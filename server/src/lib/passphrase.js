#!/usr/bin/env node
'use strict';

/**
 * CLI tool to create the first admin account, or reset an existing user's
 * passphrase (e.g. after a lockout), in Endpaper's multi-user schema.
 *
 * Usage:
 *   node src/lib/passphrase.js --set "my secret phrase" [username]
 *
 * If [username] is omitted, defaults to "admin". If that user doesn't exist
 * yet, it is created as an admin. If it already exists, its passphrase is
 * reset in place (its admin status is left untouched).
 */

const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const SALT_ROUNDS = 10;

async function main() {
  const args = process.argv.slice(2);

  if (args[0] !== '--set' || !args[1]) {
    console.error('Usage: node src/lib/passphrase.js --set "<passphrase>" [username]');
    process.exit(1);
  }

  const passphrase = args[1];
  const username = (args[2] || 'admin').trim();

  if (passphrase.length < 4) {
    console.error('Error: Passphrase must be at least 4 characters.');
    process.exit(1);
  }
  if (!username) {
    console.error('Error: Username cannot be blank.');
    process.exit(1);
  }

  // Import db here so it creates the data dir / schema (and runs migrations) if needed
  const db = require('../db');

  const hash = await bcrypt.hash(passphrase, SALT_ROUNDS);
  const existing = db.prepare('SELECT id, is_admin FROM users WHERE username = ?').get(username);

  if (existing) {
    db.transaction(() => {
      db.prepare('UPDATE users SET passphrase_hash = ? WHERE id = ?').run(hash, existing.id);
      // A reset is commonly used to revoke access, so invalidate every
      // browser session for this account rather than leaving it usable until
      // its normal expiry.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    })();
    console.log(`✓ Passphrase reset for existing user "${username}".`);
  } else {
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, username, passphrase_hash, is_admin) VALUES (?, ?, ?, 1)').run(id, username, hash);
    console.log(`✓ Admin user "${username}" created.`);
  }

  console.log('  You can now log in to Endpaper with this username and passphrase.');

  process.exit(0);
}

main().catch(err => {
  console.error('Failed to set passphrase:', err);
  process.exit(1);
});
