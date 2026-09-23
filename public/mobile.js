/* Mobile presentation over the same library, API, and reader used on desktop. */
const mobileBuildVersion = new URL(document.currentScript.src).searchParams.get('v') || 'unknown';
let mobileRoute = { page: 'home' };
let mobileLibraryView = localStorage.getItem('endpaper-mobile-library-view') === 'grid' ? 'grid' : 'list';
let mobileSearchQuery = '';
let mobilePinnedIds = new Set();
let mobileRenderVersion = 0;
let mobileNotebookQuery = '';
let mobileNotebookTag = '';

function resetMobileState() {
  mobileRoute = { page: 'home' };
  mobileSearchQuery = '';
  mobilePinnedIds = new Set();
  mobileNotebookQuery = '';
  mobileNotebookTag = '';
  mobileRenderVersion++;
  document.getElementById('mobile-actions-sheet')?.remove();
  document.getElementById('mobile-content')?.replaceChildren();
}
window.resetMobileState = resetMobileState;

function isMobileShell() {
  return window.matchMedia('(max-width: 700px), (max-width: 900px) and (pointer: coarse)').matches;
}

function mobileReadingStatus(entry) {
  return entry.status || (entry.progress >= 98 ? 'finished' : entry.progress > 0 ? 'reading' : 'unread');
}

function mobileElement(tag, className = '', text = '') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function mobileButton(text, action, className = '') {
  const button = mobileElement('button', className, text);
  button.type = 'button';
  button.addEventListener('click', action);
  return button;
}

function mobileNavigate(page, value = null) {
  mobileRoute = { page, value };
  if (isMobileShell()) history.pushState({ endpaperMobile: mobileRoute }, '', `#/${page}${value ? `/${encodeURIComponent(value)}` : ''}`);
  renderMobileShell();
  if (page === 'library' && document.getElementById('shelf-filter')?.value === 'downloaded') {
    mobileRefreshPins().then(success => { if (success && mobileRoute.page === 'library') renderMobileShell(); });
  }
  document.getElementById('shelf-view')?.scrollTo(0, 0);
}

function mobileBack() {
  if (history.state?.endpaperMobile) history.back();
  else mobileNavigate('home');
}

window.addEventListener('popstate', event => {
  if (!isMobileShell()) return;
  if (document.body.classList.contains('reader-active')) showShelf();
  mobileRoute = event.state?.endpaperMobile || { page: 'home' };
  renderMobileShell();
});

function mobileHeading(title, kicker = '', back = false) {
  const header = mobileElement('header', 'mobile-heading');
  if (back) header.appendChild(mobileButton('‹ Back', mobileBack, 'mobile-back'));
  if (kicker) header.appendChild(mobileElement('p', 'mobile-kicker', kicker));
  header.appendChild(mobileElement('h1', '', title));
  return header;
}

function mobileCover(entry, className = '') {
  const cover = mobileElement('div', `mobile-cover ${className}`);
  cover.style.backgroundColor = /^#[0-9a-f]{3,8}$/i.test(entry.coverColor || '') ? entry.coverColor : '#554a3b';
  if (entry.coverPath) {
    const image = mobileElement('img');
    image.src = `/api/books/${encodeURIComponent(entry.id)}/cover`;
    image.alt = '';
    image.loading = 'lazy';
    cover.appendChild(image);
  } else {
    const fallback = mobileElement('span', 'mobile-cover-title', className.includes('mobile-list-cover') ? (entry.name.trim().charAt(0) || 'B').toLocaleUpperCase() : entry.name);
    fallback.setAttribute('aria-hidden', 'true');
    cover.appendChild(fallback);
  }
  return cover;
}

function mobileBookCard(entry, layout = 'grid', selectable = false) {
  const card = mobileButton('', () => {
    if (selectable && bulkMode) {
      bulkSelection.has(entry.id) ? bulkSelection.delete(entry.id) : bulkSelection.add(entry.id);
      renderMobileShell();
    } else mobileNavigate('book', entry.id);
  }, `mobile-book mobile-${layout}${selectable && bulkSelection.has(entry.id) ? ' mobile-selected' : ''}`);
  card.setAttribute('aria-label', `${selectable && bulkMode ? bulkSelection.has(entry.id) ? 'Deselect' : 'Select' : 'Details for'} ${entry.name}`);
  if (selectable && bulkMode) card.setAttribute('aria-pressed', String(bulkSelection.has(entry.id)));
  card.appendChild(mobileCover(entry, layout === 'list' ? 'mobile-list-cover' : ''));
  const info = mobileElement('span', 'mobile-book-info');
  info.appendChild(mobileElement('strong', '', entry.name));
  info.appendChild(mobileElement('small', '', entry.author || 'Unknown author'));
  if (layout === 'list') info.appendChild(mobileElement('small', 'mobile-book-progress', mobileReadingStatus(entry) === 'finished' ? 'Finished' : entry.progress ? `${Math.round(entry.progress)}% read` : mobileReadingStatus(entry) === 'reading' ? 'Reading' : 'Unread'));
  card.appendChild(info);
  return card;
}

