const {test, expect} = require('@playwright/test');
const step = (page, n) => page.locator(`button[data-wizard-step="${n}"]`).click();
async function setup(page, model = 'DF54') {
  await page.goto('/simulator/');
  await expect(page.locator('#view-mode')).toHaveValue('simple');
  await page.locator('#grinder').selectOption(model);
  await page.locator('#simple-current-dial').fill('20');
  await page.locator('#simple-dial-setup summary').click();
  await page.locator('#simple-step').fill('0.5');
  await page.locator('#simple-finer').selectOption('-1');
  await page.locator('#simple-confirm-dial').check();
  await step(page, 2); await page.locator('#target').fill('28');
  await step(page, 3);
}
async function shot(page, time, taste, compatible = true) {
  await page.locator('#simple-time').fill(String(time));
  await page.locator('#simple-taste').selectOption(taste);
  await page.locator('#simple-clock-confirmed').check();
  await page.locator('#simple-pressure-confirmed').setChecked(compatible);
  await page.locator('#simple-record').click();
  await expect(page.locator('#simple-advice')).toBeVisible();
}

for (const model of ['DF54', 'DF64 Gen 1', 'DF64 Gen 2']) test(`beginner plays three real entered shots on ${model} in dial marks`, async ({page}, info) => {
  await setup(page, model);
  await shot(page,22,'too sour');
  await expect(page.locator('#simple-advice')).toContainText('from 20 to 19.5 marks');
  await expect(page.locator('#simple-advice')).not.toContainText(/dD|GbS/);
  await page.locator('#simple-continue').click();
  await expect(page.locator('#simple-time')).toHaveValue('');
  await expect(page.locator('#simple-clock-confirmed')).not.toBeChecked();
  await shot(page,26,'too sour');
  await expect(page.locator('#simple-advice')).toContainText('from 19.5 to 19 marks');
  await page.locator('#simple-continue').click();
  await shot(page,28,'balanced');
  await expect(page.locator('#simple-advice')).toContainText('Keep the grinder at 19 marks');
  await expect(page.locator('#simple-history li')).toHaveCount(3);
  await page.setViewportSize({width:375,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('beginner-three-shots.png'),fullPage:true});
});

test('first shot asks for confirmed dial movement instead of guessing numbers', async ({page}) => {
  await page.goto('/simulator/');await page.locator('#grinder').selectOption('DF54');
  await page.locator('#simple-current-dial').fill('20');await step(page,3);
  await shot(page,20,'too sour');
  await expect(page.locator('#simple-advice')).toContainText('Keep the grinder at 20');
  await expect(page.locator('#simple-advice')).toContainText('confirm a small step');
});

test('E64 WS gives owner-confirmed steps in native micrometres', async ({page}) => {
  await setup(page, 'E64 WS');await step(page,1);
  await page.locator('#simple-current-dial').fill('63');
  await page.locator('#simple-step').fill('1');await step(page,3);
  await shot(page,22,'too sour');
  await expect(page.locator('#simple-advice')).toContainText('from 63 to 62');
  await expect(page.locator('#simple-advice')).toContainText('micrometres');
  await expect(page.locator('#simple-advice')).not.toContainText(/marks|clockwise|dD/);
});

test('flow-controlled and uneven shots give preparation checks without a numbered move', async ({page}) => {
  await setup(page);
  await shot(page,22,'too sour',false);
  await expect(page.locator('#simple-advice')).toContainText('Keep the grinder at 20');
  await expect(page.locator('#simple-advice')).toContainText('programmed flow target');
  await page.locator('#simple-continue').click();await shot(page,22,'channeling');
  await expect(page.locator('#simple-advice')).toContainText('evenly prepared');
  await expect(page.locator('#simple-advice')).toContainText('Keep the grinder at 20');
});

test('fictional practice is clearly labelled over three shots and resets before real coffee', async ({page}) => {
  await page.goto('/simulator/');await page.locator('#simple-start-practice').click();await step(page,3);
  for(let i=0;i<3;i++) {
    await page.locator('#simple-practice').click();
    await expect(page.locator('#simple-advice')).toContainText('fictional shot times');
    if(i<2)await page.locator('#simple-continue').click();
  }
  await expect(page.locator('#simple-history li')).toHaveCount(3);
  await page.locator('#simple-new').click();await expect(page.locator('#simple-current-dial')).toHaveValue('');
  await expect(page.locator('#simple-history li')).toHaveCount(0);
});

