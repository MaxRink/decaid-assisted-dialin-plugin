// Runs once per invocation in the main process, before any worker starts.
//
// Pruning lives here rather than in playwright.config.js on purpose: a unit
// test (test/e2e-run-artifacts.test.js) loads the config to assert where the
// artifacts go, and merely requiring the config must never delete anything from
// the output tree.
'use strict';

const path = require('node:path');
const { runId, pruneStaleRuns } = require('./run-artifacts');

const root = path.resolve(__dirname, '..');

module.exports = async () => {
  const run = runId();
  if (!process.env.DIALIN_E2E_OUTPUT_DIR) pruneStaleRuns(path.join(root, 'test-results'), 'run-' + run);
  if (!process.env.DIALIN_E2E_REPORT_DIR) pruneStaleRuns(path.join(root, 'playwright-report'), 'run-' + run);
};
