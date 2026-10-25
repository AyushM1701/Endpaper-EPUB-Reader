'use strict';

const pino = require('pino');

// One shared logger so routes and the database layer write structured JSON.
// Pass errors as { err } so pino serialises the message and stack:
//   logger.error({ err }, 'Upload failed')
// Request logs never carry credentials: a session cookie or app key in a log file
// would let anyone who reads (or is sent) the log sign in as that user.
module.exports = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    censor: '[redacted]',
  },
});
