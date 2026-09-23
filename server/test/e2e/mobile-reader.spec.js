const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const fixture = path.join(__dirname, '../fixtures/three-chapters.epub');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.locator('#username-input').fill('admin');
  await page.locator('#passphrase-input').fill('correct horse battery');
  await page.locator('#login-btn').click();
  await expect(page.locator('#mobile-tabbar')).toBeVisible();
  await page.locator('[data-mobile-tab="library"]').click();
  if (!(await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).count())) {
    await page.locator('#file-input').setInputFiles(fixture);
    await expect(page.locator('#mobile-content h1')).toHaveText('Book details');
    await page.locator('[data-mobile-tab="library"]').click();
  }
  await expect(page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).first()).toBeVisible();
});

test('mobile routes fit iPhone width and open a rendered EPUB', async ({ page }) => {
  await page.locator('[data-mobile-tab="home"]').click();
  await page.screenshot({ path: 'test-results/mobile-home.png' });
  for (const tab of ['library', 'search', 'more', 'home']) {
    await page.locator(`[data-mobile-tab="${tab}"]`).click();
    await expect(page.locator('#mobile-content h1')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(394);
  }
  await page.locator('[data-mobile-tab="search"]').click();
  await page.locator('.mobile-search-input').fill('Three Chapter');
  await expect(page.locator('.mobile-search-results').getByRole('button', { name: 'Details for Three Chapter Test Book' })).toBeVisible();
  await page.evaluate(async () => {
    const entry = library.find(book => book.name === 'Three Chapter Test Book');
    await api.updateBook(entry.id, { series: 'Test Saga', series_index: 1 });
    entry.series = 'Test Saga'; entry.seriesIndex = 1; renderShelf();
  });
  await page.locator('[data-mobile-tab="home"]').click();
  await page.locator('.mobile-section').filter({ hasText: 'Your series' }).getByRole('button').click();
  await expect(page.locator('#mobile-content h1')).toHaveText('Test Saga');
  await page.locator('.mobile-back').click();
  await page.locator('[data-mobile-tab="library"]').click();
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await expect(page.locator('#mobile-content h2')).toHaveText('Three Chapter Test Book');
  await page.locator('.mobile-status-label select').selectOption('reading');
  await expect(page.locator('.mobile-status-label select')).toHaveValue('reading');
  await page.getByRole('button', { name: /Highlights & notes/ }).click();
  await expect(page.locator('#mobile-content h1')).toHaveText('Highlights & notes');
  await page.locator('.mobile-back').click();
  await page.getByRole('button', { name: /Start reading|Continue reading|Read again/ }).click();
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter One');
  await expect(page.locator('#loading-overlay')).not.toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-reader.png' });
  await page.locator('#mobile-reader-tools-button').click();
  await page.locator('[data-reader-tool="settings"]').click();
  await expect(page.locator('#settings-drawer')).toHaveClass(/open/);
  const sheet = await page.locator('#settings-drawer').boundingBox();
  expect(sheet.y + sheet.height).toBeGreaterThan(820);
  await page.goBack();
  await expect(page.locator('#reader-view')).not.toHaveClass(/active/);
  await expect(page.locator('#mobile-content h1')).toHaveText('Library');
});

test('rapid synthetic touch swipes cross only one chapter', async ({ page }) => {
  await page.locator('[data-mobile-tab="library"]').click();
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.getByRole('button', { name: /Start reading|Continue reading|Read again/ }).click();
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter One');
  await page.locator('#viewer-wrap').evaluate(body => {
    const swipe = identifier => {
      const start = { identifier, clientX: 310, clientY: 200 };
      const end = { identifier, clientX: 70, clientY: 205 };
      for (const [type, touches, changedTouches] of [['touchstart', [start], [start]], ['touchmove', [end], [end]], ['touchend', [], [end]]]) {
        const event = new Event(type, { bubbles: true });
        Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changedTouches } });
        body.dispatchEvent(event);
      }
    };
    swipe(1); swipe(2);
  });
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter Two');
  await expect(page.frameLocator('#viewer iframe').locator('body')).not.toContainText('Chapter Three');
});

test('bookmark-style jumps wait for a pending page turn', async ({ page }) => {
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.getByRole('button', { name: /Start reading|Continue reading|Read again/ }).click();
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter One');
  const overlapped = await page.evaluate(async () => {
    const current = rendition;
    const originalNext = current.next.bind(current);
    const originalDisplay = current.display.bind(current);
    const cfi = (await getCurrentLocationSafe(current)).start.cfi;
    let turning = false;
    let overlap = false;
    current.next = async () => { turning = true; await new Promise(resolve => setTimeout(resolve, 80)); turning = false; };
    current.display = async target => { if (turning) overlap = true; return originalDisplay(target); };
    try { await Promise.all([turnPage('next'), navigateReader(cfi)]); }
    finally { current.next = originalNext; current.display = originalDisplay; }
    return overlap;
  });
  expect(overlapped).toBe(false);
});

