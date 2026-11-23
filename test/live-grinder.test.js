const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {timedMeasurements} = require('./shot-fixtures');

const source = fs.readFileSync('plugin.js', 'utf8');
const ok = (body) => ({ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body))});

// Plugin with Decaid-shaped storage (echoed write acks) and REST routes. The
// grinder routes reproduce GET /api/v1/grinder/info and /state.
function load({workflow, shots = [], observation = {observedSetting: '630 ddValueDum'}, info = {observations: ['setting'], capabilities: []}, stored = {}, settings = {}} = {}) {
  const storage = new Map(Object.entries(stored)), writes = [], logs = [];
  let plugin;
  const routes = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/workflow') return ok(workflow);
    if (path === '/api/v1/grinder/info') return ok(info);
    if (path === '/api/v1/grinder/state') return ok({timestamp: new Date().toISOString(), state: 'idle', ...observation});
    if (path === '/api/v1/shots') return ok({items: shots, total: shots.length});
    if (path === '/api/v1/bean-batches/batch-1') return ok({id: 'batch-1', beanId: 'bean-1'});
    if (path === '/api/v1/beans/bean-1') return ok({id: 'bean-1', name: 'Fixture'});
    const shot = shots.find((item) => path === '/api/v1/shots/' + item.id);
    return shot ? ok(shot) : {ok: false, status: 404, json: async () => ({})};
  };
  const host = {
    log: (message) => logs.push(message),
    storage(command) {
      if (command.type === 'read') queueMicrotask(() => plugin.onEvent({name: 'storageRead', payload: {key: command.key, value: storage.get(command.key) ?? null}}));
      else { storage.set(command.key, JSON.parse(JSON.stringify(command.data))); writes.push(command.key); queueMicrotask(() => plugin.onEvent({name: 'storageWrite', payload: command.data})); }
    },
  };
  const context = vm.createContext({console, setTimeout, clearTimeout, Date, JSON, Math, Promise, URL, URLSearchParams, queueMicrotask, fetch: routes});
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  plugin = context.createPlugin(host);
  plugin.onLoad({TargetTimeSec: 28, ...settings});
  const get = async (endpoint, method = 'GET', body) => JSON.parse((await plugin.handleHttpRequest({endpoint, method, body})).body);
  return {plugin, storage, writes, logs, get};
}
const e64Workflow = (context = {}, extras = {}) => ({
  profile: {title: 'espresso', steps: [{pump: 'pressure', pressure: 9}]},
  context: {beanBatchId: 'batch-1', grinderId: 'grinder-1', grinderModel: 'E64 WS', grinderBurrs: 'stock', targetDoseWeight: 18, targetYield: 36,
    ...context, extras: {calibrationEpoch: 'epoch-1', basket: '58mm', ...extras}},
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('the live E64 observation fills a missing current setting in the coordinate the setup uses', async () => {
  const dd = load({workflow: e64Workflow({}, {grinderSettingUnit: 'deci-micrometre'})});
  const suggestion = await dd.get('suggestion');
  assert.equal(suggestion.currentSettingSource, 'live-grinder-observation');
  assert.equal(suggestion.liveGrinderObservation.coordinate.value, 630);
  assert.equal(suggestion.missingData?.includes('grinderSetting') ?? false, false);
  assert.equal(suggestion.userSuppliedCurrentFields.includes('grinderSetting'), false);
  assert.equal(suggestion.dialReference.currentNative.value, 63, 'dD 630 displays as 63 µm');

  const micrometres = load({workflow: e64Workflow({}, {grinderSettingUnit: 'micrometres'})});
  const converted = await micrometres.get('suggestion');
  assert.equal(converted.currentSettingSource, 'live-grinder-observation');
  assert.equal(converted.dialReference.currentNative.value, 63);
});

test('the workflow setting wins, and other grinders or units never take the E64 coordinate', async () => {
  assert.equal((await load({workflow: e64Workflow({grinderSetting: '600'}, {grinderSettingUnit: 'deci-micrometre'})}).get('suggestion')).currentSettingSource, 'workflow');
  const df64 = await load({workflow: e64Workflow({grinderModel: 'DF64 Gen 1'}, {grinderSettingUnit: 'marks'})}).get('suggestion');
  assert.equal(df64.currentSettingSource, null);
  assert.ok(df64.missingData.includes('grinderSetting'));
  const opaque = await load({workflow: e64Workflow({}, {grinderSettingUnit: 'deci-micrometre'}), observation: {observedSetting: 'Dial 12'}}).get('suggestion');
  assert.equal(opaque.currentSettingSource, null);
});

test('driver surfaces are passed through only as same-plugin Decaid links', async () => {
  const info = {observations: ['setting', 'rpm'], capabilities: [], surfaces: [
    {id: 'diagnostics', role: 'diagnostics', label: 'E64 diagnostics', href: '/api/v1/plugins/mahlkoenig-e64.reaplugin/e64-diagnostics?deviceId=plugin%3Ae64%3Asim'},
    {id: 'evil', role: 'diagnostics', label: 'x', href: 'https://example.com/steal'},
    {id: 'js', role: 'settings', label: 'x', href: 'javascript:alert(1)'},
  ]};
  const body = await load({workflow: e64Workflow(), info, observation: {observedSetting: '630 ddValueDum', observedRpm: 1200}}).get('grinder-observation');
  assert.deepEqual(body.surfaces.map((item) => item.href), ['/api/v1/plugins/mahlkoenig-e64.reaplugin/e64-diagnostics?deviceId=plugin%3Ae64%3Asim']);
  assert.equal(body.observedRpm, 1200);
  assert.equal(body.grinderState, 'idle');
  assert.ok(body.observedAt);
});

test('a just-stored E64 shot records the live setting; analysis labels it and explicit values win', async () => {
  const fresh = {id: 'fresh-shot', timestamp: new Date(Date.now() - 40000).toISOString(), workflow: e64Workflow({}, {grinderSettingUnit: 'deci-micrometre'}), measurements: timedMeasurements(new Date(Date.now() - 40000).toISOString(), 25)};
  const old = {...fresh, id: 'imported-shot', timestamp: '2025-01-01T08:00:00.000Z'};
  const h = load({workflow: e64Workflow(), shots: [fresh, old]});
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'fresh-shot'}});
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'imported-shot'}});
  await settle();
  const saved = h.storage.get('grinderObservations.v1');
  assert.deepEqual(Object.keys(saved.shots), ['fresh-shot'], 'an imported old shot never receives today\'s observation');
  assert.equal(saved.shots['fresh-shot'].ddValueDum, 630);
  const analysis = await h.get('analysis', 'POST', {shotId: 'fresh-shot'});
  assert.equal(analysis.context.grinderSetting, '630');
  assert.equal(analysis.context.grinderSettingSource, 'recorded-live-observation');
  assert.equal(analysis.recordedGrinderObservation.ddValueDum, 630);

  const explicit = load({workflow: e64Workflow(), shots: [{...fresh, workflow: e64Workflow({grinderSetting: '640'}, {grinderSettingUnit: 'deci-micrometre'})}],
    stored: {'grinderObservations.v1': saved}});
  const kept = await explicit.get('analysis', 'POST', {shotId: 'fresh-shot'});
  assert.equal(kept.context.grinderSetting, '640');
  assert.equal(kept.context.grinderSettingSource, undefined);
});

