const { test: base, expect } = require('@playwright/test');
const test = base.extend({request: async ({context}, use) => use(context.request)});
const PREFIX = '/api/v1/plugins/assisted-dialin.reaplugin';
const NS = 'assisted-dialin.reaplugin';
const THEMES = {light: 'rgb(255, 255, 255)', dark: 'rgb(16, 18, 23)'};

test.beforeEach(async ({ page, request }) => {
  await request.post('/__test/reset');
  await page.route('http://127.0.0.1:8080/**', route => route.abort());
});

// Every visible control is a comfortable touch target and nothing scrolls sideways.
async function checkLayout(page, label) {
  const problems = await page.evaluate(() => {
    const out = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push('horizontal overflow ' + document.documentElement.scrollWidth);
    document.querySelectorAll('button, input:not([type=radio]), select, summary, .pu-choice label').forEach(el => {
      const box = el.getBoundingClientRect();
      if (box.width && box.height && box.height < 40) out.push((el.id || el.textContent.trim().slice(0, 30)) + ' is ' + Math.round(box.height) + 'px');
    });
    return out;
  });
  expect(problems, label).toEqual([]);
}

for (const [theme, background] of Object.entries(THEMES)) for (const width of [412, 1280]) {
  test(`the setup assistant saves grinder, dial, targets and sharing (${theme}, ${width}px)`, async ({ page, request }) => {
    await page.setViewportSize({width, height: 900});
    await page.goto(PREFIX + '/setup?theme=' + theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(background);
    await expect(page.locator('[data-pu-stepper]')).toContainText('Step 1 of 5');
    // Step 1: Decaid's grinders, the only one preselected.
    const grinder = page.getByRole('radio', {name: /E64 WS/});
    await expect(grinder).toBeChecked();
    await checkLayout(page, 'grinder step');
    await page.locator('[data-pu-next]').click();
    // Step 2: E64 defaults and the plugin's earlier global step (10).
    await expect(page.getByRole('heading', {name: 'How your dial reads'})).toBeFocused();
    await expect(page.getByRole('radio', {name: /Micrometres/})).toBeChecked();
    await expect(page.getByRole('radio', {name: /Smaller numbers are finer/})).toBeChecked();
    await expect(page.locator('#setupStepSize')).toHaveValue('10');
    await page.locator('#setupStepSize').fill('5');
    await page.locator('#setupMin').fill('100');
    await checkLayout(page, 'dial step');
    await page.locator('[data-pu-next]').click();
    await expect(page.locator('#setupAlert')).toHaveText('Enter both the lowest and the highest setting, or neither.');
    await page.locator('#setupMax').fill('1200');
    await page.locator('[data-pu-next]').click();
    // Step 3: targets from Decaid's stored settings; dose and yield from the workflow.
    await expect(page.locator('#setupAlert')).toBeHidden();
    await expect(page.locator('#targetTime')).toHaveValue('30');
    await expect(page.getByRole('radio', {name: /Pump time/})).toBeChecked();
    await expect(page.locator('#workflowRecipe')).toContainText('dose 18 g, yield 36 g');
    await page.locator('#targetTime').fill('28');
    await page.getByRole('radio', {name: /From first drops/}).check();
    await checkLayout(page, 'targets step');
    await page.locator('[data-pu-next]').click();
    // Step 4: sharing stays off; a collector needs an https address and consent.
    await expect(page.locator('#shareRemote')).not.toBeChecked();
    await page.locator('#shareRemote').check();
    await page.locator('[data-pu-next]').click();
    await expect(page.locator('#setupAlert')).toContainText("collector's https:// address");
    await page.locator('#shareRemote').uncheck();
    await checkLayout(page, 'sharing step');
    await page.locator('[data-pu-next]').click();
    // Step 5: review, then one save.
    await expect(page.locator('#reviewList')).toContainText('Dial: micrometres, smaller is finer, step 5, range 100 to 1200');
    await expect(page.locator('#reviewList')).toContainText('Target: 28 s ± 1 s, from first drops');
    await expect(page.locator('[data-pu-next]')).toBeHidden();
    await checkLayout(page, 'review step');
    await page.locator('#saveSetup').click();
    await expect(page.locator('#saveStatus')).toHaveText('Saved. Assisted dial-in is ready.');
    const state = await (await request.get('/__test/state')).json();
    expect(state.grinders[0].extras[NS]).toMatchObject({settingUnit: 'micrometres', finerDelta: -1, stepSize: 5, minSetting: 100, maxSetting: 1200});
    expect(state.hostSettingWrites).toEqual([{TargetTimeSec: 28, TargetTimeClock: 'pouring', TimeToleranceSec: 1}]);
  });
}

test('Decaid extension protection keeps the targets unsaved and says where to finish', async ({ page, request }) => {
  await request.post('/__test/config', {data: {protectedSettings: true}});
  await page.goto(PREFIX + '/setup');
  await page.locator('[data-pu-next]').click();
  await page.locator('[data-pu-next]').click();
  await page.locator('#targetTime').fill('27');
  await page.locator('[data-pu-next]').click();
  await page.locator('[data-pu-next]').click();
  await page.locator('#saveSetup').click();
  await expect(page.locator('#setupAlert')).toContainText('set the target time in Decaid > Settings > Plugins');
  const state = await (await request.get('/__test/state')).json();
  expect(state.grinders[0].extras[NS].settingUnit).toBe('micrometres');
  expect(state.settings.TargetTimeSec).toBe(30);
});

test('without grinders in Decaid the assistant explains where to add one', async ({ page, request }) => {
  await request.post('/__test/config', {data: {grinders: []}});
  await page.goto(PREFIX + '/setup');
  await expect(page.locator('#grinderChoices legend')).toContainText("Add your grinder in Decaid's equipment settings");
  await page.locator('[data-pu-next]').click();
  await expect(page.locator('#setupAlert')).toHaveText('Add your grinder in Decaid first.');
  await expect(page.locator('[data-pu-stepper]')).toContainText('Step 1 of 5');
});

test('embedded in a skin the assistant hides Done and announces itself; ui?view=setup opens it too', async ({ page }) => {
  await page.goto('/simulator/');
  const messages = await page.evaluate(async (src) => {
    const seen = [];
    window.addEventListener('message', event => seen.push(event.data && event.data.type));
    const frame = document.createElement('iframe');
    frame.src = src; document.body.appendChild(frame);
    await new Promise(resolve => frame.onload = resolve);
    await new Promise(resolve => setTimeout(resolve, 300));
    return seen;
  }, PREFIX + '/ui?view=setup&embed=1&theme=dark');
  expect(messages).toContain('streamline:ready');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('h1')).toHaveText('Set up assisted dial-in');
  await expect(frame.locator('[data-pu-done]')).toBeHidden();
});

for (const theme of Object.keys(THEMES)) test(`the main page follows the ${theme} theme and links to the setup assistant`, async ({ page }) => {
  await page.goto(PREFIX + '/ui?theme=' + theme + '&lang=de');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(THEMES[theme]);
  await expect(page.locator('#openSetup')).toHaveAttribute('href', PREFIX + '/setup?theme=' + theme + '&lang=de');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.locator('#openSetup').click();
  await expect(page.getByRole('heading', {name: 'Your grinder'})).toBeVisible();
});
