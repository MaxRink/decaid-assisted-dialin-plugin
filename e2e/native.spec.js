const { test: base, expect } = require('@playwright/test');
const test = base.extend({request: async ({context}, use) => use(context.request)});
const PREFIX = '/api/v1/plugins/assisted-dialin.reaplugin';
const UI = PREFIX + '/ui';
async function expert(page) { if (await page.locator('#modeToggle').getAttribute('aria-pressed') !== 'true') await page.locator('#modeToggle').click(); }
const pluginResponse = (page, endpoint, method = 'GET') => page.waitForResponse(r => new URL(r.url()).pathname === PREFIX + '/' + endpoint && r.request().method() === method);
const step = (page, number) => page.locator('nav button[data-native-step="' + number + '"]').click();
async function analyse(page, id = 'shot-1') {
  await step(page, 3); await page.locator('#analysis input[name=shotId]').fill(id);
  const result = pluginResponse(page, 'analysis', 'POST'); await page.locator('#analysis button').click();
  return (await result).json();
}
async function catalog(page) {
  await step(page, 1); await page.getByText('Browse coffee references and import a bean', { exact: true }).click();
  const response = pluginResponse(page, 'coffee-catalog'); await page.locator('#loadCoffeeCatalog').click();
  return (await response).json();
}
async function cardFor(page, product) {
  await page.locator('#nativeCoffeeSearch').fill(product.name);
  return page.locator('#coffeeCatalog .catalog-item').filter({ has: page.locator('strong').filter({hasText: product.name}) }).first();
}
async function preview(page, product) {
  const card = await cardFor(page, product); await card.getByRole('button', { name: 'Preview import' }).click();
  if (await card.locator('select').count()) await card.locator('select').selectOption('no');
  if (await card.locator('input[type=checkbox]').count()) await card.locator('input[type=checkbox]').check();
  return card;
}
async function compare(page) {
  await expert(page);
  const response = pluginResponse(page, 'research', 'POST'); await page.locator('#compareAll').click();
  return (await response).json();
}
async function setSupplement(page, algorithm, fields) {
  const enabled = page.locator('#native-' + algorithm + '-enabled');
  await enabled.locator('xpath=ancestor::details').locator('summary').click(); await enabled.check();
  for (const [name, value] of Object.entries(fields)) {
    const input = page.locator('#native-' + algorithm + '-' + name);
    if (await input.evaluate(node => node.tagName === 'SELECT')) await input.selectOption(String(value));
    else await input.fill(String(value));
  }
}

test.beforeEach(async ({ page, request, baseURL }) => {
  await request.post('/__test/reset');
  // Native host API uses the actual Decaid loopback port. Relay it to the
  // isolated real-handler fixture; no response bodies are fabricated here.
  await page.route('http://127.0.0.1:8080/**', async route => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href });
    await route.fulfill({ response, headers: {...response.headers(), 'access-control-allow-origin': baseURL, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS', 'access-control-allow-headers': 'content-type'} });
  });
  await page.goto(UI);
});

test('live grinder display uses the published snapshot DTO and surfaces unavailable state', async ({ page, request }) => {
  await step(page, 1);
  const response = pluginResponse(page, 'grinder-observation'); await page.locator('#grinderObservation').click();
  await response; await expect(page.locator('#grinderObservationStatus')).toContainText('501 ddValueDum');
  await request.post('/__test/config', {data: {grinderObservation: {info: {observations: ['setting'], capabilities: []}, snapshot: {timestamp: new Date().toISOString(), state: 'idle'}}}});
  const unavailable = pluginResponse(page, 'grinder-observation'); await page.locator('#grinderObservation').click(); await unavailable;
  await expect(page.locator('#grinderObservationStatus')).toContainText('missing');
});