test('a stale observation is not recorded with a new shot', async () => {
  const fresh = {id: 'fresh-shot', timestamp: new Date().toISOString(), workflow: e64Workflow(), measurements: []};
  const h = load({workflow: e64Workflow(), shots: [fresh], observation: {observedSetting: '630 ddValueDum', timestamp: new Date(Date.now() - 600000).toISOString()}});
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'fresh-shot'}});
  await settle();
  assert.equal(h.storage.get('grinderObservations.v1'), undefined);
});

test('settings use the host enum type for the timing clock', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.equal(manifest.settings.TargetTimeClock.type, 'enum');
  assert.deepEqual(manifest.settings.TargetTimeClock.values, ['pump', 'pouring', 'recording']);
  assert.equal(manifest.settings.TargetTimeClock.default, 'pump');
  for (const [key, setting] of Object.entries(manifest.settings)) {
    assert.ok(setting.label && !/[a-z][A-Z]/.test(setting.label), key + ' needs a human-friendly label, not a storage key');
    assert.ok(setting.description, key + ' needs a description');
  }
});

test('an E64 display reading (plugin 0.4.4) is micrometres, flagged as rounded, and kept in the grinder\'s own number', async () => {
  const display = {observedSetting: '83'};
  const noUnit = await load({workflow: e64Workflow(), observation: display}).get('suggestion');
  assert.equal(noUnit.currentSettingSource, 'live-grinder-observation');
  assert.deepEqual(noUnit.liveGrinderObservation.reading, {kind: 'display', value: 83});
  assert.equal(noUnit.liveGrinderObservation.coordinate, null, 'no exact dD is claimed');
  assert.equal(noUnit.currentSettingPrecisionDd, 5);
  assert.equal(noUnit.dialReference.currentNative.value, 83);

  const dd = await load({workflow: e64Workflow({}, {grinderSettingUnit: 'deci-micrometre'}), observation: display}).get('suggestion');
  assert.equal(dd.dialReference.currentNative.value, 83, '83 µm display = 830 dD ±5');
  assert.equal(dd.currentSettingPrecisionDd, 5);

  const df64 = await load({workflow: e64Workflow({grinderModel: 'DF64 Gen 1'}, {grinderSettingUnit: 'marks'}), observation: display}).get('suggestion');
  assert.equal(df64.currentSettingSource, null, 'a bare number is only interpreted for E64-family grinders');
});

