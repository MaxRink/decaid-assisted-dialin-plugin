const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { createCollector } = require('../collector/server.js');
const { createResearchSharing } = require('../research-sharing.js');
const record = createResearchSharing().sanitizeRecord({ source: 'website', mode: 'measured', kind: 'shot', observationId: 'a'.repeat(32), revision: 1, grinder: { model: 'DF54', setting: 12, settingUnit: 'dial-marks' }, measurements: { pumpTimeSec: 29 } });
const batch = () => ({ schemaVersion: 1, policyVersion: 1, records: [record] });
// Installation tokens are collector-issued in production; any 64-hex value is accepted.
const token = 'c'.repeat(64), otherToken = 'd'.repeat(64);
const withToken = (headers = {}) => ({ 'Content-Type': 'application/json', 'X-Research-Token': token, ...headers });
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dialin-research-test-'));
  const server = await createCollector({ directory, allowedOrigins: ['https://lab.example.org'], ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const post = (value = batch(), headers = {}) => fetch(url + '/v1/events', { method: 'POST', headers: withToken({ Origin: 'https://lab.example.org', ...headers }), body: JSON.stringify(value) });
  return { directory, server, url, post };
}

test('collector durably stores strict minimized payload, exposes no records endpoint or client metadata', async t => {
  const f = await fixture(t); const response = await f.post();
  assert.equal(response.status, 201); assert.deepEqual(await response.json(), { accepted: 1 });
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://lab.example.org');
  assert.equal(response.headers.get('set-cookie'), null);
  const names = await fs.readdir(f.directory); assert.equal(names.length, 1);
  const value = JSON.parse(await fs.readFile(path.join(f.directory, names[0]), 'utf8'));
  const { owner, ...stored } = value;
  assert.deepEqual(stored, batch()); assert.match(owner, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(value).includes(token), false, 'the bearer token itself is never stored');
  assert.equal(JSON.stringify(value).includes('127.0.0.1'), false);
  assert.equal((await fs.stat(path.join(f.directory, names[0]))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await fetch(f.url + '/v1/events')).status, 405);
  assert.equal((await fetch(f.url + '/' + names[0])).status, 404);
});

test('unknown/free-text fields, excessive precision, unsupported versions and oversized batches reject without disk write', async t => {
  const f = await fixture(t);
  for (const value of [
    { ...batch(), token: 'secret' },
    { ...batch(), records: [{ ...record, coffee: { name: 'private coffee' } }] },
    { ...batch(), records: [{ ...record, measurements: { pumpTimeSec: 29.123456 } }] },
    { ...batch(), policyVersion: 99 },
    { ...batch(), records: Array(26).fill(record) },
  ]) assert.equal((await f.post(value)).status, 400);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('browser origins and credentialless preflight are exact; credentials, compression and oversized bodies reject', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(batch(), { Origin: 'https://evil.example.org' })).status, 403);
  assert.equal((await f.post(batch(), { Cookie: 'session=private' })).status, 400);
  assert.equal((await f.post(batch(), { Authorization: 'Bearer private' })).status, 400);
  assert.equal((await f.post(batch(), { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await f.post({ data: 'x'.repeat(65537) })).status, 413);
  const preflight = await fetch(f.url + '/v1/events', { method: 'OPTIONS', headers: { Origin: 'https://lab.example.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-research-token' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  const invalid = await fetch(f.url + '/v1/events', { method: 'OPTIONS', headers: { Origin: 'https://lab.example.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(invalid.status, 403);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('request rate and storage budgets bound ingestion', async t => {
  const limited = await fixture(t, { perMinute: 1 }); assert.equal((await limited.post()).status, 201); assert.equal((await limited.post()).status, 429);
  const capped = await fixture(t, { maxStorageBytes: 1024 });
  const large = { ...batch(), records: Array.from({ length: 25 }, (_, i) => ({ ...record, observationId: i.toString(16).padStart(32, '0') })) };
  assert.equal((await capped.post(large)).status, 507); assert.ok((await fs.readdir(capped.directory)).length < 25); // A partial batch is safely retried by observation ID.
});

test('collector validates and applies the public ingestion connection cap', async t => {
  const f = await fixture(t, { maxConnections: 3 });
  assert.equal(f.server.maxConnections, 3);
  const invalidLow = await fs.mkdtemp(path.join(os.tmpdir(), 'dialin-invalid-cap-'));
  const invalidHigh = await fs.mkdtemp(path.join(os.tmpdir(), 'dialin-invalid-cap-'));
  t.after(() => Promise.all([fs.rm(invalidLow, { recursive: true, force: true }), fs.rm(invalidHigh, { recursive: true, force: true })]));
  await assert.rejects(() => createCollector({ directory: invalidLow, maxConnections: 0 }));
  await assert.rejects(() => createCollector({ directory: invalidHigh, maxConnections: 10001 }));
});

test('retention removes only aged collector-owned files and never serves or deletes unrelated files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dialin-retention-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const oldFile = path.join(directory, 'research-' + 'a'.repeat(32) + '.json');
  await fs.writeFile(oldFile, JSON.stringify(batch())); await fs.utimes(oldFile, new Date(1), new Date(1));
  await fs.writeFile(path.join(directory, 'owner-notes.txt'), 'preserve');
  const server = await createCollector({ directory, now: () => 40 * 86400000, retentionDays: 30 });
  server.close(); assert.deepEqual(await fs.readdir(directory), ['owner-notes.txt']);
});

test('invalid wildcard origin and symbolic-link storage directories reject', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'dialin-links-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await assert.rejects(createCollector({ directory: path.join(parent, 'data'), allowedOrigins: ['*'] }));
  await fs.mkdir(path.join(parent, 'target')); await fs.symlink(path.join(parent, 'target'), path.join(parent, 'link'));
  await assert.rejects(createCollector({ directory: path.join(parent, 'link') }));
});


test('lost acknowledgments, stale revisions and corrected feedback keep one observation across restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.post()).status, 201);
  assert.equal((await f.post()).status, 201);
  const corrected = { ...record, revision: 2, taste: { good: true } };
  assert.equal((await f.post({ ...batch(), records: [corrected] })).status, 201);
  assert.equal((await f.post()).status, 201);
  const names = await fs.readdir(f.directory); assert.equal(names.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, names[0]), 'utf8')).records[0], corrected);
  await new Promise(resolve => f.server.close(resolve));
  const restarted = await createCollector({ directory: f.directory, allowedOrigins: ['https://lab.example.org'] });
  restarted.listen(0, '127.0.0.1'); await once(restarted, 'listening');
  t.after(() => new Promise(resolve => restarted.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + restarted.address().port + '/v1/events', { method: 'POST', headers: withToken(), body: JSON.stringify(batch()) });
  assert.equal(response.status, 201);
  assert.equal((await fs.readdir(f.directory)).length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, names[0]), 'utf8')).records[0].revision, 2);
});

