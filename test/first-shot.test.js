const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('plugin.js', 'utf8');
const profile = {name: 'espresso', steps: [{pump: 'pressure', pressure: 9}]};
const context = ({beanBatchId = 'new-batch', grinderId = 'g-1', grinderModel = 'DF64', grinderSetting = '10', targetDoseWeight = 18, targetYield = 36, ...overrides} = {}) => ({
  beanBatchId, grinderId, grinderModel, grinderSetting,
  targetDoseWeight, targetYield,
  extras: {burrIdentity: 'stock', calibrationEpoch: 'cal-1', basket: '58mm', grinderSettingUnit: 'marks', ...overrides},
});
function shot(id, shotContext, seconds = 20) {
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  const full = {
    id, timestamp, workflow: {context: shotContext, profile},
    measurements: [{machine: {timestamp: new Date(Date.parse(timestamp) + seconds * 1000).toISOString(), flow: 2, pressure: 9}, scale: {timestamp: new Date(Date.parse(timestamp) + seconds * 1000).toISOString(), weight: 36}}],
    annotations: {actualDoseWeight: 18, actualYield: 36},
  };
  return {id, timestamp, workflow: full.workflow, full};
}
const response = (value, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => value});

async function load({current = {context: context(), profile}, entries, catalog = true, settings = {}}) {
  let plugin;
  const full = new Map(entries.map((entry) => [entry.id, entry.full]));
  const host = {
    log() {},
    storage(command) {
      if (command.type === 'read') setTimeout(() => plugin.onEvent({name: 'storageRead', payload: {key: command.key, value: {}}}), 0);
      if (command.type === 'write') setTimeout(() => plugin.onEvent({name: 'storageWrite', payload: command.data}), 0);
    },
  };
  const fetch = async (url) => {
    if (process.env.DEBUG_FIRST_SHOT) console.error('FETCH', url);
    if (url.endsWith('/workflow')) return response(current);
    if (url.includes('/shots?')) return response({items: entries.map(({full: _, ...summary}) => summary), total: entries.length});
    const match = url.match(/\/shots\/([^/?]+)$/);
    if (match && full.has(decodeURIComponent(match[1]))) return response(full.get(decodeURIComponent(match[1])));
    if (url.endsWith('/bean-batches/new-batch')) return catalog ? response({id: 'new-batch', beanId: 'bean-new', roastLevel: 'light'}) : response({}, 500);
    if (url.endsWith('/beans/bean-new')) return catalog ? response({id: 'bean-new', name: 'New Bean', species: 'Arabica', variety: ['Bourbon'], processing: 'washed', decaf: false}) : response({}, 500);
    return response({}, 404);
  };
  const vmContext = {console, Date, JSON, Math, Number, Object, Set, Promise, URL, URLSearchParams, fetch, setTimeout, clearTimeout};
  vm.createContext(vmContext);
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, vmContext);
  plugin = vmContext.createPlugin(host);
  plugin.onLoad({TargetTimeSec: 30, TimeToleranceSec: 1, EvidenceMaxAgeDays: 14, StepSize: 0.5, NumericFinerDelta: -1, MinSetting: 0, MaxSetting: 90, ...settings});
  await new Promise((resolve) => setTimeout(resolve, 2));
  return plugin;
}
async function mark(plugin, id, extra = {}) {
  return plugin.handleHttpRequest({endpoint: 'feedback', method: 'POST', body: {shotId: id, good: true, taste: 'sour', ...extra}});
}
async function suggest(plugin) {
  const result = await plugin.handleHttpRequest({endpoint: 'suggestion', method: 'GET'});
  return {result, body: JSON.parse(result.body)};
}

