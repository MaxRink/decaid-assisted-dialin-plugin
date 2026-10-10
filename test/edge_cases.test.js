const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('plugin.js', 'utf8');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function response(body, status = 200) {
  return {ok: status >= 200 && status < 300, status, json: async () => body};
}

function shot(id, setting, extra = {}) {
  return {
    id,
    timestamp: `2026-10-10T${id === 'new' ? '02' : '01'}:00:00Z`,
    workflow: {
      context: {
        beanBatchId: 'batch-a', grinderId: 'e64', grinderModel: 'E64',
        grinderSetting: setting, ...extra,
      },
      profile: {title: 'espresso'},
    },
  };
}

function load({shots = [], stored = null, settings = {
  GrinderId: 'e64', GrinderModel: 'E64', BeanBatchId: 'batch-a',
  ProfileId: 'espresso',
}} = {}) {
  let plugin;
  let timerId = 0;
  const timers = new Map();
  const reads = [];
  const writes = [];
  const fetchCalls = [];
  const pendingFetches = [];
  const logs = [];
  const host = {
    log: (message) => logs.push(message),
    storage: (command) => {
      if (command.type === 'read') reads.push(command);
      if (command.type === 'write') writes.push(command);
    },
  };
  const fetchStub = (url) => {
    fetchCalls.push(url);
    if (typeof shots === 'function') return shots(url, pendingFetches);
    return Promise.resolve(response({items: shots, total: shots.length}));
  };
  const context = {
    console,
    Date,
    JSON,
    Math,
    Promise,
    URL,
    URLSearchParams,
    fetch: fetchStub,
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, {callback, delay});
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  plugin = context.createPlugin(host);
  plugin.onLoad(settings);
  return {
    plugin,
    reads,
    writes,
    fetchCalls,
    pendingFetches,
    logs,
    resolveRead(value = stored) {
      plugin.onEvent({name: 'storageRead', payload: {key: 'feedback.v1', value}});
    },
    ackWrite(value = {}) {
      plugin.onEvent({name: 'storageWrite', payload: value});
    },
    fireTimers() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

async function call(plugin, endpoint, method, body) {
  return plugin.handleHttpRequest({endpoint, method, body});
}

test('storage read timeout cannot overwrite feedback with an assumed empty value', async () => {
  const h = load({stored: {old: {good: true}}});
  const pending = call(h.plugin, 'feedback', 'POST', {shotId: 'new', good: true});
  h.fireTimers();
  const result = await pending;
  assert.equal(result.status, 503);
  assert.equal(h.writes.length, 0);
});

test('late write acknowledgement after timeout does not permit another save', async () => {
  const h = load();
  h.resolveRead({});
  const first = call(h.plugin, 'feedback', 'POST', {shotId: 'one', good: true});
  await flush();
  assert.equal(h.writes.length, 1);
  h.fireTimers();
  assert.equal((await first).status, 503);
  h.ackWrite({one: {good: true}});
  const second = call(h.plugin, 'feedback', 'POST', {shotId: 'two', good: true});
  assert.equal((await second).status, 503);
  assert.equal(h.writes.length, 1);
});

test('failed feedback persistence rolls back the in-memory mark', async () => {
  const h = load({shots: [shot('old', '2.0')]});
  h.resolveRead({});
  const save = call(h.plugin, 'feedback', 'POST', {shotId: 'old', good: true});
  await flush();
  assert.equal(h.writes.length, 1);
  h.fireTimers();
  assert.equal((await save).status, 503);
  const recommendation = await call(h.plugin, 'recommendation', 'GET');
  assert.equal(recommendation.status, 503);
});

test('historical missing identity is not backfilled from current settings', async () => {
  const h = load({shots: [{...shot('old', '2.0'), workflow: {context: {
    beanBatchId: 'batch-a', grinderModel: 'E64', grinderSetting: '2.0',
  }, profile: {title: 'espresso'}}}]});
  h.resolveRead({old: {good: true}});
  const result = await call(h.plugin, 'recommendation', 'GET');
  assert.equal(result.status, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.status, 'abstain');
  assert.ok(body.missingData.some((entry) => entry.missing?.includes('grinderId')));
});

test('burr and calibration mismatches prevent a recommendation', async () => {
  const h = load({
    settings: {GrinderId: 'e64', GrinderModel: 'E64', BeanBatchId: 'batch-a', ProfileId: 'espresso', BurrIdentity: 'b', CalibrationEpoch: 'new'},
    shots: [shot('old', '2.0', {grinderBurrs: 'old', extras: {calibrationEpoch: 'old'}})],
  });
  h.resolveRead({old: {good: true}});
  const result = await call(h.plugin, 'recommendation', 'GET');
  assert.equal(JSON.parse(result.body).status, 'abstain');
});

test('plain-array pagination reports that its bounded scan was truncated', async () => {
  const all = Array.from({length: 250}, (_, index) => shot(`shot-${index}`, '2.0'));
  const h = load({shots: (url) => Promise.resolve(response(all.slice(Number(new URL(url).searchParams.get('offset')), Number(new URL(url).searchParams.get('offset')) + 50)))});
  h.resolveRead(Object.fromEntries([['shot-0', {good: true}]]));
  const result = await call(h.plugin, 'shots', 'GET');
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).truncated, true);
});

test('same profile title with different profile content is not treated as identical', async () => {
  const h = load({shots: [{...shot('old', '2.0'), workflow: {context: {
    beanBatchId: 'batch-a', grinderId: 'e64', grinderModel: 'E64', grinderSetting: '2.0',
  }, profile: {title: 'espresso', steps: [{pump: 'pressure', pressure: 2}]}}}]});
  h.resolveRead({old: {good: true}});
  const result = await call(h.plugin, 'recommendation', 'GET');
  assert.equal(JSON.parse(result.body).status, 'abstain');
});

test('host HTTP bridge assignment still leaves the public handler callable', async () => {
  const h = load();
  h.resolveRead({});
  // PluginManager assigns this exact bridge before dispatching requests.
  h.plugin.__httpRequestHandler = h.plugin.handleHttpRequest;
  const result = await call(h.plugin, 'ui', 'GET');
  assert.equal(result.status, 200);
});

test('malformed and failed shot responses surface a safe generic error', async () => {
  for (const fetchResult of [
    Promise.resolve({ok: true, status: 200, json: async () => { throw new Error('secret upstream URL'); }}),
    Promise.resolve(response({token: 'secret'}, 500)),
  ]) {
    const h = load({shots: () => fetchResult});
    h.resolveRead({});
    const result = await call(h.plugin, 'shots', 'GET');
    assert.equal(result.status, 503);
    assert.equal(result.body.includes('secret'), false);
  }
});

test('shot update invalidates an in-flight history result before caching', async () => {
  let resolveFetch;
  let fetchCount = 0;
  const h = load({shots: () => {
    fetchCount += 1;
    if (fetchCount === 1) return new Promise((resolve) => { resolveFetch = resolve; });
    return Promise.resolve(response({items: [shot('old', '2.0')], total: 1}));
  }});
  h.resolveRead({old: {good: true}});
  const pending = call(h.plugin, 'recommendation', 'GET');
  await flush();
  assert.equal(typeof resolveFetch, 'function');
  h.plugin.onEvent({name: 'shotUpdated', payload: {id: 'old'}});
  resolveFetch(response({items: [shot('old', '2.0')], total: 1}));
  await pending;
  assert.equal(h.fetchCalls.length, 3);
  await call(h.plugin, 'recommendation', 'GET');
  assert.equal(h.fetchCalls.length, 4);
});

