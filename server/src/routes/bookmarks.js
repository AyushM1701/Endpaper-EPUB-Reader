'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

/**
 * GET /api/books/:id/bookmarks
 * Returns all bookmarks for a book, sorted by progress_percent.
 */
router.get('/api/books/:id/bookmarks', (req, res) => {
  const bookmarks = db.prepare(
    'SELECT * FROM bookmarks WHERE book_id = ? ORDER BY progress_percent ASC'
  ).all(req.params.id);
  res.json(bookmarks);
});

/**
 * POST /api/books/:id/bookmarks
 * Body: { cfi, label, chapter, progress_percent }
 */
router.post('/api/books/:id/bookmarks', (req, res) => {
  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const { cfi, label, chapter, progress_percent } = req.body;

  if (!cfi) return res.status(400).json({ error: 'cfi is required' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO bookmarks (id, book_id, cfi, label, chapter, progress_percent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, cfi, label || null, chapter || null, progress_percent || 0);

  const bookmark = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  res.status(201).json(bookmark);
});

/**
 * DELETE /api/bookmarks/:id
 */
router.delete('/api/bookmarks/:id', (req, res) => {
  const result = db.prepare('DELETE FROM bookmarks WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Bookmark not found' });
  res.json({ ok: true });
});

module.exports = router;
