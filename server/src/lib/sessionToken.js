'use strict';

const crypto = require('crypto');

// The cookie carries a random token; the database only stores its SHA-256, so
// a leaked database file or backup snapshot cannot be replayed as a login.
// The token is high-entropy, so an unsalted fast hash is sufficient.
function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

const HASHED_TOKEN_RE = /^[0-9a-f]{64}$/;

function isHashedSessionToken(value) {
  return typeof value === 'string' && HASHED_TOKEN_RE.test(value);
}

module.exports = { hashSessionToken, isHashedSessionToken };
