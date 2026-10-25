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

function tags(value) {
  if (value == null || value === '') return null;
  const values = Array.isArray(value) ? value : String(value).split(',');
  const normalized = [...new Set(values.map(item => String(item).trim().toLowerCase()).filter(Boolean))];
  if (normalized.length > 12 || normalized.some(item => item.length > 40)) throw new Error('tags are invalid');
  return JSON.stringify(normalized);
}

const MAX_HIGHLIGHT_PAGE = 500;

function firstQueryString(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first.trim() : '';
}

/**
 * GET /api/highlights?q=&tag=&limit=&offset=
 * Filters in SQL and returns one page, newest first. X-Total-Count carries the
 * number of matches so clients can fetch further pages.
 */
router.get('/api/highlights', (req, res) => {
  const query = firstQueryString(req.query.q).toLowerCase();
  const tag = firstQueryString(req.query.tag).toLowerCase();
  const limit = Math.min(MAX_HIGHLIGHT_PAGE, Math.max(1, parseInt(firstQueryString(req.query.limit), 10) || MAX_HIGHLIGHT_PAGE));
  const offset = Math.max(0, parseInt(firstQueryString(req.query.offset), 10) || 0);
  const where = ['h.user_id = ?'];
  const params = [req.user_id];
  if (query) {
    where.push("lower(COALESCE(h.excerpt, '') || ' ' || COALESCE(h.note, '') || ' ' || COALESCE(h.chapter, '') || ' ' || COALESCE(b.title, '')) LIKE ? ESCAPE '\\'");
    params.push(`%${query.replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(h.tags) WHERE json_each.value = ?)');
    params.push(tag);
  }
  const from = `FROM highlights h JOIN books b ON b.id = h.book_id WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params).n;
  const rows = db.prepare(`
    SELECT h.*, b.title AS book_title, b.author AS book_author
    ${from} ORDER BY h.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  res.set('X-Total-Count', String(total));
  res.json(rows.map(row => ({ ...row, tags: row.tags ? JSON.parse(row.tags) : [] })));
});

/**
 * GET /api/books/:id/highlights
 * Returns all highlights for a book.
 */
router.get('/api/books/:id/highlights', validateUuidParam('id'), (req, res) => {
  const highlights = db.prepare(
    'SELECT * FROM highlights WHERE book_id = ? AND user_id = ? ORDER BY created_at ASC'
  ).all(req.params.id, req.user_id);
  res.json(highlights.map(item => ({ ...item, tags: item.tags ? JSON.parse(item.tags) : [] })));
});

/**
 * POST /api/books/:id/highlights
 * Body: { cfi_range, excerpt, note, color, chapter }
 */
router.post('/api/books/:id/highlights', validateUuidParam('id'), (req, res) => {
  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  let cfiRange, safeExcerpt, safeNote, safeColor, safeChapter, safeTags;
  try {
    cfiRange = text(req.body.cfi_range, { required: true, max: 10000, field: 'cfi_range' });
    safeExcerpt = text(req.body.excerpt, { max: 1000, field: 'excerpt' });
    safeNote = text(req.body.note, { max: 2000, field: 'note' });
    safeColor = color(req.body.color);
    safeChapter = text(req.body.chapter, { max: 500, field: 'chapter' });
    safeTags = tags(req.body.tags);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO highlights (id, user_id, book_id, cfi_range, excerpt, note, color, chapter, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user_id, req.params.id, cfiRange, safeExcerpt, safeNote, safeColor, safeChapter, safeTags);

  const highlight = db.prepare('SELECT * FROM highlights WHERE id = ?').get(id);
  res.status(201).json({ ...highlight, tags: highlight.tags ? JSON.parse(highlight.tags) : [] });
});

/**
 * PATCH /api/highlights/:id
 * Body: { color, note }
 */
router.patch('/api/highlights/:id', validateUuidParam('id'), (req, res) => {
  const existing = db.prepare('SELECT id FROM highlights WHERE id = ? AND user_id = ?').get(req.params.id, req.user_id);
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
    if (req.body.tags !== undefined) {
      values.tags = tags(req.body.tags);
      updates.push('tags = @tags');
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  values.id = req.params.id;
  values.user_id = req.user_id;
  db.prepare(`UPDATE highlights SET ${updates.join(', ')} WHERE id = @id AND user_id = @user_id`).run(values);

  const updated = db.prepare('SELECT * FROM highlights WHERE id = ?').get(req.params.id);
  res.json({ ...updated, tags: updated.tags ? JSON.parse(updated.tags) : [] });
});

/**
 * DELETE /api/highlights/:id
 */
router.delete('/api/highlights/:id', validateUuidParam('id'), (req, res) => {
  const result = db.prepare('DELETE FROM highlights WHERE id = ? AND user_id = ?').run(req.params.id, req.user_id);
  if (result.changes === 0) return res.status(404).json({ error: 'Highlight not found' });
  res.json({ ok: true });
});

module.exports = router;
