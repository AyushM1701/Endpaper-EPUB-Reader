const { test, expect } = require('@playwright/test');
const path = require('node:path');

test.use({ serviceWorkers: 'block' });

test('the browser tab declares working SVG and PNG book icons', async ({ page }) => {
  await page.goto('/');
  const icons = await page.locator('link[rel="icon"]').evaluateAll(items => items.map(item => ({ href: item.href, type: item.type })));
  expect(icons.map(icon => icon.type)).toEqual(['image/png', 'image/svg+xml']);
  for (const icon of icons) {
    const response = await page.request.get(icon.href);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain(icon.type);
    expect(await page.evaluate(src => new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0);
      image.onerror = () => resolve(false); image.src = src;
    }), icon.href)).toBe(true);
  }
});

test('SVG library controls preserve touch actions, names and viewport fit', async ({ page }) => {
  await page.goto('/');
  await page.locator('#username-input').fill('admin');
  await page.locator('#passphrase-input').fill('correct horse battery');
  await page.locator('#login-btn').click();
  await expect(page.locator('#dropzone')).toHaveJSProperty('hidden', false);
  if (!(await page.evaluate(() => library.some(book => book.name === 'Three Chapter Test Book')))) {
    await page.locator('#file-input').setInputFiles(path.join(__dirname, '../fixtures/three-chapters.epub'));
    await expect(page.locator('#mobile-content h1')).toHaveText('Book details');
  }
  await page.locator('[data-mobile-tab="library"]').click();
  const grid = page.getByRole('button', { name: 'Grid', exact: true });
  await expect(grid.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await grid.click();
  await expect(page.locator('.mobile-books-grid')).toBeVisible();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.locator('.mobile-books-list')).toBeVisible();
  const actions = page.getByRole('button', { name: 'Actions for Three Chapter Test Book', exact: true }).first();
  await expect(actions.locator('svg')).toBeVisible();
  await actions.click();
  await expect(page.getByRole('dialog', { name: 'Actions for Three Chapter Test Book', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(actions).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(394);
  await page.screenshot({ path: 'test-results/icons-phone-library.png' });
});