function mobileRail(title, entries, onSelect) {
  if (!entries.length) return null;
  const section = mobileElement('section', 'mobile-section');
  section.appendChild(mobileElement('h2', '', title));
  const rail = mobileElement('div', 'mobile-rail');
  entries.forEach(entry => rail.appendChild(onSelect ? onSelect(entry) : mobileBookCard(entry)));
  section.appendChild(rail);
  return section;
}

function mobileHome(root) {
  root.appendChild(mobileHeading('Your reading', 'ENDPAPER'));
  const resume = library.filter(entry => entry.lastOpenedAt && mobileReadingStatus(entry) === 'reading')
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
  if (resume) {
    const section = mobileElement('section', 'mobile-section');
    section.appendChild(mobileElement('h2', '', 'Continue reading'));
    const card = mobileButton('', () => openBook(resume.id), 'mobile-continue');
    card.appendChild(mobileCover(resume));
    const info = mobileElement('span', 'mobile-continue-info');
    info.appendChild(mobileElement('strong', '', resume.name));
    info.appendChild(mobileElement('small', '', resume.author || 'Unknown author'));
    const time = formatMinutes(estimatedBookMinutes(resume, true));
    info.appendChild(mobileElement('small', '', `${Math.round(resume.progress)}% read${time ? ` · about ${time} left` : ''}`));
    const track = mobileElement('span', 'mobile-progress-track');
    const fill = mobileElement('span'); fill.style.width = `${Math.max(0, Math.min(100, resume.progress))}%`;
    track.appendChild(fill); info.appendChild(track); card.appendChild(info); section.appendChild(card); root.appendChild(section);
  }
  const seen = new Set(resume ? [resume.id] : []);
  const recent = [...library].sort((a, b) => b.addedAt - a.addedAt).filter(entry => !seen.has(entry.id)).slice(0, 8);
  recent.forEach(entry => seen.add(entry.id));
  const recentRail = mobileRail('Recently added', recent);
  if (recentRail) root.appendChild(recentRail);
  const series = new Map();
  library.filter(entry => entry.series).forEach(entry => {
    if (!series.has(entry.series)) series.set(entry.series, []);
    series.get(entry.series).push(entry);
  });
  const seriesRail = mobileRail('Your series', [...series].map(([name, books]) => ({ name, books })), item => {
    const card = mobileButton('', () => mobileNavigate('series', item.name), 'mobile-book mobile-grid');
    card.appendChild(mobileCover(item.books[0]));
    const info = mobileElement('span', 'mobile-book-info');
    info.appendChild(mobileElement('strong', '', item.name));
    info.appendChild(mobileElement('small', '', `${item.books.length} book${item.books.length === 1 ? '' : 's'}`));
    card.appendChild(info); return card;
  });
  if (seriesRail) root.appendChild(seriesRail);
  const unread = library.filter(entry => mobileReadingStatus(entry) === 'unread' && !seen.has(entry.id)).slice(0, 8);
  const unreadRail = mobileRail('Unread picks', unread);
  if (unreadRail) root.appendChild(unreadRail);
  if (!library.length) root.appendChild(mobileElement('p', 'mobile-empty', 'Your shared library is empty. Add an EPUB to start reading.'));
  root.appendChild(mobileButton('Browse all books  →', () => mobileNavigate('library'), 'mobile-wide-action'));
}

function mobileFilteredLibrary() {
  const filter = document.getElementById('shelf-filter')?.value || 'all';
  const sort = document.getElementById('shelf-sort')?.value || 'recent';
  let books = [...library];
  if (filter === 'unread') books = books.filter(entry => mobileReadingStatus(entry) === 'unread');
  else if (filter === 'reading') books = books.filter(entry => mobileReadingStatus(entry) === 'reading');
  else if (filter === 'finished') books = books.filter(entry => mobileReadingStatus(entry) === 'finished');
  else if (filter === 'downloaded') books = books.filter(entry => mobilePinnedIds.has(entry.id));
  else if (filter.startsWith('col_')) {
    const collection = allCollections.find(item => item.id === filter.slice(4));
    if (collection) books = books.filter(entry => collection.book_ids.includes(entry.id));
  }
  books.sort((a, b) => {
    if (sort === 'opened') return (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0);
    if (sort === 'title') return a.name.localeCompare(b.name);
    if (sort === 'author') return (a.author || '').localeCompare(b.author || '');
    if (sort === 'progress') return b.progress - a.progress;
    if (sort === 'series') return (a.series || '\uffff').localeCompare(b.series || '\uffff') || (Number(a.seriesIndex) || 0) - (Number(b.seriesIndex) || 0);
    return (b.addedAt || 0) - (a.addedAt || 0);
  });
  return books;
}

