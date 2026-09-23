'use strict';

/* Generates the authoritative architecture/source document from this checkout.
 * Run with: node scripts/generate-architecture-source.js */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'ARCHITECTURE_AND_SOURCE.md');
const ignoredDirectories = new Set(['.git', 'node_modules', 'data', '.tmp-smoke-endpaper', 'test-results', 'playwright-report']);
const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.epub', '.zip', '.db', '.sqlite', '.woff', '.woff2']);

function collect(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'ARCHITECTURE_AND_SOURCE.md') return [];
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : collect(absolute);
    return entry.isFile() ? [absolute] : [];
  });
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function isBinary(file, buffer) {
  return binaryExtensions.has(path.extname(file).toLowerCase()) || buffer.includes(0);
}

function language(file) {
  const extension = path.extname(file).toLowerCase();
  return ({ '.js': 'javascript', '.json': 'json', '.css': 'css', '.html': 'html', '.svg': 'xml', '.yml': 'yaml', '.yaml': 'yaml', '.md': 'markdown', '.dockerfile': 'dockerfile' })[extension] || (path.basename(file) === 'Dockerfile' ? 'dockerfile' : 'text');
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const files = collect(root).sort((a, b) => relative(a).localeCompare(relative(b)));
const fileRecords = files.map(file => {
  const bytes = fs.readFileSync(file);
  return { file, bytes, binary: isBinary(file, bytes) };
});
const textFiles = fileRecords.filter(record => !record.binary);
const binaryFiles = fileRecords.filter(record => record.binary);
const generatedAt = new Date().toISOString();

const architecture = `# Endpaper — Architecture and Complete Current Source\n\n` +
`> Generated from the working tree on ${generatedAt}. Run \`node scripts/generate-architecture-source.js\` after any source change. This document is an auditable snapshot; the files in the checkout remain authoritative.\n\n` +
`## Architecture\n\n` +
`Endpaper is a zero-build, self-hosted EPUB reader. The browser application in \`public/\` is vanilla HTML, CSS, and JavaScript; its Express/SQLite backend is in \`server/\`. Shared book metadata and files live on the server, while each reader's progress, annotations, sessions, and settings remain per-user.\n\n` +
`The reader loads EPUB archives as explicit binary input (\`ePub(); await book.open(arrayBuffer, 'binary')\`) rather than extension-less Blob URLs. Initial text rendering is protected by a watchdog and recovery state; annotation and indexing work follows first paint. Reader chrome overlays the fixed reader viewport, avoiding resize-driven navigation races.\n\n` +
`A dedicated narrow-screen presentation in \`public/mobile.js\` provides Home, Library, Search, More, Series, Book Detail, Offline Downloads, Notebook, and Stats screens over the same application state and API. WebKit browser tests exercise mobile reading and offline flows.\n\n` +
`SQLite uses WAL, foreign keys, migration backups, and schema version 4. EPUB metadata extraction validates archive limits and now derives bounded text-only word counts from spine documents. The client consumes \`word_count\` for reading estimates rather than compressed EPUB byte size.\n\n` +
`The service worker keeps each installed shell version coherent until activation, with version-addressed scripts and styles. It also has a transient runtime cache and a persistent \`endpaper-pinned-books\` cache. Offline pinning is acknowledged after the book bytes reach the persistent cache. After an online passphrase sign-in, the browser stores an encrypted account-scoped library snapshot so a cold offline launch can restore the catalogue and open pinned books.\n\n` +
`## Source inventory\n\n` +
`- Text/source files embedded below: ${textFiles.length}\n` +
`- Binary assets catalogued by SHA-256: ${binaryFiles.length}\n\n` +
`## Complete text source\n\n`;

const source = textFiles.map(({ file, bytes }) => {
  const contents = bytes.toString('utf8').replace(/\r\n/g, '\n');
  const fence = '`````';
  return `### \`${relative(file)}\`\n\nSize: ${bytes.length.toLocaleString()} bytes · SHA-256: \`${digest(bytes)}\`\n\n${fence}${language(file)}\n${contents}${fence}\n`;
}).join('\n');

const assets = `## Binary asset inventory\n\n` +
`Binary files are intentionally not pasted as text. Their exact current bytes are identified here.\n\n` +
`| Path | Bytes | SHA-256 |\n|---|---:|---|\n` +
binaryFiles.map(({ file, bytes }) => `| \`${relative(file)}\` | ${bytes.length.toLocaleString()} | \`${digest(bytes)}\` |`).join('\n') + '\n';

fs.writeFileSync(output, architecture + source + assets, 'utf8');
console.log(`Wrote ${relative(output)} with ${textFiles.length} text files and ${binaryFiles.length} binary assets.`);
