'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

/**
 * GET /api/books/:id/highlights
 * Returns all highlights for a book.
 */
router.get('/api/books/:id/highlights', (req, res) => {
  const highlights = db.prepare(
    'SELECT * FROM highlights WHERE book_id = ? ORDER BY created_at ASC'
  ).all(req.params.id);
  res.json(highlights);
});

/**
 * POST /api/books/:id/highlights
 * Body: { cfi_range, excerpt, note, color, chapter }
 */
router.post('/api/books/:id/highlights', (req, res) => {
  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const { cfi_range, excerpt, note, color, chapter } = req.body;

  if (!cfi_range) return res.status(400).json({ error: 'cfi_range is required' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO highlights (id, book_id, cfi_range, excerpt, note, color, chapter)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, cfi_range, excerpt || null, note || null, color || 'gold', chapter || null);

  const highlight = db.prepare('SELECT * FROM highlights WHERE id = ?').get(id);
  res.status(201).json(highlight);
});

/**
 * PATCH /api/highlights/:id
 * Body: { color, note }
 */
router.patch('/api/highlights/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM highlights WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Highlight not found' });

  const allowed = ['color', 'note'];
  const updates = [];
  const values = {};

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = @${key}`);
      values[key] = req.body[key];
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  values.id = req.params.id;
  db.prepare(`UPDATE highlights SET ${updates.join(', ')} WHERE id = @id`).run(values);

  const updated = db.prepare('SELECT * FROM highlights WHERE id = ?').get(req.params.id);
  res.json(updated);
});

/**
 * DELETE /api/highlights/:id
 */
router.delete('/api/highlights/:id', (req, res) => {
  const result = db.prepare('DELETE FROM highlights WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Highlight not found' });
  res.json({ ok: true });
});

module.exports = router;
