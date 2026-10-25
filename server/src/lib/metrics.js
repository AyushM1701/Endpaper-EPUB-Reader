'use strict';

// Prometheus metrics at GET /metrics. Off unless METRICS_TOKEN is set; scrapers
// then send "Authorization: Bearer <token>". Nothing personal is exposed:
// only counts, sizes and request totals.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { DATA_DIR } = require('./paths');

const requestCounts = new Map();

function countRequests(req, res, next) {
  res.on('finish', () => {
    const key = `${req.method}|${Math.floor(res.statusCode / 100)}xx`;
    requestCounts.set(key, (requestCounts.get(key) || 0) + 1);
  });
  next();
}

function tokenMatches(header, token) {
  const supplied = /^Bearer\s+(.+)$/i.exec(header || '')?.[1] || '';
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b) && supplied.length > 0;
}

function metricsHandler(req, res) {
  const token = process.env.METRICS_TOKEN;
  if (!token) return res.status(404).type('text/plain').send('Not found');
  if (!tokenMatches(req.get('authorization'), token)) return res.status(401).set('WWW-Authenticate', 'Bearer').type('text/plain').send('Unauthorized');
  const scalar = sql => db.prepare(sql).get().n || 0;
  let dbBytes = 0;
  for (const suffix of ['', '-wal']) {
    try { dbBytes += fs.statSync(path.join(DATA_DIR, `endpaper.db${suffix}`)).size; } catch (_) {}
  }
  const memory = process.memoryUsage();
  const lines = [
    ['endpaper_books', 'gauge', 'Books in the shared library', scalar('SELECT COUNT(*) AS n FROM books')],
    ['endpaper_book_bytes', 'gauge', 'Total size of stored EPUB files', scalar('SELECT COALESCE(SUM(file_size), 0) AS n FROM books')],
    ['endpaper_users', 'gauge', 'Accounts', scalar('SELECT COUNT(*) AS n FROM users')],
    ['endpaper_active_sessions', 'gauge', 'Signed-in sessions that have not expired', scalar("SELECT COUNT(*) AS n FROM sessions WHERE datetime(expires_at) > CURRENT_TIMESTAMP")],
    ['endpaper_reading_seconds_total', 'counter', 'Reading time recorded across all accounts', scalar('SELECT COALESCE(SUM(duration_seconds), 0) AS n FROM reading_sessions')],
    ['endpaper_highlights', 'gauge', 'Highlights across all accounts', scalar('SELECT COUNT(*) AS n FROM highlights')],
    ['endpaper_database_bytes', 'gauge', 'SQLite database size including the WAL', dbBytes],
    ['process_resident_memory_bytes', 'gauge', 'Resident memory of the server process', memory.rss],
    ['process_uptime_seconds', 'gauge', 'Seconds since the server started', Math.round(process.uptime())],
  ];
  let body = '';
  for (const [name, type, help, value] of lines) body += `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}\n`;
  body += '# HELP endpaper_http_requests_total HTTP requests by method and status class\n# TYPE endpaper_http_requests_total counter\n';
  for (const [key, value] of [...requestCounts.entries()].sort()) {
    const [method, status] = key.split('|');
    body += `endpaper_http_requests_total{method="${method}",status="${status}"} ${value}\n`;
  }
  res.set('Cache-Control', 'no-store').type('text/plain; version=0.0.4').send(body);
}

module.exports = { countRequests, metricsHandler };
