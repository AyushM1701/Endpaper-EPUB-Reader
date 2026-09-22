/* ================================================================
   ENDPAPER — Self-hosted EPUB Reader
   Frontend with API-backed persistence
   ================================================================ */



/* ---------------- API Layer ---------------- */
let allCollections = [];

// Keep a small, account-scoped LRU of recently opened EPUBs. This avoids a
// second download when a reader briefly returns to the shelf, without letting
// a very large book pin an unbounded amount of mobile memory.
// R-16: Store Blobs instead of ArrayBuffers so EPUB.js receives a blob:// URL
// — the backing data lives outside the GC heap and no .slice() copy is needed.
const EPUB_BUFFER_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const EPUB_BUFFER_CACHE_MAX_ITEM_BYTES = 12 * 1024 * 1024;
const epubBlobCache = new Map();     // key → Blob
const epubBlobRequests = new Map();  // key → Promise<Blob>
const epubLocationCache = new Map();
let epubBlobCacheBytes = 0;

// Blob URL for the currently open book; revoked in discardReaderState (R-16)
let currentBlobUrl = null;

function readerAssetCacheKey(bookId, version = accountVersion) {
  return `${version}:${bookId}`;
}

function getCachedEpubBlob(key) {
  const blob = epubBlobCache.get(key);
  if (!blob) return null;
  // LRU: re-insert to move to tail
  epubBlobCache.delete(key);
  epubBlobCache.set(key, blob);
  return blob;
}

function rememberEpubBlob(key, blob) {
  if (!(blob instanceof Blob) || blob.size > EPUB_BUFFER_CACHE_MAX_ITEM_BYTES) return;
  const previous = epubBlobCache.get(key);
  if (previous) epubBlobCacheBytes -= previous.size;
  epubBlobCache.delete(key);
  epubBlobCache.set(key, blob);
  epubBlobCacheBytes += blob.size;
  while (epubBlobCacheBytes > EPUB_BUFFER_CACHE_MAX_BYTES && epubBlobCache.size > 1) {
    const oldestKey = epubBlobCache.keys().next().value;
    const oldest = epubBlobCache.get(oldestKey);
    epubBlobCache.delete(oldestKey);
    epubBlobCacheBytes -= oldest.size;
  }
}

function clearReaderAssetCaches() {
  epubBlobCache.clear();
  epubBlobRequests.clear();
  epubLocationCache.clear();
  bookSearchIndex.clear();
  bookTextIndex.clear();
  epubBlobCacheBytes = 0;
}

const api = {
  async fetch(url, opts = {}) {
    const { expectedAccountVersion, ...requestOptions } = opts;
    // Authenticated calls that do not need a custom guard still inherit the
    // account that started them, so an old 401 cannot log out a newer login.
    const requestAccountVersion = expectedAccountVersion == null ? accountVersion : expectedAccountVersion;
    const headers = new Headers(requestOptions.headers || {});
    if (requestOptions.body && !(requestOptions.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await fetch(url, {
      credentials: 'same-origin',
      ...requestOptions,
      headers,
    });
    if (res.status === 401) {
      if (requestAccountVersion === accountVersion) {
        setCurrentUser(null);
        // Session expired — show the gate after synchronously clearing reader state.
        showLoginGate();
      }
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      err.isOffline = res.status === 503 && data.error === 'Offline';
      err.book_id = data.book_id;
      err.title = data.title;
      throw err;
    }
    return res;
  },

  async startSession(bookId, opts = {}) {
    const res = await this.fetch('/api/sessions/start', {
      ...opts,
      method: 'POST',
      body: JSON.stringify({ book_id: bookId, client_id: CLIENT_ID }),
    });
    return res.json();
  },

  async endSession(sessionId, opts = {}) {
    if (!sessionId) return;
    const res = await this.fetch(`/api/sessions/${sessionId}/end`, { ...opts, method: 'POST' });
    return res.json();
  },

  async getBooks(opts = {}) {
    const books = [];
    let page = 1;
    let firstPayload = null;
    do {
      const res = await this.fetch(`/api/books?limit=100&page=${page}`, opts);
      const payload = await res.json();
      if (!firstPayload) firstPayload = payload;
      books.push(...(Array.isArray(payload) ? payload : (payload.books || [])));
      if (Array.isArray(payload) || page >= (payload.totalPages || 1)) break;
      page++;
    } while (page <= 10_000);
    return { ...(firstPayload || {}), books, page: 1, totalPages: 1 };
  },

  async uploadBook(file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await this.fetch('/api/books', {
      method: 'POST',
      body: formData,
    });
    return res.json();
  },

  async getBookFile(id, opts = {}) {
    const requestAccountVersion = opts.expectedAccountVersion == null ? accountVersion : opts.expectedAccountVersion;
    const key = readerAssetCacheKey(id, requestAccountVersion);
    // R-16: Return Blob from cache — EPUB.js will receive a blob:// URL, no .slice() copy needed
    const cached = getCachedEpubBlob(key);
    if (cached) return cached;
    if (opts.signal && opts.signal.aborted) {
      const error = new Error('The user aborted a request.');
      error.name = 'AbortError';
      throw error;
    }
    if (epubBlobRequests.has(key)) return epubBlobRequests.get(key);

    const pending = this.fetch(`/api/books/${id}/file`, {
      ...opts,
      headers: {},  // no Content-Type for binary
    }).then(res => res.blob()).then(blob => {
      if (requestAccountVersion === accountVersion && currentUser) rememberEpubBlob(key, blob);
      return blob;
    }).finally(() => {
      if (epubBlobRequests.get(key) === pending) epubBlobRequests.delete(key);
    });
    epubBlobRequests.set(key, pending);
    return pending;
  },

  async updateBook(id, data, opts = {}) {
    const res = await this.fetch(`/api/books/${id}`, {
      ...opts,
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async deleteBook(id) {
    const res = await this.fetch(`/api/books/${id}`, { method: 'DELETE' });
    return res.json();
  },

  async getStats(opts = {}) {
    const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      : 'UTC';
    const res = await this.fetch(`/api/stats?tz=${encodeURIComponent(tz)}`, opts);
    return res.json();
  },

  async getCollections() {
    const res = await this.fetch('/api/collections');
    return res.json();
  },

  async createCollection(name) {
    const res = await this.fetch('/api/collections', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return res.json();
  },

  async deleteCollection(id) {
    const res = await this.fetch(`/api/collections/${id}`, { method: 'DELETE' });
    return res.json();
  },

  async renameCollection(id, name) {
    const res = await this.fetch(`/api/collections/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    return res.json();
  },

  async addBookToCollection(bookId, collectionId) {
    const res = await this.fetch(`/api/books/${bookId}/collections/${collectionId}`, {
      method: 'POST',
    });
    return res.json();
  },

  async removeBookFromCollection(bookId, collectionId) {
    const res = await this.fetch(`/api/books/${bookId}/collections/${collectionId}`, {
      method: 'DELETE',
    });
    return res.json();
  },
  async getBookmarks(bookId, opts = {}) {
    const res = await this.fetch(`/api/books/${bookId}/bookmarks`, opts);
    return res.json();
  },

  async addBookmark(bookId, data, opts = {}) {
    const res = await this.fetch(`/api/books/${bookId}/bookmarks`, {
      ...opts,
      method: 'POST',
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async removeBookmark(id, opts = {}) {
    await this.fetch(`/api/bookmarks/${id}`, { ...opts, method: 'DELETE' });
  },

  async getHighlights(bookId, opts = {}) {
    const res = await this.fetch(`/api/books/${bookId}/highlights`, opts);
    return res.json();
  },

  async getAllHighlights(query = '', opts = {}) {
    const res = await this.fetch(`/api/highlights?q=${encodeURIComponent(query)}`, opts);
    return res.json();
  },

  async addHighlight(bookId, data, opts = {}) {
    const res = await this.fetch(`/api/books/${bookId}/highlights`, {
      ...opts,
      method: 'POST',
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async updateHighlight(id, data, opts = {}) {
    const res = await this.fetch(`/api/highlights/${id}`, {
      ...opts,
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async removeHighlight(id, opts = {}) {
    await this.fetch(`/api/highlights/${id}`, { ...opts, method: 'DELETE' });
  },

  async getSettings(opts = {}) {
    const res = await this.fetch('/api/settings', opts);
    return res.json();
  },

  async saveSettings(data, opts = {}) {
    await this.fetch('/api/settings', {
      ...opts,
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async getUsers() {
    const res = await this.fetch('/api/users');
    return res.json();
  },

  async createUser(data) {
    const res = await this.fetch('/api/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async deleteUser(id) {
    const res = await this.fetch(`/api/users/${id}`, { method: 'DELETE' });
    return res.json();
  },

  async updateUser(id, data) {
    const res = await this.fetch(`/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    return res.json();
  },
};

/* ---------------- State ---------------- */
let library = [];          // {id, title, author, series, seriesIndex, rating, coverColor, coverPath, progress, lastLocationCfi, bookmarks, highlights}
let book = null;
let rendition = null;
let currentBookId = null;
let locationsReady = false;
var currentSessionId = null;
let toastTimer = null;
let currentUser = null;
let adminModalReturnFocus = null;
let shortcutsModalReturnFocus = null;
let accountVersion = 0;
let readerRequestVersion = 0;
let readerAbortController = null;
let activeReaderRequest = null;
let isDraggingProgressSlider = false;
let seekLockUntil = 0;
let lastReaderInteractionAt = 0;
let personalReadingBytesPerMinute = 4200;
const CLIENT_ID = sessionStorage.getItem('endpaper_client_id') || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
sessionStorage.setItem('endpaper_client_id', CLIENT_ID);

function showToast(message, action = null) {
  const toast = document.getElementById('toast');
  toast.innerHTML = '';
  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  toast.appendChild(textSpan);

  if (action && action.text && action.onClick) {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'toast-action-btn';
    actionBtn.textContent = action.text;
    actionBtn.style.marginLeft = '12px';
    actionBtn.style.padding = '2px 8px';
    actionBtn.style.borderRadius = '4px';
    actionBtn.style.border = '1px solid currentColor';
    actionBtn.style.background = 'transparent';
    actionBtn.style.color = 'inherit';
    actionBtn.style.cursor = 'pointer';
    actionBtn.style.font = 'inherit';
    actionBtn.style.fontWeight = '600';
    actionBtn.onclick = (e) => {
      e.stopPropagation();
      toast.classList.remove('show');
      action.onClick();
    };
    toast.appendChild(actionBtn);
  }

  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), action ? 5000 : 3200);
}

function isCurrentUserAdmin() {
  return Boolean(currentUser && currentUser.isAdmin);
}

function updateRoleAwareControls() {
  const isAdmin = isCurrentUserAdmin();
  document.querySelectorAll('[data-admin-only]').forEach(el => {
    el.hidden = !isAdmin;
    if (el.matches('input')) el.disabled = !isAdmin;
  });

  const accountContext = document.getElementById('current-user-context');
  const accountName = document.getElementById('current-user-name');
  const accountRole = document.getElementById('current-user-role');
  if (accountContext && accountName && accountRole && currentUser && currentUser.username) {
    accountName.textContent = currentUser.username;
    accountRole.textContent = isAdmin ? 'Admin' : 'Reader';
    accountRole.className = `role-badge ${isAdmin ? 'admin' : 'reader'}`;
    accountContext.title = `Signed in as ${currentUser.username} (${isAdmin ? 'Admin' : 'Reader'})`;
    accountContext.hidden = false;
  } else if (accountContext) {
    accountContext.hidden = true;
  }

  const adminModal = document.getElementById('admin-modal');
  if (!isAdmin && adminModal && adminModal.classList.contains('show')) {
    closeAdminModal({ returnFocus: false });
  }

  const uploadButton = document.getElementById('upload-btn');
  const readerActive = document.getElementById('reader-view').classList.contains('active');
  if (uploadButton) uploadButton.style.display = !readerActive ? 'flex' : 'none';

  const dropzoneEl = document.getElementById('dropzone');
  if (dropzoneEl) dropzoneEl.classList.remove('drag-over');

  const emptyCopy = document.getElementById('empty-shelf-copy');
  if (emptyCopy) {
    emptyCopy.textContent = 'Add an EPUB to the shared library. Everyone can read it, while bookmarks, progress, and settings stay personal.';
  }
}

function userIdentity(user) {
  return user && user.username ? `${user.username}\u0000${user.isAdmin ? 'admin' : 'reader'}` : null;
}

function isActiveAccount(version) {
  return Boolean(currentUser) && version === accountVersion;
}

function setCurrentUser(session) {
  const nextUser = session && session.ok !== false
    ? { isAdmin: Boolean(session.is_admin), username: session.username || null }
    : null;
  if (userIdentity(currentUser) !== userIdentity(nextUser)) {
    accountVersion += 1;
    // Never leave one family member's active rendition or private metadata
    // visible while the next account is being opened.
    discardReaderState({ clearLibrary: true, resetPreferences: true });
  }
  currentUser = nextUser;
  updateRoleAwareControls();
}

function requireAdmin(action) {
  if (isCurrentUserAdmin()) return true;
  showToast(`Only an admin can ${action}.`);
  return false;
}

async function refreshCurrentUser() {
  const res = await fetch('/api/session', { credentials: 'same-origin' });
  if (!res.ok) {
    setCurrentUser(null);
    return null;
  }
  const session = await res.json();
  setCurrentUser(session);
  return session;
}

const DEFAULT_READER_SETTINGS = Object.freeze({
  theme: 'light',
  font: 'Serif (Georgia)',
  fontSize: 100,
  lineHeight: 150,
  marginIdx: 1,
  letterSpacingIdx: 0,
  layout: 'paginated',
  gestures: { swipe: true, edge: true, center: true },
});

const settings = { ...DEFAULT_READER_SETTINGS };

const FONTS = [
  { name: 'Serif (Georgia)', css: 'Georgia, "Times New Roman", serif' },
  { name: 'Book (Atkinson)', css: '"Atkinson Hyperlegible", sans-serif' },
  { name: 'Sans (Work Sans)', css: '"Work Sans", Helvetica, Arial, sans-serif' },
  { name: 'Classic Serif', css: '"Palatino Linotype", Palatino, serif' },
  { name: 'Monospace', css: '"Courier New", monospace' },
];

const THEMES = {
  light: { body: '#F6F1E7', text: '#201C16', link: '#A9803F' },
  sepia: { body: '#EBDCC0', text: '#4A3A22', link: '#8A6A2F' },
  dark:  { body: '#22262C', text: '#DAD5C8', link: '#C9973F' },
  night: { body: '#000000', text: '#B8B8B8', link: '#E0B15C' },
};

// Many EPUBs hard-code foreground colours on individual text elements. Keep
// the override deliberately text-only so page art and SVG illustrations retain
// their authored fills while Dark and Night pages remain readable.
const EPUB_TEXT_SELECTORS = 'body, body p, body div, body span, body li, body dd, body dt, body blockquote, body figcaption, body caption, body td, body th, body h1, body h2, body h3, body h4, body h5, body h6, body em, body strong, body b, body i, body small, body cite, body q, body code, body pre, body [style*="color"]';

const MARGIN_LABELS = ['Narrow', 'Medium', 'Wide'];
const MARGIN_PADDING = ['4%', '10%', '18%'];
const SPACING_LABELS = ['Normal', 'Relaxed', 'Loose', 'Airy'];
const SPACING_VALUES = ['normal', '0.5px', '1px', '1.6px'];

const spineColors = ['#3F5D4C','#7A3B32','#3B4A6B','#6B4C3B','#5B3F5D','#2C4237','#8A6A2F','#43506B'];

function normalizeSettings() {
  if (!THEMES[settings.theme]) settings.theme = 'light';
  if (!FONTS.some(font => font.name === settings.font)) settings.font = FONTS[0].name;
  settings.fontSize = Number.isFinite(settings.fontSize) ? Math.max(70, Math.min(220, Math.round(settings.fontSize / 10) * 10)) : 100;
  settings.lineHeight = Number.isFinite(settings.lineHeight) ? Math.max(120, Math.min(220, Math.round(settings.lineHeight / 10) * 10)) : 150;
  settings.marginIdx = Number.isInteger(settings.marginIdx) ? Math.max(0, Math.min(MARGIN_LABELS.length - 1, settings.marginIdx)) : 1;
  settings.letterSpacingIdx = Number.isInteger(settings.letterSpacingIdx) ? Math.max(0, Math.min(SPACING_VALUES.length - 1, settings.letterSpacingIdx)) : 0;
  if (!['paginated', 'scrolled'].includes(settings.layout)) settings.layout = 'paginated';
  settings.gestures = { swipe: true, edge: true, center: true, ...(settings.gestures || {}) };
}

/* ---------------- Auth gate ---------------- */
function showLoginGate() {
  document.getElementById('login-gate').classList.remove('hidden');
}

function hideLoginGate() {
  document.getElementById('login-gate').classList.add('hidden');
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');
  const userIn = document.getElementById('username-input');
  const passIn = document.getElementById('passphrase-input');
  const username = userIn.value.trim();
  const passphrase = passIn.value;

  if (!username) { errEl.textContent = 'Please enter a username.'; return false; }
  if (!passphrase) { errEl.textContent = 'Please enter a passphrase.'; return false; }

  btn.disabled = true;
  errEl.textContent = '';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, passphrase }),
    });

    if (res.ok) {
      userIn.value = '';
      passIn.value = '';
      const session = await refreshCurrentUser();
      if (!session) {
        errEl.textContent = 'Your session could not be started. Please try again.';
      } else {
        hideLoginGate();
        boot();
      }
    } else {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error || 'Incorrect passphrase.';
    }
  } catch (err) {
    errEl.textContent = 'Connection error. Please try again.';
  }

  btn.disabled = false;
  return false;
}

async function logout() {
  if (currentBookId || rendition || currentSessionId) {
    await showShelf();
  }
  if (!currentUser) {
    showLoginGate();
    return;
  }
  try {
    await api.fetch('/api/logout', { method: 'POST' });
  } catch (err) {
    // A stale session is already effectively logged out; show the gate either way.
    console.error('Logout failed:', err);
  }
  if (currentSessionId) {
    currentSessionId = null;
  }
  setCurrentUser(null);
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_RUNTIME_CACHE' });
  }
  showLoginGate();
  document.getElementById('username-input').focus();
  showToast('You have been logged out.');
}

/* ---------------- Font options UI ---------------- */
function renderFontOptions(){
  const wrap = document.getElementById('font-options');
  wrap.innerHTML = '';
  FONTS.forEach(f => {
    const selected = settings.font === f.name;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'font-option' + (selected ? ' active' : '');
    el.style.fontFamily = f.css;
    el.setAttribute('role', 'radio');
    el.setAttribute('aria-checked', String(selected));
    el.innerHTML = `<span>${f.name}</span><span class="check">✓</span>`;
    el.onclick = () => { settings.font = f.name; renderFontOptions(); applyTheme(); };
    wrap.appendChild(el);
  });
}
renderFontOptions();

/* ---------------- Drag & drop / upload ---------------- */
const dropzone = document.getElementById('dropzone');
['dragover','dragenter'].forEach(evt => document.body.addEventListener(evt, e => {
  e.preventDefault();
  if (dropzone) dropzone.classList.add('drag-over');
}));
['dragleave','drop'].forEach(evt => document.body.addEventListener(evt, e => {
  e.preventDefault();
  if (dropzone) dropzone.classList.remove('drag-over');
}));
document.body.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    handleFiles(e.dataTransfer.files);
  }
});
document.getElementById('file-input').addEventListener('change', e => handleFiles(e.target.files));

async function handleFiles(fileList){
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  const epubFiles = files.filter(f => f.name.toLowerCase().endsWith('.epub'));
  if (epubFiles.length === 0) return;

  const progressEl = document.getElementById('upload-progress');
  const progressText = document.getElementById('upload-progress-text');
  progressEl.classList.add('show');
  progressText.replaceChildren();
  const uploadHeading = document.createElement('strong');
  uploadHeading.textContent = `Adding ${epubFiles.length} book${epubFiles.length === 1 ? '' : 's'}`;
  const uploadList = document.createElement('div');
  const uploadRows = epubFiles.map(file => {
    const row = document.createElement('div');
    row.className = 'upload-status-row';
    row.textContent = `${file.name} — waiting`;
    uploadList.appendChild(row);
    return row;
  });
  progressText.append(uploadHeading, uploadList);

  let uploaded = 0;
  let lastAddedBookId = null;
  for (let i = 0; i < epubFiles.length; i++) {
    const file = epubFiles[i];
    uploadRows[i].textContent = `${file.name} — uploading…`;
    try {
      const bookData = await api.uploadBook(file);
      const entry = {
        id: bookData.id,
        name: bookData.title,
        author: bookData.author,
        series: bookData.series || null,
        seriesIndex: bookData.series_index != null && bookData.series_index !== '' ? bookData.series_index : null,
        rating: bookData.rating != null ? Number(bookData.rating) : null,
        coverColor: bookData.cover_color,
        coverPath: bookData.cover_path,
        description: bookData.description || '',
        isbn: bookData.isbn || '',
        tags: bookData.tags || '',
        progress: bookData.progress_percent || 0,
        status: bookData.status || 'unread',
        lastLocationCfi: bookData.last_location_cfi,
        fileSize: Number(bookData.file_size) || file.size || 0,
        addedAt: bookData.added_at ? new Date(bookData.added_at).getTime() : Date.now(),
        lastOpenedAt: bookData.last_opened_at ? new Date(bookData.last_opened_at).getTime() : null,
        bookmarks: [],
        highlights: [],
      };
      library.push(entry);
      renderShelf();
      lastAddedBookId = entry.id;
      uploaded++;
      uploadRows[i].textContent = `${file.name} — added`;
    } catch(err) {
      console.error('Upload failed:', err);
      if (err.status === 409 || (err.message && err.message.toLowerCase().includes('already in the library'))) {
        const bookId = err.book_id || (err.data && err.data.book_id);
        const bookTitle = (err.data && err.data.title) || file.name;
        showToast(`“${bookTitle}” is already in the library.`, bookId ? {
          text: 'Open',
          onClick: () => openBook(bookId)
        } : null);
      } else {
        showToast(`Could not add “${file.name}”: ${err.message}`);
      }
      uploadRows[i].textContent = `${file.name} — ${err.status === 409 ? 'already in library' : 'failed'}`;
    }
  }
  progressEl.classList.remove('show');
  if (uploaded === 1) showToast('Book added to your library.');
  else if (uploaded > 1) showToast(`${uploaded} books added to your library.`);
  document.getElementById('file-input').value = '';
  if (epubFiles.length === 1 && uploaded === 1 && lastAddedBookId) openBook(lastAddedBookId);
}

/* ---------------- Shelf rendering ---------------- */
let bookWarmupHandle = null;
let bookWarmupKey = null;

function cancelBookWarmup() {
  if (bookWarmupHandle == null) return;
  if ('cancelIdleCallback' in window) window.cancelIdleCallback(bookWarmupHandle);
  else clearTimeout(bookWarmupHandle);
  bookWarmupHandle = null;
  bookWarmupKey = null;
}

