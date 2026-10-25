'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { text, number, clip, isHexColor, isUuid, isBookFilename, isCoverFilename } = require('../src/lib/validation');

test('validation accepts expected library identifiers and rejects traversal', () => {
  assert.equal(isUuid('123e4567-e89b-42d3-a456-426614174000'), true);
  assert.equal(isBookFilename('123e4567-e89b-42d3-a456-426614174000.epub'), true);
  assert.equal(isBookFilename('../book.epub'), false);
  assert.equal(isCoverFilename('123e4567-e89b-42d3-a456-426614174000.webp'), true);
  assert.equal(isCoverFilename('..\\cover.webp'), false);
});

test('text and number enforce bounds without coercing invalid values', () => {
  assert.equal(text('  A title  ', { required: true, max: 20, field: 'title' }), 'A title');
  assert.throws(() => text('', { required: true, field: 'title' }), /required/);
  assert.equal(number(98, { min: 0, max: 100, field: 'progress' }), 98);
  assert.throws(() => number('not-a-number', { field: 'progress' }), /number/);
  assert.equal(number(4, { min: 1, max: 5, integer: true, field: 'rating' }), 4);
  assert.throws(() => number(3.5, { min: 1, max: 5, integer: true, field: 'rating' }), /whole number/);
});

test('EPUB paths resolve like a browser and descriptions become plain text', () => {
  const { resolveArchivePath, htmlToText } = require('../src/lib/epubMeta');
  assert.equal(resolveArchivePath('OEBPS/', '../Images/Cover%20Art.jpg'), 'images/cover art.jpg');
  assert.equal(resolveArchivePath('OEBPS/', 'text/ch1.xhtml#start'), 'oebps/text/ch1.xhtml');
  assert.equal(resolveArchivePath('OEBPS/', 'bad%zz.xhtml'), 'oebps/bad%zz.xhtml');
  assert.equal(resolveArchivePath('', '../outside.xhtml'), null);
  assert.equal(htmlToText('<p>One &amp; two.</p><p>Three<br/>four</p>'), 'One & two.\n\nThree\nfour');
  assert.equal(htmlToText('5 < 6 and plain'), '5 < 6 and plain');
});

test('clip truncates untrusted metadata and isHexColor only accepts colors', () => {
  assert.equal(clip('  long blurb  ', 4), 'long');
  assert.equal(clip('   ', 10), null);
  assert.equal(clip(42, 10), null);
  assert.equal(isHexColor('#3F5D4C'), true);
  assert.equal(isHexColor('red"><b>'), false);
});

test('frontend escapes attribute quotes and builds UUIDs without a secure context', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../../public/app.js'), 'utf8');
  const extract = (start, end) => {
    const from = app.indexOf(start);
    const to = app.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing ${start}`);
    return app.slice(from, to + end.length);
  };
  const source = [
    extract('const HTML_ESCAPES', '};'),
    extract('function escapeHtml(', '\n}'),
    extract('const UUID_PATTERN', ';'),
    extract('function uuidV4(', '\n}'),
  ].join('\n');
  // Plain-HTTP pages have getRandomValues but no randomUUID.
  const context = { crypto: { getRandomValues: array => webcrypto.getRandomValues(array) } };
  vm.runInNewContext(`${source}\nthis.escapeHtml = escapeHtml; this.uuidV4 = uuidV4;`, context);
  assert.equal(context.escapeHtml(`x" onmouseover='a' <b>&`), 'x&quot; onmouseover=&#39;a&#39; &lt;b&gt;&amp;');
  for (let i = 0; i < 20; i++) assert.equal(isUuid(context.uuidV4()), true);
});

test('notebook export writes Readwise-compatible CSV and JSON', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../../public/app.js'), 'utf8');
  const from = app.indexOf('function csvCell(');
  const to = app.indexOf('async function exportNotebook(');
  assert.ok(from > 0 && to > from);
  const context = {};
  vm.runInNewContext(`${app.slice(from, to)}\nthis.notebookExport = notebookExport;`, context);
  const items = [{ excerpt: 'Line one,\n"quoted"', book_title: 'Book', book_author: 'Ann', note: 'n', chapter: 'Ch 1', created_at: '2026-10-18 10:00:00', tags: ['a'] }];
  const csv = context.notebookExport(items, 'csv');
  assert.equal(csv.body.split('\r\n')[0], 'Highlight,Title,Author,URL,Note,Location,Date');
  assert.match(csv.body, /^"Line one,\n""quoted""",Book,Ann,,n,Ch 1,/m);
  const json = JSON.parse(context.notebookExport(items, 'json').body);
  assert.equal(json.highlights[0].text, 'Line one,\n"quoted"');
  assert.equal(json.highlights[0].highlighted_at, '2026-10-18T10:00:00.000Z');
  assert.match(context.notebookExport(items, 'md').body, /## Book — Ann\n\n> Line one,\n> "quoted"/);
});

test('frontend runs without inline scripts so the CSP can forbid them', () => {
  const publicDir = path.resolve(__dirname, '../../public');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const sources = Object.fromEntries(['app.js', 'ui.js', 'mobile.js', 'control-icons.js', 'reader-index-cache.js', 'html-actions.js', 'sw-register.js']
    .map(file => [file, fs.readFileSync(path.join(publicDir, file), 'utf8')]));
  const server = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');

  const csp = /Content-Security-Policy', "([^"]+)"/.exec(server)[1];
  const scriptSrc = csp.split(';').map(part => part.trim()).find(part => part.startsWith('script-src'));
  assert.equal(scriptSrc, "script-src 'self'");

  assert.doesNotMatch(html, /\son[a-z]+\s*=\s*"/, 'index.html must not use inline event handlers');
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, 'index.html must not contain inline <script> blocks');
  for (const [file, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /\son[a-z]+\s*=\s*\\?["']/, `${file} must not generate inline event handlers`);
    assert.doesNotMatch(source, /setAttribute\(\s*['"]on[a-z]+['"]/, `${file} must not add inline event handlers at runtime`);
  }

  // Every data-on* handler must call a global function declaration that exists.
  const allJs = Object.values(sources).join('\n');
  const bodies = [...html.matchAll(/\sdata-on[a-z]+="([^"]*)"/g)].map(match => match[1]);
  assert.ok(bodies.length > 100);
  for (const body of bodies) {
    for (const [, name] of body.matchAll(/(?<![.\w])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (name === 'if') continue;
      assert.match(allJs, new RegExp(`(^|\\n)\\s*(async\\s+)?function\\s+${name}\\s*\\(`), `missing handler function ${name}`);
    }
  }
});

test('frontend keeps security and reader regression invariants', () => {
  const publicDir = path.resolve(__dirname, '../../public');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.doesNotMatch(app, /allow-same-origin allow-scripts/);
  // Dictionary lookups leave the server, so they must stay behind the Define action.
  assert.equal((app.match(/lookupDictionary\(/g) || []).length, 2);
  assert.match(app, /addEventListener\('visibilitychange'/);
  assert.match(app, /pct\s*>=\s*98/);
  assert.doesNotMatch(html, /cdnjs\.cloudflare\.com|fonts\.googleapis\.com/);
  assert.match(html, /\/jszip\.min\.js/);
  assert.match(html, /\/epub\.min\.js/);
  assert.ok(fs.existsSync(path.join(publicDir, 'jszip.min.js')));
});
