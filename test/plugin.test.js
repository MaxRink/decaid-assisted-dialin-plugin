const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load({shots = [], stored = null, settings = {GrinderId: 'e64', GrinderModel: 'E64', BeanBatchId: 'batch-a', ProfileId: 'espresso'}, fetchImpl = null, writeFailures = 0} = {}) {
  const events = [];
  const host = {
    log: (message) => events.push(message),
    storage: (command) => {
      if (command.type === 'read') setTimeout(() => plugin.onEvent({name: 'storageRead', payload: {key: command.key, value: stored}}), 0);
      if (command.type === 'write' && writeFailures-- > 0) throw new Error('storage offline');
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
    observedAt: null, grinderState: 'running', observedRpm: null,
    reading: {kind: 'ddValueDum', value: 501}, coordinate: {value: 501, unit: 'deci-micrometre'}, surfaces: [],
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

test('a synchronously failing feedback write does not break later reads or writes', async () => {
  const {plugin} = load({shots: [shot('old', '2.0')], writeFailures: 1});
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal((await plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId: 'old', good: true}})).status, 503);
  const read = await plugin.handleHttpRequest({endpoint: 'recommendation', method: 'GET'});
  assert.equal(read.status, 200, read.body);
  assert.equal(JSON.parse(read.body).status, 'abstain', 'the failed mark must have been rolled back');
  assert.equal((await plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId: 'old', good: true}})).status, 200);
  assert.equal(JSON.parse((await plugin.handleHttpRequest({endpoint: 'recommendation', method: 'GET'})).body).sourceShotId, 'old');
});

test('recommendation picks the newest instant even when timestamp strings sort differently', async () => {
  // 03:00+02:00 is 01:00Z, an hour before 02:00Z, but sorts later as text.
  const older = {...shot('offset', '2.0'), timestamp: '2026-10-10T03:00:00+02:00'};
  const newer = {...shot('utc', '2.2'), timestamp: '2026-10-10T02:00:00Z'};
  const {plugin} = load({shots: [older, newer]});
  await new Promise((resolve) => setTimeout(resolve, 2));
  for (const id of ['offset', 'utc']) assert.equal((await plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId: id, good: true}})).status, 200);
  assert.equal(JSON.parse((await plugin.handleHttpRequest({endpoint: 'recommendation', method: 'GET'})).body).sourceShotId, 'utc');
});

test('state-changing requests from another site are refused without side effects', async () => {
  const {plugin, events} = load({shots: [shot('old', '2.0')]});
  await new Promise((resolve) => setTimeout(resolve, 2));
  const writes = () => events.filter((event) => event.stored).length;
  const lan = '192.168.1.5:8080';
  const crossSite = [
    {origin: 'https://other-site.example', host: lan},
    {Origin: 'https://OTHER-SITE.example', HOST: lan},
    {origin: 'null', host: lan},
    {origin: 'http://192.168.1.5.other-site.example:8080', host: lan},
    {origin: 'http://192.168.1.5:8080', host: 'other.local:8080, 192.168.1.5:8080'},
  ];
  const requests = [
    {endpoint: 'feedback', method: 'POST', body: {shotId: 'old', good: true}},
    {endpoint: 'grinders', method: 'POST', body: {operation: 'upsert', profile: {id: 'g'}}},
    {endpoint: 'grinders', method: 'DELETE', body: {id: 'g'}},
    {endpoint: 'settings', method: 'POST', body: {GrinderProfileId: 'g'}},
    {endpoint: 'sharing', method: 'POST', body: {sharing: true, endpoint: 'https://other-site.example/v1/events', acknowledgeHostLimits: true}},
    {endpoint: 'sharing', method: 'DELETE'},
  ];
  const before = writes();
  for (const headers of crossSite) for (const request of requests) {
    const response = await plugin.handleHttpRequest({...request, headers});
    assert.equal(response.status, 403, JSON.stringify([headers, request.endpoint]));
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(writes(), before, 'no storage write may happen');
  assert.equal(JSON.parse((await plugin.handleHttpRequest({endpoint: 'recommendation', method: 'GET'})).body).status, 'abstain');
  const sharing = JSON.parse((await plugin.handleHttpRequest({endpoint: 'sharing', method: 'GET', headers: crossSite[0]})).body);
  assert.equal(sharing.sharing, false);
  assert.equal(sharing.endpoint, null);
  assert.equal((await plugin.handleHttpRequest({endpoint: 'ui', method: 'GET', headers: crossSite[0]})).status, 200, 'reads stay available');

  // Same host on any port (a skin on :3000), IPv6 literals and clients without Origin are allowed.
  for (const headers of [{origin: 'http://192.168.1.5:8080', host: lan}, {origin: 'http://192.168.1.5:3000', host: lan}, {Origin: 'http://[::1]:3000', Host: '[::1]:8080'}, {}, undefined]) {
    const response = await plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId: 'old', good: true}, headers});
    assert.equal(response.status, 200, JSON.stringify(headers));
  }
  assert.equal(JSON.parse((await plugin.handleHttpRequest({endpoint: 'recommendation', method: 'GET'})).body).sourceShotId, 'old');
});