function scheduleBookWarmup(entry) {
  if (!entry || !currentUser || entry.fileSize > EPUB_BUFFER_CACHE_MAX_ITEM_BYTES) return;
  // R-17/R-18: Touch/mobile devices have no hover intent signal — prefetching a
  // large EPUB wastes bandwidth with no user benefit. Warmup is desktop-only.
  if (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (connection && (connection.saveData || /(^|-)2g$/.test(connection.effectiveType || ''))) return;
  const expectedAccountVersion = accountVersion;
  const key = readerAssetCacheKey(entry.id, expectedAccountVersion);
  if (epubBlobCache.has(key) || epubBlobRequests.has(key) || bookWarmupKey === key) return;

  cancelBookWarmup();
  bookWarmupKey = key;
  const warm = () => {
    bookWarmupHandle = null;
    bookWarmupKey = null;
    if (!isActiveAccount(expectedAccountVersion) || currentBookId) return;
    api.getBookFile(entry.id, { expectedAccountVersion }).catch(() => {});
  };
  bookWarmupHandle = 'requestIdleCallback' in window
    ? window.requestIdleCallback(warm, { timeout: 2500 })
    : setTimeout(warm, 800);
}

function formatSeriesText(series, seriesIndex) {
  if (!series) return '';
  if (seriesIndex != null && seriesIndex !== '') {
    return `Book ${seriesIndex} of ${series}`;
  }
  return series;
}

function renderRatingHtml(bookId, currentRating) {
  const r = Number(currentRating) || 0;
  let stars = '';
  for (let i = 1; i <= 5; i++) {
    const filled = i <= r ? ' filled' : '';
    const glyph = i <= r ? '★' : '☆';
    stars += `<button type="button" class="star-btn${filled}" title="Rate ${i} star${i > 1 ? 's' : ''}" onclick="event.stopPropagation(); setBookRating('${bookId}', ${i === r ? 'null' : i})">${glyph}</button>`;
  }
  return `<div class="rating-stars" role="group" aria-label="Book rating">${stars}</div>`;
}

async function setBookRating(bookId, rating) {
  const entry = library.find(b => b.id === bookId);
  if (entry) entry.rating = rating;
  renderShelf();
  if (activeOrganizeBookId === bookId) {
    const ratingContainer = document.querySelector('#collection-list .rating-stars');
    if (ratingContainer) {
      ratingContainer.outerHTML = renderRatingHtml(bookId, rating);
    }
  }
  try {
    await api.updateBook(bookId, { rating });
    showToast(rating ? `Rated ${rating} star${rating > 1 ? 's' : ''}.` : 'Rating cleared.');
  } catch (err) {
    console.error('Rating update failed:', err);
    showToast(`Could not update rating: ${err.message}`);
  }
}

function renderContinueCard(){
  const card = document.getElementById('continue-card');
  const candidates = library.filter(b => b.lastOpenedAt);
  if (candidates.length === 0){ card.style.display = 'none'; return; }
  const b = candidates.sort((x, y) => y.lastOpenedAt - x.lastOpenedAt)[0];
  const coverStyle = b.coverPath
    ? `background-image:url('/api/books/${b.id}/cover'); background-size:cover; background-position:center;`
    : `background:${b.coverColor};`;
  const seriesInfo = b.series ? `<div class="continue-series">${escapeHtml(formatSeriesText(b.series, b.seriesIndex))}</div>` : '';
  const ratingWidget = `<div style="margin-top:6px;">${renderRatingHtml(b.id, b.rating)}</div>`;
  card.innerHTML = `
    <div class="spine spine-book" style="${coverStyle}">${b.coverPath ? '' : `<span class="spine-title">${escapeHtml(b.name)}</span>`}</div>
    <div id="continue-info">
      <div class="kicker">Continue reading</div>
      <h3>${escapeHtml(b.name)}</h3>
      ${seriesInfo}
      <div class="author">${escapeHtml(b.author || 'Unknown author')}</div>
      <div class="progress-text">${b.progress}% through the book</div>
      <div class="book-progress-bar" style="margin-top:8px;"><div class="book-progress-fill" style="width:${b.progress}%"></div></div>
      ${ratingWidget}
    </div>
  `;
  card.style.display = 'flex';
  card.onclick = () => openBook(b.id);
  scheduleBookWarmup(b);
}

function renderShelf(){
  const shelf = document.getElementById('shelf');
  const empty = document.getElementById('shelf-empty');
  const header = document.getElementById('shelf-header');
  shelf.innerHTML = '';
  renderContinueCard();
  if (library.length === 0){
    empty.style.display = 'block';
    header.style.display = 'none';
    document.getElementById('continue-card').style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  header.style.display = 'flex';
  document.getElementById('shelf-count').textContent = library.length + (library.length === 1 ? ' book' : ' books');

  // Search, filtering, and sorting
  const searchQuery = document.getElementById('shelf-search').value.trim().toLocaleLowerCase();
  const filterVal = document.getElementById('shelf-filter').value;
  let filtered = searchQuery
    ? library.filter(b => `${b.name || ''} ${b.author || ''}`.toLocaleLowerCase().includes(searchQuery))
    : library;
  if (filterVal === 'unread') filtered = filtered.filter(b => b.progress === 0);
  // R-22: threshold raised from 95 to 98 — avoids premature finished marking on
  // the second-to-last chapter (R-21 formula now makes last entry reach 100% only
  // at its actual end, so 98% is a safe auto-finish trigger)
  else if (filterVal === 'finished') filtered = filtered.filter(b => b.progress >= 98);
  else if (filterVal.startsWith('col_')) {
    const colId = filterVal.substring(4);
    const col = allCollections.find(c => c.id === colId);
    if (col) filtered = filtered.filter(b => col.book_ids.includes(b.id));
  }

  // Sorting
  const sortVal = document.getElementById('shelf-sort').value;
  filtered = [...filtered].sort((a, b) => {
    if (sortVal === 'recent') return (b.addedAt || 0) - (a.addedAt || 0);
    if (sortVal === 'opened') return (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0);
    if (sortVal === 'title') return a.name.localeCompare(b.name);
    if (sortVal === 'author') return (a.author || '').localeCompare(b.author || '');
    if (sortVal === 'series') {
      const aSeries = a.series || '';
      const bSeries = b.series || '';
      if (!aSeries && bSeries) return 1;
      if (aSeries && !bSeries) return -1;
      const sComp = aSeries.localeCompare(bSeries);
      if (sComp !== 0) return sComp;
      const idxComp = (a.seriesIndex || 0) - (b.seriesIndex || 0);
      if (idxComp !== 0) return idxComp;
      return a.name.localeCompare(b.name);
    }
    if (sortVal === 'progress') return b.progress - a.progress;
    return 0;
  });

  filtered.forEach(b => {
    const card = document.createElement('div');
    card.className = 'book-card';
    const coverStyle = b.coverPath
      ? `background-image:url('/api/books/${b.id}/cover'); background-size:cover; background-position:center;`
      : `background:${b.coverColor};`;
    const adminActions = isCurrentUserAdmin() ? `
      <div class="spine-actions">
        <button type="button" class="spine-action-btn" title="Organize shared collections" onclick="event.stopPropagation(); openBookCollectionsModal('${b.id}')">Organize</button>
        <button type="button" class="spine-action-btn" title="Remove from shared library" onclick="event.stopPropagation(); removeBook('${b.id}')">Remove</button>
      </div>
    ` : '';
    const progressBadge = b.progress > 0
      ? `<span class="spine-badge">${b.progress}%</span>`
      : '';
    const seriesBadge = b.series ? `<div class="series-tag">${escapeHtml(formatSeriesText(b.series, b.seriesIndex))}</div>` : '';
    const ratingHtml = `<div class="shelf-rating-widget">${renderRatingHtml(b.id, b.rating)}</div>`;
    card.innerHTML = `
      <div class="spine" style="${coverStyle}">
        ${b.coverPath ? '' : `<span class="spine-title">${escapeHtml(b.name)}</span>`}
        ${b.coverPath ? '' : `<span class="spine-author">${escapeHtml(b.author || '')}</span>`}
        ${progressBadge}
        ${adminActions}
      </div>
      <div class="book-meta-under">
        ${seriesBadge}
        <div class="title" title="${escapeHtml(b.name)}">${escapeHtml(b.name)}</div>
        <div class="author">${escapeHtml(b.author || 'Unknown')}</div>
        ${ratingHtml}
        <div class="book-progress-bar"><div class="book-progress-fill" style="width:${b.progress}%"></div></div>
      </div>
    `;
    card.onclick = () => openBook(b.id);
    shelf.appendChild(card);
  });
}

async function removeBook(id){
  if (!requireAdmin('remove books from the shared library')) return;
  const entry = library.find(b => b.id === id);
  if (!entry) return;
  const confirmed = await showConfirmDialog({
    title: 'Remove Book',
    message: `Remove “${entry.name}” and all of its bookmarks and highlights? This cannot be undone.`,
    confirmText: 'Remove Book',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.deleteBook(id);
    library = library.filter(b => b.id !== id);
    renderShelf();
    showToast('Book removed.');
  } catch(e) {
    console.error('Delete failed:', e);
    showToast(`Could not remove the book: ${e.message}`);
  }
}

function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

async function showShelf(){
  const entry = getCurrentEntry();
  const sessionId = currentSessionId;
  const saveAccountVersion = accountVersion;
  // Tear down first, so a late EPUB/network callback cannot revive this reader.
  discardReaderState();
  renderShelf();
  updateRoleAwareControls();

  if (!isActiveAccount(saveAccountVersion)) return;
  if (entry) {
    const saved = await saveBookMeta(entry, { expectedAccountVersion: saveAccountVersion, allowInactiveReader: true });
    if (!saved || !isActiveAccount(saveAccountVersion)) return;
  }
  if (sessionId && isActiveAccount(saveAccountVersion)) {
    try {
      await api.endSession(sessionId, { expectedAccountVersion: saveAccountVersion });
    } catch (e) {
      if (isActiveAccount(saveAccountVersion)) console.error('Could not end reading session:', e);
    }
  }
  if (window.__reloadAfterReader && isActiveAccount(saveAccountVersion)) {
    window.__reloadAfterReader = false;
    window.location.reload();
  }
}

/* ---------------- Layout (paginated vs scrolled) ---------------- */
function renditionOptions(){
  if (settings.layout === 'scrolled'){
    return {
      width: '100%', height: '100%',
      flow: 'scrolled', manager: 'continuous',
      snap: false,
      sandbox: 'allow-same-origin',
    };
  }
  return { width: '100%', height: '100%', flow: 'paginated', spread: 'auto', sandbox: 'allow-same-origin' };
}

function setLayout(mode){
  if (settings.layout === mode || !book) { settings.layout = mode; updateSettingsUI(); saveSettings(); return; }
  settings.layout = mode;
  const entry = library.find(b => b.id === currentBookId);
  const targetBook = book;
  const request = activeReaderRequest;
  if (!entry || !request) { updateSettingsUI(); saveSettings(); return; }
  const resumeCfi = getSafeCfi() || entry.lastLocationCfi;
  if (resumeCfi) entry.lastLocationCfi = resumeCfi;

  hideHighlightPopup();
  rendition.destroy();
  document.getElementById('viewer').innerHTML = '';
  document.getElementById('reader-view').classList.toggle('scrolled', mode === 'scrolled');

  rendition = book.renderTo('viewer', renditionOptions());
  const targetRendition = rendition;
  registerThemes();
  registerSwipeGestures();
  applyTheme();
  bindRenditionInteractions(entry, targetRendition, request);
  bindRelocated(entry, targetRendition, targetBook, request);
  targetRendition.display(resumeCfi || undefined).then(() => {
    if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
    tuneScrollContainer(targetRendition);
    applySavedHighlights(entry, targetRendition);
    updateBookmarkIcon();
  }).catch(err => {
    if (isReaderRequestCurrent(request, targetBook, targetRendition)) console.error('Could not switch reading layout:', err);
  });
  updateSettingsUI();
}

function applyReaderContentStyles(contents) {
  const doc = contents && contents.document;
  if (!doc) return;
  let style = doc.getElementById('endpaper-reader-content-style');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'endpaper-reader-content-style';
    (doc.head || doc.documentElement).appendChild(style);
  }
  const theme = THEMES[settings.theme] || THEMES.light;
  const isScrolled = settings.layout === 'scrolled';
  style.textContent = `
    @media (max-width: 699px) {
      p, li, blockquote { text-align: start !important; hyphens: auto; -webkit-hyphens: auto; }
    }
    html, body {
      background-color: ${theme.body} !important;
      color: ${theme.text} !important;
      box-sizing: border-box !important;
      -webkit-user-select: auto;
      overflow-anchor: none !important;
      touch-action: pan-y !important;
      overscroll-behavior: none !important;
      -webkit-overflow-scrolling: touch;
    }
    body {
      margin: 0 !important;
      ${isScrolled ? 'padding-top: 14px !important; padding-bottom: 80px !important;' : 'padding-top: 0 !important; padding-bottom: 0 !important;'}
    }
    body p, body div, body span, body li, body dd, body dt, body blockquote, body figcaption, body td, body th, body h1, body h2, body h3, body h4, body h5, body h6 {
      color: inherit !important;
      background-color: transparent !important;
    }
    a, a:link, a:visited {
      color: ${theme.link} !important;
    }
    img, svg {
      max-width: 100% !important;
      height: auto !important;
    }
    .endpaper-tts-active {
      background-color: rgba(201, 151, 63, 0.32) !important;
      border-radius: 4px !important;
      box-shadow: 0 0 0 2px rgba(201, 151, 63, 0.45) !important;
      transition: background-color 0.15s ease, box-shadow 0.15s ease !important;
    }
  `;
}

function isInteractiveReaderTarget(target) {
  return Boolean(target && target.closest && target.closest('a, button, input, textarea, select, summary, [contenteditable="true"]'));
}

function handleReaderSwipeOrTap(sx, sy, ex, ey, dt, moved, width, win, isCancel) {
  if (!rendition) return false;
  lastReaderInteractionAt = Date.now();
  const dx = ex - sx;
  const dy = ey - sy;

  // If user has an active text selection in the window, do not trigger page turns
  if (win && win.getSelection && !win.getSelection().isCollapsed) return false;

  // 1. Horizontal swipe gesture in paginated mode
  if (settings.layout === 'paginated' && settings.gestures.swipe) {
    const swipeThreshold = 30; // Responsive threshold for mobile swipe
    if (Math.abs(dx) >= swipeThreshold && Math.abs(dx) > Math.abs(dy) * 1.1 && dt < 800) {
      if (dx < 0) turnPage('next');
      else turnPage('prev');
      return true;
    }
  }

  // 2. Clean tap: tap-to-turn zones (left 25% = prev, right 25% = next, center = toggle controls)
  if (!isCancel && !moved && Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 450) {
    if (settings.layout === 'paginated' && settings.gestures.edge) {
      if (ex < width * 0.25) {
        turnPage('prev');
        return true;
      } else if (ex > width * 0.75) {
        turnPage('next');
        return true;
      }
    }
    if (settings.gestures.center) {
      toggleReaderChrome();
      return true;
    }
  }
  return false;
}

function initViewerWrapGestures() {
  const wrap = document.getElementById('viewer-wrap');
  if (!wrap || wrap.__gestureBound) return;
  wrap.__gestureBound = true;

  let sx = 0, sy = 0, st = 0, moved = false, handled = false;

  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    st = Date.now();
    moved = false;
    handled = false;
  }, { passive: true });

  wrap.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved = true;
  }, { passive: true });

  const onEndOrCancel = (e, isCancel) => {
    if (e.target && e.target.tagName === 'IFRAME') return;
    if (handled || !rendition || !e.changedTouches || !e.changedTouches.length) return;
    if (isInteractiveReaderTarget(e.target)) return;

    const t = e.changedTouches[0];
    const width = wrap.clientWidth || window.innerWidth;
    const res = handleReaderSwipeOrTap(sx, sy, t.clientX, t.clientY, Date.now() - st, moved, width, window, isCancel);
    if (res) handled = true;
  };

  wrap.addEventListener('touchend', (e) => onEndOrCancel(e, false), { passive: true });
  wrap.addEventListener('touchcancel', (e) => onEndOrCancel(e, true), { passive: true });
}

function registerSwipeGestures(){
  initViewerWrapGestures();
  if (!rendition || !rendition.hooks) return;
  rendition.hooks.content.register((contents) => {
    const doc = contents.document;
    const win = contents.window || (doc && doc.defaultView);
    applyReaderContentStyles(contents);
    doc.addEventListener('keydown', handleReaderShortcut);

    let sx = 0, sy = 0, st = 0, moved = false, handled = false;

    const onTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      st = Date.now();
      moved = false;
      handled = false;
    };

    const onTouchMove = (e) => {
      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - sx;
      const dy = e.touches[0].clientY - sy;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved = true;
    };

    const onTouchEndOrCancel = (e, isCancel) => {
      if (handled || !rendition || !e.changedTouches || !e.changedTouches.length) return;
      if (isInteractiveReaderTarget(e.target)) return;

      const t = e.changedTouches[0];
      const width = win ? win.innerWidth : (doc.documentElement ? doc.documentElement.clientWidth : window.innerWidth);
      const res = handleReaderSwipeOrTap(sx, sy, t.clientX, t.clientY, Date.now() - st, moved, width, win, isCancel);
      if (res) handled = true;
    };

    doc.addEventListener('touchstart', onTouchStart, { passive: true });
    doc.addEventListener('touchmove', onTouchMove, { passive: true });
    doc.addEventListener('touchend', (e) => onTouchEndOrCancel(e, false), { passive: true });
    doc.addEventListener('touchcancel', (e) => onTouchEndOrCancel(e, true), { passive: true });
  });
}

let chromeHintShown = false;
let chromeResizeTimer = null;
let chromeResizeFrame = null;
let lastReaderViewportSize = { width: 0, height: 0 };
// Auto-hide timer for the Kindle-like 3-second chrome dismiss (R-13)
let readerChromeTimer = null;

// Page-turn serialization mutex — all rendition.next()/prev() calls route through
// turnPage() to prevent overlapping navigations from swipe, tap, keyboard, and TTS (R-09)
let pageTurnLock = false;
let pageTurnLockTimer = null;

function turnPage(direction) {
  if (!rendition || pageTurnLock) return;
  pageTurnLock = true;
  clearTimeout(pageTurnLockTimer);
  let promise;
  try { promise = direction === 'next' ? rendition.next() : rendition.prev(); } catch (_) {}
  const unlock = () => { pageTurnLock = false; };
  if (promise && typeof promise.then === 'function') {
    pageTurnLockTimer = setTimeout(unlock, 600);
    promise.then(unlock, unlock);
  } else {
    pageTurnLockTimer = setTimeout(unlock, 600);
  }
}

/**
 * Safely read the current CFI without crashing when EPUB.js returns a Promise
 * from currentLocation() (R-12).
 */
function getSafeCfi(targetRendition) {
  try {
    const r = targetRendition || rendition;
    if (!r || !r.currentLocation) return null;
    const loc = r.currentLocation();
    if (!loc || typeof loc.then === 'function') return null;
    return (loc.start && loc.start.cfi) || null;
  } catch (_) { return null; }
}

async function getCurrentLocationSafe(targetRendition = rendition) {
  try {
    if (!targetRendition || !targetRendition.currentLocation) return null;
    return await Promise.resolve(targetRendition.currentLocation());
  } catch (_) { return null; }
}

function isTouchReader(){
  return Boolean(
    document.body.classList.contains('reader-active') &&
    window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches
  );
}

function readerFullscreenElement(){
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function isImmersiveReading(){
  const app = document.getElementById('app');
  return Boolean(app && app.classList.contains('chrome-hidden'));
}

function resizeReaderViewport(){
  const viewport = document.getElementById('viewer-wrap');
  if (!rendition || !viewport) return;
  const width = Math.round(viewport.clientWidth);
  const height = Math.round(viewport.clientHeight);
  if (width < 1 || height < 1) return;
  // Skip redundant resizes — prevents spurious relayouts during chrome animation (R-01)
  if (lastReaderViewportSize.width === width && lastReaderViewportSize.height === height) return;
  lastReaderViewportSize = { width, height };
  try { rendition.resize(width, height); } catch (e) {}
}

function scheduleReaderResize(){
  if (chromeResizeFrame != null) cancelAnimationFrame(chromeResizeFrame);
  clearTimeout(chromeResizeTimer);
  chromeResizeFrame = requestAnimationFrame(() => {
    chromeResizeFrame = requestAnimationFrame(() => {
      chromeResizeFrame = null;
      resizeReaderViewport();
    });
  });
  // The bars animate for 250ms. A final measured resize after the transition
  // prevents EPUB.js from retaining the smaller, pre-fullscreen page box.
  chromeResizeTimer = setTimeout(resizeReaderViewport, 320);
}


function syncReaderChromeAccessibility(){
  const app = document.getElementById('app');
  const hidden = app.classList.contains('chrome-hidden');
  ['topbar', 'progress-bar'].forEach(id => {
    const element = document.getElementById(id);
    if (!element) return;
    element.setAttribute('aria-hidden', String(hidden));
    element.toggleAttribute('inert', hidden);
  });
}

function updateFullscreenControlUI(){
  const desktopBtn = document.getElementById('fullscreen-btn');
  const app = document.getElementById('app');
  if (!app) return;
  const immersive = isImmersiveReading() || Boolean(readerFullscreenElement());
  if (desktopBtn) {
    desktopBtn.setAttribute('aria-pressed', String(immersive));
    desktopBtn.setAttribute('aria-label', immersive ? 'Exit fullscreen' : 'Fullscreen');
    desktopBtn.title = immersive ? 'Exit fullscreen' : 'Fullscreen';
  }
}

function requestReaderFullscreen(){
  const app = document.getElementById('app');
  if (!app || readerFullscreenElement()) return;
  const request = app.requestFullscreen || app.webkitRequestFullscreen;
  if (!request) return;
  try {
    const result = app.requestFullscreen
      ? request.call(app, { navigationUI: 'hide' })
      : request.call(app);
    if (result && result.then) result.then(scheduleReaderResize).catch(scheduleReaderResize);
  } catch (e) {
    // The chrome-hidden state remains a useful immersive fallback on browsers
    // that do not permit the Fullscreen API for embedded EPUB interactions.
  }
}

function exitReaderFullscreen(){
  const app = document.getElementById('app');
  if (!app || !readerFullscreenElement()) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit) return;
  try {
    const result = exit.call(document);
    if (result && result.catch) result.catch(() => {});
  } catch (e) {}
}

function enterImmersiveReading(){
  const app = document.getElementById('app');
  if (!app || !document.body.classList.contains('reader-active')) return false;
  clearTimeout(readerChromeTimer);
  readerChromeTimer = null;
  app.classList.add('chrome-hidden');
  closeDrawers();
  syncReaderChromeAccessibility();
  updateFullscreenControlUI();
  // R-13: Viewer dimensions are constant (overlays float on top) — no resize needed
  return true;
}

function exitImmersiveReading(){
  const app = document.getElementById('app');
  if (!app) return false;
  app.classList.remove('chrome-hidden');
  exitReaderFullscreen();
  syncReaderChromeAccessibility();
  updateFullscreenControlUI();
  // R-13: Viewer dimensions unchanged — no resize needed
  return true;
}

// Show chrome and start a 3-second auto-hide timer (Kindle-like UX, R-13).
// Tapping center while chrome is visible calls enterImmersiveReading() directly.
function showReaderChromeTemporarily(delay = 3000) {
  const app = document.getElementById('app');
  if (!app || !document.body.classList.contains('reader-active')) return;
  app.classList.remove('chrome-hidden');
  syncReaderChromeAccessibility();
  updateFullscreenControlUI();
  clearTimeout(readerChromeTimer);
  readerChromeTimer = setTimeout(() => {
    readerChromeTimer = null;
    if (
      document.body.classList.contains('reader-active') &&
      !document.querySelector('.drawer[aria-hidden="false"]')
    ) {
      enterImmersiveReading();
    }
  }, delay);
}