test('shelf metadata is safe in quoted attributes and phone landscape keeps mobile navigation', async ({ page }) => {
  const attack = 'Bad " autofocus onfocus="window.__injected=1 <img src=x onerror="window.__injected=1">';
  await page.evaluate(title => {
    const entry = library.find(book => book.name === 'Three Chapter Test Book');
    entry.name = title;
    renderShelf();
  }, attack);
  const card = page.locator('.book-card').filter({ hasText: 'Bad' });
  await expect(card).toHaveAttribute('aria-label', new RegExp('Bad'));
  await expect(card.locator('.title')).toHaveAttribute('title', attack);
  expect(await page.evaluate(() => window.__injected || 0)).toBe(0);
  expect(await page.locator('.book-card [autofocus]').count()).toBe(0);
  await page.setViewportSize({ width: 852, height: 393 });
  await expect(page.locator('#mobile-tabbar')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(853);
});

test('a failed progress seek restores the saved position', async ({ page }) => {
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.getByRole('button', { name: /Start reading|Continue reading|Read again/ }).click();
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter One');
  const before = await page.evaluate(() => getCurrentEntry().progress);
  await page.evaluate(() => {
    rendition.display = async () => { throw new Error('seek failure'); };
    const slider = document.getElementById('progress-slider');
    slider.value = '75';
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#progress-slider')).toHaveValue(String(Math.round(before)));
  expect(await page.evaluate(() => getCurrentEntry().progress)).toBe(before);
});

test('dragging the mobile progress slider previews and seeks', async ({ page }) => {
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.getByRole('button', { name: /Start reading|Continue reading|Read again/ }).click();
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter One');
  const slider = page.locator('#progress-slider');
  const bounds = await slider.boundingBox();
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + bounds.width * 0.1, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.8, y, { steps: 8 });
  expect(Number(await slider.inputValue())).toBeGreaterThanOrEqual(65);
  await page.mouse.up();
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter Three');
  await page.touchscreen.tap(bounds.x + bounds.width * 0.15, y);
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter One');
});

test('library sheet traps focus and supports reading and downloaded filters', async ({ page }) => {
  await page.getByRole('button', { name: 'Sort & filter' }).click();
  const dialog = page.getByRole('dialog', { name: 'Library options' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('select').first()).toBeFocused();
  await expect(dialog.locator('select').first()).toContainText('Reading');
  await expect(dialog.locator('select').first()).toContainText('Downloaded');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Sort & filter' })).toBeFocused();
});

test('mobile status reflects server normalization', async ({ page }) => {
  await page.evaluate(async () => {
    const entry = library.find(book => book.name === 'Three Chapter Test Book');
    const updated = await api.updateBook(entry.id, { progress_percent: 99 });
    entry.progress = updated.progress_percent; entry.status = updated.status;
    renderShelf();
  });
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.locator('.mobile-status-label select').selectOption('unread');
  await expect(page.locator('.mobile-status-label select')).toHaveValue('finished');
});

test('offline pinning waits for worker acknowledgement and stores the EPUB', async ({ page }) => {
  await page.locator('[data-mobile-tab="library"]').click();
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.getByRole('button', { name: 'Download for offline' }).click();
  await expect(page.getByRole('button', { name: 'Remove download' })).toBeVisible();
  await page.locator('[data-mobile-tab="more"]').click();
  await page.getByRole('button', { name: /Offline downloads/ }).click();
  await expect(page.getByRole('button', { name: 'Details for Three Chapter Test Book' })).toBeVisible();
  const storedBytes = await page.evaluate(async () => {
    const entry = library.find(book => book.name === 'Three Chapter Test Book');
    const cache = await caches.open('endpaper-pinned-books');
    const response = await cache.match(`/api/books/${entry.id}/file`);
    return response ? (await response.blob()).size : 0;
  });
  expect(storedBytes).toBeGreaterThan(0);
  await expect(page.locator('.mobile-detail-meta')).toContainText('1 downloaded');
  await page.locator('.mobile-offline-remove').click();
  await expect(page.locator('.mobile-empty')).toContainText('No books downloaded');
});

test('a pinned book opens after a cold offline restart', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright WebKit fails the offline reload internally on Windows; run this case in Chromium.');
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.getByRole('button', { name: 'Download for offline' }).click();
  await expect(page.getByRole('button', { name: 'Remove download' })).toBeVisible();
  expect(await page.evaluate(() => Boolean(localStorage.getItem('endpaper-offline-snapshot:admin')))).toBe(true);
  await page.context().setOffline(true);
  try {
    await page.reload();
    await expect(page.locator('#login-btn')).toBeVisible();
    await expect(page.locator('#login-offline-hint')).toBeVisible();
    await page.locator('#username-input').fill('admin');
    await page.locator('#passphrase-input').fill('incorrect offline passphrase');
    await page.locator('#login-btn').click();
    await expect(page.locator('#login-gate')).toBeVisible();
    await expect(page.locator('#mobile-content')).toBeEmpty();
    await page.locator('#passphrase-input').fill('correct horse battery');
    await page.locator('#login-btn').click();
    await expect(page.locator('#mobile-content h1')).toHaveText('Offline downloads');
    await page.locator('[data-mobile-tab="home"]').click();
    await expect(page.locator('.mobile-offline-home')).toContainText('Reading offline');
    await page.getByRole('button', { name: 'Open downloaded books' }).click();
    await expect(page.locator('#mobile-content h1')).toHaveText('Offline downloads');
    await page.locator('[data-mobile-tab="library"]').click();
    await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
    await page.getByRole('button', { name: /Start reading|Continue reading|Read again/ }).click();
    await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter One');
  } finally { await page.context().setOffline(false); }
});

test('offline download requires a local unlock for a restored session', async ({ page }) => {
  await page.evaluate(() => {
    offlineSnapshotKey = null;
    offlineSnapshotSalt = null;
    localStorage.removeItem(offlineSnapshotStorageKey(currentUser.username));
  });
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.getByRole('button', { name: 'Download for offline' }).click();
  await expect(page.locator('#mobile-content h1')).toHaveText('Offline downloads');
  await page.getByRole('textbox', { name: 'Passphrase for offline access' }).fill('wrong passphrase');
  await page.getByRole('button', { name: 'Enable offline access' }).click();
  await expect(page.locator('.mobile-offline-error')).toContainText('Incorrect passphrase');
  await page.getByRole('textbox', { name: 'Passphrase for offline access' }).fill('correct horse battery');
  await page.getByRole('button', { name: 'Enable offline access' }).click();
  await expect(page.locator('.mobile-offline-access')).toContainText('Ready to go offline');
  await page.locator('[data-mobile-tab="library"]').click();
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.getByRole('button', { name: 'Download for offline' }).click();
  await expect(page.getByRole('button', { name: 'Remove download' })).toBeVisible();
});

test('scrolling hides reader controls and a tap fades them back in', async ({ page }) => {
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.getByRole('button', { name: /Start reading|Continue reading|Read again/ }).click();
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter One');
  await page.evaluate(() => setLayout('scrolled'));
  await expect(page.locator('#reader-view')).toHaveClass(/scrolled/);
  await expect(page.locator('#epub-scroll-container')).toBeVisible();
  await page.evaluate(() => {
    const scroller = document.getElementById('epub-scroll-container');
    const spacer = document.createElement('div');
    spacer.style.height = '1600px';
    scroller.appendChild(spacer);
    scroller.scrollTop = 120;
  });
  await expect(page.locator('#app')).toHaveClass(/chrome-hidden/);
  await expect(page.locator('#reader-reveal-controls')).toHaveCSS('opacity', '0');
  await expect(page.locator('#mobile-reader-controls')).toHaveCSS('opacity', '0');
  await page.screenshot({ path: 'test-results/mobile-scrolled-immersive.png' });
  await page.locator('#viewer-wrap').evaluate(target => {
    const touch = { identifier: 1, clientX: 190, clientY: 350 };
    for (const [type, touches] of [['touchstart', [touch]], ['touchend', []]]) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: [touch] } });
      target.dispatchEvent(event);
    }
  });
  await expect(page.locator('#app')).not.toHaveClass(/chrome-hidden/);
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await expect(page.locator('#mobile-reader-controls')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'test-results/mobile-scrolled-controls.png' });
  await page.evaluate(() => { document.getElementById('epub-scroll-container').scrollTop += 120; });
  await expect(page.locator('#app')).toHaveClass(/chrome-hidden/);
});

