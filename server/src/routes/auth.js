'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const logger = require('../lib/logger');
const { hashSessionToken } = require('../lib/sessionToken');
const { deviceLabel } = require('../lib/deviceLabel');
const totp = require('../lib/totp');
const { sessionCookieOptions, clearSessionCookie } = require('../middleware/auth');

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
  INSERT INTO sessions (token, user_id, created_at, last_seen_at, device_label, expires_at)
  VALUES (?, ?, datetime('now'), datetime('now'), ?, datetime('now', '+90 days'))
`);
const createSessionAndPrune = db.transaction((token, userId, label) => {
  pruneExpiredSessions.run();
  createSession.run(hashSessionToken(token), userId, label);
});

// Checks and spends a sign-in code in one synchronous transaction. The row is re-read here,
// after the slow passphrase check, so two simultaneous sign-ins cannot both use one code.
const consumeSecondFactor = db.transaction((userId, code) => {
  const user = db.prepare('SELECT totp_secret, totp_last_step, totp_recovery FROM users WHERE id = ?').get(userId);
  if (!user || !user.totp_secret) return true;
  const step = totp.verify(user.totp_secret, code, { lastUsedStep: user.totp_last_step });
  if (step != null) {
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, userId);
    return true;
  }
  const recovery = JSON.parse(user.totp_recovery || '[]');
  const hashed = totp.hashRecoveryCode(code);
  if (!recovery.includes(hashed)) return false;
  // A recovery code works once.
  db.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?').run(JSON.stringify(recovery.filter(item => item !== hashed)), userId);
  return true;
});

// Compared against when the username does not exist, so a login attempt takes
// the same bcrypt time either way and cannot reveal which accounts exist.
const DUMMY_PASSPHRASE_HASH = bcrypt.hashSync(randomUUID(), 10);

// Rate limit failed login attempts without blocking a household that shares
// one public IP and signs in successfully from several devices.
const normalizeLoginName = (req) => String((req.body && req.body.username) || '').trim().toLocaleLowerCase('en-US');
// Tunable for unusual setups (for example a whole school behind one IP).
const LOGIN_WINDOW_MS = Math.max(1, Number(process.env.LOGIN_LIMIT_WINDOW_MINUTES) || 15) * 60 * 1000;
const LOGIN_LIMIT_PER_IP = Math.max(1, Number(process.env.LOGIN_LIMIT_PER_IP) || 50);
const LOGIN_LIMIT_PER_ACCOUNT = Math.max(1, Number(process.env.LOGIN_LIMIT_PER_ACCOUNT) || 5);
const loginIpLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  max: LOGIN_LIMIT_PER_IP,
  message: { error: 'Too many login attempts from this network. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});
const loginLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  max: LOGIN_LIMIT_PER_ACCOUNT,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // ipKeyGenerator groups IPv6 addresses by /56, so one client cannot rotate addresses to dodge the limit.
  keyGenerator: (req) => ipKeyGenerator(req.ip) + ':' + normalizeLoginName(req),
});

/**
 * POST /api/login
 * Body: { username: "...", passphrase: "..." }
 * On success: sets httpOnly session cookie (90-day expiry)
 */
router.post('/api/login', loginIpLimiter, loginLimiter, async (req, res) => {
  try {
    const { username, passphrase } = req.body || {};
    const trimmedUsername = typeof username === 'string' ? username.trim() : '';
    if (!trimmedUsername || trimmedUsername.length > 255) {
      return res.status(400).json({ error: 'A valid username is required' });
    }
    if (!passphrase || typeof passphrase !== 'string' || passphrase.length > 1024) {
      return res.status(400).json({ error: 'A valid passphrase is required' });
    }

    const user = db.prepare("SELECT id, passphrase_hash, totp_secret, totp_last_step, totp_recovery FROM users WHERE lower(username) = lower(?)").get(trimmedUsername);

    let match = await bcrypt.compare(passphrase, user ? user.passphrase_hash : DUMMY_PASSPHRASE_HASH);
    // Older builds trimmed passphrases when an admin set them, so accept the
    // trimmed form for accounts created that way.
    if (!match && user && passphrase.trim() !== passphrase) {
      match = await bcrypt.compare(passphrase.trim(), user.passphrase_hash);
    }

    if (!user || !match) {
      return res.status(401).json({ error: 'Incorrect username or passphrase' });
    }

    // Two-step sign-in: the passphrase was right, now ask for (or check) the code.
    if (user.totp_secret) {
      const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
      if (!code) return res.status(401).json({ error: 'Enter the 6-digit code from your authenticator app', totp_required: true });
      if (!consumeSecondFactor(user.id, code)) return res.status(401).json({ error: 'That code did not work. Try the newest code, or a recovery code.', totp_required: true });
    }

    // Generate a token with a matching server-side and browser-side 90-day
    // expiry. Pruning here keeps unused records bounded even on low traffic.
    const token = randomUUID();
    createSessionAndPrune(token, user.id, deviceLabel(req.get('user-agent')));

    // Set httpOnly, SameSite=Strict cookie with 90-day expiry
    res.cookie('endpaper_session', token, { ...sessionCookieOptions(req), maxAge: SESSION_TTL_MS });

    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'Login error');
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
    db.prepare("DELETE FROM sessions WHERE token = ?").run(hashSessionToken(token));
  }
  clearSessionCookie(req, res);
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
