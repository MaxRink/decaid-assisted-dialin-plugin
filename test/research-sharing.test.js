const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createResearchSharing } = require('../research-sharing.js');
const schema = createResearchSharing();
const record = (time = 27) => ({ source: 'website', mode: 'measured', kind: 'shot', grinder: { model: 'E64 WS', setting: 60, settingUnit: 'micrometres' }, measurements: { pumpTimeSec: time, pumpComplete: true }, taste: { intent: 'too_sour' } });
function setup(extra = {}) {
  let stored = null; const sent = [];
  const client = schema.createClient({ load: async () => stored, save: async state => { stored = structuredClone(state); },
    send: async (url, init) => { sent.push({ url, init }); return { ok: true, json: async () => ({ accepted: JSON.parse(init.body).records.length }) }; }, ...extra });
  return { client, sent, stored: () => stored };
}
function coordinated() {
  let stored = null, lock = Promise.resolve();
  const withLock = operation => {
    const result = lock.then(operation);
    lock = result.catch(() => {});
    return result;
  };
  return { stored: () => structuredClone(stored), withLock,
    make: (extra = {}) => schema.createClient({ load: async () => structuredClone(stored), reload: async () => structuredClone(stored),
      save: async value => { stored = structuredClone(value); }, withLock,
      send: async (_url, init) => ({ ok: true, json: async () => ({ accepted: JSON.parse(init.body).records.length }) }), ...extra }) };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const receipt = { ok: true, json: async () => ({ accepted: 1 }) };

test('factory is standalone without module, URL, browser or Node dependencies', () => {
  const isolated = vm.runInNewContext('(' + createResearchSharing.toString() + ')()');
  assert.equal(isolated.sanitizeRecord(record()).grinder.setting, 60);
});

test('allowlist drops identities, raw traces and free text while preserving measured categories', () => {
  const input = { ...record(), name: 'private', ip: '192.0.2.1', shotId: 'shot-secret', timestamp: '2026-10-12T12:00:00Z', token: 'secret',
    grinder: { ...record().grinder, serial: 'private-serial' }, coffee: { name: 'private-bean', roaster: 'private-roaster', roast: 'light', species: 'arabica' },
    taste: { intent: 'too_sour', notes: 'private prose', acidity: 4 }, trace: [{ pressure: 9 }] };
  const clean = schema.sanitizeRecord(input);
  assert.equal(JSON.stringify(clean).includes('private'), false);
  assert.equal(clean.coffee.roast, 'light'); assert.equal(clean.taste.acidity, 4);
  assert.throws(() => schema.validateRecord(input));
  assert.deepEqual(schema.validateRecord(clean), clean);
});

test('rejects invalid envelopes; drops invalid numeric/category values rather than coercing', () => {
  assert.throws(() => schema.sanitizeRecord({ source: 'website', mode: 'measured', kind: 'shot' }));
  const clean = schema.sanitizeRecord({ ...record(), measurements: { pumpTimeSec: '27', meanPressureBar: Infinity, yieldG: 301, doseG: 18 }, grinder: { setting: 999, settingUnit: 'unknown' } });
  assert.deepEqual(clean.measurements, { doseG: 18 }); assert.equal(clean.grinder.setting, undefined);
  assert.throws(() => schema.validateBatch({ schemaVersion: 1, policyVersion: 1, records: Array(26).fill(schema.sanitizeRecord(record())) }));
});

test('HTTPS endpoint rejects credentials, fragment, query, control bytes and alternate schemes', () => {
  for (const value of ['http://example.org/v1/events', 'https://user:pass@example.org/x', 'https://example.org/x?token=a', 'https://example.org/#x', 'https://example.org\n/x', 'https://example.org\\evil']) assert.throws(() => schema.validateEndpoint(value));
  assert.equal(schema.validateEndpoint('https://collector.example.org/v1/events'), 'https://collector.example.org/v1/events');
});

test('local archive works by default but consent and endpoint are required before explicit send', async () => {
  const { client, sent } = setup(); await client.ready;
  await client.capture(record(), 'shot:1'); await client.flush();
  assert.equal(sent.length, 0); assert.equal((await client.exportLocal()).records.length, 1);
  assert.equal((await client.status()).queuedCount, 0);
  await client.setSharing(true, null); await client.capture(record(29), 'shot:2'); await client.flush(); assert.equal(sent.length, 0);
  await client.setSharing(true, 'https://collector.example.org/v1/events');
  assert.equal((await client.status()).queuedCount, 0, 'endpoint choice does not backfill old data');
  await client.capture(record(30), 'shot:3'); assert.equal(sent.length, 0);
  assert.equal((await client.flush()).sent, 1); assert.equal(sent.length, 1);
  assert.equal(sent[0].init.credentials, 'omit'); assert.equal(sent[0].init.redirect, 'error');
  assert.equal(sent[0].init.referrerPolicy, 'no-referrer');
  assert.equal(sent[0].init.body.includes('shot:3'), false);
});

test('local toggle is persisted separately; disable sharing clears queue but retains export', async () => {
  const { client, stored } = setup(); await client.ready;
  await client.setSharing(true, 'https://collector.example.org/v1/events');
  await client.capture(record(), '1'); await client.setSharing(false);
  assert.equal(stored().sharing, false); assert.deepEqual(stored().queue, []);
  assert.equal((await client.exportLocal()).records.length, 1);
  await client.setLocalCollection(false); await client.capture(record(30), '2');
  assert.equal((await client.exportLocal()).records.length, 1); assert.equal(stored().localEnabled, false);
  await client.clear(); assert.equal((await client.exportLocal()).records.length, 0);
  assert.equal((await client.status()).sharing, false);
});

test('amendment replaces one local/queued entry, never exports local identifier', async () => {
  const { client, sent } = setup(); await client.ready; await client.setSharing(true, 'https://collector.example.org/v1/events');
  await client.capture(record(), 'shot:private-id'); await client.capture(record(31), 'shot:private-id');
  assert.equal((await client.status()).queuedCount, 1);
  assert.equal((await client.exportLocal()).records[0].measurements.pumpTimeSec, 31);
  await client.flush(); assert.equal(sent[0].init.body.includes('private-id'), false);
  assert.equal(JSON.parse(sent[0].init.body).records.length, 1);
});

test('old in-flight acknowledgment cannot drop a newer amendment', async () => {
  let acknowledge, started; const didStart = new Promise(resolve => { started = resolve; });
  const { client } = setup({ send: async () => { started(); return await new Promise(resolve => { acknowledge = resolve; }); } });
  await client.ready; await client.setSharing(true, 'https://collector.example.org/v1/events'); await client.capture(record(), 'shot:1');
  const sending = client.flush(); await didStart;
  await client.capture(record(32), 'shot:1'); acknowledge({ ok: true, json: async () => ({ accepted: 1 }) }); await sending;
  assert.equal((await client.status()).queuedCount, 1);
  assert.equal((await client.exportLocal()).records[0].measurements.pumpTimeSec, 32);
});

test('optout during upload aborts where supported, deletes queue and ignores stale acknowledgment', async () => {
  let finish, started, signal; const didStart = new Promise(resolve => { started = resolve; });
  const { client, stored } = setup({ send: async (_url, init) => { signal = init.signal; started(); return await new Promise(resolve => { finish = resolve; }); } });
  await client.ready; await client.setSharing(true, 'https://collector.example.org/v1/events'); await client.capture(record(), '1');
  const sending = client.flush(); await didStart; await client.setSharing(false);
  assert.equal(signal.aborted, true); assert.deepEqual(stored().queue, []);
  finish({ ok: true, json: async () => ({ accepted: 1 }) }); assert.equal((await sending).sent, 0);
  assert.equal((await client.status()).sharing, false);
});

test('an immediate optout supersedes an earlier queued optin', async () => {
  const { client, sent } = setup(); await client.ready;
  const enabling = client.setSharing(true, 'https://collector.example.org/v1/events');
  const capture = client.capture(record(), '1'); const disabling = client.setSharing(false);
  await Promise.all([enabling, capture, disabling]); await client.flush();
  assert.equal(sent.length, 0); assert.equal((await client.status()).queuedCount, 0);
});

test('failed or redirected transmission retains data; no automatic retry runs', async () => {
  let calls = 0;
  const { client } = setup({ send: async () => { calls++; return { ok: true, redirected: true }; } });
  await client.ready; await client.setSharing(true, 'https://collector.example.org/v1/events'); await client.capture(record(), '1');
  await assert.rejects(client.flush()); assert.equal(calls, 1); assert.equal((await client.status()).queuedCount, 1);
});

test('invalid storage and failed persistence fail closed without transmitting', async () => {
  const invalid = setup({ load: async () => ({ sharing: true, records: [] }) }); await invalid.client.ready;
  assert.equal((await invalid.client.status()).sharing, false); await assert.rejects(invalid.client.capture(record()));
  const fail = setup({ save: async () => { throw new Error('disk full'); } }); await fail.client.ready;
  await assert.rejects(fail.client.setSharing(true, 'https://collector.example.org/v1/events')); await fail.client.flush(); assert.equal(fail.sent.length, 0);
});

test('local history and outgoing queue are bounded; one flush sends at most 25 records', async () => {
  const { client, sent } = setup(); await client.ready; await client.setSharing(true, 'https://collector.example.org/v1/events');
  for (let n = 0; n < 205; n++) await client.capture(record(20 + n / 100), 'shot:' + n);
  assert.equal((await client.status()).localCount, 200); assert.equal((await client.status()).queuedCount, 100);
  await client.flush(); assert.equal(JSON.parse(sent[0].init.body).records.length, 25); assert.equal((await client.status()).queuedCount, 75);
});

test('persisted choice and queue survive restart; reload never triggers send itself', async () => {
  const first = setup(); await first.client.ready; await first.client.setSharing(true, 'https://collector.example.org/v1/events'); await first.client.capture(record(), '1');
  const next = setup({ load: async () => first.stored() }); await next.client.ready;
  assert.equal((await next.client.status()).sharing, true); assert.equal((await next.client.status()).queuedCount, 1); assert.equal(next.sent.length, 0);
});

test('all reviewed grinder models and their labeled display coordinates survive minimization', () => {
  const models = require('../data/grinder-dials.json').models;
  for (const model of models) {
    const clean = schema.sanitizeRecord({ ...record(), grinder: { model: model.model, setting: 12, settingUnit: model.unit } });
    assert.equal(clean.grinder.model, model.model);
    assert.equal(clean.grinder.setting, 12, model.unit);
    if (model.unit === "decimal dial numbers") assert.equal(clean.grinder.settingUnit, "printed-decimal");
  }
  const clean = schema.sanitizeRecord({ ...record(), advice: { algorithm: 'native-response', status: 'collecting' },
    phases: [{ role: 'preinfusion', source: 'recorded_substate', durationSec: 5, meanMachineFlowMlPerSec: 2.1, profileName: 'private name' }] });
  assert.equal(clean.advice.algorithm, 'native-response'); assert.equal(clean.advice.status, 'collecting');
  assert.equal(clean.phases[0].profileName, undefined); assert.equal(clean.phases[0].durationSec, 5);
});

test('unchanged recaptures are idempotent after flush and across restarts, including archive-off transport state', async () => {
  const first = setup(); await first.client.ready; await first.client.setLocalCollection(false);
  await first.client.setSharing(true, 'https://collector.example.org/v1/events');
  const key = 'opaque / shot ? ' + 'x'.repeat(180);
  await first.client.capture(record(), key); await first.client.flush();
  await first.client.capture(record(), key); assert.equal((await first.client.status()).queuedCount, 0);
  assert.equal((await first.client.exportLocal()).records.length, 0);
  const second = setup({ load: async () => first.stored() }); await second.client.ready;
  await second.client.capture(record(), key); await second.client.flush(); assert.equal(second.sent.length, 0);
  await second.client.capture(record(32), key); assert.equal((await second.client.status()).queuedCount, 1);
  await second.client.setSharing(false); assert.deepEqual(second.stored().fingerprints, []);
  const before = structuredClone(second.stored()); await second.client.capture(record(34), 'another'); assert.deepEqual(second.stored(), before);
});

test('default archive deduplicates unchanged shot after successful send', async () => {
  const { client, sent } = setup(); await client.ready; await client.setSharing(true, 'https://collector.example.org/v1/events');
  await client.capture(record(), 'shot'); await client.flush(); await client.capture(record(), 'shot'); await client.flush();
  assert.equal(sent.length, 1); assert.equal((await client.status()).localCount, 1);
});

test('random observation identity survives amendments and sent-state reload without leaking local keys', async () => {
  const first = setup(); await first.client.ready; await first.client.setLocalCollection(false);
  await first.client.setSharing(true, 'https://collector.example.org/v1/events');
  await first.client.capture(record(), 'private/device/shot-id'); await first.client.flush();
  const original = JSON.parse(first.sent[0].init.body).records[0];
  assert.match(original.observationId, /^[a-f0-9]{32}$/); assert.equal(original.revision, 1);
  const second = setup({ load: async () => first.stored() }); await second.client.ready;
  await second.client.capture(record(31), 'private/device/shot-id'); await second.client.flush();
  const amended = JSON.parse(second.sent[0].init.body).records[0];
  assert.equal(amended.observationId, original.observationId); assert.equal(amended.revision, 2);
  assert.equal(JSON.stringify(amended).includes('private/device'), false);
});

test('amendments keep the newest revision when the private archive is older than transport state', async () => {
  const { client, sent } = setup(); await client.ready;
  await client.setSharing(true, 'https://collector.example.org/v1/events');
  const key = 'shot-with-private-archive';
  await client.capture(record(27), key); await client.flush();
  const original = JSON.parse(sent[0].init.body).records[0];
  await client.setLocalCollection(false);
  await client.capture(record(28), key); await client.capture(record(29), key);
  await client.flush();
  const corrected = JSON.parse(sent[1].init.body).records[0];
  assert.equal(corrected.observationId, original.observationId);
  assert.equal(corrected.revision, 3);
  assert.equal(corrected.measurements.pumpTimeSec, 29);
  await client.capture(record(27), key); await client.flush();
  const reverted = JSON.parse(sent[2].init.body).records[0];
  assert.equal(reverted.observationId, original.observationId);
  assert.equal(reverted.revision, 4);
});

test('coordinated browser clients reload before saving and cannot send after another tab deletes state', async () => {
  let stored = null; let lock = Promise.resolve(); const sent = [];
  const withLock = operation => {
    const previous = lock; let release;
    lock = new Promise(resolve => { release = resolve; });
    return previous.then(operation).finally(release);
  };
  const make = () => schema.createClient({
    load: async () => stored, reload: async () => stored,
    save: async value => { stored = structuredClone(value); }, withLock,
    send: async (url, init) => { sent.push({url, init}); return {ok: true, json: async () => ({accepted: 1})}; }
  });
  const first = make(), second = make(); await Promise.all([first.ready, second.ready]);
  await first.setSharing(true, 'https://collector.example.org/v1/events');
  await first.capture(record(), 'tab-a');
  await second.status(); // Simulate the stale tab observing the shared queue.
  await first.clear();
  await second.flush();
  assert.equal(sent.length, 0);
  assert.equal((await second.status()).sharing, false);
  assert.equal((await second.status()).queuedCount, 0);
});

test('a failed persistence cannot be undone by a refresh of the old opted-in state', async () => {
  const first = setup(); await first.client.ready;
  await first.client.setSharing(true, 'https://collector.example.org/v1/events');
  const persisted = first.stored();
  const sent = [];
  const client = schema.createClient({
    load: async () => persisted, reload: async () => persisted,
    save: async () => { throw new Error('disk full'); },
    send: async () => { sent.push(true); return {ok: true, json: async () => ({accepted: 1})}; }
  });
  await client.ready;
  await assert.rejects(client.capture(record(), 'failed-write'));
  assert.equal((await client.flush()).sent, 0);
  assert.equal(sent.length, 0);
  const status = await client.status();
  assert.equal(status.sharing, false);
  assert.match(status.error, /storage could not be saved/);
});

test('a pending opt-out cannot be undone by reload before a queued send', async () => {
  const shared = coordinated(); let sends = 0;
  const client = shared.make({ send: () => { sends++; return receipt; } });
  await client.setSharing(true, 'https://collector.example.org/v1/events');
  await client.capture(record(), 'shot');
  await Promise.all([client.flush(), client.setSharing(false)]);
  assert.equal(sends, 0); assert.equal(shared.stored().sharing, false);
});

test('ordinary local-only saves do not prevent observing another tab enabling sharing', async () => {
  const shared = coordinated(), first = shared.make(), second = shared.make();
  await first.capture(record(), 'local-only');
  await second.setSharing(true, 'https://collector.example.org/v1/events');
  await second.capture(record(28), 'second');
  assert.equal((await first.status()).sharing, true);
  await first.capture(record(29), 'first');
  assert.equal(shared.stored().sharing, true);
  assert.deepEqual(shared.stored().queue.map(item => item.key), ['second', 'first']);
});

test('concurrent tabs preserve each other\'s captures', async () => {
  const shared = coordinated(), first = shared.make(), second = shared.make();
  await first.setSharing(true, 'https://collector.example.org/v1/events');
  await Promise.all([first.capture(record(), 'first'), second.capture(record(28), 'second')]);
  assert.deepEqual(shared.stored().queue.map(item => item.key).sort(), ['first', 'second']);
  assert.deepEqual(shared.stored().queue.map(item => item.revision).sort(), [1, 2]);
});

test('request starts under the storage lock, before a deletion at lock release', { timeout: 2000 }, async () => {
  const shared = coordinated(), upload = deferred(), events = [];
  const second = shared.make(); let afterRelease = null;
  const first = shared.make({
    withLock: async operation => {
      const value = await shared.withLock(operation);
      const action = afterRelease; afterRelease = null;
      if (action) await action();
      return value;
    },
    send: () => { events.push('send'); assert.equal(shared.stored().sharing, true); return upload.promise; }
  });
  await first.setSharing(true, 'https://collector.example.org/v1/events');
  await first.capture(record(), 'shot');
  const deleted = deferred();
  afterRelease = async () => { await second.clear(); events.push('delete'); deleted.resolve(); };
  const sending = first.flush(); await deleted.promise;
  assert.deepEqual(events, ['send', 'delete']);
  assert.equal(shared.stored().sharing, false); assert.deepEqual(shared.stored().records, []);
  upload.resolve(receipt);
  assert.equal((await sending).sent, 0);
  assert.deepEqual(shared.stored().queue, []);
});

test('another tab can clear a stalled upload and a late receipt preserves reused revisions', { timeout: 2000 }, async () => {
  const shared = coordinated(), upload = deferred(), started = deferred();
  const first = shared.make({ send: () => { started.resolve(); return upload.promise; } }), second = shared.make();
  await first.setSharing(true, 'https://collector.example.org/v1/events');
  await first.capture(record(), 'shot');
  const old = shared.stored().queue[0];
  const sending = first.flush(); await started.promise;
  await second.clear();
  await second.setSharing(true, 'https://collector.example.org/v1/events');
  await second.capture(record(28), 'shot');
  const current = shared.stored().queue[0];
  assert.equal(current.revision, old.revision);
  assert.equal(current.record.revision, old.record.revision);
  assert.notEqual(current.record.observationId, old.record.observationId);
  upload.resolve(receipt); await sending;
  assert.deepEqual(shared.stored().queue, [current]);
});

test('another tab can revoke or change endpoint during a stalled upload', { timeout: 2000 }, async () => {
  for (const target of [null, 'https://replacement.example.org/v1/events']) {
    const shared = coordinated(), upload = deferred(), started = deferred();
    const first = shared.make({ send: () => { started.resolve(); return upload.promise; } }), second = shared.make();
    await first.setSharing(true, 'https://collector.example.org/v1/events');
    await first.capture(record(), 'shot');
    const sending = first.flush(); await started.promise;
    await second.setSharing(target !== null, target);
    if (target) await second.capture(record(29), 'shot');
    const beforeReceipt = shared.stored();
    upload.resolve(receipt); assert.equal((await sending).sent, 0);
    assert.deepEqual(shared.stored(), beforeReceipt);
  }
});

test('capture and receipt persistence always share one local serial queue', { timeout: 2000 }, async () => {
  let stored = null, delay = false;
  const pending = [], upload = deferred(), started = deferred(), sent = [];
  const client = schema.createClient({ load: async () => stored,
    save: value => {
      if (!delay) { stored = structuredClone(value); return; }
      return new Promise(resolve => pending.push(() => { stored = structuredClone(value); resolve(); }));
    },
    send: (_url, init) => { sent.push(JSON.parse(init.body)); started.resolve(); return upload.promise; }
  });
  await client.setSharing(true, 'https://collector.example.org/v1/events');
  await client.capture(record(), 'shot'); delay = true;
  const correction = client.capture(record(28), 'shot');
  await new Promise(setImmediate); assert.equal(pending.length, 1);
  const sending = client.flush(); await new Promise(setImmediate);
  assert.equal(sent.length, 0, 'send waits for capture storage acknowledgment');
  pending.shift()(); await correction; await started.promise;
  assert.equal(sent[0].records[0].measurements.pumpTimeSec, 28);
  const newer = client.capture(record(29), 'shot');
  await new Promise(setImmediate); assert.equal(pending.length, 1);
  upload.resolve(receipt); await new Promise(setImmediate);
  assert.equal(pending.length, 1, 'receipt cannot overlap an unacknowledged capture write');
  pending.shift()(); await newer; await sending;
  assert.equal(stored.queue.length, 1);
  assert.equal(stored.queue[0].record.measurements.pumpTimeSec, 29);
});

test('comparison approaches and random series retain scientific provenance but drop explanations', () => {
  const value = schema.sanitizeRecord({ ...record(), researchSeries: schema.randomId(), shotOrdinal: 2, taste: { good: false },
    approaches: [{ algorithm: 'native-response', status: 'collecting', coordinateStatus: 'estimated_relative', settingUnit: 'micrometres', proposedSetting: 60, explanation: 'secret bean' }] });
  assert.equal(value.taste.good, false); assert.equal(value.shotOrdinal, 2); assert.equal(value.approaches[0].status, 'collecting');
  assert.equal(value.approaches[0].coordinateStatus, 'estimated_relative');
  assert.equal(value.approaches[0].explanation, undefined); assert.match(value.researchSeries, /^[a-f0-9]{32}$/);
  assert.equal(schema.sanitizeRecord({ ...record(), researchSeries: 'private-bean-name', shotOrdinal: 2 }).shotOrdinal, undefined);
  assert.equal(schema.sanitizeRecord({ ...record(), advice: { algorithm: 'grindTime', status: 'computed' } }).advice.status, 'computed');
});