test('all four wizard steps hide inactive content in both modes and expose all 104 profile policies', async ({ page }) => {
  for (const expert of [false, true]) {
    if (expert) await page.locator('#modeToggle').click();
    for (let number = 1; number <= 4; number++) {
      await step(page, number);
      await expect(page.locator('section[data-native-step]:visible')).toHaveCount(1);
      await expect(page.locator('#nativeWizardStatus')).toContainText('Step ' + number + ' of 4');
    }
    if (expert) await expect(page.locator('#compareStep > .expert-panel')).toBeVisible(); else await expect(page.locator('#compareStep > .expert-panel')).toBeHidden();
  }
  await step(page, 2); await page.locator('#loadProfiles').click();
  const select = page.locator('#nativeProfiles select'); await expect(select.locator('option')).toHaveCount(105);
  await select.selectOption({ index: 1 }); await expect(page.locator('#nativeProfiles')).toContainText('Timing adjustment:');
  await expect(page.locator('#nativeProfiles')).toContainText('not a runtime profile match');
  await expect(page.locator('#nativeRecipeContext')).toContainText('Analyse a saved shot');
});

test('real saved shot displays sensor units, phases, temperature, all three clocks and actual recipe', async ({ page }) => {
  const body = await analyse(page); expect(body.shotId).toBe('shot-1');
  await expect(page.locator('#traceGraph')).toBeVisible();
  await expect(page.locator('#traceGraphBody')).toContainText('Machine inlet flow (ml/s)');
  await expect(page.locator('#traceGraphBody')).toContainText('Beverage mass flow (g/s)');
  await expect(page.locator('#traceGraphBody')).toContainText('Pressure (bar)');
  await page.locator('#traceGraphBody details summary').click();
  await expect(page.locator('#traceGraphBody')).toContainText('Measured mix temperature (°C)');
  expect(body.metrics.trace.phases.length).toBeGreaterThan(0);
  await expert(page); await step(page, 4);
  for (const clock of ['pouring', 'recording', 'pump']) {
    await page.locator('#compare-clock').selectOption(clock);
    await expect(page.locator('#compare-actual')).toHaveValue(String(body.metrics.timing[clock].durationSec));
  }
  await step(page, 2); await expect(page.locator('#nativeRecipeContext')).toContainText('18 g');
  await expect(page.locator('#nativeRecipeContext')).toContainText('36 g');
});

test('feedback preserves zero sensory values, temperatures, manual completion and auxiliary weighing through plugin reload', async ({ page, request }) => {
  await analyse(page); const form = page.locator('#feedback');
  await form.locator('[name=shotId]').fill('shot-1'); await form.locator('[name=notes]').fill('Owner tasted after cooling');
  await form.locator('[name=overall]').selectOption('under-extracted'); await form.locator('[name=taste]').selectOption('sour');
  await form.getByText('Optional taste intensity details', {exact: true}).click(); await form.getByText('Optional brew and tasting temperature', {exact: true}).click();
  for (const [key, value] of Object.entries({acidity: 0, bitterness: 0, brewTimeSec: 29, brewTemperatureC: 93, tastingTemperatureC: 52, sinceBrewMin: 3})) await form.locator('[name=' + key + ']').fill(String(value));
  await form.locator('[name=manualStopConfirmed]').check();
  await form.getByText('Optional bean weighing record', {exact: true}).click();
  await form.locator('[name=confirmBeanMeasurement]').check(); await form.locator('[name=beanScaleId]').fill('aux-scale-1');
  await form.locator('[name=beanWeight]').fill('18.2'); await form.locator('[name=beanCapturedAt]').fill('2026-10-11T08:00');
  const response = pluginResponse(page, 'feedback', 'POST'); await form.getByRole('button', {name: 'Mark good', exact: true}).click();
  expect((await response).ok()).toBeTruthy(); await expect(page.locator('#result')).toContainText('Feedback saved');
  await request.post('/__test/reload'); const body = await analyse(page);
  expect(body.feedback.good).toBe(true); expect(body.feedback.manualStopConfirmed).toBe(true);
  expect(body.feedback.flavour.acidity).toBe(0); expect(body.feedback.flavour.tastingTemperatureC).toBe(52);
  expect(body.feedback.brewTimeClock).toBe('pump'); expect(body.measuredBeanDose.weightG).toBe(18.2);
  expect(body.measuredBeanDose.connectionRole).toBe('auxiliary');
  const unmark = pluginResponse(page, 'feedback', 'POST'); await form.getByRole('button', {name: 'Mark as not a good result'}).click(); await unmark;
  expect((await analyse(page)).feedback.good).toBe(false);
});

