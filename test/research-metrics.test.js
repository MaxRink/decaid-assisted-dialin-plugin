const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { createCollector } = require('../collector/server.js');
const { createResearchSharing } = require('../research-sharing.js');
const schema = createResearchSharing();
const record = (extra = {}) => schema.sanitizeRecord({ source: 'website', mode: 'manual', kind: 'shot', observationId: 'a'.repeat(32), revision: 1,
  researchSeries: 'b'.repeat(32), shotOrdinal: 1, grinder: { model: 'DF54', settingUnit: 'dial-marks', setting: 12 },
  measurements: { pumpTimeSec: 25, doseG: 18, yieldG: 36, meanMixTemperatureC: 93 }, taste: { good: true, intent: 'balanced' },
  advice: { algorithm: 'manual', direction: 'none', status: 'retained', coordinateStatus: 'native', settingUnit: 'dial-marks', proposedSetting: 12 }, ...extra });
const batch = records => ({ schemaVersion: 1, policyVersion: 1, records });
function parse(text) {
  const samples = [], types = new Map();
  assert.ok(text.endsWith('\n'));
  for (const line of text.trim().split('\n')) {
    if (line.startsWith('# TYPE ')) { const [, , name, type] = line.split(' '); assert.equal(type, 'gauge'); types.set(name, type); continue; }
    if (line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (-?(?:\d+(?:\.\d+)?)(?:e[+-]?\d+)?)$/.exec(line);
    assert.ok(match, 'valid Prometheus sample: ' + line); assert.ok(types.has(match[1]));
    const labels = {};
    for (const item of (match[2] || '').matchAll(/([a-z_]+)=("(?:[^"\\]|\\.)*")/g)) labels[item[1]] = JSON.parse(item[2]);
    samples.push({ name: match[1], labels, value: Number(match[3]) });
  }
  assert.equal(new Set(samples.map(s => s.name + JSON.stringify(s.labels))).size, samples.length);
  return samples;
}
function sum(samples, name, labels = {}) { return samples.filter(s => s.name === name && Object.entries(labels).every(([k,v]) => s.labels[k] === v)).reduce((a,s) => a + s.value, 0); }
async function fixture(t, options = {}) {
  const directory = options.directory || await fs.mkdtemp(path.join(os.tmpdir(), 'research-metrics-'));
  const server = await createCollector({ directory, metricsEnabled: true, ...options });
  server.listen(0, '127.0.0.1'); server.metricsServer.listen(0, '127.0.0.1');
  await Promise.all([once(server, 'listening'), once(server.metricsServer, 'listening')]);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const metricsUrl = 'http://127.0.0.1:' + server.metricsServer.address().port;
  return { directory, server, url, metricsUrl, post: records => fetch(url + '/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch(records)) }),
    scrape: async () => { const response = await fetch(metricsUrl + '/metrics'); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /version=0.0.4/); return parse(await response.text()); } };
}

test('private metrics describe actual measurements, units, tastes and algorithm results without record keys', async t => {
  const f = await fixture(t);
  const input = record({ approaches: [
    { algorithm: 'GbS1', status: 'suggestion', direction: 'finer', coordinateStatus: 'estimated_relative', settingUnit: 'dial-marks', proposedSetting: 11 },
    { algorithm: 'grindTime', status: 'computed', coordinateStatus: 'unknown' }
  ] });
  assert.equal((await f.post([input])).status, 201);
  const samples = await f.scrape();
  assert.equal(sum(samples, 'decaid_research_retained_records'), 1);
  assert.equal(sum(samples, 'decaid_research_measurement_sum', { quantity: 'pump_time_seconds', model: 'DF54', mode: 'manual' }), 25);
  assert.equal(sum(samples, 'decaid_research_distribution_bucket', { quantity: 'pump_time_seconds', le: '20' }), 0);
  assert.equal(sum(samples, 'decaid_research_distribution_bucket', { quantity: 'pump_time_seconds', le: '25' }), 1);
  assert.equal(sum(samples, 'decaid_research_distribution_bucket', { quantity: 'pump_time_seconds', le: '+Inf' }), 1);
  assert.equal(sum(samples, 'decaid_research_approaches', { algorithm: 'grindTime', status: 'computed' }), 1);
  assert.equal(sum(samples, 'decaid_research_recommendation_delta_sum', { algorithm: 'GbS1', unit: 'dial-marks', coordinate_status: 'estimated_relative' }), -1);
  assert.equal(sum(samples, 'decaid_research_categories', { field: 'taste_good', value: 'true' }), 1);
  const body = await (await fetch(f.metricsUrl + '/metrics')).text();
  for (const secret of [input.observationId, input.researchSeries, 'observationId', 'researchSeries', 'shotOrdinal', 'revision', '127.0.0.1']) assert.equal(body.includes(secret), false);
  assert.equal((await fetch(f.url + '/metrics')).status, 404);
  assert.equal((await fetch(f.metricsUrl + '/metrics', { headers: { Origin: 'https://example.org' } })).status, 403);
  assert.equal((await fetch(f.metricsUrl + '/v1/events')).status, 404);
});

test('retry and corrections update snapshot gauges once and restart reconstructs the same values', async t => {
  const f = await fixture(t);
  await f.post([record()]); await f.post([record()]);
  const correction = record({ revision: 2, measurements: { pumpTimeSec: 35, meanMachineFlowMlPerSec: 0 }, taste: { good: false }, advice: { algorithm: 'manual', status: 'hold' } });
  await f.post([correction]); await f.post([record()]);
  const samples = await f.scrape();
  assert.equal(sum(samples, 'decaid_research_retained_records'), 1);
  assert.equal(sum(samples, 'decaid_research_measurement_sum', { quantity: 'pump_time_seconds' }), 35);
  assert.equal(sum(samples, 'decaid_research_measurement_count', { quantity: 'pump_time_seconds' }), 1);
  assert.equal(sum(samples, 'decaid_research_categories', { field: 'taste_good', value: 'true' }), 0);
  assert.equal(sum(samples, 'decaid_research_categories', { field: 'taste_good', value: 'false' }), 1);
  assert.ok(samples.some(s => s.name === 'decaid_research_measurement_sum' && s.labels.quantity === 'machine_flow_ml_per_second' && s.value === 0));
  const restarted = await createCollector({ directory: f.directory, metricsEnabled: true });
  restarted.metricsServer.listen(0, '127.0.0.1'); await once(restarted.metricsServer, 'listening');
  t.after(() => new Promise(resolve => restarted.metricsServer.close(resolve)));
  const restored = parse(await (await fetch('http://127.0.0.1:' + restarted.metricsServer.address().port + '/metrics')).text());
  // Removed zero-sum families need not persist across reconstruction; every live value must match.
  assert.deepEqual(restored.filter(s => s.value !== 0), samples.filter(s => s.value !== 0));
});

test('retention rebuild removes expired distributions and never merges fictional practice with manual evidence', async t => {
  let clock = Date.now(); const f = await fixture(t, { retentionDays: 1, now: () => clock });
  await f.post([record(), record({ observationId: 'c'.repeat(32), mode: 'practice', measurements: { pumpTimeSec: 50 } })]);
  let samples = await f.scrape();
  assert.equal(sum(samples, 'decaid_research_measurement_sum', { quantity: 'pump_time_seconds', mode: 'manual' }), 25);
  assert.equal(sum(samples, 'decaid_research_measurement_sum', { quantity: 'pump_time_seconds', mode: 'practice' }), 50);
  clock += 2 * 86400000;
  await f.post([record({ observationId: 'd'.repeat(32), measurements: { pumpTimeSec: 40 } })]);
  samples = await f.scrape();
  assert.equal(sum(samples, 'decaid_research_retained_records'), 1);
  assert.equal(sum(samples, 'decaid_research_measurement_count', { mode: 'practice' }), 0);
  assert.equal(sum(samples, 'decaid_research_measurement_sum', { quantity: 'pump_time_seconds' }), 40);
});

test('metrics are disabled by default and repeated scrapes do not reread retained records', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'metrics-disabled-'));
  const disabled = await createCollector({ directory }); assert.equal(disabled.metricsServer, undefined);
  disabled.close(); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const f = await fixture(t); await f.post([record()]);
  const open = fs.readFile; let reads = 0;
  t.mock.method(fs, 'readFile', (...args) => { reads++; return open(...args); });
  await f.scrape(); await f.scrape(); await f.scrape();
  assert.equal(reads, 0);
});

