'use strict';

// Recompute word counts for books uploaded before the word_count migration.
// Usage: npm run reindex-books
const path = require('path');
const db = require('../db');
const { extractMeta } = require('./epubMeta');

const dataDir = process.env.ENDPAPER_DATA_DIR
  ? path.resolve(process.env.ENDPAPER_DATA_DIR)
  : path.resolve(__dirname, '../../../data');
const booksDir = path.join(dataDir, 'books');

async function main() {
  const rows = db.prepare('SELECT id, filename FROM books WHERE word_count IS NULL OR word_count <= 0').all();
  const update = db.prepare('UPDATE books SET word_count = ? WHERE id = ?');
  for (const row of rows) {
    try {
      const meta = await extractMeta(path.join(booksDir, row.filename), row.id, path.join(dataDir, 'covers'));
      update.run(Number.isFinite(meta.wordCount) && meta.wordCount > 0 ? meta.wordCount : null, row.id);
      console.log(`Indexed ${row.filename}: ${meta.wordCount || 'unavailable'} words`);
    } catch (error) {
      console.error(`Could not index ${row.filename}: ${error.message}`);
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
