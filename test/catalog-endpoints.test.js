const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('offline coffee and profile catalogs remain read-only and keep all source records', async () => {
  let plugin; let network = 0; let writes = 0;
  const context = { console, Date, JSON, Math, Number, Object, Set, Promise, URLSearchParams, setTimeout, clearTimeout,
    fetch: async () => { network++; throw new Error('offline catalog must not use network'); } };
  const host = { log() {}, storage(command) {
    if (command.type === 'write') writes++;
    if (command.type === 'read') queueMicrotask(() => plugin.onEvent({name:'storageRead',payload:{key:command.key,value:{}}}));
  }};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('plugin.js','utf8')+'\nthis.factory=createPlugin;',context);
  plugin=context.factory(host); plugin.onLoad({});
  for (const [endpoint, path] of [['coffee-catalog','data/coffee-catalog.json'], ['profiles','data/decent-profiles.json']]) {
    const response=await plugin.handleHttpRequest({endpoint,method:'GET'});
    assert.equal(response.status,200);
    const actual=JSON.parse(response.body), expected=JSON.parse(fs.readFileSync(path,'utf8'));
    assert.deepEqual(actual,expected);
  }
  assert.equal(network,0); assert.equal(writes,0);
  plugin.onUnload();
});
