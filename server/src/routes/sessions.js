'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { validateUuidParam } = require('../lib/validation');

const router = express.Router();

// Clients heartbeat every minute while the reader is visible. A session that
// was never ended (closed tab, killed PWA) only counts up to its last
// heartbeat plus a short grace period, not until the next time a book opens.
const IDLE_GRACE_MS = 2 * 60 * 1000;
// Sessions from clients that predate heartbeats have no activity record.
const UNTRACKED_SESSION_CAP_MS = 4 * 60 * 60 * 1000;

function effectiveEnd(session, requestedEnd) {
  const start = Date.parse(session.started_at);
  const end = Date.parse(requestedEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return requestedEnd;
  const lastActive = Date.parse(session.last_active_at || '');
  const limit = Number.isFinite(lastActive) ? lastActive + IDLE_GRACE_MS : start + UNTRACKED_SESSION_CAP_MS;
  return new Date(Math.max(start, Math.min(end, limit))).toISOString();
}

function closeSession(session, requestedEnd) {
  if (session.ended_at) return session;
  const endedAt = effectiveEnd(session, requestedEnd);
  const duration = Math.max(0, Math.floor((new Date(endedAt).getTime() - new Date(session.started_at).getTime()) / 1000));
  const progress = db.prepare('SELECT progress_percent FROM user_books WHERE user_id = ? AND book_id = ?').get(session.user_id, session.book_id)?.progress_percent;
  db.prepare(`UPDATE reading_sessions SET ended_at = ?, duration_seconds = ?, end_progress_percent = ? WHERE id = ?`)
    .run(endedAt, duration, progress ?? null, session.id);
  return { ...session, ended_at: endedAt, duration_seconds: duration, end_progress_percent: progress ?? null };
}

/**
 * POST /api/sessions/start
 * Body: { book_id }
 * Creates a new reading session, returns the session object.
 */
router.post('/api/sessions/start', (req, res) => {
  const { book_id } = req.body;
  const clientId = typeof req.body.client_id === 'string' && req.body.client_id.length <= 100
    ? req.body.client_id
    : 'legacy-client';
  if (!book_id) return res.status(400).json({ error: 'book_id is required' });

  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(book_id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const started_at = new Date().toISOString();
  const id = randomUUID();

  // A browser can be closed mid-read or a user can open a second book. Close
  // any abandoned single-user sessions before starting the new one so stats do
  // not silently lose that reading time.
  db.transaction(() => {
    const openSessions = db.prepare('SELECT * FROM reading_sessions WHERE ended_at IS NULL AND user_id = ? AND COALESCE(client_id, ?) = ?').all(req.user_id, clientId, clientId);
    for (const session of openSessions) closeSession(session, started_at);
    const progress = db.prepare('SELECT progress_percent FROM user_books WHERE user_id = ? AND book_id = ?').get(req.user_id, book_id)?.progress_percent;
    db.prepare('INSERT INTO reading_sessions (id, user_id, book_id, started_at, last_active_at, client_id, start_progress_percent) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.user_id, book_id, started_at, started_at, clientId, progress ?? 0);
  })();

  res.status(201).json({ id, book_id, started_at, client_id: clientId });
});

/**
 * POST /api/sessions/:id/heartbeat
 * Records that the reader is still on screen.
 */
router.post('/api/sessions/:id/heartbeat', validateUuidParam('id'), (req, res) => {
  const result = db.prepare('UPDATE reading_sessions SET last_active_at = ? WHERE id = ? AND user_id = ? AND ended_at IS NULL')
    .run(new Date().toISOString(), req.params.id, req.user_id);
  if (result.changes === 0) return res.status(404).json({ error: 'Session not found or already ended' });
  res.json({ ok: true });
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
  // Rolling seven days (the UI labels this precisely rather than “this week”).
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const weekRow = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) as total
    FROM reading_sessions WHERE started_at >= ? AND user_id = ?
  `).get(weekAgo, req.user_id);

  // Total time read all-time
  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) as total FROM reading_sessions WHERE user_id = ?
  `).get(req.user_id);

  // Books finished: reaching 98% marks a book finished, and readers can also set it by hand.
  const finishedRow = db.prepare(`
    SELECT COUNT(*) as total FROM user_books WHERE status = 'finished' AND user_id = ?
  `).get(req.user_id);

  // Timezone resolution: validate client timezone
  let timeZone = 'UTC';
  if (typeof req.query.tz === 'string' && req.query.tz.trim()) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: req.query.tz.trim() });
      timeZone = req.query.tz.trim();
    } catch (_) {
      timeZone = 'UTC';
    }
  }

  // Helper: get local date string YYYY-MM-DD in client timezone
  const getLocalDateKey = (dateObj) => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dateObj);
    } catch (_) {
      return dateObj.toISOString().slice(0, 10);
    }
  };

  // Reading streak: every local date touched by a session counts, including a
  // session crossing midnight. There is no artificial historical cutoff.
  const sessionRows = db.prepare(`
    SELECT rs.started_at, COALESCE(rs.ended_at, rs.last_active_at, rs.started_at) AS ended_at,
           COALESCE(rs.duration_seconds, 0) AS duration_seconds,
           rs.book_id, b.title
    FROM reading_sessions rs
    LEFT JOIN books b ON b.id = rs.book_id
    WHERE rs.user_id = ?
    ORDER BY started_at DESC
  `).all(req.user_id);

  const daySet = new Set();
  const dailySeconds = new Map();
  const monthlySeconds = new Map();
  for (const row of sessionRows) {
    if (row.started_at) {
      const start = new Date(row.started_at);
      const end = new Date(row.ended_at || row.started_at);
      if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
        daySet.add(getLocalDateKey(start));
        daySet.add(getLocalDateKey(end));
        for (let cursor = start.getTime() + 6 * 3600000; cursor < end.getTime(); cursor += 6 * 3600000) {
          daySet.add(getLocalDateKey(new Date(cursor)));
        }
        const key = getLocalDateKey(start);
        dailySeconds.set(key, (dailySeconds.get(key) || 0) + Number(row.duration_seconds || 0));
        const month = key.slice(0, 7);
        monthlySeconds.set(month, (monthlySeconds.get(month) || 0) + Number(row.duration_seconds || 0));
      }
    }
  }

  let streak = 0;
  const now = new Date();
  const todayKey = getLocalDateKey(now);

  const [y, m, d] = todayKey.split('-').map(Number);
  const baseUtcTime = Date.UTC(y, m - 1, d);

  let expectedDate = daySet.has(todayKey)
    ? baseUtcTime
    : baseUtcTime - 86400000;

  while (true) {
    const key = new Date(expectedDate).toISOString().slice(0, 10);
    if (daySet.has(key)) {
      streak++;
      expectedDate -= 86400000;
    } else {
      break;
    }
  }

  const sortedDays = [...daySet].sort();
  let longestStreak = 0;
  let run = 0;
  let previous = null;
  for (const key of sortedDays) {
    const stamp = Date.parse(`${key}T00:00:00Z`);
    run = previous != null && stamp - previous === 86400000 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = stamp;
  }

  const previousWeekStart = new Date(Date.now() - 14 * 86400000).toISOString();
  const previousWeekEnd = weekAgo;
  const previousWeek = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) AS total FROM reading_sessions
    WHERE started_at >= ? AND started_at < ? AND user_id = ?
  `).get(previousWeekStart, previousWeekEnd, req.user_id).total;
  const averageSession = db.prepare(`
    SELECT COALESCE(AVG(duration_seconds), 0) AS value FROM reading_sessions
    WHERE user_id = ? AND duration_seconds > 0
  `).get(req.user_id).value;
  const mostRead = db.prepare(`
    SELECT rs.book_id, b.title, SUM(rs.duration_seconds) AS seconds
    FROM reading_sessions rs JOIN books b ON b.id = rs.book_id
    WHERE rs.user_id = ? AND rs.duration_seconds > 0
    GROUP BY rs.book_id, b.title ORDER BY seconds DESC LIMIT 5
  `).all(req.user_id);
  const daily = [];
  for (let offset = 13; offset >= 0; offset--) {
    const date = new Date(Date.now() - offset * 86400000);
    const key = getLocalDateKey(date);
    daily.push({ date: key, seconds: dailySeconds.get(key) || 0 });
  }
  const monthly = [...monthlySeconds.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-12)
    .map(([month, seconds]) => ({ month, seconds }));
  const paceRows = db.prepare(`
    SELECT b.word_count, rs.start_progress_percent, rs.end_progress_percent, rs.duration_seconds
    FROM reading_sessions rs JOIN books b ON b.id = rs.book_id
    WHERE rs.user_id = ? AND rs.ended_at IS NOT NULL AND b.word_count > 0
      AND rs.start_progress_percent IS NOT NULL AND rs.end_progress_percent IS NOT NULL
      AND rs.duration_seconds >= 60
  `).all(req.user_id);
  const paceSamples = paceRows.map(row => {
    const delta = Math.max(0, Math.min(100, Number(row.end_progress_percent)) - Math.max(0, Number(row.start_progress_percent)));
    const words = Number(row.word_count) * delta / 100;
    const seconds = Number(row.duration_seconds);
    const wpm = words / (seconds / 60);
    // Discard stationary sessions and jumps whose implied pace is implausible.
    return words >= 100 && wpm >= 60 && wpm <= 600 ? { words, seconds } : null;
  }).filter(Boolean);
  const paceSeconds = paceSamples.reduce((sum, row) => sum + row.seconds, 0);
  const estimatedWordsRead = paceSamples.reduce((sum, row) => sum + row.words, 0);
  const readingWordsPerMinute = paceSeconds >= 1800 && estimatedWordsRead >= 1000
    ? Math.max(120, Math.min(450, Math.round(estimatedWordsRead / (paceSeconds / 60))))
    : null;

  // Goal progress, a year-long calendar, time per book and a year in review.
  const todayKey2 = getLocalDateKey(new Date());
  const thisYear = todayKey2.slice(0, 4);
  const calendar = [];
  for (let offset = 364; offset >= 0; offset--) {
    const key = getLocalDateKey(new Date(Date.now() - offset * 86400000));
    calendar.push({ date: key, seconds: dailySeconds.get(key) || 0 });
  }
  const finishedRows = db.prepare(`
    SELECT ub.book_id, b.title, b.author, ub.finished_at FROM user_books ub JOIN books b ON b.id = ub.book_id
    WHERE ub.user_id = ? AND ub.status = 'finished' AND ub.finished_at IS NOT NULL
    ORDER BY ub.finished_at DESC
  `).all(req.user_id);
  const finishedThisYear = finishedRows.filter(row => {
    const date = new Date(row.finished_at.includes('T') ? row.finished_at : `${row.finished_at.replace(' ', 'T')}Z`);
    return !isNaN(date.getTime()) && getLocalDateKey(date).startsWith(thisYear);
  });
  const perBook = db.prepare(`
    SELECT rs.book_id, b.title, b.author, SUM(COALESCE(rs.duration_seconds, 0)) AS seconds, COUNT(*) AS sessions, MAX(rs.started_at) AS last_read
    FROM reading_sessions rs JOIN books b ON b.id = rs.book_id
    WHERE rs.user_id = ? GROUP BY rs.book_id, b.title, b.author HAVING seconds > 0 ORDER BY seconds DESC
  `).all(req.user_id);
  const yearMonths = [...monthlySeconds.entries()].filter(([month]) => month.startsWith(thisYear));
  const yearSeconds = yearMonths.reduce((sum, [, seconds]) => sum + seconds, 0);
  const busiestMonth = yearMonths.sort(([, a], [, b]) => b - a)[0] || null;
  const daysReadThisYear = [...dailySeconds.entries()].filter(([key, seconds]) => key.startsWith(thisYear) && seconds > 0).length;

  res.json({
    today_seconds: dailySeconds.get(todayKey2) || 0,
    books_finished_this_year: finishedThisYear.length,
    calendar,
    per_book: perBook,
    year_review: {
      year: Number(thisYear),
      seconds: yearSeconds,
      days_read: daysReadThisYear,
      busiest_month: busiestMonth ? { month: busiestMonth[0], seconds: busiestMonth[1] } : null,
      books_finished: finishedThisYear.slice(0, 50).map(row => ({ book_id: row.book_id, title: row.title, author: row.author, finished_at: row.finished_at })),
      top_book: perBook.find(row => String(row.last_read || '').startsWith(thisYear)) || null,
    },
    time_read_this_week: weekRow.total,
    time_read_total: totalRow.total,
    books_finished: finishedRow.total,
    reading_streak_days: streak,
    longest_streak_days: longestStreak,
    previous_7_days: previousWeek,
    average_session_seconds: Math.round(averageSession || 0),
    reading_words_per_minute: readingWordsPerMinute,
    daily,
    monthly,
    most_read: mostRead,
  });
});

module.exports = router;
