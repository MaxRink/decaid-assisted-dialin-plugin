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
// A client already enrolled with the test collector: most cases are about the
// upload deadline, not about the one-time enrolment round trip.
const enrolledState = (extra = {}) => ({ schemaVersion: 1, policyVersion: 1, localEnabled: true, sharing: false, endpoint: null, nextRevision: 0,
  records: [], queue: [], fingerprints: [], collectorTokens: [{ endpoint: ENDPOINT, token: TOKEN }], ...extra });
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
const tick = () => new Promise(setImmediate);
function setup(extra = {}) {
  const timers = clock(), sent = [];
  const client = schema.createClient({ load: async () => enrolledState(), save: async () => {},
    uploadDeadlineMs: 50, timer: timers.timer, cancelTimer: timers.cancelTimer,
    send: (_url, init) => { sent.push(init); return { ok: true, json: async () => ({ accepted: 1 }) }; },
    ...extra });
  return { client, timers, sent };
}
const receipt = (accepted = 1) => ({ ok: true, json: async () => ({ accepted }) });
async function ready(client, key = 'shot:1') {
  await client.ready; await client.setSharing(true, ENDPOINT); await client.capture(record(), key);
  assert.equal((await client.status()).queuedCount, 1);
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('an upload that never settles is abandoned at the deadline, clears inflight and retries', { timeout: 5000 }, async () => {
  const timers = clock();
  let signal = null, calls = 0, hang = true, started;
  const didStart = new Promise(resolve => { started = resolve; });
  const client = schema.createClient({ load: async () => enrolledState(), save: async () => {},
    uploadDeadlineMs: 50, timer: timers.timer, cancelTimer: timers.cancelTimer,
    send: (_url, init) => {
      calls += 1; signal = init.signal;
      if (!hang) return receipt();
      started(); return new Promise(() => {}); // transport that never settles
    } });
  await ready(client);
  const sending = client.flush();
  await didStart; await tick();
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

test('an abandoned attempt cannot clear a newer upload', { timeout: 5000 }, async () => {
  const timers = clock();
  const late = deferred(), second = deferred();
  const signals = [];
  let calls = 0;
  const client = schema.createClient({ load: async () => enrolledState(), save: async () => {},
    uploadDeadlineMs: 50, timer: timers.timer, cancelTimer: timers.cancelTimer,
    send: (_url, init) => { calls += 1; signals.push(init.signal); return calls === 1 ? late.promise : second.promise; } });
  await ready(client);
  const first = client.flush();
  await tick();
  timers.advance();                                   // only upload 1 misses its deadline
  await assert.rejects(first, /timed out/);
  assert.equal(signals[0].aborted, true);
  const second_flush = client.flush();                // upload 2 is live
  await tick();
  assert.equal(calls, 2);
  assert.equal(signals[1].aborted, false, 'upload 2 starts unaborted');
  late.resolve(receipt());                            // upload 1 answers long after its deadline
  for (let i = 0; i < 6; i += 1) await tick();
  assert.equal(signals[1].aborted, false, 'a late completion does not abort the live upload');
  // The privacy path: an opt-out must still reach the upload that is running now.
  await client.setSharing(false);
  assert.equal(signals[1].aborted, true, 'opt-out aborts the upload that is still in flight');
  assert.equal((await client.status()).sharing, false);
  second.resolve(receipt()); await tick();
  await assert.rejects(second_flush, /timed out/).catch(() => {});
});

test('the deadline covers the enrolment request as well', { timeout: 5000 }, async () => {
  const timers = clock();
  let enrolHangs = true, started;
  const didStart = new Promise(resolve => { started = resolve; });
  const client = schema.createClient({ load: async () => enrolledState({ collectorTokens: [] }), save: async () => {},
    uploadDeadlineMs: 50, timer: timers.timer, cancelTimer: timers.cancelTimer,
    send: (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.enrol === true) { started(); return enrolHangs ? new Promise(() => {}) : { ok: true, json: async () => ({ token: TOKEN }) }; }
      return { ok: true, json: async () => ({ accepted: body.records.length }) };
    } });
  await ready(client);
  const sending = client.flush();
  await didStart; await tick();
  assert.deepEqual(timers.scheduled(), [50], 'the enrolment request arms a deadline');
  timers.advance();
  await assert.rejects(sending, /timed out/);
  assert.match((await client.status()).uploadError, /timed out/);
  enrolHangs = false;
  assert.equal((await client.flush()).sent, 1, 'a later flush enrols and uploads');
  assert.equal((await client.status()).queuedCount, 0);
});

test('a receipt that arrives after the deadline leaves the queue for the retry to acknowledge', { timeout: 5000 }, async () => {
  const timers = clock();
  const late = deferred();
  let accepted = 1, bodies = 0;
  const client = schema.createClient({ load: async () => enrolledState(), save: async () => {},
    uploadDeadlineMs: 50, timer: timers.timer, cancelTimer: timers.cancelTimer,
    send: () => { bodies += 1; return late.promise; } });
  await ready(client);
  const sending = client.flush();
  await tick(); await tick();
  timers.advance();
  await assert.rejects(sending, /timed out/);
  assert.equal((await client.status()).queuedCount, 1);
  // The abandoned attempt does not apply a receipt nobody is waiting for; the
  // retry re-sends the same observations, which the collector deduplicates by
  // revision, so nothing is lost or counted twice.
  late.resolve(receipt(accepted));
  for (let i = 0; i < 20; i += 1) await tick();
  const after = await client.status();
  assert.equal(after.queuedCount, 1, 'the abandoned attempt does not drain the queue');
  assert.match(after.uploadError, /timed out/);
  accepted = 1;
  const retried = await client.flush();
  assert.equal(retried.sent, 1);
  assert.equal(bodies, 2, 'the retry re-sends the same records');
  assert.equal((await client.status()).queuedCount, 0);
});

test('a wedged storage adapter is not reported as a transport timeout', { timeout: 5000 }, async () => {
  const timers = clock();
  const reload = deferred();
  let saved = enrolledState(), reloads = 0, sends = 0, hangReload = false;
  const client = schema.createClient({
    load: async () => saved,
    reload: async () => { if (!hangReload) return saved; reloads += 1; return reload.promise; },
    save: async value => { saved = structuredClone(value); },
    uploadDeadlineMs: 50, timer: timers.timer, cancelTimer: timers.cancelTimer,
    send: () => { sends += 1; return receipt(); } });
  await client.ready; await client.setSharing(true, ENDPOINT); await client.capture(record(), 'shot:1');
  assert.equal((await client.status()).queuedCount, 1);
  hangReload = true;
  const sending = client.flush();
  await tick(); await tick();
  assert.equal(reloads, 1, 'the storage adapter is what stalled');
  assert.deepEqual(timers.scheduled(), [], 'no transport deadline is armed for storage work');
  assert.equal(sends, 0, 'the transport was never called');
  // Documented limitation: status() refreshes under the same storage lock, so a
  // wedged adapter blocks it until it acknowledges or rejects. The deadline
  // does not pretend otherwise.
  const observed = await Promise.race([
    client.status().then(() => 'resolved', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('blocked'), 20)),
  ]);
  assert.equal(observed, 'blocked', 'status() waits on the wedged adapter, as documented');
  reload.resolve(saved);
  const result = await sending;
  assert.equal(result.sent, 1);
  assert.equal((await client.status()).uploadError, null, 'storage latency is not an upload failure');
});

test('the configured destination and its token never appear in any message', async () => {
  const { client } = setup({ send: () => { throw new Error(
    'connect to ' + ENDPOINT + ' (host collector.example.org) failed for token glued' + TOKEN + 'tail and id' + 'c'.repeat(32) + TOKEN); } });
  await ready(client);
  const failure = await client.flush().catch(error => error);
  const status = await client.status();
  for (const text of [failure.message, status.uploadError]) {
    assert.doesNotMatch(text, /collector\.example\.org|https:|v1\/events/, 'no destination in "' + text + '"');
    assert.equal(text.includes(TOKEN), false, 'no token in "' + text + '"');
    assert.match(text, /<redacted>/);
  }
});

test('a non-Error rejection still produces a readable message', async () => {
  const { client } = setup({ send: () => { throw {}; } });
  await ready(client);
  const failure = await client.flush().catch(error => error);
  assert.equal(failure.message, 'Research upload failed');
  assert.equal((await client.status()).uploadError, 'Research upload failed');
});

test('the deadline label is exact', { timeout: 5000 }, async () => {
  for (const [ms, expected] of [[500, '500 milliseconds'], [1000, '1 second'], [1500, '1.5 seconds'], [30000, '30 seconds']]) {
    const timers = clock();
    const client = schema.createClient({ load: async () => enrolledState(), save: async () => {},
      uploadDeadlineMs: ms, timer: timers.timer, cancelTimer: timers.cancelTimer, send: () => new Promise(() => {}) });
    await ready(client);
    const sending = client.flush().catch(error => error);
    await tick(); await tick();
    timers.advance();
    const failure = await sending;
    assert.match(failure.message, new RegExp('timed out after ' + expected.replace('.', '\\.') + ';'));
  }
});

test('a throwing scheduler adapter cannot resurrect the stall', { timeout: 5000 }, async () => {
  const timers = clock();
  const client = schema.createClient({ load: async () => enrolledState(), save: async () => {},
    uploadDeadlineMs: 50, timer: timers.timer,
    cancelTimer: () => { throw new Error('scheduler is broken'); },
    send: () => receipt() });
  await ready(client);
  const result = await client.flush();
  assert.equal(result.sent, 1, 'a broken cancelTimer does not prevent the upload from settling');
  assert.equal((await client.status()).uploadError, null);
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
      return hang ? new Promise(() => {}) : receipt(); } });
  await client.ready; await client.setSharing(true, ENDPOINT); await client.capture(record(), 'shot:1');
  const sending = client.flush();
  await tick(); await tick();
  assert.deepEqual(timers.scheduled(), [50], 'the stalled upload armed its deadline');
  timers.advance();
  await assert.rejects(sending, /timed out/);
  assert.match((await client.status()).uploadError, /timed out/);
  hang = false;
  assert.equal((await client.flush()).sent, 1);
  assert.equal(calls, 2);
});

test('without a timer the deadline cannot fire, so a stalled transport is still not abandoned', { timeout: 5000 }, async () => {
  // Characterisation of the documented precondition: the deadline needs
  // setTimeout or an injected timer. This is the pre-deadline behaviour and it
  // is what a runtime with neither timers nor a timer adapter gets.
  const context = vm.createContext({ console, JSON, Math, Number, String, Object, Array, Map, Set, Error, Promise, Date });
  vm.runInContext(fs.readFileSync('research-sharing.js', 'utf8').split('if (typeof module')[0] + '\nthis.createResearchSharing = createResearchSharing;', context);
  assert.equal(vm.runInContext('typeof setTimeout', context), 'undefined');
  const isolated = context.createResearchSharing();
  const client = isolated.createClient({ load: async () => structuredClone(enrolledState()), save: async () => {},
    send: () => new Promise(() => {}) });
  await client.ready; await client.setSharing(true, ENDPOINT); await client.capture(record(), 'shot:1');
  const outcome = await Promise.race([
    client.flush().then(() => 'settled', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('pending'), 50)),
  ]);
  assert.equal(outcome, 'pending', 'no timer means no deadline, as documented');
});
