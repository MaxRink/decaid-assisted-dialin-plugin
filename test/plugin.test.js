const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load({shots = [], stored = null, settings = {GrinderId: 'e64', GrinderModel: 'E64', BeanBatchId: 'batch-a', ProfileId: 'espresso'}, fetchImpl = null} = {}) {
  const events = [];
  const host = {
    log: (message) => events.push(message),
    storage: (command) => {
      if (command.type === 'read') setTimeout(() => plugin.onEvent({name: 'storageRead', payload: {key: command.key, value: stored}}), 0);
      if (command.type === 'write') { events.push({stored: command.data}); setTimeout(() => plugin.onEvent({name: 'storageWrite', payload: command.data}), 0); }
    },
  };
  let plugin;
  const source = fs.readFileSync('plugin.js', 'utf8');
  const fetchStub = fetchImpl || (async (url) => url.includes('/workflow')
    ? {ok: true, status: 200, json: async () => ({context: {beanBatchId: settings.BeanBatchId, grinderId: settings.GrinderId, grinderModel: settings.GrinderModel}, profile: {title: settings.ProfileId, steps: [{pump: 'pressure', pressure: 9}]}})}
    : {ok: true, status: 200, json: async () => ({items: shots, total: shots.length})});
  const context = {console, setTimeout, clearTimeout, Date, JSON, Math, Promise, URLSearchParams, fetch: fetchStub, btoa: (s) => Buffer.from(s).toString('base64')};
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  plugin = context.createPlugin(host);
  plugin.onLoad(settings);
  return {plugin, events};
}

const shot = (id, setting, extra = {}) => ({id, timestamp: id === 'new' ? '2026-10-10T02:00:00Z' : '2026-10-10T01:00:00Z', workflow: {context: {beanBatchId: 'batch-a', grinderId: 'e64', grinderModel: 'E64', grinderSetting: setting, ...extra}, profile: {title: 'espresso', steps: [{pump: 'pressure', pressure: 9}]}}});

test('marks feedback and recommends newest comparable shot', async () => {
  const {plugin, events} = load({shots: [shot('old', '2.0'), shot('new', '2.2')]});
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal((await plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId: 'old', good: true, notes: 'sweet'}})).status, 200);
  assert.equal((await plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId: 'new', good: true}})).status, 200);
  const response = await plugin.handleHttpRequest({endpoint: 'recommendation', method: 'GET'});
  const result = JSON.parse(response.body);
  assert.equal(result.status, 'recommendation');
  assert.equal(result.sourceShotId, 'new');
  assert.ok(events.some((event) => event.stored));
});

test('abstains when current identity is incomplete or shot data differs', async () => {
  const incomplete = load({shots: [shot('old', '2.0')], settings: {BeanBatchId: 'batch-a'}});
  await new Promise((resolve) => setTimeout(resolve, 2));
  await incomplete.plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId: 'old', good: true}});
  assert.equal(JSON.parse((await incomplete.plugin.handleHttpRequest({endpoint: 'recommendation', method: 'GET'})).body).status, 'abstain');
  const changed = load({shots: [shot('old', '2.0', {beanBatchId: 'other'})]});
  await new Promise((resolve) => setTimeout(resolve, 2));
  await changed.plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId: 'old', good: true}});
  assert.equal(JSON.parse((await changed.plugin.handleHttpRequest({endpoint: 'recommendation', method: 'GET'})).body).status, 'abstain');
});

test('serves HTML and rejects malformed feedback', async () => {
  const {plugin} = load();
  assert.match((await plugin.handleHttpRequest({endpoint: 'ui', method: 'GET'})).body, /Assisted dial-in/);
  assert.equal((await plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: '{}'})).status, 400);
});

test('numeric host settings strings can supply missing current dose and yield', async () => {
  const {plugin} = load({shots: [shot('old', '2.0', {targetDoseWeight: 18, targetYield: 36})], stored: {old: {good: true}}, settings: {GrinderId: 'e64', GrinderModel: 'E64', BeanBatchId: 'batch-a', ProfileId: 'espresso', Dose: '18', Yield: '36'}});
  const response = await plugin.handleHttpRequest({endpoint: 'recommendation', method: 'GET'});
  const body = JSON.parse(response.body);
  assert.equal(body.status, 'recommendation');
  assert.deepEqual(body.comparison.userSuppliedCurrentFields.filter(key => key === 'dose' || key === 'yield').sort(), ['dose', 'yield']);
});

test('runtime plugin version matches the install manifest', () => {
  const {plugin} = load();
  assert.equal(plugin.version, JSON.parse(fs.readFileSync('manifest.json', 'utf8')).version);
  plugin.onUnload();
});

test('manifest registers the live grinder observation endpoint', () => {
  const ids = JSON.parse(fs.readFileSync('manifest.json', 'utf8')).api.map(item => item.id);
  assert.ok(ids.includes('grinder-observation'));
});

test('exposes a healthy grinder observation as opaque live provenance', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/grinder/info')) return {ok: true, status: 200, json: async () => ({observations: ['setting'], capabilities: []})};
    if (url.endsWith('/grinder/state')) return {ok: true, status: 200, json: async () => ({state: 'running', observedSetting: '501 ddValueDum'})};
    return {ok: false, status: 404, json: async () => ({})};
  };
  const {plugin} = load({fetchImpl});
  const body = JSON.parse((await plugin.handleHttpRequest({endpoint: 'grinder-observation', method: 'GET'})).body);
  assert.deepEqual(body, {
    status: 'available', setting: '501 ddValueDum', unit: 'opaque', verified: false,
    source: 'decaid-grinder-observation',
    provenance: 'Live read-only grinder display observation. The value is opaque and is not a micron conversion, verified shot setting, or automatic control command.',
  });
});

test('does not expose a failed or malformed grinder observation', async () => {
  const fetchImpl = async (url) => url.endsWith('/grinder/info')
    ? {ok: true, status: 200, json: async () => ({observations: ['setting']})}
    : {ok: true, status: 200, json: async () => ({state: 'running'})};
  const {plugin} = load({fetchImpl});
  const body = JSON.parse((await plugin.handleHttpRequest({endpoint: 'grinder-observation', method: 'GET'})).body);
  assert.equal(body.status, 'unavailable');
  assert.match(body.reason, /sensor/);
});
