'use strict';

const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const sharp = require('sharp');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) => ['item', 'itemref', 'reference', 'meta', 'dc:creator', 'dc:identifier'].includes(name),
});

const MAX_XML_BYTES = 1 * 1024 * 1024;
const MAX_COVER_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_COVER_PIXELS = 40 * 1024 * 1024;
const MAX_WORD_COUNT_BYTES = 20 * 1024 * 1024;
const MAX_WORD_COUNT_DOCUMENT_BYTES = 2 * 1024 * 1024;

function openZip(epubPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(epubPath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = new Map();
      let entryCount = 0;
      let totalBytes = 0;
      let finished = false;
      const fail = error => {
        if (finished) return;
        finished = true;
        try { zipfile.close(); } catch (_) {}
        reject(error);
      };
      zipfile.on('entry', entry => {
        entryCount++;
        totalBytes += entry.uncompressedSize || 0;
        const compressed = Math.max(1, entry.compressedSize || 0);
        if (entryCount > MAX_ARCHIVE_ENTRIES) return fail(new Error('EPUB contains too many files'));
        if (totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) return fail(new Error('EPUB expands to too much data'));
        if ((entry.uncompressedSize || 0) / compressed > MAX_COMPRESSION_RATIO) return fail(new Error('EPUB entry compression ratio is unsafe'));
        entries.set(entry.fileName.toLowerCase(), entry);
        zipfile.readEntry();
      });
      zipfile.on('end', () => {
        if (finished) return;
        finished = true;
        resolve({ zipfile, entries });
      });
      zipfile.on('error', fail);
      zipfile.readEntry();
    });
  });
}

function readEntry(zipfile, entry, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!entry) return reject(new Error('Entry not found'));
    if (entry.uncompressedSize > maxBytes) return reject(new Error('Entry too large'));
    
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err) return reject(err);
      const chunks = [];
      readStream.on('data', chunk => chunks.push(chunk));
      readStream.on('error', reject);
      readStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function validateEpub(epubPath) {
  const { zipfile, entries } = await openZip(epubPath);
  try {
    const mimetypeEntry = entries.get('mimetype');
    const containerEntry = entries.get('meta-inf/container.xml');
    
    if (!mimetypeEntry || !containerEntry) {
      throw new Error('The uploaded file is not a valid EPUB');
    }
    
    const mimetypeData = await readEntry(zipfile, mimetypeEntry, 128);
    if (mimetypeData.toString('utf8').trim() !== 'application/epub+zip') {
      throw new Error('The uploaded file is not a valid EPUB');
    }
    
    const containerData = await readEntry(zipfile, containerEntry, MAX_XML_BYTES);
    const container = parser.parse(containerData.toString('utf8'));
    const rootfile = container?.container?.rootfiles?.rootfile;
    const root = Array.isArray(rootfile) ? rootfile[0] : rootfile;
    const opfPath = root && root['@_full-path'];
    if (!opfPath || !entries.has(String(opfPath).toLowerCase())) throw new Error('The EPUB package document is missing');
    const opfData = await readEntry(zipfile, entries.get(String(opfPath).toLowerCase()), MAX_XML_BYTES);
    const opf = parser.parse(opfData.toString('utf8'));
    const pkg = opf.package || opf['opf:package'];
    const manifestItems = pkg?.manifest?.item;
    const spineItems = pkg?.spine?.itemref;
    if (!pkg || !manifestItems || !spineItems) throw new Error('The EPUB package has no readable manifest or spine');
  } finally {
    zipfile.close();
  }
}