test('weighing validation recovers and unchecked measurements are omitted', async ({ page }) => {
  await step(page, 3); const form = page.locator('#feedback'); await form.locator('[name=shotId]').fill('shot-1');
  await form.getByText('Optional bean weighing record', {exact: true}).click(); await form.locator('[name=confirmBeanMeasurement]').check();
  await form.getByRole('button', {name: 'Mark good', exact: true}).click(); await expect(page.locator('#result')).toContainText('Confirm a positive bean weight');
  await expect(form.getByRole('button', {name: 'Mark good', exact: true})).toBeEnabled();
  await form.locator('[name=confirmBeanMeasurement]').uncheck();
  const response = pluginResponse(page, 'feedback', 'POST'); await form.getByRole('button', {name: 'Mark good', exact: true}).click();
  expect((await response).request().postDataJSON()).not.toHaveProperty('measuredBeanDose');
});

test('all ten calculators use structured independent inputs and preserve zero tolerance', async ({ page }) => {
  await analyse(page); await expert(page); await step(page, 4); await page.locator('#compare-target').fill('30'); await page.locator('#compare-tolerance').fill('0');
  const values = {
    effectiveDd: {grindDdDum: 500, grindDurationMs: 3000, effectiveBaseline: 50, residue: 50},
    grindTime: {mode: 3, recipeDdUm: 50, targetDdDum: 500, recipeTimeMs: 3000},
    inverseRegression: {x1: 50, y1: 32, x2: 60, y2: 25, targetSec: 28},
    proposedDd: {model: 'e64', roast: 'light', dose: 18},
    manual: {profile: 'df64_gen2', targetTimeSec: 28, actualTimeSec: 28, currentDial: 20, stepMarks: 1, numericFinerDelta: '-1', flavor: 'too sour'},
  };
  for (const [name, fields] of Object.entries(values)) await setSupplement(page, name, fields);
  const body = await compare(page); expect(body.results).toHaveLength(10);
  expect(body.results.every(row => row.status === 'computed')).toBeTruthy();
  expect(body.results.find(row => row.algorithm === 'manual').result.proposedDial).toBe(19);
  await expect(page.locator('#comparisonRows article')).toHaveCount(10);
  await page.locator('#native-manual-flavor').selectOption('balanced'); const balanced = await compare(page);
  expect(balanced.results.find(row => row.algorithm === 'manual').result.proposedDial).toBeNull();
});

test('native marks and incomplete pump clocks remain unavailable instead of becoming invented dD or times', async ({ page }) => {
  await analyse(page, 'shot-3'); await expert(page); await step(page, 4); await expect(page.locator('#compare-actual')).toHaveValue('');
  await page.locator('#compare-target').fill('30'); await page.locator('#compare-actual').fill('29');
  const body = await compare(page); expect(body.results.filter(row => row.status === 'computed')).toHaveLength(0);
  await expect(page.locator('#comparisonRows')).toContainText('Native marks are never guessed');
});

test('failed new analysis clears old graph and comparisons; retry recovers', async ({ page }) => {
  await analyse(page); await expert(page); await step(page, 4); await page.locator('#compare-target').fill('30'); await compare(page);
  expect(await page.locator('#comparisonRows article').count()).toBe(10);
  await analyse(page, 'missing-shot'); await expect(page.locator('#traceGraph')).toBeHidden();
  await expect(page.locator('#comparisonRows')).toBeEmpty(); await expect(page.locator('#result')).not.toContainText('Saved brew analysis: shot-1');
  await analyse(page); await expect(page.locator('#traceGraph')).toBeVisible();
});

