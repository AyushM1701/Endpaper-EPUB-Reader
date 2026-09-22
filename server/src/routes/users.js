'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const db = require('../db');
const { validateUuidParam } = require('../lib/validation');

const router = express.Router();

/**
 * Middleware to ensure the current user is an admin.
 */
function requireAdmin(req, res, next) {
  const user = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(req.user_id);
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  next();
}

/**
 * GET /api/users
 * Lists all users.
 */
router.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY created_at ASC').all();
  res.json(users);
});

/**
 * POST /api/users
 * Creates a new user.
 * Body: { username: "...", passphrase: "...", is_admin: boolean }
 */
router.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { username, passphrase, is_admin } = req.body;

    if (!username || typeof username !== 'string' || username.trim().length === 0 || username.length > 255) {
      return res.status(400).json({ error: 'A valid username is required' });
    }
    if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) {
      return res.status(400).json({ error: 'A valid passphrase (min 12 characters) is required' });
    }
    if (is_admin !== undefined && typeof is_admin !== 'boolean') {
      return res.status(400).json({ error: 'is_admin must be a boolean' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE lower(username) = lower(?)').get(username.trim());
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const hash = await bcrypt.hash(passphrase, 10);
    const id = randomUUID();

    db.prepare('INSERT INTO users (id, username, passphrase_hash, is_admin) VALUES (?, ?, ?, ?)')
      .run(id, username.trim(), hash, is_admin ? 1 : 0);

    res.status(201).json({ id, username: username.trim(), is_admin: is_admin ? 1 : 0 });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE constraint failed'))) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/users/:id
 * Updates a user's role (is_admin) or resets their passphrase.
 * Body: { is_admin?: boolean, passphrase?: string }
 */
router.patch('/api/users/:id', validateUuidParam('id'), requireAdmin, async (req, res) => {
  try {
    const existing = db.prepare('SELECT id, username, is_admin, created_at FROM users WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { is_admin, passphrase } = req.body;
    if (is_admin === undefined && passphrase === undefined) {
      return res.status(400).json({ error: 'At least one field (is_admin or passphrase) must be provided' });
    }

    let newAdmin = existing.is_admin;
    if (is_admin !== undefined) {
      if (typeof is_admin !== 'boolean') {
        return res.status(400).json({ error: 'is_admin must be a boolean' });
      }
      const parsedAdmin = is_admin ? 1 : 0;
      if (req.params.id === req.user_id && parsedAdmin === 0) {
        return res.status(400).json({ error: 'You cannot remove your own admin privileges' });
      }
      newAdmin = parsedAdmin;
    }

    let newHash = null;
    if (passphrase !== undefined) {
      if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) {
        return res.status(400).json({ error: 'A valid passphrase (min 12 characters) is required' });
      }
      newHash = await bcrypt.hash(passphrase, 10);
    }

    db.transaction(() => {
      if (newHash !== null) {
        db.prepare('UPDATE users SET is_admin = ?, passphrase_hash = ? WHERE id = ?').run(newAdmin, newHash, req.params.id);
        // Revoke active sessions on passphrase reset
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
      } else {
        db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(newAdmin, req.params.id);
      }
    })();

    const updated = db.prepare('SELECT id, username, is_admin, created_at FROM users WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/users/:id
 * Deletes a user. Cannot delete yourself.
 */
router.delete('/api/users/:id', validateUuidParam('id'), requireAdmin, (req, res) => {
  if (req.params.id === req.user_id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({ ok: true });
});

module.exports = router;
module.exports.requireAdmin = requireAdmin;
