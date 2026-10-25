'use strict';

const express = require('express');
const pinoHttp = require('pino-http');
const logger = require('./lib/logger');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { BOOK_TEXT_LIMITS, isUuid, isBookFilename, isCoverFilename, isHexColor, userTags } = require('./lib/validation');

// Initialize database (runs schema migration on require)
const db = require('./db');

// ---------- Startup: clean stale tmp files ----------
const { DATA_DIR, PUBLIC_DIR } = require('./lib/paths');
const { writeLibraryArchive, writeFullBackup } = require('./lib/libraryArchive');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
try {
  const ONE_HOUR = 60 * 60 * 1000;
  const now = Date.now();
  for (const file of fs.readdirSync(TMP_DIR)) {
    const filePath = path.join(TMP_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && now - stat.mtimeMs > ONE_HOUR) {
        fs.unlinkSync(filePath);
      }
    } catch (e) { /* skip */ }
  }
} catch (e) { /* tmp dir may not exist yet */ }

// Middleware
const { authMiddleware } = require('./middleware/auth');
const { requireAdmin } = require('./routes/users');

// Routes
const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');
const opdsRoutes = require('./routes/opds');
const booksRoutes = require('./routes/books');
const bookmarksRoutes = require('./routes/bookmarks');
const highlightsRoutes = require('./routes/highlights');
const sessionsRoutes = require('./routes/sessions');
const collectionsRoutes = require('./routes/collections');
const settingsRoutes = require('./routes/settings');
const usersRoutes = require('./routes/users');

const app = express();
const trustProxyVal = process.env.TRUST_PROXY;
if (trustProxyVal !== undefined) {
  app.set('trust proxy', isNaN(Number(trustProxyVal)) ? (trustProxyVal === 'true' ? true : (trustProxyVal === 'false' ? false : trustProxyVal)) : Number(trustProxyVal));
} else {
  // Trust forwarding headers only from a proxy on this machine (Caddy or nginx
  // in front of PM2). A direct client can never connect from loopback, so it
  // cannot spoof its IP, while login rate limits still see real client IPs.
  app.set('trust proxy', 'loopback');
}
const PORT = process.env.PORT || 3001;
const MAX_IMPORT_BYTES = Math.min(Math.max(Number(process.env.IMPORT_MAX_BYTES) || 500 * 1024 * 1024, 1), 2 * 1024 * 1024 * 1024);
const MAX_IMPORT_ENTRIES = 5000;

app.disable('x-powered-by');

// ---------- Middleware ----------
app.use(express.json({ limit: '10mb' }));
// Express 5 leaves req.body undefined when a request has no JSON body; routes
// read fields from it directly, so give them an empty object instead.
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
app.use(cookieParser());

// Request logging
app.use(pinoHttp({ 
  logger, 
  autoLogging: { ignore: req => req.url.startsWith('/healthz') } 
}));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://api.dictionaryapi.dev; media-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Useful for container orchestrators and intentionally unauthenticated so a
// reverse proxy can tell a sleeping process from a logged-out user.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Prometheus metrics, only when METRICS_TOKEN is set (see src/lib/metrics.js).
const { countRequests, metricsHandler } = require('./lib/metrics');
app.use(countRequests);
app.get('/metrics', metricsHandler);

// Auth middleware on all /api/* routes (auth route handler skips /api/login internally)
// OPDS feeds for reading apps use their own HTTP Basic app-key auth.
app.use(opdsRoutes);

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', authMiddleware);
// Record successful admin and account changes (see src/lib/auditLog.js).
const { auditMiddleware, listAudit, pruneAudit } = require('./lib/auditLog');
app.use('/api', auditMiddleware);


// Deduplicate replayed offline writes after an uncertain network outcome.
// The frontend sends a stable UUID for every queued mutation.
app.use('/api', (req, res, next) => {
  if (!req.user_id || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const operationId = req.get('Idempotency-Key');
  if (!operationId) return next();
  if (!isUuid(operationId)) return res.status(400).json({ error: 'Invalid Idempotency-Key' });
  const existing = db.prepare('SELECT response_json FROM client_operations WHERE user_id = ? AND operation_id = ?').get(req.user_id, operationId);
  if (existing) return res.json(existing.response_json ? JSON.parse(existing.response_json) : { ok: true, replayed: true });
  const originalJson = res.json.bind(res);
  res.json = payload => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        db.prepare('INSERT OR IGNORE INTO client_operations (user_id, operation_id, response_json) VALUES (?, ?, ?)')
          .run(req.user_id, operationId, JSON.stringify(payload == null ? { ok: true } : payload));
      } catch (error) {
        logger.warn({ err: error }, 'Could not persist idempotency receipt');
      }
    }
    return originalJson(payload);
  };
  next();
});