test('catalog preview is read-only, bounded, imported with readback, and deduplicated', async ({ page, request }) => {
  const data = await catalog(page); expect(data.products).toHaveLength(82);
  await expect(page.locator('#coffeeCatalog .catalog-item')).toHaveCount(10);
  const product = data.products.find(item => item.beanEligible); expect(product).toBeTruthy();
  const before = await (await request.get('/__test/state')).json();
  const card = await preview(page, product);
  const previewed = await (await request.get('/__test/state')).json(); expect(previewed.beans).toEqual(before.beans);
  await card.getByRole('button', {name: 'Confirm import into host beans'}).click(); await expect(card).toContainText('Imported; host readback confirmed');
  await card.getByRole('button', {name: 'Confirm import into host beans'}).click(); await expect(card).toContainText('Already imported');
  const after = await (await request.get('/__test/state')).json();
  expect(after.beans.filter(bean => bean.extras?.catalogId === product.id)).toHaveLength(1);
  expect(after.beans.find(bean => bean.extras?.catalogId === product.id).extras.sourceOrigin).toBe(product.origin || null);
});

test('unsupported coffee formats cannot import; unknown format and decaf require explicit choices', async ({ page, request }) => {
  const data = await catalog(page), blocked = data.products.find(item => ['capsule', 'bundle', 'ground', 'ready-to-drink', 'green-bean'].includes(item.format));
  expect(blocked).toBeTruthy(); const blockedCard = await cardFor(page, blocked); await blockedCard.getByRole('button').click();
  await expect(blockedCard.getByRole('button', {name: 'Reference only'})).toBeDisabled();
  const unknown = data.products.find(item => !item.beanEligible && !['capsule', 'bundle', 'ground', 'ready-to-drink', 'green-bean'].includes(item.format));
  expect(unknown).toBeTruthy(); const card = await cardFor(page, unknown); await card.getByRole('button').click();
  const before = await (await request.get('/__test/state')).json(); await card.getByRole('button', {name: 'Confirm import into host beans'}).click();
  expect((await (await request.get('/__test/state')).json()).beans).toEqual(before.beans);
  await expect(card.locator('input[type=checkbox]')).toBeVisible();
});

test('network failures are visible, controls unlock, and retry uses actual handlers', async ({ page }) => {
  await page.route('**' + PREFIX + '/shots', route => route.abort()); await step(page, 3); await page.locator('#loadShots').click();
  await expect(page.locator('#result')).toContainText('Could not load recent shots'); await page.unroute('**' + PREFIX + '/shots');
  await page.locator('#loadShots').click(); await expect(page.locator('#shotSelect option')).toHaveCount(3);
  await page.route('**' + PREFIX + '/feedback', route => route.abort()); await page.locator('#feedback [name=shotId]').fill('shot-1');
  await page.locator('#feedback button[value=true]').click(); await expect(page.locator('#result')).toContainText('Could not save feedback');
  await expect(page.locator('#feedback button[value=true]')).toBeEnabled(); await page.unroute('**' + PREFIX + '/feedback');
  await page.locator('#feedback button[value=true]').click(); await expect(page.locator('#result')).toContainText('Feedback saved');
});

test('unsafe return links are hidden and feedback text renders as text after reload', async ({ page }) => {
  for (const target of ['javascript:alert(1)', 'https://evil.example/path', 'http://user:secret@127.0.0.1/path']) {
    await page.goto(UI + '?returnTo=' + encodeURIComponent(target)); await expect(page.locator('#returnLink')).toBeHidden();
  }
  await page.goto(UI + '?returnTo=' + encodeURIComponent('http://127.0.0.1:8080/shots')); await step(page, 3);
  await expect(page.locator('#returnLink')).toHaveAttribute('href', 'http://127.0.0.1:8080/shots');
  await page.locator('#feedback [name=shotId]').fill('shot-1'); await page.locator('#feedback [name=notes]').fill('<img src=x onerror="window.exploited=true">');
  await page.locator('#feedback button[value=true]').click(); await expect(page.locator('#result')).toContainText('Feedback saved');
  await analyse(page); expect(await page.evaluate(() => window.exploited)).toBeUndefined(); await expect(page.locator('#result img')).toHaveCount(0);
});

