'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

/**
 * POST /api/sessions/start
 * Body: { book_id }
 * Creates a new reading session, returns the session object.
 */
router.post('/api/sessions/start', (req, res) => {
  const { book_id } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id is required' });

  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(book_id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const id = uuidv4();
  const started_at = new Date().toISOString();

  db.prepare(`
    INSERT INTO reading_sessions (id, book_id, started_at) VALUES (?, ?, ?)
  `).run(id, book_id, started_at);

  res.status(201).json({ id, book_id, started_at });
});

/**
 * POST /api/sessions/:id/end
 * Closes a reading session and computes duration.
 */
router.post('/api/sessions/:id/end', (req, res) => {
  const session = db.prepare('SELECT * FROM reading_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const ended_at = new Date().toISOString();
  const duration_seconds = Math.floor(
    (new Date(ended_at).getTime() - new Date(session.started_at).getTime()) / 1000
  );

  db.prepare(`
    UPDATE reading_sessions SET ended_at = ?, duration_seconds = ? WHERE id = ?
  `).run(ended_at, duration_seconds, req.params.id);

  res.json({ ...session, ended_at, duration_seconds });
});

/**
 * GET /api/stats
 * Aggregate reading statistics:
 * - time read this week (seconds)
 * - current streak (days)
 * - total books finished
 * - average reading pace (seconds per book)
 */
router.get('/api/stats', (req, res) => {
  // Time read this week
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const weekRow = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) as total
    FROM reading_sessions WHERE started_at >= ?
  `).get(weekAgo);

  // Total time read all-time
  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) as total FROM reading_sessions
  `).get();

  // Books finished (progress >= 95%)
  const finishedRow = db.prepare(`
    SELECT COUNT(*) as total FROM books WHERE progress_percent >= 95
  `).get();

  // Reading streak: count consecutive days with at least one session
  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 365; i++) {
    const dayStart = new Date(today.getTime() - i * 24 * 60 * 60 * 1000).toISOString();
    const dayEnd = new Date(today.getTime() - (i - 1) * 24 * 60 * 60 * 1000).toISOString();
    const row = db.prepare(`
      SELECT COUNT(*) as n FROM reading_sessions
      WHERE started_at >= ? AND started_at < ?
    `).get(dayStart, dayEnd);
    if (row.n > 0) streak++;
    else break;
  }

  res.json({
    time_read_this_week: weekRow.total,
    time_read_total: totalRow.total,
    books_finished: finishedRow.total,
    reading_streak_days: streak,
  });
});

module.exports = router;
