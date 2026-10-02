const { test, expect } = require('@playwright/test');
const path = require('node:path');

test.use({ viewport: { width:1440, height:900 }, isMobile:false, hasTouch:false, serviceWorkers:'block' });
async function login(page) {
  await page.goto('/');
  await page.locator('#username-input').fill('admin');
  await page.locator('#passphrase-input').fill('correct horse battery');
  await page.locator('#login-btn').click();
  await expect(page.locator('#dropzone')).toHaveJSProperty('hidden', false);
}
test.beforeEach(async ({ page }) => {
  await login(page);
  if (!(await page.evaluate(() => library.some(book => book.name === 'Three Chapter Test Book')))) {
    await page.locator('#file-input').setInputFiles(path.join(__dirname, '../fixtures/three-chapters.epub'));
    await expect(page.locator('#reader-view')).toHaveClass(/active/);
    await page.evaluate(() => showShelf());
  }
});

test('desktop ratings are visible without hover and save without opening the book', async ({ page }) => {
  await page.getByRole('button', { name:'Library', exact:true }).click();
  const card = page.locator('#shelf .book-card').first();
  await page.mouse.move(0,0);
  await expect(card.locator('.shelf-rating-widget')).toHaveCSS('opacity','1');
  await card.getByRole('button', { name:'Rate 3 stars', exact:true }).click();
  await expect(card.locator('.star-btn.filled')).toHaveCount(3);
  await expect(page.locator('#reader-view')).not.toHaveClass(/active/);
  await expect(page.locator('#book-details-modal')).not.toBeVisible();
  await expect(page.getByRole('status')).toContainText('Rated 3 stars.');
  await page.reload();
  await page.getByRole('button', { name:'Library', exact:true }).click();
  await expect(page.locator('#shelf .book-card').first().locator('.star-btn.filled')).toHaveCount(3);
  await page.mouse.move(0,0);
  await expect.poll(() => page.evaluate(() => Math.abs(document.querySelector('#desktop-nav [aria-current="page"]').getBoundingClientRect().top - document.querySelector('#desktop-nav .navigation-highlight').getBoundingClientRect().top))).toBeLessThan(1);
  await page.screenshot({ path:'test-results/library-polish-desktop-ratings.png' });
  await page.evaluate(() => { if (document.documentElement.classList.contains('dark-shell')) toggleShellTheme(); });
  await expect(card.locator('.shelf-rating-widget')).toHaveCSS('opacity','1');
  await page.screenshot({ path:'test-results/library-polish-desktop-ratings-light.png' });
});

test('More groups tools and sidebar hover stays distinct from the current page', async ({ page }) => {
  await page.getByRole('button', { name:'More', exact:true }).click();
  const more = page.locator('#desktop-content');
  for (const heading of ['Reading','Library','Preferences & help','Account']) await expect(more.getByRole('heading',{name:heading,exact:true})).toBeVisible();
  await expect(more.locator('.mobile-more-list')).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  await page.locator('#desktop-nav [data-desktop-page="offline"]').hover();
  await expect(page.locator('#desktop-nav button[aria-current="page"]')).toHaveCount(1);
  await expect(page.locator('#desktop-nav button[aria-current="page"]')).toContainText('More');
  const colors = await page.evaluate(() => ({ hover:getComputedStyle(document.querySelector('#desktop-nav [data-desktop-page="offline"]')).backgroundColor, selected:getComputedStyle(document.querySelector('#desktop-nav .navigation-highlight')).backgroundColor }));
  expect(colors.hover).not.toBe(colors.selected);
  await page.screenshot({ path:'test-results/library-polish-desktop-more.png' });
  await more.getByRole('button',{name:'Help',exact:true}).click();
  await expect(page.locator('#shortcuts-modal')).toBeVisible();
});