function toggleReaderChrome(){
  // Tapping center: if currently immersive — show chrome briefly then auto-hide;
  // if chrome is visible — hide it immediately and cancel any pending timer.
  if (isImmersiveReading()) showReaderChromeTemporarily();
  else enterImmersiveReading();
}

function tuneScrollContainer(targetRendition = rendition, entry = getCurrentEntry(), request = activeReaderRequest){
  if (settings.layout !== 'scrolled' || !targetRendition || !targetRendition.manager) {
    return;
  }
  const el = targetRendition.manager.container;
  if (!el) return;
  el.style.scrollBehavior = 'auto';
  el.style.webkitOverflowScrolling = 'touch';
  el.style.overscrollBehavior = 'contain';
  el.style.overflowAnchor = 'none';
  el.id = 'epub-scroll-container';
  el.style.scrollbarWidth = 'thin';
  el.style.scrollbarColor = 'var(--gold) transparent';

  if (!el.__endpaperScrollListenerBound) {
    el.__endpaperScrollListenerBound = true;
    let scrollRaf = null;
    el.addEventListener('scroll', () => {
      lastReaderInteractionAt = Date.now();
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(async () => {
        scrollRaf = null;
        if (!isReaderRequestCurrent(request, book, targetRendition)) return;
        const currentEntry = entry || getCurrentEntry();
        if (!currentEntry) return;
        const loc = await getCurrentLocationSafe(targetRendition);
        if (loc && loc.start && isReaderRequestCurrent(request, book, targetRendition)) updateReaderLocation(currentEntry, loc, book, targetRendition, request);
      });
    }, { passive: true });
  }
}

function pageScroll(direction){
  if (settings.layout !== 'scrolled' || !rendition || !rendition.manager) return false;
  const el = rendition.manager.container;
  if (!el) return false;
  let lineHeight = 24;
  try {
    const iframeBody = document.querySelector('#viewer iframe')?.contentDocument?.body;
    if (iframeBody) {
      const lh = parseFloat(window.getComputedStyle(iframeBody).lineHeight);
      if (!isNaN(lh) && lh > 0) lineHeight = lh;
    }
  } catch (_) {}
  const rawScroll = el.clientHeight * 0.85;
  const snappedScroll = Math.round(rawScroll / lineHeight) * lineHeight;
  el.scrollBy({ top: direction * snappedScroll, behavior: 'smooth' });
  return true;
}

function createReaderRequest(bookId) {
  abortReaderRequests();
  readerAbortController = new AbortController();
  const request = {
    version: readerRequestVersion,
    accountVersion,
    bookId,
    controller: readerAbortController,
  };
  activeReaderRequest = request;
  return request;
}

function readerRequestOptions(request) {
  return { signal: request.controller.signal, expectedAccountVersion: request.accountVersion };
}

function isReaderRequestCurrent(request, targetBook = book, targetRendition = rendition) {
  return Boolean(
    request && activeReaderRequest === request && readerRequestVersion === request.version &&
    accountVersion === request.accountVersion && currentBookId === request.bookId &&
    readerAbortController === request.controller && !request.controller.signal.aborted &&
    targetBook === book && targetRendition === rendition
  );
}

function isAbortError(error) {
  return error && (error.name === 'AbortError' || error.message === 'The user aborted a request.');
}

async function recoverFromReaderFailure(request, message, targetBook = null, targetRendition = null){
  const current = isReaderRequestCurrent(request, targetBook, targetRendition);
  if (!current) return;
  await showShelf();
  if (isActiveAccount(request.accountVersion)) showToast(message);
}

function bindRenditionInteractions(entry, targetRendition, request) {
  if (!targetRendition) return;
  const active = () => isReaderRequestCurrent(request, book, targetRendition);
  targetRendition.on('selected', (cfi, contents) => { if (active()) onTextSelected(entry, cfi, contents); });
  targetRendition.on('selected', (cfiRange, contents) => {
    if (!active()) return;
    targetRendition.book.getRange(cfiRange).then((range) => {
      const text = range.toString().trim();
      if (text && !text.includes(' ')) {
        const rect = contents.window.getSelection().getRangeAt(0).getBoundingClientRect();
        lookupDictionary(text, rect.left + 50, rect.bottom + 50);
      } else {
        const tooltip = document.getElementById('dict-tooltip');
        if (tooltip) tooltip.classList.add('hidden');
      }
    });
  });
  targetRendition.on('markClicked', (cfi) => { if (active()) onHighlightClicked(entry, cfi); });
  targetRendition.on('mousedown', () => { if (active()) hideHighlightPopup(); });
  targetRendition.on('touchstart', () => { if (active()) hideHighlightPopup(); });
}

function getLocationsKey(bookId) {
  return `endpaper_locations_${bookId}`;
}

// NOTE (R-20): ensureLocations() was removed — it was dead code never called anywhere.
// The live location cache/generate pipeline lives in openBook() below.

/* ---------------- Opening a book ---------------- */
async function openBook(id){
  const entry = library.find(b => b.id === id);
  lastReaderInteractionAt = Date.now();
  if (!entry || !currentUser) return;
  if (currentBookId === id && rendition) return;
  if (currentBookId && (book || rendition || currentSessionId)) {
    await showShelf();
    if (!currentUser) return;
  }

  const request = createReaderRequest(id);
  const requestOptions = readerRequestOptions(request);
  currentBookId = id;
  const initialPct = (entry.progress != null && Number.isFinite(entry.progress))
    ? Math.max(0, Math.min(100, entry.progress))
    : 0;
  const initPctEl = document.getElementById('progress-pct');
  const initSliderEl = document.getElementById('progress-slider');
  if (initPctEl) initPctEl.textContent = initialPct + '%';
  if (initSliderEl) {
    initSliderEl.value = initialPct;
    initSliderEl.style.setProperty('--progress', initialPct + '%');
  }
  entry.lastOpenedAt = Date.now();
  document.getElementById('app').classList.remove('chrome-hidden');
  document.body.classList.add('reader-active');
  syncReaderPalette();
  syncReaderChromeAccessibility();
  updateFullscreenControlUI();

  document.getElementById('shelf-view').style.display = 'none';
  document.getElementById('reader-view').classList.add('active');
  document.getElementById('toc-toggle').style.display = 'flex';
  document.getElementById('search-toggle').style.display = 'flex';
  document.getElementById('settings-toggle').style.display = 'flex';
  document.getElementById('bookmarks-toggle').style.display = 'flex';
  document.getElementById('bookmark-toggle').style.display = 'flex';
  if (document.getElementById('tts-btn')) document.getElementById('tts-btn').style.display = 'flex';
  if (document.getElementById('fullscreen-btn')) document.getElementById('fullscreen-btn').style.display = 'flex';
  if (document.getElementById('reader-more-btn')) document.getElementById('reader-more-btn').style.display = 'flex';
  document.getElementById('upload-btn').style.display = 'none';

  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SET_CURRENT_BOOK', bookId: id });
  }
  window.currentBookData = entry;

  const overlay = document.getElementById('loading-overlay');
  overlay.classList.remove('hidden');
  document.getElementById('loading-text').textContent = 'Opening book…';
  document.getElementById('viewer').innerHTML = '';
  document.getElementById('search-input').value = '';
  document.getElementById('search-status').textContent = '';
  document.getElementById('search-results').innerHTML = '';

  // Fetch the EPUB file from the server
  let targetBook;
  try {
    const blob = await api.getBookFile(id, requestOptions);
    if (!isReaderRequestCurrent(request, null, null)) return;
    // R-16: Use a Blob URL — avoids .slice() copy, data lives outside the GC heap.
    // Revoke the previous URL first so the browser can release any prior backing store.
    if (currentBlobUrl) { try { URL.revokeObjectURL(currentBlobUrl); } catch (_) {} }
    currentBlobUrl = URL.createObjectURL(blob);
    targetBook = ePub(currentBlobUrl);
  } catch(err) {
    if (isReaderRequestCurrent(request, null, null) && !isAbortError(err)) {
      console.error('Failed to load book file:', err);
      await recoverFromReaderFailure(request, 'This book could not be opened. Please try again.', null, null);
    }
    return;
  }

  if (!isReaderRequestCurrent(request, null, null)) {
    try { targetBook.destroy(); } catch (e) {}
    return;
  }
  book = targetBook;

  try {
    rendition = book.renderTo('viewer', renditionOptions());
  } catch (err) {
    if (!isAbortError(err)) console.error('Failed to prepare EPUB reader:', err);
    await recoverFromReaderFailure(request, 'This EPUB could not be prepared. Please try again.', targetBook, null);
    return;
  }
  const targetRendition = rendition;
  document.getElementById('reader-view').classList.toggle('scrolled', settings.layout === 'scrolled');

  registerThemes();
  registerSwipeGestures();
  applyTheme();
  bindRenditionInteractions(entry, targetRendition, request);
  bindRelocated(entry, targetRendition, targetBook, request);

  // Load bookmarks and highlights from server
  entry.annotationLoadFailed = false;
  try {
    const [bookmarks, highlights] = await Promise.all([
      api.getBookmarks(id, requestOptions),
      api.getHighlights(id, requestOptions),
    ]);
    if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
    entry.annotationLoadFailed = false;
    entry.bookmarks = bookmarks.map(bm => ({
      id: bm.id,
      cfi: bm.cfi,
      chapter: bm.chapter || bm.label || 'Untitled section',
      pct: bm.progress_percent || 0,
      addedAt: bm.created_at ? new Date(bm.created_at).getTime() : Date.now(),
    }));
    entry.highlights = highlights.map(hl => ({
      id: hl.id,
      cfi: hl.cfi_range,
      color: hl.color || 'gold',
      excerpt: hl.excerpt || '',
      chapter: hl.chapter || 'Untitled section',
      addedAt: hl.created_at ? new Date(hl.created_at).getTime() : Date.now(),
    }));
    window.currentHighlights = entry.highlights;
  } catch(e) {
    if (isReaderRequestCurrent(request, targetBook, targetRendition) && !isAbortError(e)) {
      console.error('Failed to load bookmarks/highlights:', e);
      entry.annotationLoadFailed = true;
    }
    if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
  }

  targetRendition.display(entry.lastLocationCfi || undefined).then(() => {
    if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
    overlay.classList.add('hidden');
    // R-13: Show chrome briefly then auto-hide (Kindle-like UX)
    showReaderChromeTemporarily();
    tuneScrollContainer(targetRendition);
    updateBookmarkIcon();
    applySavedHighlights(entry, targetRendition);
  }).catch(err => {
    if (isReaderRequestCurrent(request, targetBook, targetRendition) && !isAbortError(err)) {
      console.error('Failed to render book:', err);
      recoverFromReaderFailure(request, 'This EPUB could not be displayed. Please try again.', targetBook, targetRendition);
    }
  });

  renderBookmarks();
  renderBookmarkTicks();
  renderHighlights();

  targetBook.loaded.navigation.then(nav => {
    if (isReaderRequestCurrent(request, targetBook, targetRendition)) renderToc(nav.toc);
  }).catch(() => {});

  // Only admins may change shared book metadata.
  if (isCurrentUserAdmin()) targetBook.loaded.metadata.then(meta => {
    if (isReaderRequestCurrent(request, targetBook, targetRendition) && meta && meta.title && meta.title.trim() && meta.title.trim() !== entry.name){
      entry.name = meta.title.trim();
      api.updateBook(id, { title: entry.name }, requestOptions).catch(() => {});
      renderShelf();
    }
  }).catch(() => {});

  if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;

  // Generate locations in background for accurate % and progress bar
  targetBook.ready.then(() => {
    if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
    const cachedLocations = epubLocationCache.get(readerAssetCacheKey(id));
    if (cachedLocations) {
      targetBook.locations.load(cachedLocations);
      locationsReady = true;
      syncProgressFromCurrentLocation(entry, targetBook, targetRendition, request);
      return;
    }

    const scheduleLocations = window.requestIdleCallback
      ? (cb) => window.requestIdleCallback(cb, { timeout: 4000 })
      : (cb) => setTimeout(cb, 100);

    const generateWhenQuiet = () => scheduleLocations(async () => {
      if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
      if (Date.now() - lastReaderInteractionAt < 2500) {
        generateWhenQuiet();
        return;
      }
      try {
        await targetBook.locations.generate(1024);
        if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
        locationsReady = true;
        try {
          epubLocationCache.set(readerAssetCacheKey(id), targetBook.locations.save());
        } catch (_) {}
        syncProgressFromCurrentLocation(entry, targetBook, targetRendition, request);
      } catch(e) {
        if (isReaderRequestCurrent(request, targetBook, targetRendition) && !isAbortError(e)) console.debug('Location generation skipped:', e);
      }
    });
  });

  // Start reading session for analytics
  try {
    const session = await api.startSession(id, requestOptions);
    if (!isReaderRequestCurrent(request, targetBook, targetRendition)) {
      if (session && session.id) {
        api.endSession(session.id, { expectedAccountVersion: request.accountVersion }).catch(() => {});
      }
      return;
    }
    if (session && session.id && isReaderRequestCurrent(request, targetBook, targetRendition)) {
      currentSessionId = session.id;
    } else if (session && session.id) {
      api.endSession(session.id, requestOptions).catch(() => {});
    }
  } catch(e) {
    if (isReaderRequestCurrent(request, targetBook, targetRendition) && !isAbortError(e)) console.error('Failed to start reading session:', e);
  }

  if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
  isDraggingProgressSlider = false;
  seekLockUntil = 0;

  const sliderEl = document.getElementById('progress-slider');
  if (sliderEl) {
    const startSliderDrag = () => {
      isDraggingProgressSlider = true;
      seekLockUntil = Date.now() + 5000;
    };

    sliderEl.onpointerdown = startSliderDrag;
    sliderEl.onmousedown = startSliderDrag;
    sliderEl.ontouchstart = startSliderDrag;

    sliderEl.oninput = (e) => {
      isDraggingProgressSlider = true;
      seekLockUntil = Date.now() + 5000;
      const dragPct = Math.max(0, Math.min(100, Math.round(Number(e.target.value))));
      const pctEl = document.getElementById('progress-pct');
      if (pctEl) pctEl.textContent = dragPct + '%';
      sliderEl.style.setProperty('--progress', dragPct + '%');
    };

    sliderEl.onchange = (e) => {
      isDraggingProgressSlider = true;
      seekLockUntil = Date.now() + 2000;
      const dragPct = Math.max(0, Math.min(100, Math.round(Number(e.target.value))));
      sliderEl.value = dragPct;
      sliderEl.style.setProperty('--progress', dragPct + '%');
      const pctEl = document.getElementById('progress-pct');
      if (pctEl) pctEl.textContent = dragPct + '%';
      entry.progress = dragPct;
      scheduleSaveMeta(entry, request);

      const targetFraction = dragPct / 100;
      if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;

      const unlockSeek = () => {
        setTimeout(() => {
          isDraggingProgressSlider = false;
          seekLockUntil = 0;
        }, 200);
      };

      let displayPromise = null;
      if (locationsReady && targetBook.locations && targetBook.locations.total > 0) {
        try {
          const cfi = targetBook.locations.cfiFromPercentage(targetFraction);
          if (cfi) {
            displayPromise = targetRendition.display(cfi);
          }
        } catch (_) {}
      }

      if (!displayPromise && targetBook.spine) {
        const spineItems = targetBook.spine.spineItems || (Array.isArray(targetBook.spine.items) ? targetBook.spine.items : []);
        const totalSpine = Math.max(1, spineItems.length || targetBook.spine.length || 1);
        const targetIndex = Math.min(totalSpine - 1, Math.max(0, Math.floor(targetFraction * totalSpine)));
        const item = targetBook.spine.get(targetIndex) || spineItems[targetIndex];
        if (item && (item.cfiBase || item.href)) {
          displayPromise = targetRendition.display(item.cfiBase || item.href);
        }
      }

      if (displayPromise && typeof displayPromise.then === 'function') {
        displayPromise.then(unlockSeek).catch(unlockSeek);
      } else {
        unlockSeek();
      }
    };
  }

  window.onkeydown = handleReaderShortcut;
}

let readerLocationRafId = null;
let titleUpdateTimer = null;

function scheduleDocumentTitleUpdate(titleText) {
  if (document.title === titleText) return;
  clearTimeout(titleUpdateTimer);
  titleUpdateTimer = setTimeout(() => {
    if (document.title !== titleText) document.title = titleText;
  }, 400);
}

function getSpineSection(targetBook, location, cfi) {
  if (!targetBook || !targetBook.spine) return null;
  const spineItems = targetBook.spine.spineItems || (Array.isArray(targetBook.spine.items) ? targetBook.spine.items : []);
  const totalItems = spineItems.length;

  // 1. Try EPUB.js built-in spine.get(cfi)
  if (cfi) {
    try {
      const sec = targetBook.spine.get(cfi);
      if (sec && typeof sec.index === 'number' && sec.index >= 0) return sec;
    } catch (_) {}

    // Fallback: Parse standard EPUB CFI spine component /6/(\d+)
    const match = String(cfi).match(/\/6\/(\d+)/);
    if (match && totalItems > 0) {
      const spinePos = (parseInt(match[1], 10) / 2) - 1;
      if (spinePos >= 0 && spinePos < totalItems && spineItems[spinePos]) {
        return spineItems[spinePos];
      }
    }
  }

  // 2. Try location.start href with multi-strategy path normalization
  if (location && location.start && location.start.href) {
    const rawHref = location.start.href;
    try {
      const sec = targetBook.spine.get(rawHref);
      if (sec && typeof sec.index === 'number' && sec.index >= 0) return sec;
    } catch (_) {}

    const cleanHref = rawHref.split('#')[0].split('?')[0];
    const filename = cleanHref.split('/').pop();

    if (totalItems > 0) {
      // Path-based match (safe against basename collisions)
      const matched = spineItems.find(item => {
        if (!item || !item.href) return false;
        const itemClean = item.href.split('#')[0].split('?')[0];
        return itemClean === cleanHref ||
               itemClean.endsWith('/' + cleanHref) ||
               cleanHref.endsWith('/' + itemClean);
      });
      if (matched && typeof matched.index === 'number') return matched;

      // Basename fallback: only safe when the filename is unique across the spine (R-23)
      const basenameMatches = spineItems.filter(item =>
        item && item.href && item.href.split('#')[0].split('?')[0].split('/').pop() === filename
      );
      if (basenameMatches.length === 1 && typeof basenameMatches[0].index === 'number') {
        return basenameMatches[0];
      }
    }
  }

  // 3. Try location.start.cfi
  if (location && location.start && location.start.cfi && location.start.cfi !== cfi) {
    try {
      const sec = targetBook.spine.get(location.start.cfi);
      if (sec && typeof sec.index === 'number' && sec.index >= 0) return sec;
    } catch (_) {}
    const match = String(location.start.cfi).match(/\/6\/(\d+)/);
    if (match && totalItems > 0) {
      const spinePos = (parseInt(match[1], 10) / 2) - 1;
      if (spinePos >= 0 && spinePos < totalItems && spineItems[spinePos]) {
        return spineItems[spinePos];
      }
    }
  }

  // 4. Try location.start.index
  if (location && location.start && location.start.index != null && Number.isInteger(location.start.index)) {
    const idx = location.start.index;
    if (idx >= 0 && idx < totalItems && spineItems[idx]) {
      return spineItems[idx];
    }
  }

  return null;
}

function bindRelocated(entry, targetRendition = rendition, targetBook = book, request = activeReaderRequest){
  if (!targetRendition) return;
  targetRendition.on('relocated', (location) => {
    if (!isReaderRequestCurrent(request, targetBook, targetRendition) || !location || !location.start) return;
    updateReaderLocation(entry, location, targetBook, targetRendition, request);
  });
}

function updateReaderLocation(entry, location, targetBook, targetRendition, request) {
    if (!location || !location.start || !isReaderRequestCurrent(request, targetBook, targetRendition)) return;
    const cfi = location.start.cfi;
    entry.lastLocationCfi = cfi;

    let pct = (entry.progress != null && Number.isFinite(entry.progress)) ? entry.progress : null;
    let calculatedPct = null;

    // 1. If locations are generated, use accurate location percentage
    if (locationsReady && targetBook && targetBook.locations && targetBook.locations.total > 0 && cfi) {
      try {
        const percentage = targetBook.locations.percentageFromCfi(cfi);
        if (typeof percentage === 'number' && Number.isFinite(percentage) && percentage >= 0 && percentage <= 1) {
          calculatedPct = Math.round(percentage * 100);
        }
      } catch (err) {
        console.debug('[Reader] percentageFromCfi failed:', err);
      }
    }

    // 2. Spine-based global progress calculation (accurate across all chapters even if locations.generate hasn't completed)
    if (calculatedPct === null && targetBook && targetBook.spine) {
      const spineItems = targetBook.spine.spineItems || (Array.isArray(targetBook.spine.items) ? targetBook.spine.items : []);
      const totalSections = Math.max(1, spineItems.length || targetBook.spine.length || 1);
      const section = getSpineSection(targetBook, location, cfi);

      if (section && typeof section.index === 'number' && section.index >= 0) {
        let intraFraction = 0;
        if (location.start.percentage != null && Number.isFinite(location.start.percentage) && location.start.percentage >= 0 && location.start.percentage <= 1) {
          intraFraction = location.start.percentage;
        } else if (location.start.displayed && location.start.displayed.total > 0) {
          const curPage = location.start.displayed.page || 1;
          intraFraction = Math.max(0, (curPage - 1) / location.start.displayed.total);
        }
        calculatedPct = Math.round(((section.index + intraFraction) / totalSections) * 100);
      } else {
        console.debug('[Reader] getSpineSection could not resolve section for location:', location.start);
      }
    }

    // 3. Fallback: Navigation TOC position
    if (calculatedPct === null && targetBook && targetBook.navigation && Array.isArray(targetBook.navigation.toc) && targetBook.navigation.toc.length > 0) {
      const toc = targetBook.navigation.toc;
      const href = location.start.href ? location.start.href.split('#')[0].split('?')[0] : '';
      const filename = href.split('/').pop();
      const tocIdx = toc.findIndex(t => {
        if (!t || !t.href) return false;
        const cleanT = t.href.split('#')[0].split('?')[0];
        return cleanT === href || cleanT.endsWith('/' + href) || href.endsWith('/' + cleanT) || cleanT.split('/').pop() === filename;
      });
      if (tocIdx >= 0) {
        // Use tocIdx / (length-1) so that the last entry only reaches 100% when
        // you are actually at its end, preventing premature "finished" marking (R-21)
        calculatedPct = Math.round((tocIdx / Math.max(1, toc.length - 1)) * 100);
      }
    }

    const isSeekingLocked = isDraggingProgressSlider || Date.now() < seekLockUntil;

    if (calculatedPct !== null && !isSeekingLocked) {
      pct = Math.max(0, Math.min(100, calculatedPct));
      entry.progress = pct;
    }

    // Auto-update status
    if (pct != null && pct >= 98 && entry.status !== 'finished') { // R-22: 95→98
      entry.status = 'finished';
    } else if (pct != null && pct > 0 && entry.status === 'unread') {
      entry.status = 'reading';
    }

    const chapter = targetBook.navigation && targetBook.navigation.get(location.start.href);
    const chapterLabel = chapter ? chapter.label.trim() : '';

    // Schedule lightweight, non-blocking DOM updates in requestAnimationFrame
    if (!readerLocationRafId) {
      readerLocationRafId = requestAnimationFrame(() => {
        readerLocationRafId = null;
        if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;

        const isLockedNow = isDraggingProgressSlider || Date.now() < seekLockUntil;
        const pctEl = document.getElementById('progress-pct');
        const sliderEl = document.getElementById('progress-slider');
        const chapterEl = document.getElementById('progress-chapter');

        const displayPct = pct != null ? pct : null;
        const pctText = displayPct != null ? displayPct + '%' : '—%';
        if (pctEl && !isLockedNow && pctEl.textContent !== pctText) {
          pctEl.textContent = pctText;
        }
        if (sliderEl && !isLockedNow) {
          const sliderVal = displayPct != null ? displayPct : 0;
          if (Number(sliderEl.value) !== sliderVal) sliderEl.value = sliderVal;
          sliderEl.style.setProperty('--progress', (displayPct != null ? displayPct : 0) + '%');
        }

        if (chapterEl && chapterEl.textContent !== chapterLabel) {
          chapterEl.textContent = chapterLabel;
        }

        updateBookmarkIcon(cfi);
      });
    }

    if (!isSeekingLocked) {
      scheduleDocumentTitleUpdate(`${entry.name} — ${pct != null ? pct + '%' : '—%'} | Endpaper`);
      scheduleSaveMeta(entry, request);
    }
}