test('display-derived settings warn when the calibrated step is finer than the display', async () => {
  const shots = [0, 1, 2].map((index) => ({id: 'step-' + index, timestamp: new Date(Date.now() - (index + 1) * 60000).toISOString(),
    workflow: e64Workflow({grinderSetting: '830'}, {grinderSettingUnit: 'deci-micrometre'})}));
  const suggest = async (StepSize) => {
    const h = load({workflow: e64Workflow({}, {grinderSettingUnit: 'deci-micrometre'}), observation: {observedSetting: '83'}, shots,
      settings: {StepSize, NumericFinerDelta: -1}});
    for (const shot of shots)
      assert.equal((await h.plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId: shot.id, good: false, taste: 'sour', brewTimeSec: 22, brewTimeClock: 'pump'}})).status, 200);
    return h.get('suggestion');
  };
  const fine = await suggest(5);
  assert.equal(fine.status, 'suggestion', fine.reason);
  assert.equal(fine.proposedSetting, 825, 'sour: one step finer (smaller)');
  assert.ok(fine.warnings.some((warning) => /finer than the grinder display resolution \(10 deci-micrometre\)/.test(warning)));
  const coarse = await suggest(10);
  assert.equal(coarse.proposedSetting, 820);
  assert.equal(coarse.warnings.some((warning) => /display resolution/.test(warning)), false);
});

test('shot records keep the display value, and records written with exact dD still load', async () => {
  const fresh = {id: 'fresh-shot', timestamp: new Date(Date.now() - 40000).toISOString(), workflow: e64Workflow(), measurements: []};
  const h = load({workflow: e64Workflow(), shots: [fresh], observation: {observedSetting: '83'}});
  h.plugin.onEvent({name: 'shotStored', payload: {id: 'fresh-shot'}});
  await settle();
  assert.deepEqual(Object.keys(h.storage.get('grinderObservations.v1').shots['fresh-shot']).sort(), ['display', 'grinderId', 'grinderModel', 'observedAt', 'recordedAt']);
  const analysis = await h.get('analysis', 'POST', {shotId: 'fresh-shot'});
  assert.equal(analysis.context.grinderSetting, '83');
  assert.equal(analysis.context.settingUnit, 'micrometres');
  assert.equal(analysis.context.grinderSettingPrecisionDd, 5);

  const legacy = {key: 'grinderObservations.v1', schemaVersion: 1, shots: {'fresh-shot': {ddValueDum: 827, observedAt: new Date().toISOString()}}};
  const old = load({workflow: e64Workflow(), shots: [{...fresh, workflow: e64Workflow({}, {grinderSettingUnit: 'deci-micrometre'})}], stored: {'grinderObservations.v1': legacy}});
  const restored = await old.get('analysis', 'POST', {shotId: 'fresh-shot'});
  assert.equal(restored.context.grinderSetting, '827');
  assert.equal(restored.context.grinderSettingPrecisionDd, undefined, 'an exact dD record is not flagged as rounded');
  assert.equal(restored.recordedGrinderObservation.ddValueDum, 827);
});
