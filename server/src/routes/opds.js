'use strict';

// OPDS 1.2 catalogue so reading apps (KOReader, Moon+ Reader, Thorium,
// Panels, …) can browse the shared library and download EPUBs.
//
// Apps authenticate with HTTP Basic: the Endpaper username plus an app key the
// user creates under Account → Passphrase & devices. The key is not the
// passphrase, is stored only as a SHA-256 hash, and can be revoked at any time.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { DATA_DIR } = require('../lib/paths');
const { isUuid, isBookFilename, isCoverFilename } = require('../lib/validation');
const searchIndex = require('../lib/searchIndex');

const router = express.Router();
const PAGE_SIZE = 50;
const ATOM = 'application/atom+xml';
const NAVIGATION = `${ATOM};profile=opds-catalog;kind=navigation`;
const ACQUISITION = `${ATOM};profile=opds-catalog;kind=acquisition`;

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function xml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
}

const failedOpdsLogins = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => res.status(429).type('text/plain').send('Too many attempts. Try again later.'),
});

function opdsAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
  const challenge = () => res.set('WWW-Authenticate', 'Basic realm="Endpaper", charset="UTF-8"').status(401).type('text/plain').send('Sign in with your Endpaper username and an app key.');
  if (!match) return challenge();
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 1) return challenge();
  const username = decoded.slice(0, separator);
  const key = decoded.slice(separator + 1);
  const user = db.prepare('SELECT id, opds_key_hash FROM users WHERE lower(username) = lower(?)').get(username);
  const expected = Buffer.from(user?.opds_key_hash || '0'.repeat(64), 'hex');
  const actual = Buffer.from(hashKey(key), 'hex');
  // Compare in constant time, and even for unknown users, so timing reveals nothing.
  const valid = crypto.timingSafeEqual(expected, actual) && Boolean(user?.opds_key_hash);
  if (!valid) return challenge();
  req.user_id = user.id;
  res.set('Cache-Control', 'private, no-store');
  next();
}

function feed({ id, title, kind, selfHref, entries, links = [] }) {
  const updated = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <id>${xml(id)}</id>
  <title>${xml(title)}</title>
  <updated>${updated}</updated>
  <author><name>Endpaper</name></author>
  <link rel="self" href="${xml(selfHref)}" type="${kind}"/>
  <link rel="start" href="/opds" type="${NAVIGATION}"/>
  <link rel="search" href="/opds/opensearch.xml" type="application/opensearchdescription+xml"/>
${links.map(link => `  <link rel="${xml(link.rel)}" href="${xml(link.href)}" type="${xml(link.type || kind)}"/>`).join('\n')}
${entries.join('\n')}
</feed>`;
}

function bookEntry(book) {
  const updated = new Date(String(book.added_at || '').replace(' ', 'T') + (String(book.added_at || '').includes('Z') ? '' : 'Z'));
  const tags = String(book.tags || '').split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 12);
  return `  <entry>
    <id>urn:uuid:${xml(book.id)}</id>
    <title>${xml(book.title)}</title>
    ${book.author ? `<author><name>${xml(book.author)}</name></author>` : ''}
    <updated>${isNaN(updated.getTime()) ? new Date().toISOString() : updated.toISOString()}</updated>
    ${book.isbn ? `<dc:identifier>urn:isbn:${xml(book.isbn)}</dc:identifier>` : ''}
    ${book.description ? `<summary type="text">${xml(book.description.slice(0, 2000))}</summary>` : ''}
    ${tags.map(tag => `<category term="${xml(tag)}" label="${xml(tag)}"/>`).join('')}
    ${book.series ? `<category scheme="http://calibre-ebook.com/series" term="${xml(book.series)}" label="${xml(book.series)}${book.series_index != null ? ` #${xml(book.series_index)}` : ''}"/>` : ''}
    <link rel="http://opds-spec.org/acquisition" href="/opds/books/${xml(book.id)}/file" type="application/epub+zip"/>
    ${book.cover_path ? `<link rel="http://opds-spec.org/image" href="/opds/books/${xml(book.id)}/cover" type="image/webp"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="/opds/books/${xml(book.id)}/cover" type="image/webp"/>` : ''}
  </entry>`;
}

function navEntry(id, title, href, content, type = ACQUISITION) {
  return `  <entry>
    <id>${xml(id)}</id>
    <title>${xml(title)}</title>
    <updated>${new Date().toISOString()}</updated>
    <content type="text">${xml(content)}</content>
    <link rel="subsection" href="${xml(href)}" type="${type}"/>
  </entry>`;
}

const BOOK_COLUMNS = 'id, title, author, series, series_index, description, isbn, tags, cover_path, added_at, filename';

function pageOf(req) {
  return Math.max(1, Math.min(10_000, parseInt(String(req.query.page || '1'), 10) || 1));
}

function acquisitionFeed(res, { id, title, base, rows, total, page, extraQuery = '' }) {
  const links = [];
  if (page > 1) links.push({ rel: 'previous', href: `${base}?page=${page - 1}${extraQuery}` });
  if (page * PAGE_SIZE < total) links.push({ rel: 'next', href: `${base}?page=${page + 1}${extraQuery}` });
  res.type(ACQUISITION).send(feed({ id, title, kind: ACQUISITION, selfHref: `${base}?page=${page}${extraQuery}`, entries: rows.map(bookEntry), links }));
}

router.use('/opds', failedOpdsLogins, opdsAuth);

router.get('/opds', (req, res) => {
  res.type(NAVIGATION).send(feed({
    id: 'urn:endpaper:root', title: 'Endpaper library', kind: NAVIGATION, selfHref: '/opds',
    entries: [
      navEntry('urn:endpaper:new', 'Recently added', '/opds/new', 'The newest books in the shared library'),
      navEntry('urn:endpaper:all', 'All books', '/opds/all', 'Every book, by title'),
      navEntry('urn:endpaper:reading', 'Continue reading', '/opds/reading', 'Books you have started'),
      navEntry('urn:endpaper:want', 'Want to read', '/opds/want', 'Books you saved for later'),
    ],
  }));
});

router.get('/opds/opensearch.xml', (req, res) => {
  res.type('application/opensearchdescription+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Endpaper</ShortName>
  <Description>Search the Endpaper library</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="${ACQUISITION}" template="/opds/search?q={searchTerms}"/>
</OpenSearchDescription>`);
});

