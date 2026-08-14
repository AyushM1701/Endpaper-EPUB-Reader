'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { validateUuidParam } = require('../lib/validation');

const router = express.Router();

function closeSession(session, endedAt) {
  if (session.ended_at) return session;
  const duration = Math.max(0, Math.floor((new Date(endedAt).getTime() - new Date(session.started_at).getTime()) / 1000));
  db.prepare(`UPDATE reading_sessions SET ended_at = ?, duration_seconds = ? WHERE id = ?`)
    .run(endedAt, duration, session.id);
  return { ...session, ended_at: endedAt, duration_seconds: duration };
}

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

  const started_at = new Date().toISOString();
  const id = randomUUID();

  // A browser can be closed mid-read or a user can open a second book. Close
  // any abandoned single-user sessions before starting the new one so stats do
  // not silently lose that reading time.
  db.transaction(() => {
    const openSessions = db.prepare('SELECT * FROM reading_sessions WHERE ended_at IS NULL AND user_id = ?').all(req.user_id);
    for (const session of openSessions) closeSession(session, started_at);
    db.prepare('INSERT INTO reading_sessions (id, user_id, book_id, started_at) VALUES (?, ?, ?, ?)')
      .run(id, req.user_id, book_id, started_at);
  })();

  res.status(201).json({ id, book_id, started_at });
});

/**
 * POST /api/sessions/:id/end
 * Closes a reading session and computes duration.
 */
router.post('/api/sessions/:id/end', validateUuidParam('id'), (req, res) => {
  const session = db.prepare('SELECT * FROM reading_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user_id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // This endpoint is intentionally idempotent: sendBeacon and a normal close
  // can race during page unload.
  res.json(closeSession(session, new Date().toISOString()));
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
    FROM reading_sessions WHERE started_at >= ? AND user_id = ?
  `).get(weekAgo, req.user_id);

  // Total time read all-time
  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) as total FROM reading_sessions WHERE user_id = ?
  `).get(req.user_id);

  // Books finished (progress >= 95%)
  const finishedRow = db.prepare(`
    SELECT COUNT(*) as total FROM user_books WHERE progress_percent >= 95 AND user_id = ?
  `).get(req.user_id);

  // Reading streak: calculate distinct local calendar days in one query. The
  // current day only counts if there has actually been a session today.
  const readingDays = db.prepare(`
    SELECT DISTINCT date(started_at, 'localtime') AS day
    FROM reading_sessions
    WHERE started_at >= date('now', 'localtime', '-365 days') AND user_id = ?
    ORDER BY day DESC
  `).all(req.user_id).map(row => row.day);
  let streak = 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  const dayKey = (date) => {
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 10);
  };
  const todayKey = dayKey(cursor);
  const expected = readingDays.includes(todayKey)
    ? cursor
    : new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  for (const day of readingDays) {
    if (day !== dayKey(expected)) break;
    streak++;
    expected.setDate(expected.getDate() - 1);
  }

  res.json({
    time_read_this_week: weekRow.total,
    time_read_total: totalRow.total,
    books_finished: finishedRow.total,
    reading_streak_days: streak,
  });
});

module.exports = router;