function mobileLibrary(root) {
  root.appendChild(mobileHeading('Library', 'THE SHARED SHELF'));
  const tools = mobileElement('div', 'mobile-library-tools');
  tools.appendChild(mobileElement('span', '', `${library.length} book${library.length === 1 ? '' : 's'}`));
  tools.appendChild(mobileButton('Sort & filter', mobileLibraryActions, 'mobile-pill'));
  tools.appendChild(mobileButton('Add books', () => document.getElementById('file-input').click(), 'mobile-pill'));
  tools.appendChild(mobileButton(bulkMode ? 'Cancel selection' : 'Select books', () => toggleBulkMode(!bulkMode), 'mobile-pill'));
  tools.appendChild(mobileButton(mobileLibraryView === 'list' ? '▦ Grid' : '☰ List', () => {
    mobileLibraryView = mobileLibraryView === 'list' ? 'grid' : 'list'; localStorage.setItem('endpaper-mobile-library-view', mobileLibraryView); renderMobileShell();
  }, 'mobile-pill'));
  root.appendChild(tools);
  if (bulkMode) {
    const bar = mobileElement('div', 'mobile-bulk-actions');
    bar.appendChild(mobileElement('span', '', `${bulkSelection.size} selected`));
    if (bulkSelection.size) {
      bar.appendChild(mobileButton('Download', () => bulkDownloadOffline()));
      if (isCurrentUserAdmin()) {
        bar.appendChild(mobileButton('Collection', () => bulkAddToCollection()));
        bar.appendChild(mobileButton('Series', () => bulkEditSeries()));
        bar.appendChild(mobileButton('Remove', () => bulkDeleteBooks()));
      }
    }
    root.appendChild(bar);
  }
  const list = mobileElement('div', `mobile-books mobile-books-${mobileLibraryView}`);
  mobileFilteredLibrary().forEach(entry => {
    const card = mobileBookCard(entry, mobileLibraryView, true);
    if (mobileLibraryView === 'list' && !bulkMode) {
      const row = mobileElement('div', 'mobile-library-row');
      row.appendChild(card);
      const menu = mobileButton('⋯', event => mobileBookActions(entry, event.currentTarget), 'mobile-row-menu');
      menu.setAttribute('aria-label', `Actions for ${entry.name}`);
      row.appendChild(menu); list.appendChild(row);
    } else list.appendChild(card);
  });
  root.appendChild(list);
}

function mobileBookActions(entry, returnFocus) {
  const backdrop = mobileElement('div', 'mobile-sheet-backdrop');
  const sheet = mobileElement('section', 'mobile-actions-sheet');
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', `Actions for ${entry.name}`);
  sheet.appendChild(mobileElement('h2', '', entry.name));
  const close = () => { backdrop.remove(); requestAnimationFrame(() => returnFocus?.isConnected && returnFocus.focus({ preventScroll: true })); };
  const action = (label, handler) => sheet.appendChild(mobileButton(label, () => { close(); handler(); }, 'mobile-secondary-action'));
  action('Read', () => openBook(entry.id));
  action('Book details', () => mobileNavigate('book', entry.id));
  action('Download for offline', () => downloadBookOffline(entry.id).then(() => showToast('Book is available offline.')).catch(error => showToast(error.message)));
  if (isCurrentUserAdmin()) {
    action('Edit details', () => editBookMetadata(entry.id));
    action('Remove book', () => removeBook(entry.id));
  }
  sheet.appendChild(mobileButton('Done', close, 'mobile-wide-action'));
  backdrop.appendChild(sheet);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  backdrop.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const buttons = [...sheet.querySelectorAll('button')];
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
    }
  });
  document.body.appendChild(backdrop); sheet.querySelector('button')?.focus();
}

function mobileLibraryActions(event) {
  document.getElementById('mobile-actions-sheet')?.remove();
  const returnFocus = event?.currentTarget || document.activeElement;
  const backdrop = mobileElement('div', 'mobile-sheet-backdrop'); backdrop.id = 'mobile-actions-sheet';
  const sheet = mobileElement('section', 'mobile-actions-sheet');
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'mobile-actions-title');
  const heading = mobileElement('h2', '', 'Library options'); heading.id = 'mobile-actions-title'; sheet.appendChild(heading);
  const close = () => {
    backdrop.remove();
    const focusTarget = returnFocus?.isConnected ? returnFocus : [...document.querySelectorAll('.mobile-library-tools button')].find(button => button.textContent === 'Sort & filter');
    requestAnimationFrame(() => focusTarget?.focus({ preventScroll: true }));
  };
  for (const [label, sourceId] of [['Show', 'shelf-filter'], ['Sort by', 'shelf-sort']]) {
    const wrapper = mobileElement('label', 'mobile-select-label', label);
    const source = document.getElementById(sourceId);
    const select = source.cloneNode(true);
    select.removeAttribute('id'); select.removeAttribute('onchange');
    if (sourceId === 'shelf-filter') {
      for (const [value, text] of [['reading', 'Reading'], ['downloaded', 'Downloaded']]) {
        if (![...source.options].some(option => option.value === value)) source.add(new Option(text, value));
      }
      select.replaceChildren(...[...source.options].map(option => option.cloneNode(true)));
    }
    select.value = source.value;
    select.addEventListener('change', () => { source.value = select.value; renderShelf(); });
    wrapper.appendChild(select); sheet.appendChild(wrapper);
  }
  sheet.appendChild(mobileButton('Collections', () => { close(); openCollectionsManager(); }, 'mobile-secondary-action'));
  sheet.appendChild(mobileButton('Downloaded books', () => { close(); document.getElementById('shelf-filter').value = 'downloaded'; renderShelf(); }, 'mobile-secondary-action'));
  sheet.appendChild(mobileButton('Select books', () => { close(); toggleBulkMode(true); }, 'mobile-secondary-action'));
  sheet.appendChild(mobileButton(mobileLibraryView === 'list' ? 'Grid view' : 'List view', () => { mobileLibraryView = mobileLibraryView === 'list' ? 'grid' : 'list'; localStorage.setItem('endpaper-mobile-library-view', mobileLibraryView); close(); renderMobileShell(); }, 'mobile-secondary-action'));
  sheet.appendChild(mobileButton('Add books', () => { close(); document.getElementById('file-input').click(); }, 'mobile-secondary-action'));
  sheet.appendChild(mobileButton('Done', close, 'mobile-wide-action'));
  backdrop.appendChild(sheet);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  backdrop.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...sheet.querySelectorAll('button,select,input')].filter(element => !element.disabled);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  document.body.appendChild(backdrop);
  sheet.querySelector('select')?.focus();
}

