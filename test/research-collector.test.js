const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createCollector } = require('../collector/server.js');
const { createResearchSharing } = require('../research-sharing.js');
const record = createResearchSharing().sanitizeRecord({ source: 'website', mode: 'measured', kind: 'shot', observationId: 'a'.repeat(32), revision: 1, grinder: { model: 'DF54', setting: 12, settingUnit: 'dial-marks' }, measurements: { pumpTimeSec: 29 } });
const batch = () => ({ schemaVersion: 1, policyVersion: 1, records: [record] });
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dialin-research-test-'));
  const server = await createCollector({ directory, allowedOrigins: ['https://lab.example.org'], ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const post = (value = batch(), headers = {}) => fetch(url + '/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://lab.example.org', ...headers }, body: JSON.stringify(value) });
  return { directory, server, url, post };
}

test('collector durably stores strict minimized payload, exposes no records endpoint or client metadata', async t => {
  const f = await fixture(t); const response = await f.post();
  assert.equal(response.status, 201); assert.deepEqual(await response.json(), { accepted: 1 });
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://lab.example.org');
  assert.equal(response.headers.get('set-cookie'), null);
  const names = await fs.readdir(f.directory); assert.equal(names.length, 1);
  const value = JSON.parse(await fs.readFile(path.join(f.directory, names[0]), 'utf8'));
  assert.deepEqual(value, batch()); assert.equal(JSON.stringify(value).includes('127.0.0.1'), false);
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
  const preflight = await fetch(f.url + '/v1/events', { method: 'OPTIONS', headers: { Origin: 'https://lab.example.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
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
  const response = await fetch('http://127.0.0.1:' + restarted.address().port + '/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch()) });
  assert.equal(response.status, 201);
  assert.equal((await fs.readdir(f.directory)).length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, names[0]), 'utf8')).records[0].revision, 2);
});
