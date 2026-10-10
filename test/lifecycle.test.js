const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../plugin.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {promise, resolve};
}

function fixture() {
  let plugin;
  const pending = [];
  const context = vm.createContext({
    console,
    Date,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    fetch: (...args) => {
      const request = deferred();
      pending.push({args, ...request});
      return request.promise;
    },
  });
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  plugin = context.createPlugin({
    log() {},
    storage(event) {
      if (event.type === 'read') {
        plugin.onEvent({name: 'storageRead', payload: {key: event.key, value: {}}});
      }
    },
  });
  plugin.onLoad({BeanBatchId: 'batch', GrinderId: 'grinder', ProfileId: 'profile'});
  return {plugin, pending};
}

function response(body, ok = true, status = 200) {
  return {ok, status, json: async () => body};
}

async function nextRequest(pending) {
  await new Promise(setImmediate);
  assert.equal(pending.length, 1, 'recommendation should have one active HTTP request');
  return pending[0];
}

test('an in-flight recommendation is rejected when shot history changes', async () => {
  const {plugin, pending} = fixture();
  const request = plugin.handleHttpRequest({endpoint: 'recommendation', method: 'GET'});
  const first = await nextRequest(pending);
  plugin.onEvent({name: 'shotUpdated', payload: {id: 'new-shot'}});
  first.resolve(response([]));
  await new Promise(setImmediate);
  assert.equal(pending.length, 2, 'generation change should not expose the old snapshot');
  pending[1].resolve(response([]));
  await new Promise(setImmediate);
  assert.equal(pending.length, 3, 'recommendation should read the current workflow after refreshing history');
  pending[2].resolve(response({}));
  const result = await request;
  assert.equal(result.status, 503);
  assert.deepEqual(JSON.parse(result.body), {error: 'Assisted dial-in unavailable', code: 'request_failed'});
});

test('an in-flight recommendation is rejected after unload', async () => {
  const {plugin, pending} = fixture();
  const request = plugin.handleHttpRequest({endpoint: 'recommendation', method: 'GET'});
  const first = await nextRequest(pending);
  plugin.onUnload();
  first.resolve(response([]));
  const result = await request;
  assert.equal(result.status, 503);
  assert.deepEqual(JSON.parse(result.body), {error: 'Assisted dial-in unavailable', code: 'request_failed'});
});
