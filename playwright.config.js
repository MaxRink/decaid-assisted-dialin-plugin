const {defineConfig, devices} = require('@playwright/test');
const path = require('node:path');
const baseURL = 'http://127.0.0.1:' + (process.env.DIALIN_TEST_PORT || 9017);
// Playwright deletes a run's output directory when it starts and deletes each
// worker's .playwright-artifacts-<n> directory when that worker exits. Two
// invocations sharing the default `test-results` path therefore delete the
// traces, videos and screenshots the other one is still writing, and the
// victim reports "ENOENT: no such file or directory" against its own
// .playwright-artifacts directory. Every invocation now owns its artifact
// directory; DIALIN_E2E_OUTPUT_DIR pins the path when a stable location is
// wanted (CI keeps uploading test-results/, which contains every run).
const runId = process.env.DIALIN_E2E_RUN_ID || String(process.pid);
const outputDir = process.env.DIALIN_E2E_OUTPUT_DIR || path.join('test-results', 'run-' + runId);
// The HTML report may not live inside outputDir, so it gets its own folder
// under the same run id instead of a shared playwright-report/ tree.
const reportDir = process.env.DIALIN_E2E_REPORT_DIR || path.join('playwright-report', 'run-' + runId);
module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  outputDir,
  timeout: 45000,
  expect: {timeout: 10000},
  fullyParallel: true,
  workers: process.env.CI ? 2 : 2,
  retries: 0,
  reporter: [['list'], ['html', {open: 'never', outputFolder: reportDir}], ['json', {outputFile: path.join(outputDir, 'results.json')}]],
  use: {baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure'},
  webServer: {command: 'node e2e/server.js', url: baseURL + '/simulator/', reuseExistingServer: false, gracefulShutdown: {signal: 'SIGTERM', timeout: 5000}},
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome'], ...(process.env.PLAYWRIGHT_CHROME ? {channel: 'chrome'} : {})}},
    {name: 'firefox', use: {...devices['Desktop Firefox']}},
    {name: 'webkit', use: {...devices['Desktop Safari']}},
    {name: 'mobile', use: {...devices['iPhone 13'], defaultBrowserType: 'chromium', ...(process.env.PLAYWRIGHT_CHROME ? {channel: 'chrome'} : {})}},
  ],
});