async function syncProgressFromCurrentLocation(entry, targetBook, targetRendition, request) {
  if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
  const location = await getCurrentLocationSafe(targetRendition);
  if (location && isReaderRequestCurrent(request, targetBook, targetRendition)) updateReaderLocation(entry, location, targetBook, targetRendition, request);
}

/* ---------------- Bookmarks ---------------- */
function getCurrentEntry(){
  return library.find(b => b.id === currentBookId);
}

function createReaderMutationContext(entry = getCurrentEntry()){
  const request = activeReaderRequest;
  const targetBook = book;
  const targetRendition = rendition;
  if (!entry || !isReaderRequestCurrent(request, targetBook, targetRendition)) return null;
  return {
    entry,
    request,
    targetBook,
    targetRendition,
    requestOptions: readerRequestOptions(request),
  };
}

function isReaderMutationCurrent(context){
  return Boolean(
    context && getCurrentEntry() === context.entry &&
    isReaderRequestCurrent(context.request, context.targetBook, context.targetRendition)
  );
}

async function toggleBookmark(){
  const entry = getCurrentEntry();
  const context = createReaderMutationContext(entry);
  if (!context) return;
  const { targetBook, targetRendition, requestOptions } = context;
  const loc = await getCurrentLocationSafe(targetRendition);
  if (!loc || !loc.start) return;
  const cfi = loc.start.cfi;

  const existingIdx = entry.bookmarks.findIndex(bm => bm.cfi === cfi);
  if (existingIdx > -1){
    const removed = entry.bookmarks.splice(existingIdx, 1)[0];
    if (removed.id) {
      api.removeBookmark(removed.id, requestOptions).catch(e => {
        if (isReaderMutationCurrent(context) && !isAbortError(e)) console.error('Remove bookmark failed:', e);
      });
    }
  } else {
    const pending = entry.__pendingBookmarks || (entry.__pendingBookmarks = new Set());
    if (pending.has(cfi)) return;
    pending.add(cfi);
    const chapter = targetBook.navigation && targetBook.navigation.get(loc.start.href);
    let pct = 0;
    if (locationsReady) pct = Math.round(targetBook.locations.percentageFromCfi(cfi) * 100);
    else if (loc.start.percentage != null) pct = Math.round(loc.start.percentage * 100);

    const chapterLabel = chapter ? chapter.label.trim() : 'Untitled section';

    try {
      const saved = await resilientApiPost(`/api/books/${entry.id}/bookmarks`, {
        cfi,
        chapter: chapterLabel,
        label: chapterLabel,
        progress_percent: pct,
      }, false, 'POST', requestOptions);
      if (!isReaderMutationCurrent(context)) return;
      if (!entry.bookmarks.some(bookmark => bookmark.cfi === cfi)) {
        entry.annotationLoadFailed = false;
        entry.bookmarks.push({
          id: (saved && saved.id) || ('temp_' + Date.now()),
          cfi,
          chapter: chapterLabel,
          pct,
          addedAt: Date.now(),
        });
        entry.bookmarks.sort((a, b) => a.pct - b.pct);
      }
    } catch(e) {
      if (isReaderMutationCurrent(context) && !isAbortError(e)) console.error('Add bookmark failed:', e);
    } finally {
      pending.delete(cfi);
    }
  }
  if (!isReaderMutationCurrent(context)) return;
  updateBookmarkIcon();
  renderBookmarks();
  renderBookmarkTicks();
}

async function updateBookmarkIcon(knownCfi){
  const btn = document.getElementById('bookmark-toggle');
  const entry = getCurrentEntry();
  if (!entry || !rendition){ if (btn) btn.classList.remove('active'); return; }
  const cfi = knownCfi !== undefined ? knownCfi : ((await getCurrentLocationSafe(rendition))?.start?.cfi || null);
  const bookmarked = !!cfi && entry.bookmarks.some(bm => bm.cfi === cfi);
  if (btn && btn.classList.contains('active') !== bookmarked) {
    btn.classList.toggle('active', bookmarked);
    btn.title = bookmarked ? 'Remove bookmark' : 'Bookmark this page';
  }
}

function renderBookmarks(){
  const entry = getCurrentEntry();
  const list = document.getElementById('bookmarks-list');
  list.innerHTML = '';
  if (entry && entry.annotationLoadFailed && (!entry.bookmarks || entry.bookmarks.length === 0)) {
    list.innerHTML = '<div class="bookmark-empty" style="color:#C14B4B;">Could not load bookmarks. Please try reopening the book.</div>';
    return;
  }
  if (!entry || entry.bookmarks.length === 0){
    list.innerHTML = '<div class="bookmark-empty">No bookmarks yet — tap the ribbon icon in the top bar while reading to save your place.</div>';
    return;
  }
  entry.bookmarks.forEach(bm => {
    const item = document.createElement('div');
    item.className = 'bookmark-item';
    item.innerHTML = `
      <div class="bookmark-chapter">${escapeHtml(bm.chapter)}</div>
      <div class="bookmark-meta">
        <span class="bookmark-pct">${bm.pct}% through the book</span>
        <button class="bookmark-remove">Remove</button>
      </div>
    `;
    item.querySelector('.bookmark-chapter').onclick =
      item.querySelector('.bookmark-pct').onclick = () => {
        if (getCurrentEntry() !== entry || !rendition) return;
        rendition.display(bm.cfi);
        toggleDrawer('bookmarks', true);
      };
    item.querySelector('.bookmark-remove').onclick = (e) => {
      e.stopPropagation();
      const context = createReaderMutationContext(entry);
      if (!context) return;
      entry.bookmarks = entry.bookmarks.filter(b => b.cfi !== bm.cfi);
      if (bm.id) {
        api.removeBookmark(bm.id, context.requestOptions).catch(err => {
          if (isReaderMutationCurrent(context) && !isAbortError(err)) console.error('Remove bookmark failed:', err);
        });
      }
      if (!isReaderMutationCurrent(context)) return;
      renderBookmarks();
      renderBookmarkTicks();
      updateBookmarkIcon();
    };
    list.appendChild(item);
  });
}

function renderBookmarkTicks(){
  const entry = getCurrentEntry();
  const wrap = document.getElementById('bookmark-ticks');
  wrap.innerHTML = '';
  if (!entry) return;
  entry.bookmarks.forEach(bm => {
    const dot = document.createElement('div');
    dot.className = 'bookmark-tick';
    dot.style.left = bm.pct + '%';
    dot.title = bm.chapter + ' — ' + bm.pct + '%';
    dot.onclick = () => rendition && rendition.display(bm.cfi);
    wrap.appendChild(dot);
  });
}

function setMarksTab(paneId){
  document.querySelectorAll('.marks-tab').forEach(t => {
    const selected = t.dataset.tab === paneId;
    t.classList.toggle('active', selected);
    t.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('.marks-pane').forEach(p => {
    const selected = p.id === paneId;
    p.classList.toggle('active', selected);
    p.hidden = !selected;
  });
}

function moveRadioOption(event, selector){
  const option = event.target && event.target.closest && event.target.closest(selector);
  if (!option || !['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'].includes(event.key)) return false;
  const options = Array.from(option.closest('[role="radiogroup"]').querySelectorAll(selector));
  const currentIndex = options.indexOf(option);
  if (currentIndex < 0 || options.length === 0) return false;
  let nextIndex = currentIndex;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + options.length) % options.length;
  else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = options.length - 1;
  event.preventDefault();
  options[nextIndex].focus();
  options[nextIndex].click();
  return true;
}

function handleReaderSettingsKeydown(event){
  if (moveRadioOption(event, '.layout-option')) return;
  if (moveRadioOption(event, '.theme-swatch')) return;
  if (moveRadioOption(event, '.font-option')) return;
  const tab = event.target && event.target.closest && event.target.closest('.marks-tab');
  if (!tab || !['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(tab.closest('[role="tablist"]').querySelectorAll('.marks-tab'));
  const index = tabs.indexOf(tab);
  let nextIndex = index;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  event.preventDefault();
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
}
document.addEventListener('keydown', handleReaderSettingsKeydown);

/* ---------------- Highlights ---------------- */
let pendingHighlightCfi = null;
let pendingHighlightContext = null;
let highlightReturnFocus = null;

function onTextSelected(entry, cfi, contents){
  if (!contents) return;
  const context = createReaderMutationContext(entry);
  if (!context) return;
  const win = contents.window || (contents.document && contents.document.defaultView);
  if (!win) return;
  const sel = win.getSelection();
  const text = sel ? sel.toString().trim() : '';
  if (!text) return;
  context.cfi = cfi;
  context.excerpt = text.length > 140 ? text.slice(0, 140) + '…' : text;
  context.returnFocus = contents.document.defaultView && contents.document.defaultView.frameElement;
  pendingHighlightContext = context;
  highlightReturnFocus = context.returnFocus;
  pendingHighlightCfi = cfi;

  try {
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const iframe = contents.document.defaultView.frameElement;
    const iframeRect = iframe ? iframe.getBoundingClientRect() : { left: 0, top: 0 };
    showHighlightPopup(iframeRect.left + rect.left + rect.width / 2, iframeRect.top + rect.top, false);
  } catch(e){ showHighlightPopup(window.innerWidth / 2, 90, false); }
}

function onHighlightClicked(entry, cfi){
  const context = createReaderMutationContext(entry);
  if (!context) return;
  const hl = entry.highlights.find(h => h.cfi === cfi);
  if (!hl) return;
  context.cfi = cfi;
  context.excerpt = hl.excerpt || '';
  context.returnFocus = document.querySelector('#viewer iframe');
  pendingHighlightContext = context;
  highlightReturnFocus = context.returnFocus;
  pendingHighlightCfi = cfi;
  showHighlightPopup(window.innerWidth / 2, 90, true);
}

function showHighlightPopup(x, y, isExisting){
  const popup = document.getElementById('highlight-popup');
  popup.style.left = Math.max(60, Math.min(window.innerWidth - 60, x)) + 'px';
  popup.style.top = Math.max(70, y - 46) + 'px';
  popup.style.transform = 'translateX(-50%)';
  document.getElementById('highlight-remove-btn').style.display = isExisting ? 'inline' : 'none';
  popup.setAttribute('aria-hidden', 'false');
  popup.classList.add('show');
  const context = pendingHighlightContext;
  requestAnimationFrame(() => {
    if (popup.classList.contains('show') && pendingHighlightContext === context) {
      const target = popup.querySelector('.swatch-btn');
      if (target) target.focus({ preventScroll: true });
    }
  });
}
function hideHighlightPopup({ returnFocus = false } = {}){
  const popup = document.getElementById('highlight-popup');
  const focusTarget = highlightReturnFocus;
  popup.classList.remove('show');
  popup.setAttribute('aria-hidden', 'true');
  pendingHighlightCfi = null;
  pendingHighlightContext = null;
  highlightReturnFocus = null;
  if (returnFocus && focusTarget && focusTarget.isConnected) {
    setTimeout(() => {
      try { focusTarget.focus({ preventScroll: true }); } catch (e) {}
    }, 0);
  }
}

function finishPendingHighlight(context, returnFocus = true){
  if (pendingHighlightContext === context) hideHighlightPopup({ returnFocus });
}

function highlightStyle(color){
  const isDarkPage = settings.theme === 'dark' || settings.theme === 'night';
  return {
    fill: color,
    'fill-opacity': isDarkPage ? '0.62' : '0.4',
    // Multiply makes coloured SVG highlights almost disappear on black pages.
    'mix-blend-mode': isDarkPage ? 'screen' : 'multiply',
  };
}

function refreshHighlightStyles(){
  const entry = getCurrentEntry();
  if (!entry || !rendition || !entry.highlights) return;
  entry.highlights.forEach(highlight => {
    try { rendition.annotations.remove(highlight.cfi, 'highlight'); } catch (e) {}
    try {
      rendition.annotations.add('highlight', highlight.cfi, {}, null, 'epub-highlight', highlightStyle(highlight.color));
    } catch (e) {}
  });
}

async function applyHighlight(color){
  const context = pendingHighlightContext;
  if (!context || !pendingHighlightCfi || !isReaderMutationCurrent(context)) { hideHighlightPopup(); return; }
  if (context.saving) return;
  context.saving = true;
  const { entry, targetBook, targetRendition, requestOptions } = context;
  const cfi = context.cfi;
  const existing = entry.highlights.find(h => h.cfi === cfi);
  if (existing){
    try { targetRendition.annotations.remove(existing.cfi, 'highlight'); } catch(e){}
    existing.color = color;
    if (existing.id) {
      api.updateHighlight(existing.id, { color }, requestOptions).catch(e => {
        if (isReaderMutationCurrent(context) && !isAbortError(e)) console.error('Update highlight failed:', e);
      });
    }
  } else {
    const location = await getCurrentLocationSafe(targetRendition);
    const chapter = targetBook.navigation && location && location.start && targetBook.navigation.get(location.start.href);
    const chapterLabel = chapter ? chapter.label.trim() : 'Untitled section';
    const excerpt = context.excerpt || '';

    try {
      const saved = await resilientApiPost(`/api/books/${entry.id}/highlights`, {
        cfi_range: cfi,
        color,
        excerpt,
        chapter: chapterLabel,
      }, false, 'POST', requestOptions);
      if (!isReaderMutationCurrent(context)) return;
      entry.annotationLoadFailed = false;
      entry.highlights.push({
        id: (saved && saved.id) || ('temp_' + Date.now()),
        cfi,
        color,
        excerpt,
        chapter: chapterLabel,
        addedAt: Date.now(),
      });
    } catch(e) {
      if (isReaderMutationCurrent(context) && !isAbortError(e)) console.error('Add highlight failed:', e);
      finishPendingHighlight(context);
      return;
    } finally {
      context.saving = false;
    }
  }
  context.saving = false;
  if (!isReaderMutationCurrent(context)) return;
  targetRendition.annotations.add('highlight', cfi, {}, null, 'epub-highlight', highlightStyle(color));
  try {
    targetRendition.getContents().forEach(c => {
      const win = c.window || (c.document && c.document.defaultView);
      if (win) win.getSelection().removeAllRanges();
    });
  } catch(e){}
  finishPendingHighlight(context);
  renderHighlights();
}

async function removeCurrentHighlight(){
  const context = pendingHighlightContext;
  if (!context || !pendingHighlightCfi || !isReaderMutationCurrent(context)) { hideHighlightPopup(); return; }
  const { entry, targetRendition, requestOptions } = context;
  const cfi = context.cfi;
  try { targetRendition.annotations.remove(cfi, 'highlight'); } catch(e){}
  const removed = entry.highlights.find(h => h.cfi === cfi);
  entry.highlights = entry.highlights.filter(h => h.cfi !== cfi);
  if (removed && removed.id) {
    api.removeHighlight(removed.id, requestOptions).catch(e => {
      if (isReaderMutationCurrent(context) && !isAbortError(e)) console.error('Remove highlight failed:', e);
    });
  }
  if (!isReaderMutationCurrent(context)) return;
  finishPendingHighlight(context);
  renderHighlights();
}

function applySavedHighlights(entry, targetRendition = rendition){
  if (!targetRendition || !entry.highlights) return;
  entry.highlights.forEach(h => {
    try {
      targetRendition.annotations.add('highlight', h.cfi, {}, null, 'epub-highlight', highlightStyle(h.color));
    } catch(e){}
  });
}

function renderHighlights(){
  const entry = getCurrentEntry();
  const list = document.getElementById('highlights-list');
  list.innerHTML = '';
  if (entry && entry.annotationLoadFailed && (!entry.highlights || entry.highlights.length === 0)) {
    list.innerHTML = '<div class="bookmark-empty" style="color:#C14B4B;">Could not load highlights. Please try reopening the book.</div>';
    return;
  }
  if (!entry || entry.highlights.length === 0){
    list.innerHTML = '<div class="bookmark-empty">No highlights yet — select any text while reading to mark it.</div>';
    return;
  }
  entry.highlights.forEach(h => {
    const item = document.createElement('div');
    item.className = 'highlight-item';
    item.innerHTML = `
      <div class="highlight-excerpt"><span class="highlight-swatch" style="background:${h.color}"></span>"${escapeHtml(h.excerpt)}"</div>
    `;
    item.onclick = () => { rendition.display(h.cfi); toggleDrawer('bookmarks', true); };
    list.appendChild(item);
  });
}

/* ---------------- Search ---------------- */
let searchDebounce = null;
let searchRequestVersion = 0;
const bookSearchIndex = new Map();
const bookTextIndex = new Map();

async function getBookTextIndex(targetBook, bookId, isCurrentSearch) {
  if (bookTextIndex.has(bookId)) return bookTextIndex.get(bookId);
  const pending = (async () => {
    const sections = [];
    if (targetBook.spine && typeof targetBook.spine.each === 'function') {
      targetBook.spine.each(section => sections.push(section));
    }
    const indexed = [];
    for (const section of sections) {
      if (!isCurrentSearch()) return null;
      try {
        const documentNode = await section.load(targetBook.load.bind(targetBook));
        if (!isCurrentSearch()) return null;
        const textContent = documentNode?.documentElement?.textContent || documentNode?.body?.textContent || '';
        indexed.push({ section, text: textContent.normalize('NFKC').toLocaleLowerCase() });
      } catch (_) {
        indexed.push({ section, text: '' });
      } finally {
        if (typeof section.unload === 'function') section.unload();
      }
    }
    return indexed;
  })();
  bookTextIndex.set(bookId, pending);
  try {
    const indexed = await pending;
    if (!indexed) bookTextIndex.delete(bookId);
    while (bookTextIndex.size > 3) bookTextIndex.delete(bookTextIndex.keys().next().value);
    return indexed;
  } catch (error) {
    bookTextIndex.delete(bookId);
    throw error;
  }
}
document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const requestVersion = ++searchRequestVersion;
  const q = e.target.value.trim();
  if (q.length < 3){
    document.getElementById('search-status').textContent = q.length ? 'Keep typing…' : '';
    document.getElementById('search-results').innerHTML = '';
    return;
  }
  searchDebounce = setTimeout(() => runSearch(q, requestVersion), 300);
});

async function runSearch(query, requestVersion = ++searchRequestVersion){
  const targetBook = book;
  const targetRendition = rendition;
  const isCurrentSearch = () => (
    requestVersion === searchRequestVersion &&
    targetBook === book &&
    targetRendition === rendition &&
    Boolean(currentBookId)
  );
  if (!targetBook || !isCurrentSearch()) return;
  document.getElementById('search-status').textContent = 'Searching…';
  const resultsEl = document.getElementById('search-results');
  resultsEl.innerHTML = '';
  let results = [];
  try {
    const cacheKey = `${currentBookId}:${query.toLocaleLowerCase()}`;
    const cached = bookSearchIndex.get(cacheKey);
    if (cached) {
      results = cached;
    } else {
      const indexedSections = await getBookTextIndex(targetBook, currentBookId, isCurrentSearch);
      if (!indexedSections || !isCurrentSearch()) return;
      const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase();
      const candidates = indexedSections.filter(item => item.text.includes(normalizedQuery));
      for (const { section } of candidates){
        try {
          await section.load(targetBook.load.bind(targetBook));
          if (!isCurrentSearch()) return;
          const matches = section.find(query) || [];
          matches.forEach(m => results.push({ cfi: m.cfi, excerpt: m.excerpt, href: section.href }));
        } catch(e){ /* skip unreadable section */ }
        finally { if (typeof section.unload === 'function') section.unload(); }
        if (results.length > 60) break;
      }
      bookSearchIndex.set(cacheKey, results.slice(0, 61));
      while (bookSearchIndex.size > 100) bookSearchIndex.delete(bookSearchIndex.keys().next().value);
    }
    if (!isCurrentSearch()) return;
    document.getElementById('search-status').textContent =
      results.length === 0 ? 'No matches found.' : results.length + ' match' + (results.length === 1 ? '' : 'es');
    const re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    results.forEach(r => {
      const chapter = targetBook.navigation && targetBook.navigation.get(r.href);
      const item = document.createElement('div');
      item.className = 'search-result';
      item.innerHTML = `
        <div class="search-chapter">${chapter ? escapeHtml(chapter.label.trim()) : ''}</div>
        <div class="search-excerpt">${escapeHtml(r.excerpt).replace(re, '<mark>$1</mark>')}</div>
      `;
      item.onclick = () => {
        if (!isCurrentSearch()) return;
        rendition.display(r.cfi);
        toggleDrawer('search', true);
      };
      resultsEl.appendChild(item);
    });
  } catch (err) {
    if (!isCurrentSearch()) return;
    console.error('Search failed:', err);
    document.getElementById('search-status').textContent = 'Search failed — try a shorter query.';
  }
}

/* ---------------- Fullscreen & shortcuts modal ---------------- */
function toggleFullscreen(){
  const app = document.getElementById('app');
  if (!app) return;
  if (isImmersiveReading() || readerFullscreenElement()) {
    exitImmersiveReading();
  } else {
    enterImmersiveReading();
    requestReaderFullscreen();
  }
}

function isEditableShortcutTarget(target){
  const element = target && target.nodeType === Node.ELEMENT_NODE ? target : target && target.parentElement;
  return Boolean(element && (element.matches('input, textarea, select, [contenteditable="true"]') || element.closest('[contenteditable="true"]')));
}

function handleReaderShortcut(e){
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape'){
    e.preventDefault();
    closeDrawers();
    closeShortcutsModal();
    hideHighlightPopup({ returnFocus: true });
    document.getElementById('app').classList.remove('chrome-hidden');
    syncReaderChromeAccessibility();
    exitReaderFullscreen();
    updateFullscreenControlUI();
    scheduleReaderResize();
    return;
  }
  if (isEditableShortcutTarget(e.target)) return;
  // Preserve native text selection/caret movement in the EPUB document.
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.shiftKey) return;
  if (!rendition) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); turnPage('prev'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); turnPage('next'); }
  else if (e.key === ' '){ e.preventDefault(); if (!pageScroll(e.shiftKey ? -1 : 1)) turnPage(e.shiftKey ? 'prev' : 'next'); }
  else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); toggleBookmark(); }
  else if (e.key === 't' || e.key === 'T') { e.preventDefault(); toggleDrawer('toc'); }
  else if (e.key === 's' || e.key === 'S') { e.preventDefault(); toggleDrawer('settings'); }
  else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleDrawer('bookmarks'); }
  else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
  else if (e.key === 'h' || e.key === 'H') { e.preventDefault(); showShelf(); }
  else if (e.key === '/'){ e.preventDefault(); toggleDrawer('search'); document.getElementById('search-input').focus(); }
  else if (e.key === '?') { e.preventDefault(); openShortcutsModal(); }
}

