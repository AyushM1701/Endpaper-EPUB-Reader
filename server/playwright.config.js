const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:39137',
    browserName: 'webkit',
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  webServer: {
    command: 'node test/e2e-server.js',
    url: 'http://127.0.0.1:39137/healthz',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
