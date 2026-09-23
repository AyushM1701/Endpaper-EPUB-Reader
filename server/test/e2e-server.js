'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'endpaper-e2e-'));
process.env.ENDPAPER_DATA_DIR = dataDir;
process.env.PORT = process.env.PORT || '39137';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
execFileSync(process.execPath, [path.join(__dirname, '../src/lib/passphrase.js'), '--set', 'correct horse battery', 'admin'], {
  cwd: path.join(__dirname, '..'), env: process.env,
});
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {} });
require('../src/index.js');