function syncReaderFullscreenState(){
  const app = document.getElementById('app');
  if (!readerFullscreenElement() && document.body.classList.contains('reader-active')) {
    app.classList.remove('chrome-hidden');
  }
  syncReaderChromeAccessibility();
  updateFullscreenControlUI();
  scheduleReaderResize();
}
document.addEventListener('fullscreenchange', syncReaderFullscreenState);
document.addEventListener('webkitfullscreenchange', syncReaderFullscreenState);

function getShortcutsFocusableElements(){
  const modal = document.getElementById('shortcuts-modal');
  return Array.from(modal.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
    .filter(element => element.getClientRects().length > 0);
}

function openShortcutsModal(){
  const modal = document.getElementById('shortcuts-modal');
  const active = document.activeElement;
  shortcutsModalReturnFocus = active instanceof HTMLElement ? active : document.getElementById('help-toggle');
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    const first = getShortcutsFocusableElements()[0];
    if (first) first.focus({ preventScroll: true });
  });
}

function closeShortcutsModal({ returnFocus = true } = {}){
  const modal = document.getElementById('shortcuts-modal');
  if (!modal.classList.contains('show')) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  const target = shortcutsModalReturnFocus;
  shortcutsModalReturnFocus = null;
  if (returnFocus && target && target.isConnected && !target.hidden) {
    target.focus({ preventScroll: true });
  }
}

function handleShortcutsModalKeydown(event){
  const modal = document.getElementById('shortcuts-modal');
  if (!modal.classList.contains('show')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeShortcutsModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = getShortcutsFocusableElements();
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
document.addEventListener('keydown', handleShortcutsModalKeydown);
document.addEventListener('mousedown', (e) => {
  const popup = document.getElementById('highlight-popup');
  if (popup.classList.contains('show') && !popup.contains(e.target)) hideHighlightPopup();
});

function renderToc(toc){
  const list = document.getElementById('toc-list');
  list.innerHTML = '';
  function walk(items, depth){
    items.forEach(item => {
      const a = document.createElement('a');
      a.className = 'toc-item';
      a.style.paddingLeft = (4 + depth * 14) + 'px';
      a.textContent = item.label.trim();
      a.href = 'javascript:void(0)';
      a.onclick = () => { rendition.display(item.href); toggleDrawer('toc', true); };
      list.appendChild(a);
      if (item.subitems && item.subitems.length) walk(item.subitems, depth + 1);
    });
  }
  walk(toc, 0);
}

/* ---------------- Theming (reading pane) ---------------- */
function registerThemes(){
  Object.keys(THEMES).forEach(key => {
    const t = THEMES[key];
    rendition.themes.register(key, {
      'body': { 'background': t.body + ' !important', 'color': t.text + ' !important' },
      [EPUB_TEXT_SELECTORS]: { 'color': t.text + ' !important' },
      'a, a:link, a:visited': { 'color': t.link + ' !important' },
      '::selection': { 'background': 'rgba(169,128,63,0.35)' },
    });
  });
}

function syncReaderPalette(){
  const readerTheme = THEMES[settings.theme] || THEMES.light;
  const app = document.getElementById('app');
  if (app) app.style.setProperty('--reader-page-bg', readerTheme.body);
  const viewerWrap = document.getElementById('viewer-wrap');
  if (viewerWrap) viewerWrap.style.backgroundColor = readerTheme.body;
  const readerView = document.getElementById('reader-view');
  if (readerView) readerView.style.backgroundColor = readerTheme.body;

  const isReaderActive = document.body.classList.contains('reader-active');
  const shellColor = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#F6F1E7';
  const effectiveBg = isReaderActive ? readerTheme.body : shellColor;
  
  document.documentElement.style.backgroundColor = effectiveBg;
  document.body.style.backgroundColor = effectiveBg;

  // Track nav zone width so click zones never overlap rendered text
  const marginRaw = parseInt(MARGIN_PADDING[settings.marginIdx], 10) || 10;
  const isHover = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(hover: hover)').matches;
  const effectiveMargin = isHover ? Math.max(marginRaw, 8) : marginRaw;
  const navZoneWidth = Math.min(15, effectiveMargin);
  document.documentElement.style.setProperty('--nav-zone-width', `${navZoneWidth}%`);

  // Match Safari/PWA browser chrome to the actual reading page so the safe
  // areas do not appear as contrasting grey bands.
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.content = effectiveBg;
  }
}

function applyTheme(){
  syncReaderPalette();
  if (!rendition) { updateSettingsUI(); saveSettings(); return; }
  rendition.themes.select(settings.theme);
  const fontCss = FONTS.find(f => f.name === settings.font).css;
  rendition.themes.font(fontCss);
  rendition.themes.fontSize(settings.fontSize + '%');
  let paddingVal = MARGIN_PADDING[settings.marginIdx];
  if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
    paddingVal = `max(${paddingVal}, 44px, 8%)`;
  }
  const vPad = settings.layout === 'scrolled' ? '0' : '12px';
  rendition.themes.override('padding', `${vPad} ${paddingVal}`, true);
  rendition.themes.override('line-height', (settings.lineHeight / 100).toString(), true);
  rendition.themes.override('letter-spacing', SPACING_VALUES[settings.letterSpacingIdx], true);
  // Page appearance belongs inside the EPUB iframe; never tint the library shell.
  document.body.style.removeProperty('background');
  if (rendition && typeof rendition.views === 'function') {
    rendition.views().forEach(v => {
      if (v && v.contents) applyReaderContentStyles(v.contents);
    });
  }
  updateSettingsUI();
  saveSettings();
}

function updateSettingsUI(){
  document.querySelectorAll('.layout-option').forEach(el => {
    const selected = el.dataset.layout === settings.layout;
    el.classList.toggle('active', selected);
    el.setAttribute('aria-checked', String(selected));
  });
  document.querySelectorAll('.theme-swatch').forEach(el => {
    const selected = el.dataset.theme === settings.theme;
    el.classList.toggle('active', selected);
    el.setAttribute('aria-checked', String(selected));
  });
  document.getElementById('font-size-val').textContent = settings.fontSize + '%';
  document.getElementById('line-height-val').textContent = (settings.lineHeight/100).toFixed(1);
  document.getElementById('line-height-slider').value = settings.lineHeight;
  document.getElementById('line-height-slider').setAttribute('aria-valuetext', (settings.lineHeight / 100).toFixed(1) + ' line spacing');
  document.getElementById('margin-val').textContent = MARGIN_LABELS[settings.marginIdx];
  document.getElementById('margin-slider').value = settings.marginIdx;
  document.getElementById('margin-slider').setAttribute('aria-valuetext', MARGIN_LABELS[settings.marginIdx] + ' page width');
  document.getElementById('letter-spacing-val').textContent = SPACING_LABELS[settings.letterSpacingIdx];
  document.getElementById('letter-spacing-slider').value = settings.letterSpacingIdx;
  document.getElementById('letter-spacing-slider').setAttribute('aria-valuetext', SPACING_LABELS[settings.letterSpacingIdx] + ' letter spacing');
}

function setReadingTheme(name){
  if (!THEMES[name]) return;
  settings.theme = name;
  applyTheme();
  refreshHighlightStyles();
}
function stepFontSize(dir){
  settings.fontSize = Math.max(70, Math.min(220, settings.fontSize + dir * 10));
  applyTheme();
}
document.getElementById('line-height-slider').addEventListener('input', e => {
  settings.lineHeight = parseInt(e.target.value); applyTheme();
});
document.getElementById('margin-slider').addEventListener('input', e => {
  settings.marginIdx = parseInt(e.target.value); applyTheme();
});
document.getElementById('letter-spacing-slider').addEventListener('input', e => {
  settings.letterSpacingIdx = parseInt(e.target.value); applyTheme();
});

/* ---------------- Drawers ---------------- */
const DRAWER_IDS = ['toc', 'search', 'bookmarks', 'settings'];
let drawerReturnFocus = null;

function toggleDrawer(which, forceClose){
  const el = document.getElementById(which + '-drawer');
  const wasOpen = el.classList.contains('open');
  const willOpen = forceClose ? false : !wasOpen;

  DRAWER_IDS.forEach(id => {
    const d = document.getElementById(id + '-drawer');
    if (d) d.classList.remove('open');
  });

  if (willOpen) {
    const active = document.activeElement;
    drawerReturnFocus = active instanceof HTMLElement ? active : document.querySelector(`[data-drawer-toggle="${which}"]`);
    el.classList.add('open');
    requestAnimationFrame(() => {
      if (which === 'search') {
        const input = document.getElementById('search-input');
        if (input) input.focus();
      } else {
        const focusable = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable.length > 0) focusable[0].focus();
      }
    });
  } else {
    el.classList.remove('open');
    if (drawerReturnFocus && drawerReturnFocus.isConnected && !drawerReturnFocus.hidden) {
      drawerReturnFocus.focus({ preventScroll: true });
      drawerReturnFocus = null;
    }
  }
  updateDrawerBackdrop();
}
function closeDrawers({ returnFocus = true } = {}){
  DRAWER_IDS.forEach(id => document.getElementById(id + '-drawer').classList.remove('open'));
  updateDrawerBackdrop();
  if (returnFocus && drawerReturnFocus && drawerReturnFocus.isConnected && !drawerReturnFocus.hidden) {
    drawerReturnFocus.focus({ preventScroll: true });
  }
  drawerReturnFocus = null;
}
function updateDrawerBackdrop(){
  const anyOpen = DRAWER_IDS.some(id => document.getElementById(id + '-drawer').classList.contains('open'));
  document.getElementById('drawer-backdrop').classList.toggle('show', anyOpen);
  DRAWER_IDS.forEach(id => {
    const drawer = document.getElementById(id + '-drawer');
    const open = drawer.classList.contains('open');
    drawer.setAttribute('aria-hidden', String(!open));
    drawer.toggleAttribute('inert', !open);
    document.querySelectorAll(`[data-drawer-toggle="${id}"]`).forEach(toggle => {
      toggle.setAttribute('aria-expanded', String(open));
    });
  });
}

/* ---------------- App shell (chrome) dark mode ---------------- */
function updateShellThemeControl(){
  const control = document.getElementById('shell-theme-toggle');
  if (!control) return;
  const dark = document.documentElement.classList.contains('dark-shell');
  control.setAttribute('aria-pressed', String(dark));
  control.setAttribute('aria-label', dark ? 'Use light app appearance' : 'Use dark app appearance');
  control.title = dark ? 'Use light app appearance' : 'Use dark app appearance';
  syncReaderPalette();
}

function toggleShellTheme(){
  document.documentElement.classList.toggle('dark-shell');
  const theme = document.documentElement.classList.contains('dark-shell') ? 'dark' : 'light';
  updateShellThemeControl();
  const expectedAccountVersion = accountVersion;
  api.saveSettings({ 'shell-theme': theme }, { expectedAccountVersion }).catch(e => console.error('Could not save shell theme', e));
}

/* ---------------- Persistence (API-backed) ---------------- */

const OFFLINE_QUEUE_PREFIX = 'endpaper_offline_queue:';
const OFFLINE_QUEUE_MAX_ITEMS = 200;
const OFFLINE_QUEUE_MAX_BYTES = 2 * 1024 * 1024;
const OFFLINE_QUEUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function offlineQueueKey() {
  return currentUser && currentUser.username ? OFFLINE_QUEUE_PREFIX + encodeURIComponent(currentUser.username.toLocaleLowerCase()) : null;
}

function setSyncState(state, detail = '') {
  const element = document.getElementById('sync-status');
  if (!element) return;
  element.dataset.state = state;
  element.textContent = detail || ({ saved: 'Saved', saving: 'Saving…', syncing: 'Syncing…', offline: 'Offline', pending: 'Changes pending' }[state] || '');
  element.hidden = !element.textContent;
}

function loadOfflineQueue() {
  const key = offlineQueueKey();
  if (!key) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    const cutoff = Date.now() - OFFLINE_QUEUE_TTL_MS;
    return Array.isArray(parsed) ? parsed.filter(item => item && item.ts >= cutoff && item.account === currentUser.username) : [];
  } catch (_) { return []; }
}

function storeOfflineQueue(queue) {
  const key = offlineQueueKey();
  if (!key) return;
  let bounded = queue.slice(-OFFLINE_QUEUE_MAX_ITEMS);
  while (bounded.length && new Blob([JSON.stringify(bounded)]).size > OFFLINE_QUEUE_MAX_BYTES) bounded.shift();
  if (bounded.length) localStorage.setItem(key, JSON.stringify(bounded));
  else localStorage.removeItem(key);
  setSyncState(bounded.length ? (navigator.onLine ? 'pending' : 'offline') : 'saved', bounded.length ? `${bounded.length} change${bounded.length === 1 ? '' : 's'} pending` : 'Saved');
}

async function resilientApiPost(url, body, isProgressSave = false, method = 'POST', opts = {}) {
  const operationId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  setSyncState(navigator.onLine ? 'saving' : 'offline');
  try {
    const headers = new Headers(opts.headers || {});
    headers.set('Idempotency-Key', operationId);
    const res = await api.fetch(url, {
      ...opts,
      headers,
      method,
      body: JSON.stringify(body),
    });
    generateWhenQuiet();
    setSyncState('saved');
    return await res.json().catch(() => ({ ok: true }));
  } catch (networkErr) {
    if (isAbortError(networkErr) || (networkErr && networkErr.message === 'Session expired')) {
      throw networkErr;
    }
    // HTTP failures are permanent/application errors, not evidence of being
    // offline. Queue only a genuine fetch/network failure.
    if (networkErr && networkErr.status && !networkErr.isOffline) throw networkErr;
    const queue = loadOfflineQueue();
    const item = { url, body, method, ts: Date.now(), operationId, account: currentUser.username };
    const next = isProgressSave ? queue.filter(queued => queued.url !== url).concat(item) : queue.concat(item);
    storeOfflineQueue(next);
    return { queued: true };
  }
}

async function flushOfflineQueue() {
  try {
    const queue = loadOfflineQueue();
    if (!Array.isArray(queue) || !queue.length) return;

    setSyncState('syncing');
    const failed = [];
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index];
      try {
        await api.fetch(item.url, {
          method: item.method || 'POST',
          headers: { 'Idempotency-Key': item.operationId },
          body: JSON.stringify(item.body),
        });
      } catch (e) {
        if (e && e.message === 'Session expired') {
          failed.push(...queue.slice(index));
          break;
        }
        if (!e || !e.status || e.isOffline) failed.push(item);
        else console.error('Dropping permanently failed offline change', e);
      }
    }
    storeOfflineQueue(failed);
  } catch (_) {}
}

window.addEventListener('online', flushOfflineQueue);
window.addEventListener('offline', () => setSyncState('offline', loadOfflineQueue().length ? `${loadOfflineQueue().length} changes pending` : 'Offline'));

let metaSaveTimer = null;
let metaSaveAbortController = null;
function scheduleSaveMeta(entry, request = activeReaderRequest){
  clearTimeout(metaSaveTimer);
  const expectedAccountVersion = request ? request.accountVersion : accountVersion;
  metaSaveTimer = setTimeout(() => saveBookMeta(entry, { expectedAccountVersion, request }), 1200);
}

async function saveBookMeta(entry, { expectedAccountVersion = accountVersion, request = null, allowInactiveReader = false } = {}){
  if (!entry || !isActiveAccount(expectedAccountVersion)) return false;
  if (!allowInactiveReader && !isReaderRequestCurrent(request)) return false;
  if (metaSaveAbortController) metaSaveAbortController.abort();
  const controller = new AbortController();
  metaSaveAbortController = controller;
  try {
    await resilientApiPost(`/api/books/${entry.id}`, {
      progress_percent: entry.progress,
      last_location_cfi: entry.lastLocationCfi,
      last_opened_at: new Date().toISOString(),
    }, true, 'PATCH', { signal: controller.signal, expectedAccountVersion });
    return true;
  } catch(e){
    if (!isAbortError(e) && isActiveAccount(expectedAccountVersion)) console.error('Could not save book meta', e);
    return false;
  } finally {
    if (metaSaveAbortController === controller) metaSaveAbortController = null;
  }
}

let settingsSaveTimer = null;
let settingsSaveAbortController = null;
async function saveSettings(){
  clearTimeout(settingsSaveTimer);
  const expectedAccountVersion = accountVersion;
  const settingsSnapshot = { ...settings };
  settingsSaveTimer = setTimeout(async () => {
    if (!isActiveAccount(expectedAccountVersion)) return;
    if (settingsSaveAbortController) settingsSaveAbortController.abort();
    const controller = new AbortController();
    settingsSaveAbortController = controller;
    try {
      await api.saveSettings({
        'reader-settings': settingsSnapshot,
      }, { signal: controller.signal, expectedAccountVersion });
    } catch(e){
      if (!isAbortError(e) && isActiveAccount(expectedAccountVersion)) console.error('Could not save settings', e);
    } finally {
      if (settingsSaveAbortController === controller) settingsSaveAbortController = null;
    }
  }, 500);
}

async function loadLibraryFromStorage(expectedAccountVersion = accountVersion){
  if (!isActiveAccount(expectedAccountVersion)) return false;
  const data = await api.getBooks({ expectedAccountVersion });
  if (!isActiveAccount(expectedAccountVersion)) return false;
  const books = Array.isArray(data) ? data : (data.books || []);
  library = books.map(b => ({
    id: b.id,
    name: b.title,
    author: b.author,
    series: b.series || null,
    seriesIndex: b.series_index != null && b.series_index !== '' ? b.series_index : null,
    rating: b.rating != null ? Number(b.rating) : null,
    coverColor: b.cover_color,
    coverPath: b.cover_path,
    description: b.description || '',
    isbn: b.isbn || '',
    tags: b.tags || '',
    progress: b.progress_percent || 0,
    status: b.status || 'unread',
    lastLocationCfi: b.last_location_cfi,
    fileSize: Number(b.file_size) || 0,
    addedAt: b.added_at ? new Date(b.added_at).getTime() : 0,
    lastOpenedAt: b.last_opened_at ? new Date(b.last_opened_at).getTime() : null,
    bookmarks: [],
    highlights: [],
  }));

  try {
    const serverSettings = await api.getSettings({ expectedAccountVersion });
    if (!isActiveAccount(expectedAccountVersion)) return false;
    if (serverSettings['reader-settings'] && typeof serverSettings['reader-settings'] === 'object') {
      Object.assign(settings, serverSettings['reader-settings']);
    }
    normalizeSettings();
    document.documentElement.classList.toggle('dark-shell', serverSettings['shell-theme'] === 'dark');
    updateShellThemeControl();
  } catch(e){ /* defaults are fine */ }
  return isActiveAccount(expectedAccountVersion);
}

/* ---------------- Export / Import ---------------- */
async function exportLibrary(){
  if (!requireAdmin('create a library backup')) return;
  // Native navigation lets the browser stream directly to disk instead of
  // buffering a potentially huge ZIP in JavaScript memory.
  const link = document.createElement('a');
  link.href = '/api/export';
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

document.getElementById('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!requireAdmin('restore a library backup')) {
    e.target.value = '';
    return;
  }
  const confirmed = await showConfirmDialog({
    title: 'Import Backup',
    message: 'Import this backup into the shared library? Existing books are kept and backup data is merged.',
    confirmText: 'Import Backup',
    danger: false,
  });
  if (!confirmed) {
    e.target.value = '';
    return;
  }
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await api.fetch('/api/import', {
      method: 'POST',
      body: formData,
    });
    const result = await res.json();

    // Reload library from server
    await loadLibraryFromStorage();
    renderFontOptions();
    renderShelf();
    updateSettingsUI();
    showToast(result.restored_files ? `Backup imported (${result.restored_files} files restored).` : 'Backup imported.');
  } catch(err){
    console.error('Import failed', err);
    showToast(`Import failed: ${err.message}`);
  }
  e.target.value = '';
});

/* Keep the rendition's page size in sync with Safari's toolbar show/hide,
   keyboard, and rotation.
   R-02/R-14: resize no longer calls display(cfi), so keyboard show/hide on
   iPhone is safe. R-03: orientationchange gets a longer debounce to let layout
   settle before measuring the viewport. */