for (const [route, title, where, order] of [
  ['/opds/new', 'Recently added', '1 = 1', 'b.added_at DESC'],
  ['/opds/all', 'All books', '1 = 1', 'b.title COLLATE NOCASE ASC'],
  ['/opds/reading', 'Continue reading', "ub.status = 'reading'", 'ub.last_opened_at DESC'],
  ['/opds/want', 'Want to read', 'ub.want_to_read = 1', 'b.title COLLATE NOCASE ASC'],
]) {
  router.get(route, (req, res) => {
    const page = pageOf(req);
    const from = `FROM books b LEFT JOIN user_books ub ON ub.book_id = b.id AND ub.user_id = ? WHERE ${where}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(req.user_id).n;
    const rows = db.prepare(`SELECT ${BOOK_COLUMNS.split(', ').map(column => `b.${column}`).join(', ')} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`).all(req.user_id, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    acquisitionFeed(res, { id: `urn:endpaper:${route.split('/').pop()}`, title, base: route, rows, total, page });
  });
}

router.get('/opds/search', (req, res) => {
  const q = String((Array.isArray(req.query.q) ? req.query.q[0] : req.query.q) || '').trim().slice(0, 200);
  const page = pageOf(req);
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const metadataIds = q ? db.prepare(`SELECT id FROM books WHERE title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR series LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR isbn LIKE ? ESCAPE '\\' ORDER BY title COLLATE NOCASE`).all(like, like, like, like, like).map(row => row.id) : [];
  // Then books whose text matches, after the title/author matches.
  const textIds = q ? searchIndex.search(q, { limit: 200, perBook: 1 }).map(row => row.book_id) : [];
  const ids = [...new Set([...metadataIds, ...textIds])];
  const pageIds = ids.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const rows = pageIds.map(id => db.prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE id = ?`).get(id)).filter(Boolean);
  acquisitionFeed(res, { id: 'urn:endpaper:search', title: `Search: ${q}`, base: '/opds/search', rows, total: ids.length, page, extraQuery: `&q=${encodeURIComponent(q)}` });
});

router.get('/opds/books/:id/file', (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).end();
  const book = db.prepare('SELECT title, filename FROM books WHERE id = ?').get(req.params.id);
  if (!book || !isBookFilename(book.filename)) return res.status(404).end();
  const safeName = `${String(book.title || 'book').replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().slice(0, 120) || 'book'}.epub`;
  res.attachment(safeName);
  res.type('application/epub+zip');
  res.sendFile(path.join(DATA_DIR, 'books', book.filename));
});

router.get('/opds/books/:id/cover', (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).end();
  const book = db.prepare('SELECT cover_path FROM books WHERE id = ?').get(req.params.id);
  if (!book || !isCoverFilename(book.cover_path)) return res.status(404).end();
  res.sendFile(path.join(DATA_DIR, 'covers', book.cover_path));
});

module.exports = router;
module.exports.hashOpdsKey = hashKey;
