'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');

const router = express.Router();
const SESSION_TTL_DAYS = 90;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

const pruneExpiredSessions = db.prepare(`
  DELETE FROM sessions
  WHERE expires_at IS NULL
     OR datetime(expires_at) IS NULL
     OR datetime(expires_at) <= CURRENT_TIMESTAMP
`);
const createSession = db.prepare(`
  INSERT INTO sessions (token, user_id, expires_at)
  VALUES (?, ?, datetime('now', '+90 days'))
`);
const createSessionAndPrune = db.transaction((token, userId) => {
  pruneExpiredSessions.run();
  createSession.run(token, userId);
});

// Rate limit failed login attempts without blocking a household that shares
// one public IP and signs in successfully from several devices.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => req.ip + ':' + (req.body.username || ''),
});

/**
 * POST /api/login
 * Body: { username: "...", passphrase: "..." }
 * On success: sets httpOnly session cookie (90-day expiry)
 */
router.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { username, passphrase } = req.body || {};
    const trimmedUsername = typeof username === 'string' ? username.trim() : '';
    if (!trimmedUsername || trimmedUsername.length > 255) {
      return res.status(400).json({ error: 'A valid username is required' });
    }
    if (!passphrase || typeof passphrase !== 'string' || passphrase.length > 1024) {
      return res.status(400).json({ error: 'A valid passphrase is required' });
    }

    const user = db.prepare("SELECT id, passphrase_hash FROM users WHERE lower(username) = lower(?)").get(trimmedUsername);

    if (!user) {
      return res.status(401).json({ error: 'Incorrect username or passphrase' });
    }

    const match = await bcrypt.compare(passphrase, user.passphrase_hash);

    if (!match) {
      return res.status(401).json({ error: 'Incorrect username or passphrase' });
    }

    // Generate a token with a matching server-side and browser-side 90-day
    // expiry. Pruning here keeps unused records bounded even on low traffic.
    const token = randomUUID();
    createSessionAndPrune(token, user.id);

    // Set httpOnly, SameSite=Strict cookie with 90-day expiry
    res.cookie('endpaper_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: SESSION_TTL_MS,
      path: '/',
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/logout
 * Invalidates the current session and removes its cookie.
 */
router.post('/api/logout', (req, res) => {
  const token = req.cookies && req.cookies.endpaper_session;
  if (token) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }
  res.clearCookie('endpaper_session', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
  res.json({ ok: true });
});

/**
 * GET /api/session
 * Returns 200 if the session cookie is valid (middleware already checked it).
 * We will return whether the current user is an admin.
 */
router.get('/api/session', (req, res) => {
  const user = db.prepare("SELECT is_admin, username FROM users WHERE id = ?").get(req.user_id);
  res.json({ ok: true, is_admin: !!(user && user.is_admin), username: user ? user.username : null });
});

module.exports = router;