let viewportResizeDebounce = null;
function handleViewportResize(e){
  clearTimeout(viewportResizeDebounce);
  const delay = (e && e.type === 'orientationchange') ? 400 : 150;
  viewportResizeDebounce = setTimeout(resizeReaderViewport, delay);
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', handleViewportResize);
window.addEventListener('resize', handleViewportResize);
window.addEventListener('orientationchange', handleViewportResize);

// End reading session on page unload
window.addEventListener('beforeunload', () => {
  if (currentSessionId) {
    // Use sendBeacon for reliable delivery
    navigator.sendBeacon(`/api/sessions/${currentSessionId}/end`, '{}');
  }
});

/* ---------------- Init ---------------- */
async function boot(){
  const bootAccountVersion = accountVersion;
  if (!isActiveAccount(bootAccountVersion)) return;
  const emptyP = document.getElementById('empty-shelf-copy');
  const emptyDiv = document.getElementById('shelf-empty');
  const header = document.getElementById('shelf-header');
  const continueCard = document.getElementById('continue-card');
  const dropzone = document.getElementById('dropzone');
  const emptyImportRow = document.getElementById('empty-import-row');

  if (emptyP) emptyP.textContent = 'Loading the shared library…';
  if (emptyDiv) emptyDiv.style.display = 'block';
  if (header) header.style.display = 'none';
  if (continueCard) continueCard.style.display = 'none';
  if (dropzone) dropzone.hidden = true;
  if (emptyImportRow) emptyImportRow.hidden = true;

  try {
    const loaded = await loadLibraryFromStorage(bootAccountVersion);
    if (!loaded || !isActiveAccount(bootAccountVersion)) return;
    if (emptyP) emptyP.textContent = 'The shared shelf is empty';
    if (dropzone && isCurrentUserAdmin()) dropzone.hidden = false;
    if (emptyImportRow && isCurrentUserAdmin()) emptyImportRow.hidden = false;
  } catch (e) {
    if (!isActiveAccount(bootAccountVersion)) return;
    console.error('Boot failed:', e);
    if (emptyDiv) emptyDiv.style.display = 'block';
    if (header) header.style.display = 'none';
    if (continueCard) continueCard.style.display = 'none';
    if (emptyP) {
      emptyP.innerHTML = '<div style="color:var(--ink); font-weight:500; margin-bottom:12px;">Could not load your library.</div><button type="button" class="file-link-btn" onclick="boot()" style="margin: 0 auto; display: inline-flex;">Retry</button>';
    }
    if (dropzone) dropzone.hidden = true;
    if (emptyImportRow) emptyImportRow.hidden = true;
    return;
  }
  renderFontOptions();
  restoreShelfPreferences();
  syncGestureSettingsUI();
  renderShelf();
  updateSettingsUI();
  api.getStats({ expectedAccountVersion: bootAccountVersion }).then(stats => {
    if (!isActiveAccount(bootAccountVersion)) return;
    const measured = Number(stats.reading_bytes_per_minute);
    if (Number.isFinite(measured) && measured > 0) {
      personalReadingBytesPerMinute = Math.min(50_000, Math.max(1_500, measured));
      renderShelf();
    }
  }).catch(() => {});
  // Load collections after shelf is ready
  await loadCollections();
  if (!isActiveAccount(bootAccountVersion)) return;
  updateRoleAwareControls();
  flushOfflineQueue();
}

function abortReaderRequests() {
  readerRequestVersion += 1;
  if (readerAbortController) {
    readerAbortController.abort();
    readerAbortController = null;
  }
  activeReaderRequest = null;
}

function resetReaderPreferences() {
  Object.assign(settings, DEFAULT_READER_SETTINGS);
  document.documentElement.classList.remove('dark-shell');
  document.body.style.removeProperty('background');
  updateShellThemeControl();
}

/* Dispose immediately and without API calls. This is deliberately used by
   expiry/account-change paths, where another request could attach stale
   reader data to the wrong person. */
function discardReaderState({ clearLibrary = false, resetPreferences = false } = {}) {
  abortReaderRequests();
  searchRequestVersion += 1;
  clearTimeout(searchDebounce);
  clearTimeout(metaSaveTimer);
  clearTimeout(settingsSaveTimer);
  if (typeof metaSaveAbortController !== 'undefined' && metaSaveAbortController) metaSaveAbortController.abort();
  if (typeof settingsSaveAbortController !== 'undefined' && settingsSaveAbortController) settingsSaveAbortController.abort();
  currentSessionId = null;
  currentBookId = null;
  locationsReady = false;
  lastReaderViewportSize = { width: 0, height: 0 };
  pageTurnLock = false;
  clearTimeout(pageTurnLockTimer);
  pendingHighlightCfi = null;
  pendingHighlightContext = null;
  highlightReturnFocus = null;
  window.onkeydown = null;

  if (typeof scrollFadeObserver !== 'undefined' && scrollFadeObserver) {
    scrollFadeObserver.disconnect();
    scrollFadeObserver = null;
  }
  clearTimeout(readerChromeTimer); // R-13
  readerChromeTimer = null;

  // R-16: Revoke the Blob URL so the browser can reclaim the underlying EPUB data
  if (currentBlobUrl) {
    try { URL.revokeObjectURL(currentBlobUrl); } catch (_) {}
    currentBlobUrl = null;
  }

  const oldBook = book;
  book = null;
  rendition = null;
  try { if (oldBook) oldBook.destroy(); } catch (e) { /* already disposed */ }

  document.getElementById('viewer').replaceChildren();
  document.getElementById('loading-overlay').classList.add('hidden');
  hideHighlightPopup();
  closeShortcutsModal({ returnFocus: false });
  closeStatsModal();
  document.getElementById('collections-modal').classList.remove('show');
  closeAdminModal({ returnFocus: false });
  document.getElementById('app').classList.remove('chrome-hidden');
  syncReaderChromeAccessibility();
  exitReaderFullscreen();
  updateFullscreenControlUI();
  document.body.classList.remove('reader-active');
  document.body.style.removeProperty('background');
  syncReaderPalette();
  document.getElementById('reader-view').classList.remove('active', 'scrolled');
  document.getElementById('shelf-view').style.display = 'block';
  ['toc-toggle', 'search-toggle', 'settings-toggle', 'bookmarks-toggle', 'bookmark-toggle', 'tts-btn', 'fullscreen-btn', 'reader-more-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  stopTts();
  const ttsBtn = document.getElementById('tts-btn');
  if (ttsBtn) ttsBtn.setAttribute('aria-pressed', 'false');
  window.currentBookData = null;
  window.currentHighlights = [];
  const progressSliderEl = document.getElementById('progress-slider');
  if (progressSliderEl) {
    progressSliderEl.onchange = null;
    progressSliderEl.oninput = null;
    progressSliderEl.onpointerdown = null;
    progressSliderEl.onmousedown = null;
    progressSliderEl.ontouchstart = null;
  }
  isDraggingProgressSlider = false;
  seekLockUntil = 0;
  closeDrawers();
  document.title = 'Endpaper — an EPUB reader';

  if (clearLibrary) {
    cancelBookWarmup();
    clearReaderAssetCaches();
    library = [];
    allCollections = [];
    renderShelf();
  }
  if (resetPreferences) {
    resetReaderPreferences();
    renderFontOptions();
    updateSettingsUI();
  }
}

// Check auth before boot
(async function(){
  try {
    const session = await refreshCurrentUser();
    if (session) {
      boot();
    } else {
      showLoginGate();
    }
  } catch(e) {
    setCurrentUser(null);
    showLoginGate();
  }
})();

/* ---------------- Stats UI ---------------- */
let statsModalReturnFocus = null;

async function openStatsModal() {
  const expectedAccountVersion = accountVersion;
  if (!isActiveAccount(expectedAccountVersion)) return;
  const active = document.activeElement;
  statsModalReturnFocus = active instanceof HTMLElement ? active : null;
  try {
    const stats = await api.getStats({ expectedAccountVersion });
    if (!isActiveAccount(expectedAccountVersion)) return;
    document.getElementById('stat-streak').textContent = stats.reading_streak_days;
    document.getElementById('stat-finished').textContent = stats.books_finished;
    
    const weekHours = (stats.time_read_this_week / 3600).toFixed(1);
    document.getElementById('stat-week').textContent = weekHours.replace('.0', '') + 'h';
    
    const totalHours = (stats.time_read_total / 3600).toFixed(1);
    document.getElementById('stat-total').textContent = totalHours.replace('.0', '') + 'h';

    const chart = document.getElementById('stats-chart');
    const daily = Array.isArray(stats.daily) ? stats.daily : [];
    const maxSeconds = Math.max(60, ...daily.map(day => day.seconds || 0));
    chart.innerHTML = daily.map(day => `<div class="stats-bar" style="height:${Math.max(2, Math.round((day.seconds || 0) / maxSeconds * 100))}%" title="${Math.round((day.seconds || 0) / 60)} minutes on ${escapeHtml(day.date)}"><span>${escapeHtml(day.date.slice(8))}</span></div>`).join('');
    const change = stats.previous_7_days > 0 ? Math.round((stats.time_read_this_week - stats.previous_7_days) / stats.previous_7_days * 100) : null;
    const recentMonths = (stats.monthly || []).slice(-6).map(month => `${month.month}: ${formatMinutes(Math.round(month.seconds / 60))}`).join(' · ');
    document.getElementById('stats-comparison').textContent = `Longest streak: ${stats.longest_streak_days || 0} days · Average session: ${Math.round((stats.average_session_seconds || 0) / 60)} min${change == null ? '' : ` · ${change >= 0 ? '+' : ''}${change}% vs previous 7 days`}${recentMonths ? `\nMonthly: ${recentMonths}` : ''}`;
    document.getElementById('stats-most-read').innerHTML = stats.most_read?.length ? `<strong>Most read</strong><br>${stats.most_read.map((item, index) => `${index + 1}. ${escapeHtml(item.title)} — ${formatMinutes(Math.round(item.seconds / 60))}`).join('<br>')}` : '';
    try {
      const prefs = await api.getSettings({ expectedAccountVersion });
      const goals = prefs['reading-goals'] || {};
      document.getElementById('goal-daily').value = goals.dailyMinutes || '';
      document.getElementById('goal-weekly').value = goals.weeklyHours || '';
      document.getElementById('goal-books').value = goals.booksPerYear || '';
    } catch (_) {}

    const modal = document.getElementById('stats-modal');
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      const closeBtn = modal.querySelector('.modal-close-btn') || modal.querySelector('button');
      if (closeBtn) closeBtn.focus();
    });
  } catch(e) {
    if (isActiveAccount(expectedAccountVersion) && !isAbortError(e)) console.error('Failed to load stats:', e);
  }
}

function closeStatsModal({ returnFocus = true } = {}) {
  const modal = document.getElementById('stats-modal');
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  ['stat-streak', 'stat-finished', 'stat-week', 'stat-total'].forEach(id => {
    document.getElementById(id).textContent = '—';
  });
  const target = statsModalReturnFocus;
  statsModalReturnFocus = null;
  if (returnFocus && target && target.isConnected && !target.hidden) {
    target.focus({ preventScroll: true });
  }
}

/* ---------------- Collections UI ---------------- */
let collectionsModalReturnFocus = null;

async function loadCollections() {
  try {
    allCollections = await api.getCollections();
    renderCollectionsFilter();
  } catch(e) {
    console.error('Failed to load collections:', e);
    const group = document.getElementById('shelf-filter-collections');
    if (group) {
      group.innerHTML = '<option disabled>Could not load collections</option>';
    }
  }
}

function renderCollectionsFilter() {
  const group = document.getElementById('shelf-filter-collections');
  if (!group) return;
  group.innerHTML = '';
  allCollections.forEach(c => {
    const opt = document.createElement('option');
    opt.value = 'col_' + c.id;
    opt.textContent = c.name;
    group.appendChild(opt);
  });
}

let activeOrganizeBookId = null;

async function openBookCollectionsModal(bookId) {
  if (!requireAdmin('organize shared collections')) return;
  const active = document.activeElement;
  collectionsModalReturnFocus = active instanceof HTMLElement ? active : null;
  activeOrganizeBookId = bookId;
  const book = library.find(b => b.id === bookId);
  document.getElementById('collections-title').textContent = book ? `Organize “${book.name}”` : 'Organize Collections';
  const list = document.getElementById('collection-list');
  list.innerHTML = '';
  
  if (book) {
    const ratingRow = document.createElement('div');
    ratingRow.style.cssText = 'padding: 8px 4px 12px; margin-bottom: 12px; border-bottom: 1px solid var(--border-soft); display: flex; align-items: center; justify-content: space-between;';
    ratingRow.innerHTML = `
      <span style="font-size:13px; font-weight:600; color:var(--ink);">Your Rating</span>
      ${renderRatingHtml(book.id, book.rating)}
    `;
    list.appendChild(ratingRow);
  }

  if (allCollections.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.cssText = 'color:var(--ink-soft); font-size:13px; font-style:italic; padding: 4px;';
    emptyMsg.textContent = 'No collections yet.';
    list.appendChild(emptyMsg);
  } else {
    allCollections.forEach(c => {
      const isChecked = c.book_ids.includes(bookId);
      const row = document.createElement('label');
      row.className = 'collection-item';
      row.innerHTML = `<input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleBookCollection('${c.id}', this.checked)"> <span>${escapeHtml(c.name)}</span>`;
      list.appendChild(row);
    });
  }
  
  const modal = document.getElementById('collections-modal');
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('new-collection-input').value = '';
  requestAnimationFrame(() => {
    const firstInput = modal.querySelector('input, button');
    if (firstInput) firstInput.focus();
  });
}

async function openCollectionsManager() {
  if (!requireAdmin('manage shared collections')) return;
  const active = document.activeElement;
  collectionsModalReturnFocus = active instanceof HTMLElement ? active : document.getElementById('library-tools-btn');
  activeOrganizeBookId = null;
  document.getElementById('collections-title').textContent = 'Manage Collections';
  const list = document.getElementById('collection-list');
  list.innerHTML = '<div style="color:var(--ink-soft); font-size:13px; padding:6px 0;">Loading collections…</div>';
  const modal = document.getElementById('collections-modal');
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('new-collection-input').value = '';

  try {
    allCollections = await api.getCollections();
    renderCollectionsFilter();
    list.innerHTML = '';
    if (allCollections.length === 0) {
      list.innerHTML = '<div style="color:var(--ink-soft); font-size:13px; font-style:italic; padding:4px 0;">No collections yet. Create one below.</div>';
    } else {
      allCollections.forEach(collection => {
        const row = document.createElement('div');
        row.className = 'collection-item collection-item-manage';
        const name = document.createElement('span');
        name.textContent = `${collection.name} (${collection.book_ids.length})`;
        const actions = document.createElement('div');
        actions.className = 'collection-actions';
        const rename = document.createElement('button');
        rename.className = 'collection-delete';
        rename.textContent = 'Rename';
        rename.onclick = () => renameCollection(collection.id, collection.name);
        const remove = document.createElement('button');
        remove.className = 'collection-delete';
        remove.textContent = 'Delete';
        remove.onclick = () => deleteCollection(collection.id, collection.name);
        actions.append(rename, remove);
        row.append(name, actions);
        list.appendChild(row);
      });
    }
    requestAnimationFrame(() => {
      const input = document.getElementById('new-collection-input');
      if (input) input.focus();
    });
  } catch (e) {
    console.error('Failed to load collections in manager:', e);
    list.innerHTML = `
      <div style="color:#C14B4B; font-size:13px; margin-bottom:8px;">Could not load collections: ${escapeHtml(e.message)}</div>
      <button type="button" class="file-link-btn" onclick="openCollectionsManager()">Retry</button>
    `;
  }
}

function closeCollectionsModal({ returnFocus = true } = {}) {
  const modal = document.getElementById('collections-modal');
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  activeOrganizeBookId = null;
  renderShelf();
  const target = collectionsModalReturnFocus;
  collectionsModalReturnFocus = null;
  if (returnFocus && target && target.isConnected && !target.hidden) {
    target.focus({ preventScroll: true });
  }
}

function toggleLibraryToolsMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('library-tools-menu');
  const btn = document.getElementById('library-tools-btn');
  if (!menu) return;
  const isShown = menu.classList.contains('show');
  menu.classList.toggle('show', !isShown);
  if (btn) btn.setAttribute('aria-expanded', String(!isShown));
}

function closeLibraryToolsMenu() {
  const menu = document.getElementById('library-tools-menu');
  const btn = document.getElementById('library-tools-btn');
  if (menu) menu.classList.remove('show');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown-wrap')) {
    closeLibraryToolsMenu();
  }
});

async function toggleBookCollection(collectionId, isChecked) {
  if (!requireAdmin('organize shared collections')) return;
  if (!activeOrganizeBookId) return;
  try {
    if (isChecked) {
      await api.addBookToCollection(activeOrganizeBookId, collectionId);
    } else {
      await api.removeBookFromCollection(activeOrganizeBookId, collectionId);
    }
    await loadCollections();
  } catch(e) { console.error('Failed to toggle collection:', e); showToast(`Could not update collection: ${e.message}`); }
}

async function deleteCollection(id, name) {
  if (!requireAdmin('manage shared collections')) return;
  const confirmed = await showConfirmDialog({
    title: 'Delete Collection',
    message: `Delete the “${name}” collection? Its books will remain in your library.`,
    confirmText: 'Delete Collection',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.deleteCollection(id);
    await loadCollections();
    openCollectionsManager();
    showToast('Collection deleted.');
  } catch (e) {
    console.error('Failed to delete collection:', e);
    showToast(`Could not delete collection: ${e.message}`);
  }
}

async function renameCollection(id, currentName) {
  if (!requireAdmin('manage shared collections')) return;
  const name = prompt('Collection name', currentName);
  if (name === null || name.trim() === currentName) return;
  try {
    await api.renameCollection(id, name.trim());
    await loadCollections();
    openCollectionsManager();
    showToast('Collection renamed.');
  } catch (e) {
    console.error('Failed to rename collection:', e);
    showToast(`Could not rename collection: ${e.message}`);
  }
}

async function createCollection() {
  if (!requireAdmin('manage shared collections')) return;
  const input = document.getElementById('new-collection-input');
  const name = input.value.trim();
  if (!name) return;
  try {
    const col = await api.createCollection(name);
    await loadCollections();
    if (activeOrganizeBookId) {
      await api.addBookToCollection(activeOrganizeBookId, col.id);
      await loadCollections();
      openBookCollectionsModal(activeOrganizeBookId); // refresh
    } else {
      openCollectionsManager();
    }
  } catch(e) { console.error('Failed to create collection:', e); showToast(`Could not create collection: ${e.message}`); }
}

async function openAdminModal() {
  if (!requireAdmin('manage users')) return;
  const modal = document.getElementById('admin-modal');
  const activeElement = document.activeElement;
  adminModalReturnFocus = activeElement instanceof HTMLElement
    ? activeElement
    : document.getElementById('admin-toggle');
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  await renderAdminUsers();
  if (modal.classList.contains('show')) {
    document.getElementById('new-user-username').focus({ preventScroll: true });
  }
}

function closeAdminModal({ returnFocus = true } = {}) {
  const modal = document.getElementById('admin-modal');
  if (!modal.classList.contains('show')) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  const returnTarget = adminModalReturnFocus;
  adminModalReturnFocus = null;
  if (returnFocus && returnTarget && returnTarget.isConnected && !returnTarget.hidden) {
    returnTarget.focus({ preventScroll: true });
  }
}

function getAdminModalFocusableElements() {
  const modal = document.getElementById('admin-modal');
  return Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
    .filter(el => el.getClientRects().length > 0 && !el.hasAttribute('hidden'));
}

function handleAdminModalKeydown(event) {
  const modal = document.getElementById('admin-modal');
  if (!modal.classList.contains('show')) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeAdminModal();
    return;
  }

  if (event.key !== 'Tab') return;
  const focusable = getAdminModalFocusableElements();
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function renderAdminUsers() {
  if (!requireAdmin('manage users')) return;
  const list = document.getElementById('user-list');
  list.innerHTML = '';
  try {
    const users = await api.getUsers();
    if (!users.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-empty';
      empty.textContent = 'No accounts yet.';
      list.appendChild(empty);
      return;
    }
    users.forEach(u => {
      const row = document.createElement('div');
      row.className = 'collection-item collection-item-manage admin-user-item';
      row.setAttribute('role', 'listitem');

      const identity = document.createElement('div');
      identity.className = 'admin-user-identity';
      const name = document.createElement('span');
      name.className = 'admin-user-name';
      name.textContent = u.username;
      const role = document.createElement('span');
      role.className = `role-badge ${u.is_admin ? 'admin' : 'reader'}`;
      role.textContent = u.is_admin ? 'Admin' : 'Reader';
      identity.append(name, role);

      const isCurrentUser = Boolean(currentUser && currentUser.username === u.username);
      if (isCurrentUser) {
        const current = document.createElement('span');
        current.className = 'current-user-badge';
        current.textContent = 'You';
        identity.appendChild(current);
      }
      row.appendChild(identity);

      const actions = document.createElement('div');
      actions.className = 'collection-actions';

      if (!isCurrentUser) {
        const roleBtn = document.createElement('button');
        roleBtn.type = 'button';
        roleBtn.className = 'admin-btn-sm';
        roleBtn.textContent = u.is_admin ? 'Make Reader' : 'Make Admin';
        roleBtn.setAttribute('aria-label', `Change ${u.username} to ${u.is_admin ? 'Reader' : 'Admin'}`);
        roleBtn.onclick = () => toggleUserRole(u.id, !u.is_admin);
        actions.appendChild(roleBtn);
      }

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'admin-btn-sm';
      resetBtn.textContent = 'Reset passphrase';
      resetBtn.setAttribute('aria-label', `Reset passphrase for ${u.username}`);
      resetBtn.onclick = () => openResetPassphraseModal(u.id, u.username);
      actions.appendChild(resetBtn);

      if (isCurrentUser) {
        const protectedNote = document.createElement('span');
        protectedNote.className = 'admin-self-note';
        protectedNote.textContent = 'Current account';
        actions.appendChild(protectedNote);
      } else {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'collection-delete';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove ${u.username}`);
        remove.onclick = () => deleteUser(u.id, u.username);
        actions.appendChild(remove);
      }
      row.appendChild(actions);
      list.appendChild(row);
    });
  } catch (e) {
    const error = document.createElement('div');
    error.style.cssText = 'color:#C14B4B; font-size:13px; padding:8px 0;';
    error.innerHTML = `Could not load accounts: ${escapeHtml(e.message)} <button type="button" class="file-link-btn" style="margin-left:8px; display:inline-flex; vertical-align:middle;" onclick="renderAdminUsers()">Retry</button>`;
    list.appendChild(error);
  }
}

async function toggleUserRole(userId, newIsAdmin) {
  if (!requireAdmin('manage users')) return;
  const roleName = newIsAdmin ? 'Admin' : 'Reader';
  const confirmed = await showConfirmDialog({
    title: 'Change User Role',
    message: `Are you sure you want to change this account's role to ${roleName}?`,
    confirmText: 'Change Role',
    danger: false,
  });
  if (!confirmed) return;
  try {
    await api.updateUser(userId, { is_admin: newIsAdmin });
    await renderAdminUsers();
    showToast(`Role updated to ${roleName}.`);
  } catch(e) {
    console.error('Role change failed:', e);
    showToast(`Could not change role: ${e.message}`);
  }
}

let resetPassphraseTargetId = null;
let resetPassphraseReturnFocus = null;

function openResetPassphraseModal(userId, username) {
  const active = document.activeElement;
  resetPassphraseReturnFocus = active instanceof HTMLElement ? active : null;
  resetPassphraseTargetId = userId;
  const modal = document.getElementById('reset-passphrase-modal');
  const label = document.getElementById('reset-passphrase-user-label');
  const input = document.getElementById('reset-passphrase-input');
  label.textContent = `Set a new passphrase for “${username}”.`;
  input.value = '';
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  input.focus();
}

function closeResetPassphraseModal({ returnFocus = true } = {}) {
  resetPassphraseTargetId = null;
  const modal = document.getElementById('reset-passphrase-modal');
  if (modal) {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }
  const target = resetPassphraseReturnFocus;
  resetPassphraseReturnFocus = null;
  if (returnFocus && target && target.isConnected && !target.hidden) {
    target.focus({ preventScroll: true });
  }
}

async function handleResetPassphraseSubmit(event) {
  if (event) event.preventDefault();
  if (!resetPassphraseTargetId) return;
  const input = document.getElementById('reset-passphrase-input');
  const passphrase = input.value.trim();
  if (!passphrase || passphrase.length < 12) {
    showToast('Passphrase must be at least 12 characters.');
    input.focus();
    return;
  }
  try {
    await api.updateUser(resetPassphraseTargetId, { passphrase });
    closeResetPassphraseModal();
    showToast('Passphrase updated successfully.');
  } catch (e) {
    console.error('Failed to reset passphrase:', e);
    showToast(`Could not reset passphrase: ${e.message}`);
  }
}

async function createUser(event) {
  if (event) event.preventDefault();
  if (!requireAdmin('manage users')) return;
  const userIn = document.getElementById('new-user-username');
  const passIn = document.getElementById('new-user-passphrase');
  const username = userIn.value.trim();
  const passphrase = passIn.value.trim();
  const isAdmin = document.getElementById('new-user-isadmin').checked;
  if (!username || !passphrase) {
    showToast('Please enter a username and passphrase.');
    (!username ? userIn : passIn).focus();
    return false;
  }
  try {
    await api.createUser({ username, passphrase, is_admin: isAdmin });
    userIn.value = '';
    passIn.value = '';
    document.getElementById('new-user-isadmin').checked = false;
    await renderAdminUsers();
    userIn.focus();
    showToast('User added.');
  } catch(e) {
    console.error('Failed to create user:', e);
    showToast(`Could not create user: ${e.message}`);
  }
  return false;
}

async function deleteUser(id, username) {
  if (!requireAdmin('manage users')) return;
  const accountName = username ? `“${username}”` : 'this account';
  const confirmed = await showConfirmDialog({
    title: 'Remove User',
    message: `Remove ${accountName} from Endpaper? Their reading progress, bookmarks, highlights, and preferences will be permanently deleted. The shared library and everyone else’s data will remain. This cannot be undone.`,
    confirmText: 'Remove User',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.deleteUser(id);
    await renderAdminUsers();
    showToast(username ? `${username} was removed.` : 'User removed.');
  } catch(e) {
    console.error('Failed to delete user:', e);
    showToast(`Could not delete user: ${e.message}`);
  }
}

/* ---------------- Reusable Confirmation Modal ---------------- */
let confirmDialogResolver = null;
const confirmQueue = [];
let isConfirmDialogOpen = false;

function showConfirmDialog({ title = 'Confirm Action', message = 'Are you sure?', confirmText = 'Confirm', cancelText = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    confirmQueue.push({ options: { title, message, confirmText, cancelText, danger }, resolve });
    processConfirmQueue();
  });
}

function processConfirmQueue() {
  if (isConfirmDialogOpen || confirmQueue.length === 0) return;
  isConfirmDialogOpen = true;
  const current = confirmQueue[0];
  const { options, resolve } = current;
  confirmDialogResolver = resolve;

  const modal = document.getElementById('confirm-modal');
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-message');
  const okBtn = document.getElementById('confirm-ok-btn');
  const cancelBtn = document.getElementById('confirm-cancel-btn');

  if (titleEl) titleEl.textContent = options.title;
  if (msgEl) msgEl.textContent = options.message;
  if (okBtn) {
    okBtn.textContent = options.confirmText;
    okBtn.className = options.danger ? 'new-collection-btn danger-btn' : 'new-collection-btn';
  }
  if (cancelBtn) cancelBtn.textContent = options.cancelText;

  if (modal) {
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
  }
  if (okBtn) okBtn.focus();
}

function closeConfirmDialog(result = false) {
  const modal = document.getElementById('confirm-modal');
  if (modal && modal.classList.contains('show')) {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }
  const current = confirmQueue.shift();
  isConfirmDialogOpen = false;
  confirmDialogResolver = null;
  if (current && current.resolve) {
    current.resolve(result);
  }
  if (confirmQueue.length > 0) {
    setTimeout(processConfirmQueue, 50);
  }
}

if (document.getElementById('confirm-ok-btn')) {
  document.getElementById('confirm-ok-btn').addEventListener('click', () => closeConfirmDialog(true));
}
if (document.getElementById('confirm-cancel-btn')) {
  document.getElementById('confirm-cancel-btn').addEventListener('click', () => closeConfirmDialog(false));
}
if (document.getElementById('confirm-x-btn')) {
  document.getElementById('confirm-x-btn').addEventListener('click', () => closeConfirmDialog(false));
}
if (document.getElementById('confirm-modal')) {
  document.getElementById('confirm-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeConfirmDialog(false);
  });
}
function trapFocus(event, container) {
  if (event.key !== 'Tab' || !container) return;
  const focusable = Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => !el.hidden && el.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

document.addEventListener('keydown', (e) => {
  const confirmModal = document.getElementById('confirm-modal');
  if (confirmModal && confirmModal.classList.contains('show')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeConfirmDialog(false);
      return;
    } else if (e.key === 'Enter' && e.target && !e.target.matches('button')) {
      e.preventDefault();
      closeConfirmDialog(true);
      return;
    }
    trapFocus(e, confirmModal);
    return;
  }

  const resetModal = document.getElementById('reset-passphrase-modal');
  if (resetModal && resetModal.classList.contains('show')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeResetPassphraseModal();
      return;
    }
    trapFocus(e, resetModal);
    return;
  }

  const statsModal = document.getElementById('stats-modal');
  if (statsModal && statsModal.classList.contains('show')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeStatsModal();
      return;
    }
    trapFocus(e, statsModal);
    return;
  }

  const collectionsModal = document.getElementById('collections-modal');
  if (collectionsModal && collectionsModal.classList.contains('show')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCollectionsModal();
      return;
    }
    trapFocus(e, collectionsModal);
    return;
  }

  const openDrawerId = DRAWER_IDS.find(id => {
    const el = document.getElementById(id + '-drawer');
    return el && el.classList.contains('open');
  });
  if (openDrawerId) {
    const openDrawer = document.getElementById(openDrawerId + '-drawer');
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDrawers();
      return;
    }
    trapFocus(e, openDrawer);
    return;
  }
});