// ---------- API Routes ----------
app.use(authRoutes);
app.use(accountRoutes);
app.use(booksRoutes);
app.use(bookmarksRoutes);
app.use(highlightsRoutes);
app.use(sessionsRoutes);
app.use(collectionsRoutes);
app.use(settingsRoutes);
app.use(usersRoutes);

// ---------- Export / Import endpoints ----------

function importError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function assertArray(value, name) {
  if (value !== undefined && !Array.isArray(value)) throw importError(`${name} must be an array`);
  return value || [];
}

const SETTING_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const SENSITIVE_SETTING_KEYS = new Set(['passphrase_hash', 'session_token']);
const HIGHLIGHT_COLORS = new Set(['gold', '#F2D94E', '#8FD19E', '#8FC1E3', '#E8A0BF']);
const READING_STATUSES = new Set(['unread', 'reading', 'finished']);

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw importError(`Invalid ${name} in backup`);
  }
  return value;
}

function backupText(value, name, { required = false, max = 10000 } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || value.length > max) {
    throw importError(`Invalid ${name} in backup`);
  }
  const normalized = value.trim();
  if (required && !normalized) throw importError(`Invalid ${name} in backup`);
  return normalized || null;
}

// Book metadata the app itself may have stored unbounded (older uploads) is
// truncated rather than rejected, so one long blurb cannot block a restore.
function backupMetadataText(value, name, field, adjustments, { required = false } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string') throw importError(`Invalid ${name} in backup`);
  const normalized = value.trim();
  if (required && !normalized) throw importError(`Invalid ${name} in backup`);
  const max = BOOK_TEXT_LIMITS[field];
  if (normalized.length <= max) return normalized || null;
  adjustments.push(`Shortened ${name} to ${max} characters`);
  return normalized.slice(0, max).trim() || null;
}

function backupNumber(value, name, {
  required = false,
  min = -Infinity,
  max = Infinity,
  integer = false,
  fallback = null,
} = {}) {
  if (value == null) {
    if (required) throw importError(`Invalid ${name} in backup`);
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw importError(`Invalid ${name} in backup`);
  }
  return value;
}

function backupTimestamp(value, name, { required = false, fallback = null } = {}) {
  const timestamp = backupText(value, name, { required, max: 64 });
  if (timestamp == null) return fallback;
  if (Number.isNaN(Date.parse(timestamp))) throw importError(`Invalid ${name} in backup`);
  return new Date(timestamp).toISOString();
}

function optionalUserId(value, name) {
  if (value == null) return null;
  if (!isUuid(value)) throw importError(`Invalid ${name} in backup`);
  return value;
}

function assertUnique(values, key, name) {
  const seen = new Set();
  for (const value of values) {
    const item = key(value);
    if (seen.has(item)) throw importError(`Duplicate ${name} in backup`);
    seen.add(item);
  }
}

function normalizeBackupUser(value) {
  assertObject(value, 'user');
  if (!isUuid(value.id)) throw importError('Invalid user in backup');
  return { id: value.id, username: backupText(value.username, 'username', { required: true, max: 255 }) };
}

function normalizeBackupBook(value, adjustments) {
  assertObject(value, 'book');
  if (!isUuid(value.id) || !isBookFilename(value.filename)) throw importError('Invalid book in backup');
  const fileFormat = backupText(value.file_format, 'book format', { max: 16 }) || 'epub';
  if (fileFormat.toLowerCase() !== 'epub') throw importError('Invalid book format in backup');
  if (value.cover_path != null && !isCoverFilename(value.cover_path)) throw importError('Invalid book cover in backup');

  return {
    id: value.id,
    title: backupMetadataText(value.title, 'book title', 'title', adjustments, { required: true }),
    author: backupMetadataText(value.author, 'book author', 'author', adjustments),
    series: backupMetadataText(value.series, 'book series', 'series', adjustments),
    series_index: backupNumber(value.series_index, 'book series index', { min: -1_000_000, max: 1_000_000 }),
    description: backupMetadataText(value.description, 'book description', 'description', adjustments),
    isbn: backupMetadataText(value.isbn, 'book ISBN', 'isbn', adjustments),
    tags: backupMetadataText(value.tags, 'book tags', 'tags', adjustments),
    filename: value.filename,
    file_format: 'epub',
    file_size: backupNumber(value.file_size, 'book file size', { min: 0, max: MAX_IMPORT_BYTES, integer: true }),
    cover_path: value.cover_path || null,
    cover_color: normalizeCoverColor(value.cover_color, adjustments),
    added_at: backupTimestamp(value.added_at, 'book added time', { fallback: new Date().toISOString() }),
  };
}

