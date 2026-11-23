const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('plugin.js', 'utf8');
const ok = (body, status = 200) => ({ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(body))});
const E64 = '/api/v1/plugins/mahlkoenig-e64.reaplugin';
const DEVICE = 'plugin:mahlkoenig-e64.reaplugin:e64:sim';
const page = {origin: 'http://192.168.1.5:8080', host: '192.168.1.5:8080'};

// The assisted dial-in plugin against Decaid-shaped routes, including the
// grinder plugin's read-only settings and grind-events endpoints.
function load({owner = 'grinder', ownerVia = 'settings', events = [], display = '83', controls = {grindSetting: {kind: 'numeric', min: 0, max: 200, step: 1}},
  capabilities = ['grindSetting', 'startStop'], shots = [], workflow = e64Workflow(), settings = {}} = {}) {
  const storage = new Map(), state = {display, puts: [], requests: []};
  let plugin;
  const routes = async (url, init = {}) => {
    const parsed = new URL(url), path = parsed.pathname, method = init.method || 'GET';
    state.requests.push(method + ' ' + path);
    if (path === '/api/v1/workflow') return ok(workflow);
    if (path === '/api/v1/grinder/info') return ok({deviceId: DEVICE, capabilities, observations: ['setting'], ...(controls ? {controls} : {})});
    if (path === '/api/v1/grinder/state') return ok({timestamp: new Date().toISOString(), state: 'idle', observedSetting: state.display});
    if (path === '/api/v1/grinder/setting' && method === 'PUT') { state.puts.push(JSON.parse(init.body)); state.display = JSON.parse(init.body).setting; return ok({}); }
    if (path === E64 + '/settings') return ownerVia === 'settings' ? ok({AdjustmentOwner: owner}) : ok({}, 404);
    // The E64 plugin's diagnostics read=control reports {owner, ...}.
    if (path === E64 + '/e64-diagnostics') return ownerVia === 'diagnostics' && parsed.searchParams.get('read') === 'control' ? ok({owner, debugMode: 'unprobed'}) : ok({}, 404);
    if (path === E64 + '/grind-events') return ok({events});
    if (path === '/api/v1/shots') return ok({items: shots, total: shots.length});
    if (path === '/api/v1/bean-batches/batch-1') return ok({id: 'batch-1', beanId: 'bean-1'});
    if (path === '/api/v1/beans/bean-1') return ok({id: 'bean-1', name: 'Fixture'});
    const shot = shots.find((item) => path === '/api/v1/shots/' + item.id);
    return shot ? ok(shot) : ok({}, 404);
  };
  const host = {
    log() {},
    storage(command) {
      if (command.type === 'read') queueMicrotask(() => plugin.onEvent({name: 'storageRead', payload: {key: command.key, value: storage.get(command.key) ?? null}}));
      else { storage.set(command.key, JSON.parse(JSON.stringify(command.data))); queueMicrotask(() => plugin.onEvent({name: 'storageWrite', payload: command.data})); }
    },
  };
  const context = vm.createContext({console, setTimeout, clearTimeout, Date, JSON, Math, Promise, URL, URLSearchParams, queueMicrotask, fetch: routes});
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  plugin = context.createPlugin(host);
  plugin.onLoad({TargetTimeSec: 28, ...settings});
  const call = async (endpoint, method = 'GET', body, headers) => {
    const response = await plugin.handleHttpRequest({endpoint, method, body, headers});
    return {status: response.status, body: JSON.parse(response.body)};
  };
  const records = () => storage.get('grinderObservations.v1')?.shots || {};
  return {plugin, state, call, records};
}
function e64Workflow(context = {}, extras = {grinderSettingUnit: 'deci-micrometre'}) {
  return {profile: {title: 'espresso', steps: [{pump: 'pressure', pressure: 9}]},
    context: {beanBatchId: 'batch-1', grinderId: 'grinder-1', grinderModel: 'E64 WS', grinderBurrs: 'stock', targetDoseWeight: 18, targetYield: 36,
      ...context, extras: {calibrationEpoch: 'epoch-1', basket: '58mm', ...extras}}};
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const shotAt = (id, startedMsAgo, context = {}) => ({id, timestamp: ago(startedMsAgo), workflow: e64Workflow(context), measurements: []});
const grind = (uuid, completedMsAgo, extra = {}) => ({grindUuid: uuid, completedAt: ago(completedMsAgo), success: true,
  recipe: {index: 2, uuid: 'recipe-a', mode: 'GbW', type: 'espresso', amount: 18, coarseness: 82}, brewTargets: {doseG: 18, yieldG: 36, timeS: 28},
  grindWeightG: 18.07, grindDurationS: 8.3, grindDdd: 819, ...extra});
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('each stored shot is linked to the grind that completed just before it, at most once', async () => {
  const shots = [shotAt('shot-1', 60000), shotAt('shot-2', 30000)];
  const h = load({shots, events: [grind('grind-old', 20 * 60000), grind('grind-a', 120000), grind('grind-failed', 70000, {success: false})]});
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'shot-1'}});
  await settle();
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'shot-2'}});
  await settle();
  const linked = h.records();
  assert.equal(linked['shot-1'].grind.grindUuid, 'grind-a', 'the successful grind a minute before the shot');
  assert.deepEqual(linked['shot-1'].grind.recipe, {index: 2, uuid: 'recipe-a', mode: 'GbW', type: 'espresso', amount: 18, coarseness: 82});
  assert.equal(linked['shot-1'].grind.weightG, 18.07);
  assert.equal(linked['shot-1'].grind.durationS, 8.3);
  assert.equal(linked['shot-2'].grind, undefined, 'a grind belongs to one shot; older and failed grinds never link');
});

