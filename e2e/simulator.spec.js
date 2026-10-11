const {test: base, expect} = require('@playwright/test');
const test = base.extend({request: async ({context}, use) => use(context.request)});
const fs = require('node:fs/promises');
const lab = '/simulator/';
const step = (page, n) => page.locator(`button[data-wizard-step="${n}"]`).click();
const file = (name, data) => ({name, mimeType: 'application/json', buffer: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))});
async function downloadJSON(page, click) {
  const waiting = page.waitForEvent('download'); await click();
  return JSON.parse(await fs.readFile(await (await waiting).path(), 'utf8'));
}
async function seed(page) {
  await page.goto(lab); await expect(page.locator('#notice')).toContainText('Ready');
  await step(page, 2); await page.locator('#noise').fill('0'); await page.locator('#next').click();
}
test.beforeEach(async ({page, request}) => {
  await request.post('/__test/reset');
  await page.addInitScript(() => localStorage.setItem('decaid.assisted-dialin.view-mode', 'expert'));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.__browserErrors = errors;
});
test.afterEach(async ({page}) => { expect(page.__browserErrors).toEqual([]); });

test('all four steps and both modes fit five screen widths', async ({page}, info) => {
  test.setTimeout(120000);
  await page.goto(lab);
  for (const width of [320, 375, 768, 1024, 1440]) {
    await page.setViewportSize({width, height: 900});
    for (const mode of ['simple', 'expert']) {
      await step(page, 1); await page.locator('#view-mode').selectOption(mode);
      for (const n of [1,2,3,4]) {
        await step(page, n);
        await expect(page.locator('#wizard-status')).toContainText(`Step ${n} of 4`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await page.locator('section[data-wizard-step]:visible').evaluateAll(nodes => nodes.every(n => n.dataset.wizardStep === document.querySelector('button[aria-current="step"]').dataset.wizardStep))).toBe(true);
      }
    }
  }
  await page.setViewportSize({width:375,height:900}); await step(page,1);
  await page.screenshot({path: info.outputPath('phone-setup.png'), fullPage: true});
});

test('mode, theme and individual grinder selection survive reload', async ({page}) => {
  await page.goto(lab); await page.locator('#view-mode').selectOption('expert');
  await page.locator('#theme').click(); const theme = await page.locator('body').getAttribute('class');
  const selected = await page.locator('#grinder-instance').inputValue();
  await page.reload(); await expect(page.locator('#view-mode')).toHaveValue('expert');
  await expect(page.locator('#grinder-instance')).toHaveValue(selected);
  expect(await page.locator('body').getAttribute('class')).toBe(theme);
});

for (const algorithm of ['GbS1','GbS2','GbS3','GbS4','DdEff']) test(`${algorithm} can brew, replay and compare independent results`, async ({page}) => {
  await page.goto(lab); await page.locator('#algorithm').selectOption(algorithm);
  await step(page,2); await page.locator('#noise').fill('0');
  await page.locator('#next').click(); await page.locator('#next').click(); await page.locator('#next').click();
  await step(page,3); await expect(page.locator('#shots tr')).toHaveCount(3);
  await step(page,4); await expect(page.locator('#result')).not.toContainText('Run a shot');
  await expect(page.locator('#compare article')).toHaveCount(5);
  await page.locator('#compare-all-lab').click();
  await expect(page.locator('#all-comparison-results article')).toHaveCount(10);
  for (const name of ['GbS1','GbS2','GbS3','GbS4','DdEff']) await expect(page.locator('#all-comparison-results')).toContainText(name + ' · computed');
  const before = await page.locator('#result').textContent(); await page.locator('#replay').click();
  await expect(page.locator('#result')).toHaveText(before);
});

test('planned shots preserve explicit times and context changes clear history', async ({page}) => {
  await seed(page); await step(page,3); await page.locator('#add').click();
  const second = page.locator('#shots tr').nth(1); await second.locator('input').nth(1).fill('24');
  await second.locator('input').nth(1).dispatchEvent('change');
  await step(page,2); await page.locator('#run').click(); await step(page,3);
  await expect(page.locator('#shots tr').nth(1).locator('input').nth(1)).toHaveValue('24');
  await step(page,1); await page.locator('#bean').fill('Different lot'); await page.locator('#bean').dispatchEvent('change');
  await step(page,3); await expect(page.locator('#shots tr')).toHaveCount(0);
});

