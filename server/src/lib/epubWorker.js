const { parentPort, workerData } = require('worker_threads');
const { extractMeta, validateEpub } = require('./epubMeta');
const fs = require('fs');

try {
  validateEpub(workerData.tmpPath);
} catch (e) {
  parentPort.postMessage({ success: false, validationError: true, error: e.message });
  process.exit(0);
}

try {
  fs.renameSync(workerData.tmpPath, workerData.destPath);
} catch (e) {
  parentPort.postMessage({ success: false, validationError: false, error: e.message });
  process.exit(0);
}

let meta;
try {
  meta = extractMeta(workerData.destPath, workerData.id, workerData.coversDir);
} catch (e) {
  // If metadata extraction fails, we still consider it a success with empty meta
  // In the original, it also logged the error to console, but we'll do it on the main thread if needed
  meta = { _extractError: e.message, title: '', author: '', series: null, seriesIndex: null, coverPath: null };
}

parentPort.postMessage({ success: true, meta });
