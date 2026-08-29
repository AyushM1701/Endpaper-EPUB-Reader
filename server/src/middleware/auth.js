'use strict';

const db = require('../db');

const findValidSession = db.prepare(`
  SELECT user_id
  FROM sessions
  WHERE token = ?
    AND expires_at IS NOT NULL
    AND datetime(expires_at) > CURRENT_TIMESTAMP
`);
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');

function clearSessionCookie(res) {
  res.clearCookie('endpaper_session', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
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

  let row;
  try {
    row = findValidSession.get(token);
  } catch (err) {
    return next(err);
  }

  if (!row) {
    // Avoid repeatedly sending an unusable token after expiry or logout.
    try { deleteSession.run(token); } catch (err) { return next(err); }
    clearSessionCookie(res);
    if (fullPath === '/api/session') {
      return res.status(401).json({ error: 'Invalid session' });
    }
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.user_id = row.user_id;

  next();
}

module.exports = { authMiddleware };
