'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COVER_FILE_RE = new RegExp(`^${UUID_RE.source.slice(1, -1)}\\.(?:jpe?g|png|gif|webp)$`, 'i');
const BOOK_FILE_RE = new RegExp(`^${UUID_RE.source.slice(1, -1)}\\.epub$`, 'i');

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isBookFilename(value) {
  return typeof value === 'string' && BOOK_FILE_RE.test(value);
}

function isCoverFilename(value) {
  return typeof value === 'string' && COVER_FILE_RE.test(value);
}

function text(value, { required = false, max = 500, field = 'value' } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be text`);
  const result = value.trim();
  if (required && !result) throw new Error(`${field} is required`);
  if (result.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return result || null;
}

function number(value, { min = -Infinity, max = Infinity, field = 'value', nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}`);
  }
  return value;
}

/**
 * Express middleware factory: validates that the named route param is a UUID.
 * Usage: router.get('/api/books/:id', validateUuidParam('id'), handler)
 */
function validateUuidParam(...paramNames) {
  return (req, res, next) => {
    for (const name of paramNames) {
      if (req.params[name] && !isUuid(req.params[name])) {
        return res.status(400).json({ error: `Invalid ${name} format` });
      }
    }
    next();
  };
}

module.exports = { isUuid, isBookFilename, isCoverFilename, text, number, validateUuidParam };
