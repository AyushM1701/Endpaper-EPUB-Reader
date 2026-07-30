'use strict';

const db = require('../db');

const SESSION_SECRET = process.env.SESSION_SECRET || 'endpaper-dev-secret-change-in-production';

/**
 * Auth middleware: checks for a valid session cookie on all /api/* routes
 * except /api/login and /api/session.
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

  // Validate the token against stored session
  const row = db.prepare("SELECT value FROM settings WHERE key = 'session_token'").get();

  if (!row || row.value !== token) {
    if (fullPath === '/api/session') {
      return res.status(401).json({ error: 'Invalid session' });
    }
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  next();
}

module.exports = { authMiddleware, SESSION_SECRET };
