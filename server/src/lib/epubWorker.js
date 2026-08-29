const { parentPort, workerData } = require('worker_threads');
const { extractMeta, validateEpub } = require('./epubMeta');
const fs = require('fs');
const crypto = require('crypto');

(async () => {
  try {
    await validateEpub(workerData.tmpPath);
  } catch (e) {
    parentPort.postMessage({ success: false, validationError: true, error: e.message });
    process.exit(0);
  }

  let fileHash;
  try {
    fileHash = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(workerData.tmpPath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  } catch (e) {
    parentPort.postMessage({ success: false, validationError: false, error: e.message });
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
    meta = await extractMeta(workerData.destPath, workerData.id, workerData.coversDir);
  } catch (e) {
    meta = { _extractError: e.message, title: '', author: '', series: null, seriesIndex: null, coverPath: null };
  }

  meta.file_hash = fileHash;
  parentPort.postMessage({ success: true, meta });
})();
