// Grinder recipe per shot, applying a suggestion and the grinder-GBS shadow
// comparison. The grinder plugin's read-only owner setting and grind events
// are mocked at the fixture boundary (e2e/server.js); the simulator specs
// cover the live chain.
const { test: base, expect } = require('@playwright/test');
const test = base.extend({ request: async ({ context }, use) => use(context.request) });
const PREFIX = '/api/v1/plugins/assisted-dialin.reaplugin';
const UI = PREFIX + '/ui';
const DEVICE = 'plugin:mahlkoenig-e64.reaplugin:e64:fixture';
const step = (page, number) => page.locator('nav button[data-native-step="' + number + '"]').click();
const ago = (ms) => new Date(Date.now() - ms).toISOString();

async function setup(request, { owner, display = '63', controls = true, events = [] }) {
  await request.post('/__test/reset');
  const { shots } = await (await request.get('/__test/state')).json();
  const base = shots[0];
  // Three comparable sour shots at dD 630: one 10 dD step finer is 620 dD, shown as 62.
  const comparable = [1, 2, 3].map((n) => ({ ...JSON.parse(JSON.stringify(base)), id: 'cmp-' + n, timestamp: ago(n * 3600000) }));
  const info = { deviceId: DEVICE, observations: ['setting'], capabilities: controls ? ['grindSetting'] : [],
    ...(controls ? { controls: { grindSetting: { kind: 'numeric', min: 0, max: 200, step: 1 } } } : {}) };
  await request.post('/__test/config', { data: { shots: [...shots, ...comparable], e64: { owner, events },
    grinderObservation: { info, snapshot: { timestamp: new Date().toISOString(), state: 'idle', observedSetting: display } } } });
  for (const shot of comparable)
    expect((await request.post(PREFIX + '/feedback', { data: { shotId: shot.id, good: false, taste: 'sour', brewTimeSec: 24, brewTimeClock: 'pump' } })).status()).toBe(200);
  return { base, shots: [...shots, ...comparable] };
}
async function storeShot(request, shots, base, id, startedMsAgo) {
  const shot = { ...JSON.parse(JSON.stringify(base)), id, timestamp: ago(startedMsAgo) };
  delete shot.workflow.context.grinderSetting;
  shots.push(shot);
  await request.post('/__test/config', { data: { shots } });
  await request.post('/__test/event', { data: { name: 'shotStored', payload: { id } } });
  await expect.poll(async () => Boolean((await (await request.get('/__test/state')).json()).storage['grinderObservations.v1']?.shots?.[id])).toBe(true);
}

test('a stored shot shows the grinder recipe and ground weight, and uses it as labelled dose evidence', async ({ page, request }) => {
  // The E64 0.5 event shape, with the blocks it adds from the grinder's own grind log.
  const events = [{ grindUuid: 'a1b2c3d4-0000-4000-8000-000000000001', completedAt: ago(90000), targetWeightGr: 18, resultWeightGr: 18.0,
    motorRunTimeMs: 7600, setting: '63', linkedShotId: null,
    log: { grindWeightGr: 18.07, grindDurationMs: 8300, setting: '63', successful: true },
    recipe: { index: 0, uuid: 'b1b2c3d4-0000-4000-8000-000000000002', mode: 'GbW', type: 'espresso', amountGr: 18, setting: '63', brewTimeMs: 28000, brewWeightGr: 36 } }];
  const { shots, base } = await setup(request, { owner: 'off', events });
  await storeShot(request, shots, base, 'with-recipe', 30000);
  await page.goto(UI); await step(page, 3);
  await page.locator('#loadShots').click();
  await expect(page.locator('#shotSelect option[value="with-recipe"]')).toContainText('Recipe: espresso/GbW 18, ground 18.07 g');
  await page.locator('#analysis input[name=shotId]').fill('with-recipe');
  await page.locator('#analysis button').click();
  await expect(page.locator('#result')).toContainText('Recipe: espresso/GbW 18, ground 18.07 g');
  await expect(page.locator('#result')).toContainText('Dose evidence: 18.07 g (grinder-reported ground weight)');
});

test('Apply to grinder sets the suggestion only after confirmation, through the standard route', async ({ page, request }) => {
  await setup(request, { owner: 'decaid' });
  await page.goto(UI); await step(page, 4);
  await page.locator('#nativeAdviceSuggest').click();
  await expect(page.locator('#applyToGrinder')).toBeVisible();
  expect((await (await request.get('/__test/state')).json()).settingWrites).toEqual([]);
  await page.locator('#applyToGrinder').click();
  await expect(page.locator('#grinderAdjustStatus')).toContainText('Set the grinder to the suggested 620 deci-micrometre?');
  expect((await (await request.get('/__test/state')).json()).settingWrites).toEqual([]);
  await page.locator('#confirmApply').click();
  await expect(page.locator('#grinderAdjustStatus')).toContainText('Applied: the grinder was asked to set 62 (suggested 620 deci-micrometre)');
  const state = await (await request.get('/__test/state')).json();
  expect(state.settingWrites).toEqual([{ setting: '62' }]);
  const applied = Object.values(state.storage['grinderObservations.v1'].shots).find((record) => record.applied)?.applied;
  expect(applied.suggested).toEqual({ value: 620, unit: 'deci-micrometre' });
  expect(applied.applied).toEqual({ value: 62, unit: 'grinder display' });
});

test('without a settable grinder control, Apply is never offered', async ({ page, request }) => {
  await setup(request, { owner: 'decaid', controls: false });
  await page.goto(UI); await step(page, 4);
  const suggestion = page.waitForResponse((r) => new URL(r.url()).pathname === PREFIX + '/grinder-control');
  await page.locator('#nativeAdviceSuggest').click(); await suggestion;
  await expect(page.locator('#applyToGrinder')).toBeHidden();
});

test('shadow mode records the assisted suggestion beside the dial the grinder GBS moves to', async ({ page, request }) => {
  const { shots, base } = await setup(request, { owner: 'grinder', display: '63' });
  await storeShot(request, shots, base, 'shadow-1', 60000);
  // The grinder's own GBS moves the dial before the next shot.
  const { grinderObservation } = { grinderObservation: { info: { deviceId: DEVICE, observations: ['setting'], capabilities: ['grindSetting'],
    controls: { grindSetting: { kind: 'numeric', min: 0, max: 200, step: 1 } } }, snapshot: { timestamp: new Date().toISOString(), state: 'idle', observedSetting: '61' } } };
  await request.post('/__test/config', { data: { grinderObservation } });
  await storeShot(request, shots, base, 'shadow-2', 20000);
  await page.goto(UI); await step(page, 4);
  await page.locator('#nativeAdviceSuggest').click();
  await expect(page.locator('#grinderAdjustStatus')).toContainText('recorded for comparison only');
  await expect(page.locator('#applyToGrinder')).toBeHidden();
  await page.getByText('Grinder GBS vs assisted dial-in', { exact: true }).click();
  await page.locator('#loadGbsComparison').click();
  await expect(page.locator('#gbsComparisonList li').first()).toHaveText('Shot shadow-1: dial 63 — assisted: finer to 620 deci-micrometre — grinder GBS next: 61');
  expect((await (await request.get('/__test/state')).json()).settingWrites).toEqual([]);
});
