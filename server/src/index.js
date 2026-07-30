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

// Routes
const authRoutes = require('./routes/auth');
const booksRoutes = require('./routes/books');
const bookmarksRoutes = require('./routes/bookmarks');
const highlightsRoutes = require('./routes/highlights');
const sessionsRoutes = require('./routes/sessions');
const collectionsRoutes = require('./routes/collections');
const settingsRoutes = require('./routes/settings');

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

function assertText(value, name, { required = false, max = 10000 } = {}) {
  if (value == null && !required) return;
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) {
    throw importError(`Invalid ${name} in backup`);
  }
}

function validateBackupDump(dump) {
  if (!dump || typeof dump !== 'object' || Array.isArray(dump)) throw importError('Backup database is invalid');
  const books = assertArray(dump.books, 'books');
  const bookmarks = assertArray(dump.bookmarks, 'bookmarks');
  const highlights = assertArray(dump.highlights, 'highlights');
  const sessions = assertArray(dump.reading_sessions, 'reading_sessions');
  const collections = assertArray(dump.collections, 'collections');
  const bookCollections = assertArray(dump.book_collections, 'book_collections');
  const settings = assertArray(dump.settings, 'settings');

  for (const book of books) {
    if (!book || !isUuid(book.id) || !isBookFilename(book.filename)) throw importError('Invalid book in backup');
    assertText(book.title, 'book title', { required: true, max: 500 });
    assertText(book.author, 'book author', { max: 500 });
    assertText(book.series, 'book series', { max: 500 });
    if (book.cover_path != null && !isCoverFilename(book.cover_path)) throw importError('Invalid book cover in backup');
  }
  for (const bookmark of bookmarks) {
    if (!bookmark || !isUuid(bookmark.id) || !isUuid(bookmark.book_id)) throw importError('Invalid bookmark in backup');
    assertText(bookmark.cfi, 'bookmark CFI', { required: true });
  }
  for (const highlight of highlights) {
    if (!highlight || !isUuid(highlight.id) || !isUuid(highlight.book_id)) throw importError('Invalid highlight in backup');
    assertText(highlight.cfi_range, 'highlight CFI', { required: true });
  }
  for (const session of sessions) {
    if (!session || !isUuid(session.id) || !isUuid(session.book_id)) throw importError('Invalid reading session in backup');
    assertText(session.started_at, 'session start time', { required: true, max: 40 });
  }
  for (const collection of collections) {
    if (!collection || !isUuid(collection.id)) throw importError('Invalid collection in backup');
    assertText(collection.name, 'collection name', { required: true, max: 80 });
  }
  for (const membership of bookCollections) {
    if (!membership || !isUuid(membership.book_id) || !isUuid(membership.collection_id)) throw importError('Invalid collection membership in backup');
  }
  for (const setting of settings) {
    if (!setting || typeof setting.key !== 'string' || setting.key.length > 80 || typeof setting.value !== 'string' || setting.value.length > 100_000) {
      throw importError('Invalid setting in backup');
    }
  }

  return { books, bookmarks, highlights, sessions, collections, bookCollections, settings };
}

function safeArchiveFiles(zip) {
  const entries = zip.getEntries();
  if (entries.length > MAX_IMPORT_ENTRIES) throw importError('Backup contains too many files');
  let totalSize = 0;
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const size = Number(entry.header && entry.header.size);
    if (!Number.isSafeInteger(size) || size < 0) throw importError('Backup contains an invalid file entry');
    totalSize += size;
    if (totalSize > MAX_IMPORT_BYTES) throw importError('Backup is too large to import');
    if (entry.entryName === 'database.json') continue;
    const bookMatch = /^books\/([0-9a-f-]+\.epub)$/i.exec(entry.entryName);
    const coverMatch = /^covers\/([0-9a-f-]+\.(?:jpe?g|png|gif|webp))$/i.exec(entry.entryName);
    if (bookMatch && isBookFilename(bookMatch[1])) files.push({ entry, directory: 'books', filename: bookMatch[1] });
    else if (coverMatch && isCoverFilename(coverMatch[1])) files.push({ entry, directory: 'covers', filename: coverMatch[1] });
    else throw importError('Backup contains an unsupported file');
  }
  return files;
}

/**
 * POST /api/export
 * Zips data/books/ + a JSON dump of the DB, returns as a downloadable zip.
 */