function mobileSearchResults(root, query) {
  root.replaceChildren();
  const needle = query.trim().toLocaleLowerCase();
  const matches = needle ? library.filter(entry => `${entry.name} ${entry.author || ''} ${entry.series || ''} ${entry.description || ''} ${entry.tags || ''} ${entry.isbn || ''}`.toLocaleLowerCase().includes(needle)) : [];
  root.appendChild(mobileElement('p', 'mobile-results-label', needle ? `${matches.length} result${matches.length === 1 ? '' : 's'}` : 'Search by title, author, series, tag, or ISBN'));
  matches.forEach(entry => root.appendChild(mobileBookCard(entry, 'list')));
}

function mobileSearch(root) {
  root.appendChild(mobileHeading('Search', 'FIND YOUR NEXT BOOK'));
  const input = mobileElement('input', 'mobile-search-input');
  input.type = 'search'; input.placeholder = 'Title, author, series, tag, or ISBN';
  input.setAttribute('aria-label', 'Search library'); input.value = mobileSearchQuery;
  const results = mobileElement('div', 'mobile-search-results');
  input.addEventListener('input', () => { mobileSearchQuery = input.value; mobileSearchResults(results, input.value); });
  root.append(input, results); mobileSearchResults(results, mobileSearchQuery);
}

function mobileMore(root) {
  root.appendChild(mobileHeading('More', 'YOUR ENDPAPER'));
  root.appendChild(mobileElement('p', 'mobile-account', currentUser?.username || currentUser?.name || 'Reader'));
  const options = mobileElement('div', 'mobile-more-list');
  const items = [
    ['Add books', () => document.getElementById('file-input').click()],
    ['Offline downloads', () => mobileNavigate('offline')],
    ['Notebook', () => mobileNavigate('notebook')],
    ['Reading stats', () => mobileNavigate('stats')],
    ['Reading goals', () => mobileNavigate('goals')],
    ['Appearance & reader defaults', () => mobileNavigate('preferences')],
    ['Check for updates', async () => {
      try {
        const registration = await navigator.serviceWorker?.getRegistration();
        await registration?.update();
        showToast(window.__pendingServiceWorker ? 'An update is ready.' : 'You have the latest version.');
      } catch (error) { showToast(error.message || 'Could not check for updates.'); }
    }],
    ['Help', () => openShortcutsModal()],
  ];
  if (isCurrentUserAdmin()) items.push(['Collections', () => openCollectionsManager()], ['People & permissions', () => openAdminModal()], ['Import backup', () => document.getElementById('import-input').click()], ['Export backup', () => exportLibrary()]);
  root.appendChild(mobileElement('p', 'mobile-detail-meta', `Role: ${isCurrentUserAdmin() ? 'Admin' : 'Reader'} · Endpaper ${mobileBuildVersion}`));
  items.push(['Log out', () => logout()]);
  items.forEach(([label, action]) => options.appendChild(mobileButton(`${label}  ›`, action)));
  root.appendChild(options);
}

