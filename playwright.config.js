const {defineConfig, devices} = require('@playwright/test');
module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  timeout: 45000,
  expect: {timeout: 10000},
  fullyParallel: true,
  workers: process.env.CI ? 2 : 2,
  retries: 0,
  reporter: [['list'], ['html', {open: 'never'}], ['json', {outputFile: 'test-results/results.json'}]],
  use: {baseURL: 'http://127.0.0.1:9017', trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure'},
  webServer: {command: 'node e2e/server.js', url: 'http://127.0.0.1:9017/simulator/', reuseExistingServer: false, gracefulShutdown: {signal: 'SIGTERM', timeout: 5000}},
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome'], ...(process.env.PLAYWRIGHT_CHROME ? {channel: 'chrome'} : {})}},
    {name: 'firefox', use: {...devices['Desktop Firefox']}},
    {name: 'webkit', use: {...devices['Desktop Safari']}},
    {name: 'mobile', use: {...devices['iPhone 13'], defaultBrowserType: 'chromium', ...(process.env.PLAYWRIGHT_CHROME ? {channel: 'chrome'} : {})}},
  ],
});
