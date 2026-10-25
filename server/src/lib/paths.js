'use strict';

const path = require('path');

// In a checkout the server lives in server/, next to data/ and public/.
// The Docker image only contains server/, so it sets both variables explicitly.
const REPO_ROOT = path.resolve(__dirname, '../../..');

const DATA_DIR = process.env.ENDPAPER_DATA_DIR
  ? path.resolve(process.env.ENDPAPER_DATA_DIR)
  : path.join(REPO_ROOT, 'data');

const PUBLIC_DIR = process.env.ENDPAPER_PUBLIC_DIR
  ? path.resolve(process.env.ENDPAPER_PUBLIC_DIR)
  : path.join(REPO_ROOT, 'public');

module.exports = { DATA_DIR, PUBLIC_DIR };
