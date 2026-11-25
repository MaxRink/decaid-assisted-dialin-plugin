const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runId, processAlive, pruneStaleRuns } = require('../e2e/run-artifacts');
const root = path.resolve(__dirname, '..');
const config = require('../playwright.config.js');

test('a worker process resolves the same artifact directory as its parent', () => {
  // Playwright evaluates the config once in the main process and again in every
  // worker it spawns; both must write into one directory.
  assert.equal(process.env.DIALIN_E2E_RUN_ID, String(process.pid), 'the first evaluation owns the run id');
  const workerOutput = execFileSync(process.execPath,
    ['-e', 'process.stdout.write(String(require("./playwright.config.js").outputDir))'],
    { cwd: root, env: { ...process.env }, encoding: 'utf8' });
  assert.equal(workerOutput, config.outputDir, 'a spawned worker uses the parent run id');
  assert.match(config.outputDir, new RegExp('run-' + process.pid + '$'));
});

test('the run report and its traces share one directory', () => {
  const json = config.reporter.find(entry => entry[0] === 'json')[1];
  assert.equal(path.dirname(json.outputFile), config.outputDir,
    'results.json sits next to the failure traces of the same run');
  const html = config.reporter.find(entry => entry[0] === 'html')[1];
  assert.equal(html.outputFolder.startsWith(config.outputDir), false, 'the HTML report stays outside outputDir');
  assert.match(html.outputFolder, new RegExp('run-' + process.pid + '$'));
});

test('an explicit run id is used verbatim', () => {
  const env = { DIALIN_E2E_RUN_ID: 'nightly' };
  assert.equal(runId(env), 'nightly');
  assert.equal(env.DIALIN_E2E_RUN_ID, 'nightly');
  const fresh = {};
  assert.equal(runId(fresh), String(process.pid));
  assert.equal(runId(fresh), String(process.pid), 'a worker inherits instead of stamping its own id');
});

test('stale run directories are pruned while live and named runs are kept', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dialin-runs-'));
  const deadPid = Math.max(process.pid + 100000, 999999);
  assert.equal(processAlive(deadPid), false, 'the fixture pid must not be running');
  const stale = path.join(directory, 'run-' + deadPid);
  const live = path.join(directory, 'run-' + process.pid);
  const named = path.join(directory, 'run-nightly');
  const kept = path.join(directory, 'run-424242');
  for (const entry of [stale, live, named, kept]) fs.mkdirSync(entry);
  fs.writeFileSync(path.join(live, 'trace.zip'), 'in flight');
  assert.deepEqual(pruneStaleRuns(directory, 'run-424242'), [stale]);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['run-424242', 'run-nightly', 'run-' + process.pid].sort());
  assert.equal(fs.readFileSync(path.join(live, 'trace.zip'), 'utf8'), 'in flight', 'a live run keeps its artifacts');
  assert.deepEqual(pruneStaleRuns(path.join(directory, 'missing'), 'run-1'), [], 'a missing directory is not an error');
});
