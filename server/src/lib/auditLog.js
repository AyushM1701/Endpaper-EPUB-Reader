'use strict';

// Audit log of actions that change the shared library or accounts: who did
// what, to what, and when. Recorded only after the request succeeds. Values
// such as passphrases or descriptions are never stored, only which fields changed.
const db = require('../db');
const logger = require('./logger');

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    user_id TEXT,
    username TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    target_label TEXT,
    details TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at DESC);
`);

const SHARED_BOOK_FIELDS = ['title', 'author', 'series', 'series_index', 'description', 'isbn', 'tags'];
const bookTitle = id => db.prepare('SELECT title FROM books WHERE id = ?').get(id)?.title || null;
const userName = id => db.prepare('SELECT username FROM users WHERE id = ?').get(id)?.username || null;
const collectionName = id => db.prepare('SELECT name FROM collections WHERE id = ?').get(id)?.name || null;

// [method, path pattern, action, describe(req, match) -> { type, id, label, details } | null]
const AUDITED = [
  ['POST', /^\/api\/books$/, 'book.add', () => ({ type: 'book' })],
  ['PATCH', /^\/api\/books\/([^/]+)$/, 'book.edit', (req, m) => {
    const fields = SHARED_BOOK_FIELDS.filter(key => req.body?.[key] !== undefined);
    return fields.length ? { type: 'book', id: m[1], label: bookTitle(m[1]), details: { fields } } : null;
  }],
  ['DELETE', /^\/api\/books\/([^/]+)$/, 'book.remove', (req, m) => ({ type: 'book', id: m[1], label: bookTitle(m[1]) })],
  ['POST', /^\/api\/books\/([^/]+)\/cover$/, 'book.cover', (req, m) => ({ type: 'book', id: m[1], label: bookTitle(m[1]) })],
  ['POST', /^\/api\/users$/, 'user.create', req => ({ type: 'user', label: String(req.body?.username || '').trim().slice(0, 100), details: { admin: Boolean(req.body?.is_admin) } })],
  ['PATCH', /^\/api\/users\/([^/]+)$/, 'user.update', (req, m) => ({
    type: 'user', id: m[1], label: userName(m[1]),
    details: { ...(req.body?.is_admin !== undefined ? { admin: Boolean(req.body.is_admin) } : {}), ...(req.body?.passphrase !== undefined ? { passphrase_reset: true } : {}) },
  })],
  ['DELETE', /^\/api\/users\/([^/]+)$/, 'user.remove', (req, m) => ({ type: 'user', id: m[1], label: userName(m[1]) })],
  ['POST', /^\/api\/collections$/, 'collection.create', req => ({ type: 'collection', label: String(req.body?.name || '').trim().slice(0, 80) })],
  ['PATCH', /^\/api\/collections\/([^/]+)$/, 'collection.rename', (req, m) => ({ type: 'collection', id: m[1], label: collectionName(m[1]), details: { to: String(req.body?.name || '').trim().slice(0, 80) } })],
  ['DELETE', /^\/api\/collections\/([^/]+)$/, 'collection.remove', (req, m) => ({ type: 'collection', id: m[1], label: collectionName(m[1]) })],
  ['POST', /^\/api\/import$/, 'library.import', req => (req.query?.dry_run === '1' ? null : { type: 'library' })],
  ['POST', /^\/api\/export$/, 'library.export', () => ({ type: 'library' })],
  ['POST', /^\/api\/account\/passphrase$/, 'account.passphrase', () => ({ type: 'account' })],
  ['POST', /^\/api\/account\/opds$/, 'account.app_key_create', () => ({ type: 'account' })],
  ['DELETE', /^\/api\/account\/opds$/, 'account.app_key_revoke', () => ({ type: 'account' })],
  ['POST', /^\/api\/account\/totp\/enable$/, 'account.two_factor_on', () => ({ type: 'account' })],
  ['POST', /^\/api\/account\/totp\/disable$/, 'account.two_factor_off', () => ({ type: 'account' })],
];

const insert = db.prepare(`
  INSERT INTO audit_log (user_id, username, action, target_type, target_id, target_label, details)
  VALUES (@user_id, @username, @action, @target_type, @target_id, @target_label, @details)
`);

function auditMiddleware(req, res, next) {
  if (!req.user_id || req.method === 'GET') return next();
  const pathname = req.originalUrl.split('?')[0];
  const rule = AUDITED.find(([method, pattern]) => method === req.method && pattern.test(pathname));
  if (!rule) return next();
  const [, pattern, action, describe] = rule;
  // Describe before the handler runs, so a deleted book still has its title.
  let target;
  try { target = describe(req, pathname.match(pattern)); } catch (_) { target = { type: null }; }
  if (!target) return next();
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    try {
      insert.run({
        user_id: req.user_id,
        username: userName(req.user_id),
        action,
        target_type: target.type || null,
        target_id: target.id || res.locals.auditTargetId || null,
        target_label: target.label || res.locals.auditTargetLabel || null,
        details: target.details && Object.keys(target.details).length ? JSON.stringify(target.details) : null,
      });
    } catch (err) {
      logger.warn({ err }, 'Could not write audit log entry');
    }
  });
  next();
}

function listAudit({ limit = 100, before = null } = {}) {
  const rows = before
    ? db.prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
    : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map(row => ({ ...row, details: row.details ? JSON.parse(row.details) : null }));
}

function pruneAudit(days = 365) {
  return db.prepare("DELETE FROM audit_log WHERE at < datetime('now', ?)").run(`-${days} days`).changes;
}

module.exports = { auditMiddleware, listAudit, pruneAudit };
