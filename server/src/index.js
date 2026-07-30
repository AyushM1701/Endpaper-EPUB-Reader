'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

// Initialize database (runs schema migration on require)
const db = require('./db');

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

// ---------- Middleware ----------
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Auth middleware on all /api/* routes (auth route handler skips /api/login internally)
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

/**
 * POST /api/export
 * Zips data/books/ + a JSON dump of the DB, returns as a downloadable zip.
 */
app.post('/api/export', (req, res) => {
  try {
    const zip = new AdmZip();
    const DATA_DIR = path.resolve(__dirname, '../../data');
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
const importUpload = multer({ dest: path.resolve(__dirname, '../../data/tmp') });

app.post('/api/import', importUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const zip = new AdmZip(req.file.path);
    const DATA_DIR = path.resolve(__dirname, '../../data');
    const BOOKS_DIR = path.join(DATA_DIR, 'books');
    const COVERS_DIR = path.join(DATA_DIR, 'covers');

    // Extract book and cover files
    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.entryName.startsWith('books/') && !entry.isDirectory) {
        const filename = path.basename(entry.entryName);
        const destPath = path.join(BOOKS_DIR, filename);
        if (!fs.existsSync(destPath)) {
          fs.writeFileSync(destPath, entry.getData());
        }
      }
      if (entry.entryName.startsWith('covers/') && !entry.isDirectory) {
        const filename = path.basename(entry.entryName);
        const destPath = path.join(COVERS_DIR, filename);
        if (!fs.existsSync(destPath)) {
          fs.writeFileSync(destPath, entry.getData());
        }
      }
    }

    // Restore DB data
    const dbEntry = zip.getEntry('database.json');
    if (dbEntry) {
      const dump = JSON.parse(dbEntry.getData().toString('utf8'));

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

      const importAll = db.transaction((dump) => {
        for (const book of (dump.books || [])) insertBook.run(book);
        for (const bm of (dump.bookmarks || [])) insertBookmark.run(bm);
        for (const hl of (dump.highlights || [])) insertHighlight.run(hl);
        for (const s of (dump.reading_sessions || [])) insertSession.run(s);
        for (const c of (dump.collections || [])) insertCollection.run(c);
        for (const bc of (dump.book_collections || [])) insertBookCollection.run(bc);
        for (const s of (dump.settings || [])) insertSetting.run(s);
      });

      importAll(dump);
    }

    // Clean up tmp file
    try { fs.unlinkSync(req.file.path); } catch (e) {}

    res.json({ ok: true });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    console.error('Import error:', err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
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

// ---------- Start ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Endpaper server listening on http://0.0.0.0:${PORT}`);
});
