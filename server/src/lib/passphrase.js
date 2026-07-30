#!/usr/bin/env node
'use strict';

/**
 * CLI tool to set the Endpaper passphrase.
 *
 * Usage:
 *   node src/lib/passphrase.js --set "my secret phrase"
 *
 * This hashes the passphrase with bcrypt and stores it in the SQLite settings table.
 * Must be run once before the app will accept logins.
 */

const bcrypt = require('bcrypt');
const SALT_ROUNDS = 10;

async function main() {
  const args = process.argv.slice(2);

  if (args[0] !== '--set' || !args[1]) {
    console.error('Usage: node src/lib/passphrase.js --set "<passphrase>"');
    process.exit(1);
  }

  const passphrase = args[1];

  if (passphrase.length < 4) {
    console.error('Error: Passphrase must be at least 4 characters.');
    process.exit(1);
  }

  // Import db here so it creates data dir / schema if needed
  const db = require('../db');

  const hash = await bcrypt.hash(passphrase, SALT_ROUNDS);

  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES ('passphrase_hash', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  stmt.run(hash);

  console.log('✓ Passphrase set successfully.');
  console.log('  You can now log in to Endpaper with this passphrase.');

  process.exit(0);
}

main().catch(err => {
  console.error('Failed to set passphrase:', err);
  process.exit(1);
});