test('an undeclared GrinderRPM setting does not enter the current comparison context', async () => {
  const {plugin} = load({shots: [shot('old', '2.0')], settings: {GrinderId: 'e64', GrinderModel: 'E64', BeanBatchId: 'batch-a', ProfileId: 'espresso', GrinderRPM: 900}});
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal((await plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId: 'old', good: true}})).status, 200);
  const body = JSON.parse((await plugin.handleHttpRequest({endpoint: 'recommendation', method: 'GET'})).body);
  assert.equal(body.status, 'recommendation', JSON.stringify(body));
});

test('reloading the same plugin object restores feedback storage', async () => {
  const settings = {GrinderId: 'e64', GrinderModel: 'E64', BeanBatchId: 'batch-a', ProfileId: 'espresso'};
  const {plugin} = load({shots: [shot('old', '2.0')], settings});
  await new Promise((resolve) => setTimeout(resolve, 2));
  plugin.onUnload();
  plugin.onLoad(settings);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const saved = await plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId: 'old', good: true}});
  assert.equal(saved.status, 200, saved.body);
});

test('feedback requires a host-style shot ID', async () => {
  const {plugin} = load({shots: [shot('old', '2.0')]});
  await new Promise((resolve) => setTimeout(resolve, 2));
  for (const shotId of ['../old', 'a b', '-lead', 'x'.repeat(257), 'tab\tid', 'ä'])
    assert.equal((await plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId, good: true}})).status, 400, shotId);
  for (const shotId of ['3f2b1c9e-8d7a-4c1b-9e0f-1a2b3c4d5e6f', 'de1app-1700000000', 'x'.repeat(256)])
    assert.equal((await plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId, good: true}})).status, 200, shotId);
});

test('one damaged stored feedback entry is skipped and logged instead of disabling all feedback', async () => {
  const stored = {old: {good: true, updatedAt: '2026-10-10T03:00:00.000Z'}, broken: {good: 'yes'}, 'bad key': {good: true}};
  const {plugin, events} = load({shots: [shot('old', '2.0')], stored});
  await new Promise((resolve) => setTimeout(resolve, 2));
  const body = JSON.parse((await plugin.handleHttpRequest({endpoint: 'recommendation', method: 'GET'})).body);
  assert.equal(body.sourceShotId, 'old');
  assert.ok(events.some((event) => typeof event === 'string' && /skipped 2 invalid stored feedback/.test(event)));
});

test('feedback keeps at most 500 entries, evicting the least recently updated', async () => {
  const stored = {};
  for (let i = 0; i < 500; i++) stored['shot-' + i] = {good: false, updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()};
  const {plugin, events} = load({shots: [], stored});
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal((await plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId: 'shot-new', good: true}})).status, 200);
  const written = events.filter((event) => event.stored).at(-1).stored;
  assert.equal(Object.keys(written).length, 500);
  assert.equal(written['shot-0'], undefined, 'oldest entry evicted');
  assert.ok(written['shot-1'] && written['shot-new']);
});