function normalizeCoverColor(value, adjustments) {
  if (value == null || isHexColor(value)) return value ?? null;
  adjustments.push('Reset an invalid book cover color');
  return null;
}

// Older builds accepted fractional ratings; round them rather than reject the backup.
function normalizeRating(value, adjustments) {
  const rating = backupNumber(value, 'book rating', { min: 1, max: 5 });
  if (rating == null || Number.isInteger(rating)) return rating;
  adjustments.push(`Rounded a ${rating}-star rating to ${Math.round(rating)}`);
  return Math.round(rating);
}

function normalizeBackupUserTags(value, adjustments) {
  if (value == null || value === '') return null;
  try { return userTags(typeof value === 'string' && value.startsWith('[') ? JSON.parse(value) : value); }
  catch (_) { adjustments.push('Dropped invalid personal tags'); return null; }
}

function normalizeUserBook(value, adjustments) {
  assertObject(value, 'user_book');
  if (!isUuid(value.book_id)) throw importError('Invalid user_book in backup');
  const status = backupText(value.status, 'book status', { max: 16 }) || 'unread';
  if (!READING_STATUSES.has(status)) throw importError('Invalid book status in backup');
  return {
    user_id: optionalUserId(value.user_id, 'user_book user'),
    book_id: value.book_id,
    status,
    rating: normalizeRating(value.rating, adjustments),
    progress_percent: backupNumber(value.progress_percent, 'book progress', { min: 0, max: 100, fallback: 0 }),
    want_to_read: value.want_to_read ? 1 : 0,
    user_tags: normalizeBackupUserTags(value.user_tags, adjustments),
    last_location_cfi: backupText(value.last_location_cfi, 'book location', { max: 10000 }),
    last_opened_at: backupTimestamp(value.last_opened_at, 'book last-opened time'),
  };
}

function normalizeBookmark(value) {
  assertObject(value, 'bookmark');
  if (!isUuid(value.id) || !isUuid(value.book_id)) throw importError('Invalid bookmark in backup');
  return {
    id: value.id,
    user_id: optionalUserId(value.user_id, 'bookmark user'),
    book_id: value.book_id,
    cfi: backupText(value.cfi, 'bookmark CFI', { required: true, max: 10000 }),
    label: backupText(value.label, 'bookmark label', { max: 500 }),
    note: backupText(value.note, 'bookmark note', { max: 2000 }),
    chapter: backupText(value.chapter, 'bookmark chapter', { max: 500 }),
    progress_percent: backupNumber(value.progress_percent, 'bookmark progress', { min: 0, max: 100, fallback: 0 }),
    created_at: backupTimestamp(value.created_at, 'bookmark created time', { fallback: new Date().toISOString() }),
  };
}

function normalizeHighlight(value) {
  assertObject(value, 'highlight');
  if (!isUuid(value.id) || !isUuid(value.book_id)) throw importError('Invalid highlight in backup');
  const color = backupText(value.color, 'highlight color', { max: 16 }) || 'gold';
  if (!HIGHLIGHT_COLORS.has(color)) throw importError('Invalid highlight color in backup');
  return {
    id: value.id,
    user_id: optionalUserId(value.user_id, 'highlight user'),
    book_id: value.book_id,
    cfi_range: backupText(value.cfi_range, 'highlight CFI', { required: true, max: 10000 }),
    excerpt: backupText(value.excerpt, 'highlight excerpt', { max: 1000 }),
    note: backupText(value.note, 'highlight note', { max: 2000 }),
    color,
    chapter: backupText(value.chapter, 'highlight chapter', { max: 500 }),
    tags: backupText(value.tags, 'highlight tags', { max: 2000 }),
    created_at: backupTimestamp(value.created_at, 'highlight created time', { fallback: new Date().toISOString() }),
  };
}

function normalizeReadingSession(value) {
  assertObject(value, 'reading session');
  if (!isUuid(value.id) || !isUuid(value.book_id)) throw importError('Invalid reading session in backup');
  return {
    id: value.id,
    user_id: optionalUserId(value.user_id, 'reading session user'),
    book_id: value.book_id,
    started_at: backupTimestamp(value.started_at, 'session start time', { required: true }),
    ended_at: backupTimestamp(value.ended_at, 'session end time'),
    duration_seconds: backupNumber(value.duration_seconds, 'session duration', { min: 0, max: 2_147_483_647, integer: true }),
    client_id: backupText(value.client_id, 'session client', { max: 100 }),
  };
}