function mobileSeries(root, name) {
  const books = library.filter(entry => entry.series === name).sort((a, b) => (Number(a.seriesIndex) || 0) - (Number(b.seriesIndex) || 0));
  if (!books.length) return mobileNavigate('home');
  const hero = mobileElement('div', 'mobile-series-hero');
  if (books[0].coverPath) hero.style.backgroundImage = `url('/api/books/${encodeURIComponent(books[0].id)}/cover')`;
  const stack = mobileElement('div', 'mobile-series-stack');
  books.slice(0, 3).forEach(entry => stack.appendChild(mobileCover(entry, 'mobile-series-cover')));
  hero.appendChild(stack);
  hero.appendChild(mobileHeading(name, `${books.length} BOOK${books.length === 1 ? '' : 'S'} IN THIS SERIES`, true));
  root.appendChild(hero);
  const next = books.find(entry => mobileReadingStatus(entry) === 'reading') || books.find(entry => mobileReadingStatus(entry) === 'unread') || books[0];
  root.appendChild(mobileElement('p', 'mobile-detail-meta', `By ${[...new Set(books.map(entry => entry.author).filter(Boolean))].join(', ') || 'Unknown author'} · ${mobileReadingStatus(next) === 'reading' ? 'Continue with' : 'Start with'} ${next.name}`));
  root.appendChild(mobileButton(mobileReadingStatus(next) === 'reading' ? 'Continue series' : 'Start reading', () => openBook(next.id), 'mobile-wide-action'));
  const list = mobileElement('div', 'mobile-books mobile-books-list');
  books.forEach(entry => list.appendChild(mobileBookCard(entry, 'list')));
  root.appendChild(list);
}

async function mobileRefreshPins() {
  try {
    const result = await serviceWorkerMessage('GET_PINNED_BOOKS');
    if (!result?.ok || !Array.isArray(result.bookIds)) throw new Error('Offline download list is unavailable.');
    mobilePinnedIds = new Set(result?.bookIds || []);
    return true;
  } catch (error) { console.warn('Could not check offline downloads:', error); return false; }
}

function mobileBookDetail(root, id) {
  const entry = library.find(item => item.id === id);
  if (!entry) return mobileNavigate('library');
  root.appendChild(mobileHeading('Book details', '', true));
  const hero = mobileElement('div', 'mobile-detail-hero');
  hero.appendChild(mobileCover(entry));
  const info = mobileElement('div');
  info.appendChild(mobileElement('h2', '', entry.name));
  info.appendChild(mobileElement('p', '', entry.author || 'Unknown author'));
  if (entry.series) info.appendChild(mobileButton(formatSeriesText(entry.series, entry.seriesIndex), () => mobileNavigate('series', entry.series), 'mobile-series-link'));
  hero.appendChild(info); root.appendChild(hero);
  root.appendChild(mobileButton(mobileReadingStatus(entry) === 'finished' ? 'Read again' : entry.progress ? 'Continue reading' : 'Start reading', () => { if (mobileReadingStatus(entry) === 'finished') entry.lastLocationCfi = null; openBook(entry.id); }, 'mobile-wide-action'));
  const actions = mobileElement('div', 'mobile-detail-actions');
  const offline = mobileButton('Checking download…', async () => {
    offline.disabled = true;
    try {
      if (mobilePinnedIds.has(id)) { await removeOfflineBook(id); mobilePinnedIds.delete(id); }
      else { await downloadBookOffline(id); mobilePinnedIds.add(id); }
      offline.textContent = mobilePinnedIds.has(id) ? 'Remove download' : 'Download for offline';
    } catch (error) { showToast(error.message || 'Offline download failed.'); }
    finally { offline.disabled = false; }
  });
  offline.disabled = true;
  actions.appendChild(offline);
  if (isCurrentUserAdmin()) {
    actions.appendChild(mobileButton('Collections', () => openBookCollectionsModal(id)));
    actions.appendChild(mobileButton('Edit details', () => editBookMetadata(id)));
  }
  root.appendChild(actions);
  const statusLabel = mobileElement('label', 'mobile-status-label', 'Reading status');
  const statusSelect = mobileElement('select');
  for (const [value, label] of [['unread', 'Unread'], ['reading', 'Reading'], ['finished', 'Finished']]) {
    const option = new Option(label, value, false, entry.status === value);
    statusSelect.appendChild(option);
  }
  statusSelect.addEventListener('change', async () => {
    const previous = entry.status;
    entry.status = statusSelect.value;
    try { const updated = await api.updateBook(id, { status: entry.status }); entry.status = updated.status; statusSelect.value = updated.status; renderShelf(); }
    catch (error) { entry.status = previous; statusSelect.value = previous; showToast(error.message || 'Could not save reading status.'); }
  });
  statusLabel.appendChild(statusSelect); root.appendChild(statusLabel);
  root.appendChild(mobileButton('Highlights & notes  ›', () => mobileNavigate('notebook', id), 'mobile-secondary-action'));
  root.appendChild(mobileButton('Read from beginning', () => { entry.lastLocationCfi = null; openBook(id); }, 'mobile-secondary-action'));
  if (isCurrentUserAdmin()) root.appendChild(mobileButton('Remove book', () => removeBook(id), 'mobile-secondary-action'));
  const rating = mobileElement('div', 'mobile-rating');
  rating.appendChild(mobileElement('span', '', 'Your rating'));
  for (let number = 1; number <= 5; number++) {
    rating.appendChild(mobileButton(number <= (entry.rating || 0) ? '★' : '☆', () => setBookRating(id, number === entry.rating ? null : number), 'mobile-star'));
  }
  root.appendChild(rating);
  root.appendChild(mobileElement('p', 'mobile-detail-meta', `${entry.progress ? `${Math.round(entry.progress)}% read` : 'Unread'}${entry.wordCount ? ` · about ${formatMinutes(estimatedBookMinutes(entry))}` : ''}${entry.fileSize ? ` · ${(entry.fileSize / 1048576).toFixed(1)} MB` : ''}`));
  if (entry.description) root.appendChild(mobileElement('p', 'mobile-description', entry.description));
  if (entry.tags) root.appendChild(mobileElement('p', 'mobile-detail-meta', entry.tags));
  mobileRefreshPins().then(success => {
    if (mobileRoute.page !== 'book' || mobileRoute.value !== id) return;
    offline.textContent = success ? mobilePinnedIds.has(id) ? 'Remove download' : 'Download for offline' : 'Download state unavailable';
    offline.disabled = !success;
  });
}

