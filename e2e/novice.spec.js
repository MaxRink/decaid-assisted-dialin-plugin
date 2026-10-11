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