test('grinder create, update and selection persist without rewriting authoritative workflow identity', async ({ page, request }) => {
  await expert(page); await page.getByText('Individual grinder profiles and calibration', {exact: true}).click(); await page.locator('#loadGrinders').click();
  await expect(page.locator('#grinderProfileSelect option')).toHaveCount(2);
  await page.locator('#grinderProfileSelect').selectOption('__new__');
  await page.locator('#grinderModel').selectOption('DF64 Gen 2'); await page.locator('#grinderLabel').fill('My DF64');
  await page.locator('#grinderBurrs').fill('Owner burr set'); await page.locator('#grinderEpoch').fill('zero-2026-10');
  await page.locator('#grinderPitchSource').fill('Owner verified physical direction'); await page.locator('#saveGrinder').click();
  await expect(page.locator('#grinderManagerStatus')).toContainText('Saved host grinder');
  const id = await page.locator('#grinderProfileSelect').inputValue(); expect(id).not.toBe('grinder-1');
  await page.locator('#grinderLabel').fill('My calibrated DF64'); await page.locator('#saveGrinder').click();
  await expect(page.locator('#grinderManagerStatus')).toContainText('Saved host grinder'); await page.locator('#selectGrinder').click();
  await expect(page.locator('#grinderManagerStatus')).toContainText('Using DF64 Gen 2');
  let state = await (await request.get('/__test/state')).json(); expect(state.grinders).toHaveLength(2);
  expect(state.workflow.context.grinderId).toBe('grinder-1');
  await request.post('/__test/reload'); await page.reload(); await expert(page); await page.getByText('Individual grinder profiles and calibration', {exact: true}).click(); await page.locator('#loadGrinders').click();
  await expect(page.locator('#grinderProfileSelect option')).toHaveCount(3); await page.locator('#grinderProfileSelect').selectOption(id);
  await expect(page.locator('#grinderLabel')).toHaveValue('My calibrated DF64');
  const settings = await (await request.get(PREFIX + '/settings')).json(); expect(settings.GrinderProfileId).toBe(id);
});

test('catalog host lookup failure prevents writes and retries; concurrent clicks produce one bean', async ({ page, request }) => {
  const data = await catalog(page), product = data.products.find(item => item.beanEligible), card = await preview(page, product);
  const before = await (await request.get('/__test/state')).json();
  await request.post('/__test/config', {data: {failPath: '/api/v1/beans', status: 503}});
  await card.getByRole('button', {name: 'Confirm import into host beans'}).click(); await expect(card).toContainText('Injected host failure');
  let state = await (await request.get('/__test/state')).json(); expect(state.beans).toEqual(before.beans);
  expect(state.requests.filter(r => r.path === '/api/v1/beans' && r.method === 'POST')).toHaveLength(0);
  await request.post('/__test/config', {data: {failPath: null, delayPath: '/api/v1/beans', delayMs: 150}});
  await card.getByRole('button', {name: 'Confirm import into host beans'}).evaluate(button => { button.click(); button.click(); });
  await expect(card).toContainText('Imported; host readback confirmed');
  state = await (await request.get('/__test/state')).json(); expect(state.beans.filter(bean => bean.extras?.catalogId === product.id)).toHaveLength(1);
  expect(state.requests.filter(r => r.path === '/api/v1/beans' && r.method === 'POST')).toHaveLength(1);
});

