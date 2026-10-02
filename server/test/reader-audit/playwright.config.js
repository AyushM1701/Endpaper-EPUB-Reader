const { defineConfig } = require('@playwright/test');
const path = require('node:path');
module.exports = defineConfig({
  testDir: __dirname, timeout: 30000, expect: { timeout: 4000 }, workers: 1,
  reporter: 'list',
  outputDir: path.resolve(__dirname, '../../../../EndpaperRecovery/reader-audit-results'),
  use: { baseURL: 'http://127.0.0.1:39139', browserName: process.env.READER_AUDIT_BROWSER || 'webkit', viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, serviceWorkers: 'block' },
  webServer: { command: 'node test/e2e-server.js', cwd: path.resolve(__dirname, '../..'), env: { PORT: '39139' }, url: 'http://127.0.0.1:39139/healthz', reuseExistingServer: false },
});
