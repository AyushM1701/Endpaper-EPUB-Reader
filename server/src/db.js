'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.ENDPAPER_DATA_DIR
  ? path.resolve(process.env.ENDPAPER_DATA_DIR)
  : path.resolve(__dirname, '../../data');
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

// Back up an existing database before the first structural change in this
// process. PRAGMA user_version is the ordered migration marker; older builds
// inferred state solely from columns, which made partial upgrades difficult to
// reason about and could mutate data before a safety copy existed.
const TARGET_SCHEMA_VERSION = 4;
const startingSchemaVersion = Number(db.pragma('user_version', { simple: true })) || 0;
const existingTableCount = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
if (existingTableCount > 0 && startingSchemaVersion < TARGET_SCHEMA_VERSION && fs.existsSync(DB_PATH)) {
  const earlyBackupDir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(earlyBackupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(DB_PATH, path.join(earlyBackupDir, `endpaper-pre-migration-v${startingSchemaVersion}-to-v${TARGET_SCHEMA_VERSION}-${stamp}.db`));
}

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
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
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
    word_count INTEGER,
    file_hash TEXT,
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
    duration_seconds INTEGER,
    client_id TEXT,
    start_progress_percent REAL,
    end_progress_percent REAL
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

  CREATE TABLE IF NOT EXISTS client_operations (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    response_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, operation_id)
  );

  CREATE INDEX IF NOT EXISTS idx_books_added_at ON books(added_at DESC);
  CREATE INDEX IF NOT EXISTS idx_user_books_user ON user_books(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_books_opened ON user_books(user_id, last_opened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_book_progress ON bookmarks(book_id, progress_percent);
  CREATE INDEX IF NOT EXISTS idx_highlights_book_created ON highlights(book_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON reading_sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_open ON reading_sessions(ended_at);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_user_book_progress ON bookmarks(user_id, book_id, progress_percent);
  CREATE INDEX IF NOT EXISTS idx_highlights_user_book_created ON highlights(user_id, book_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_book_started ON reading_sessions(user_id, book_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_client_operations_created ON client_operations(created_at);
`);

function addColumnIfMissing(table, definition) {
  const name = definition.trim().split(/\s+/)[0];
  const columns = db.pragma(`table_info(${table})`);
  if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

addColumnIfMissing('books', 'description TEXT');
addColumnIfMissing('books', 'isbn TEXT');
addColumnIfMissing('books', 'tags TEXT');
addColumnIfMissing('books', 'word_count INTEGER');
addColumnIfMissing('highlights', 'tags TEXT');
addColumnIfMissing('reading_sessions', 'client_id TEXT');
addColumnIfMissing('reading_sessions', 'start_progress_percent REAL');
addColumnIfMissing('reading_sessions', 'end_progress_percent REAL');

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
    const legacyCollections = db.prepare('SELECT id, name FROM collections ORDER BY id').all();
    const canonicalByName = new Map();
    for (const collection of legacyCollections) {
      const key = collection.name.toLocaleLowerCase();
      const canonical = canonicalByName.get(key);
      if (!canonical) {
        canonicalByName.set(key, collection);
        continue;
      }
      const memberships = db.prepare('SELECT book_id FROM book_collections WHERE collection_id = ?').all(collection.id);
      for (const membership of memberships) {
        db.prepare('INSERT OR IGNORE INTO book_collections (book_id, collection_id) VALUES (?, ?)').run(membership.book_id, canonical.id);
      }
      db.prepare('DELETE FROM book_collections WHERE collection_id = ?').run(collection.id);
      db.prepare('DELETE FROM collections WHERE id = ?').run(collection.id);
    }
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

// ---------- 4. Books table migration (add file_hash) ----------
const bookCols = db.pragma('table_info(books)');
if (!bookCols.some(c => c.name === 'file_hash')) {
  console.log('Migrating books table to add file_hash column...');
  db.exec('ALTER TABLE books ADD COLUMN file_hash TEXT;');
}
// Function to create a pre-migration backup before any structural data changes
function backupDatabaseBeforeMigration(label) {
  try {
    const BACKUP_DIR = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupTarget = path.join(BACKUP_DIR, `endpaper-pre-migration-${label}-${timestamp}.db`);
    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, backupTarget);
      console.log(`[Migration] Safety backup created at ${backupTarget}`);
    }
  } catch (e) {
    console.error(`[Migration] Warning: Pre-migration backup failed:`, e);
  }
}

// Consolidate historical duplicate entries safely before unique index creation
const duplicateHashes = db.prepare(`
  SELECT file_hash FROM books 
  WHERE file_hash IS NOT NULL 
  GROUP BY file_hash 
  HAVING count(*) > 1
`).all();

if (duplicateHashes.length > 0) {
  console.log(`[Migration] Found ${duplicateHashes.length} duplicate book group(s). Consolidating dependent data...`);
  backupDatabaseBeforeMigration('books-deduplication');

  db.transaction(() => {
    for (const dup of duplicateHashes) {
      const booksInGroup = db.prepare(`
        SELECT id, title, filename, cover_path, added_at FROM books 
        WHERE file_hash = ? 
        ORDER BY added_at ASC
      `).all(dup.file_hash);

      const targetBook = booksInGroup[0];
      const duplicateBooks = booksInGroup.slice(1);

      for (const dupBook of duplicateBooks) {
        // 1. Repoint bookmarks to canonical book
        db.prepare('UPDATE bookmarks SET book_id = ? WHERE book_id = ?').run(targetBook.id, dupBook.id);

        // 2. Repoint highlights to canonical book
        db.prepare('UPDATE highlights SET book_id = ? WHERE book_id = ?').run(targetBook.id, dupBook.id);

        // 3. Repoint reading sessions to canonical book
        db.prepare('UPDATE reading_sessions SET book_id = ? WHERE book_id = ?').run(targetBook.id, dupBook.id);

        // 4. Repoint book_collections
        const dupCollections = db.prepare('SELECT collection_id FROM book_collections WHERE book_id = ?').all(dupBook.id);
        for (const col of dupCollections) {
          db.prepare('INSERT OR IGNORE INTO book_collections (book_id, collection_id) VALUES (?, ?)').run(targetBook.id, col.collection_id);
        }
        db.prepare('DELETE FROM book_collections WHERE book_id = ?').run(dupBook.id);

        // 5. Consolidate user_books progress
        const dupUserBooks = db.prepare('SELECT * FROM user_books WHERE book_id = ?').all(dupBook.id);
        for (const dupUb of dupUserBooks) {
          const targetUb = db.prepare('SELECT * FROM user_books WHERE user_id = ? AND book_id = ?').get(dupUb.user_id, targetBook.id);
          if (targetUb) {
            const mergedProgress = Math.max(targetUb.progress_percent || 0, dupUb.progress_percent || 0);
            const mergedStatus = (mergedProgress >= 95) ? 'finished' : (targetUb.status === 'reading' || dupUb.status === 'reading' ? 'reading' : (targetUb.status || dupUb.status || 'unread'));
            const mergedRating = targetUb.rating || dupUb.rating || null;
            const mergedOpened = (targetUb.last_opened_at && dupUb.last_opened_at) 
              ? (new Date(targetUb.last_opened_at) > new Date(dupUb.last_opened_at) ? targetUb.last_opened_at : dupUb.last_opened_at)
              : (targetUb.last_opened_at || dupUb.last_opened_at);
            const dupProgress = dupUb.progress_percent || 0;
            const targetProgress = targetUb.progress_percent || 0;
            let mergedCfi = targetUb.last_location_cfi;
            if (dupProgress > targetProgress && dupUb.last_location_cfi) {
              mergedCfi = dupUb.last_location_cfi;
            } else if (dupProgress === targetProgress) {
              const dupTime = dupUb.last_opened_at ? new Date(dupUb.last_opened_at).getTime() : 0;
              const targetTime = targetUb.last_opened_at ? new Date(targetUb.last_opened_at).getTime() : 0;
              if (dupTime > targetTime && dupUb.last_location_cfi) {
                mergedCfi = dupUb.last_location_cfi;
              }
            }

            db.prepare(`
              UPDATE user_books 
              SET status = ?, rating = ?, progress_percent = ?, last_location_cfi = ?, last_opened_at = ?
              WHERE user_id = ? AND book_id = ?
            `).run(mergedStatus, mergedRating, mergedProgress, mergedCfi, mergedOpened, dupUb.user_id, targetBook.id);

            db.prepare('DELETE FROM user_books WHERE user_id = ? AND book_id = ?').run(dupUb.user_id, dupBook.id);
          } else {
            db.prepare('UPDATE user_books SET book_id = ? WHERE user_id = ? AND book_id = ?').run(targetBook.id, dupUb.user_id, dupBook.id);
          }
        }

        // 6. Safely remove now-orphaned duplicate book row
        db.prepare('DELETE FROM books WHERE id = ?').run(dupBook.id);

        // 7. Clean duplicate disk assets if distinct from canonical
        if (dupBook.filename && dupBook.filename !== targetBook.filename) {
          const f = path.join(DATA_DIR, 'books', dupBook.filename);
          if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch (e) {} }
        }
        if (dupBook.cover_path && dupBook.cover_path !== targetBook.cover_path) {
          const c = path.join(DATA_DIR, 'covers', dupBook.cover_path);
          if (fs.existsSync(c)) { try { fs.unlinkSync(c); } catch (e) {} }
        }

        console.log(`[Migration] Safely merged duplicate book "${dupBook.title}" (${dupBook.id}) into "${targetBook.title}" (${targetBook.id}) with all annotations preserved.`);
      }
    }
  })();
}

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_books_file_hash ON books(file_hash);');

// ---------- 5. Users table case-insensitive uniqueness migration ----------
const duplicateUsers = db.prepare(`
  SELECT lower(username) as lower_name, count(*) as count 
  FROM users 
  GROUP BY lower(username) 
  HAVING count > 1
`).all();

if (duplicateUsers.length > 0) {
  console.log(`[Migration] Found ${duplicateUsers.length} case-collision user group(s). Backing up and renaming...`);
  backupDatabaseBeforeMigration('users-uniqueness');
}

for (const dup of duplicateUsers) {
  const usersWithCase = db.prepare(`
    SELECT id, username FROM users 
    WHERE lower(username) = ? 
    ORDER BY created_at ASC
  `).all(dup.lower_name);
  for (let i = 1; i < usersWithCase.length; i++) {
    const newName = `${usersWithCase[i].username}_${usersWithCase[i].id.slice(0, 8)}_${i}`;
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(newName, usersWithCase[i].id);
  }
}

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE);');

// ---------- 6. Collections table case-insensitive uniqueness migration ----------
const duplicateCollections = db.prepare(`
  SELECT lower(name) as lower_name, count(*) as count 
  FROM collections 
  GROUP BY lower(name) 
  HAVING count > 1
`).all();

if (duplicateCollections.length > 0) {
  console.log(`[Migration] Found ${duplicateCollections.length} case-collision collection group(s). Backing up and renaming...`);
  backupDatabaseBeforeMigration('collections-uniqueness');
}

for (const dup of duplicateCollections) {
  const collectionsWithCase = db.prepare(`
    SELECT id, name FROM collections 
    WHERE lower(name) = ? 
    ORDER BY id ASC
  `).all(dup.lower_name);
  for (let i = 1; i < collectionsWithCase.length; i++) {
    const newName = `${collectionsWithCase[i].name}_${collectionsWithCase[i].id.slice(0, 8)}_${i}`;
    db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(newName, collectionsWithCase[i].id);
  }
}

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_name_nocase ON collections(name COLLATE NOCASE);');
db.pragma(`user_version = ${TARGET_SCHEMA_VERSION}`);

// Hash legacy files without blocking startup or reading whole EPUBs into RAM.
// One file is processed at a time and the unique index resolves races safely.
setImmediate(async () => {
  const crypto = require('crypto');
  const missing = db.prepare('SELECT id, filename FROM books WHERE file_hash IS NULL').all();
  const updateHash = db.prepare('UPDATE books SET file_hash = ? WHERE id = ? AND file_hash IS NULL');
  for (const item of missing) {
    const filePath = path.join(DATA_DIR, 'books', item.filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const hash = crypto.createHash('sha256');
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      updateHash.run(hash.digest('hex'), item.id);
    } catch (error) {
      console.error('Could not hash book', item.filename, error);
    }
  }
});

// ---------- Periodic session pruning ----------
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
function runSessionPruning() {
  try {
    const result = db.prepare(`
      DELETE FROM sessions
      WHERE expires_at IS NULL
         OR datetime(expires_at) IS NULL
         OR datetime(expires_at) <= CURRENT_TIMESTAMP
    `).run();
    if (result.changes > 0) {
      console.log(`Pruned ${result.changes} expired session(s).`);
    }
  } catch (e) {
    console.error('Session pruning error:', e);
  }
}
runSessionPruning();
setInterval(runSessionPruning, PRUNE_INTERVAL_MS);

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
