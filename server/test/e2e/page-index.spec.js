const { test, expect } = require('@playwright/test');
const Zip = require('../../../public/jszip.min.js');
let epub;
test.use({ serviceWorkers: 'block' });
test.beforeAll(async () => {
  const zip = new Zip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const manifest = [], spine = [];
  for (let i = 1; i <= 40; i++) {
    manifest.push(`<item id="ch${i}" href="chapter${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="ch${i}"/>`);
    const text = Array.from({ length: 12 }, (_, p) => `<p>Section ${i}, paragraph ${p}. ${'Reading position and text stay accurate while the index is calculated. '.repeat(12)}</p>`).join('');
    zip.file(`OEBPS/chapter${i}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${i}</title></head><body><h1>Chapter ${i}</h1>${text}</body></html>`);
  }
  zip.file('OEBPS/content.opf', `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">index-test</dc:identifier><dc:title>Page Index Test Book</dc:title><dc:creator>Endpaper Tests</dc:creator><dc:language>en</dc:language></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  epub = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
});
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.locator('#username-input').fill('admin');
  await page.locator('#passphrase-input').fill('correct horse battery');
  await page.locator('#login-btn').click();
  await expect(page.locator('#dropzone')).toHaveJSProperty('hidden', false);
  if (!(await page.evaluate(() => library.some(item => item.name === 'Page Index Test Book')))) {
    await page.locator('#file-input').setInputFiles({ name: 'page-index.epub', mimeType: 'application/epub+zip', buffer: epub });
    await expect.poll(() => page.evaluate(() => library.some(item => item.name === 'Page Index Test Book'))).toBe(true);
  }
});
async function open(page) {
  await expect.poll(() => page.evaluate(() => library.some(item => item.name === 'Page Index Test Book'))).toBe(true);
  await page.evaluate(async () => {
    window.indexStarted = performance.now();
    await openBook(library.find(item => item.name === 'Page Index Test Book').id);
  });
  await expect.poll(() => page.evaluate(() => readerNavigationReady)).toBe(true);
}
async function ready(page) {
  await expect.poll(() => page.evaluate(() => locationsReady), { timeout: 4000 }).toBe(true);
  await expect(page.locator('#mobile-reader-page-count')).toHaveText(/^\d+ of \d+$/);
}
async function spyGeneration(page) {
  await page.evaluate(() => {
    const original = window.ePub;
    window.indexGenerationCalls = 0;
    const tracked = (...args) => {
      const result = original(...args), generate = result.locations.generate.bind(result.locations);
      result.locations.generate = async (...values) => {
        window.indexGenerationCalls++; const started = performance.now();
        try { return await generate(...values); }
        finally { window.indexGenerationMillis = performance.now() - started; }
      };
      return result;
    };
    Object.assign(tracked, original); window.ePub = tracked;
  });
}

test('a forty-chapter index finishes promptly while the reader changes layout', async ({ page }) => {
  await spyGeneration(page);
  await open(page);
  await page.evaluate(() => setLayout('scrolled'));
  await ready(page);
  await expect.poll(() => page.evaluate(() => readerNavigationReady)).toBe(true);
  const measured = await page.evaluate(() => ({ elapsed: performance.now() - window.indexStarted, generation: window.indexGenerationMillis, count: book.locations.total + 1 }));
  console.log('PAGE INDEX cold', measured);
  expect(measured.elapsed).toBeLessThan(5000);
  await expect(page.frameLocator('#viewer iframe').first().locator('body')).toContainText('Chapter 1');
});

test('the saved index survives a reload without regenerating or moving the reader', async ({ page }) => {
  await open(page); await ready(page);
  const original = await page.evaluate(() => book.locations.save());
  // Reference generation uses the bundled EPUB.js parser with its original
  // pacing, independent of the optimized reader scheduling and cache.
  const reference = await page.evaluate(async () => {
    const file = await api.getBookFile(currentBookId), other = ePub();
    await other.open(await file.arrayBuffer(), 'binary'); registerEpubProtection(other);
    const start = performance.now(); await other.locations.generate(1024);
    const result = { elapsed: performance.now() - start, locations: other.locations.save() };
    other.destroy(); return result;
  });
  console.log('PAGE INDEX reference', reference.elapsed);
  expect(original).toBe(reference.locations);
  await page.evaluate(async () => { await navigateReader('next'); await showShelf(); });
  const position = await page.evaluate(() => library.find(item => item.name === 'Page Index Test Book').lastLocationCfi);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(currentUser))).toBe(true);
  await spyGeneration(page); await open(page); await ready(page);
  expect(await page.evaluate(() => window.indexGenerationCalls)).toBe(0);
  expect(await page.evaluate(() => book.locations.save())).toBe(original);
  expect(await page.evaluate(() => getSafeCfi())).toBe(position);
  console.log('PAGE INDEX reopen', await page.evaluate(() => performance.now() - window.indexStarted));
});

test('unavailable persistent storage still produces a usable page index', async ({ page }) => {
  await page.evaluate(() => Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined }));
  await open(page); await ready(page);
  await page.evaluate(() => navigateReader('next'));
  await expect(page.locator('#mobile-reader-page-count')).toHaveText(/^\d+ of \d+$/);
});

test('a corrupt saved index is regenerated without breaking reading', async ({ page }) => {
  await open(page); await ready(page);
  const original = await page.evaluate(() => book.locations.save());
  await expect.poll(() => page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('endpaper-reader-indexes', 1);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('locations', 'readonly'), read = tx.objectStore('locations').getAll();
      read.onsuccess = () => { resolve(read.result.length); db.close(); };
    };
  }))).toBeGreaterThan(0);
  await page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('endpaper-reader-indexes', 1);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('locations', 'readwrite'), store = tx.objectStore('locations'), read = store.getAll();
      read.onsuccess = () => read.result.forEach(record => store.put({ ...record, locations: 'broken JSON' }));
      tx.oncomplete = () => { db.close(); resolve(); };
    };
  }));
  await page.reload(); await spyGeneration(page); await open(page); await ready(page);
  expect(await page.evaluate(() => window.indexGenerationCalls)).toBe(1);
  expect(await page.evaluate(() => book.locations.save())).toBe(original);
});

test('another account calculates its own index instead of reading the previous account cache', async ({ page }) => {
  await open(page); await ready(page);
  const username = `index-reader-${Date.now()}`;
  await page.evaluate(async name => {
    await api.createUser({ username: name, passphrase: 'index test passphrase', is_admin: false });
    await logout();
  }, username);
  await page.locator('#username-input').fill(username);
  await page.locator('#passphrase-input').fill('index test passphrase');
  await page.locator('#login-btn').click();
  await spyGeneration(page); await open(page); await ready(page);
  expect(await page.evaluate(() => window.indexGenerationCalls)).toBe(1);
});

test('indexing cannot unload a chapter while its render hooks are pending', async ({ page }) => {
  await open(page); await ready(page);
  const output = await page.evaluate(async () => {
    const section = book.spine.get(0);
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const hold = (html, renderedSection) => { if (renderedSection === section) { started(); return pending; } };
    book.spine.hooks.serialize.register(hold);
    const render = section.render(book.load.bind(book));
    await entered;
    await book.locations.process(section);
    release();
    const result = await render;
    book.spine.hooks.serialize.deregister(hold);
    return result || '';
  });
  expect(output).toContain('Chapter 1');
  expect(output).toContain('Content-Security-Policy');
});