function normalizeCollection(value) {
  assertObject(value, 'collection');
  if (!isUuid(value.id)) throw importError('Invalid collection in backup');
  return { id: value.id, name: backupText(value.name, 'collection name', { required: true, max: 80 }) };
}

function normalizeBookCollection(value) {
  assertObject(value, 'collection membership');
  if (!isUuid(value.book_id) || !isUuid(value.collection_id)) {
    throw importError('Invalid collection membership in backup');
  }
  return { book_id: value.book_id, collection_id: value.collection_id };
}

function normalizeSetting(value) {
  assertObject(value, 'setting');
  const key = backupText(value.key, 'setting key', { required: true, max: 80 });
  if (!SETTING_KEY_RE.test(key) || typeof value.value !== 'string' || value.value.length > 100_000) {
    throw importError('Invalid setting in backup');
  }
  return { user_id: optionalUserId(value.user_id, 'setting user'), key, value: value.value };
}

function validateBackupDump(dump) {
  if (!dump || typeof dump !== 'object' || Array.isArray(dump)) throw importError('Backup database is invalid');
  const adjustments = [];
  const users = assertArray(dump.users, 'users').map(normalizeBackupUser);
  const userBooks = assertArray(dump.user_books, 'user_books').map(row => normalizeUserBook(row, adjustments));
  const books = assertArray(dump.books, 'books').map(book => normalizeBackupBook(book, adjustments));
  const bookmarks = assertArray(dump.bookmarks, 'bookmarks').map(normalizeBookmark);
  const highlights = assertArray(dump.highlights, 'highlights').map(normalizeHighlight);
  const sessions = assertArray(dump.reading_sessions, 'reading_sessions').map(normalizeReadingSession);
  const collections = assertArray(dump.collections, 'collections').map(normalizeCollection);
  const bookCollections = assertArray(dump.book_collections, 'book_collections').map(normalizeBookCollection);
  const settings = assertArray(dump.settings, 'settings').map(normalizeSetting);

  assertUnique(users, user => user.id, 'user ID');
  assertUnique(users, user => user.username, 'username');
  assertUnique(books, book => book.id, 'book ID');
  assertUnique(books, book => book.filename, 'book filename');
  assertUnique(bookmarks, bookmark => bookmark.id, 'bookmark ID');
  assertUnique(highlights, highlight => highlight.id, 'highlight ID');
  assertUnique(sessions, session => session.id, 'reading session ID');
  assertUnique(collections, collection => collection.id, 'collection ID');
  assertUnique(collections, collection => collection.name.toLowerCase(), 'collection name');
  assertUnique(bookCollections, membership => `${membership.book_id}:${membership.collection_id}`, 'collection membership');
  assertUnique(userBooks, row => `${row.user_id || 'missing'}:${row.book_id}`, 'user book');
  assertUnique(settings, row => `${row.user_id || 'missing'}:${row.key}`, 'setting');

  const bookIds = new Set(books.map(book => book.id));
  const collectionIds = new Set(collections.map(collection => collection.id));
  for (const membership of bookCollections) {
    if (!bookIds.has(membership.book_id) || !collectionIds.has(membership.collection_id)) {
      throw importError('Collection membership references a missing book or collection');
    }
  }

  return { users, userBooks, books, bookmarks, highlights, sessions, collections, bookCollections, settings, adjustments };
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (err) {
    return false;
  }
}

function validateArchiveAssets(files, backup, booksDir, coversDir) {
  const archiveFiles = new Map(files.map(file => [`${file.directory}/${file.filename}`, file]));
  const expectedAssets = new Set();

  for (const book of backup.books) {
    const bookKey = `books/${book.filename}`;
    const archivedBook = archiveFiles.get(bookKey);
    expectedAssets.add(bookKey);
    if (!archivedBook && !isRegularFile(path.join(booksDir, book.filename))) {
      throw importError(`Backup is missing the EPUB for "${book.title}"`);
    }
    if (archivedBook && book.file_size != null && archivedBook.size !== book.file_size) {
      throw importError(`Backup EPUB size does not match metadata for "${book.title}"`);
    }

    if (book.cover_path) {
      const coverKey = `covers/${book.cover_path}`;
      expectedAssets.add(coverKey);
      if (!archiveFiles.has(coverKey) && !isRegularFile(path.join(coversDir, book.cover_path))) {
        throw importError(`Backup is missing the cover for "${book.title}"`);
      }
    }
  }

  for (const file of files) {
    if (!expectedAssets.has(`${file.directory}/${file.filename}`)) {
      throw importError('Backup contains an unreferenced library asset');
    }
  }
}