test('scenario download/import replays and rejects invalid input atomically', async ({page}) => {
  await seed(page); await step(page,4);
  const exported = await downloadJSON(page, () => page.locator('#export').click());
  expect(exported.shots).toHaveLength(1);
  await page.locator('#import').setInputFiles(file('scenario.json', exported));
  await expect(page.locator('#notice')).toContainText('imported and replayed');
  const previousBean = exported.setup.bean;
  const invalid = structuredClone(exported); invalid.setup.bean = 'Must not be applied'; invalid.shots[0].actual = 999999;
  await page.locator('#import').setInputFiles(file('bad.json', invalid));
  await expect(page.locator('#notice')).toContainText('invalid'); await step(page,1);
  await expect(page.locator('#bean')).toHaveValue(previousBean);
  await step(page,4); await page.locator('#import').setInputFiles(file('malformed.json','{'));
  await expect(page.locator('#notice')).toHaveClass(/error/);
});

test('profile reference inventory never overwrites a recipe or observed trace', async ({page}) => {
  await page.goto(lab); await step(page,2);
  const picker = page.locator('#profile-picker select'); await expect(picker.locator('option')).toHaveCount(105);
  const target = await page.locator('#target').inputValue();
  const id = await picker.locator('option').evaluateAll(options => options.find(x => /d.flow/i.test(x.textContent))?.value);
  expect(id).toBeTruthy(); await picker.selectOption(id);
  await expect(page.locator('#profile-picker')).toContainText('matching name is not');
  await expect(page.locator('#target')).toHaveValue(target);
});

test('catalog search is bounded, preview-only and safely displays publisher fields', async ({page, request}) => {
  await page.goto(lab); await page.getByText('Browse coffee catalogues and reviewed starting points',{exact:true}).click();
  await expect(page.locator('#coffee-catalog article').first()).toBeVisible();
  expect(await page.locator('#coffee-catalog article').count()).toBeLessThanOrEqual(12);
  await page.locator('#coffee-catalog-search').fill('Apas');
  await expect(page.locator('#coffee-catalog')).toContainText('Apas');
  const original = await request.get('/__test/state').then(r=>r.json());
  const button = page.locator('#coffee-catalog article').first().getByRole('button'); await button.click();
  const after = await request.get('/__test/state').then(r=>r.json());
  expect(after.beans).toEqual(original.beans); expect(after.requests.filter(x=>x.method==='POST')).toHaveLength(0);
});

test('real trace import exposes distinct clocks and all measured signal units', async ({page, request}, info) => {
  const state = await request.get('/__test/state').then(r=>r.json()); await page.goto(lab); await step(page,3);
  await page.locator('#shot-trace-import').setInputFiles(file('shot.json',state.shots[0]));
  await expect(page.locator('#shot-trace-status')).toContainText('shot-1');
  await expect(page.locator('#actual-shot-time')).toHaveValue('29');
  await expect(page.locator('#actual-shot-trace')).toContainText('Machine inlet ml/s and beverage g/s are different');
  for (const name of ['machineFlow','pressure','beverageFlowGPerSec']) expect(await page.locator(`#actual-shot-trace [data-series="${name}"]`).count()).toBeGreaterThan(0);
  await page.locator('#actual-shot-clock').selectOption('pouring'); await expect(page.locator('#actual-shot-time')).toHaveValue('25');
  await page.locator('#actual-shot-clock').selectOption('recording'); await expect(page.locator('#actual-shot-time')).toHaveValue('31');
  await page.screenshot({path: info.outputPath('actual-shot-graph.png'),fullPage:true});
});

test('invalid trace import preserves prior shot and gaps do not create a pump duration', async ({page, request}) => {
  const state = await request.get('/__test/state').then(r=>r.json()); await page.goto(lab); await step(page,3);
  await page.locator('#shot-trace-import').setInputFiles(file('shot.json',state.shots[0]));
  await page.locator('#shot-trace-import').setInputFiles(file('bad.json',{id:'bad',timestamp:'bad',measurements:[]}));
  await expect(page.locator('#notice')).toHaveClass(/error/); await expect(page.locator('#shot-trace-status')).toContainText('shot-1');
  const gapped = state.shots[0]; gapped.measurements = gapped.measurements.filter((_,i)=>i<3||i>15);
  await page.locator('#shot-trace-import').setInputFiles(file('gapped.json',gapped));
  await expect(page.locator('#actual-shot-time')).toHaveValue('');
  await page.locator('#actual-shot-clock').selectOption('recording'); await expect(page.locator('#actual-shot-time')).toHaveValue('31');
});