test('single-observation corrections discard historical sum and distribution label groups', async t => {
  const f = await fixture(t, { maxRecords: 1 });
  for (let revision = 1; revision <= 12; revision++) {
    const current = record({ revision, mode: revision % 2 ? 'manual' : 'practice',
      grinder: { model: revision % 3 ? 'DF54' : 'E64 WS', setting: 0, settingUnit: revision % 3 ? 'dial-marks' : 'micrometres' },
      measurements: { pumpTimeSec: revision % 2 ? 25 : 35, yieldG: 0 } });
    assert.equal((await f.post([current])).status, 201);
  }
  const samples = await f.scrape();
  assert.equal(sum(samples, 'decaid_research_retained_records'), 1);
  const sums = samples.filter(s => s.name.endsWith('_sum'));
  assert.ok(sums.every(s => s.labels.mode === 'practice'));
  assert.ok(sums.filter(s => s.labels.model).every(s => s.labels.model === 'E64 WS'));
  assert.ok(samples.some(s => s.name === 'decaid_research_distribution_bucket' && s.labels.quantity === 'pump_time_seconds' && s.labels.le === '30' && s.value === 0));
  assert.equal(samples.filter(s => s.name === 'decaid_research_distribution_bucket' && s.labels.quantity === 'pump_time_seconds').length, 10);
});

test('series budget withholds the whole research snapshot instead of growing memory or publishing partial results', () => {
  const { createResearchMetrics } = require('../collector/metrics.js');
  const bounded = createResearchMetrics(20);
  bounded.observe(record(), 1);
  const samples = parse(bounded.render({count:1,bytes:100,maxRecords:100,maxStorageBytes:1000}));
  assert.equal(sum(samples, 'decaid_research_metrics_available'), 0);
  assert.equal(sum(samples, 'decaid_research_retained_records'), 1);
  assert.equal(samples.some(s => s.name === 'decaid_research_measurement_sum'), false);
  for (let index = 0; index < 100; index++) bounded.observe(record({revision:index+2}), 1);
  assert.deepEqual(parse(bounded.render({count:1,bytes:100,maxRecords:100,maxStorageBytes:1000})), samples);
  const rebuilt = createResearchMetrics(20);
  rebuilt.observe(schema.sanitizeRecord({ source:'website', mode:'manual', kind:'shot', observationId:'a'.repeat(32), revision:2, measurements:{meanMachineFlowMlPerSec:0} }), 1);
  const restored = parse(rebuilt.render({count:1,bytes:100,maxRecords:100,maxStorageBytes:1000}));
  assert.equal(sum(restored, 'decaid_research_metrics_available'), 1);
  assert.equal(sum(restored, 'decaid_research_measurement_count', {quantity:'machine_flow_ml_per_second'}), 1);
});