test('immersive reading always exposes a route back to settings', async ({ page }) => {
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'black');
  const tabbar = page.locator('#mobile-tabbar');
  const bottomGap = await tabbar.evaluate(element => window.innerHeight - element.getBoundingClientRect().bottom);
  expect(bottomGap).toBeLessThanOrEqual(50);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(23, 23, 20)');

  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.getByRole('button', { name: /Start reading|Continue reading|Read again/ }).click();
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter One');
  await page.evaluate(() => setLayout('paginated'));
  await expect(page.locator('#reader-view')).not.toHaveClass(/scrolled/);
  const readerLayout = await page.evaluate(() => ({
    headerBottom: document.getElementById('mobile-reader-back').getBoundingClientRect().bottom,
    viewerTop: document.getElementById('viewer-wrap').getBoundingClientRect().top,
    viewerBottom: document.getElementById('viewer-wrap').getBoundingClientRect().bottom,
    progressTop: document.getElementById('progress-bar').getBoundingClientRect().top,
    sliderHeight: document.getElementById('progress-slider').getBoundingClientRect().height,
  }));
  expect(readerLayout.viewerTop).toBeGreaterThan(readerLayout.headerBottom);
  expect(readerLayout.viewerBottom).toBeLessThanOrEqual(readerLayout.progressTop);
  expect(readerLayout.sliderHeight).toBeLessThanOrEqual(44);
  await page.evaluate(() => setReadingTheme('dark'));
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter One');
  await page.screenshot({ path: 'test-results/mobile-reader-dark.png' });
  await page.evaluate(() => enterImmersiveReading());
  await expect(page.locator('#mobile-reader-controls')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('button', { name: 'Reading menu' })).toBeVisible();
  await expect(page.locator('#reader-immersive-progress')).toContainText('% read');
  await expect(page.locator('#mobile-reader-controls')).toHaveCSS('opacity', '0');
  await page.screenshot({ path: 'test-results/mobile-reader-immersive.png' });
  await page.getByRole('button', { name: 'Reading menu' }).click();
  await expect(page.locator('#mobile-reader-controls')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#mobile-reader-tools-menu')).toBeVisible();
  await page.getByRole('button', { name: 'Appearance' }).click();
  await expect(page.locator('#settings-drawer')).toHaveClass(/open/);
  await page.evaluate(() => {
    closeDrawers();
    const app = document.getElementById('app');
    app.requestFullscreen = undefined;
    app.webkitRequestFullscreen = undefined;
    toggleFullscreen();
  });
  await expect(page.getByRole('button', { name: 'Reading menu' })).toBeVisible();
  await page.getByRole('button', { name: 'Reading menu' }).click();
  await expect(page.locator('#mobile-reader-controls')).toHaveAttribute('aria-hidden', 'false');
});