test('new bean gets a bean-aware provisional first-shot suggestion without mixing another batch', async () => {
  const current = {context: context({beanType: 'washed', roastLevel: 'light'}), profile};
  const fresh = shot('fresh', context({beanType: 'washed', roastLevel: 'light'}), 20);
  const old = shot('old-other-bean', context({beanBatchId: 'old-batch', beanType: 'washed', roastLevel: 'light'}), 20);
  const plugin = await load({current, entries: [fresh, old]});
  await mark(plugin, fresh.id);
  await mark(plugin, old.id);
  const {result, body} = await suggest(plugin);
  assert.equal(result.status, 200, JSON.stringify(body));
  assert.equal(body.status, 'suggestion');
  assert.equal(body.stage, 'provisional');
  assert.equal(body.confidence, 'provisional');
  assert.equal(body.evidenceCount, 1);
  assert.deepEqual(body.sourceShotIds, ['fresh']);
  assert.equal(body.direction, 'finer');
  assert.equal(body.proposedSetting, 9.5);
  assert.equal(body.currentBeanCatalog.bean.name, 'New Bean');
  assert.equal(body.currentBeanCatalog.bean.species, 'Arabica');
  assert.deepEqual(body.currentBeanCatalog.bean.variety, ['Bourbon']);
  assert.equal(body.currentBeanCatalog.bean.processing, 'washed');
  assert.equal(body.currentBeanCatalog.batch.roastLevel, 'light');
  assert.match(body.currentBeanCatalog.provenance, /current.*catalog|historical.*not|not.*historical/i);
  assert.ok(body.reviewedReferences.matches.some((source) => source.id === 'df64-clive'));
  assert.match(body.reviewedReferences.matches.find((source) => source.id === 'df64-clive').url, /^https:\/\//);
  assert.match(body.reviewedReferences.provenance, /contextual facts|do not alter/i);
});

test('first-shot path excludes recipe or calibration changes and never backfills bean metadata', async () => {
  const current = {context: context({beanType: 'washed', roastLevel: 'light', calibrationEpoch: 'cal-2'}), profile};
  const changed = shot('changed', context({calibrationEpoch: 'cal-1'}), 20);
  const missingBean = shot('missing-bean', context({calibrationEpoch: 'cal-2'}), 20);
  const plugin = await load({current, entries: [changed, missingBean]});
  await mark(plugin, changed.id);
  await mark(plugin, missingBean.id);
  const {body} = await suggest(plugin);
  assert.equal(body.status, 'abstain');
  assert.equal(body.sourceShotIds.length, 0);
  assert.ok(body.excluded.some((item) => item.shotId === 'changed'));
  assert.ok(body.excluded.some((item) => item.shotId === 'missing-bean'));
});

test('first-shot numeric proposal is direction-only without owner calibration and catalog failures are safe', async () => {
  const fresh = shot('fresh', context({beanType: 'washed', roastLevel: 'light'}), 20);
  const noNumbers = await load({current: {context: context({beanType: 'washed', roastLevel: 'light'}), profile}, entries: [fresh], settings: {StepSize: '', NumericFinerDelta: '', MinSetting: '', MaxSetting: ''}});
  await mark(noNumbers, fresh.id);
  const directionOnly = await suggest(noNumbers);
  assert.equal(directionOnly.body.status, 'suggestion', JSON.stringify(directionOnly.body));
  assert.equal(directionOnly.body.proposedSetting, null);
  assert.ok(directionOnly.body.warnings.some((warning) => /Direction only/.test(warning)));

  const brokenCatalog = await load({current: {context: context({beanType: 'washed', roastLevel: 'light'}), profile}, entries: [fresh], catalog: false});
  await mark(brokenCatalog, fresh.id);
  const failed = await suggest(brokenCatalog);
  assert.equal(failed.result.status, 503);
  assert.equal(failed.body.code, 'request_failed');
});

test('unknown grinder identity abstains before provisional catalog guidance', async () => {
  const fresh = shot('fresh', context({grinderId: undefined, beanType: 'washed', roastLevel: 'light'}), 20);
  const current = {context: context({grinderId: null, beanType: 'washed', roastLevel: 'light'}), profile};
  const plugin = await load({current, entries: [fresh]});
  await mark(plugin, fresh.id);
  const {body} = await suggest(plugin);
  assert.equal(body.status, 'abstain', JSON.stringify(body));
  assert.ok(body.missingData.includes('grinderId'));
});