test('snake_case grind events are accepted and the shot list and analysis carry the recipe and dose evidence', async () => {
  const shots = [shotAt('shot-1', 60000)];
  const events = [{grind_uuid: 'grind-a', completed_at: ago(90000), success: true, recipe_index: 1, recipe_uuid: 'recipe-b', recipe_mode: 'GbT',
    recipe_type: 'espresso', recipe_amount: 9.5, recipe_coarseness: 80, grind_weight: 17.9, grind_duration: 9.5, grind_ddd: 800}];
  const h = load({shots, events});
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'shot-1'}});
  await settle();
  const listed = (await h.call('shots')).body.items[0];
  assert.deepEqual(listed.grind.recipe, {index: 1, uuid: 'recipe-b', mode: 'GbT', type: 'espresso', amount: 9.5, coarseness: 80});
  assert.equal(listed.grind.weightG, 17.9);
  const analysis = (await h.call('analysis', 'POST', {shotId: 'shot-1'})).body;
  assert.equal(analysis.grind.grindUuid, 'grind-a');
  assert.deepEqual(analysis.doseEvidence, {grams: 17.9, source: 'grinder-reported ground weight', grindUuid: 'grind-a'});
});

test('weighed beans and the shot dose annotation outrank the grinder weight as dose evidence', async () => {
  const shots = [{...shotAt('shot-1', 60000), annotations: {actualDoseWeight: 18.2}}];
  const h = load({shots, events: [grind('grind-a', 90000)]});
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'shot-1'}});
  await settle();
  assert.deepEqual((await h.call('analysis', 'POST', {shotId: 'shot-1'})).body.doseEvidence, {grams: 18.2, source: 'shot dose annotation'});
});

test('the adjustment owner is read from the grinder plugin settings or diagnostics and degrades to unknown', async () => {
  assert.equal((await load({owner: 'decaid'}).call('grinder-control')).body.owner, 'decaid');
  assert.equal((await load({owner: JSON.stringify({sim: 'grinder'})}).call('grinder-control')).body.owner, 'grinder');
  assert.equal((await load({owner: 'decaid', ownerVia: 'diagnostics'}).call('grinder-control')).body.owner, 'decaid');
  const absent = (await load({ownerVia: 'none'}).call('grinder-control')).body;
  assert.equal(absent.owner, null);
  assert.equal(absent.applyAvailable, false);
  assert.equal((await load({owner: 'something-else'}).call('grinder-control')).body.owner, null);
});

// Three comparable sour shots at the live dial: one 10 dD step finer is 820 dD = 82 on the grinder.
async function decaidOwned(options = {}) {
  const shots = [0, 1, 2].map((index) => shotAt('step-' + index, (index + 1) * 60000, {grinderSetting: '830'}));
  const h = load({owner: 'decaid', shots, settings: {StepSize: 10, NumericFinerDelta: -1}, ...options});
  for (const shot of shots)
    assert.equal((await h.call('feedback', 'POST', {shotId: shot.id, good: false, taste: 'sour', brewTimeSec: 22, brewTimeClock: 'pump'}, page)).status, 200);
  return h;
}

