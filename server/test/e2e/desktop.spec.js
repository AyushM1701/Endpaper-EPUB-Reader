const { test, expect } = require('@playwright/test');
const path = require('node:path');

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });

test('desktop shelf and reader remain usable', async ({ page }) => {
  await page.goto('/');
  await page.locator('#username-input').fill('admin');
  await page.locator('#passphrase-input').fill('correct horse battery');
  await page.locator('#login-btn').click();
  await expect(page.locator('#login-gate')).toBeHidden();
  await expect(page.locator('#topbar')).toBeVisible();
  await expect(page.locator('#mobile-shell')).toBeHidden();
  await expect(page.locator('#dropzone')).toHaveJSProperty('hidden', false);
  if (!(await page.locator('#shelf .book-card').count())) {
    await page.locator('#file-input').setInputFiles(path.join(__dirname, '../fixtures/three-chapters.epub'));
    await expect(page.locator('#reader-view')).toHaveClass(/active/);
    await page.evaluate(() => showShelf());
  }
  await expect(page.locator('#shelf .book-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.locator('#shelf .book-card').click();
  await page.locator('#book-details-actions .primary-action').click();
  await expect(page.frameLocator('#viewer iframe').locator('body')).toContainText('Chapter One');
  await expect(page.locator('#reader-error-state')).toBeHidden();
});
