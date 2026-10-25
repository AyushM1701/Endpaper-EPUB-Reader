'use strict';

// Full-text search over book contents (SQLite FTS5). Each spine document is one
// row, so results can point the reader at the right chapter. Accents fold
// ("cafe" finds "Café") and the last search word matches as a prefix.
const path = require('path');
const db = require('../db');
const logger = require('./logger');
const { DATA_DIR } = require('./paths');

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS book_text USING fts5(
    book_id UNINDEXED, href UNINDEXED, content,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TABLE IF NOT EXISTS book_text_status (
    book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
    sections INTEGER NOT NULL DEFAULT 0
  );
`);

const insertSection = db.prepare('INSERT INTO book_text (book_id, href, content) VALUES (?, ?, ?)');
const deleteSections = db.prepare('DELETE FROM book_text WHERE book_id = ?');
const markIndexed = db.prepare(`
  INSERT INTO book_text_status (book_id, sections) VALUES (?, ?)
  ON CONFLICT(book_id) DO UPDATE SET indexed_at = datetime('now'), sections = excluded.sections
`);

const indexBook = db.transaction((bookId, sections) => {
  deleteSections.run(bookId);
  let count = 0;
  for (const section of sections || []) {
    if (!section || typeof section.text !== 'string' || !section.text.trim()) continue;
    insertSection.run(bookId, String(section.href || ''), section.text);
    count++;
  }
  markIndexed.run(bookId, count);
  return count;
});

function removeBook(bookId) {
  deleteSections.run(bookId);
  db.prepare('DELETE FROM book_text_status WHERE book_id = ?').run(bookId);
}

// Turn what a person typed into a safe FTS5 query: words only, all required,
// the last one as a prefix so results appear while typing.
function toMatchQuery(input) {
  const words = String(input || '').normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
  const limited = words.slice(0, 8).filter(word => word.length <= 64);
  if (!limited.length) return null;
  return limited.map((word, index) => `"${word}"${index === limited.length - 1 && word.length >= 2 ? '*' : ''}`).join(' ');
}

// Snippet markers are control characters so the client can escape the text
// and then turn only these into <mark>.
const MARK_START = '\u0002';
const MARK_END = '\u0003';

function search(input, { limit = 40, perBook = 3 } = {}) {
  const match = toMatchQuery(input);
  if (!match) return [];
  const rows = db.prepare(`
    SELECT t.book_id, t.href, snippet(book_text, 2, ?, ?, '…', 14) AS snippet, bm25(book_text) AS score,
           b.title, b.author
    FROM book_text t JOIN books b ON b.id = t.book_id
    WHERE book_text MATCH ?
    ORDER BY score
    LIMIT 400
  `).all(MARK_START, MARK_END, match);
  const perBookCount = new Map();
  const results = [];
  for (const row of rows) {
    const count = perBookCount.get(row.book_id) || 0;
    if (count >= perBook) continue;
    perBookCount.set(row.book_id, count + 1);
    results.push({ book_id: row.book_id, title: row.title, author: row.author, href: row.href, snippet: row.snippet });
    if (results.length >= limit) break;
  }
  return results;
}

// Books uploaded before the index existed (or restored from a backup) are
// indexed in the background, one at a time, without blocking requests.
let backfillRunning = false;
async function backfillMissing() {
  if (backfillRunning) return;
  backfillRunning = true;
  const { extractMeta } = require('./epubMeta');
  try {
    const pending = db.prepare(`
      SELECT b.id, b.filename FROM books b
      LEFT JOIN book_text_status s ON s.book_id = b.id
      WHERE s.book_id IS NULL
    `).all();
    for (const book of pending) {
      try {
        const meta = await extractMeta(path.join(DATA_DIR, 'books', book.filename), book.id, path.join(DATA_DIR, 'covers'), { extractCover: false, collectText: true });
        if (db.prepare('SELECT 1 FROM books WHERE id = ?').get(book.id)) indexBook(book.id, meta.textSections);
      } catch (err) {
        logger.warn({ err, bookId: book.id }, 'Could not index book text');
        markIndexed.run(book.id, 0);
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    if (pending.length) logger.info(`Indexed text for ${pending.length} book(s).`);
  } finally {
    backfillRunning = false;
  }
}

module.exports = { indexBook, removeBook, search, backfillMissing, toMatchQuery, MARK_START, MARK_END };
