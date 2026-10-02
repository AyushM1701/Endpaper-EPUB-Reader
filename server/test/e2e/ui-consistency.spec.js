const { test, expect } = require('@playwright/test');
const path = require('node:path');

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.locator('#username-input').fill('admin');
  await page.locator('#passphrase-input').fill('correct horse battery');
  await page.locator('#login-btn').click();
  await expect(page.locator('#dropzone')).toHaveJSProperty('hidden', false);
  if (!(await page.getByRole('group', { name: 'Three Chapter Test Book by Endpaper Tests', exact: true, includeHidden: true }).count())) {
    await page.locator('#file-input').setInputFiles(path.join(__dirname, '../fixtures/three-chapters.epub'));
    await expect(page.locator('#reader-view')).toHaveClass(/active/);
    await page.evaluate(() => showShelf());
  }
  await page.evaluate(() => { library.find(book => book.name === 'Three Chapter Test Book').lastLocationCfi = null; settings.layout = 'paginated'; });
});

test('desktop separates discovery from the searchable library and opens book details', async ({ page }) => {
  await expect(page.locator('#mobile-shell')).toBeHidden();
  await expect(page.locator('#desktop-heading')).toHaveText('Your reading');
  await expect(page.locator('#shelf-header')).toBeHidden();
  await expect(page.locator('.smart-book .smart-cover').first()).toBeVisible();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.locator('#shelf-header')).toBeVisible();
  await expect(page.locator('#smart-sections')).toBeHidden();
  await page.getByRole('searchbox', { name: 'Search library' }).fill('Three Chapter');
  await expect(page.locator('#shelf .book-card:visible')).toHaveCount(1);
  await page.locator('#shelf .book-card').press('Enter');
  await expect(page.locator('#book-details-modal')).toHaveClass(/show/);
  await page.locator('#book-details-actions').getByRole('button', { name: /Read|Continue reading/ }).first().click();
  await expect(page.frameLocator('#viewer iframe').locator('body').first()).toContainText('Chapter One');
  await expect(page.getByRole('region', { name: 'Read Aloud controls' })).toHaveCount(0);
  await page.evaluate(() => { ttsQueue = [{ text: 'Test speech controls' }]; ttsIndex = 0; updateTtsPlayerUI(); });
  await page.getByRole('button', { name: 'Stop reading aloud', exact: true }).press('Space');
  await expect(page.locator('#tts-player-bar')).toBeHidden();
  await expect(page.locator('#reader-more-btn')).toBeFocused();
});

test('desktop series opens its collection and metadata uses an in-app editor', async ({ page }) => {
  await page.evaluate(async () => {
    const entry = library.find(book => book.name === 'Three Chapter Test Book');
    await api.updateBook(entry.id, { series: 'Test Saga', series_index: 1 });
    entry.series = 'Test Saga'; entry.seriesIndex = 1; renderShelf();
  });
  await page.locator('.smart-section').filter({ hasText: 'Your series' }).getByRole('button', { name: /Test Saga/ }).click();
  await expect(page.locator('#desktop-heading')).toHaveText('Test Saga');
  await expect(page.locator('#shelf .book-card:visible')).toHaveCount(1);
  await page.getByRole('group', { name: 'Three Chapter Test Book by Endpaper Tests', exact: true }).click();
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit book details', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Three Chapter Test Book');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#book-details-modal')).toHaveClass(/show/);
});

test('narrow fine-pointer panels have keyboard results and visible audio options', async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 850 });
  await page.locator('[data-mobile-tab="library"]').click();
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.getByRole('button', { name: /Start reading|Continue reading|Read again/ }).click();
  await expect(page.frameLocator('#viewer iframe').locator('body').first()).toContainText('Chapter One');
  await page.locator('#mobile-reader-tools-button').click();
  await page.locator('[data-reader-tool="search"]').click();
  await page.getByRole('textbox', { name: 'Search this book', exact: true }).fill('chapter');
  await expect(page.locator('button.search-result').first()).toBeVisible();
  const close = await page.getByRole('button', { name: 'Close book search' }).boundingBox();
  expect(close.y).toBeGreaterThanOrEqual(0);
  expect(close.y + close.height).toBeLessThan(850);
  await page.locator('button.search-result').first().press('Space');
  await expect(page.locator('#search-drawer')).not.toHaveClass(/open/);
  await page.locator('#mobile-reader-tools-button').click();
  await page.getByRole('button', { name: 'Audio options', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Audio options', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Voice', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Sleep timer', exact: true })).toBeVisible();
});

test('notebook edits persist and opening a saved passage jumps to its chapter', async ({ page }) => {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('group', { name: 'Three Chapter Test Book by Endpaper Tests', exact: true }).click();
  await page.locator('#book-details-actions .primary-action').click();
  await expect(page.frameLocator('#viewer iframe').locator('body').first()).toContainText('Chapter One');
  await page.evaluate(async () => {
    await navigateReader('chapter2.xhtml');
    const contents = rendition.getContents()[0];
    const range = contents.document.createRange();
    range.selectNodeContents(contents.document.querySelector('p'));
    const cfi = contents.cfiFromRange(range);
    await api.addHighlight(currentBookId, { cfi_range: cfi, excerpt: 'This is chapter Two', chapter: 'Chapter Two', color: '#8FC1E3', note: 'Original note', tags: ['test'] });
    showShelf();
  });
  await page.getByRole('button', { name: 'Notebook', exact: true }).first().click();
  await expect(page.locator('#desktop-content .annotation-note')).toHaveText('Original note');
  await page.getByRole('button', { name: 'Edit note & tags', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Saved note');
  await page.getByRole('textbox', { name: 'Tags (comma-separated)', exact: true }).fill('test, important');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#desktop-content .annotation-note')).toHaveText('Saved note');
  await page.getByRole('button', { name: /Open highlight in Three Chapter/ }).press('Enter');
  await expect(page.frameLocator('#viewer iframe').locator('body').first()).toContainText('Chapter Two');
  await page.locator('#bookmarks-toggle').click();
  await page.getByRole('tab', { name: 'Highlights', exact: true }).click();
  await expect(page.locator('#highlights-list .annotation-note')).toHaveText('Saved note');
});

test('metadata editor keeps unsaved values visible after a save failure', async ({ page }) => {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('group', { name: 'Three Chapter Test Book by Endpaper Tests', exact: true }).click();
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Draft title');
  await page.route('**/api/books/*', route => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test save unavailable' }) }) : route.continue());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.form-editor .editor-error')).not.toBeEmpty();
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Draft title');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
});
