'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

// Keys that must never be exposed or overwritten via the API
const SENSITIVE_KEYS = ['passphrase_hash', 'session_token'];

/**
 * GET /api/settings
 * Returns all non-sensitive settings as a JSON object.
 */
router.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    if (!SENSITIVE_KEYS.includes(row.key)) {
      // Try to parse JSON values, fall back to string
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch (e) {
        settings[row.key] = row.value;
      }
    }
  }
  res.json(settings);
});

/**
 * PUT /api/settings
 * Body: { key: value, key2: value2, ... }
 * Upserts each key-value pair into the settings table.
 * Sensitive keys are rejected.
 */
router.put('/api/settings', (req, res) => {
  const body = req.body;

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const runAll = db.transaction((entries) => {
    for (const [key, value] of entries) {
      if (SENSITIVE_KEYS.includes(key)) continue;
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      upsert.run(key, serialized);
    }
  });

  runAll(Object.entries(body));

  res.json({ ok: true });
});

module.exports = router;
