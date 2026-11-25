const {defineConfig, devices} = require('@playwright/test');
const path = require('node:path');
const {runId, pruneStaleRuns} = require('./e2e/run-artifacts');
const baseURL = 'http://127.0.0.1:' + (process.env.DIALIN_TEST_PORT || 9017);
// One artifact directory per invocation, shared by the main process and the
// workers it spawns (see e2e/run-artifacts.js). A shared directory lets one run
// delete the traces, videos and screenshots another run is still writing.
const inheritedRunId = Boolean(process.env.DIALIN_E2E_RUN_ID);
const run = runId();
const outputDir = process.env.DIALIN_E2E_OUTPUT_DIR || path.join('test-results', 'run-' + run);
// The HTML report may not live inside outputDir, so it gets its own folder
// under the same run id instead of a shared playwright-report/ tree.
const reportDir = process.env.DIALIN_E2E_REPORT_DIR || path.join('playwright-report', 'run-' + run);
// Only the process that created the id owns the run; workers inherit it and
// must never sweep the directories their own run is writing into.
if (!inheritedRunId) {
  if (!process.env.DIALIN_E2E_OUTPUT_DIR) pruneStaleRuns('test-results', 'run-' + run);
  if (!process.env.DIALIN_E2E_REPORT_DIR) pruneStaleRuns('playwright-report', 'run-' + run);
}
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
