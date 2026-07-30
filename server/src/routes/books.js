'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { extractMeta } = require('../lib/epubMeta');

const router = express.Router();

const DATA_DIR = path.resolve(__dirname, '../../../data');
const BOOKS_DIR = path.join(DATA_DIR, 'books');
const COVERS_DIR = path.join(DATA_DIR, 'covers');

// Spine colors for books without covers (matches frontend)
const SPINE_COLORS = ['#3F5D4C','#7A3B32','#3B4A6B','#6B4C3B','#5B3F5D','#2C4237','#8A6A2F','#43506B'];

// Multer config: store uploaded EPUBs temporarily
const upload = multer({
  dest: path.join(DATA_DIR, 'tmp'),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.epub')) {
      cb(null, true);
    } else {
      cb(new Error('Only .epub files are allowed'));
    }
  },
});

/**
 * GET /api/books
 * Returns the full library listing (metadata only, no file content).
 */
router.get('/api/books', (req, res) => {
  const books = db.prepare(`
    SELECT id, title, author, series, series_index, cover_path, cover_color,
           status, rating, progress_percent, last_location_cfi,
           added_at, last_opened_at, file_size
    FROM books ORDER BY added_at DESC
  `).all();

  res.json(books);
});

/**
 * POST /api/books
 * Multipart upload of an EPUB file.
 * Parses metadata + extracts cover, inserts DB row, returns the book object.
 */
router.post('/api/books', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const id = uuidv4();
    const ext = '.epub';
    const filename = id + ext;
    const destPath = path.join(BOOKS_DIR, filename);

    // Move from multer tmp to books dir
    fs.renameSync(req.file.path, destPath);

    const fileSize = fs.statSync(destPath).size;

    // Extract metadata and cover from EPUB
    let meta;
    try {
      meta = extractMeta(destPath, id, COVERS_DIR);
    } catch (e) {
      console.error('Metadata extraction error:', e.message);
      meta = { title: '', author: '', series: null, seriesIndex: null, coverPath: null };
    }

    // Fallback title from filename
    const title = meta.title || req.file.originalname.replace(/\.epub$/i, '').replace(/[_]+/g, ' ').trim();

    // Pick a spine color
    const bookCount = db.prepare('SELECT COUNT(*) as n FROM books').get().n;
    const coverColor = SPINE_COLORS[bookCount % SPINE_COLORS.length];

    const book = {
      id,
      title,
      author: meta.author || null,
      series: meta.series || null,
      series_index: meta.seriesIndex || null,
      filename,
      file_format: 'epub',
      file_size: fileSize,
      cover_path: meta.coverPath || null,
      cover_color: coverColor,
      status: 'unread',
      rating: null,
      progress_percent: 0,
      last_location_cfi: null,
    };

    db.prepare(`
      INSERT INTO books (id, title, author, series, series_index, filename, file_format,
                         file_size, cover_path, cover_color, status, rating,
                         progress_percent, last_location_cfi)
      VALUES (@id, @title, @author, @series, @series_index, @filename, @file_format,
              @file_size, @cover_path, @cover_color, @status, @rating,
              @progress_percent, @last_location_cfi)
    `).run(book);

    // Return the full book row
    const inserted = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
    res.status(201).json(inserted);
  } catch (err) {
    // Clean up tmp file on error
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

/**
 * GET /api/books/:id
 * Returns metadata for a single book.
 */
router.get('/api/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  res.json(book);
});

/**
 * GET /api/books/:id/file
 * Streams the EPUB file.
 */
router.get('/api/books/:id/file', (req, res) => {
  const book = db.prepare('SELECT filename FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const filePath = path.join(BOOKS_DIR, book.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

  res.setHeader('Content-Type', 'application/epub+zip');
  res.setHeader('Content-Disposition', `inline; filename="${book.filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

/**
 * GET /api/books/:id/cover
 * Streams the cover image, or returns a 204 if no cover exists.
 */
router.get('/api/books/:id/cover', (req, res) => {
  const book = db.prepare('SELECT cover_path FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  if (!book.cover_path) return res.status(204).end();

  const coverPath = path.join(COVERS_DIR, book.cover_path);
  if (!fs.existsSync(coverPath)) return res.status(204).end();

  const ext = path.extname(book.cover_path).toLowerCase();
  const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
  res.setHeader('Content-Type', mimeTypes[ext] || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(coverPath).pipe(res);
});

/**
 * PATCH /api/books/:id
 * Update mutable fields: progress_percent, last_location_cfi, status, rating, last_opened_at, title, author.
 */
router.patch('/api/books/:id', (req, res) => {
  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const allowed = ['progress_percent', 'last_location_cfi', 'status', 'rating', 'last_opened_at', 'title', 'author'];
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
  db.prepare(`UPDATE books SET ${updates.join(', ')} WHERE id = @id`).run(values);

  const updated = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  res.json(updated);
});

/**
 * DELETE /api/books/:id
 * Removes DB row + EPUB file + cover file.
 */
router.delete('/api/books/:id', (req, res) => {
  const book = db.prepare('SELECT filename, cover_path FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  // Delete files from disk
  const filePath = path.join(BOOKS_DIR, book.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  if (book.cover_path) {
    const coverPath = path.join(COVERS_DIR, book.cover_path);
    if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
  }

  // Delete from DB (cascades to bookmarks, highlights, sessions, book_collections)
  db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);

  res.json({ ok: true });
});

module.exports = router;