test('observation count cap rejects new keys but permits corrections and retry at capacity', async t => {
  const f = await fixture(t, { maxRecords: 1 });
  assert.equal((await f.post()).status, 201);
  const another = { ...record, observationId: 'b'.repeat(32) };
  assert.equal((await f.post({ ...batch(), records: [another] })).status, 507);
  const correction = { ...record, revision: 2, taste: { good: true } };
  assert.equal((await f.post({ ...batch(), records: [correction] })).status, 201);
  assert.equal((await f.post()).status, 201);
  const names = await fs.readdir(f.directory); assert.equal(names.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, names[0]), 'utf8')).records[0].revision, 2);
});

test('legacy over-cap directory starts, permits updates and recovers when retention prunes it', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dialin-overcap-test-'));
  let clock = Date.now();
  const values = ['a', 'b', 'c'].map(id => ({ ...record, observationId: id.repeat(32) }));
  for (const value of values) await fs.writeFile(path.join(directory, 'research-' + value.observationId + '.json'), JSON.stringify({ ...batch(), records: [value] }));
  await fs.writeFile(path.join(directory, 'owner-notes.txt'), 'preserve');
  const server = await createCollector({ directory, maxRecords: 1, retentionDays: 1, now: () => clock });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const post = value => fetch('http://127.0.0.1:' + server.address().port + '/v1/events', { method: 'POST', headers: withToken(), body: JSON.stringify({ ...batch(), records: [value] }) });
  const fresh = { ...record, observationId: 'd'.repeat(32) };
  assert.equal((await post(fresh)).status, 507);
  assert.equal((await post({ ...values[0], revision: 2 })).status, 201);
  clock += 2 * 86400000;
  assert.equal((await post(fresh)).status, 201);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['owner-notes.txt', 'research-' + fresh.observationId + '.json']);
});

test('directory-sync failure withholds acknowledgment and a retry must complete the sync', async t => {
  const f = await fixture(t);
  const originalOpen = fs.open; let fail = true, directorySyncs = 0;
  t.mock.method(fs, 'open', async (name, ...args) => {
    const handle = await originalOpen(name, ...args);
    if (name !== f.directory) return handle;
    return { close: () => handle.close(), sync: async () => {
      directorySyncs++; if (fail) throw new Error('simulated directory sync failure'); await handle.sync();
    } };
  });
  assert.equal((await f.post()).status, 503);
  assert.equal((await fs.readdir(f.directory)).length, 1);
  fail = false;
  assert.equal((await f.post()).status, 201);
  assert.equal(directorySyncs, 2);
  assert.equal((await fs.readdir(f.directory)).length, 1);
});