test('long list titles and management screens fit the phone viewport', async ({ page }) => {
  await page.evaluate(() => {
    library.find(book => book.name === 'Three Chapter Test Book').name = 'He Who Fights with Monsters: A Very Long LitRPG Adventure Title';
    renderMobileShell();
  });
  const title = page.locator('.mobile-library-row .mobile-book-info strong').first();
  await expect(title).toContainText('He Who Fights with Monsters');
  const titleBounds = await title.boundingBox();
  expect(titleBounds.x + titleBounds.width).toBeLessThanOrEqual(393);
  expect(await title.evaluate(element => getComputedStyle(element).webkitLineClamp)).toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
  const toolbarButtons = page.locator('.mobile-library-tools button');
  expect(await toolbarButtons.count()).toBe(4);
  for (const button of await toolbarButtons.all()) {
    const bounds = await button.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(393);
  }
  await page.screenshot({ path: 'test-results/mobile-library-list.png' });

  await page.locator('[data-mobile-tab="more"]').click();
  await page.getByRole('button', { name: /^Collections/ }).click();
  await expect(page.locator('#collections-card')).toBeVisible();
  const collectionsLayout = await page.locator('#collections-card').evaluate(element => ({
    x: element.getBoundingClientRect().x,
    width: element.getBoundingClientRect().width,
    background: getComputedStyle(element).backgroundColor,
  }));
  expect(collectionsLayout).toEqual({ x: 0, width: 393, background: 'rgb(23, 23, 20)' });
  await expect(page.locator('#new-collection-input')).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-collections.png' });
  await page.getByRole('button', { name: 'Close collections' }).click();

  await page.getByRole('button', { name: /^People & permissions/ }).click();
  await expect(page.locator('#admin-card')).toBeVisible();
  expect(await page.locator('#admin-card').evaluate(element => element.getBoundingClientRect().width)).toBe(393);
  await expect(page.locator('#new-user-username')).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-people.png' });
});

