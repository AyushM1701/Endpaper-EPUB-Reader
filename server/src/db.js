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

// Check if we need to run the multi-user migration
const settingsTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
let needsMigration = false;
let oldPassphrase = null;
let oldSession = null;

if (settingsTableExists) {
  oldPassphrase = db.prepare("SELECT value FROM settings WHERE key = 'passphrase_hash'").get();
  oldSession = db.prepare("SELECT value FROM settings WHERE key = 'session_token'").get();
  if (oldPassphrase) {
    needsMigration = true;
  }
}

if (needsMigration) {
  console.log("Migrating database to multi-user schema...");
  // 1. Add user_id column to existing tables. Guard each ALTER TABLE with a
  // column-existence check so this step is safe to re-run if the process is
  // killed after this point but before the data migration below commits —
  // otherwise a retry would hit "duplicate column name" and the app would
  // never start again.
  for (const table of ['bookmarks', 'highlights', 'reading_sessions']) {
    const cols = db.pragma(`table_info(${table})`);
    if (!cols.some(c => c.name === 'user_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT;`);
    }
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    passphrase_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

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
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_books (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'unread',
    rating INTEGER,
    progress_percent REAL DEFAULT 0,
    last_location_cfi TEXT,
    last_opened_at TEXT,
    PRIMARY KEY (user_id, book_id)
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    cfi TEXT NOT NULL,
    label TEXT,
    chapter TEXT,
    progress_percent REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY(user_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_books_added_at ON books(added_at DESC);
  CREATE INDEX IF NOT EXISTS idx_user_books_opened ON user_books(user_id, last_opened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_book_progress ON bookmarks(book_id, progress_percent);
  CREATE INDEX IF NOT EXISTS idx_highlights_book_created ON highlights(book_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON reading_sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_open ON reading_sessions(ended_at);
`);

// Authentication sessions are server-side records as well as browser cookies.
// Older databases did not record an expiry, so add and backfill the column
// before any route can validate a session. A NULL/invalid expiry is treated as
// expired below rather than leaving an indefinitely valid legacy token behind.
const sessionCols = db.pragma('table_info(sessions)');
if (!sessionCols.some(column => column.name === 'expires_at')) {
  console.log('Migrating sessions table to add server-side expiry...');
  db.exec('ALTER TABLE sessions ADD COLUMN expires_at TEXT;');
}
db.prepare(`
  UPDATE sessions
  SET expires_at = datetime(COALESCE(created_at, CURRENT_TIMESTAMP), '+90 days')
  WHERE expires_at IS NULL OR datetime(expires_at) IS NULL
`).run();
db.prepare(`
  DELETE FROM sessions
  WHERE expires_at IS NULL
     OR datetime(expires_at) IS NULL
     OR datetime(expires_at) <= CURRENT_TIMESTAMP
`).run();
db.exec('CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON sessions(expires_at);');

if (needsMigration) {
  const crypto = require('crypto');
  db.transaction(() => {
    const defaultUserId = crypto.randomUUID();
    // 1. Create admin user
    db.prepare("INSERT INTO users (id, username, passphrase_hash, is_admin) VALUES (?, 'admin', ?, 1)").run(defaultUserId, oldPassphrase.value);
    
    // 2. Migrate session
    if (oldSession) {
      db.prepare(`
        INSERT OR IGNORE INTO sessions (token, user_id, expires_at)
        VALUES (?, ?, datetime('now', '+90 days'))
      `).run(oldSession.value, defaultUserId);
    }
    
    // 3. Migrate user books. Extract progress etc. from books.
    try {
      db.prepare(`
        INSERT INTO user_books (user_id, book_id, status, rating, progress_percent, last_location_cfi, last_opened_at)
        SELECT ?, id, status, rating, progress_percent, last_location_cfi, last_opened_at FROM books
      `).run(defaultUserId);
    } catch (e) {
      console.error("Migration warning on user_books", e);
    }
    
    // 4. Update other tables
    db.prepare("UPDATE bookmarks SET user_id = ? WHERE user_id IS NULL").run(defaultUserId);
    db.prepare("UPDATE highlights SET user_id = ? WHERE user_id IS NULL").run(defaultUserId);
    db.prepare("UPDATE reading_sessions SET user_id = ? WHERE user_id IS NULL").run(defaultUserId);
    
    // 5. Clean up old settings
    db.prepare("DELETE FROM settings WHERE key IN ('passphrase_hash', 'session_token')").run();
  })();
}

// 2. Settings table migration (add user_id)
const settingsCols = db.pragma('table_info(settings)');
const settingsHasUserId = settingsCols.some(c => c.name === 'user_id');

if (!settingsHasUserId) {
  console.log("Migrating settings table to user-scoped schema...");
  db.transaction(() => {
    // Read existing global settings
    const globalSettings = db.prepare('SELECT key, value FROM settings').all();
    
    // Create new table
    db.exec(`
      CREATE TABLE settings_new (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY(user_id, key)
      );
    `);
    
    // Apply global settings to all users
    if (globalSettings.length > 0) {
      const users = db.prepare('SELECT id FROM users').all();
      const insertStmt = db.prepare('INSERT INTO settings_new (user_id, key, value) VALUES (?, ?, ?)');
      for (const user of users) {
        for (const setting of globalSettings) {
          insertStmt.run(user.id, setting.key, setting.value);
        }
      }
    }
    
    db.exec(`
      DROP TABLE settings;
      ALTER TABLE settings_new RENAME TO settings;
    `);
  })();
}

// 3. Collections table migration (remove user_id)
const collectionsCols = db.pragma('table_info(collections)');
const collectionsHasUserId = collectionsCols.some(c => c.name === 'user_id');

if (collectionsHasUserId) {
  console.log("Migrating collections table back to global schema...");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE collections_global (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );
    `);
    
    db.exec(`
      INSERT OR IGNORE INTO collections_global (id, name)
      SELECT id, name FROM collections;
    `);
    
    db.exec(`
      DROP TABLE collections;
      ALTER TABLE collections_global RENAME TO collections;
    `);
  })();
}

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