test('taste, cup temperature, timing and manual-stop confirmation round-trip', async ({page, request}) => {
  const state=await request.get('/__test/state').then(r=>r.json()); const shot=state.shots[0]; shot.finalStopReason='appStop';
  await page.goto(lab);await step(page,3);await page.locator('#shot-trace-import').setInputFiles(file('shot.json',shot));
  await page.locator('#assist-taste').selectOption('sour');await page.locator('#assist-overall').selectOption('under-extracted');
  await page.locator('#taste-temperature').fill('55');await page.locator('#taste-minutes').fill('4');await page.locator('#manual-stop-confirmed').check();
  const exported=await downloadJSON(page,()=>page.locator('#export-shot-trace').click());
  expect(exported.feedback.manualStopConfirmed).toBe(true);expect(exported.feedback.flavour.tastingTemperatureC).toBe(55);
  await page.locator('#clear-shot-trace').click();await expect(page.locator('#manual-stop-confirmed')).not.toBeChecked();
  await page.locator('#shot-trace-import').setInputFiles(file('feedback.json',exported));
  await expect(page.locator('#taste-temperature')).toHaveValue('55');await expect(page.locator('#manual-stop-confirmed')).toBeChecked();
  await step(page,4);await page.locator('#assist').click();await expect(page.locator('#assist-result')).toContainText('Saved shot shot-1');
});

test('D-Flow profile uses actual controller gating instead of generic time advice', async ({page, request}) => {
  const state=await request.get('/__test/state').then(r=>r.json());await page.goto(lab);await step(page,3);
  await page.locator('#shot-trace-import').setInputFiles(file('dflow.json',state.shots[1]));
  await page.locator('#assist-overall').selectOption('under-extracted');await step(page,4);await page.locator('#assist').click();
  await expect(page.locator('#assist-result')).toContainText('abstain');
  await expect(page.locator('#assist-result')).toContainText(/controller|flow/i);
});

test('all supporting calculators use enabled explicit measurements', async ({page}) => {
  await seed(page);await step(page,4);
  const inputs={effectiveDd:{grindDdDum:630,grindDurationMs:3000,effectiveBaseline:63,residue:0},grindTime:{recipeDdUm:63,targetDdDum:650,recipeTimeMs:3000},inverseRegression:{x1:50,y1:20,x2:60,y2:30,targetSec:25},proposedDd:{dose:18},manual:{targetTimeSec:28,actualTimeSec:24,currentDial:20,stepMarks:1}};
  for(const [name, values] of Object.entries(inputs)){const details=page.locator('#all-comparison-inputs details').filter({has:page.locator(`#lab-${name}-enabled`)});await details.locator('summary').click();await page.locator(`#lab-${name}-enabled`).check();for(const [key,value] of Object.entries(values))await page.locator(`#lab-${name}-${key}`).fill(String(value));}
  await page.locator('#lab-grindTime-mode').selectOption('3');await page.locator('#lab-manual-numericFinerDelta').selectOption('-1');await page.locator('#lab-manual-flavor').selectOption('too sour');
  await page.locator('#compare-all-lab').click();await expect(page.locator('#all-comparison-results article')).toHaveCount(10);
  await expect(page.locator('#all-comparison-results h3')).toHaveText(['GbS1 · computed','GbS2 · computed','GbS3 · computed','GbS4 · computed','DdEff · computed','effectiveDd · computed','grindTime · computed','inverseRegression · computed','proposedDd · computed','manual · computed']);
});

test('missing reference APIs surface failure without preventing experiment use', async ({page}) => {
  await page.route('**/data/coffee-catalog.json',route=>route.fulfill({status:503,body:'unavailable'}));
  await page.goto(lab);await page.getByText('Browse coffee catalogues and reviewed starting points',{exact:true}).click();
  await expect(page.locator('#coffee-catalog')).toContainText(/unavailable|could not/i);
  await page.unroute('**/data/coffee-catalog.json');
  await page.getByRole('button',{name:'Retry coffee catalogue'}).click();
  await expect(page.locator('#coffee-catalog article').first()).toBeVisible();
  await step(page,2);await page.locator('#next').click();await step(page,3);await expect(page.locator('#shots tr')).toHaveCount(1);
});

test('grinder reference failure is visible in Simple mode and retry preserves the owner dial', async ({page}) => {
  await page.route('**/data/grinder-dials.json',route=>route.fulfill({status:503,body:'unavailable'}));
  await page.goto(lab);await page.locator('#view-mode').selectOption('simple');
  await expect(page.locator('#grinder-load-status')).toContainText(/unavailable/i);
  await page.locator('#simple-current-dial').fill('20');
  await page.unroute('**/data/grinder-dials.json');
  await page.getByRole('button',{name:'Retry grinder references'}).click();
  await expect(page.locator('#grinder-load-status')).toBeEmpty();
  await expect(page.locator('#simple-current-dial')).toHaveValue('20');
});

test('decision gallery opens every diagram and fits mobile without broken images', async ({page}) => {
  const diagramCount = (await fs.readdir('docs/decision-trees')).filter(name=>name.endsWith('.mmd')).length;
  await page.goto('/docs/decision-trees/');await expect(page.locator('.card')).toHaveCount(diagramCount);
  await page.setViewportSize({width:320,height:900});
  for(const details of await page.locator('.card details').all())await details.locator('summary').click();
  for (const image of await page.locator('.diagram img').all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(()=>image.evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