test('storage failure is surfaced and a reload enables an explicit retry without false saved feedback', async ({ page, request }) => {
  await request.post('/__test/config', {data: {storageFail: true}}); await step(page, 3);
  await page.locator('#feedback [name=shotId]').fill('shot-1'); await page.locator('#feedback button[value=true]').click();
  await expect(page.locator('#result')).toContainText(/storage|save|Reload/i, {timeout: 20000});
  await expect(page.locator('#result')).not.toContainText('Feedback saved'); await expect(page.locator('#feedback button[value=true]')).toBeEnabled();
  const state = await (await request.get('/__test/state')).json(); expect(state.storage['feedback.v1']?.['shot-1']).toBeUndefined();
  await request.post('/__test/config', {data: {storageFail: false}}); await request.post('/__test/reload');
  await page.locator('#feedback button[value=true]').click(); await expect(page.locator('#result')).toContainText('Feedback saved');
});

test('D-Flow traces remain observed flow evidence and recipe display never licenses elapsed-time conversion', async ({ page }) => {
  const body = await analyse(page, 'shot-2'); expect(body.metrics.trace.controlMode).toMatch(/flow|hybrid|dynamic/i);
  await expect(page.locator('#traceGraph')).toBeVisible(); await expect(page.locator('#traceGraphBody')).toContainText('Beverage mass flow');
  await step(page, 2); await expect(page.locator('#nativeRecipeContext')).toContainText('do not alter this saved evidence');
  await page.locator('#loadProfiles').click(); const select = page.locator('#nativeProfiles select'); await expect(select.locator('option')).toHaveCount(105);
  const option = await select.locator('option').evaluateAll(options => options.find(option => /D-Flow/i.test(option.textContent))?.value);
  expect(option).toBeTruthy(); await select.selectOption(option); await expect(page.locator('#nativeProfiles')).toContainText('saved controller steps');
});

test('populated native content stays within a narrow mobile viewport in all steps', async ({ page }) => {
  await page.setViewportSize({width: 375, height: 812});
  await catalog(page); await page.locator('#coffeeCatalog > button').click();
  await analyse(page); await page.locator('#traceGraphBody details summary').click();
  await expert(page); await step(page, 4); await page.locator('#compare-target').fill('30'); await compare(page);
  await page.locator('#compareStep details.expert-panel > summary').click();
  for (let number = 1; number <= 4; number++) {
    await step(page, number);
    const overflow = await page.evaluate(() => ({viewport: innerWidth, width: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll('section[data-native-step]:not([hidden]) *')].filter(node => node.getClientRects().length && node.getBoundingClientRect().right > innerWidth + 1).map(node => node.tagName + '#' + node.id)}));
    expect(overflow.width).toBeLessThanOrEqual(overflow.viewport + 1); expect(overflow.offenders).toEqual([]);
  }
});

test('beginner native guidance gives a concrete owner-confirmed dial step and a second balanced shot retains it', async ({ page, request }) => {
  const state = await (await request.get('/__test/state')).json();
  state.shots[0].workflow.context.grinderModel = 'DF64 Gen 2'; state.shots[0].workflow.context.grinderSetting = '20'; state.shots[0].workflow.context.extras.grinderSettingUnit = 'dial-mark';
  await request.post('/__test/config', {data: {shots: state.shots, workflow: state.shots[0].workflow}});
  await analyse(page); await step(page, 4);
  await expect(page.locator('#compareAll')).toBeHidden(); await expect(page.locator('#nativeNextStep')).toBeVisible();
  await page.locator('#nativeAdviceManual > summary').click(); await page.locator('#nativeAdviceModel').selectOption('df64_gen2');
  await page.locator('#nativeAdviceCurrent').fill('20'); await page.locator('#nativeAdviceStep').fill('1');
  await page.locator('#nativeAdviceDirection').selectOption('-1'); await page.locator('#nativeAdviceActual').fill('24'); await page.locator('#nativeAdviceTarget').fill('30');
  await page.locator('#nativeAdviceTaste').selectOption('too sour'); await page.locator('#nativeAdviceConfirm').check();
  await page.locator('#nativeAdviceForm button').click(); await expect(page.locator('#nativeAdviceResult')).toContainText('Try 19 marks next (currently 20; 1 mark finer)');
  await expect(page.locator('#nativeAdviceResult')).toContainText('Keep dose and beverage weight unchanged');
  state.shots[0].workflow.context.grinderSetting = '19'; await request.post('/__test/config', {data: {shots: state.shots, workflow: state.shots[0].workflow}});
  await analyse(page); await step(page, 4); await page.locator('#nativeAdviceCurrent').fill('19'); await page.locator('#nativeAdviceActual').fill('30'); await page.locator('#nativeAdviceTaste').selectOption('balanced'); await page.locator('#nativeAdviceConfirm').check();
  await page.locator('#nativeAdviceForm button').click(); await expect(page.locator('#nativeAdviceResult')).toContainText('Keep 19 marks for now');
  await expect(page.locator('#nativeAdviceResult')).not.toContainText('dD');
});

