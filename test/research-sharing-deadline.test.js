const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createResearchSharing } = require('../research-sharing.js');
const schema = createResearchSharing();
const ENDPOINT = 'https://collector.example.org/v1/events';
const TOKEN = 'a'.repeat(64);
const record = (time = 27) => ({ source: 'website', mode: 'measured', kind: 'shot',
  grinder: { model: 'E64 WS', setting: 60, settingUnit: 'micrometres' },
  measurements: { pumpTimeSec: time, pumpComplete: true }, taste: { intent: 'too_sour' } });
// A client already enrolled with the test collector: these tests are about the
// upload deadline, not about the one-time enrolment round trip.
const enrolledState = () => ({ schemaVersion: 1, policyVersion: 1, localEnabled: true, sharing: false, endpoint: null, nextRevision: 0,
  records: [], queue: [], fingerprints: [], collectorTokens: [{ endpoint: ENDPOINT, token: TOKEN }] });
// Injected clock: nothing sleeps in real time, the test decides when the
// upload deadline expires and can inspect what is still scheduled.
function clock() {
  const tasks = new Map(), armed = []; let last = 0;
  return {
    timer(callback, ms) { last += 1; tasks.set(last, { callback, ms }); armed.push(ms); return last; },
    cancelTimer(handle) { tasks.delete(handle); },
    advance() { const due = [...tasks.values()]; tasks.clear(); for (const task of due) task.callback(); },
    scheduled: () => [...tasks.values()].map(task => task.ms),
    armed: () => armed,
    pending: () => tasks.size,
  };
}
function setup(extra = {}) {
  const timers = clock(), sent = [], aborted = [];
  const client = schema.createClient({ load: async () => enrolledState(), save: async () => {},
    uploadDeadlineMs: 50, timer: timers.timer, cancelTimer: timers.cancelTimer,
    send: (_url, init) => { sent.push(init); aborted.push(() => init.signal && init.signal.aborted); return { ok: true, json: async () => ({ accepted: 1 }) }; },
    ...extra });
  return { client, timers, sent };
}
async function ready(client, key = 'shot:1') {
  await client.ready; await client.setSharing(true, ENDPOINT); await client.capture(record(), key);
  assert.equal((await client.status()).queuedCount, 1);
}

test('an upload that never settles is aborted at the deadline, clears inflight and retries', { timeout: 5000 }, async () => {
  const timers = clock();
  let signal = null, calls = 0, hang = true, started;
  const didStart = new Promise(resolve => { started = resolve; });
  const client = schema.createClient({ load: async () => enrolledState(), save: async () => {},
    uploadDeadlineMs: 50, timer: timers.timer, cancelTimer: timers.cancelTimer,
    send: (_url, init) => {
      calls += 1; signal = init.signal;
      if (!hang) return { ok: true, json: async () => ({ accepted: 1 }) };
      started(); return new Promise(() => {}); // transport that never settles
    } });
  await ready(client);
  const sending = client.flush();
  await didStart;
  assert.equal(signal.aborted, false, 'the request is not aborted before its deadline');
  assert.deepEqual(timers.scheduled(), [50], 'the upload arms exactly one deadline');
  timers.advance();
  // (a) the flush settles instead of pinning inflight forever
  await assert.rejects(sending, /timed out/);
  // abort via AbortController where the runtime provides one
  assert.equal(signal.aborted, true, 'the expired request is aborted');
  // (c) the failure is reported honestly and sharing is not silently disabled
  const stalled = await client.status();
  assert.match(stalled.uploadError, /timed out/);
  assert.equal(stalled.queuedCount, 1, 'the records stay queued for a later retry');
  assert.equal(stalled.sharing, true, 'a transport stall is not a storage error');
  assert.equal(stalled.error, null);
  // (b) inflight is clear, so a later flush retries against a working transport
  hang = false;
  const retried = await client.flush();
  assert.equal(retried.sent, 1);
  assert.equal(calls, 2, 'the retry reached the transport');
  const recovered = await client.status();
  assert.equal(recovered.queuedCount, 0);
  assert.equal(recovered.uploadError, null, 'a successful upload clears the stall');
});

test('the deadline is cancelled when an upload finishes in time', async () => {
  const { client, timers, sent } = setup();
  await ready(client);
  const result = await client.flush();
  assert.equal(result.sent, 1); assert.equal(sent.length, 1);
  assert.deepEqual(timers.armed(), [50], 'every upload arms the deadline');
  assert.equal(timers.pending(), 0, 'no deadline survives a completed upload');
  assert.equal((await client.status()).uploadError, null);
});

test('a stalled upload reports no endpoint or token in any message', { timeout: 5000 }, async () => {
  const timers = clock();
  const client = schema.createClient({ load: async () => enrolledState(), save: async () => {},
    uploadDeadlineMs: 50, timer: timers.timer, cancelTimer: timers.cancelTimer,
    send: () => new Promise(() => {}) });
  await ready(client);
  const sending = client.flush();
  await new Promise(setImmediate);
  assert.deepEqual(timers.scheduled(), [50], 'the stalled upload armed its deadline');
  timers.advance();
  const error = await sending.catch(failure => failure);
  assert.match(error.message, /timed out/);
  const status = await client.status();
  for (const message of [error.message, status.uploadError, status.error || ''])
    assert.equal(/collector\.example\.org|https:|[a-f0-9]{64}/.test(message), false, 'no endpoint or token in "' + message + '"');
});

test('a transport error is reported with its endpoint and token redacted', async () => {
  const { client } = setup({ send: () => { throw new Error('connect to ' + ENDPOINT + ' failed for token ' + TOKEN); } });
  await ready(client);
  await assert.rejects(client.flush());
  const status = await client.status();
  assert.match(status.uploadError, /failed/);
  assert.equal(status.uploadError.includes('collector.example.org'), false);
  assert.equal(status.uploadError.includes(TOKEN), false);
  assert.match(status.uploadError, /<endpoint>[\s\S]*<token>/);
});

test('the deadline race works in a QuickJS-like runtime without AbortController or URL', { timeout: 5000 }, async () => {
  // Reproduce the optional-adapter note in research-sharing.js: only the
  // primitives a QuickJS host is guaranteed to provide, plus an injected timer.
  const context = vm.createContext({ console, JSON, Math, Number, String, Object, Array, Map, Set, Error, Promise,
    Date, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync('research-sharing.js', 'utf8').split('if (typeof module')[0] + '\nthis.createResearchSharing = createResearchSharing;', context);
  assert.equal(vm.runInContext('typeof AbortController', context), 'undefined');
  assert.equal(vm.runInContext('typeof URL', context), 'undefined');
  const isolated = context.createResearchSharing();
  const timers = clock();
  let calls = 0, hang = true;
  const client = isolated.createClient({ load: async () => structuredClone(enrolledState()), save: async () => {},
    uploadDeadlineMs: 50, timer: timers.timer, cancelTimer: timers.cancelTimer,
    send: (_url, init) => { calls += 1; assert.equal(init.signal, undefined, 'no AbortController means no signal');
      return hang ? new Promise(() => {}) : { ok: true, json: async () => ({ accepted: 1 }) }; } });
  await client.ready; await client.setSharing(true, ENDPOINT); await client.capture(record(), 'shot:1');
  const sending = client.flush();
  await new Promise(setImmediate);
  assert.deepEqual(timers.scheduled(), [50], 'the stalled upload armed its deadline');
  timers.advance();
  await assert.rejects(sending, /timed out/);
  assert.match((await client.status()).uploadError, /timed out/);
  hang = false;
  assert.equal((await client.flush()).sent, 1);
  assert.equal(calls, 2);
});