async function mobileOffline(root, version) {
  root.appendChild(mobileHeading('Offline downloads', '', true));
  const usage = mobileElement('p', 'mobile-detail-meta'); root.appendChild(usage);
  const list = mobileElement('div', 'mobile-books mobile-books-list'); root.appendChild(list);
  list.appendChild(mobileElement('p', 'mobile-empty', 'Checking downloads…'));
  await mobileRefreshPins();
  if (version !== mobileRenderVersion) return;
  list.replaceChildren();
  const stale = [...mobilePinnedIds].filter(id => !library.some(entry => entry.id === id));
  await Promise.all(stale.map(id => purgeOfflineBook(id).catch(error => console.warn('Offline cleanup failed:', error))));
  const books = library.filter(entry => mobilePinnedIds.has(entry.id));
  if (!books.length) { list.appendChild(mobileElement('p', 'mobile-empty', 'No books downloaded yet. Open a book’s details to save it for offline reading.')); return; }
  let totalBytes = 0;
  const cache = await caches.open('endpaper-pinned-books');
  for (const entry of books) {
    const response = await cache.match(`/api/books/${entry.id}/file`);
    const bytes = response ? (await response.blob()).size : Number(entry.fileSize) || 0;
    totalBytes += bytes;
    const row = mobileElement('div', 'mobile-offline-row');
    row.appendChild(mobileBookCard(entry, 'list'));
    row.appendChild(mobileElement('small', 'mobile-offline-size', `${(bytes / 1048576).toFixed(1)} MB`));
    row.appendChild(mobileButton('Remove', async () => {
      try { await removeOfflineBook(entry.id); mobilePinnedIds.delete(entry.id); renderMobileShell(); }
      catch (error) { showToast(error.message || 'Could not remove download.'); }
    }, 'mobile-offline-remove'));
    list.appendChild(row);
  }
  if (version === mobileRenderVersion && books.length) usage.textContent = `${books.length} downloaded · ${(totalBytes / 1048576).toFixed(1)} MB stored`;
}

async function mobileNotebook(root, version) {
  const bookId = mobileRoute.value;
  root.appendChild(mobileHeading(bookId ? 'Highlights & notes' : 'Notebook', '', true));
  const search = mobileElement('input', 'mobile-search-input');
  search.type = 'search'; search.placeholder = 'Search highlights and notes'; search.setAttribute('aria-label', 'Search highlights and notes');
  search.value = mobileNotebookQuery; root.appendChild(search);
  const tags = mobileElement('div', 'mobile-note-tags'); root.appendChild(tags);
  const list = mobileElement('div', 'mobile-notebook-list'); root.appendChild(list);
  list.appendChild(mobileElement('p', 'mobile-empty', 'Loading highlights…'));
  try {
    const highlights = (await api.getAllHighlights()).filter(item => !bookId || item.book_id === bookId);
    if (version !== mobileRenderVersion) return;
    const render = () => {
      tags.replaceChildren();
      const allTags = [...new Set(highlights.flatMap(item => item.tags || []))].sort();
      for (const tag of allTags) {
        const button = mobileButton(`#${tag}`, () => { mobileNotebookTag = mobileNotebookTag === tag ? '' : tag; render(); }, 'mobile-pill');
        button.setAttribute('aria-pressed', String(mobileNotebookTag === tag)); tags.appendChild(button);
      }
      list.replaceChildren();
      const needle = mobileNotebookQuery.trim().toLocaleLowerCase();
      const filtered = highlights.filter(item => (!mobileNotebookTag || (item.tags || []).includes(mobileNotebookTag)) && (!needle || `${item.excerpt || ''} ${item.note || ''} ${item.book_title || ''} ${(item.tags || []).join(' ')}`.toLocaleLowerCase().includes(needle)));
      if (!filtered.length) list.appendChild(mobileElement('p', 'mobile-empty', highlights.length ? 'No matching highlights.' : 'No highlights or notes yet.'));
      filtered.forEach(item => {
        const card = mobileElement('article', 'mobile-note');
        const open = mobileButton('', async () => {
          await openBook(item.book_id);
          if (item.cfi && currentBookId === item.book_id) navigateReader(item.cfi);
        }, 'mobile-note-open');
        open.setAttribute('aria-label', `Open highlight in ${item.book_title || 'book'}`);
        open.appendChild(mobileElement('small', '', item.book_title || 'Book'));
        open.appendChild(mobileElement('blockquote', '', item.excerpt || ''));
        if (item.note) open.appendChild(mobileElement('p', '', item.note));
        card.appendChild(open);
        const edit = mobileButton('Edit tags', async () => {
          const value = prompt('Comma-separated tags', (item.tags || []).join(', '));
          if (value == null) return;
          try { const updated = await api.updateHighlight(item.id, { tags: value.split(',') }); item.tags = updated.tags || []; render(); }
          catch (error) { showToast(error.message || 'Could not save tags.'); }
        }, 'mobile-note-edit');
        card.appendChild(edit); list.appendChild(card);
      });
    };
    search.addEventListener('input', () => { mobileNotebookQuery = search.value; render(); });
    render();
  } catch (_) { list.textContent = 'Notebook is unavailable right now.'; }
}

