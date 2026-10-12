const {test, expect} = require('@playwright/test');
async function step(page, n) {
  const button = page.locator(`button[data-wizard-step="${n}"]`);
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'step');
  await expect(page.locator(`section[data-wizard-step="${n}"]:not(.expert-only):visible`)).toHaveCount(1);
}
async function setup(page, target = '28') {
  await page.goto('/simulator/');
  await expect(page.locator('#grinder option')).toHaveCount(16);
  await page.locator('#simple-dial-setup summary').click();
  await expect(page.locator('#simple-step')).toHaveValue('0.5');
  await expect(page.locator('#simple-confirm-dial')).not.toBeChecked();
  await expect(page.locator('#simple-bound-min')).toHaveValue('');
  await page.locator('#simple-step').fill('0.25');
  await page.locator('#simple-finer').selectOption('-1');
  await page.locator('#simple-bound-min').fill('20');
  await page.locator('#simple-bound-max').fill('25');
  await page.locator('#simple-confirm-dial').check();
  await step(page,2); await page.locator('#target').fill(target);
}
async function shot(page, setting, time, taste = 'too bitter') {
  await step(page,1); await expect(page.locator('#simple-current-dial')).toBeVisible(); await page.locator('#simple-current-dial').fill(String(setting));
  await step(page,3); await page.locator('#simple-time').fill(String(time));
  await page.locator('#simple-taste').selectOption(taste);
  await page.locator('#simple-clock-confirmed').check();
  await page.locator('#simple-pressure-confirmed').check();
  await page.locator('#simple-record').click();
}
test('native plateau repeats the real setting instead of following an older slope', async ({page}, info) => {
  await setup(page);
  for (const [index, [setting,time]] of [[22,34],[22.25,31],[22.5,31],[22.5,31]].entries()) {
    if (index) await page.locator('#simple-continue').click();
    await shot(page,setting,time);
  }
  await expect(page.locator('#native-response')).toHaveAttribute('data-reason','latest_plateau');
  await expect(page.locator('#simple-advice')).toContainText('Keep the grinder at 22.5 marks and repeat');
  await expect(page.locator('#simple-history li')).toHaveCount(4);
  await page.locator('#native-response summary').click();
  await expect(page.locator('#native-response')).toContainText('22.5 marks → 31 s median, 2 shot(s)');
  await expect(page.locator('#all-comparison-results article')).toHaveCount(10);
  await page.setViewportSize({width:375,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('native-plateau.png'),fullPage:true});
});
test('stable native data gives one bounded test, then a liked coffee holds', async ({page}) => {
  await setup(page,'25');
  for (const [index,[setting,time]] of [[22,34],[22.25,31],[22.5,28]].entries()) {
    if (index) await page.locator('#simple-continue').click();
    await shot(page,setting,time);
  }
  await expect(page.locator('#native-response')).toHaveAttribute('data-status','suggestion');
  await expect(page.locator('#simple-advice')).toContainText('Try 22.75 marks next');
  await page.locator('#view-mode').selectOption('expert');
  await expect(page.locator('#native-response')).toBeVisible();
  await shot(page,22.5,28,'balanced');
  await expect(page.locator('#simple-advice')).toContainText('Keep the grinder at 22.5 marks');
});
test('editing a recipe keeps wizard navigation stable during focus loss', async ({page}) => {
  await setup(page, '25');
  await shot(page, 22, 34);
  await step(page, 2);
  const before = await page.evaluate(() => {
    const rect = document.querySelector('nav.setup-steps').getBoundingClientRect();
    return rect.top + window.scrollY;
  });
  await page.evaluate(() => {
    const target = document.querySelector('#target');
    const steps = document.querySelector('nav.setup-steps');
    window.__navTopAfterTargetBlur = null;
    target.addEventListener('blur', () => requestAnimationFrame(() => {
      const rect = steps.getBoundingClientRect();
      window.__navTopAfterTargetBlur = rect.top + window.scrollY;
    }), {once: true});
  });
  await page.locator('#target').fill('26');
  await page.locator('button[data-wizard-step="1"]').click();
  await expect(page.locator('button[data-wizard-step="1"]')).toHaveAttribute('aria-current', 'step');
  await expect.poll(() => page.evaluate(() => window.__navTopAfterTargetBlur)).not.toBeNull();
  const topAfterBlur = await page.evaluate(() => window.__navTopAfterTargetBlur);
  expect(Math.abs(topAfterBlur - before)).toBeLessThan(0.5);
});
test('guided bounds entry preserves shots and owner step survives a reload without confirmation', async ({page}) => {
  await setup(page);
  await shot(page,22,34);
  await step(page,1); await expect(page.locator('#simple-current-dial')).toBeVisible(); await page.locator('#simple-bound-min').fill('');
  await page.locator('#simple-confirm-dial').check();
  await step(page,3); await page.locator('#simple-record').click();
  await page.getByRole('button',{name:'Check step, direction and allowed trial window'}).click();
  await expect(page.locator('#simple-bound-min')).toBeVisible();
  await page.locator('#simple-bound-min').fill('20');
  await page.locator('#simple-confirm-dial').check();
  await step(page,3); await page.locator('#simple-record').click();
  await expect(page.locator('#simple-history li')).toHaveCount(1);
  await page.reload();
  await page.locator('#simple-dial-setup summary').click();
  await expect(page.locator('#simple-step')).toHaveValue('0.25');
  await expect(page.locator('#simple-confirm-dial')).not.toBeChecked();
  await page.locator('#grinder').selectOption('E65S GbW');
  await expect(page.locator('#simple-step')).toHaveValue('');
});