test('a numeric suggestion is applied only on explicit confirmation from the page, through the standard setting route', async () => {
  const h = await decaidOwned();
  const suggestion = (await h.call('suggestion')).body;
  assert.equal(suggestion.proposedSetting, 820);
  assert.equal((await h.call('grinder-control')).body.applyAvailable, true);
  assert.equal(h.state.puts.length, 0, 'suggesting never moves the grinder');
  const request = {proposedSetting: 820, settingUnit: 'deci-micrometre'};
  assert.equal((await h.call('apply-setting', 'POST', {...request, confirmed: true})).status, 403, 'not from the plugin page');
  assert.equal((await h.call('apply-setting', 'POST', request, page)).status, 409, 'not confirmed');
  assert.equal((await h.call('apply-setting', 'POST', {...request, proposedSetting: 700, confirmed: true}, page)).status, 409, 'not the current suggestion');
  assert.equal(h.state.puts.length, 0);
  const applied = await h.call('apply-setting', 'POST', {...request, confirmed: true}, page);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(h.state.puts, [{setting: '82'}]);
  assert.ok(h.state.requests.every((line) => !line.startsWith('PUT ' + E64) && !line.startsWith('POST ' + E64)), 'the grinder plugin is never called to change anything');
  const record = h.records()[suggestion.sourceShotIds[0]].applied;
  assert.deepEqual(record.suggested, {value: 820, unit: 'deci-micrometre'});
  assert.deepEqual(record.applied, {value: 82, unit: 'grinder display'});
  assert.equal(record.accepted, true);
});

test('apply is refused unless the grinder plugin hands adjustments to Decaid and offers a setting control', async () => {
  for (const options of [{owner: 'grinder'}, {owner: 'off'}, {controls: null}, {capabilities: []}, {controls: {grindSetting: {kind: 'enumerated', values: ['a']}}}]) {
    const h = await decaidOwned(options);
    const response = await h.call('apply-setting', 'POST', {proposedSetting: 820, settingUnit: 'deci-micrometre', confirmed: true}, page);
    assert.equal(response.status, 409, JSON.stringify(options));
    assert.equal(h.state.puts.length, 0);
  }
});

test('while the grinder owns adjustments, the assisted suggestion is recorded beside the dial the grinder moves to', async () => {
  const shots = [0, 1, 2].map((index) => shotAt('step-' + index, (3 - index) * 60000, {grinderSetting: '830'}));
  const h = load({owner: 'grinder', shots, settings: {StepSize: 10, NumericFinerDelta: -1}});
  for (const shot of shots)
    await h.call('feedback', 'POST', {shotId: shot.id, good: false, taste: 'sour', brewTimeSec: 22, brewTimeClock: 'pump'}, page);
  h.state.display = '83';
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'step-2'}});
  await settle();
  const control = (await h.call('grinder-control')).body;
  assert.equal(control.shadowMode, true);
  assert.equal(control.applyAvailable, false);
  // The grinder's GBS moves its dial before the next shot.
  h.state.display = '81';
  shots.push(shotAt('next', 10000, {grinderSetting: '810'}));
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'next'}});
  await settle();
  const rows = (await h.call('gbs-comparison')).body.rows;
  const row = rows.find((item) => item.shotId === 'step-2');
  assert.ok(row, JSON.stringify(rows));
  assert.deepEqual(row.dial, {value: 83, unit: 'grinder display'});
  assert.equal(row.assisted.direction, 'finer');
  assert.equal(row.assisted.proposedSetting, 820);
  assert.deepEqual(row.grinderNext, {shotId: 'next', dial: {value: 81, unit: 'grinder display'}, direction: 'smaller'});
  assert.equal(h.state.puts.length, 0);
});


test('E64 0.5 grind events (no UUID yet, result weight and motor time) link to the next shot once', async () => {
  const shots = [shotAt('shot-1', 60000), shotAt('shot-2', 30000)];
  const events = [{grindUuid: null, completedAt: ago(100000), targetWeightGr: 18, resultWeightGr: 18.085, motorRunTimeMs: 8860, setting: '82', linkedShotId: null}];
  const h = load({shots, events});
  for (const id of ['shot-1', 'shot-2']) { h.plugin.onEvent({name: 'shotStored', payload: {id}}); await settle(); }
  const grind = h.records()['shot-1'].grind;
  assert.equal(grind.grindUuid, null);
  assert.equal(grind.weightG, 18.085);
  assert.equal(grind.durationS, 8.86);
  assert.deepEqual(grind.targets, {targetWeightG: 18});
  assert.equal(grind.setting, '82');
  assert.equal(h.records()['shot-2'].grind, undefined, 'the same grind (keyed by completion time) is not linked twice');
});

test('an opaque setting control (E64 0.5) is settable with a whole display value', async () => {
  const h = await decaidOwned({controls: {grindSetting: {kind: 'opaque'}}});
  const applied = await h.call('apply-setting', 'POST', {proposedSetting: 820, settingUnit: 'deci-micrometre', confirmed: true}, page);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(h.state.puts, [{setting: '82'}]);
});

