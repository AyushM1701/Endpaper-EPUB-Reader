'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

/**
 * GET /api/collections
 * Returns all collections, each with an array of book IDs.
 */
router.get('/api/collections', (req, res) => {
  const collections = db.prepare('SELECT * FROM collections ORDER BY name ASC').all();

  const result = collections.map(c => {
    const bookIds = db.prepare(
      'SELECT book_id FROM book_collections WHERE collection_id = ?'
    ).all(c.id).map(r => r.book_id);
    return { ...c, book_ids: bookIds };
  });

  res.json(result);
});

/**
 * POST /api/collections
 * Body: { name }
 */
router.post('/api/collections', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Collection name is required' });
  }

  const id = uuidv4();
  try {
    db.prepare('INSERT INTO collections (id, name) VALUES (?, ?)').run(id, name.trim());
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A collection with that name already exists' });
    }
    throw err;
  }

  const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  res.status(201).json({ ...collection, book_ids: [] });
});

/**
 * POST /api/books/:id/collections/:collectionId
 * Add a book to a collection.
 */
router.post('/api/books/:id/collections/:collectionId', (req, res) => {
  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(req.params.collectionId);
  if (!collection) return res.status(404).json({ error: 'Collection not found' });

  try {
    db.prepare(
      'INSERT INTO book_collections (book_id, collection_id) VALUES (?, ?)'
    ).run(req.params.id, req.params.collectionId);
  } catch (err) {
    if (err.message.includes('UNIQUE') || err.message.includes('PRIMARY')) {
      return res.json({ ok: true, message: 'Already in collection' });
    }
    throw err;
  }

  res.status(201).json({ ok: true });
});

/**
 * DELETE /api/books/:id/collections/:collectionId
 * Remove a book from a collection.
 */
router.delete('/api/books/:id/collections/:collectionId', (req, res) => {
  db.prepare(
    'DELETE FROM book_collections WHERE book_id = ? AND collection_id = ?'
  ).run(req.params.id, req.params.collectionId);
  res.json({ ok: true });
});

module.exports = router;
