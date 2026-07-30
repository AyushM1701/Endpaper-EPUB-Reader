'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');

const router = express.Router();

// Rate limit: 5 login attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

/**
 * POST /api/login
 * Body: { passphrase: "..." }
 * On success: sets httpOnly session cookie (90-day expiry)
 */
router.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { passphrase } = req.body;

    if (!passphrase || typeof passphrase !== 'string' || passphrase.length > 1024) {
      return res.status(400).json({ error: 'A valid passphrase is required' });
    }

    const row = db.prepare("SELECT value FROM settings WHERE key = 'passphrase_hash'").get();

    if (!row) {
      return res.status(500).json({ error: 'No passphrase configured. Run: node src/lib/passphrase.js --set "your phrase"' });
    }

    const match = await bcrypt.compare(passphrase, row.value);

    if (!match) {
      return res.status(401).json({ error: 'Incorrect passphrase' });
    }

    // Generate session token and store it
    const token = randomUUID();
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('session_token', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(token);

    // Set httpOnly, SameSite=Strict cookie with 90-day expiry
    res.cookie('endpaper_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
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
  const current = db.prepare("SELECT value FROM settings WHERE key = 'session_token'").get();
  if (current && current.value === token) {
    db.prepare("DELETE FROM settings WHERE key = 'session_token'").run();
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
 */
router.get('/api/session', (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