async function mobileStats(root, version) {
  root.appendChild(mobileHeading('Reading stats', '', true));
  const content = mobileElement('div', 'mobile-stats'); root.appendChild(content);
  content.textContent = 'Loading statistics…';
  try {
    const stats = await api.getStats();
    if (version !== mobileRenderVersion) return;
    content.replaceChildren();
    for (const [value, label] of [[stats.reading_streak_days, 'Day streak'], [stats.books_finished, 'Books finished'], [formatMinutes(Math.round(stats.time_read_this_week / 60)) || '0 min', 'Last 7 days'], [formatMinutes(Math.round(stats.time_read_total / 60)) || '0 min', 'Total reading']]) {
      const card = mobileElement('div', 'mobile-stat'); card.appendChild(mobileElement('strong', '', String(value))); card.appendChild(mobileElement('small', '', label)); content.appendChild(card);
    }
    const details = mobileElement('section', 'mobile-stats-detail'); root.appendChild(details);
    details.appendChild(mobileElement('h2', '', 'Last 14 days'));
    const days = Array.isArray(stats.daily) ? stats.daily : [];
    const maxSeconds = Math.max(60, ...days.map(day => day.seconds || 0));
    const chart = mobileElement('div', 'mobile-stats-chart'); chart.setAttribute('aria-label', 'Reading minutes over the last 14 days');
    for (const day of days) {
      const bar = mobileElement('div', 'mobile-stats-bar');
      bar.style.height = `${Math.max(2, Math.round((day.seconds || 0) / maxSeconds * 100))}%`;
      bar.title = `${Math.round((day.seconds || 0) / 60)} minutes on ${day.date}`;
      chart.appendChild(bar);
    }
    details.appendChild(chart);
    const trend = stats.previous_7_days > 0 ? Math.round((stats.time_read_this_week - stats.previous_7_days) / stats.previous_7_days * 100) : null;
    details.appendChild(mobileElement('p', 'mobile-detail-meta', `Longest streak: ${stats.longest_streak_days || 0} days · Average session: ${Math.round((stats.average_session_seconds || 0) / 60)} min${trend == null ? '' : ` · ${trend >= 0 ? '+' : ''}${trend}% vs previous 7 days`}`));
    if (stats.monthly?.length) {
      details.appendChild(mobileElement('h2', '', 'Recent months'));
      details.appendChild(mobileElement('p', 'mobile-detail-meta', stats.monthly.slice(-6).map(month => `${month.month}: ${formatMinutes(Math.round(month.seconds / 60)) || '0 min'}`).join(' · ')));
    }
    if (stats.most_read?.length) {
      details.appendChild(mobileElement('h2', '', 'Most read'));
      for (const item of stats.most_read) details.appendChild(mobileElement('p', 'mobile-detail-meta', `${item.title} · ${formatMinutes(Math.round(item.seconds / 60))}`));
    }
    details.appendChild(mobileButton('View reading goals', () => mobileNavigate('goals'), 'mobile-wide-action'));
  } catch (_) { content.textContent = 'Statistics are unavailable right now.'; }
}

async function mobileGoals(root, version) {
  root.appendChild(mobileHeading('Reading goals', '', true));
  const form = mobileElement('form', 'mobile-goals');
  const fields = [['dailyMinutes', 'Daily minutes', 1440, 5], ['weeklyHours', 'Weekly hours', 168, 0.5], ['booksPerYear', 'Books per year', 1000, 1]];
  const inputs = {};
  for (const [key, label, max, step] of fields) {
    const wrapper = mobileElement('label', 'mobile-select-label', label);
    const input = mobileElement('input'); input.type = 'number'; input.min = '0'; input.max = String(max); input.step = String(step);
    wrapper.appendChild(input); form.appendChild(wrapper); inputs[key] = input;
  }
  const save = mobileButton('Save goals', async () => {
    const goals = Object.fromEntries(fields.map(([key]) => [key, Number(inputs[key].value) || 0]));
    try { await api.saveSettings({ 'reading-goals': goals }); showToast('Reading goals saved.'); }
    catch (error) { showToast(error.message || 'Could not save goals.'); }
  }, 'mobile-wide-action');
  form.appendChild(save); root.appendChild(form);
  try {
    const preferences = await api.getSettings();
    if (version !== mobileRenderVersion) return;
    const goals = preferences['reading-goals'] || {};
    for (const [key] of fields) inputs[key].value = goals[key] || '';
  } catch (_) { showToast('Could not load goals.'); }
}

