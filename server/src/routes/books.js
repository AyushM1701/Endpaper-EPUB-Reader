'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { randomUUID } = crypto;
const { Worker } = require('worker_threads');
const sharp = require('sharp');
const db = require('../db');
const logger = require('../lib/logger');
const { extractMeta, validateEpub } = require('../lib/epubMeta');
const { BOOK_TEXT_LIMITS, isBookFilename, isCoverFilename, clip, text, number, userTags, parseUserTags, validateUuidParam } = require('../lib/validation');

// Rows returned to the client carry personal tags as an array.
function withUserFields(row) {
  if (!row) return row;
  return { ...row, want_to_read: Boolean(row.want_to_read), user_tags: parseUserTags(row.user_tags) };
}
const { requireAdmin } = require('./users');
const searchIndex = require('../lib/searchIndex');

const router = express.Router();

const { DATA_DIR } = require('../lib/paths');
const BOOKS_DIR = path.join(DATA_DIR, 'books');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const MAX_WORKERS = Math.max(1, Math.min(4, Number(process.env.EPUB_WORKERS) || 2));
const WORKER_TIMEOUT_MS = Math.max(10_000, Number(process.env.EPUB_WORKER_TIMEOUT_MS) || 120_000);
let activeWorkers = 0;
const workerQueue = [];

function drainWorkerQueue() {
  while (activeWorkers < MAX_WORKERS && workerQueue.length) {
    const job = workerQueue.shift();
    activeWorkers++;
    let settled = false;
    const worker = new Worker(path.join(__dirname, '../lib/epubWorker.js'), { workerData: job.workerData });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeWorkers--;
      if (error) job.reject(error); else job.resolve(value);
      drainWorkerQueue();
    };
    const timeout = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(new Error('EPUB processing timed out'));
    }, WORKER_TIMEOUT_MS);
    worker.on('message', message => {
      if (message.success) finish(null, message.meta);
      else {
        const error = new Error(message.error);
        error.validationError = message.validationError;
        finish(error);
      }
    });
    worker.on('error', error => finish(error));
    worker.on('exit', code => { if (code !== 0) finish(new Error(`Worker stopped with exit code ${code}`)); });
  }
}

function runEpubWorker(workerData) {
  return new Promise((resolve, reject) => {
    workerQueue.push({ workerData, resolve, reject });
    drainWorkerQueue();
  });
}

// Spine colors for books without covers (matches frontend)
const SPINE_COLORS = ['#3F5D4C','#7A3B32','#3B4A6B','#6B4C3B','#5B3F5D','#2C4237','#755926','#43506B'];

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
// Express turns ?a=1&a=2 into an array; use the first value of a repeated param.
function queryString(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : '';
}