function createUserIdMap(backupUsers) {
  // Only match identities that already exist locally. Import never inserts a
  // user or accepts a password hash/admin flag from a backup.
  const localUsers = new Map(
    db.prepare('SELECT id, username FROM users').all().map(user => [user.username, user.id])
  );
  const userIds = new Map();
  let unmatchedUsers = 0;
  for (const user of backupUsers) {
    const localUserId = localUsers.get(user.username);
    if (localUserId) userIds.set(user.id, localUserId);
    else unmatchedUsers++;
  }
  return { userIds, unmatchedUsers };
}

function importBackupData(backup, backupUserIds, unmatchedUsers) {
  const insertBook = db.prepare(`
    INSERT INTO books (id, title, author, series, series_index, description, isbn, tags, filename, file_format,
                       file_size, cover_path, cover_color, added_at)
    VALUES (@id, @title, @author, @series, @series_index, @description, @isbn, @tags, @filename, @file_format,
            @file_size, @cover_path, @cover_color, @added_at)
  `);
  const getBookById = db.prepare('SELECT id, filename FROM books WHERE id = ?');
  const getBookByFilename = db.prepare('SELECT id FROM books WHERE filename = ?');
  const insertCollection = db.prepare('INSERT INTO collections (id, name) VALUES (?, ?)');
  const getCollectionById = db.prepare('SELECT id, name FROM collections WHERE id = ?');
  const getCollectionByName = db.prepare('SELECT id, name FROM collections WHERE lower(name) = lower(?)');
  const insertBookCollection = db.prepare(`
    INSERT OR IGNORE INTO book_collections (book_id, collection_id) VALUES (?, ?)
  `);
  const listBookIds = db.prepare('SELECT id FROM books');
  const insertUserBook = db.prepare(`
    INSERT INTO user_books (user_id, book_id, status, rating, progress_percent, last_location_cfi, last_opened_at, want_to_read, user_tags)
    VALUES (@user_id, @book_id, @status, @rating, @progress_percent, @last_location_cfi, @last_opened_at, @want_to_read, @user_tags)
    ON CONFLICT(user_id, book_id) DO UPDATE SET
      status = excluded.status,
      want_to_read = excluded.want_to_read,
      user_tags = excluded.user_tags,
      rating = excluded.rating,
      progress_percent = excluded.progress_percent,
      last_location_cfi = excluded.last_location_cfi,
      last_opened_at = excluded.last_opened_at
    WHERE excluded.last_opened_at > user_books.last_opened_at OR user_books.last_opened_at IS NULL
  `);
  const insertBookmark = db.prepare(`
    INSERT OR IGNORE INTO bookmarks (id, user_id, book_id, cfi, label, note, chapter, progress_percent, created_at)
    VALUES (@id, @user_id, @book_id, @cfi, @label, @note, @chapter, @progress_percent, @created_at)
  `);
  const insertHighlight = db.prepare(`
    INSERT OR IGNORE INTO highlights (id, user_id, book_id, cfi_range, excerpt, note, color, chapter, tags, created_at)
    VALUES (@id, @user_id, @book_id, @cfi_range, @excerpt, @note, @color, @chapter, @tags, @created_at)
  `);
  const insertReadingSession = db.prepare(`
    INSERT OR IGNORE INTO reading_sessions (id, user_id, book_id, started_at, ended_at, duration_seconds, client_id)
    VALUES (@id, @user_id, @book_id, @started_at, @ended_at, @duration_seconds, @client_id)
  `);
  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (@user_id, @key, @value)
  `);

  return db.transaction(() => {
    const imported = {
      books: 0,
      collections: 0,
      book_collections: 0,
      user_books: 0,
      bookmarks: 0,
      highlights: 0,
      reading_sessions: 0,
      settings: 0,
    };
    const skipped = {
      users: unmatchedUsers,
      user_books: 0,
      bookmarks: 0,
      highlights: 0,
      reading_sessions: 0,
      settings: 0,
    };

    for (const book of backup.books) {
      const existingById = getBookById.get(book.id);
      const existingByFilename = getBookByFilename.get(book.filename);
      if (existingById && existingById.filename !== book.filename) {
        throw importError('Backup book ID conflicts with an existing library book');
      }
      if (existingByFilename && existingByFilename.id !== book.id) {
        throw importError('Backup book file conflicts with an existing library book');
      }
      if (!existingById) imported.books += insertBook.run(book).changes;
    }

    const collectionIds = new Map();
    for (const collection of backup.collections) {
      const existingById = getCollectionById.get(collection.id);
      const existingByName = getCollectionByName.get(collection.name);
      if (existingById && existingById.name.toLowerCase() !== collection.name.toLowerCase()) {
        throw importError('Backup collection ID conflicts with an existing collection');
      }
      if (existingById && existingByName && existingById.id !== existingByName.id) {
        throw importError('Backup collection conflicts with existing collection identities');
      }
      if (existingById) {
        collectionIds.set(collection.id, existingById.id);
      } else if (existingByName) {
        collectionIds.set(collection.id, existingByName.id);
      } else {
        imported.collections += insertCollection.run(collection.id, collection.name).changes;
        collectionIds.set(collection.id, collection.id);
      }
    }

    for (const membership of backup.bookCollections) {
      imported.book_collections += insertBookCollection.run(
        membership.book_id,
        collectionIds.get(membership.collection_id)
      ).changes;
    }

    const localBookIds = new Set(listBookIds.all().map(book => book.id));
    const mappedPrivateRow = (row, section, requiresBook = true) => {
      const localUserId = row.user_id && backupUserIds.get(row.user_id);
      if (!localUserId || (requiresBook && !localBookIds.has(row.book_id))) {
        skipped[section]++;
        return null;
      }
      return { ...row, user_id: localUserId };
    };

    for (const row of backup.userBooks) {
      const mapped = mappedPrivateRow(row, 'user_books');
      if (mapped) imported.user_books += insertUserBook.run(mapped).changes;
    }
    for (const row of backup.bookmarks) {
      const mapped = mappedPrivateRow(row, 'bookmarks');
      if (mapped) imported.bookmarks += insertBookmark.run(mapped).changes;
    }
    for (const row of backup.highlights) {
      const mapped = mappedPrivateRow(row, 'highlights');
      if (mapped) imported.highlights += insertHighlight.run(mapped).changes;
    }
    for (const row of backup.sessions) {
      const mapped = mappedPrivateRow(row, 'reading_sessions');
      if (mapped) imported.reading_sessions += insertReadingSession.run(mapped).changes;
    }
    for (const row of backup.settings) {
      if (SENSITIVE_SETTING_KEYS.has(row.key)) {
        skipped.settings++;
        continue;
      }
      const mapped = mappedPrivateRow(row, 'settings', false);
      if (mapped) imported.settings += insertSetting.run(mapped).changes;
    }

    return { imported, skipped };
  })();
}

/**
 * POST /api/export (POST only: it is a privileged action, even though SameSite=Strict already blocks cross-site use)
 * Streams a zip of the shared library plus user data. User records intentionally contain
 * identities only, so passphrase hashes, roles, and auth sessions never leave
 * this server.
 */
/**
 * GET /api/admin/audit?limit=&before= — the audit log, newest first (admins only).
 */
app.get('/api/admin/audit', requireAdmin, (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '100'), 10) || 100));
  const before = parseInt(String(req.query.before || ''), 10) || null;
  res.json({ entries: listAudit({ limit, before }) });
});
setInterval(() => { try { pruneAudit(); } catch (_) {} }, 24 * 60 * 60 * 1000).unref();

app.post('/api/export', requireAdmin, (req, res) => {
  let started;
  try {
    const filename = `endpaper-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    started = writeLibraryArchive(res);
    started.done.catch(err => {
      logger.error({ err }, 'Export archive error');
      if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
      else res.destroy(err);
    });
  } catch (err) {
    logger.error({ err }, 'Export error');
    res.removeHeader('Content-Disposition');
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.status ? err.message : 'Export failed' });
    else res.destroy(err);
  }
});