document.getElementById('admin-modal').addEventListener('mousedown', (event) => {
  if (event.target === event.currentTarget) closeAdminModal();
});
document.addEventListener('keydown', handleAdminModalKeydown);
if (document.getElementById('empty-upload-btn')) {
  document.getElementById('empty-upload-btn').addEventListener('click', () => {
    document.getElementById('upload-btn').click();
  });
}


/* ---------------- Read Aloud / Text-to-Speech (TTS) Engine ---------------- */
let ttsQueue = [];           // Array of { text: string, element: HTMLElement, doc: Document }
let ttsIndex = 0;
let ttsUtterance = null;
let ttsIsPaused = false;
let ttsRate = 1.0;
let ttsPitch = 1.0;
let ttsVoiceURI = '';
let ttsSleepTimer = null;
const TTS_RATES = [0.75, 1.0, 1.25, 1.5, 2.0];

function splitIntoSentences(text) {
  if (!text) return [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
      const segments = Array.from(segmenter.segment(text));
      return segments.map(s => s.segment.trim()).filter(s => s.length > 0);
    } catch (_) {}
  }
  const raw = text.match(/[^.!?\n\r]+[.!?]+(?:\s+|$)|[^.!?\n\r]+$/g) || [text];
  return raw.map(s => s.trim()).filter(s => s.length > 0);
}

function clearTtsHighlights() {
  try {
    const iframes = document.querySelectorAll('#viewer iframe');
    iframes.forEach(iframe => {
      const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      if (doc) {
        doc.querySelectorAll('.endpaper-tts-active').forEach(el => el.classList.remove('endpaper-tts-active'));
      }
    });
  } catch (_) {}
}

