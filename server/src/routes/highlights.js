'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { text, validateUuidParam } = require('../lib/validation');

const HIGHLIGHT_COLORS = new Set(['gold', '#F2D94E', '#8FD19E', '#8FC1E3', '#E8A0BF']);

function color(value) {
  const result = value || 'gold';
  if (typeof result !== 'string' || !HIGHLIGHT_COLORS.has(result)) throw new Error('color is invalid');
  return result;
}

const router = express.Router();

/**
 * GET /api/books/:id/highlights
 * Returns all highlights for a book.
 */
router.get('/api/books/:id/highlights', validateUuidParam('id'), (req, res) => {
  const highlights = db.prepare(
    'SELECT * FROM highlights WHERE book_id = ? ORDER BY created_at ASC'
  ).all(req.params.id);
  res.json(highlights);
});

/**
 * POST /api/books/:id/highlights
 * Body: { cfi_range, excerpt, note, color, chapter }
 */
router.post('/api/books/:id/highlights', validateUuidParam('id'), (req, res) => {
  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  let cfiRange, safeExcerpt, safeNote, safeColor, safeChapter;
  try {
    cfiRange = text(req.body.cfi_range, { required: true, max: 10000, field: 'cfi_range' });
    safeExcerpt = text(req.body.excerpt, { max: 1000, field: 'excerpt' });
    safeNote = text(req.body.note, { max: 2000, field: 'note' });
    safeColor = color(req.body.color);
    safeChapter = text(req.body.chapter, { max: 500, field: 'chapter' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO highlights (id, book_id, cfi_range, excerpt, note, color, chapter)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, cfiRange, safeExcerpt, safeNote, safeColor, safeChapter);

  const highlight = db.prepare('SELECT * FROM highlights WHERE id = ?').get(id);
  res.status(201).json(highlight);
});

/**
 * PATCH /api/highlights/:id
 * Body: { color, note }
 */
router.patch('/api/highlights/:id', validateUuidParam('id'), (req, res) => {
  const existing = db.prepare('SELECT id FROM highlights WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Highlight not found' });

  const updates = [];
  const values = {};

  try {
    if (req.body.color !== undefined) {
      values.color = color(req.body.color);
      updates.push('color = @color');
    }
    if (req.body.note !== undefined) {
      values.note = text(req.body.note, { max: 2000, field: 'note' });
      updates.push('note = @note');
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
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
router.delete('/api/highlights/:id', validateUuidParam('id'), (req, res) => {
  const result = db.prepare('DELETE FROM highlights WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Highlight not found' });
  res.json({ ok: true });
});

module.exports = router;
