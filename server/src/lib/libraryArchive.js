'use strict';

// The library backup format: database.json plus every EPUB and cover, in one
// ZIP that POST /api/import can restore. Used by the export download, the
// `npm run backup` command and the optional scheduled backup.
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const db = require('../db');
const { DATA_DIR } = require('./paths');

const createZipArchive = opts => (typeof archiver === 'function' ? archiver('zip', opts) : new archiver.ZipArchive(opts));

function isRegularFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch (_) { return false; }
}

// Every file a backup will reference must exist before anything is written,
// so a backup is never silently incomplete.
function checkLibraryAssets(books) {
  for (const book of books) {
    if (!isRegularFile(path.join(DATA_DIR, 'books', book.filename))) {
      throw Object.assign(new Error(`Cannot back up: book file for "${book.title || book.id}" (${book.filename}) is missing on disk`), { status: 500 });
    }
    if (book.cover_path && !isRegularFile(path.join(DATA_DIR, 'covers', book.cover_path))) {
      throw Object.assign(new Error(`Cannot back up: cover file for "${book.title || book.id}" (${book.cover_path}) is missing on disk`), { status: 500 });
    }
  }
}

function libraryDump(books) {
  return {
    formatVersion: 2,
    exportedAt: new Date().toISOString(),
    // Identity mapping is used on import; never export a hash, role, 2FA secret or app key.
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
}

/**
 * Stream a full library backup into `output` (an HTTP response or a file).
 * The database snapshot is taken in one read transaction, so it is consistent
 * even while people keep reading. Resolves when the archive is finalized.
 */
function writeLibraryArchive(output) {
  const books = db.prepare('SELECT * FROM books').all();
  checkLibraryAssets(books);
  const dump = db.transaction(() => libraryDump(books))();
  const archive = createZipArchive({ zlib: { level: 9 } });
  const done = new Promise((resolve, reject) => {
    archive.on('error', reject);
    output.on('error', reject);
    output.on('close', resolve);
    output.on('finish', resolve);
  });
  archive.pipe(output);
  const added = new Set();
  for (const book of books) {
    for (const [dir, file] of [['books', book.filename], ['covers', book.cover_path]]) {
      if (!file || added.has(`${dir}/${file}`)) continue;
      archive.file(path.join(DATA_DIR, dir, file), { name: `${dir}/${file}` });
      added.add(`${dir}/${file}`);
    }
  }
  archive.append(JSON.stringify(dump, null, 2), { name: 'database.json' });
  archive.finalize();
  return { archive, done, bookCount: books.length };
}

// ---------- Full backups on disk ----------
const FULL_BACKUP_DIR = path.join(DATA_DIR, 'backups', 'full');

async function writeFullBackup({ keep = 3 } = {}) {
  fs.mkdirSync(FULL_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalPath = path.join(FULL_BACKUP_DIR, `endpaper-full-${stamp}.zip`);
  const partialPath = `${finalPath}.partial`;
  const output = fs.createWriteStream(partialPath);
  try {
    const { done, bookCount } = writeLibraryArchive(output);
    await done;
    fs.renameSync(partialPath, finalPath);
    // Keep the newest `keep` archives.
    const archives = fs.readdirSync(FULL_BACKUP_DIR).filter(name => /^endpaper-full-.*\.zip$/.test(name)).sort().reverse();
    for (const old of archives.slice(Math.max(1, keep))) fs.rmSync(path.join(FULL_BACKUP_DIR, old), { force: true });
    return { path: finalPath, bookCount, bytes: fs.statSync(finalPath).size };
  } catch (err) {
    output.destroy();
    fs.rmSync(partialPath, { force: true });
    throw err;
  }
}

module.exports = { writeLibraryArchive, writeFullBackup, FULL_BACKUP_DIR, isRegularFile };
