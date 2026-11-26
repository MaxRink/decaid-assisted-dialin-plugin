// Artifact bookkeeping for the Playwright config.
//
// Playwright deletes a run's output directory when it starts and deletes each
// worker's .playwright-artifacts-<n> directory when that worker exits. Two
// invocations sharing one output directory therefore delete the traces, videos
// and screenshots the other one is still writing, and the victim fails with
// "ENOENT: no such file or directory" against its own artifact path.
//
// Every invocation therefore owns one directory. The config is evaluated both
// in the main process and again in every worker it spawns, so the id cannot be
// the current pid: the first evaluation stamps the main process id into the
// environment and the workers inherit it. One run, one directory.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RUN_PREFIX = 'run-';

// Returns the id used for this invocation's artifact directories. The caller
// that receives a freshly stamped id owns the run and may prune older ones.
function runId(env = process.env) {
  if (typeof env.DIALIN_E2E_RUN_ID === 'string' && env.DIALIN_E2E_RUN_ID) return env.DIALIN_E2E_RUN_ID;
  env.DIALIN_E2E_RUN_ID = String(process.pid);
  return env.DIALIN_E2E_RUN_ID;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error && error.code === 'EPERM';
  }
}

// Removes `run-<pid>` directories whose process is gone. Directory names that
// are not pid-derived (`DIALIN_E2E_RUN_ID=nightly`, for example) are never
// touched, and the caller's own directory is always kept.
function pruneStaleRuns(directory, keep = '') {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep || !entry.name.startsWith(RUN_PREFIX)) continue;
    const id = entry.name.slice(RUN_PREFIX.length);
    if (!/^\d+$/.test(id) || processAlive(Number(id))) continue;
    const target = path.join(directory, entry.name);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch (_) { /* a directory we cannot remove is not worth failing a run over */ }
  }
  return removed;
}

module.exports = { RUN_PREFIX, runId, processAlive, pruneStaleRuns };
