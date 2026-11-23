// Grinder data from the real E64 WS simulator (private research repository,
// located through E64_SIM_ROOT) reaches the served page through the unmodified
// E64 Decaid plugin. Missing simulator/plugin checkouts fail these tests unless
// E64_SIM_OPTIONAL=1 marks them as optional for this run.
const { test: base, expect } = require('@playwright/test');
const test = base.extend({ request: async ({ context }, use) => use(context.request) });
const PREFIX = '/api/v1/plugins/assisted-dialin.reaplugin';
const UI = PREFIX + '/ui';
const step = (page, number) => page.locator('nav button[data-native-step="' + number + '"]').click();
const pluginResponse = (page, endpoint, method = 'GET') => page.waitForResponse((r) => new URL(r.url()).pathname === PREFIX + '/' + endpoint && r.request().method() === method);

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
  const started = await request.post('/__test/sim', { data: { action: 'start' } });
  if (started.status() === 424 && process.env.E64_SIM_OPTIONAL === '1') {
    test.skip(true, 'E64 simulator unavailable (E64_SIM_OPTIONAL=1): ' + (await started.json()).error);
  }
  expect(started.status(), await started.text()).toBe(200);
});

const sim = async (request, dd) => {
  const response = await request.post('/__test/sim', { data: { dd } });
  expect(response.status()).toBe(200);
  return (await response.json()).snapshot;
};

test('the live setting the simulator reports reaches the page and the next-step suggestion', async ({ page, request }) => {
  expect((await sim(request, 630)).observedSetting).toBe('630 ddValueDum');
  // Current workflow without a recorded setting: only the live grinder can supply it.
  const { workflow } = await (await request.get('/__test/state')).json();
  delete workflow.context.grinderSetting;
  await request.post('/__test/config', { data: { workflow } });

  await page.goto(UI); await step(page, 1);
  const first = pluginResponse(page, 'grinder-observation'); await page.locator('#grinderObservation').click();
  expect((await (await first).json()).coordinate).toEqual({ value: 630, unit: 'deci-micrometre' });
  await expect(page.locator('#grinderObservationStatus')).toContainText('630 ddValueDum');
  await expect(page.locator('#grinderDiagnosticsLink')).toHaveAttribute('href', /^\/api\/v1\/plugins\/mahlkoenig-e64\.reaplugin\/e64-diagnostics\?ui=1&deviceId=plugin%3A/);

  // A dial change on the simulated grinder is what the page reads next.
  await sim(request, 700);
  const second = pluginResponse(page, 'grinder-observation'); await page.locator('#grinderObservation').click(); await second;
  await expect(page.locator('#grinderObservationStatus')).toContainText('700 ddValueDum');

  await page.locator('#modeToggle').click();
  const suggestion = pluginResponse(page, 'suggestion'); await page.locator('#suggestion').click();
  const body = await (await suggestion).json();
  expect(body.currentSettingSource).toBe('live-grinder-observation');
  expect(body.dialReference.currentNative.value).toBe(70);
  await expect(page.locator('#result')).toContainText('read live from the connected grinder: 700 ddValueDum');
});

test('a shot stored while the simulator reports a setting keeps it for later analysis', async ({ page, request }) => {
  await sim(request, 655);
  const { shots } = await (await request.get('/__test/state')).json();
  const stored = JSON.parse(JSON.stringify(shots[0]));
  stored.id = 'sim-recorded-shot';
  stored.timestamp = new Date(Date.now() - 30000).toISOString();
  delete stored.workflow.context.grinderSetting;
  await request.post('/__test/config', { data: { shots: [...shots, stored] } });
  await request.post('/__test/event', { data: { name: 'shotStored', payload: { id: stored.id } } });
  await expect.poll(async () => (await (await request.get('/__test/state')).json()).storage['grinderObservations.v1']?.shots?.[stored.id]?.ddValueDum).toBe(655);

  // A later dial change must not rewrite what was observed for that shot.
  await sim(request, 900);
  await page.goto(UI); await step(page, 3);
  await page.locator('#analysis input[name=shotId]').fill(stored.id);
  const analysis = pluginResponse(page, 'analysis', 'POST'); await page.locator('#analysis button').click();
  const body = await (await analysis).json();
  expect(body.context.grinderSetting).toBe('655');
  expect(body.context.grinderSettingSource).toBe('recorded-live-observation');
  expect(body.recordedGrinderObservation.ddValueDum).toBe(655);
});
