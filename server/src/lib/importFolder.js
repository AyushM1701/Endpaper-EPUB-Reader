'use strict';

// Import every EPUB under a folder, such as a Calibre library, into the shared
// library. Runs on the server, so large libraries never pass through a browser.
//
//   npm run import-folder -- "/path/to/Calibre Library" [--user admin] [--dry-run]
//
// Each book goes through the same pipeline as a web upload (validation,
// duplicate check, cover, search index). When Calibre's metadata.opf sits next
// to the EPUB, its series, tags, description and rating are applied too.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const db = require('../db');
const { DATA_DIR } = require('./paths');
const { BOOK_TEXT_LIMITS, clip } = require('./validation');
const { htmlToText } = require('./epubMeta');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const opfParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false, isArray: name => ['meta', 'dc:subject', 'dc:creator', 'dc:identifier'].includes(name) });

function parseArgs(argv) {
  const args = { folder: null, user: null, dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--user') args.user = argv[++index];
    else if (value === '--dry-run') args.dryRun = true;
    else if (!args.folder) args.folder = value;
  }
  return args;
}

function findEpubs(folder) {
  const found = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.epub')) found.push(full);
    }
  };
  walk(folder);
  return found.sort();
}

const textOf = value => (typeof value === 'string' ? value : value?.['#text']) || '';

// Calibre writes metadata.opf beside each book's files.
function readCalibreOpf(epubPath) {
  const opfPath = path.join(path.dirname(epubPath), 'metadata.opf');
  if (!fs.existsSync(opfPath)) return null;
  try {
    const opf = opfParser.parse(fs.readFileSync(opfPath, 'utf8'));
    const metadata = (opf.package || opf['opf:package'] || {}).metadata || {};
    const metas = metadata.meta || [];
    const metaValue = name => metas.find(item => item['@_name'] === name)?.['@_content'];
    const isbn = (metadata['dc:identifier'] || []).find(item => /isbn/i.test(item['@_opf:scheme'] || item['@_scheme'] || ''));
    const rating = Number(metaValue('calibre:rating'));
    const seriesIndex = Number(metaValue('calibre:series_index'));
    return {
      title: clip(textOf(metadata['dc:title']), BOOK_TEXT_LIMITS.title),
      author: clip((metadata['dc:creator'] || []).map(textOf).filter(Boolean).join(', '), BOOK_TEXT_LIMITS.author),
      description: clip(htmlToText(textOf(metadata['dc:description'])), BOOK_TEXT_LIMITS.description),
      tags: clip((metadata['dc:subject'] || []).map(textOf).filter(Boolean).join(', '), BOOK_TEXT_LIMITS.tags),
      isbn: clip(textOf(isbn), BOOK_TEXT_LIMITS.isbn),
      series: clip(metaValue('calibre:series') || '', BOOK_TEXT_LIMITS.series),
      series_index: Number.isFinite(seriesIndex) ? seriesIndex : null,
      // Calibre stores 0–10 (half stars); Endpaper uses whole stars 1–5.
      rating: Number.isFinite(rating) && rating > 0 ? Math.max(1, Math.min(5, Math.round(rating / 2))) : null,
    };
  } catch (_) {
    return null;
  }
}

function applyCalibreMetadata(bookId, userId, calibre) {
  const updates = {};
  for (const key of ['title', 'author', 'description', 'tags', 'isbn', 'series']) if (calibre[key]) updates[key] = calibre[key];
  if (calibre.series && calibre.series_index != null) updates.series_index = calibre.series_index;
  const keys = Object.keys(updates);
  if (keys.length) db.prepare(`UPDATE books SET ${keys.map(key => `${key} = @${key}`).join(', ')} WHERE id = @id`).run({ ...updates, id: bookId });
  if (calibre.rating) db.prepare('UPDATE user_books SET rating = ? WHERE user_id = ? AND book_id = ?').run(calibre.rating, userId, bookId);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.folder || !fs.existsSync(args.folder) || !fs.statSync(args.folder).isDirectory()) {
    console.error('Usage: npm run import-folder -- "/path/to/folder" [--user admin] [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const user = args.user
    ? db.prepare('SELECT id, username FROM users WHERE lower(username) = lower(?)').get(args.user)
    : db.prepare('SELECT id, username FROM users WHERE is_admin = 1 ORDER BY rowid LIMIT 1').get();
  if (!user) {
    console.error(args.user ? `No account named "${args.user}".` : 'No admin account exists yet. Create one with npm run set-passphrase first.');
    process.exitCode = 1;
    return;
  }
  const files = findEpubs(path.resolve(args.folder));
  console.log(`Found ${files.length} EPUB file(s) under ${path.resolve(args.folder)}. Adding them as ${user.username}.`);
  if (args.dryRun) { files.forEach(file => console.log(`  would import ${file}`)); return; }

  const { ingestEpub } = require('../routes/books');
  const counts = { added: 0, duplicate: 0, failed: 0 };
  for (const [index, file] of files.entries()) {
    const label = `[${index + 1}/${files.length}] ${path.relative(args.folder, file)}`;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error('larger than 100 MB');
      // ingestEpub moves its input into the library, so hand it a copy.
      const tmpPath = path.join(DATA_DIR, 'tmp', `import-${randomUUID()}.epub`);
      fs.copyFileSync(file, tmpPath);
      const result = await ingestEpub({ tmpPath, originalName: path.basename(file), userId: user.id });
      if (result.status === 201) {
        const calibre = readCalibreOpf(file);
        if (calibre) applyCalibreMetadata(result.body.id, user.id, calibre);
        counts.added++;
        console.log(`${label}: added "${calibre?.title || result.body.title}"${result.body.possible_duplicate ? ` (looks like "${result.body.possible_duplicate.title}", already in the library)` : ''}`);
      } else if (result.status === 409) {
        counts.duplicate++;
        console.log(`${label}: already in the library`);
      } else {
        counts.failed++;
        console.log(`${label}: skipped (${result.body.error})`);
      }
    } catch (error) {
      counts.failed++;
      console.log(`${label}: failed (${error.message})`);
    }
  }
  console.log(`Done: ${counts.added} added, ${counts.duplicate} already present, ${counts.failed} skipped.`);
}

if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 100));
}

module.exports = { findEpubs, readCalibreOpf };
