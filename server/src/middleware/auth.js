'use strict';

const db = require('../db');
const { hashSessionToken } = require('../lib/sessionToken');

const findValidSession = db.prepare(`
  SELECT user_id, last_seen_at
  FROM sessions
  WHERE token = ?
    AND expires_at IS NOT NULL
    AND datetime(expires_at) > CURRENT_TIMESTAMP
    AND (last_seen_at IS NULL OR datetime(last_seen_at) > datetime('now', ?))
`);
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
// Sessions slide: each visit pushes the 90-day expiry forward, but a session
// unused for SESSION_IDLE_DAYS (default 30) is treated as signed out.
const SESSION_IDLE_DAYS = Math.max(1, Math.min(365, Number(process.env.SESSION_IDLE_DAYS) || 30));
const IDLE_MODIFIER = `-${SESSION_IDLE_DAYS} days`;
const touchSession = db.prepare("UPDATE sessions SET last_seen_at = datetime('now'), expires_at = datetime('now', '+90 days') WHERE token = ?");
// Throttle last-seen writes; the devices list only needs minute-level accuracy.
const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;

// Mark the cookie Secure whenever the request arrived over HTTPS (directly or,
// with trust proxy, via X-Forwarded-Proto). Plain-HTTP private deployments such
// as a Tailscale IP still get a cookie the browser will keep.
function sessionCookieOptions(req) {
  return {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'strict',
    path: '/',
  };
}

function clearSessionCookie(req, res) {
  res.clearCookie('endpaper_session', sessionCookieOptions(req));
}

/**
 * Auth middleware: checks for a valid session cookie on all /api/* routes
 * except /api/login and /api/session. The session token is a high-entropy,
 * server-stored UUID; no additional signing secret is required.
 */
function authMiddleware(req, res, next) {
  // When mounted at /api via app.use('/api', ...), req.path is relative to the mount.
  // Use req.originalUrl for absolute path matching.
  const fullPath = req.originalUrl.split('?')[0]; // strip query string

  // Skip auth for login endpoint
  if (fullPath === '/api/login') return next();

  const token = req.cookies && req.cookies['endpaper_session'];

  if (!token) {
    // For /api/session, return 401 cleanly (used to check auth status)
    if (fullPath === '/api/session') {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tokenHash = hashSessionToken(token);
  let row;
  try {
    row = findValidSession.get(tokenHash, IDLE_MODIFIER);
  } catch (err) {
    return next(err);
  }

  if (!row) {
    // Avoid repeatedly sending an unusable token after expiry or logout.
    try { deleteSession.run(tokenHash); } catch (err) { return next(err); }
    clearSessionCookie(req, res);
    if (fullPath === '/api/session') {
      return res.status(401).json({ error: 'Invalid session' });
    }
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.user_id = row.user_id;
  req.session_token_hash = tokenHash;
  const lastSeen = Date.parse(row.last_seen_at ? row.last_seen_at.replace(' ', 'T') + 'Z' : '');
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > LAST_SEEN_INTERVAL_MS) {
    try { touchSession.run(tokenHash); } catch (err) { return next(err); }
    // Keep the browser cookie's lifetime in step with the sliding server expiry.
    res.cookie('endpaper_session', token, { ...sessionCookieOptions(req), maxAge: 90 * 24 * 60 * 60 * 1000 });
  }

  next();
}

module.exports = { authMiddleware, sessionCookieOptions, clearSessionCookie };
