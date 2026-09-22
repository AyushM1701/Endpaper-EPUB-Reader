'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { text, number, isUuid, isBookFilename, isCoverFilename } = require('../src/lib/validation');

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
});

test('frontend keeps security and reader regression invariants', () => {
  const publicDir = path.resolve(__dirname, '../../public');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.doesNotMatch(app, /allow-same-origin allow-scripts/);
  assert.match(app, /pct\s*>=\s*98/);
  assert.doesNotMatch(html, /cdnjs\.cloudflare\.com|fonts\.googleapis\.com/);
  assert.match(html, /\/jszip\.min\.js/);
  assert.match(html, /\/epub\.min\.js/);
  assert.ok(fs.existsSync(path.join(publicDir, 'jszip.min.js')));
});