function mobilePreferences(root) {
  root.appendChild(mobileHeading('Appearance & reader defaults', '', true));
  root.appendChild(mobileButton(document.documentElement.classList.contains('dark-shell') ? 'Use light app appearance' : 'Use dark app appearance', () => { toggleShellTheme(); renderMobileShell(); }, 'mobile-secondary-action'));
  const fields = [
    ['Reading theme', Object.keys(THEMES), settings.theme, value => setReadingTheme(value)],
    ['Layout', ['paginated', 'scrolled'], settings.layout, value => setLayout(value)],
    ['Typeface', FONTS.map(font => font.name), settings.font, value => { settings.font = value; applyTheme(); }],
  ];
  for (const [label, options, current, change] of fields) {
    const wrapper = mobileElement('label', 'mobile-select-label', label);
    const select = mobileElement('select');
    for (const value of options) select.appendChild(new Option(value, value, false, value === current));
    select.addEventListener('change', () => change(select.value));
    wrapper.appendChild(select); root.appendChild(wrapper);
  }
  const size = mobileElement('label', 'mobile-select-label', `Font size: ${settings.fontSize}%`);
  const slider = mobileElement('input'); slider.type = 'range'; slider.min = '70'; slider.max = '220'; slider.step = '10'; slider.value = String(settings.fontSize);
  slider.addEventListener('input', () => { settings.fontSize = Number(slider.value); size.firstChild.textContent = `Font size: ${settings.fontSize}%`; applyTheme(); });
  size.appendChild(slider); root.appendChild(size);
}

function renderMobileShell() {
  const shell = document.getElementById('mobile-shell');
  const root = document.getElementById('mobile-content');
  if (!shell || !root || !isMobileShell() || !currentUser) return;
  const version = ++mobileRenderVersion;
  root.replaceChildren();
  const { page, value } = mobileRoute;
  if (page === 'home') mobileHome(root);
  else if (page === 'library') mobileLibrary(root);
  else if (page === 'search') mobileSearch(root);
  else if (page === 'more') mobileMore(root);
  else if (page === 'series') mobileSeries(root, value);
  else if (page === 'book') mobileBookDetail(root, value);
  else if (page === 'offline') mobileOffline(root, version);
  else if (page === 'notebook') mobileNotebook(root, version);
  else if (page === 'stats') mobileStats(root, version);
  else if (page === 'goals') mobileGoals(root, version);
  else if (page === 'preferences') mobilePreferences(root);
  document.querySelectorAll('[data-mobile-tab]').forEach(tab => {
    const active = tab.dataset.mobileTab === page;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-current', active ? 'page' : 'false');
  });
}

document.querySelectorAll('[data-mobile-tab]').forEach(tab => tab.addEventListener('click', () => mobileNavigate(tab.dataset.mobileTab)));
function closeMobileReaderTools() {
  const menu = document.getElementById('mobile-reader-tools-menu');
  if (menu) menu.hidden = true;
  document.getElementById('mobile-reader-tools-button')?.setAttribute('aria-expanded', 'false');
}
window.closeMobileReaderTools = closeMobileReaderTools;
document.getElementById('mobile-reader-tools-button')?.addEventListener('click', () => {
  const menu = document.getElementById('mobile-reader-tools-menu');
  menu.hidden = !menu.hidden;
  document.getElementById('mobile-reader-tools-button').setAttribute('aria-expanded', String(!menu.hidden));
});
document.querySelectorAll('[data-reader-tool]').forEach(button => button.addEventListener('click', () => {
  const tool = button.dataset.readerTool;
  closeMobileReaderTools();
  if (['toc', 'search', 'settings', 'bookmarks'].includes(tool)) toggleDrawer(tool);
  else if (tool === 'bookmark') toggleBookmark();
  else if (tool === 'tts') document.getElementById('tts-btn')?.click();
  else if (tool === 'fullscreen') toggleFullscreen();
  else if (tool === 'share') {
    const entry = getCurrentEntry();
    if (!entry) return;
    const data = { title: entry.name, text: `${entry.name}${entry.author ? ` by ${entry.author}` : ''}`, url: location.origin };
    if (navigator.share) navigator.share(data).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(data.text).then(() => showToast('Book details copied.')).catch(() => showToast(data.text));
    else showToast(data.text);
  }
}));
window.renderMobileShell = renderMobileShell;
window.mobileNavigate = mobileNavigate;
renderMobileShell();