function highlightTtsElement(element, doc) {
  clearTtsHighlights();
  if (!element) return;
  element.classList.add('endpaper-tts-active');
  try {
    const isScrolled = settings.layout === 'scrolled';

    if (isScrolled) {
      // In scrolled layout, smooth auto-scroll to keep active spoken sentence in comfortable view
      const scrollContainer = (rendition && rendition.manager && rendition.manager.container) ||
                              document.getElementById('epub-scroll-container') ||
                              document.querySelector('#viewer > div');
      const iframe = (doc && doc.defaultView && doc.defaultView.frameElement) || document.querySelector('#viewer iframe');

      if (scrollContainer && iframe) {
        const containerRect = scrollContainer.getBoundingClientRect();
        const iframeRect = iframe.getBoundingClientRect();
        const elRect = element.getBoundingClientRect();

        // Calculate the element's position relative to the scroll container viewport
        const elTopInContainer = (iframeRect.top - containerRect.top) + elRect.top;
        const elCenterInContainer = elTopInContainer + (elRect.height / 2);
        const targetLine = containerRect.height * 0.38; // Target ~38% from top for optimal reading position

        const diff = elCenterInContainer - targetLine;
        // If active sentence deviates by more than 35px from the target reading line, scroll smoothly
        if (Math.abs(diff) > 35) {
          scrollContainer.scrollBy({
            top: diff,
            behavior: 'smooth'
          });
        }
      } else {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else {
      // In paginated mode, detect whether element is off-screen using viewer coordinates
      const viewer = document.getElementById('viewer');
      const iframe = (doc && doc.defaultView && doc.defaultView.frameElement) || document.querySelector('#viewer iframe');
      if (viewer && iframe) {
        const viewerRect = viewer.getBoundingClientRect();
        const iframeRect = iframe.getBoundingClientRect();
        const elRect = element.getBoundingClientRect();

        const screenLeft = iframeRect.left + elRect.left;
        const screenRight = iframeRect.left + elRect.right;

        // If the element is to the right of the visible screen (next spread)
        if (screenLeft >= viewerRect.right - 20) {
          turnPage('next');
        } else if (screenRight <= viewerRect.left + 20) {
          // If the element is to the left of the visible screen (previous spread)
          turnPage('prev');
        }
      }
    }
  } catch (_) {}
}

function updateTtsPlayerUI() {
  const bar = document.getElementById('tts-player-bar');
  const ttsBtn = document.getElementById('tts-btn');
  const playIcon = document.getElementById('tts-play-icon');
  const pauseIcon = document.getElementById('tts-pause-icon');
  const activeTextEl = document.getElementById('tts-active-text');
  const rateLabel = document.getElementById('tts-rate-label');

  if (!bar) return;

  if (ttsQueue.length > 0 && ttsIndex < ttsQueue.length) {
    bar.classList.remove('hidden');
    if (ttsBtn) ttsBtn.setAttribute('aria-pressed', 'true');
    const current = ttsQueue[ttsIndex];
    if (activeTextEl) activeTextEl.textContent = current ? current.text : '';
    if (playIcon && pauseIcon) {
      playIcon.style.display = ttsIsPaused ? 'block' : 'none';
      pauseIcon.style.display = ttsIsPaused ? 'none' : 'block';
    }
    if (rateLabel) rateLabel.textContent = ttsRate + '×';
  } else {
    bar.classList.add('hidden');
    if (ttsBtn) ttsBtn.setAttribute('aria-pressed', 'false');
    clearTtsHighlights();
  }
}

function speakCurrentTtsItem() {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();

  if (ttsIndex >= ttsQueue.length || ttsIndex < 0) {
    stopTts();
    return;
  }

  const item = ttsQueue[ttsIndex];
  if (!item || !item.text) {
    ttsIndex++;
    speakCurrentTtsItem();
    return;
  }

  ttsIsPaused = false;
  highlightTtsElement(item.element, item.doc);
  updateTtsPlayerUI();

  ttsUtterance = new SpeechSynthesisUtterance(item.text);
  ttsUtterance.rate = ttsRate;
  ttsUtterance.pitch = ttsPitch;
  const selectedVoice = speechSynthesis.getVoices().find(voice => voice.voiceURI === ttsVoiceURI);
  if (selectedVoice) ttsUtterance.voice = selectedVoice;

  ttsUtterance.onend = () => {
    if (!ttsIsPaused) {
      ttsIndex++;
      if (ttsIndex < ttsQueue.length) {
        speakCurrentTtsItem();
      } else {
        // Reached end of current chapter queue. Advance to the next chapter!
        if (rendition && rendition.next) {
          // Route through page-turn mutex so TTS cannot race with user input (R-09)
          if (pageTurnLock) { stopTts(); showToast('Finished reading aloud'); return; }
          pageTurnLock = true;
          clearTimeout(pageTurnLockTimer);
          let ttsAdvancePromise;
          try { ttsAdvancePromise = rendition.next(); } catch (_) {}
          const unlockTts = () => { pageTurnLock = false; };
          pageTurnLockTimer = setTimeout(unlockTts, 600);
          (ttsAdvancePromise || Promise.resolve()).then(() => {
            unlockTts();
            clearTimeout(pageTurnLockTimer);
            setTimeout(async () => {
              // Match active section via currentLocation() rather than blindly
              // taking getContents()[0] which may be a preloaded prior section (R-11)
              let targetDoc = null;
              try {
                const loc = await getCurrentLocationSafe(rendition);
                const activeHref = loc && loc.start && loc.start.href;
                const contents = (rendition.getContents && rendition.getContents()) || [];
                if (activeHref && contents.length > 0) {
                  const normalizeHref = value => decodeURIComponent(String(value || '').split('#')[0].split('?')[0]).replace(/^\.\//, '');
                  const activePath = normalizeHref(activeHref);
                  const exact = contents.filter(c => {
                    const candidate = normalizeHref(c.href || (c.section && c.section.href));
                    return candidate === activePath || candidate.endsWith('/' + activePath) || activePath.endsWith('/' + candidate);
                  });
                  if (exact.length === 1) targetDoc = exact[0].document;
                  if (!targetDoc) {
                    const activeBase = activePath.split('/').pop();
                    const basenameMatches = contents.filter(c => normalizeHref(c.href || (c.section && c.section.href)).split('/').pop() === activeBase);
                    if (basenameMatches.length === 1) targetDoc = basenameMatches[0].document;
                  }
                }
              } catch (_) {}
              if (!targetDoc) {
                const iframes = document.querySelectorAll('#viewer iframe');
                if (iframes.length === 1) targetDoc = iframes[0].contentDocument || (iframes[0].contentWindow && iframes[0].contentWindow.document);
              }
              if (targetDoc) {
                const nextQueue = collectReadableItemsFromNode(null, targetDoc);
                if (nextQueue.length > 0) { startTtsWithQueue(nextQueue, 0); return; }
              }
              stopTts();
              showToast('Finished reading aloud');
            }, 350);
          }).catch(() => {
            unlockTts();
            clearTimeout(pageTurnLockTimer);
            stopTts();
            showToast('Finished reading aloud');
          });
        } else {
          stopTts();
          showToast('Finished reading aloud');
        }
      }
    }
  };

  ttsUtterance.onerror = (e) => {
    if (e.error !== 'interrupted' && e.error !== 'canceled') {
      console.error('TTS error:', e);
      stopTts();
    }
  };

  window.speechSynthesis.speak(ttsUtterance);
}

function startTtsWithQueue(items, startIndex = 0) {
  if (!('speechSynthesis' in window)) {
    showToast('Speech synthesis not supported on this browser', 'error');
    return;
  }
  if (!items || items.length === 0) {
    showToast('No readable text found on current page', 'error');
    return;
  }
  window.speechSynthesis.cancel();
  ttsQueue = items;
  ttsIndex = Math.max(0, Math.min(items.length - 1, startIndex));
  ttsIsPaused = false;
  speakCurrentTtsItem();
}

function stopTts() {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  ttsQueue = [];
  ttsIndex = 0;
  ttsUtterance = null;
  ttsIsPaused = false;
  if (ttsSleepTimer) clearTimeout(ttsSleepTimer);
  ttsSleepTimer = null;
  clearTtsHighlights();
  updateTtsPlayerUI();
}

function toggleTtsPause() {
  if (!('speechSynthesis' in window) || ttsQueue.length === 0) return;
  if (ttsIsPaused) {
    ttsIsPaused = false;
    speakCurrentTtsItem();
  } else {
    ttsIsPaused = true;
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }
  updateTtsPlayerUI();
}

function ttsNextSentence() {
  if (ttsIndex + 1 < ttsQueue.length) {
    ttsIndex++;
    if (!ttsIsPaused) {
      speakCurrentTtsItem();
    } else {
      const item = ttsQueue[ttsIndex];
      if (item) highlightTtsElement(item.element, item.doc);
      updateTtsPlayerUI();
    }
  } else {
    stopTts();
  }
}

function ttsPrevSentence() {
  if (ttsIndex > 0) {
    ttsIndex--;
    if (!ttsIsPaused) {
      speakCurrentTtsItem();
    } else {
      const item = ttsQueue[ttsIndex];
      if (item) highlightTtsElement(item.element, item.doc);
      updateTtsPlayerUI();
    }
  } else {
    if (!ttsIsPaused) {
      speakCurrentTtsItem();
    }
  }
}

function cycleTtsRate() {
  const currentIndex = TTS_RATES.indexOf(ttsRate);
  const nextIndex = (currentIndex + 1) % TTS_RATES.length;
  ttsRate = TTS_RATES[nextIndex];
  const rateLabel = document.getElementById('tts-rate-label');
  if (rateLabel) rateLabel.textContent = ttsRate + '×';
  if (!ttsIsPaused && ttsQueue.length > 0) {
    speakCurrentTtsItem();
  }
}

function collectReadableItemsFromNode(startNode, doc) {
  if (!doc) return [];
  const isScrolled = settings.layout === 'scrolled';
  const allDocs = [];

  if (isScrolled) {
    // In continuous scrolled mode, collect from current iframe document and all subsequent chapter iframes
    const iframes = Array.from(document.querySelectorAll('#viewer iframe'));
    let foundCurrent = false;
    iframes.forEach(iframe => {
      try {
        const d = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
        if (d === doc) foundCurrent = true;
        if (foundCurrent && d && !allDocs.includes(d)) allDocs.push(d);
      } catch (_) {}
    });
  }
  if (allDocs.length === 0) allDocs.push(doc);

  const items = [];
  allDocs.forEach((d, docIndex) => {
    const allBlocks = Array.from(d.querySelectorAll('p, h1, h2, h3, h4, h5, h6, blockquote, li, dt, dd'));
    let startIndex = 0;
    if (docIndex === 0 && startNode) {
      const parentBlock = (startNode.closest && startNode.closest('p, h1, h2, h3, h4, h5, h6, blockquote, li, dt, dd')) ||
                          (startNode.parentElement && startNode.parentElement.closest && startNode.parentElement.closest('p, h1, h2, h3, h4, h5, h6, blockquote, li, dt, dd'));
      if (parentBlock) {
        const idx = allBlocks.indexOf(parentBlock);
        if (idx >= 0) startIndex = idx;
      }
    }

    for (let i = startIndex; i < allBlocks.length; i++) {
      const block = allBlocks[i];
      const text = block.innerText || block.textContent || '';
      const cleanText = text.replace(/\s+/g, ' ').trim();
      if (cleanText) {
        const sentences = splitIntoSentences(cleanText);
        sentences.forEach(s => {
          items.push({ text: s, element: block, doc: d });
        });
      }
    }
  });

  return items;
}

function readAloudFromSelection() {
  if (!rendition) return;
  hideHighlightPopup();

  let startNode = null;
  let doc = null;

  const contents = (rendition.getContents && rendition.getContents()) || [];
  for (const content of contents) {
    const win = content.window || (content.document && content.document.defaultView);
    if (win && win.getSelection) {
      const sel = win.getSelection();
      if (sel && sel.rangeCount > 0 && sel.toString().trim()) {
        const range = sel.getRangeAt(0);
        startNode = range.startContainer;
        doc = content.document || win.document;
        break;
      }
    }
  }

  if (!doc && contents.length > 0) {
    doc = contents[0].document;
  }
  if (!doc) {
    const iframe = document.querySelector('#viewer iframe');
    if (iframe) doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
  }

  if (doc) {
    const queue = collectReadableItemsFromNode(startNode, doc);
    if (queue.length > 0) {
      startTtsWithQueue(queue, 0);
      return;
    }
  }

  startTtsFromVisible();
}

function startTtsFromVisible() {
  if (!('speechSynthesis' in window)) {
    showToast('Speech synthesis not supported on this browser', 'error');
    return;
  }

  if (ttsQueue.length > 0 && !ttsIsPaused) {
    toggleTtsPause();
    return;
  }
  if (ttsQueue.length > 0 && ttsIsPaused) {
    toggleTtsPause();
    return;
  }

  if (!rendition) return;

  const contents = (rendition.getContents && rendition.getContents()) || [];
  let startNode = null;
  let targetDoc = null;

  // 1. Check user text selection first
  for (const content of contents) {
    const win = content.window || (content.document && content.document.defaultView);
    if (win && win.getSelection) {
      const sel = win.getSelection();
      if (sel && sel.rangeCount > 0 && sel.toString().trim()) {
        const range = sel.getRangeAt(0);
        startNode = range.startContainer;
        targetDoc = content.document || win.document;
        break;
      }
    }
  }

  // 2. If no selection, find the topmost visible paragraph in viewport
  if (!startNode) {
    for (const content of contents) {
      const doc = content.document || (content.content && content.content.document);
      const win = content.window || (doc && doc.defaultView);
      if (doc) {
        const blocks = Array.from(doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, blockquote, li, dt, dd'));
        for (const block of blocks) {
          const rect = block.getBoundingClientRect();
          if (rect.bottom > 20 && rect.top < (win ? win.innerHeight : window.innerHeight) * 0.6) {
            startNode = block;
            targetDoc = doc;
            break;
          }
        }
        if (startNode) break;
      }
    }
  }

  if (!targetDoc && contents.length > 0) {
    targetDoc = contents[0].document;
  }
  if (!targetDoc) {
    const iframe = document.querySelector('#viewer iframe');
    if (iframe) targetDoc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
  }

  if (targetDoc) {
    const queue = collectReadableItemsFromNode(startNode, targetDoc);
    if (queue.length > 0) {
      startTtsWithQueue(queue, 0);
      return;
    }
  }

  showToast('No readable text found on current page', 'error');
}

if (document.getElementById('tts-btn')) {
  document.getElementById('tts-btn').addEventListener('click', () => {
    startTtsFromVisible();
  });
}

function showDictionaryUI(word, data, status, x, y) {
  const tooltip = document.getElementById('dict-tooltip');
  if (!tooltip) return;
  if (status === 'offline') {
    tooltip.innerHTML = '<h4>' + escapeHtml(word) + '</h4><p>No definition available offline.</p>';
  } else if (status === 'not_found') {
    tooltip.innerHTML = '<h4>' + escapeHtml(word) + '</h4><p>No definition found for \'' + escapeHtml(word) + '\'.</p>';
  } else if (status === 'error') {
    tooltip.innerHTML = '<h4>' + escapeHtml(word) + '</h4><p>Definition lookup failed. Try again.</p>';
  } else if (status === 'success' && data) {
    try {
      const meaning = data[0].meanings[0].definitions[0].definition;
      tooltip.innerHTML = '<h4>' + escapeHtml(word) + '</h4><p>' + escapeHtml(meaning) + '</p>';
    } catch (e) {
      tooltip.innerHTML = '<h4>' + escapeHtml(word) + '</h4><p>No definition found for \'' + escapeHtml(word) + '\'.</p>';
    }
  }
  if (x !== undefined && y !== undefined) {
    tooltip.style.left = Math.max(10, x) + 'px';
    tooltip.style.top = Math.max(10, y + 20) + 'px';
  }
  tooltip.classList.remove('hidden');
}

async function lookupDictionary(word, x, y) {
  const tooltip = document.getElementById('dict-tooltip');
  if (!word || word.length < 2) {
    if (tooltip) tooltip.classList.add('hidden');
    return;
  }
  const cacheKey = 'endpaper_dictionary_cache';
  let dictionaryCache = {};
  try { dictionaryCache = JSON.parse(localStorage.getItem(cacheKey) || '{}'); } catch (_) {}
  const normalizedWord = word.toLocaleLowerCase();
  if (!navigator.onLine) {
    if (dictionaryCache[normalizedWord]) showDictionaryUI(word, dictionaryCache[normalizedWord].data, 'success', x, y);
    else showDictionaryUI(word, null, 'offline', x, y);
    return;
  }
  try {
    const res = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
    if (!res.ok) {
      showDictionaryUI(word, null, res.status === 404 ? 'not_found' : 'error', x, y);
      return;
    }
    const data = await res.json();
    try {
      dictionaryCache[normalizedWord] = { data, ts: Date.now() };
      const entries = Object.entries(dictionaryCache).sort((a,b) => b[1].ts - a[1].ts).slice(0, 200);
      localStorage.setItem(cacheKey, JSON.stringify(Object.fromEntries(entries)));
    } catch (_) {}
    showDictionaryUI(word, data, 'success', x, y);
  } catch (_) {
    showDictionaryUI(word, null, 'offline', x, y);
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#dict-tooltip')) {
    const t = document.getElementById('dict-tooltip');
    if (t) t.classList.add('hidden');
  }
});

if (document.getElementById('export-highlights-btn')) {
  document.getElementById('export-highlights-btn').addEventListener('click', () => {
    if (!window.currentHighlights || window.currentHighlights.length === 0) return;
    let md = '# Highlights for ' + window.currentBookData.title + '\n\n';
    window.currentHighlights.forEach(h => {
      md += '> ' + h.excerpt + '\n\n';
      if (h.note) md += '**Note:** ' + h.note + '\n\n';
      md += '---\n\n';
    });
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = window.currentBookData.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_highlights.md';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

/* ---------------- Product experience extensions (R-24–R-55) ---------------- */
let shelfRenderTimer = null;
let bulkMode = false;
const bulkSelection = new Set();
let notebookItems = [];
let notebookTagFilter = '';

function shelfPreferenceKey() {
  return currentUser?.username ? `endpaper_shelf:${currentUser.username.toLocaleLowerCase()}` : null;
}

function saveShelfPreferences() {
  const key = shelfPreferenceKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify({
    search: document.getElementById('shelf-search')?.value || '',
    filter: document.getElementById('shelf-filter')?.value || 'all',
    sort: document.getElementById('shelf-sort')?.value || 'recent',
    density: document.getElementById('shelf-density')?.value || 'comfortable',
  }));
}

function restoreShelfPreferences() {
  const key = shelfPreferenceKey();
  if (!key) return;
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    if (document.getElementById('shelf-search')) document.getElementById('shelf-search').value = value.search || '';
    if (document.getElementById('shelf-filter') && [...document.getElementById('shelf-filter').options].some(option => option.value === value.filter)) document.getElementById('shelf-filter').value = value.filter;
    if (document.getElementById('shelf-sort') && [...document.getElementById('shelf-sort').options].some(option => option.value === value.sort)) document.getElementById('shelf-sort').value = value.sort;
    if (document.getElementById('shelf-density') && ['comfortable', 'compact'].includes(value.density)) document.getElementById('shelf-density').value = value.density;
  } catch (_) {}
}

function scheduleShelfRender() {
  clearTimeout(shelfRenderTimer);
  shelfRenderTimer = setTimeout(renderShelf, 130);
}

function estimatedBookMinutes(entry, remainingOnly = false) {
  const total = Math.max(10, Math.round((entry.fileSize || 1_000_000) / personalReadingBytesPerMinute));
  return remainingOnly ? Math.max(0, Math.round(total * (1 - (entry.progress || 0) / 100))) : total;
}

function formatMinutes(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${rest ? ` ${rest}m` : ''}`;
}

function coverMarkup(entry, className = 'cover-img') {
  return entry.coverPath
    ? `<img class="${className}" src="/api/books/${entry.id}/cover" alt="" loading="lazy" decoding="async">`
    : `<span class="spine-title">${escapeHtml(entry.name)}</span><span class="spine-author">${escapeHtml(entry.author || '')}</span>`;
}

function renderContinueCard(){
  const rail = document.getElementById('continue-card');
  const candidates = library.filter(entry => entry.lastOpenedAt && entry.progress > 0 && entry.progress < 98)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, 4);
  rail.replaceChildren();
  if (!candidates.length) { rail.style.display = 'none'; return; }
  const fragment = document.createDocumentFragment();
  candidates.forEach(entry => {
    const item = document.createElement('article');
    item.className = 'continue-item';
    item.tabIndex = 0;
    item.innerHTML = `<div class="spine" style="background:${entry.coverColor}">${coverMarkup(entry)}</div><div><div class="kicker">Continue reading</div><h3>${escapeHtml(entry.name)}</h3><div class="author">${escapeHtml(entry.author || 'Unknown author')}</div><div class="progress-text">${Math.round(entry.progress)}% · about ${formatMinutes(estimatedBookMinutes(entry, true))} left</div><div class="book-progress-bar"><div class="book-progress-fill" style="width:${entry.progress}%"></div></div></div>`;
    item.onclick = () => openBook(entry.id);
    item.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openBook(entry.id); } };
    fragment.appendChild(item);
  });
  rail.appendChild(fragment);
  rail.style.display = 'flex';
  scheduleBookWarmup(candidates[0]);
}

function smartBook(entry, subtitle) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'smart-book';
  item.innerHTML = `<strong>${escapeHtml(entry.name)}</strong><span>${escapeHtml(subtitle || entry.author || 'Unknown author')}</span>`;
  item.onclick = () => openBook(entry.id);
  return item;
}

function renderSmartSections(searchQuery, filterValue) {
  const root = document.getElementById('smart-sections');
  root.replaceChildren();
  if (searchQuery || filterValue !== 'all' || !library.length) { root.style.display = 'none'; return; }
  const sections = [];
  sections.push(['Recently added', [...library].sort((a,b) => b.addedAt - a.addedAt).slice(0,8), entry => entry.author]);
  const unread = library.filter(entry => entry.progress === 0).slice(0,8);
  if (unread.length) sections.push(['Unread', unread, entry => entry.author]);
  const finished = library.filter(entry => entry.progress >= 98).slice(0,8);
  if (finished.length) sections.push(['Finished', finished, entry => entry.author]);
  const series = new Map();
  library.filter(entry => entry.series).forEach(entry => {
    if (!series.has(entry.series)) series.set(entry.series, []);
    series.get(entry.series).push(entry);
  });
  if (series.size) {
    const seriesEntries = [...series.entries()].slice(0,8).map(([name, entries]) => ({ ...entries[0], name, __subtitle: `${entries.length} book${entries.length === 1 ? '' : 's'}` }));
    sections.splice(1, 0, ['Your series', seriesEntries, entry => entry.__subtitle]);
  }
  for (const [title, entries, subtitle] of sections) {
    if (!entries.length) continue;
    const section = document.createElement('section');
    section.className = 'smart-section';
    const heading = document.createElement('h3'); heading.textContent = title;
    const rail = document.createElement('div'); rail.className = 'smart-rail';
    entries.forEach(entry => rail.appendChild(smartBook(entry, subtitle(entry))));
    section.append(heading, rail); root.appendChild(section);
  }
  root.style.display = root.childElementCount ? 'grid' : 'none';
}

function createShelfCard(entry) {
  const card = document.createElement('article');
  card.className = `book-card${bulkMode ? ' bulk-mode' : ''}${bulkSelection.has(entry.id) ? ' selected' : ''}`;
  card.tabIndex = 0;
  card.setAttribute('aria-label', `${entry.name} by ${entry.author || 'Unknown author'}`);
  const seriesBadge = entry.series ? `<div class="series-tag">${escapeHtml(formatSeriesText(entry.series, entry.seriesIndex))}</div>` : '';
  card.innerHTML = `${bulkMode ? `<input class="book-select" type="checkbox" aria-label="Select ${escapeHtml(entry.name)}" ${bulkSelection.has(entry.id) ? 'checked' : ''}>` : ''}<div class="spine" style="background:${entry.coverColor}">${coverMarkup(entry)}${entry.progress > 0 ? `<span class="spine-badge">${Math.round(entry.progress)}%</span>` : ''}<button type="button" class="book-menu-btn" aria-label="Details and actions for ${escapeHtml(entry.name)}">⋯</button></div><div class="book-meta-under">${seriesBadge}<div class="title" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div><div class="author">${escapeHtml(entry.author || 'Unknown')}</div><div class="shelf-rating-widget">${renderRatingHtml(entry.id, entry.rating)}</div><div class="book-progress-bar"><div class="book-progress-fill" style="width:${entry.progress}%"></div></div></div>`;
  const activate = event => {
    if (event.target.closest('.book-menu-btn,.star-btn')) return;
    if (bulkMode) {
      bulkSelection.has(entry.id) ? bulkSelection.delete(entry.id) : bulkSelection.add(entry.id);
      updateBulkToolbar(); renderShelf();
    } else openBook(entry.id);
  };
  card.onclick = activate;
  card.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(event); } };
  card.querySelector('.book-menu-btn').onclick = event => { event.stopPropagation(); openBookDetails(entry.id); };
  return card;
}

function renderShelf(){
  const shelf = document.getElementById('shelf');
  shelf.classList.toggle('compact', document.getElementById('shelf-density')?.value === 'compact');
  const empty = document.getElementById('shelf-empty');
  const header = document.getElementById('shelf-header');
  shelf.replaceChildren();
  renderContinueCard();
  if (!library.length) {
    empty.style.display = 'block'; header.style.display = 'none'; document.getElementById('continue-card').style.display = 'none'; document.getElementById('smart-sections').style.display = 'none'; return;
  }
  empty.style.display = 'none'; header.style.display = 'flex';
  const searchQuery = document.getElementById('shelf-search').value.trim().toLocaleLowerCase();
  const filterValue = document.getElementById('shelf-filter').value;
  const searchable = entry => `${entry.name || ''} ${entry.author || ''} ${entry.series || ''} ${entry.description || ''} ${entry.tags || ''} ${entry.isbn || ''}`.toLocaleLowerCase();
  let filtered = searchQuery ? library.filter(entry => searchable(entry).includes(searchQuery)) : [...library];
  if (filterValue === 'unread') filtered = filtered.filter(entry => entry.progress === 0);
  else if (filterValue === 'finished') filtered = filtered.filter(entry => entry.progress >= 98);
  else if (filterValue.startsWith('col_')) {
    const collection = allCollections.find(item => item.id === filterValue.slice(4));
    if (collection) filtered = filtered.filter(entry => collection.book_ids.includes(entry.id));
  }
  const sortValue = document.getElementById('shelf-sort').value;
  filtered.sort((a,b) => {
    if (sortValue === 'opened') return (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0);
    if (sortValue === 'title') return a.name.localeCompare(b.name);
    if (sortValue === 'author') return (a.author || '').localeCompare(b.author || '');
    if (sortValue === 'progress') return b.progress - a.progress;
    if (sortValue === 'series') return (a.series || '\uffff').localeCompare(b.series || '\uffff') || (Number(a.seriesIndex) || 0) - (Number(b.seriesIndex) || 0);
    return (b.addedAt || 0) - (a.addedAt || 0);
  });
  document.getElementById('shelf-count').textContent = filtered.length === library.length ? `${library.length} book${library.length === 1 ? '' : 's'}` : `${filtered.length} of ${library.length} books`;
  renderSmartSections(searchQuery, filterValue);
  const fragment = document.createDocumentFragment();
  filtered.forEach(entry => fragment.appendChild(createShelfCard(entry)));
  shelf.appendChild(fragment);
  saveShelfPreferences();
}

function toggleReaderMoreMenu(event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById('reader-more-menu');
  const button = document.getElementById('reader-more-btn');
  menu.hidden = !menu.hidden;
  button?.setAttribute('aria-expanded', String(!menu.hidden));
}

function toggleBulkMode(force) {
  bulkMode = typeof force === 'boolean' ? force : !bulkMode;
  if (!bulkMode) bulkSelection.clear();
  updateBulkToolbar(); renderShelf();
}

function updateBulkToolbar() {
  const toolbar = document.getElementById('bulk-toolbar');
  toolbar.hidden = !bulkMode;
  document.getElementById('bulk-count').textContent = `${bulkSelection.size} selected`;
  updateRoleAwareControls();
}

async function downloadBookOffline(id) {
  setSyncState('saving', 'Downloading…');
  const [fileResponse, coverResponse] = await Promise.all([
    api.fetch(`/api/books/${id}/file`, { headers: {} }),
    api.fetch(`/api/books/${id}/cover`, { headers: {} }).catch(() => null),
  ]);
  // Fully consume the responses so the service worker can finish its cache put.
  await fileResponse.blob();
  if (coverResponse?.ok) await coverResponse.blob();
  setSyncState('saved', 'Available offline');
}

async function removeOfflineBook(id) {
  const cacheNames = await caches.keys();
  await Promise.all(cacheNames.map(async name => {
    const cache = await caches.open(name);
    const requests = await cache.keys();
    await Promise.all(requests.filter(request => new URL(request.url).pathname.includes(`/api/books/${id}/`)).map(request => cache.delete(request)));
  }));
  showToast('Offline download removed.');
}

async function bulkDownloadOffline() {
  for (const id of bulkSelection) await downloadBookOffline(id);
  showToast(`${bulkSelection.size} book${bulkSelection.size === 1 ? '' : 's'} available offline.`); toggleBulkMode(false);
}

async function bulkAddToCollection() {
  if (!requireAdmin('organize books')) return;
  const name = prompt(`Collection name (${allCollections.map(item => item.name).join(', ')})`);
  if (!name) return;
  let collection = allCollections.find(item => item.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  if (!collection) collection = await api.createCollection(name.trim());
  for (const id of bulkSelection) await api.addBookToCollection(id, collection.id);
  await loadCollections(); showToast('Books added to collection.'); toggleBulkMode(false);
}

async function bulkRemoveFromCollection() {
  if (!requireAdmin('organize books')) return;
  const name = prompt(`Remove from collection (${allCollections.map(item => item.name).join(', ')})`);
  if (!name) return;
  const collection = allCollections.find(item => item.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  if (!collection) { showToast('Collection not found.'); return; }
  for (const id of bulkSelection) await api.removeBookFromCollection(id, collection.id);
  await loadCollections(); showToast('Books removed from collection.'); toggleBulkMode(false);
}

async function bulkEditSeries() {
  if (!requireAdmin('edit shared book metadata')) return;
  const series = prompt('Series name (leave blank to clear)');
  if (series == null) return;
  const ordered = [...bulkSelection].map(id => library.find(entry => entry.id === id)).filter(Boolean);
  const startText = series.trim() ? prompt('Starting series number (optional; increments in shelf order)', '') : '';
  if (startText == null) return;
  const parsedStart = startText.trim() === '' ? null : Number(startText);
  if (parsedStart != null && !Number.isFinite(parsedStart)) { showToast('Series number must be numeric.'); return; }
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index];
    const updated = await api.updateBook(entry.id, {
      series: series.trim() || null,
      series_index: parsedStart == null ? null : parsedStart + index,
    });
    entry.series = updated.series || '';
    entry.seriesIndex = updated.series_index;
  }
  showToast('Series details updated.'); toggleBulkMode(false); renderShelf();
}

async function bulkDeleteBooks() {
  if (!requireAdmin('remove books')) return;
  const confirmed = await showConfirmDialog({ title: 'Remove selected books', message: `Remove ${bulkSelection.size} selected books and their reading data?`, confirmText: 'Remove books', danger: true });
  if (!confirmed) return;
  for (const id of [...bulkSelection]) await api.deleteBook(id);
  library = library.filter(entry => !bulkSelection.has(entry.id)); showToast('Selected books removed.'); toggleBulkMode(false);
}

async function openBookDetails(id) {
  const entry = library.find(item => item.id === id);
  if (!entry) return;
  const modal = document.getElementById('book-details-modal');
  document.getElementById('book-details-title').textContent = entry.name;
  document.getElementById('book-details-content').innerHTML = `<div class="book-details-layout"><div class="book-details-cover" style="background:${entry.coverColor}">${coverMarkup(entry, 'book-details-cover')}</div><div><div class="book-detail-meta">${escapeHtml(entry.author || 'Unknown author')}<br>${entry.series ? escapeHtml(formatSeriesText(entry.series, entry.seriesIndex)) + '<br>' : ''}${(entry.fileSize / 1024 / 1024).toFixed(1)} MB · about ${formatMinutes(estimatedBookMinutes(entry))}<br>${entry.progress ? `${Math.round(entry.progress)}% read · ${formatMinutes(estimatedBookMinutes(entry, true))} remaining` : 'Unread'}${entry.isbn ? `<br>ISBN ${escapeHtml(entry.isbn)}` : ''}${entry.tags ? `<br>${escapeHtml(entry.tags)}` : ''}</div><p class="book-description">${escapeHtml(entry.description || 'No description available.')}</p></div></div>`;
  const actions = document.getElementById('book-details-actions');
  actions.innerHTML = `<button type="button" onclick="closeBookDetails(); openBook('${id}')">${entry.progress ? 'Continue reading' : 'Read'}</button><button type="button" onclick="downloadBookOffline('${id}').then(()=>showToast('Book is available offline.'))">Download for offline</button><button type="button" onclick="removeOfflineBook('${id}')">Remove download</button>${isCurrentUserAdmin() ? `<button type="button" onclick="openBookCollectionsModal('${id}')">Collections</button><button type="button" onclick="editBookMetadata('${id}')">Edit details</button><button type="button" onclick="closeBookDetails(); removeBook('${id}')">Remove book</button>` : ''}`;
  modal.classList.add('show'); modal.setAttribute('aria-hidden', 'false'); modal.querySelector('button')?.focus();
}

function closeBookDetails() { const modal = document.getElementById('book-details-modal'); modal.classList.remove('show'); modal.setAttribute('aria-hidden', 'true'); }

async function editBookMetadata(id) {
  const entry = library.find(item => item.id === id); if (!entry) return;
  const title = prompt('Title', entry.name); if (title == null) return;
  const author = prompt('Author', entry.author || ''); if (author == null) return;
  const description = prompt('Description', entry.description || ''); if (description == null) return;
  const tags = prompt('Tags', entry.tags || ''); if (tags == null) return;
  const updated = await api.updateBook(id, { title, author, description, tags });
  Object.assign(entry, { name: updated.title, author: updated.author, description: updated.description || '', tags: updated.tags || '' });
  closeBookDetails(); renderShelf(); showToast('Book details updated.');
}

async function openNotebookModal() {
  const modal = document.getElementById('notebook-modal'); modal.classList.add('show'); modal.setAttribute('aria-hidden', 'false');
  notebookItems = await api.getAllHighlights(); notebookTagFilter = ''; renderNotebook(); document.getElementById('notebook-search').focus();
}

function closeNotebookModal() { const modal = document.getElementById('notebook-modal'); modal.classList.remove('show'); modal.setAttribute('aria-hidden', 'true'); }

function renderNotebook() {
  const query = (document.getElementById('notebook-search')?.value || '').trim().toLocaleLowerCase();
  const tags = [...new Set(notebookItems.flatMap(item => item.tags || []))].sort();
  document.getElementById('notebook-tags').innerHTML = tags.map(tag => `<button class="tag-chip" type="button" onclick="notebookTagFilter='${escapeHtml(tag)}'; renderNotebook()">#${escapeHtml(tag)}</button>`).join('');
  const filtered = notebookItems.filter(item => (!query || `${item.excerpt || ''} ${item.note || ''} ${item.book_title || ''} ${(item.tags || []).join(' ')}`.toLocaleLowerCase().includes(query)) && (!notebookTagFilter || (item.tags || []).includes(notebookTagFilter)));
  document.getElementById('notebook-list').innerHTML = filtered.length ? filtered.map(item => `<article class="notebook-item"><small>${escapeHtml(item.book_title)} · ${escapeHtml(item.chapter || '')}</small><blockquote>${escapeHtml(item.excerpt || '')}</blockquote>${item.note ? `<p>${escapeHtml(item.note)}</p>` : ''}<div>${(item.tags || []).map(tag => `<span class="tag-chip">#${escapeHtml(tag)}</span>`).join(' ')} <button class="file-link-btn" onclick="editHighlightTags('${item.id}')">Edit tags</button> <button class="file-link-btn" onclick="closeNotebookModal(); openBook('${item.book_id}')">Open</button></div></article>`).join('') : '<p class="bookmark-empty">No matching highlights.</p>';
}

async function editHighlightTags(id) {
  const item = notebookItems.find(value => value.id === id); if (!item) return;
  const value = prompt('Comma-separated tags', (item.tags || []).join(', ')); if (value == null) return;
  const updated = await api.updateHighlight(id, { tags: value.split(',') }); item.tags = updated.tags || []; renderNotebook();
}

function selectionText() { return pendingHighlightContext?.excerpt || ''; }
async function copySelectionText() { const text = selectionText(); if (text) await navigator.clipboard.writeText(text); hideHighlightPopup(); showToast('Copied selection.'); }
async function shareSelectionText() { const text = selectionText(); if (!text) return; if (navigator.share) await navigator.share({ text }); else await navigator.clipboard.writeText(text); hideHighlightPopup(); }
function lookupSelectedWord() { const word = selectionText().trim().split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, ''); hideHighlightPopup(); if (word) lookupDictionary(word, window.innerWidth / 2, 100); }
async function addNoteToSelection() {
  const context = pendingHighlightContext; if (!context) return;
  const note = prompt('Add a note'); if (note == null) return;
  const saved = await resilientApiPost(`/api/books/${context.entry.id}/highlights`, { cfi_range: context.cfi, color: '#F2D94E', excerpt: context.excerpt, note, chapter: '' }, false, 'POST', context.requestOptions);
  context.entry.highlights.push({ id: saved.id, cfi: context.cfi, color: '#F2D94E', excerpt: context.excerpt, note, tags: [] });
  try { context.targetRendition.annotations.add('highlight', context.cfi, {}, null, 'epub-highlight', highlightStyle('#F2D94E')); } catch (_) {}
  finishPendingHighlight(context); renderHighlights();
}

function updateGestureSettings() {
  settings.gestures = { swipe: document.getElementById('gesture-swipe').checked, edge: document.getElementById('gesture-edge').checked, center: document.getElementById('gesture-center').checked };
  saveSettings();
}

function syncGestureSettingsUI() {
  const gestures = settings.gestures || {};
  if (document.getElementById('gesture-swipe')) document.getElementById('gesture-swipe').checked = gestures.swipe !== false;
  if (document.getElementById('gesture-edge')) document.getElementById('gesture-edge').checked = gestures.edge !== false;
  if (document.getElementById('gesture-center')) document.getElementById('gesture-center').checked = gestures.center !== false;
}

function updateProgressEstimate() {
  const entry = getCurrentEntry(); const target = document.getElementById('progress-remaining');
  if (entry && target) target.textContent = `${formatMinutes(estimatedBookMinutes(entry, true))} left`;
}

function populateTtsVoices() {
  const select = document.getElementById('tts-voice-select'); if (!select || !('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices(); select.replaceChildren(...voices.map(voice => new Option(`${voice.name} (${voice.lang})`, voice.voiceURI, false, voice.voiceURI === ttsVoiceURI)));
}

function applyAppUpdate() { window.__pendingServiceWorker?.postMessage({ type: 'SKIP_WAITING' }); }
function dismissInstallTip() { localStorage.setItem('endpaper_install_tip_dismissed', '1'); document.getElementById('install-tip').hidden = true; }

async function saveReadingGoals() {
  const goals = { dailyMinutes: Number(document.getElementById('goal-daily').value) || 0, weeklyHours: Number(document.getElementById('goal-weekly').value) || 0, booksPerYear: Number(document.getElementById('goal-books').value) || 0 };
  await api.saveSettings({ 'reading-goals': goals }); showToast('Reading goals saved.');
}

document.getElementById('shelf-search')?.setAttribute('oninput', 'scheduleShelfRender()');
document.getElementById('shelf-filter')?.setAttribute('onchange', 'renderShelf()');
document.getElementById('shelf-sort')?.setAttribute('onchange', 'renderShelf()');
document.addEventListener('click', event => { if (!event.target.closest('#reader-more-menu,#reader-more-btn,#reader-bottom-actions')) { document.getElementById('reader-more-menu').hidden = true; document.getElementById('reader-more-btn')?.setAttribute('aria-expanded','false'); } });
document.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const modal = document.querySelector('.modal.show[aria-modal="true"]'); if (!modal) return;
  const focusable = [...modal.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(item => !item.hidden);
  if (!focusable.length) return;
  if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
  else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
});

document.getElementById('tts-voice-select')?.addEventListener('change', event => { ttsVoiceURI = event.target.value; if (ttsQueue.length && !ttsIsPaused) speakCurrentTtsItem(); });
document.getElementById('tts-pitch')?.addEventListener('input', event => { ttsPitch = Number(event.target.value); if (ttsQueue.length && !ttsIsPaused) speakCurrentTtsItem(); });
document.getElementById('tts-sleep')?.addEventListener('change', event => { if (ttsSleepTimer) clearTimeout(ttsSleepTimer); const minutes = Number(event.target.value); if (minutes) ttsSleepTimer = setTimeout(() => { stopTts(); showToast('Sleep timer ended.'); }, minutes * 60_000); });
if ('speechSynthesis' in window) { populateTtsVoices(); speechSynthesis.addEventListener?.('voiceschanged', populateTtsVoices); }
new MutationObserver(updateProgressEstimate).observe(document.getElementById('progress-pct'), { childList: true, characterData: true, subtree: true });

window.addEventListener('load', () => {
  const isIosSafari = /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone;
  if (isIosSafari && !localStorage.getItem('endpaper_install_tip_dismissed')) document.getElementById('install-tip').hidden = false;
  restoreShelfPreferences(); syncGestureSettingsUI();
});
