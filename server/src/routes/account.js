'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const db = require('../db');
const logger = require('../lib/logger');

const router = express.Router();

// Session rows are keyed by the token's SHA-256. The API never returns that
// hash; a short prefix is enough to address one of a user's own sessions.
const SESSION_ID_LENGTH = 16;
const SESSION_ID_RE = /^[0-9a-f]{16}$/;

// SQLite datetime('now') values are UTC without a zone marker.
function sqliteTimeToIso(value) {
  if (!value) return null;
  const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// A stolen session should not be able to brute-force the current passphrase.
const passphraseChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: req => `passphrase:${req.user_id}`,
});

/**
 * POST /api/account/passphrase
 * Body: { current, next }
 * Changes the signed-in user's passphrase and signs out every other device.
 * A wrong current passphrase is a 400, not a 401: the session itself is valid.
 */
router.post('/api/account/passphrase', passphraseChangeLimiter, async (req, res) => {
  try {
    const { current, next } = req.body || {};
    if (typeof current !== 'string' || !current || current.length > 1024) {
      return res.status(400).json({ error: 'Enter your current passphrase' });
    }
    if (typeof next !== 'string' || next.trim().length < 12 || next.length > 1024) {
      return res.status(400).json({ error: 'The new passphrase must be at least 12 characters' });
    }
    const user = db.prepare('SELECT passphrase_hash FROM users WHERE id = ?').get(req.user_id);
    if (!user || !(await bcrypt.compare(current, user.passphrase_hash))) {
      return res.status(400).json({ error: 'Your current passphrase is incorrect' });
    }
    const hash = await bcrypt.hash(next, 10);
    const signedOut = db.transaction(() => {
      db.prepare('UPDATE users SET passphrase_hash = ? WHERE id = ?').run(hash, req.user_id);
      return db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user_id, req.session_token_hash).changes;
    })();
    res.json({ ok: true, signed_out_sessions: signedOut });
  } catch (err) {
    logger.error({ err }, 'Passphrase change error');
    res.status(500).json({ error: 'Could not change the passphrase' });
  }
});

/**
 * GET /api/account/sessions
 * Lists the signed-in user's active sessions, newest activity first.
 */
router.get('/api/account/sessions', (req, res) => {
  const rows = db.prepare(`
    SELECT token, device_label, created_at, last_seen_at, expires_at
    FROM sessions
    WHERE user_id = ? AND expires_at IS NOT NULL AND datetime(expires_at) > CURRENT_TIMESTAMP
    ORDER BY COALESCE(last_seen_at, created_at) DESC
  `).all(req.user_id);
  res.json({
    sessions: rows.map(row => ({
      id: row.token.slice(0, SESSION_ID_LENGTH),
      label: row.device_label || 'Unknown device',
      created_at: sqliteTimeToIso(row.created_at),
      last_seen_at: sqliteTimeToIso(row.last_seen_at || row.created_at),
      expires_at: sqliteTimeToIso(row.expires_at),
      current: row.token === req.session_token_hash,
    })),
  });
});

/**
 * DELETE /api/account/sessions/:id
 * Signs out one of the user's other devices. The current device uses /api/logout.
 */
router.delete('/api/account/sessions/:id', (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  if (!SESSION_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid session' });
  if (req.session_token_hash.startsWith(id)) {
    return res.status(400).json({ error: 'Use Log out to sign out of this device' });
  }
  const result = db.prepare('DELETE FROM sessions WHERE user_id = ? AND substr(token, 1, ?) = ?')
    .run(req.user_id, SESSION_ID_LENGTH, id);
  if (result.changes === 0) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true });
});

// ---------- Two-factor sign-in (TOTP) ----------
const totp = require('../lib/totp');

router.get('/api/account/totp', (req, res) => {
  const user = db.prepare('SELECT totp_secret, totp_recovery FROM users WHERE id = ?').get(req.user_id);
  const recovery = user?.totp_recovery ? JSON.parse(user.totp_recovery) : [];
  res.json({ enabled: Boolean(user?.totp_secret), recovery_codes_left: recovery.length });
});

