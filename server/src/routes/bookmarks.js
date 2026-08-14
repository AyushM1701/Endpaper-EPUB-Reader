'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { text, number, validateUuidParam } = require('../lib/validation');

const router = express.Router();

/**
 * GET /api/books/:id/bookmarks
 * Returns all bookmarks for a book, sorted by progress_percent.
 */
router.get('/api/books/:id/bookmarks', validateUuidParam('id'), (req, res) => {
  const bookmarks = db.prepare(
    'SELECT * FROM bookmarks WHERE book_id = ? AND user_id = ? ORDER BY progress_percent ASC'
  ).all(req.params.id, req.user_id);
  res.json(bookmarks);
});

/**
 * POST /api/books/:id/bookmarks
 * Body: { cfi, label, chapter, progress_percent }
 */
router.post('/api/books/:id/bookmarks', validateUuidParam('id'), (req, res) => {
  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  let cfi, safeLabel, safeChapter, progress;
  try {
    cfi = text(req.body.cfi, { required: true, max: 10000, field: 'cfi' });
    safeLabel = text(req.body.label, { max: 500, field: 'label' });
    safeChapter = text(req.body.chapter, { max: 500, field: 'chapter' });
    progress = req.body.progress_percent === undefined ? 0 : number(req.body.progress_percent, { min: 0, max: 100, field: 'progress_percent' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO bookmarks (id, user_id, book_id, cfi, label, chapter, progress_percent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user_id, req.params.id, cfi, safeLabel, safeChapter, progress);

  const bookmark = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  res.status(201).json(bookmark);
});

/**
 * DELETE /api/bookmarks/:id
 */
router.delete('/api/bookmarks/:id', validateUuidParam('id'), (req, res) => {
  const result = db.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?').run(req.params.id, req.user_id);
  if (result.changes === 0) return res.status(404).json({ error: 'Bookmark not found' });
  res.json({ ok: true });
});

module.exports = router;