test('invalid saved position recovers and layout switching keeps text visible', async ({ page }) => {
  await page.evaluate(() => {
    const entry = library.find(book => book.name === 'Three Chapter Test Book');
    entry.lastLocationCfi = 'epubcfi(/999/999)';
  });
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.getByRole('button', { name: /Start reading|Continue reading|Read again/ }).click();
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter One');
  await page.evaluate(() => setLayout('scrolled'));
  await expect(page.locator('#reader-view')).toHaveClass(/scrolled/);
  await expect(page.frameLocator('#viewer iframe').first().locator('body')).toContainText('Chapter One');
  await expect(page.locator('#reader-error-state')).toBeHidden();
});

test('an illustration-only EPUB is accepted as rendered content', async ({ page }) => {
  await page.locator('#file-input').setInputFiles(path.join(__dirname, '../fixtures/image-only.epub'));
  await expect(page.locator('#mobile-content h1')).toHaveText('Book details');
  await page.getByRole('button', { name: /Start reading|Continue reading|Read again/ }).click();
  await expect(page.locator('#reader-view')).toHaveClass(/active/);
  await expect(page.frameLocator('#viewer iframe').locator('svg')).toBeVisible();
  await expect(page.locator('#loading-overlay')).not.toBeVisible();
  await expect(page.locator('#reader-error-state')).toBeHidden();
});

test('an available update stays out of the reader and shell assets share a version', async ({ page }) => {
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).click();
  await page.getByRole('button', { name: /Start reading|Continue reading|Read again/ }).click();
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter One');
  await page.evaluate(() => { window.__pendingServiceWorker = {}; document.getElementById('update-banner').hidden = true; });
  await expect(page.locator('#update-banner')).toBeHidden();
  await page.evaluate(() => showShelf());
  await expect(page.locator('#update-banner')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  const shellAssets = await page.evaluate(async () => {
    const names = await caches.keys();
    const shell = await caches.open(names.find(name => name.startsWith('endpaper-shell-')));
    return (await shell.keys()).map(request => new URL(request.url).pathname + new URL(request.url).search);
  });
  expect(shellAssets.some(path => path.startsWith('/app.js?v=v15.0.5-20260923'))).toBe(true);
  expect(shellAssets.some(path => path.startsWith('/mobile.js?v=v15.0.5-20260923'))).toBe(true);
  expect(shellAssets).toContain('/fonts/AtkinsonHyperlegible-Regular.woff2');
  expect(shellAssets).toContain('/fonts/WorkSans-Regular.woff2');
  expect(await page.evaluate(async () => (await document.fonts.load('16px "Atkinson Hyperlegible"')).length)).toBeGreaterThan(0);
});

test('Reader role can add books from mobile More', async ({ page }) => {
  const username = `mobile-reader-${Date.now()}`;
  await page.evaluate(async name => { await api.createUser({ username: name, passphrase: 'reader test passphrase', is_admin: false }); }, username);
  await page.locator('[data-mobile-tab="more"]').click();
  await page.getByRole('button', { name: /Log out/ }).click();
  await expect(page.locator('#login-btn')).toBeVisible();
  await page.locator('#username-input').fill(username);
  await page.locator('#passphrase-input').fill('reader test passphrase');
  await page.locator('#login-btn').click();
  await page.locator('[data-mobile-tab="more"]').click();
  await expect(page.locator('#mobile-content')).toContainText('Role: Reader');
  await expect(page.getByRole('button', { name: /Add books/ })).toBeVisible();
  const readerCopy = Buffer.from(fs.readFileSync(fixture));
  readerCopy[10] ^= 1; // Change ZIP metadata, preserving the EPUB content.
  await page.locator('#file-input').setInputFiles({ name: 'reader-copy.epub', mimeType: 'application/epub+zip', buffer: readerCopy });
  await expect(page.locator('#mobile-content h1')).toHaveText('Book details');
});

test('removing a book clears its pinned offline bytes', async ({ page }) => {
  await page.getByRole('button', { name: 'Details for Three Chapter Test Book' }).first().click();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.getByRole('button', { name: 'Download for offline' }).click();
  await expect(page.getByRole('button', { name: 'Remove download' })).toBeVisible();
  const id = await page.evaluate(() => mobileRoute.value);
  await page.getByRole('button', { name: 'Remove book' }).click();
  await page.locator('#confirm-ok-btn').click();
  await expect.poll(async () => page.evaluate(async bookId => {
    const cache = await caches.open('endpaper-pinned-books');
    return Boolean(await cache.match(`/api/books/${bookId}/file`));
  }, id)).toBe(false);
});
