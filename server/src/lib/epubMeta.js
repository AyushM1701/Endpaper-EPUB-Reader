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

function openZip(epubPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(epubPath, { lazyEntries: false, autoClose: false }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = new Map();
      zipfile.on('entry', entry => entries.set(entry.fileName.toLowerCase(), entry));
      zipfile.on('end', () => resolve({ zipfile, entries }));
      zipfile.on('error', reject);
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
    
    await readEntry(zipfile, containerEntry, MAX_XML_BYTES); // Validate size
  } finally {
    zipfile.close();
  }
}

async function extractMeta(epubPath, coverId, coversDir) {
  const { zipfile, entries } = await openZip(epubPath);
  const result = { title: '', author: '', series: null, seriesIndex: null, coverPath: null };

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

    const metas = Array.isArray(metadata.meta) ? metadata.meta : (metadata.meta ? [metadata.meta] : []);
    for (const m of metas) {
      if (m['@_name'] === 'calibre:series') result.series = m['@_content'] || null;
      if (m['@_name'] === 'calibre:series_index') result.seriesIndex = parseFloat(m['@_content']) || null;
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
          await sharp(coverData)
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
