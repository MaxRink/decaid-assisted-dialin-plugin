const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load({shots = [], stored = null, settings = {GrinderId: 'e64', GrinderModel: 'E64', BeanBatchId: 'batch-a', ProfileId: 'espresso'}} = {}) {
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
  const fetchStub = async (url) => ({ok: true, status: 200, json: async () => ({items: shots, total: shots.length})});
  const context = {console, setTimeout, clearTimeout, Date, JSON, Math, Promise, URLSearchParams, fetch: fetchStub, btoa: (s) => Buffer.from(s).toString('base64')};
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  plugin = context.createPlugin(host);
  plugin.onLoad(settings);
  return {plugin, events};
}

const shot = (id, setting, extra = {}) => ({id, timestamp: id === 'new' ? '2026-10-10T02:00:00Z' : '2026-10-10T01:00:00Z', workflow: {context: {beanBatchId: 'batch-a', grinderId: 'e64', grinderModel: 'E64', grinderSetting: setting, ...extra}, profile: {title: 'espresso'}}});

test('marks feedback and recommends newest comparable shot', async () => {
  const {plugin, events} = load({shots: [shot('old', '2.0'), shot('new', '2.2')]});
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal((await plugin.__httpRequestHandler({endpoint: 'feedback', method: 'POST', body: {shotId: 'old', good: true, notes: 'sweet'}})).status, 200);
  assert.equal((await plugin.__httpRequestHandler({endpoint: 'feedback', method: 'POST', body: {shotId: 'new', good: true}})).status, 200);
  const response = await plugin.__httpRequestHandler({endpoint: 'recommendation', method: 'GET'});
  const result = JSON.parse(response.body);
  assert.equal(result.status, 'recommendation');
  assert.equal(result.sourceShotId, 'new');
  assert.ok(events.some((event) => event.stored));
});

test('abstains when current identity is incomplete or shot data differs', async () => {
  const incomplete = load({shots: [shot('old', '2.0')], settings: {BeanBatchId: 'batch-a'}});
  await new Promise((resolve) => setTimeout(resolve, 2));
  await incomplete.plugin.__httpRequestHandler({endpoint: 'feedback', method: 'POST', body: {shotId: 'old', good: true}});
  assert.equal(JSON.parse((await incomplete.plugin.__httpRequestHandler({endpoint: 'recommendation', method: 'GET'})).body).status, 'abstain');
  const changed = load({shots: [shot('old', '2.0', {beanBatchId: 'other'})]});
  await new Promise((resolve) => setTimeout(resolve, 2));
  await changed.plugin.__httpRequestHandler({endpoint: 'feedback', method: 'POST', body: {shotId: 'old', good: true}});
  assert.equal(JSON.parse((await changed.plugin.__httpRequestHandler({endpoint: 'recommendation', method: 'GET'})).body).status, 'abstain');
});

test('serves HTML and rejects malformed feedback', async () => {
  const {plugin} = load();
  assert.match((await plugin.__httpRequestHandler({endpoint: 'ui', method: 'GET'})).body, /Assisted dial-in/);
  assert.equal((await plugin.__httpRequestHandler({endpoint: 'feedback', method: 'POST', body: '{}'})).status, 400);
});