test('beginner exact dial guidance is withheld for a different grinder, dynamic profile, or uncertain preparation signal', async ({ page, request }) => {
  await analyse(page); await step(page, 4); await page.locator('#nativeAdviceManual > summary').click();
  await page.locator('#nativeAdviceModel').selectOption('df64_gen2'); await page.locator('#nativeAdviceCurrent').fill('20'); await page.locator('#nativeAdviceStep').fill('1');
  await page.locator('#nativeAdviceDirection').selectOption('-1'); await page.locator('#nativeAdviceActual').fill('24'); await page.locator('#nativeAdviceTarget').fill('30'); await page.locator('#nativeAdviceConfirm').check();
  await page.locator('#nativeAdviceForm button').click(); await expect(page.locator('#nativeAdviceResult')).toContainText('selected grinder must match');
  await analyse(page, 'shot-2'); await step(page, 4); await page.locator('#nativeAdviceConfirm').check(); await page.locator('#nativeAdviceForm button').click();
  await expect(page.locator('#nativeAdviceResult')).toContainText('cannot support a time-based dial adjustment');
  const state = await (await request.get('/__test/state')).json(); state.shots[0].workflow.context.grinderModel = 'DF64 Gen 2'; state.shots[0].workflow.context.grinderSetting = '20'; state.shots[0].workflow.context.extras.grinderSettingUnit = 'dial-mark';
  await request.post('/__test/config', {data: {shots: state.shots}}); await analyse(page); await step(page, 4);
  await page.locator('#nativeAdviceTaste').selectOption('channeling'); await page.locator('#nativeAdviceConfirm').check(); await page.locator('#nativeAdviceForm button').click();
  await expect(page.locator('#nativeAdviceResult')).toContainText('Keep 20 marks for now'); await expect(page.locator('#nativeAdviceResult')).toContainText('does not identify a reliable dial change');
});

test('beginner manual confirmation cannot leak between shots and interrupted shots never produce a dial proposal', async ({ page, request }) => {
  const state = await (await request.get('/__test/state')).json(); state.shots[0].workflow.context.grinderModel = 'DF64 Gen 2'; state.shots[0].finalStopReason = 'stoppingBackstop';
  await request.post('/__test/config', {data: {shots: state.shots}}); await analyse(page); await step(page, 4); await page.locator('#nativeAdviceManual > summary').click();
  await page.locator('#nativeAdviceModel').selectOption('df64_gen2'); await page.locator('#nativeAdviceCurrent').fill('20'); await page.locator('#nativeAdviceStep').fill('1');
  await page.locator('#nativeAdviceDirection').selectOption('-1'); await page.locator('#nativeAdviceActual').fill('24'); await page.locator('#nativeAdviceTarget').fill('30'); await page.locator('#nativeAdviceConfirm').check();
  await page.locator('#nativeAdviceForm button').click(); await expect(page.locator('#nativeAdviceResult')).toContainText('interrupted machine stop');
  await analyse(page); await step(page, 4); await expect(page.locator('#nativeAdviceConfirm')).not.toBeChecked();
  await page.locator('#nativeAdviceCurrent').fill(''); await page.locator('#nativeAdviceForm button').click();
  expect(await page.locator('#nativeAdviceCurrent').evaluate(input => input.validity.valueMissing)).toBe(true);
});