app.post('/api/export', (req, res) => {
  try {
    const zip = new AdmZip();
    const BOOKS_DIR = path.join(DATA_DIR, 'books');
    const COVERS_DIR = path.join(DATA_DIR, 'covers');

    // Add all book files
    if (fs.existsSync(BOOKS_DIR)) {
      const bookFiles = fs.readdirSync(BOOKS_DIR);
      for (const f of bookFiles) {
        zip.addLocalFile(path.join(BOOKS_DIR, f), 'books');
      }
    }

    // Add all cover files
    if (fs.existsSync(COVERS_DIR)) {
      const coverFiles = fs.readdirSync(COVERS_DIR);
      for (const f of coverFiles) {
        zip.addLocalFile(path.join(COVERS_DIR, f), 'covers');
      }
    }

    // Dump DB tables as JSON
    const dump = {
      exportedAt: new Date().toISOString(),
      books: db.prepare('SELECT * FROM books').all(),
      bookmarks: db.prepare('SELECT * FROM bookmarks').all(),
      highlights: db.prepare('SELECT * FROM highlights').all(),
      reading_sessions: db.prepare('SELECT * FROM reading_sessions').all(),
      collections: db.prepare('SELECT * FROM collections').all(),
      book_collections: db.prepare('SELECT * FROM book_collections').all(),
      settings: db.prepare('SELECT * FROM settings').all().filter(s =>
        !['passphrase_hash', 'session_token'].includes(s.key)
      ),
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
 * Accepts a zip file (from /api/export) and restores books, covers, and DB data.
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

app.post('/api/import', importUpload.single('file'), (req, res) => {
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

    // Restore DB data
      const insertBook = db.prepare(`
        INSERT OR IGNORE INTO books (id, title, author, series, series_index, filename, file_format,
                                     file_size, cover_path, cover_color, status, rating,
                                     progress_percent, last_location_cfi, added_at, last_opened_at)
        VALUES (@id, @title, @author, @series, @series_index, @filename, @file_format,
                @file_size, @cover_path, @cover_color, @status, @rating,
                @progress_percent, @last_location_cfi, @added_at, @last_opened_at)
      `);

      const insertBookmark = db.prepare(`
        INSERT OR IGNORE INTO bookmarks (id, book_id, cfi, label, chapter, progress_percent, created_at)
        VALUES (@id, @book_id, @cfi, @label, @chapter, @progress_percent, @created_at)
      `);

      const insertHighlight = db.prepare(`
        INSERT OR IGNORE INTO highlights (id, book_id, cfi_range, excerpt, note, color, chapter, created_at)
        VALUES (@id, @book_id, @cfi_range, @excerpt, @note, @color, @chapter, @created_at)
      `);

      const insertSession = db.prepare(`
        INSERT OR IGNORE INTO reading_sessions (id, book_id, started_at, ended_at, duration_seconds)
        VALUES (@id, @book_id, @started_at, @ended_at, @duration_seconds)
      `);

      const insertCollection = db.prepare(`
        INSERT OR IGNORE INTO collections (id, name) VALUES (@id, @name)
      `);

      const insertBookCollection = db.prepare(`
        INSERT OR IGNORE INTO book_collections (book_id, collection_id) VALUES (@book_id, @collection_id)
      `);

      const insertSetting = db.prepare(`
        INSERT OR IGNORE INTO settings (key, value) VALUES (@key, @value)
      `);

      const importAll = db.transaction((backup) => {
        for (const book of backup.books) insertBook.run(book);
        for (const bm of backup.bookmarks) insertBookmark.run(bm);
        for (const hl of backup.highlights) insertHighlight.run(hl);
        for (const s of backup.sessions) insertSession.run(s);
        for (const c of backup.collections) insertCollection.run(c);
        for (const bc of backup.bookCollections) insertBookCollection.run(bc);
        for (const s of backup.settings) insertSetting.run(s);
      });

      importAll(dump);

    // Only allow exact, expected archive paths and never overwrite a local
    // file. The database import above is transactional; files are immutable
    // UUID assets, so retrying a partial import is safe.
    let restoredFiles = 0;
    for (const file of files) {
      const destination = path.join(file.directory === 'books' ? BOOKS_DIR : COVERS_DIR, file.filename);
      if (!fs.existsSync(destination)) {
        fs.writeFileSync(destination, file.entry.getData());
        restoredFiles++;
      }
    }

    // Clean up tmp file
    try { fs.unlinkSync(req.file.path); } catch (e) {}

    res.json({ ok: true, restored_files: restoredFiles });
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
  console.log(`\n${signal} received — shutting down gracefully…`);
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
