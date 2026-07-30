'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const db = require('../db');
const { extractMeta, validateEpub } = require('../lib/epubMeta');
const { isBookFilename, isCoverFilename, text, number, validateUuidParam } = require('../lib/validation');

const router = express.Router();

const DATA_DIR = path.resolve(__dirname, '../../../data');
const BOOKS_DIR = path.join(DATA_DIR, 'books');
const COVERS_DIR = path.join(DATA_DIR, 'covers');

// Spine colors for books without covers (matches frontend)
const SPINE_COLORS = ['#3F5D4C','#7A3B32','#3B4A6B','#6B4C3B','#5B3F5D','#2C4237','#8A6A2F','#43506B'];

// Multer config: store uploaded EPUBs temporarily
const upload = multer({
  dest: path.join(DATA_DIR, 'tmp'),
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 10 }, // 100MB max
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
  let destPath = null;
  let coverPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const id = randomUUID();
    const ext = '.epub';
    const filename = id + ext;
    destPath = path.join(BOOKS_DIR, filename);

    // Verify the archive before moving it into the permanent library.
    validateEpub(req.file.path);

    // Move from multer tmp to books dir
    fs.renameSync(req.file.path, destPath);

    const fileSize = fs.statSync(destPath).size;

    // Extract metadata and cover from EPUB
    let meta;
    try {
      meta = extractMeta(destPath, id, COVERS_DIR);
      coverPath = meta.coverPath;
    } catch (e) {
      console.error('Metadata extraction error:', e.message);
      meta = { title: '', author: '', series: null, seriesIndex: null, coverPath: null };
    }

    // Fallback title from filename
    const fallbackTitle = req.file.originalname.replace(/\.epub$/i, '').replace(/[_]+/g, ' ').trim();
    const title = text(meta.title || fallbackTitle || 'Untitled book', { required: true, max: 500, field: 'title' });

    // Pick a spine color
    const bookCount = db.prepare('SELECT COUNT(*) as n FROM books').get().n;
    const coverColor = SPINE_COLORS[bookCount % SPINE_COLORS.length];

    const book = {
      id,
      title,
      author: text(meta.author, { max: 500, field: 'author' }),
      series: text(meta.series, { max: 500, field: 'series' }),
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
    // Clean up whichever stage received the file on error.
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    if (destPath && fs.existsSync(destPath)) {
      try { fs.unlinkSync(destPath); } catch (e) {}
    }
    if (coverPath && isCoverFilename(coverPath)) {
      const createdCoverPath = path.join(COVERS_DIR, coverPath);
      if (fs.existsSync(createdCoverPath)) {
        try { fs.unlinkSync(createdCoverPath); } catch (e) {}
      }
    }
    console.error('Upload error:', err);
    const isClientError = /valid EPUB|must be/.test(err.message);
    res.status(isClientError ? 400 : 500).json({ error: isClientError ? err.message : 'Upload failed' });
  }
});

/**
 * GET /api/books/:id
 * Returns metadata for a single book.
 */
router.get('/api/books/:id', validateUuidParam('id'), (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  res.json(book);
});

/**
 * GET /api/books/:id/file
 * Streams the EPUB file.
 */
router.get('/api/books/:id/file', validateUuidParam('id'), (req, res) => {
  const book = db.prepare('SELECT filename FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  if (!isBookFilename(book.filename)) return res.status(500).json({ error: 'Invalid book file record' });
  const filePath = path.join(BOOKS_DIR, book.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

  res.setHeader('Content-Type', 'application/epub+zip');
  res.setHeader('Content-Disposition', `inline; filename="${book.filename}"`);
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'Could not read book file' });
    else res.destroy();
  });
  stream.pipe(res);
});

/**
 * GET /api/books/:id/cover
 * Streams the cover image, or returns a 204 if no cover exists.
 */
router.get('/api/books/:id/cover', validateUuidParam('id'), (req, res) => {
  const book = db.prepare('SELECT cover_path FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  if (!book.cover_path) return res.status(204).end();
  if (!isCoverFilename(book.cover_path)) return res.status(500).json({ error: 'Invalid cover file record' });

  const coverPath = path.join(COVERS_DIR, book.cover_path);
  if (!fs.existsSync(coverPath)) return res.status(204).end();

  const ext = path.extname(book.cover_path).toLowerCase();
  const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
  res.setHeader('Content-Type', mimeTypes[ext] || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  const stream = fs.createReadStream(coverPath);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'Could not read cover image' });
    else res.destroy();
  });
  stream.pipe(res);
});

/**
 * PATCH /api/books/:id
 * Update mutable fields: progress_percent, last_location_cfi, status, rating, last_opened_at, title, author.
 */
router.patch('/api/books/:id', validateUuidParam('id'), (req, res) => {
  const book = db.prepare('SELECT id, status, progress_percent FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const updates = [];
  const values = {};

  try {
    if (req.body.progress_percent !== undefined) {
      values.progress_percent = number(req.body.progress_percent, { min: 0, max: 100, field: 'progress_percent' });
      updates.push('progress_percent = @progress_percent');
    }
    if (req.body.last_location_cfi !== undefined) {
      values.last_location_cfi = text(req.body.last_location_cfi, { max: 10000, field: 'last_location_cfi' });
      updates.push('last_location_cfi = @last_location_cfi');
    }
    if (req.body.status !== undefined) {
      if (!['unread', 'reading', 'finished'].includes(req.body.status)) throw new Error('status is invalid');
      values.status = req.body.status;
      updates.push('status = @status');
    }
    if (req.body.rating !== undefined) {
      values.rating = number(req.body.rating, { min: 1, max: 5, nullable: true, field: 'rating' });
      updates.push('rating = @rating');
    }
    if (req.body.last_opened_at !== undefined) {
      const date = new Date(req.body.last_opened_at);
      if (typeof req.body.last_opened_at !== 'string' || Number.isNaN(date.getTime())) throw new Error('last_opened_at is invalid');
      values.last_opened_at = date.toISOString();
      updates.push('last_opened_at = @last_opened_at');
    }
    if (req.body.title !== undefined) {
      values.title = text(req.body.title, { required: true, max: 500, field: 'title' });
      updates.push('title = @title');
    }
    if (req.body.author !== undefined) {
      values.author = text(req.body.author, { max: 500, field: 'author' });
      updates.push('author = @author');
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  values.id = req.params.id;

  // Auto-update status based on progress
  const newProgress = values.progress_percent !== undefined ? values.progress_percent : book.progress_percent;
  const currentStatus = values.status || book.status;
  if (newProgress >= 95 && currentStatus !== 'finished') {
    values.status = 'finished';
    updates.push('status = @status');
  } else if (newProgress > 0 && currentStatus === 'unread') {
    values.status = 'reading';
    updates.push('status = @status');
  }

  db.prepare(`UPDATE books SET ${updates.join(', ')} WHERE id = @id`).run(values);

  const updated = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  res.json(updated);
});

/**
 * DELETE /api/books/:id
 * Removes DB row + EPUB file + cover file.
 */
router.delete('/api/books/:id', validateUuidParam('id'), (req, res) => {
  const book = db.prepare('SELECT filename, cover_path FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  // Delete files from disk
  if (!isBookFilename(book.filename)) return res.status(500).json({ error: 'Invalid book file record' });
  const filePath = path.join(BOOKS_DIR, book.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  if (book.cover_path && isCoverFilename(book.cover_path)) {
    const coverPath = path.join(COVERS_DIR, book.cover_path);
    if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
  }

  // Delete from DB (cascades to bookmarks, highlights, sessions, book_collections)
  db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);

  res.json({ ok: true });
});

module.exports = router;