test('beginner suggestion failure appears next to the action and can be retried', async ({ page }) => {
  await step(page, 4); await page.route('**' + PREFIX + '/suggestion', route => route.abort());
  await page.locator('#nativeAdviceSuggest').click(); await expect(page.locator('#nativeNextStep')).toContainText('Could not load the next setting');
  await expect(page.locator('#nativeNextStep')).toBeVisible(); await page.unroute('**' + PREFIX + '/suggestion');
  await page.locator('#nativeAdviceSuggest').click(); await expect(page.locator('#nativeNextStep')).toContainText('Keep the current dial setting for now');
  await expect(page.locator('#nativeNextStep')).not.toContainText('dD');
});

test('E64 beginner advice uses confirmed native micrometres and never physical rotation or a mark conversion', async ({ page, request }) => {
  const state = await (await request.get('/__test/state')).json(); state.shots[0].workflow.context.grinderSetting = '600';
  await request.post('/__test/config', {data: {shots: state.shots}}); await analyse(page); await step(page, 4); await page.locator('#nativeAdviceManual > summary').click();
  await page.locator('#nativeAdviceModel').selectOption('e64ws'); await expect(page.locator('#nativeAdviceStepLabel')).toContainText('µm');
  await page.locator('#nativeAdviceCurrent').fill('60'); await page.locator('#nativeAdviceStep').fill('2'); await page.locator('#nativeAdviceDirection').selectOption('-1');
  await page.locator('#nativeAdviceActual').fill('24'); await page.locator('#nativeAdviceTarget').fill('30'); await page.locator('#nativeAdviceConfirm').check();
  await page.locator('#nativeAdviceForm button').click(); await expect(page.locator('#nativeAdviceResult')).toContainText('Taste the shot');
  await page.locator('#nativeAdviceTaste').selectOption('too sour'); await page.locator('#nativeAdviceCurrent').fill('80');
  await page.locator('#nativeAdviceForm button').click(); await expect(page.locator('#nativeAdviceResult')).toContainText('recorded at 60 µm');
  await page.locator('#nativeAdviceCurrent').fill('60');
  const response = pluginResponse(page, 'research', 'POST'); await page.locator('#nativeAdviceForm button').click();
  const reply = await response, payload = reply.request().postDataJSON(), body = await reply.json();
  expect(payload.input.settingUnit).toBe('micrometres'); expect(payload.input.stepNative).toBe(2); expect(payload.input).not.toHaveProperty('stepMarks');
  expect(body.result.physicalTurn).toBeNull(); expect(body.result.proposedDial).toBe(58);
  await expect(page.locator('#nativeAdviceResult')).toContainText('58 µm next (currently 60; 2 µm finer)');
  await expect(page.locator('#nativeAdviceResult')).not.toContainText(/clockwise|counterclockwise|dD/);
  await page.locator('#nativeAdviceModel').selectOption('df54'); await expect(page.locator('#nativeAdviceCurrent')).toHaveValue(''); await expect(page.locator('#nativeAdviceStep')).toHaveValue('');
  await expect(page.locator('#nativeAdviceDirection')).toHaveValue(''); await expect(page.locator('#nativeAdviceConfirm')).not.toBeChecked();
});

test('beginner recorded-good advice shows verified E64 native units instead of the stored research coordinate', async ({ page }) => {
  await analyse(page); await page.locator('#feedback [name=shotId]').fill('shot-1'); await page.locator('#feedback [name=taste]').selectOption('balanced');
  await page.locator('#feedback button[value=true]').click(); await expect(page.locator('#result')).toContainText('Feedback saved');
  await step(page, 1); const response = pluginResponse(page, 'recommendation'); await page.locator('#recommend').click();
  expect((await (await response).json()).status).toBe('recommendation'); await expect(page.locator('#result')).toContainText('63 µm');
  await expect(page.locator('#result')).not.toContainText('630'); await expect(page.locator('#result')).toContainText('not a live hardware reading');
});
