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

// Shared by upload, PATCH and import so a backup always restores what the app wrote.
const BOOK_TEXT_LIMITS = Object.freeze({
  title: 500,
  author: 500,
  series: 500,
  description: 5000,
  isbn: 500,
  tags: 500,
});

const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;

function isHexColor(value) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

// Normalise untrusted metadata (EPUB fields) by truncating instead of rejecting.
function clip(value, max) {
  if (typeof value !== 'string') return null;
  const result = value.trim().slice(0, max).trim();
  return result || null;
}

// A reader's own tags: lower-case, de-duplicated, at most 20 of 40 characters.
function userTags(value) {
  if (value == null || value === '') return null;
  const values = Array.isArray(value) ? value : String(value).split(',');
  const normalized = [...new Set(values.map(item => String(item).trim().toLocaleLowerCase()).filter(Boolean))];
  if (normalized.length > 20 || normalized.some(item => item.length > 40)) throw new Error('tags must be at most 20 tags of 40 characters');
  return normalized.length ? JSON.stringify(normalized) : null;
}

function parseUserTags(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch (_) { return []; }
}

function text(value, { required = false, max = 500, field = 'value' } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be text`);
  const result = value.trim();
  if (required && !result) throw new Error(`${field} is required`);
  if (result.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return result || null;
}

function number(value, { min = -Infinity, max = Infinity, field = 'value', nullable = false, integer = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}`);
  }
  if (integer && !Number.isInteger(value)) throw new Error(`${field} must be a whole number`);
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

module.exports = {
  BOOK_TEXT_LIMITS,
  isUuid,
  isBookFilename,
  isCoverFilename,
  isHexColor,
  clip,
  userTags,
  parseUserTags,
  text,
  number,
  validateUuidParam,
};
