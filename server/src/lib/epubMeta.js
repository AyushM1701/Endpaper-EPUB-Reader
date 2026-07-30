'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) => ['item', 'itemref', 'reference', 'meta', 'dc:creator', 'dc:identifier'].includes(name),
});

/**
 * Extract metadata and cover image from an EPUB file.
 *
 * @param {string} epubPath - Absolute path to the .epub file
 * @param {string} coverId  - UUID to use for the cover filename
 * @param {string} coversDir - Absolute path to data/covers/
 * @returns {{ title, author, series, seriesIndex, coverPath }}
 */
function extractMeta(epubPath, coverId, coversDir) {
  const zip = new AdmZip(epubPath);
  const result = { title: '', author: '', series: null, seriesIndex: null, coverPath: null };

  // 1. Find the OPF file via container.xml
  const containerEntry = zip.getEntry('META-INF/container.xml');
  if (!containerEntry) return result;

  const containerXml = containerEntry.getData().toString('utf8');
  const container = parser.parse(containerXml);

  let opfPath = '';
  try {
    const rootfile = container.container.rootfiles.rootfile;
    opfPath = Array.isArray(rootfile) ? rootfile[0]['@_full-path'] : rootfile['@_full-path'];
  } catch (e) {
    return result;
  }

  // 2. Parse the OPF file
  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) return result;

  const opfXml = opfEntry.getData().toString('utf8');
  const opf = parser.parse(opfXml);
  const pkg = opf['package'] || opf['opf:package'] || {};
  const metadata = pkg.metadata || pkg['opf:metadata'] || {};
  const manifest = pkg.manifest || {};
  const items = Array.isArray(manifest.item) ? manifest.item : (manifest.item ? [manifest.item] : []);

  // Resolve directory of OPF for relative paths
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // 3. Extract title
  const dcTitle = metadata['dc:title'];
  if (dcTitle) {
    result.title = typeof dcTitle === 'string' ? dcTitle : (dcTitle['#text'] || dcTitle.toString());
  }

  // 4. Extract author
  const dcCreator = metadata['dc:creator'];
  if (dcCreator) {
    if (Array.isArray(dcCreator)) {
      result.author = dcCreator.map(c => typeof c === 'string' ? c : (c['#text'] || '')).filter(Boolean).join(', ');
    } else {
      result.author = typeof dcCreator === 'string' ? dcCreator : (dcCreator['#text'] || '');
    }
  }

  // 5. Extract series (Calibre meta)
  const metas = Array.isArray(metadata.meta) ? metadata.meta : (metadata.meta ? [metadata.meta] : []);
  for (const m of metas) {
    if (m['@_name'] === 'calibre:series') {
      result.series = m['@_content'] || null;
    }
    if (m['@_name'] === 'calibre:series_index') {
      result.seriesIndex = parseFloat(m['@_content']) || null;
    }
  }

  // 6. Find cover image
  let coverHref = null;

  // Method A: <meta name="cover" content="cover-image-id"/>
  const coverMeta = metas.find(m => m['@_name'] === 'cover');
  if (coverMeta) {
    const covItem = items.find(i => i['@_id'] === coverMeta['@_content']);
    if (covItem) coverHref = covItem['@_href'];
  }

  // Method B: item with properties="cover-image" (EPUB3)
  if (!coverHref) {
    const covItem = items.find(i => (i['@_properties'] || '').includes('cover-image'));
    if (covItem) coverHref = covItem['@_href'];
  }

  // Method C: look for common cover filenames
  if (!coverHref) {
    const covItem = items.find(i => {
      const href = (i['@_href'] || '').toLowerCase();
      const mediaType = (i['@_media-type'] || '').toLowerCase();
      return mediaType.startsWith('image/') && (href.includes('cover') || href.includes('frontcover'));
    });
    if (covItem) coverHref = covItem['@_href'];
  }

  // 7. Extract the cover image file from the zip
  if (coverHref) {
    const coverZipPath = opfDir + coverHref;
    // Try exact path first, then case-insensitive search
    let coverEntry = zip.getEntry(coverZipPath);
    if (!coverEntry) {
      const lowerPath = coverZipPath.toLowerCase();
      coverEntry = zip.getEntries().find(e => e.entryName.toLowerCase() === lowerPath);
    }

    if (coverEntry) {
      const coverData = coverEntry.getData();
      const ext = path.extname(coverHref).toLowerCase() || '.jpg';
      const coverFilename = coverId + ext;
      const coverOutPath = path.join(coversDir, coverFilename);

      try {
        fs.writeFileSync(coverOutPath, coverData);
        result.coverPath = coverFilename;
      } catch (e) {
        console.error('Could not save cover image:', e.message);
      }
    }
  }

  return result;
}

module.exports = { extractMeta };
