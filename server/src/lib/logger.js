'use strict';

const pino = require('pino');

// One shared logger so routes and the database layer write structured JSON.
// Pass errors as { err } so pino serialises the message and stack:
//   logger.error({ err }, 'Upload failed')
module.exports = pino({ level: process.env.LOG_LEVEL || 'info' });
