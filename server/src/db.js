'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'endpaper.db');

// Ensure data directories exist
fs.mkdirSync(path.join(DATA_DIR, 'books'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'covers'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'tmp'), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
// Enable foreign keys on every connection
db.pragma('foreign_keys = ON');
// Give concurrent readers and writers a chance to finish instead of failing immediately.
db.pragma('busy_timeout = 5000');

// ---------- Schema migration ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    series TEXT,
    series_index REAL,
    filename TEXT NOT NULL,
    file_format TEXT DEFAULT 'epub',
    file_size INTEGER,
    cover_path TEXT,
    cover_color TEXT,
    status TEXT DEFAULT 'unread',
    rating INTEGER,
    progress_percent REAL DEFAULT 0,
    last_location_cfi TEXT,
    added_at TEXT DEFAULT (datetime('now')),
    last_opened_at TEXT
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    cfi TEXT NOT NULL,
    label TEXT,
    chapter TEXT,
    progress_percent REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    cfi_range TEXT NOT NULL,
    excerpt TEXT,
    note TEXT,
    color TEXT DEFAULT 'gold',
    chapter TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reading_sessions (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_seconds INTEGER
  );

  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS book_collections (
    book_id TEXT REFERENCES books(id) ON DELETE CASCADE,
    collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, collection_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_books_added_at ON books(added_at DESC);
  CREATE INDEX IF NOT EXISTS idx_books_last_opened_at ON books(last_opened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_book_progress ON bookmarks(book_id, progress_percent);
  CREATE INDEX IF NOT EXISTS idx_highlights_book_created ON highlights(book_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON reading_sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_open ON reading_sessions(ended_at);
`);

// ---------- Automatic daily backup ----------
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = 5;
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function runBackup() {
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const backupFile = path.join(BACKUP_DIR, `endpaper-${dateStr}.db`);
    if (fs.existsSync(backupFile)) return; // already backed up today
    db.backup(backupFile)
      .then(() => {
        console.log(`Database backed up to ${backupFile}`);
        // Rotate: keep only the newest MAX_BACKUPS files
        const files = fs.readdirSync(BACKUP_DIR)
          .filter(f => f.startsWith('endpaper-') && f.endsWith('.db'))
          .sort()
          .reverse();
        for (const old of files.slice(MAX_BACKUPS)) {
          try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (e) { /* skip */ }
        }
      })
      .catch(err => console.error('Database backup failed:', err));
  } catch (e) {
    console.error('Database backup error:', e);
  }
}

// Run backup on startup (non-blocking) and schedule daily
runBackup();
setInterval(runBackup, BACKUP_INTERVAL_MS);

module.exports = db;