async function extractMeta(epubPath, coverId, coversDir) {
  const { zipfile, entries } = await openZip(epubPath);
  const result = { title: '', author: '', series: null, seriesIndex: null, description: null, isbn: null, tags: null, coverPath: null, wordCount: null };

  try {
    const containerEntry = entries.get('meta-inf/container.xml');
    if (!containerEntry) return result;

    const containerData = await readEntry(zipfile, containerEntry, MAX_XML_BYTES);
    const container = parser.parse(containerData.toString('utf8'));

    let opfPath = '';
    try {
      const rootfile = container.container.rootfiles.rootfile;
      opfPath = Array.isArray(rootfile) ? rootfile[0]['@_full-path'] : rootfile['@_full-path'];
    } catch (e) {
      return result;
    }

    const opfEntry = entries.get(opfPath.toLowerCase());
    if (!opfEntry) return result;

    const opfData = await readEntry(zipfile, opfEntry, MAX_XML_BYTES);
    const opf = parser.parse(opfData.toString('utf8'));
    const pkg = opf['package'] || opf['opf:package'] || {};
    const metadata = pkg.metadata || pkg['opf:metadata'] || {};
    const manifest = pkg.manifest || {};
    const items = Array.isArray(manifest.item) ? manifest.item : (manifest.item ? [manifest.item] : []);

    const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

    // Count only XHTML/HTML spine documents. This deliberately has hard byte
    // limits so malformed archives cannot turn metadata extraction into an
    // unbounded memory operation.
    const spine = pkg.spine || {};
    const spineItems = Array.isArray(spine.itemref) ? spine.itemref : (spine.itemref ? [spine.itemref] : []);
    let countedBytes = 0;
    let words = 0;
    let wordCountIncomplete = false;
    for (const spineItem of spineItems) {
      const manifestItem = items.find(item => item['@_id'] === spineItem['@_idref']);
      const mediaType = String(manifestItem && manifestItem['@_media-type'] || '').toLowerCase();
      if (!manifestItem || !/(xhtml|html|xml)/.test(mediaType)) continue;
      const entry = entries.get((opfDir + decodeURI(manifestItem['@_href'] || '')).toLowerCase());
      if (!entry || entry.uncompressedSize > MAX_WORD_COUNT_DOCUMENT_BYTES || countedBytes + entry.uncompressedSize > MAX_WORD_COUNT_BYTES) { wordCountIncomplete = true; continue; }
      const source = (await readEntry(zipfile, entry, MAX_WORD_COUNT_DOCUMENT_BYTES)).toString('utf8');
      countedBytes += Buffer.byteLength(source);
      const plain = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<[^>]+>/gi, ' ').replace(/&(?:nbsp|amp|quot|#39|lt|gt);/gi, ' ');
      const matches = plain.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
      words += matches ? matches.length : 0;
    }
    result.wordCount = wordCountIncomplete ? null : (words || null);

    const dcTitle = metadata['dc:title'];
    if (dcTitle) {
      result.title = typeof dcTitle === 'string' ? dcTitle : (dcTitle['#text'] || dcTitle.toString());
    }

    const dcCreator = metadata['dc:creator'];
    if (dcCreator) {
      if (Array.isArray(dcCreator)) {
        result.author = dcCreator.map(c => typeof c === 'string' ? c : (c['#text'] || '')).filter(Boolean).join(', ');
      } else {
        result.author = typeof dcCreator === 'string' ? dcCreator : (dcCreator['#text'] || '');
      }
    }
    const description = metadata['dc:description'];
    if (description) result.description = typeof description === 'string' ? description : (description['#text'] || null);
    const subjects = metadata['dc:subject'];
    if (subjects) {
      const subjectList = Array.isArray(subjects) ? subjects : [subjects];
      result.tags = subjectList.map(subject => typeof subject === 'string' ? subject : subject['#text']).filter(Boolean).join(', ') || null;
    }
    const identifiers = Array.isArray(metadata['dc:identifier']) ? metadata['dc:identifier'] : (metadata['dc:identifier'] ? [metadata['dc:identifier']] : []);
    const isbn = identifiers.map(identifier => typeof identifier === 'string' ? identifier : identifier['#text']).find(value => /(?:97[89])?\d{9}[\dX]/i.test(String(value || '').replace(/[-\s]/g, '')));
    result.isbn = isbn ? String(isbn).trim() : null;

    const metas = Array.isArray(metadata.meta) ? metadata.meta : (metadata.meta ? [metadata.meta] : []);
    for (const m of metas) {
      if (m['@_name'] === 'calibre:series') result.series = m['@_content'] || null;
      if (m['@_name'] === 'calibre:series_index') {
        const parsed = parseFloat(m['@_content']);
        result.seriesIndex = Number.isFinite(parsed) ? parsed : null;
      }
    }

    let coverHref = null;
    const coverMeta = metas.find(m => m['@_name'] === 'cover');
    if (coverMeta) {
      const covItem = items.find(i => i['@_id'] === coverMeta['@_content']);
      if (covItem) coverHref = covItem['@_href'];
    }
    if (!coverHref) {
      const covItem = items.find(i => (i['@_properties'] || '').includes('cover-image'));
      if (covItem) coverHref = covItem['@_href'];
    }
    if (!coverHref) {
      const covItem = items.find(i => {
        const href = (i['@_href'] || '').toLowerCase();
        const mediaType = (i['@_media-type'] || '').toLowerCase();
        return mediaType.startsWith('image/') && (href.includes('cover') || href.includes('frontcover'));
      });
      if (covItem) coverHref = covItem['@_href'];
    }

    if (coverHref) {
      // url decode href in case it has spaces
      coverHref = decodeURI(coverHref);
      const coverZipPath = opfDir + coverHref;
      const coverEntry = entries.get(coverZipPath.toLowerCase());
      if (coverEntry) {
        const coverData = await readEntry(zipfile, coverEntry, MAX_COVER_BYTES);
        
        // Use sharp to process the image to a WebP
        const coverFilename = coverId + '.webp';
        const coverOutPath = path.join(coversDir, coverFilename);
        
        try {
          const image = sharp(coverData, { limitInputPixels: MAX_COVER_PIXELS, failOn: 'error' });
          const imageMeta = await image.metadata();
          if (imageMeta.width && imageMeta.height && imageMeta.width * imageMeta.height > MAX_COVER_PIXELS) {
            throw new Error('Cover image dimensions are too large');
          }
          await image
            .resize({ width: 400, withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(coverOutPath);
            
          result.coverPath = coverFilename;
        } catch (e) {
          console.error('Could not process/save cover image with sharp:', e.message);
        }
      }
    }

  } finally {
    zipfile.close();
  }
  return result;
}

module.exports = { extractMeta, validateEpub };