test('final E64 events with grind-log recipe and log blocks keep the recipe and prefer the logged weight', async () => {
  const shots = [shotAt('shot-1', 60000)];
  const events = [{grindUuid: 'a1b2c3d4-0000-4000-8000-000000000001', completedAt: ago(90000), targetWeightGr: 18, resultWeightGr: 18.07,
    motorRunTimeMs: 7554, setting: '82', linkedShotId: null,
    log: {grindWeightGr: 18.085, grindDurationMs: 8860, setting: '82', successful: true},
    recipe: {index: 1, uuid: 'b1b2c3d4-0000-4000-8000-000000000002', mode: 'GbW', type: 'Espresso', amountGr: 18, setting: '82', brewTimeMs: 28000, brewWeightGr: 36}}];
  const h = load({shots, events});
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'shot-1'}});
  await settle();
  const grind = h.records()['shot-1'].grind;
  assert.equal(grind.grindUuid, 'a1b2c3d4-0000-4000-8000-000000000001');
  assert.deepEqual(grind.recipe, {index: 1, uuid: 'b1b2c3d4-0000-4000-8000-000000000002', mode: 'GbW', type: 'Espresso', amount: 18, coarseness: 82});
  assert.deepEqual(grind.targets, {targetWeightG: 18, brewWeightG: 36, brewTimeS: 28});
  assert.equal(grind.weightG, 18.085, 'the grinder log weight wins over the live result');
  assert.equal(grind.durationS, 8.86);
  const failed = load({shots, events: [{...events[0], log: {...events[0].log, successful: false}}]});
  failed.plugin.onEvent({name: 'shotStored', payload: {id: 'shot-1'}});
  await settle();
  assert.equal(failed.records()['shot-1']?.grind, undefined, 'a grind the log marks unsuccessful is never linked');
});

test('a shot linked before the grinder log arrives later receives that same grind\'s UUID and recipe, never another grind', async () => {
  const shots = [shotAt('shot-1', 60000), shotAt('shot-2', 20000)];
  const completedAt = ago(90000);
  const live = {grindUuid: null, completedAt, targetWeightGr: 18, resultWeightGr: 18.07, motorRunTimeMs: 7554, setting: '82', linkedShotId: null};
  const events = [live];
  const h = load({shots, events});
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'shot-1'}});
  await settle();
  assert.equal(h.records()['shot-1'].grind.grindUuid, null);
  // The grinder plugin has since read the grinder's log for that grind; a newer grind also exists.
  events[0] = {...live, grindUuid: 'a1b2c3d4-0000-4000-8000-000000000001', log: {grindWeightGr: 18.085, grindDurationMs: 8860, setting: '82', successful: true},
    recipe: {index: 1, uuid: 'b1b2c3d4-0000-4000-8000-000000000002', mode: 'GbW', type: 'Espresso', amountGr: 18, setting: '82'}};
  events.push({grindUuid: 'c1b2c3d4-0000-4000-8000-000000000003', completedAt: ago(30000), targetWeightGr: 18, resultWeightGr: 17.9, motorRunTimeMs: 7000});
  const analysis = (await h.call('analysis', 'POST', {shotId: 'shot-1'})).body;
  assert.equal(analysis.grind.grindUuid, 'a1b2c3d4-0000-4000-8000-000000000001');
  assert.equal(analysis.grind.completedAt, completedAt, 'the same grind, matched by its completion time');
  assert.equal(analysis.grind.recipe.mode, 'GbW');
  assert.equal(analysis.grind.weightG, 18.085);
  assert.equal(h.records()['shot-1'].grind.recipe.uuid, 'b1b2c3d4-0000-4000-8000-000000000002', 'the refresh is stored');
  // A later shot takes only the newer grind; the enriched one stays with shot-1.
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'shot-2'}});
  await settle();
  assert.equal(h.records()['shot-2'].grind.grindUuid, 'c1b2c3d4-0000-4000-8000-000000000003');
});

test('the shot list refreshes a grind still waiting for the grinder log', async () => {
  const shots = [shotAt('shot-1', 60000)];
  const live = {grindUuid: null, completedAt: ago(90000), targetWeightGr: 18, resultWeightGr: 18.07, motorRunTimeMs: 7554};
  const events = [live];
  const h = load({shots, events});
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'shot-1'}});
  await settle();
  events[0] = {...live, grindUuid: 'a1b2c3d4-0000-4000-8000-000000000001', recipe: {mode: 'GbT', type: 'Espresso', amountGr: 9}};
  const listed = (await h.call('shots')).body.items[0];
  assert.deepEqual(listed.grind.recipe, {index: null, uuid: null, mode: 'GbT', type: 'Espresso', amount: 9, coarseness: null});
});
