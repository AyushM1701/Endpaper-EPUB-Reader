'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { text, validateUuidParam } = require('../lib/validation');
const { requireAdmin } = require('./users');

const router = express.Router();

/**
 * GET /api/collections
 * Returns all collections, each with an array of book IDs.
 */
router.get('/api/collections', (req, res) => {
  const collections = db.prepare('SELECT * FROM collections ORDER BY name ASC').all();

  const memberships = db.prepare('SELECT collection_id, book_id FROM book_collections').all();
  const bookIdsByCollection = new Map(collections.map(collection => [collection.id, []]));
  for (const membership of memberships) {
    const bookIds = bookIdsByCollection.get(membership.collection_id);
    if (bookIds) bookIds.push(membership.book_id);
  }
  const result = collections.map(collection => ({
    ...collection,
    book_ids: bookIdsByCollection.get(collection.id),
  }));

  res.json(result);
});

/**
 * POST /api/collections
 * Body: { name }
 */
// Collections and their memberships are global shared-library metadata.
// Only admins may change them; every authenticated user can still browse and
// filter by them.
router.post('/api/collections', requireAdmin, (req, res) => {
  let name;
  try {
    name = text(req.body.name, { required: true, max: 80, field: 'Collection name' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const id = randomUUID();
  try {
    const existing = db.prepare('SELECT id FROM collections WHERE lower(name) = lower(?)').get(name);
    if (existing) return res.status(409).json({ error: 'A collection with that name already exists' });
    db.prepare('INSERT INTO collections (id, name) VALUES (?, ?)').run(id, name);
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
 * PATCH /api/collections/:id
 * Rename a collection without changing its memberships.
 */
router.patch('/api/collections/:id', validateUuidParam('id'), requireAdmin, (req, res) => {
  const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(req.params.id);
  if (!collection) return res.status(404).json({ error: 'Collection not found' });

  let name;
  try {
    name = text(req.body.name, { required: true, max: 80, field: 'Collection name' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const duplicate = db.prepare('SELECT id FROM collections WHERE lower(name) = lower(?) AND id != ?').get(name, req.params.id);
  if (duplicate) return res.status(409).json({ error: 'A collection with that name already exists' });
  try {
    db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(name, req.params.id);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A collection with that name already exists' });
    }
    throw err;
  }
  res.json(db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id));
});

/**
 * DELETE /api/collections/:id
 * Deleting a collection only removes its grouping, never the books in it.
 */
router.delete('/api/collections/:id', validateUuidParam('id'), requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM collections WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Collection not found' });
  res.json({ ok: true });
});

/**
 * POST /api/books/:id/collections/:collectionId
 * Add a book to a collection.
 */
router.post('/api/books/:id/collections/:collectionId', validateUuidParam('id', 'collectionId'), requireAdmin, (req, res) => {
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
router.delete('/api/books/:id/collections/:collectionId', validateUuidParam('id', 'collectionId'), requireAdmin, (req, res) => {
  db.prepare(
    'DELETE FROM book_collections WHERE book_id = ? AND collection_id = ?'
  ).run(req.params.id, req.params.collectionId);
  res.json({ ok: true });
});

module.exports = router;
