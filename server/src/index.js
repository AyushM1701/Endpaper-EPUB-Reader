'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { isUuid, isBookFilename, isCoverFilename } = require('./lib/validation');

// Initialize database (runs schema migration on require)
const db = require('./db');

// ---------- Startup: clean stale tmp files ----------
const TMP_DIR = path.resolve(__dirname, '../../data/tmp');
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
const booksRoutes = require('./routes/books');
const bookmarksRoutes = require('./routes/bookmarks');
const highlightsRoutes = require('./routes/highlights');
const sessionsRoutes = require('./routes/sessions');
const collectionsRoutes = require('./routes/collections');
const settingsRoutes = require('./routes/settings');
const usersRoutes = require('./routes/users');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = path.resolve(__dirname, '../../data');
const MAX_IMPORT_BYTES = Math.min(Math.max(Number(process.env.IMPORT_MAX_BYTES) || 500 * 1024 * 1024, 1), 2 * 1024 * 1024 * 1024);
const MAX_IMPORT_ENTRIES = 5000;

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------- Middleware ----------
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (!req.path.startsWith('/healthz')) {
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Useful for container orchestrators and intentionally unauthenticated so a
// reverse proxy can tell a sleeping process from a logged-out user.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Auth middleware on all /api/* routes (auth route handler skips /api/login internally)
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', authMiddleware);

// ---------- API Routes ----------
app.use(authRoutes);
app.use(booksRoutes);
app.use(bookmarksRoutes);
app.use(highlightsRoutes);
app.use(sessionsRoutes);
app.use(collectionsRoutes);
app.use(settingsRoutes);
app.use(usersRoutes);

// ---------- Export / Import endpoints ----------
const AdmZip = require('adm-zip');

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

function normalizeBackupBook(value) {
  assertObject(value, 'book');
  if (!isUuid(value.id) || !isBookFilename(value.filename)) throw importError('Invalid book in backup');
  const fileFormat = backupText(value.file_format, 'book format', { max: 16 }) || 'epub';
  if (fileFormat.toLowerCase() !== 'epub') throw importError('Invalid book format in backup');
  if (value.cover_path != null && !isCoverFilename(value.cover_path)) throw importError('Invalid book cover in backup');

  return {
    id: value.id,
    title: backupText(value.title, 'book title', { required: true, max: 500 }),
    author: backupText(value.author, 'book author', { max: 500 }),
    series: backupText(value.series, 'book series', { max: 500 }),
    series_index: backupNumber(value.series_index, 'book series index', { min: -1_000_000, max: 1_000_000 }),
    filename: value.filename,
    file_format: 'epub',
    file_size: backupNumber(value.file_size, 'book file size', { min: 0, max: MAX_IMPORT_BYTES, integer: true }),
    cover_path: value.cover_path || null,
    cover_color: backupText(value.cover_color, 'book cover color', { max: 32 }),
    added_at: backupTimestamp(value.added_at, 'book added time', { fallback: new Date().toISOString() }),
  };
}

function normalizeUserBook(value) {
  assertObject(value, 'user_book');
  if (!isUuid(value.book_id)) throw importError('Invalid user_book in backup');
  const status = backupText(value.status, 'book status', { max: 16 }) || 'unread';
  if (!READING_STATUSES.has(status)) throw importError('Invalid book status in backup');
  return {
    user_id: optionalUserId(value.user_id, 'user_book user'),
    book_id: value.book_id,
    status,
    rating: backupNumber(value.rating, 'book rating', { min: 1, max: 5, integer: true }),
    progress_percent: backupNumber(value.progress_percent, 'book progress', { min: 0, max: 100, fallback: 0 }),
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
  const users = assertArray(dump.users, 'users').map(normalizeBackupUser);
  const userBooks = assertArray(dump.user_books, 'user_books').map(normalizeUserBook);
  const books = assertArray(dump.books, 'books').map(normalizeBackupBook);
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

  return { users, userBooks, books, bookmarks, highlights, sessions, collections, bookCollections, settings };
}

function safeArchiveFiles(zip) {
  const entries = zip.getEntries();
  if (entries.length > MAX_IMPORT_ENTRIES) throw importError('Backup contains too many files');
  let totalSize = 0;
  const files = [];
  const seenEntryNames = new Set();
  let databaseEntries = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (seenEntryNames.has(entry.entryName)) throw importError('Backup contains duplicate file entries');
    seenEntryNames.add(entry.entryName);
    const size = Number(entry.header && entry.header.size);
    if (!Number.isSafeInteger(size) || size < 0) throw importError('Backup contains an invalid file entry');
    totalSize += size;
    if (totalSize > MAX_IMPORT_BYTES) throw importError('Backup is too large to import');
    if (entry.entryName === 'database.json') {
      databaseEntries++;
      continue;
    }
    const bookMatch = /^books\/([0-9a-f-]+\.epub)$/i.exec(entry.entryName);
    const coverMatch = /^covers\/([0-9a-f-]+\.(?:jpe?g|png|gif|webp))$/i.exec(entry.entryName);
    if (bookMatch && isBookFilename(bookMatch[1])) files.push({ entry, directory: 'books', filename: bookMatch[1], size });
    else if (coverMatch && isCoverFilename(coverMatch[1])) files.push({ entry, directory: 'covers', filename: coverMatch[1], size });
    else throw importError('Backup contains an unsupported file');
  }
  if (databaseEntries !== 1) throw importError('Backup must contain exactly one database.json');
  return files;
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

function restoreArchiveFiles(files, booksDir, coversDir) {
  let restoredFiles = 0;
  for (const file of files) {
    const destination = path.join(file.directory === 'books' ? booksDir : coversDir, file.filename);
    if (fs.existsSync(destination)) {
      if (!isRegularFile(destination)) throw importError('A local library asset is not a regular file');
      continue;
    }
    try {
      fs.writeFileSync(destination, file.entry.getData(), { flag: 'wx' });
      restoredFiles++;
    } catch (err) {
      // A concurrent import may have installed the same immutable UUID asset.
      if (err && err.code === 'EEXIST' && isRegularFile(destination)) continue;
      throw err;
    }
  }
  return restoredFiles;
}

function addLibraryAsset(zip, assetDir, filename, seenAssets) {
  const assetPath = path.join(DATA_DIR, assetDir, filename);
  if (!isRegularFile(assetPath)) {
    throw new Error(`Cannot export: library asset ${assetDir}/${filename} is missing`);
  }
  const assetKey = `${assetDir}/${filename}`;
  if (!seenAssets.has(assetKey)) {
    zip.addLocalFile(assetPath, assetDir);
    seenAssets.add(assetKey);
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
    INSERT INTO books (id, title, author, series, series_index, filename, file_format,
                       file_size, cover_path, cover_color, added_at)
    VALUES (@id, @title, @author, @series, @series_index, @filename, @file_format,
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
    INSERT INTO user_books (user_id, book_id, status, rating, progress_percent, last_location_cfi, last_opened_at)
    VALUES (@user_id, @book_id, @status, @rating, @progress_percent, @last_location_cfi, @last_opened_at)
    ON CONFLICT(user_id, book_id) DO UPDATE SET
      status = excluded.status,
      rating = excluded.rating,
      progress_percent = excluded.progress_percent,
      last_location_cfi = excluded.last_location_cfi,
      last_opened_at = excluded.last_opened_at
    WHERE excluded.last_opened_at > user_books.last_opened_at OR user_books.last_opened_at IS NULL
  `);
  const insertBookmark = db.prepare(`
    INSERT OR IGNORE INTO bookmarks (id, user_id, book_id, cfi, label, chapter, progress_percent, created_at)
    VALUES (@id, @user_id, @book_id, @cfi, @label, @chapter, @progress_percent, @created_at)
  `);
  const insertHighlight = db.prepare(`
    INSERT OR IGNORE INTO highlights (id, user_id, book_id, cfi_range, excerpt, note, color, chapter, created_at)
    VALUES (@id, @user_id, @book_id, @cfi_range, @excerpt, @note, @color, @chapter, @created_at)
  `);
  const insertReadingSession = db.prepare(`
    INSERT OR IGNORE INTO reading_sessions (id, user_id, book_id, started_at, ended_at, duration_seconds)
    VALUES (@id, @user_id, @book_id, @started_at, @ended_at, @duration_seconds)
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
 * POST /api/export
 * Zips the shared library plus user data. User records intentionally contain
 * identities only, so passphrase hashes, roles, and auth sessions never leave
 * this server.
 */
app.post('/api/export', requireAdmin, (req, res) => {
  try {
    const books = db.prepare('SELECT * FROM books').all();
    const zip = new AdmZip();
    const exportedAssets = new Set();
    for (const book of books) {
      addLibraryAsset(zip, 'books', book.filename, exportedAssets);
      if (book.cover_path) addLibraryAsset(zip, 'covers', book.cover_path, exportedAssets);
    }

    const dump = {
      formatVersion: 2,
      exportedAt: new Date().toISOString(),
      // Identity mapping is used on import; never export a hash or role.
      users: db.prepare('SELECT id, username FROM users').all(),
      user_books: db.prepare('SELECT * FROM user_books').all(),
      books,
      bookmarks: db.prepare('SELECT * FROM bookmarks').all(),
      highlights: db.prepare('SELECT * FROM highlights').all(),
      reading_sessions: db.prepare('SELECT * FROM reading_sessions').all(),
      collections: db.prepare('SELECT * FROM collections').all(),
      book_collections: db.prepare('SELECT * FROM book_collections').all(),
      settings: db.prepare(`
        SELECT user_id, key, value
        FROM settings
        WHERE key NOT IN ('passphrase_hash', 'session_token')
      `).all(),
    };
    zip.addFile('database.json', Buffer.from(JSON.stringify(dump, null, 2), 'utf8'));

    const buffer = zip.toBuffer();
    const filename = `endpaper-backup-${new Date().toISOString().slice(0, 10)}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

/**
 * POST /api/import
 * Accepts a zip file (from /api/export) and restores the shared library. User
 * state is restored only for matching, pre-existing local usernames.
 */
const multer = require('multer');
const importUpload = multer({
  dest: path.join(DATA_DIR, 'tmp'),
  limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 5 },
  fileFilter: (req, file, callback) => {
    if (!file.originalname.toLowerCase().endsWith('.zip')) return callback(importError('Only .zip backup files are allowed'));
    callback(null, true);
  },
});

app.post('/api/import', requireAdmin, importUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const zip = new AdmZip(req.file.path);
    const BOOKS_DIR = path.join(DATA_DIR, 'books');
    const COVERS_DIR = path.join(DATA_DIR, 'covers');
    const files = safeArchiveFiles(zip);

    const dbEntry = zip.getEntry('database.json');
    if (!dbEntry) throw importError('Backup is missing database.json');
    const databaseSize = Number(dbEntry.header && dbEntry.header.size);
    if (!Number.isSafeInteger(databaseSize) || databaseSize > 10 * 1024 * 1024) throw importError('Backup database is too large');
    let dump;
    try {
      dump = validateBackupDump(JSON.parse(dbEntry.getData().toString('utf8')));
    } catch (err) {
      if (err.status) throw err;
      throw importError('Backup database is not valid JSON');
    }

    validateArchiveAssets(files, dump, BOOKS_DIR, COVERS_DIR);
    const { userIds, unmatchedUsers } = createUserIdMap(dump.users);

    // Asset files have UUID names and are never overwritten. Restore them
    // before committing metadata so a write failure cannot leave new records
    // that point at missing files. A retry after an interrupted import is safe.
    const restoredFiles = restoreArchiveFiles(files, BOOKS_DIR, COVERS_DIR);
    const results = importBackupData(dump, userIds, unmatchedUsers);

    // Clean up tmp file
    try { fs.unlinkSync(req.file.path); } catch (e) {}

    res.json({ ok: true, restored_files: restoredFiles, ...results });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    console.error('Import error:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Import failed' });
  }
});

// ---------- Static files (frontend) ----------
const PUBLIC_DIR = path.resolve(__dirname, '../../public');
app.use(express.static(PUBLIC_DIR));

// SPA fallback: serve index.html for any non-API route
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Keep errors from middleware (notably Multer) in the same JSON shape as the
// rest of the API instead of returning Express's default HTML error page.
app.use((err, req, res, next) => {
  console.error('Request error:', err);
  if (res.headersSent) return next(err);
  const isUploadError = err instanceof multer.MulterError;
  const status = err.status || (isUploadError ? 400 : 500);
  const message = err.message === 'File too large'
    ? 'Uploaded file is too large'
    : (status < 500 ? err.message : 'Internal server error');
  res.status(status).json({ error: message });
});

// ---------- Start ----------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Endpaper server listening on http://0.0.0.0:${PORT}`);
});

// ---------- Graceful shutdown ----------
function gracefulShutdown(signal) {
  console.log(`\\n${signal} received — shutting down gracefully…`);
  server.close(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      console.log('Database closed and WAL checkpointed.');
    } catch (e) {
      console.error('Error closing database:', e);
    }
    process.exit(0);
  });
  // Force exit after 10s if connections don't drain
  setTimeout(() => {
    console.error('Forcing shutdown after timeout.');
    process.exit(1);
  }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