router.get('/api/books', (req, res) => {
  const page = Math.max(1, parseInt(queryString(req.query.page)) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(queryString(req.query.limit)) || 20));
  const offset = (page - 1) * limit;

  const sort = queryString(req.query.sort) || 'recent';
  const filter = queryString(req.query.filter) || 'all';
  const search = queryString(req.query.search).trim();

  let whereClauses = [];
  let queryParams = [req.user_id]; // for user_books LEFT JOIN
  let whereParams = [];

  // Filter
  // Status is the source of truth: progress >= 98 sets it to finished, and a
  // reader can mark a book unread or finished by hand.
  if (filter === 'unread') {
    whereClauses.push("IFNULL(ub.status, 'unread') = 'unread'");
  } else if (filter === 'finished') {
    whereClauses.push("ub.status = 'finished'");
  } else if (filter === 'want') {
    whereClauses.push('ub.want_to_read = 1');
  } else if (filter.startsWith('col_')) {
    const colId = filter.substring(4);
    whereClauses.push('b.id IN (SELECT book_id FROM book_collections WHERE collection_id = ?)');
    whereParams.push(colId);
  }

  // Search
  if (search) {
    const literalSearch = search.replace(/[\\%_]/g, '\\$&');
    whereClauses.push("(b.title LIKE ? ESCAPE '\\' OR b.author LIKE ? ESCAPE '\\' OR b.series LIKE ? ESCAPE '\\' OR b.description LIKE ? ESCAPE '\\' OR b.tags LIKE ? ESCAPE '\\' OR b.isbn LIKE ? ESCAPE '\\')");
    for (let index = 0; index < 6; index++) whereParams.push(`%${literalSearch}%`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Order
  let orderSql = 'ORDER BY b.added_at DESC';
  if (sort === 'opened') orderSql = 'ORDER BY ub.last_opened_at DESC NULLS LAST';
  else if (sort === 'title') orderSql = 'ORDER BY b.title COLLATE NOCASE ASC';
  else if (sort === 'author') orderSql = 'ORDER BY b.author COLLATE NOCASE ASC';
  else if (sort === 'series') orderSql = 'ORDER BY CASE WHEN b.series IS NULL OR b.series = \'\' THEN 1 ELSE 0 END, b.series COLLATE NOCASE ASC, b.series_index ASC NULLS LAST, b.title COLLATE NOCASE ASC';
  else if (sort === 'progress') orderSql = 'ORDER BY IFNULL(ub.progress_percent, 0) DESC';

  const countSql = `
    SELECT COUNT(b.id) as n
    FROM books b
    LEFT JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
    ${whereSql}
  `;
  const total = db.prepare(countSql).get(...queryParams, ...whereParams).n;

  const dataSql = `
    SELECT b.id, b.title, b.author, b.series, b.series_index, b.description, b.isbn, b.tags, b.cover_path, b.cover_color,
           IFNULL(ub.status, 'unread') as status, ub.rating, IFNULL(ub.progress_percent, 0) as progress_percent, ub.last_location_cfi,
           b.added_at, ub.last_opened_at, b.file_size, b.word_count, IFNULL(ub.want_to_read, 0) AS want_to_read, ub.user_tags
     FROM books b
    LEFT JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
    ${whereSql}
    ${orderSql}
    LIMIT ? OFFSET ?
  `;
  
  const books = db.prepare(dataSql).all(...queryParams, ...whereParams, limit, offset).map(withUserFields);

  // Continue reading book (always fetch latest opened globally for the user)
  let continueBooks = [];
  if (page === 1 && !search && filter === 'all') {
    continueBooks = db.prepare(`
      SELECT b.id, b.title, b.author, b.series, b.series_index, b.description, b.isbn, b.tags, b.cover_path, b.cover_color,
             IFNULL(ub.status, 'unread') as status, ub.rating, IFNULL(ub.progress_percent, 0) as progress_percent, ub.last_location_cfi,
             b.added_at, ub.last_opened_at, b.file_size, b.word_count
      FROM books b
      JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
      WHERE ub.last_opened_at IS NOT NULL AND ub.progress_percent > 0 AND ub.progress_percent < 98
      ORDER BY ub.last_opened_at DESC
      LIMIT 4
    `).all(req.user_id);
  }

  res.json({
    books,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    continueBooks,
    continueBook: continueBooks[0] || null
  });
});

/**
 * POST /api/books
 * Multipart upload of an EPUB file.
 * Parses metadata + extracts cover, inserts DB row, returns the book object.
 */
// Books are shared by everyone.
/**
 * Add one EPUB to the shared library: validate it off the main thread, move it
 * into place, extract metadata and cover, index its text, and record it for
 * the adding user. Used by the upload route and the folder import command.
 * Returns { status, body } in the shape the upload API responds with.
 */
async function ingestEpub({ tmpPath, originalName, userId }) {
  let destPath = null;
  let coverPath = null;
  let uploadedFileHash = null;
  try {
    const id = randomUUID();
    const ext = '.epub';
    const filename = id + ext;
    destPath = path.join(BOOKS_DIR, filename);

    // Verify, move, hash, and extract metadata in a background worker
    let meta;
    try {
      meta = await runEpubWorker({ tmpPath, destPath, id, coversDir: COVERS_DIR });
      
      if (meta._extractError) {
        logger.error({ err: meta._extractError }, 'Metadata extraction error');
        delete meta._extractError;
      }
      coverPath = meta.coverPath;
    } catch (e) {
      // The worker flags files that are not readable EPUBs (bad ZIP, missing
      // package). Those are the uploader's problem, not a server error.
      if (e.validationError) e.status = 400;
      throw e;
    }

    // Check for duplicate uploads via off-thread computed SHA-256 hash
    const fileHash = meta.file_hash;
    uploadedFileHash = fileHash;
    if (fileHash) {
      const existingBook = db.prepare('SELECT id, title FROM books WHERE file_hash = ?').get(fileHash);
      if (existingBook) {
        try { if (destPath && fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (e) {}
        try { if (coverPath && fs.existsSync(path.join(COVERS_DIR, coverPath))) fs.unlinkSync(path.join(COVERS_DIR, coverPath)); } catch (e) {}
        return { status: 409, body: { error: 'This book is already in the library', book_id: existingBook.id, title: existingBook.title } };
      }
    }

    const fileSize = fs.statSync(destPath).size;

    // Fallback title from filename
    const fallbackTitle = String(originalName || '').replace(/\.epub$/i, '').replace(/[_]+/g, ' ').trim();
    const title = clip(meta.title, BOOK_TEXT_LIMITS.title) || clip(fallbackTitle, BOOK_TEXT_LIMITS.title) || 'Untitled book';

    // Pick a spine color
    const bookCount = db.prepare('SELECT COUNT(*) as n FROM books').get().n;
    const coverColor = SPINE_COLORS[bookCount % SPINE_COLORS.length];

    const book = {
      id,
      title,
      author: clip(meta.author, BOOK_TEXT_LIMITS.author),
      series: clip(meta.series, BOOK_TEXT_LIMITS.series),
      series_index: Number.isFinite(meta.seriesIndex) && Math.abs(meta.seriesIndex) <= 1000000 ? meta.seriesIndex : null,
      description: clip(meta.description, BOOK_TEXT_LIMITS.description),
      isbn: clip(meta.isbn, BOOK_TEXT_LIMITS.isbn),
      tags: clip(meta.tags, BOOK_TEXT_LIMITS.tags),
      filename,
      file_format: 'epub',
      file_size: fileSize,
      word_count: Number.isFinite(meta.wordCount) ? meta.wordCount : null,
      file_hash: fileHash,
      cover_path: meta.coverPath || null,
      cover_color: coverColor,
      status: 'unread',
      rating: null,
      progress_percent: 0,
      last_location_cfi: null,
    };

    db.transaction(() => {
      db.prepare(`
        INSERT INTO books (id, title, author, series, series_index, description, isbn, tags, filename, file_format,
                           file_size, word_count, file_hash, cover_path, cover_color)
        VALUES (@id, @title, @author, @series, @series_index, @description, @isbn, @tags, @filename, @file_format,
                @file_size, @word_count, @file_hash, @cover_path, @cover_color)
      `).run(book);
      db.prepare(`INSERT INTO user_books (user_id, book_id, status, progress_percent) VALUES (?, ?, 'unread', 0)`).run(userId, id);
    })();

    // Index the book text for full-text search; a failure here never blocks the upload.
    try { searchIndex.indexBook(id, meta.textSections); } catch (err) { logger.warn({ err }, 'Could not index book text'); }

    // The file hash only catches identical files. A different edition or a
    // re-export of the same book shows up as the same title and author.
    const possibleDuplicate = db.prepare(`
      SELECT id, title FROM books
      WHERE id != ? AND lower(trim(title)) = lower(trim(?)) AND lower(trim(IFNULL(author, ''))) = lower(trim(?))
      LIMIT 1
    `).get(id, book.title, book.author || '');

    // Return the full book row
    const inserted = db.prepare(`
      SELECT b.*, ub.status, ub.rating, ub.progress_percent, ub.last_location_cfi, ub.last_opened_at
      FROM books b
      LEFT JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
      WHERE b.id = ?
    `).get(userId, id);
    return { status: 201, body: { ...withUserFields(inserted), possible_duplicate: possibleDuplicate || null } };
  } catch (err) {
    // Clean up whichever stage received the file on error.
    if (tmpPath && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
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
    logger.error({ err }, 'Upload error');
    if (err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed: books.file_hash/.test(err.message || ''))) {
      const existing = uploadedFileHash ? db.prepare('SELECT id, title FROM books WHERE file_hash = ?').get(uploadedFileHash) : null;
      return { status: 409, body: { error: 'This book is already in the library', book_id: existing && existing.id, title: existing && existing.title } };
    }
    const isClientError = err.status === 400 || /valid EPUB|must be|too many|too large|compression ratio|timed out/i.test(err.message);
    // Parser messages are technical; say plainly what went wrong.
    const message = err.validationError && !/valid EPUB|package/i.test(err.message) ? 'This file is not a readable EPUB (the archive is damaged or incomplete).' : err.message;
    return { status: isClientError ? 400 : 500, body: { error: isClientError ? message : 'Upload failed' } };
  }
}

router.post('/api/books', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const result = await ingestEpub({ tmpPath: req.file.path, originalName: req.file.originalname, userId: req.user_id });
  if (result.status === 201) { res.locals.auditTargetId = result.body.id; res.locals.auditTargetLabel = result.body.title; }
  res.status(result.status).json(result.body);
});

/**
 * GET /api/search/text?q=…
 * Searches inside every book in the shared library. Snippets mark matches with
 * the control characters U+0002 and U+0003 so the client can escape the text
 * before highlighting.
 */
router.get('/api/search/text', (req, res) => {
  const q = String((Array.isArray(req.query.q) ? req.query.q[0] : req.query.q) || '').slice(0, 200);
  res.json({ results: searchIndex.search(q) });
});

/**
 * GET /api/books/:id
 * Returns metadata for a single book.
 */
router.get('/api/books/:id', validateUuidParam('id'), (req, res) => {
  const book = db.prepare(`
    SELECT b.*, IFNULL(ub.status, 'unread') as status, ub.rating, IFNULL(ub.progress_percent, 0) as progress_percent, ub.last_location_cfi, ub.last_opened_at,
           IFNULL(ub.want_to_read, 0) AS want_to_read, ub.user_tags
    FROM books b
    LEFT JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
    WHERE b.id = ?
  `).get(req.user_id, req.params.id);

  if (!book) return res.status(404).json({ error: 'Book not found' });
  res.json(withUserFields(book));
});

/**
 * GET /api/books/:id/file
 * Streams the EPUB file with Cache-Control, Content-Length, and Range support.
 */
router.get('/api/books/:id/file', validateUuidParam('id'), (req, res) => {
  const book = db.prepare('SELECT filename FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  if (!isBookFilename(book.filename)) return res.status(500).json({ error: 'Invalid book file record' });
  const filePath = path.join(BOOKS_DIR, book.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return res.status(500).json({ error: 'Could not access book file' });
  }

  const totalSize = stat.size;
  res.setHeader('Content-Type', 'application/epub+zip');
  res.setHeader('Content-Disposition', `inline; filename="${book.filename}"`);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (range) {
    if (!/^bytes=\d*-\d*$/.test(range) || range.includes(',')) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.status(416).end();
    }
    const parts = range.slice(6).split('-');
    let start;
    let end;
    if (parts[0] === '') {
      const suffixLength = parseInt(parts[1], 10);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }
      start = Math.max(0, totalSize - suffixLength);
      end = totalSize - 1;
    } else {
      start = parseInt(parts[0], 10);
      end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
    }

    if (isNaN(start) || isNaN(end) || start < 0 || start > end || start >= totalSize) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.status(416).json({ error: 'Requested range not satisfiable' });
    }

    const clampedEnd = Math.min(end, totalSize - 1);
    const chunkSize = (clampedEnd - start) + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${clampedEnd}/${totalSize}`);
    res.setHeader('Content-Length', chunkSize);

    const stream = fs.createReadStream(filePath, { start, end: clampedEnd });
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Could not read book file' });
      else res.destroy();
    });
    stream.pipe(res);
  } else {
    res.setHeader('Content-Length', totalSize);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Could not read book file' });
      else res.destroy();
    });
    stream.pipe(res);
  }
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
  res.setHeader('Cache-Control', 'private, max-age=86400');
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
  const book = db.prepare(`
    SELECT b.id, IFNULL(ub.status, 'unread') as status, IFNULL(ub.progress_percent, 0) as progress_percent
    FROM books b
    LEFT JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
    WHERE b.id = ?
  `).get(req.user_id, req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const user = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(req.user_id);
  const isAdmin = !!(user && user.is_admin);
  const changesSharedMetadata = ['title', 'author', 'series', 'series_index', 'description', 'isbn', 'tags'].some(key => req.body[key] !== undefined);
  if (changesSharedMetadata && !isAdmin) {
    return res.status(403).json({ error: 'Admin privileges required to edit shared book metadata' });
  }

  const bookUpdates = [];
  const bookValues = {};
  const userBookUpdates = [];
  const userBookValues = {};

  try {
    if (req.body.progress_percent !== undefined) {
      userBookValues.progress_percent = number(req.body.progress_percent, { min: 0, max: 100, field: 'progress_percent' });
      userBookUpdates.push('progress_percent = @progress_percent');
    }
    if (req.body.last_location_cfi !== undefined) {
      userBookValues.last_location_cfi = text(req.body.last_location_cfi, { max: 10000, field: 'last_location_cfi' });
      userBookUpdates.push('last_location_cfi = @last_location_cfi');
    }
    if (req.body.status !== undefined) {
      if (!['unread', 'reading', 'finished'].includes(req.body.status)) throw new Error('status is invalid');
      userBookValues.status = req.body.status;
      userBookUpdates.push('status = @status');
    }
    if (req.body.rating !== undefined) {
      userBookValues.rating = number(req.body.rating, { min: 1, max: 5, nullable: true, integer: true, field: 'rating' });
      userBookUpdates.push('rating = @rating');
    }
    if (req.body.want_to_read !== undefined) {
      if (typeof req.body.want_to_read !== 'boolean') throw new Error('want_to_read must be true or false');
      userBookValues.want_to_read = req.body.want_to_read ? 1 : 0;
      userBookUpdates.push('want_to_read = @want_to_read');
    }
    if (req.body.user_tags !== undefined) {
      userBookValues.user_tags = userTags(req.body.user_tags);
      userBookUpdates.push('user_tags = @user_tags');
    }
    if (req.body.last_opened_at !== undefined) {
      const date = new Date(req.body.last_opened_at);
      if (typeof req.body.last_opened_at !== 'string' || Number.isNaN(date.getTime())) throw new Error('last_opened_at is invalid');
      userBookValues.last_opened_at = date.toISOString();
      userBookUpdates.push('last_opened_at = @last_opened_at');
    }
    if (req.body.title !== undefined) {
      bookValues.title = text(req.body.title, { required: true, max: BOOK_TEXT_LIMITS.title, field: 'title' });
      bookUpdates.push('title = @title');
    }
    if (req.body.author !== undefined) {
      bookValues.author = text(req.body.author, { max: BOOK_TEXT_LIMITS.author, field: 'author' });
      bookUpdates.push('author = @author');
    }
    for (const field of ['series', 'description', 'isbn', 'tags']) {
      if (req.body[field] !== undefined) {
        bookValues[field] = text(req.body[field], { max: BOOK_TEXT_LIMITS[field], field });
        bookUpdates.push(`${field} = @${field}`);
      }
    }
    if (req.body.series_index !== undefined) {
      bookValues.series_index = number(req.body.series_index, { min: -1000000, max: 1000000, nullable: true, field: 'series_index' });
      bookUpdates.push('series_index = @series_index');
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (bookUpdates.length === 0 && userBookUpdates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  db.transaction(() => {
    if (bookUpdates.length > 0) {
      bookValues.id = req.params.id;
      db.prepare(`UPDATE books SET ${bookUpdates.join(', ')} WHERE id = @id`).run(bookValues);
    }
    
    if (userBookUpdates.length > 0) {
      // Infer status only when the reader actually moved and did not choose a
      // status in the same request, so "Mark as unread" sticks until they read on.
      const progressChanged = userBookValues.progress_percent !== undefined && userBookValues.progress_percent !== book.progress_percent;
      if (progressChanged && userBookValues.status === undefined) {
        const newProgress = userBookValues.progress_percent;
        if (newProgress >= 98 && book.status !== 'finished') {
          userBookValues.status = 'finished';
          userBookUpdates.push('status = @status');
        } else if (newProgress > 0 && newProgress < 98 && book.status === 'unread') {
          userBookValues.status = 'reading';
          userBookUpdates.push('status = @status');
        }
      }
      
      // Record when a book became finished; clear it if the reader reopens it.
      if (userBookValues.status !== undefined && userBookValues.status !== book.status) {
        userBookValues.finished_at = userBookValues.status === 'finished' ? new Date().toISOString() : null;
        userBookUpdates.push('finished_at = @finished_at');
      }

      userBookValues.book_id = req.params.id;
      userBookValues.user_id = req.user_id;

      // Ensure user_books row exists before updating, or use INSERT ON CONFLICT
      // SQLite INSERT ON CONFLICT requires all NOT NULL fields to be provided
      const currentUb = db.prepare('SELECT 1 FROM user_books WHERE user_id = ? AND book_id = ?').get(req.user_id, req.params.id);
      if (currentUb) {
        db.prepare(`UPDATE user_books SET ${userBookUpdates.join(', ')} WHERE user_id = @user_id AND book_id = @book_id`).run(userBookValues);
      } else {
        // Insert a new row. Set default values for omitted fields.
        userBookValues.status = userBookValues.status || 'unread';
        userBookValues.progress_percent = userBookValues.progress_percent || 0;
        
        const cols = Object.keys(userBookValues);
        const placeholders = cols.map(c => '@' + c);
        db.prepare(`INSERT INTO user_books (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`).run(userBookValues);
      }
    }
  })();

  const updated = db.prepare(`
    SELECT b.*, IFNULL(ub.status, 'unread') as status, ub.rating, IFNULL(ub.progress_percent, 0) as progress_percent, ub.last_location_cfi, ub.last_opened_at,
           IFNULL(ub.want_to_read, 0) AS want_to_read, ub.user_tags
    FROM books b
    LEFT JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
    WHERE b.id = ?
  `).get(req.user_id, req.params.id);
  res.json(withUserFields(updated));
});

/**
 * DELETE /api/books/:id
 * Removes the book for EVERYONE (Endpaper has a single shared library — a
 * book isn't "yours" to unsubscribe from, it's a shelf everyone reads from).
 * Deleting a shared resource is destructive for every other user's
 * bookmarks, highlights, and progress on it, so this is admin-only.
 * DB row deletion cascades to user_books/bookmarks/highlights/book_collections
 * via ON DELETE CASCADE, so we only need to also clean up the files on disk.
 */
// ---------- Cover replacement (admin) ----------
const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 2 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(Object.assign(new Error('Choose a JPEG, PNG, WebP or GIF image'), { status: 400 }));
  },
});

/**
 * POST /api/books/:id/cover (multipart "file")
 * Replaces the shared cover. The image is re-encoded as a 400px-wide WebP,
 * which also strips metadata and anything that is not plain pixels.
 */
router.post('/api/books/:id/cover', validateUuidParam('id'), requireAdmin, coverUpload.single('file'), async (req, res) => {
  const book = db.prepare('SELECT id, cover_path FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  if (!req.file) return res.status(400).json({ error: 'Choose an image for the cover' });
  const filename = `${randomUUID()}.webp`;
  const destination = path.join(COVERS_DIR, filename);
  try {
    const image = sharp(req.file.buffer, { limitInputPixels: 40 * 1024 * 1024, failOn: 'error' });
    await image.rotate().resize({ width: 400, withoutEnlargement: true }).webp({ quality: 82 }).toFile(destination);
  } catch (err) {
    try { fs.unlinkSync(destination); } catch (_) {}
    return res.status(400).json({ error: 'That image could not be read' });
  }
  db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(filename, book.id);
  if (book.cover_path && isCoverFilename(book.cover_path)) {
    fs.promises.unlink(path.join(COVERS_DIR, book.cover_path)).catch(() => {});
  }
  const updated = db.prepare(`
    SELECT b.*, IFNULL(ub.status, 'unread') as status, ub.rating, IFNULL(ub.progress_percent, 0) as progress_percent, ub.last_location_cfi, ub.last_opened_at,
           IFNULL(ub.want_to_read, 0) AS want_to_read, ub.user_tags
    FROM books b LEFT JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ? WHERE b.id = ?
  `).get(req.user_id, book.id);
  res.json(withUserFields(updated));
});

// ---------- Metadata lookup by ISBN (admin, on request only) ----------
const OPEN_LIBRARY = 'https://openlibrary.org';

async function openLibraryJson(pathname) {
  const response = await fetch(`${OPEN_LIBRARY}${pathname}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Endpaper (self-hosted EPUB library)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw Object.assign(new Error('Open Library did not respond'), { status: 502 });
  return response.json();
}

/**
 * GET /api/books/:id/lookup?isbn=…
 * Asks Open Library for this ISBN and returns suggested metadata. Nothing is
 * saved: the admin reviews the suggestion and saves it with PATCH. This is the
 * only server-side request to a third party, and it only runs when asked.
 */
router.get('/api/books/:id/lookup', validateUuidParam('id'), requireAdmin, async (req, res) => {
  const raw = String((Array.isArray(req.query.isbn) ? req.query.isbn[0] : req.query.isbn) || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^(?:\d{9}[\dX]|\d{13})$/.test(raw)) return res.status(400).json({ error: 'Enter a 10- or 13-digit ISBN' });
  try {
    const edition = await openLibraryJson(`/isbn/${raw}.json`);
    if (!edition) return res.status(404).json({ error: 'Open Library has no book with that ISBN' });
    const work = edition.works?.[0]?.key ? await openLibraryJson(`${edition.works[0].key}.json`).catch(() => null) : null;
    const authorKeys = (edition.authors || work?.authors?.map(item => item.author) || []).map(item => item?.key).filter(key => /^\/authors\/OL\w+A$/.test(key || '')).slice(0, 4);
    const authors = (await Promise.all(authorKeys.map(key => openLibraryJson(`${key}.json`).catch(() => null)))).map(item => item?.name).filter(Boolean);
    const describe = value => typeof value === 'string' ? value : value?.value;
    const series = Array.isArray(edition.series) ? String(edition.series[0] || '') : '';
    res.json({
      isbn: raw,
      title: clip([edition.title, edition.subtitle].filter(Boolean).join(': '), BOOK_TEXT_LIMITS.title),
      author: clip(authors.join(', '), BOOK_TEXT_LIMITS.author),
      description: clip(describe(edition.description) || describe(work?.description) || '', BOOK_TEXT_LIMITS.description),
      tags: clip((work?.subjects || []).slice(0, 12).join(', '), BOOK_TEXT_LIMITS.tags),
      series: clip(series.replace(/\s*;.*$/, ''), BOOK_TEXT_LIMITS.series),
      source: `${OPEN_LIBRARY}/isbn/${raw}`,
    });
  } catch (err) {
    logger.warn({ err }, 'ISBN lookup failed');
    res.status(err.status || 502).json({ error: err.status ? err.message : 'Could not reach Open Library' });
  }
});

router.delete('/api/books/:id', validateUuidParam('id'), requireAdmin, (req, res) => {
  const book = db.prepare('SELECT id, filename, cover_path FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const staged = [];
  try {
    const stage = (source, label) => {
      if (!source || !fs.existsSync(source)) return;
      const destination = path.join(DATA_DIR, 'tmp', `delete-${book.id}-${label}-${randomUUID()}`);
      fs.renameSync(source, destination);
      staged.push({ source, destination });
    };
    if (isBookFilename(book.filename)) stage(path.join(BOOKS_DIR, book.filename), 'book');
    if (book.cover_path && isCoverFilename(book.cover_path)) stage(path.join(COVERS_DIR, book.cover_path), 'cover');
    db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
    searchIndex.removeBook(req.params.id);
  } catch (error) {
    for (const item of staged.reverse()) {
      try { if (fs.existsSync(item.destination)) fs.renameSync(item.destination, item.source); } catch (_) {}
    }
    logger.error({ err: error }, 'Error staging book deletion');
    return res.status(500).json({ error: 'Could not remove book files safely' });
  }
  for (const item of staged) fs.promises.unlink(item.destination).catch(error => logger.error({ err: error }, 'Error finalizing book deletion'));

  res.json({ ok: true });
});

module.exports = router;
module.exports.ingestEpub = ingestEpub;
