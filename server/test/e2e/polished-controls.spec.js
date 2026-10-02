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
});

test('sort menu supports keyboard, selection, cancellation and outside clicks', async ({ page }) => {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const sort = page.getByRole('combobox', { name: 'Sort books', exact: true });
  await sort.focus();
  await sort.press('ArrowDown');
  await expect(sort).toHaveAttribute('aria-expanded', 'true');
  await sort.press('a');
  await sort.press('Enter');
  await expect(page.locator('#shelf-sort')).toHaveValue('author');
  await expect(sort).toContainText('Author');
  await expect(sort).toBeFocused();
  await sort.click();
  await sort.press('End');
  await sort.press('Escape');
  await expect(page.locator('#shelf-sort')).toHaveValue('author');
  await expect(sort).toHaveAttribute('aria-expanded', 'false');
  await sort.click();
  await page.locator('#desktop-heading').click();
  await expect(sort).toHaveAttribute('aria-expanded', 'false');
});

for (const [action, modal] of [['help-toggle', 'shortcuts-modal'], ['admin-toggle', 'admin-modal']]) {
  test(`Account mouse action ${action} opens its destination`, async ({ page }) => {
    await page.locator('#desktop-account-menu summary').click();
    if (action === 'help-toggle') await page.screenshot({ path: path.resolve(__dirname, '../../test-results/buttons-desktop-account.png') });
    await page.locator(`#${action}`).click();
    await expect(page.locator(`#${modal}`)).toBeVisible();
    await expect(page.locator('#desktop-account-menu')).not.toHaveAttribute('open', '');
  });
}

test('Account appearance and logout actions work with the mouse', async ({ page }) => {
  const wasDark = await page.locator('html').evaluate(element => element.classList.contains('dark-shell'));
  await page.locator('#desktop-account-menu summary').click();
  await page.locator('#shell-theme-toggle').click();
  await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark-shell'))).toBe(!wasDark);
  await page.locator('#desktop-account-menu summary').click();
  await page.locator('#logout-btn').click();
  await expect(page.locator('#login-btn')).toBeVisible();
  expect(await page.evaluate(() => ({ user: currentUser, books: library.length }))).toEqual({ user: null, books: 0 });
  expect((await page.request.get('/api/session')).status()).toBe(401);
});