// Step 1: create a secret for the authenticator app. Nothing changes until confirmed.
router.post('/api/account/totp/setup', (req, res) => {
  const user = db.prepare('SELECT username, totp_secret FROM users WHERE id = ?').get(req.user_id);
  if (user.totp_secret) return res.status(400).json({ error: 'Two-step sign-in is already on' });
  const secret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_pending_secret = ? WHERE id = ?').run(secret, req.user_id);
  res.json({ secret, otpauth_url: totp.otpauthUrl(secret, user.username) });
});

// Step 2: a correct code from the app turns it on and returns one-time recovery codes.
// The current passphrase is required, so someone holding an unlocked device cannot enrol their own phone.
router.post('/api/account/totp/enable', passphraseChangeLimiter, async (req, res) => {
  const user = db.prepare('SELECT passphrase_hash, totp_pending_secret FROM users WHERE id = ?').get(req.user_id);
  if (!user?.totp_pending_secret) return res.status(400).json({ error: 'Start setup first' });
  const passphrase = req.body?.passphrase;
  if (typeof passphrase !== 'string' || !passphrase || passphrase.length > 1024 || !(await bcrypt.compare(passphrase, user.passphrase_hash))) {
    return res.status(400).json({ error: 'Your current passphrase is incorrect' });
  }
  const step = totp.verify(user.totp_pending_secret, req.body?.code);
  if (step == null) return res.status(400).json({ error: 'That code did not match. Check the time on your phone and try again.' });
  const codes = totp.generateRecoveryCodes();
  db.prepare('UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_last_step = ?, totp_recovery = ? WHERE id = ?')
    .run(step, JSON.stringify(codes.map(totp.hashRecoveryCode)), req.user_id);
  res.json({ enabled: true, recovery_codes: codes });
});

router.post('/api/account/totp/disable', passphraseChangeLimiter, (req, res) => {
  const user = db.prepare('SELECT totp_secret, totp_last_step, totp_recovery FROM users WHERE id = ?').get(req.user_id);
  if (!user?.totp_secret) return res.json({ enabled: false });
  const ok = totp.verify(user.totp_secret, req.body?.code, { lastUsedStep: user.totp_last_step }) != null
    || JSON.parse(user.totp_recovery || '[]').includes(totp.hashRecoveryCode(req.body?.code || ''));
  if (!ok) return res.status(400).json({ error: 'Enter a current code from your authenticator app or a recovery code' });
  db.prepare('UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = NULL, totp_recovery = NULL WHERE id = ?').run(req.user_id);
  res.json({ enabled: false });
});

/**
 * GET /api/account/opds — whether an app key exists.
 * POST /api/account/opds — create (or replace) the app key; shown once.
 * DELETE /api/account/opds — revoke it.
 */
router.get('/api/account/opds', (req, res) => {
  const user = db.prepare('SELECT username, opds_key_hash FROM users WHERE id = ?').get(req.user_id);
  res.json({ enabled: Boolean(user?.opds_key_hash), username: user?.username || null, path: '/opds' });
});

router.post('/api/account/opds', (req, res) => {
  const key = crypto.randomBytes(18).toString('base64url');
  db.prepare('UPDATE users SET opds_key_hash = ? WHERE id = ?').run(crypto.createHash('sha256').update(key).digest('hex'), req.user_id);
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.user_id);
  res.json({ enabled: true, username: user.username, key, path: '/opds' });
});

router.delete('/api/account/opds', (req, res) => {
  db.prepare('UPDATE users SET opds_key_hash = NULL WHERE id = ?').run(req.user_id);
  res.json({ enabled: false });
});

/**
 * POST /api/account/sessions/revoke-others
 * Signs out every device except this one.
 */
router.post('/api/account/sessions/revoke-others', (req, res) => {
  const result = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user_id, req.session_token_hash);
  res.json({ ok: true, signed_out_sessions: result.changes });
});

module.exports = router;