test('incomplete headers and bodies expire within their configured request deadlines', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const incomplete = request => new Promise((resolve, reject) => {
    const socket = net.connect(f.server.address().port, '127.0.0.1');
    let response = '';
    const deadline = setTimeout(() => { socket.destroy(); reject(new Error('Incomplete request remained open beyond 11.5 seconds')); }, 11500);
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => { response += chunk; });
    socket.on('error', reject);
    socket.on('close', () => { clearTimeout(deadline); resolve(response); });
  });
  const responses = await Promise.all([
    incomplete('POST /v1/events HTTP/1.1\r\nHost: localhost\r\n'),
    incomplete('POST /v1/events HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{'),
  ]);
  for (const response of responses) assert.match(response, /^HTTP\/1\.1 408 /);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('enrolment issues random installation tokens and stores nothing; uploads require one', async t => {
  const f = await fixture(t);
  const enrol = () => fetch(f.url + '/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://lab.example.org' }, body: JSON.stringify({ schemaVersion: 1, policyVersion: 1, enrol: true }) });
  const [a, b] = await Promise.all([enrol(), enrol()]);
  assert.equal(a.status, 201); const first = (await a.json()).token, second = (await b.json()).token;
  assert.match(first, /^[a-f0-9]{64}$/); assert.notEqual(first, second);
  assert.deepEqual(await fs.readdir(f.directory), []);
  const tokenless = await fetch(f.url + '/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch()) });
  assert.equal(tokenless.status, 401); assert.equal((await tokenless.json()).code, 'enrolment_required');
  assert.equal((await f.post(batch(), { 'X-Research-Token': 'not-a-token' })).status, 401);
  assert.deepEqual(await fs.readdir(f.directory), []);
  assert.equal((await f.post(batch(), { 'X-Research-Token': first })).status, 201);
});

test('another installation cannot overwrite an observation it did not create', async t => {
  const f = await fixture(t);
  assert.equal((await f.post()).status, 201);
  const hijack = { ...batch(), records: [{ ...record, revision: 9, taste: { good: false } }] };
  const refused = await f.post(hijack, { 'X-Research-Token': otherToken });
  assert.equal(refused.status, 403); assert.equal((await refused.json()).code, 'observation_owned');
  const names = await fs.readdir(f.directory);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, names[0]), 'utf8')).records[0].revision, 1);
  assert.equal((await f.post({ ...batch(), records: [{ ...record, revision: 2 }] })).status, 201, 'the owner can still correct it');
});

test('a record stored before enrolment is claimed by its first enrolled writer', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dialin-legacy-owner-'));
  await fs.writeFile(path.join(directory, 'research-' + record.observationId + '.json'), JSON.stringify(batch()));
  const server = await createCollector({ directory });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const post = (value, key) => fetch('http://127.0.0.1:' + server.address().port + '/v1/events', { method: 'POST', headers: withToken({ 'X-Research-Token': key }), body: JSON.stringify({ ...batch(), records: [value] }) });
  assert.equal((await post({ ...record, revision: 2 }, token)).status, 201);
  assert.equal((await post({ ...record, revision: 3 }, otherToken)).status, 403);
});

test('rate limits use the client address only when a trusted proxy supplies it', async t => {
  const proxied = await fixture(t, { perMinute: 1, trustedProxies: ['127.0.0.1'] });
  const via = (f, client) => f.post(batch(), { 'X-Forwarded-For': client });
  assert.equal((await via(proxied, '198.51.100.1')).status, 201);
  assert.equal((await via(proxied, '198.51.100.1')).status, 429);
  assert.equal((await via(proxied, '203.0.113.9, 198.51.100.2')).status, 201, 'the proxy-appended last entry identifies the client');
  const direct = await fixture(t, { perMinute: 1 });
  assert.equal((await via(direct, '198.51.100.1')).status, 201);
  assert.equal((await via(direct, '198.51.100.2')).status, 429, 'an untrusted peer cannot choose its address');
  await assert.rejects(() => createCollector({ directory: direct.directory, trustedProxies: ['collector-proxy'] }));
});

test('a full client table evicts its oldest window instead of refusing new clients', async t => {
  const f = await fixture(t, { perMinute: 1, trustedProxies: ['127.0.0.1'], maxTrackedClients: 2 });
  for (const client of ['198.51.100.1', '198.51.100.2', '198.51.100.3'])
    assert.equal((await f.post(batch(), { 'X-Forwarded-For': client })).status, 201, client);
});

test('startup skips and logs invalid stored files instead of failing', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dialin-invalid-stored-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'research-' + 'a'.repeat(32) + '.json'), JSON.stringify(batch()));
  await fs.writeFile(path.join(directory, 'research-' + 'b'.repeat(32) + '.json'), '{"private": "not json');
  await fs.writeFile(path.join(directory, 'research-' + 'e'.repeat(32) + '.json'), JSON.stringify(batch()));
  const logs = [];
  const server = await createCollector({ directory, metricsEnabled: true, log: message => logs.push(message) });
  server.close(); server.metricsServer.close();
  assert.equal(logs.length, 2);
  assert.ok(logs.some(message => message.includes('research-' + 'b'.repeat(32))));
  assert.equal(logs.join().includes('private'), false, 'logs never echo stored contents');
});