test('Library tools mouse actions open collections and backup pickers', async ({ page }) => {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.locator('#library-tools-btn').press('ArrowDown');
  await page.locator('#collections-manager-btn').click();
  await expect(page.locator('#collections-modal')).toBeVisible();
  await page.getByRole('button', { name: 'Close collections', exact: true }).click();
  await page.locator('#library-tools-btn').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#library-tools-menu').getByRole('menuitem', { name: 'Import backup', exact: true }).click();
  expect((await chooser).isMultiple()).toBe(false);
  await page.locator('#library-tools-btn').click();
  const download = page.waitForEvent('download');
  await page.locator('#library-tools-menu').getByRole('menuitem', { name: 'Export backup', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
});

test('reader action menus keep pointer actions usable after keyboard opening', async ({ page }) => {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('group', { name: 'Three Chapter Test Book by Endpaper Tests', exact: true }).click();
  await page.locator('#book-details-actions .primary-action').click();
  await expect(page.frameLocator('#viewer iframe').first().locator('body')).toContainText('Chapter');
  await page.locator('#reader-more-btn').press('ArrowDown');
  await page.locator('#reader-more-menu').getByRole('button', { name: 'Audio options', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Audio options', exact: true })).toBeVisible();
  await expect(page.locator('#reader-more-menu')).toBeHidden();
  await expect(page.locator('#reader-more-btn')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#audio-options-close').click();
  await expect(page.locator('#reader-more-btn')).toBeFocused();
  for (const [label, drawer, close] of [['Search book', 'search', 'Close book search'], ['Notebook', 'bookmarks', 'Close bookmarks and highlights']]) {
    await page.locator('#reader-more-btn').press('ArrowDown');
    await page.locator('#reader-more-menu').getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator(`#${drawer}-drawer`)).toHaveClass(/open/);
    await expect(page.locator('#reader-more-menu')).toBeHidden();
    await page.getByRole('button', { name: close, exact: true }).click();
    await expect(page.locator('#reader-more-btn')).toBeFocused();
  }
  await page.locator('#reader-more-btn').press('ArrowDown');
  await page.locator('#reader-more-menu').getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.locator('#shortcuts-modal')).toBeVisible();
  await expect(page.locator('#reader-more-menu')).toBeHidden();
  await page.getByRole('button', { name: 'Close keyboard shortcuts', exact: true }).click();
  await expect(page.locator('#reader-more-btn')).toBeFocused();
  await page.setViewportSize({ width: 650, height: 852 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#mobile-reader-tools-button')).toBeVisible();
  await page.locator('#mobile-reader-tools-button').press('ArrowDown');
  await page.locator('[data-reader-tool="settings"]').click();
  await expect(page.locator('#settings-drawer')).toHaveClass(/open/);
});

test('Account keyboard activation and outside focus dismissal remain usable', async ({ page }) => {
  const summary = page.locator('#desktop-account-menu summary');
  await summary.press('ArrowDown');
  await expect(page.locator('#shell-theme-toggle')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#shortcuts-modal')).toBeVisible();
  await page.getByRole('button', { name: 'Close keyboard shortcuts', exact: true }).click();
  await expect(summary).toBeFocused();
  await summary.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(summary).toBeFocused();
  await summary.press('ArrowDown');
  await page.locator('#upload-btn').focus();
  await expect(page.locator('#desktop-account-menu')).not.toHaveAttribute('open', '');
  await summary.click();
  await page.locator('#desktop-heading').click();
  await expect(page.locator('#desktop-account-menu')).not.toHaveAttribute('open', '');
});

test('desktop More destinations, appearance and upload actions work', async ({ page }) => {
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  for (const [label, heading] of [['Offline downloads', 'Downloads'], ['Notebook', 'Notebook'], ['Reading stats', 'Reading stats'], ['Reading goals', 'Reading goals'], ['Appearance & reader defaults', 'Appearance & reader defaults']]) {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.locator('#desktop-content').getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('#desktop-heading')).toHaveText(heading);
  }
  const layout = page.locator('#desktop-content').getByRole('combobox', { name: 'Layout', exact: true });
  await layout.click();
  await page.getByRole('option', { name: 'scrolled', exact: true }).click();
  await expect.poll(() => page.evaluate(() => settings.layout)).toBe('scrolled');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  for (const [label, modal, closeLabel] of [['Help', 'shortcuts-modal', 'Close keyboard shortcuts'], ['Collections', 'collections-modal', 'Close collections'], ['People & permissions', 'admin-modal', 'Close people and permissions']]) {
    await page.locator('#desktop-content').getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator(`#${modal}`)).toBeVisible();
    await page.getByRole('button', { name: closeLabel, exact: true }).click();
  }
  const picker = page.waitForEvent('filechooser');
  await page.locator('#upload-btn').click();
  expect((await picker).isMultiple()).toBe(true);
  expect(failures).toEqual([]);
});

test('phone book action sheets and reading tools respond to taps', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const phone = await context.newPage(); const failures = [];
  phone.on('pageerror', error => failures.push(error.message));
  await phone.goto('/');
  await phone.locator('#username-input').fill('admin');
  await phone.locator('#passphrase-input').fill('correct horse battery');
  await phone.locator('#login-btn').tap();
  await phone.locator('[data-mobile-tab="library"]').tap();
  await phone.getByRole('button', { name: 'Actions for Three Chapter Test Book', exact: true }).tap();
  let sheet = phone.getByRole('dialog', { name: /^Actions for/ });
  await sheet.getByRole('button', { name: 'Book details', exact: true }).tap();
  await expect(phone.locator('#mobile-content .mobile-detail-hero h2')).toHaveText('Three Chapter Test Book');
  await phone.getByRole('button', { name: /Start reading|Continue reading|Read again/, exact: true }).tap();
  await expect(phone.frameLocator('#viewer iframe').first().locator('body')).toContainText('Chapter');
  for (const [tool, drawer, close] of [['toc', 'toc', 'Close table of contents'], ['search', 'search', 'Close book search'], ['bookmarks', 'bookmarks', 'Close bookmarks and highlights'], ['settings', 'settings', 'Close reading settings']]) {
    await phone.locator('#mobile-reader-tools-button').tap();
    if (tool === 'settings') await phone.screenshot({ path: path.resolve(__dirname, '../../test-results/buttons-phone-reader-tools.png') });
    await phone.locator(`[data-reader-tool="${tool}"]`).tap();
    await expect(phone.locator(`#${drawer}-drawer`)).toHaveClass(/open/);
    await phone.getByRole('button', { name: close, exact: true }).tap();
  }
  await phone.locator('#mobile-reader-tools-button').tap();
  await phone.locator('[data-reader-tool="audio"]').tap();
  await expect(phone.locator('#audio-options')).toBeVisible();
  await phone.locator('#audio-options-close').tap();
  await phone.locator('#mobile-reader-back').tap();
  await phone.locator('[data-mobile-tab="library"]').tap();
  await phone.getByRole('button', { name: 'Actions for Three Chapter Test Book', exact: true }).tap();
  sheet = phone.getByRole('dialog', { name: /^Actions for/ });
  await sheet.getByRole('button', { name: 'Edit details', exact: true }).tap();
  await expect(phone.getByRole('dialog', { name: 'Edit book details', exact: true })).toBeVisible();
  await phone.getByRole('button', { name: 'Cancel', exact: true }).tap();
  expect(failures).toEqual([]);
  await context.close();
});

test('menus follow dynamic options and programmatic values, and fit the viewport', async ({ page }) => {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.evaluate(() => {
    const select = document.getElementById('shelf-filter');
    const group = document.createElement('optgroup'); group.label = 'Collections';
    group.append(new Option('Weekend reading', 'weekend'), new Option('Unavailable', 'disabled'));
    group.lastChild.disabled = true; select.append(group); select.value = 'weekend';
  });
  const filter = page.getByRole('combobox', { name: 'Filter books', exact: true });
  await expect(filter).toContainText('Weekend reading');
  await filter.click();
  await expect(page.getByRole('option', { name: 'Weekend reading' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('option', { name: 'Unavailable' })).toHaveAttribute('aria-disabled', 'true');
  const box = await page.getByRole('listbox', { name: 'Filter books' }).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(8); expect(box.x + box.width).toBeLessThanOrEqual(1432);
  expect(box.y).toBeGreaterThanOrEqual(8); expect(box.y + box.height).toBeLessThanOrEqual(892);
  await page.evaluate(() => document.getElementById('shelf-filter').disabled = true);
  await expect(filter).toBeDisabled();
  await expect(filter).toHaveAttribute('aria-expanded', 'false');
});

test('mobile and desktop share shell colors, and the touch sheet uses the same menu', async ({ page }) => {
  await page.evaluate(() => { document.documentElement.classList.remove('dark-shell'); syncReaderPalette(); });
  const palette = () => page.evaluate(() => Object.fromEntries(['--paper', '--paper-card', '--ink', '--gold', '--line'].map(name => [name, getComputedStyle(document.body).getPropertyValue(name).trim()])));
  const light = await palette();
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', light['--paper']);
  await page.setViewportSize({ width: 393, height: 852 });
  expect(await palette()).toEqual(light);
  await page.locator('[data-mobile-tab="library"]').click();
  await page.getByRole('button', { name: 'Sort & filter', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Library options' });
  await sheet.getByRole('combobox', { name: 'Sort books', exact: true }).click();
  await page.getByRole('option', { name: 'Author', exact: true }).click();
  await expect(page.locator('#shelf-sort')).toHaveValue('author');
  await expect(sheet.getByRole('combobox', { name: 'Sort books', exact: true })).toContainText('Author');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.evaluate(() => { document.documentElement.classList.add('dark-shell'); syncReaderPalette(); });
  const dark = await palette();
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', dark['--paper']);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await palette()).toEqual(dark);
});

test('reduced motion removes menu movement and library tools support Escape', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const sort = page.getByRole('combobox', { name: 'Sort books', exact: true });
  await sort.click();
  expect(await page.getByRole('listbox', { name: 'Sort books' }).evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await sort.press('Escape');
  await page.locator('#library-tools-btn').press('ArrowDown');
  await expect(page.locator('#library-tools-menu')).toBeVisible();
  await expect(page.locator('#library-tools-menu button').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#library-tools-menu')).toBeHidden();
  await expect(page.locator('#library-tools-btn')).toBeFocused();
});

test('audio dropdowns work inside the modal and retain the reading theme', async ({ page }) => {
  await page.evaluate(async () => {
    await openBook(library.find(book => book.name === 'Three Chapter Test Book').id);
  });
  await expect(page.frameLocator('#viewer iframe').first().locator('body')).toContainText('Chapter');
  const pageColor = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--reader-page-bg'));
  await page.evaluate(() => openAudioOptions());
  const sleep = page.getByRole('combobox', { name: 'Sleep timer', exact: true });
  await sleep.click();
  await page.getByRole('option', { name: '10 minutes', exact: true }).click();
  await expect(page.locator('#tts-sleep')).toHaveValue('10');
  await expect(sleep).toBeFocused();
  await page.evaluate(() => {
    const voices = document.getElementById('tts-voice-select');
    voices.replaceChildren(new Option('Test voice', 'test-voice'));
    voices.value = 'test-voice';
  });
  const voice = page.getByRole('combobox', { name: 'Voice', exact: true });
  await expect(voice).toContainText('Test voice');
  await voice.click();
  await expect(page.getByRole('option', { name: 'Test voice', exact: true })).toBeVisible();
  await voice.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Audio options', exact: true })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--reader-page-bg'))).toBe(pageColor);
  await page.getByRole('dialog', { name: 'Audio options', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
});

test('phone taps select values and a long popup scrolls without closing', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const phone = await context.newPage();
  await phone.goto('/');
  await phone.locator('#username-input').fill('admin');
  await phone.locator('#passphrase-input').fill('correct horse battery');
  await phone.locator('#login-btn').tap();
  await phone.locator('[data-mobile-tab="library"]').tap();
  await phone.getByRole('button', { name: 'Sort & filter', exact: true }).tap();
  const sheet = phone.getByRole('dialog', { name: 'Library options' });
  const sort = sheet.getByRole('combobox', { name: 'Sort books', exact: true });
  await sort.tap();
  await phone.getByRole('option', { name: 'Author', exact: true }).tap();
  await expect(phone.locator('#shelf-sort')).toHaveValue('author');
  await phone.evaluate(() => {
    const source = document.querySelector('#mobile-actions-sheet select[aria-label="Sort books"]');
    for (let index = 0; index < 25; index++) source.add(new Option(`Extra option ${index}`, `extra-${index}`));
  });
  await sort.tap();
  const list = phone.getByRole('listbox', { name: 'Sort books', exact: true });
  await list.evaluate(element => element.scrollTop = element.scrollHeight);
  await expect(list).toBeVisible();
  await phone.getByRole('option', { name: 'Extra option 24', exact: true }).tap();
  await expect(sort).toContainText('Extra option 24');
  await expect(sort).toHaveAttribute('aria-expanded', 'false');
  await context.close();
});

test('desktop hover raises the cover frame and rapid navigation settles its highlight', async ({ page }) => {
  const book = page.locator('.smart-book').first();
  const cover = book.locator('.smart-cover');
  await book.hover();
  await expect(cover).not.toHaveCSS('transform', 'none');
  await page.locator('#desktop-heading').hover();
  await expect(cover).toHaveCSS('transform', 'none');
  await page.evaluate(() => { navigateDesktop('library'); navigateDesktop('more'); navigateDesktop('home'); });
  const marker = page.locator('#desktop-nav .navigation-highlight');
  await expect(marker).toBeVisible();
  await expect.poll(async () => {
    const active = await page.locator('#desktop-nav button[aria-current="page"]').boundingBox();
    const highlight = await marker.boundingBox();
    return Math.abs(active.y - highlight.y) < 1 && Math.abs(active.x - highlight.x) < 1;
  }).toBe(true);
  await expect(page.locator('#desktop-heading')).toHaveText('Your reading');
});

test('reduced motion cancels a running navigation animation and disables hover movement', async ({ page }) => {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.locator('.smart-book').first().hover();
  await expect(page.locator('.smart-cover').first()).toHaveCSS('transform', 'none');
  expect(await page.locator('#desktop-nav .navigation-highlight').evaluate(element => element.getAnimations().length)).toBe(0);
  expect(await page.locator('#desktop-page-header').evaluate(element => element.getAnimations().length)).toBe(0);
});

test('phone navigation highlight follows tabs without obstructing touch controls', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const phone = await context.newPage();
  await phone.goto('/');
  await phone.locator('#username-input').fill('admin');
  await phone.locator('#passphrase-input').fill('correct horse battery');
  await phone.locator('#login-btn').tap();
  for (const tab of ['library', 'search', 'more', 'home']) {
    await phone.locator(`[data-mobile-tab="${tab}"]`).tap();
    const marker = phone.locator('#mobile-tabbar .navigation-highlight');
    await expect(marker).toBeVisible();
    await expect.poll(async () => {
      const active = await phone.locator(`[data-mobile-tab="${tab}"]`).boundingBox();
      const highlight = await marker.boundingBox();
      return Math.abs(active.x - highlight.x) < 1 && Math.abs(active.width - highlight.width) < 1;
    }).toBe(true);
  }
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
  await context.close();
});