const row = (page, algorithm) => page.locator(`#all-comparison-results article[data-algorithm="${algorithm}"]`);
const names = ['GbS1','GbS2','GbS3','GbS4','DdEff','effectiveDd','grindTime','inverseRegression','proposedDd','manual'];
test('Simple lists every approach before a brew and explains missing evidence', async ({page}) => {
  await page.goto('/simulator/'); await step(page,4);
  await expect(page.locator('#all-comparison-results article')).toHaveCount(10);
  for (const name of names) { await expect(row(page,name)).toBeVisible(); await expect(row(page,name)).toContainText('Why:'); }
  await expect(row(page,'GbS1')).toHaveAttribute('data-status','unavailable');
  await expect(row(page,'GbS1')).toContainText('recorded shot with its measured grinder coordinate');
  await expect(row(page,'proposedDd')).toContainText('unit cannot be used as a dial');
});
test('uncalibrated DF54 shows manual dial advice and explicit research limits', async ({page}) => {
  await setup(page); await shot(page,22,'too sour');
  await expect(page.locator('#all-comparison-results article')).toHaveCount(10);
  await expect(row(page,'manual')).toHaveAttribute('data-status','computed');
  await expect(row(page,'manual')).toContainText('from 20 to 19.5 marks');
  for (const name of names.slice(0,5)) { await expect(row(page,name)).toHaveAttribute('data-status','unavailable'); await expect(row(page,name)).toContainText('two owner calibration points'); }
});
test('E64 replays actual settings in all independent research models and preserves them in Expert', async ({page}) => {
  await setup(page,'E64 WS'); await step(page,1); await page.locator('#simple-current-dial').fill('63'); await page.locator('#simple-step').fill('1'); await step(page,3);
  await shot(page,22,'too sour');
  for (const name of names.slice(0,5)) { await expect(row(page,name)).toHaveAttribute('data-status','computed'); await expect(row(page,name)).toContainText('micrometres'); }
  await expect(row(page,'DdEff')).toContainText('not next-coffee advice');
  await expect(row(page,'GbS2')).toContainText('Latest measured time: 22 seconds; target: 28 seconds (6 seconds faster)');
  const first = JSON.parse(await row(page,'GbS1').locator('pre').textContent()); expect(first.case.state.lastResultDum).toBe(630); expect(first.case.input.setpointDdDum).toBe(630);
  await page.locator('#simple-continue').click(); await shot(page,26,'too sour');
  const second = JSON.parse(await row(page,'GbS2').locator('pre').textContent()); expect(second.case.input.setpointDdDum).toBe(620); expect(second.case.state.history).toHaveLength(1); expect(second.case.state.history[0].x).toBe(63);
  const before = await row(page,'GbS2').textContent(); await page.locator('#view-mode').selectOption('expert');
  await expect(row(page,'GbS2')).toHaveText(before); await expect(page.locator('#all-comparison-context')).toContainText('Recorded shot 2');
});
test('editing a recorded brew invalidates cards and replaces that shot', async ({page}) => {
  await setup(page,'E64 WS'); await shot(page,22,'too sour');
  await step(page,3); await page.locator('#simple-time').fill('24'); await page.locator('#simple-time').dispatchEvent('change'); await step(page,4);
  await expect(row(page,'GbS1')).toHaveAttribute('data-status','unavailable'); await expect(row(page,'GbS1')).toContainText('Inputs changed');
  await step(page,3); await page.locator('#simple-record').click(); await expect(page.locator('#simple-history li')).toHaveCount(1);
  expect(JSON.parse(await row(page,'GbS2').locator('pre').textContent()).case.state.history).toHaveLength(0);
});
test('flow and unconfirmed clocks withhold timing models without hiding any cards', async ({page}) => {
  await setup(page,'E64 WS'); await shot(page,22,'too sour',false);
  for (const name of names.slice(0,4)) { await expect(row(page,name)).toHaveAttribute('data-status','unavailable'); await expect(row(page,name)).toContainText('programmed flow target'); }
  await expect(row(page,'DdEff')).toHaveAttribute('data-status','computed');
  await step(page,3); await page.locator('#simple-pressure-confirmed').check(); await page.locator('#simple-clock-confirmed').uncheck(); await page.locator('#simple-record').click();
  await expect(row(page,'GbS1')).toContainText('Different clocks cannot be compared');
  await expect(row(page,'DdEff')).toHaveAttribute('data-status','computed');
  await expect(page.locator('#all-comparison-results article')).toHaveCount(10);
});
test('one singular algorithm cannot erase the other nine cards or their explanations', async ({page}) => {
  await setup(page,'E64 WS'); await shot(page,5,'too sour');
  await page.locator('#simple-continue').click(); await shot(page,22,'too sour');
  await expect(page.locator('#all-comparison-results article')).toHaveCount(10);
  await expect(row(page,'GbS1')).toHaveAttribute('data-status','invalid'); await expect(row(page,'GbS1')).toContainText('singular');
  for (const name of ['GbS2','GbS3','GbS4','DdEff','manual']) await expect(row(page,name)).toHaveAttribute('data-status','computed');
});
test('balanced coffee keeps manual advice even when timing-only models disagree', async ({page}) => {
  await setup(page,'E64 WS'); await shot(page,22,'balanced');
  await expect(row(page,'manual')).toContainText('Keep the grinder at 20');
  await expect(row(page,'GbS2')).toContainText('does not override your taste-based next step');
});
test('populated comparisons fit phones in both modes and themes', async ({page}, info) => {
  await setup(page,'E64 WS'); await shot(page,22,'too sour');
  for (const width of [320,375,768,1440]) { await page.setViewportSize({width,height:900}); for (const mode of ['simple','expert']) { await page.locator('#view-mode').selectOption(mode); await step(page,4); for (let theme=0;theme<2;theme++) { expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true); for (const name of names) await expect(row(page,name)).toBeVisible(); await page.locator('#theme').click(); } } }
  await page.locator('#view-mode').selectOption('simple'); await page.setViewportSize({width:375,height:900}); await page.screenshot({path:info.outputPath('all-ten-simple-phone.png'),fullPage:true});
});

test('starting a new coffee clears every result immediately', async ({page}) => {
  await setup(page,'E64 WS'); await shot(page,22,'too sour'); await page.locator('#simple-new').click(); await step(page,4);
  await expect(page.locator('#all-comparison-results article')).toHaveCount(10);
  for (const name of names) await expect(row(page,name)).toHaveAttribute('data-status','unavailable');
  await expect(page.locator('#all-comparison-context')).not.toContainText('Recorded shot 1');
});