/**
 * POST /api/import
 * Accepts a zip file (from /api/export) and restores the shared library. User
 * state is restored only for matching, pre-existing local usernames.
 */
const multer = require('multer');
const yauzl = require('yauzl');
const importUpload = multer({
  dest: path.join(DATA_DIR, 'tmp'),
  limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 5 },
  fileFilter: (req, file, callback) => {
    if (!file.originalname.toLowerCase().endsWith('.zip')) return callback(importError('Only .zip backup files are allowed'));
    callback(null, true);
  },
});

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = new Map();
      let totalBytes = 0;
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch (_) {}
        reject(error);
      };
      zipfile.on('entry', entry => {
        totalBytes += entry.uncompressedSize || 0;
        if (entries.size + 1 > MAX_IMPORT_ENTRIES) return fail(importError('Backup contains too many files'));
        if (totalBytes > MAX_IMPORT_BYTES) return fail(importError('Backup is too large to import'));
        const ratio = (entry.uncompressedSize || 0) / Math.max(1, entry.compressedSize || 0);
        if (ratio > 200) return fail(importError('Backup contains an unsafe compressed entry'));
        entries.set(entry.fileName, entry);
        zipfile.readEntry();
      });
      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ zipfile, entries });
      });
      zipfile.on('error', fail);
      zipfile.readEntry();
    });
  });
}