test('phone More stays grouped and rated books show their saved rating', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport:{width:393,height:852}, isMobile:true, hasTouch:true, serviceWorkers:'block' });
  const phone = await context.newPage(); await login(phone);
  await phone.locator('[data-mobile-tab="more"]').tap();
  await expect(phone.locator('#mobile-content .more-section')).toHaveCount(4);
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
  await phone.screenshot({path:'test-results/library-polish-phone-more.png'});
  await phone.getByRole('button',{name:'Appearance & reader defaults',exact:true}).tap();
  await expect(phone.locator('#mobile-content h1')).toHaveText('Appearance & reader defaults');
  await phone.locator('[data-mobile-tab="library"]').tap();
  await expect(phone.locator('.mobile-book-rating').first()).toHaveText('3/5');
  await phone.getByRole('button',{name:'Details for Three Chapter Test Book',exact:true}).tap();
  await expect(phone.locator('.mobile-star.filled')).toHaveCount(3);
  await phone.getByRole('button',{name:'Collections',exact:true}).click();
  await expect(phone.locator('#collections-modal')).toBeVisible();
  await phone.getByRole('button',{name:'Close collections',exact:true}).click();
  await phone.locator('#mobile-content').getByRole('button',{name:'Rate 4 stars',exact:true}).focus();
  await phone.keyboard.press('Enter');
  await expect(phone.locator('#mobile-content').getByRole('button',{name:'Rate 4 stars',exact:true})).toBeFocused();
  await expect(phone.getByRole('status')).toContainText('Rated 4 stars.');
  await context.close();
});

test('keyboard details dismiss with Escape and return to the library card', async ({ page }) => {
  await page.getByRole('button', { name:'Library', exact:true }).click();
  const card = page.locator('#shelf .book-card').first();
  await card.focus(); await card.press('Enter');
  await expect(page.locator('#book-details-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#book-details-modal')).toBeHidden();
  await expect(card).toBeFocused();
});

test('rapid rating edits survive an earlier failure and keep keyboard focus', async ({ page }) => {
  await page.getByRole('button', { name:'Library', exact:true }).click();
  const card = page.locator('#shelf .book-card').first();
  await page.route('**/api/books/*', async route => {
    if (route.request().method() === 'PATCH' && route.request().postDataJSON().rating === 2) {
      await new Promise(resolve => setTimeout(resolve, 150));
      await route.fulfill({ status:500, json:{error:'Simulated rejected rating'} });
    } else await route.continue();
  });
  await card.getByRole('button', {name:'Rate 2 stars',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(card.getByRole('button', {name:'Rate 2 stars',exact:true})).toBeFocused();
  await page.evaluate(() => showShelf());
  await card.getByRole('button', {name:'Rate 5 stars',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Rated 5 stars.');
  await expect(card.locator('.star-btn.filled')).toHaveCount(5);
  await page.reload();
  await page.getByRole('button', {name:'Library',exact:true}).click();
  await expect(card.locator('.star-btn.filled')).toHaveCount(5);
});

test('account reset clears private overlays and invalidates detached status controls', async ({ page }) => {
  await page.getByRole('button', {name:'Library',exact:true}).click();
  await page.locator('#shelf .book-card').first().click();
  await page.evaluate(() => { window.staleStatus = document.querySelector('#book-details-actions select'); });
  await page.evaluate(async () => { await openNotebookModal(); });
  await expect(page.locator('#notebook-modal')).toBeVisible();
  let mutations = 0;
  await page.route('**/api/books/*', async route => { if (route.request().method() === 'PATCH') mutations++; await route.continue(); });
  await page.evaluate(() => {
    setCurrentUser(null);
    setCurrentUser({ok:true,username:'another-reader',is_admin:false});
    staleStatus.value = 'finished'; staleStatus.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#book-details-modal')).toBeHidden();
  await expect(page.locator('#notebook-modal')).toBeHidden();
  await expect(page.locator('#book-details-content')).toBeEmpty();
  await expect(page.locator('#notebook-list')).toBeEmpty();
  expect(mutations).toBe(0);
});
