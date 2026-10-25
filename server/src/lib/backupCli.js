'use strict';

// Write a full, restorable library backup (database plus every EPUB and cover)
// to data/backups/full. Safe to run while Endpaper is serving readers: the
// database is read in one consistent transaction, unlike copying the live
// SQLite file, which can capture a half-written WAL.
//
//   npm run backup              keeps the newest 3 archives
//   npm run backup -- --keep 7
const { writeFullBackup } = require('./libraryArchive');

const keepIndex = process.argv.indexOf('--keep');
const keep = keepIndex > -1 ? Math.max(1, Number(process.argv[keepIndex + 1]) || 3) : 3;

writeFullBackup({ keep })
  .then(result => {
    console.log(`Backed up ${result.bookCount} book(s) to ${result.path} (${result.bytes < 1048576 ? `${Math.max(1, Math.round(result.bytes / 1024))} KB` : `${(result.bytes / 1048576).toFixed(1)} MB`}). Restore it from Library tools → Import backup.`);
  })
  .catch(err => {
    console.error(`Backup failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(), 100));