function readEntry(zipfile, entry, maxBytes) {
  return new Promise((resolve, reject) => {
    if (entry.uncompressedSize > maxBytes) return reject(new Error('Entry too large'));
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err) return reject(err);
      const chunks = [];
      readStream.on('data', chunk => chunks.push(chunk));
      readStream.on('error', reject);
      readStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function streamEntryToFile(zipfile, entry, destination, maxBytes) {
  return new Promise((resolve, reject) => {
    if (entry.uncompressedSize > maxBytes) return reject(importError('Backup entry is too large'));
    zipfile.openReadStream(entry, (error, readStream) => {
      if (error) return reject(error);
      let observed = 0;
      const writeStream = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
      const fail = failure => {
        readStream.destroy();
        writeStream.destroy();
        fs.promises.unlink(destination).catch(() => {}).finally(() => reject(failure));
      };
      readStream.on('data', chunk => {
        observed += chunk.length;
        if (observed > maxBytes || observed > entry.uncompressedSize + 1024) fail(importError('Backup entry exceeded its declared size'));
      });
      readStream.on('error', fail);
      writeStream.on('error', fail);
      writeStream.on('finish', resolve);
      readStream.pipe(writeStream);
    });
  });
}

app.post('/api/import', requireAdmin, importUpload.single('file'), async (req, res) => {
  let zipfile = null;
  let stageDir = null;
  const promotedFiles = [];
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const BOOKS_DIR = path.join(DATA_DIR, 'books');
    const COVERS_DIR = path.join(DATA_DIR, 'covers');
    
    const zipData = await openZip(req.file.path);
    zipfile = zipData.zipfile;
    const entries = zipData.entries;
    
    if (entries.size > MAX_IMPORT_ENTRIES) throw importError('Backup contains too many files');
    
    const dbEntry = entries.get('database.json');
    if (!dbEntry) throw importError('Backup is missing database.json');
    
    const dbData = await readEntry(zipfile, dbEntry, 10 * 1024 * 1024);
    let dump;
    try {
      dump = validateBackupDump(JSON.parse(dbData.toString('utf8')));
    } catch (err) {
      if (err.status) throw err;
      throw importError('Backup database is not valid JSON');
    }

    // Prepare files list
    const files = [];
    let totalSize = 0;
    for (const [name, entry] of entries.entries()) {
      if (entry.fileName === 'database.json' || entry.fileName.endsWith('/')) continue;
      
      const size = entry.uncompressedSize;
      totalSize += size;
      if (totalSize > MAX_IMPORT_BYTES) throw importError('Backup is too large to import');
      
      const bookMatch = /^books\/([0-9a-f-]+\.epub)$/i.exec(entry.fileName);
      const coverMatch = /^covers\/([0-9a-f-]+\.(?:jpe?g|png|gif|webp))$/i.exec(entry.fileName);
      if (bookMatch && isBookFilename(bookMatch[1])) files.push({ entry, directory: 'books', filename: bookMatch[1], size });
      else if (coverMatch && isCoverFilename(coverMatch[1])) files.push({ entry, directory: 'covers', filename: coverMatch[1], size });
      else throw importError('Backup contains an unsupported file');
    }

    validateArchiveAssets(files, dump, BOOKS_DIR, COVERS_DIR);
    const { userIds, unmatchedUsers } = createUserIdMap(dump.users);

    // ?dry_run=1: report what an import would do, change nothing.
    if (req.query.dry_run === '1') {
      const existingBook = db.prepare('SELECT 1 FROM books WHERE id = ? OR filename = ?');
      const existingCollection = db.prepare('SELECT 1 FROM collections WHERE id = ? OR lower(name) = lower(?)');
      const newBooks = dump.books.filter(book => !existingBook.get(book.id, book.filename));
      const preview = {
        dry_run: true,
        exported_at: typeof dump.exportedAt === 'string' ? dump.exportedAt : null,
        books_total: dump.books.length,
        books_new: newBooks.length,
        books_already_here: dump.books.length - newBooks.length,
        new_book_titles: newBooks.slice(0, 20).map(book => book.title),
        collections_new: dump.collections.filter(item => !existingCollection.get(item.id, item.name)).length,
        accounts_matched: dump.users.length - unmatchedUsers,
        accounts_unmatched: unmatchedUsers,
        personal_rows: dump.userBooks.length + dump.bookmarks.length + dump.highlights.length + dump.sessions.length,
        files_in_archive: files.length,
        adjustments: dump.adjustments,
      };
      zipfile.close();
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.json(preview);
    }

    // Extract assets into an isolated stage first. No live library path is
    // modified until every archive entry has streamed and validated.
    stageDir = await fs.promises.mkdtemp(path.join(DATA_DIR, 'tmp', 'import-'));
    let restoredFiles = 0;
    for (const file of files) {
      const destination = path.join(file.directory === 'books' ? BOOKS_DIR : COVERS_DIR, file.filename);
      if (fs.existsSync(destination)) {
        if (!isRegularFile(destination)) throw importError('A local library asset is not a regular file');
        continue;
      }
      const stagedPath = path.join(stageDir, `${file.directory}-${file.filename}`);
      await streamEntryToFile(zipfile, file.entry, stagedPath, MAX_IMPORT_BYTES);
      file.stagedPath = stagedPath;
    }

    // Promote staged files with exclusive renames, then compensate if the DB
    // transaction fails. Existing files are deliberately left untouched.
    for (const file of files) {
      if (!file.stagedPath) continue;
      const destination = path.join(file.directory === 'books' ? BOOKS_DIR : COVERS_DIR, file.filename);
      if (fs.existsSync(destination)) continue;
      await fs.promises.rename(file.stagedPath, destination);
      promotedFiles.push(destination);
      restoredFiles++;
    }

    let results;
    try {
      results = importBackupData(dump, userIds, unmatchedUsers);
    } catch (error) {
      await Promise.all(promotedFiles.map(filePath => fs.promises.unlink(filePath).catch(() => {})));
      throw error;
    }
    
    zipfile.close();
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    if (stageDir && path.resolve(stageDir).startsWith(path.resolve(path.join(DATA_DIR, 'tmp')) + path.sep)) {
      await fs.promises.rm(stageDir, { recursive: true, force: true });
      stageDir = null;
    }

    // Restored books get their text indexed for search in the background.
    require('./lib/searchIndex').backfillMissing().catch(err => logger.error({ err }, 'Search backfill failed'));
    res.json({ ok: true, restored_files: restoredFiles, ...results, adjustments: dump.adjustments });
  } catch (err) {
    if (zipfile) zipfile.close();
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    if (stageDir && path.resolve(stageDir).startsWith(path.resolve(path.join(DATA_DIR, 'tmp')) + path.sep)) {
      await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
    logger.error({ err }, 'Import error');
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Import failed' });
  }
});

// ---------- Static files (frontend) ----------
if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
  logger.error({ publicDir: PUBLIC_DIR }, 'Frontend not found; set ENDPAPER_PUBLIC_DIR to the directory containing index.html');
}
app.use(express.static(PUBLIC_DIR));

// SPA fallback: serve index.html for any non-API route (Express 5 wildcard syntax).
app.get('/{*splat}', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Keep errors from middleware (notably Multer) in the same JSON shape as the
// rest of the API instead of returning Express's default HTML error page.
app.use((err, req, res, next) => {
  logger.error({ err }, 'Request error');
  if (res.headersSent) return next(err);
  const isUploadError = err instanceof multer.MulterError;
  const status = err.status || (isUploadError ? 400 : 500);
  const message = err.message === 'File too large'
    ? 'Uploaded file is too large'
    : (status < 500 ? err.message : 'Internal server error');
  res.status(status).json({ error: message });
});

// ---------- Start ----------
// Optional scheduled full backups: FULL_BACKUP_EVERY_DAYS=1 writes a restorable
// ZIP of the whole library to data/backups/full every day, keeping FULL_BACKUP_KEEP.
{
  const everyDays = Number(process.env.FULL_BACKUP_EVERY_DAYS) || 0;
  const keep = Math.max(1, Number(process.env.FULL_BACKUP_KEEP) || 3);
  if (everyDays > 0) {
    const run = () => writeFullBackup({ keep })
      .then(result => logger.info({ path: result.path, books: result.bookCount, bytes: result.bytes }, 'Full library backup written'))
      .catch(err => logger.error({ err }, 'Full library backup failed'));
    setTimeout(run, 60_000).unref();
    setInterval(run, everyDays * 24 * 60 * 60 * 1000).unref();
  }
}

// Index text of books that predate full-text search, in the background.
setTimeout(() => require('./lib/searchIndex').backfillMissing().catch(err => logger.error({ err }, 'Search backfill failed')), 2000).unref();

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Endpaper server listening on http://0.0.0.0:${PORT}`);
});

// ---------- Graceful shutdown ----------
function gracefulShutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully…`);
  server.close(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      logger.info('Database closed and WAL checkpointed.');
    } catch (e) {
      logger.error({ err: e }, 'Error closing database');
    }
    process.exit(0);
  });
  // Force exit after 10s if connections don't drain
  setTimeout(() => {
    logger.error('Forcing shutdown after timeout.');
    process.exit(1);
  }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
