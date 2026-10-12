const {test, expect} = require('@playwright/test');
const step = (page, n) => page.locator(`button[data-wizard-step="${n}"]`).click();
async function setup(page, absolute) {
  await page.goto('/simulator/'); await expect(page.locator('#grinder option')).toHaveCount(16);
  await page.locator('#grinder').selectOption('DF54');
  await page.locator('#simple-current-dial').fill('20');
  await page.locator('#simple-dial-setup summary').click();
  await page.locator('#simple-step').fill('0.5'); await page.locator('#simple-finer').selectOption('-1');
  await page.locator('#simple-bound-min').fill('15'); await page.locator('#simple-bound-max').fill('25');
  await page.locator('#simple-confirm-dial').check();
  await page.locator('#mechanical-setup > summary').click();
  await expect(page.locator('#mechanical-source-note')).toContainText(/unverified|transcript/i);
  await expect(page.locator('#mechanical-enabled')).not.toBeChecked();
  if (absolute) await page.locator('#mechanical-zero-assumed').check();
  await page.locator('#mechanical-enabled').check();
}
async function record(page, time, taste = 'too sour') {
  await step(page,3); await page.locator('#simple-time').fill(String(time));
  await page.locator('#simple-taste').selectOption(taste);
  await page.locator('#simple-clock-confirmed').check(); await page.locator('#simple-pressure-confirmed').check();
  await page.locator('#simple-record').click();
}
test('beginner can choose a bounded rough-zero trial and complete three shots', async ({page}, info) => {
  await setup(page,true); await record(page,22);
  for (const name of ['GbS1','GbS2','GbS3','GbS4']) await expect(page.locator(`[data-algorithm="${name}"]`)).toHaveAttribute('data-coordinate-status','estimated_absolute');
  await expect(page.locator('[data-algorithm="DdEff"]')).toHaveAttribute('data-status','unavailable');
  await expect(page.locator('#simple-advice')).toContainText('from 20 to 19.5 marks');
  await page.locator('[data-algorithm="GbS1"]').getByRole('button',{name:'Try this estimated approach'}).click();
  await expect(page.locator('#simple-advice')).toContainText('Your chosen estimated trial');
  await page.locator('#simple-continue').click(); await step(page,1);
  const setting = Number(await page.locator('#simple-current-dial').inputValue()); expect(setting).toBeGreaterThanOrEqual(19.5); expect(setting).toBeLessThan(20);
  await record(page,26); await page.locator('#simple-continue').click(); await record(page,28,'balanced');
  await expect(page.locator('#simple-history li')).toHaveCount(3);
  await expect(page.locator('#simple-advice')).toContainText('Keep the grinder');
  await expect(page.getByRole('button',{name:'Try this estimated approach'})).toHaveCount(0);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('decaid.assisted-dialin.grinder-instances.v1')).every(profile=>profile.anchors==null))).toBe(true);
  await page.setViewportSize({width:390,height:844}); expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('rough-estimate-three-shots.png'),fullPage:true});
});
test('relative scenarios show chosen numeric assumptions without enabling absolute models', async ({page}) => {
  await setup(page,false);
  await page.locator('#mechanical-scenario').selectOption('lower');
  await expect(page.locator('#mechanical-slope')).toHaveValue('6');
  await expect(page.locator('#mechanical-scenario-note')).toContainText('not confidence bounds');
  await record(page,22);
  await expect(page.locator('[data-algorithm="GbS1"]')).toHaveAttribute('data-coordinate-status','estimated_relative');
  await expect(page.locator('[data-algorithm="GbS3"]')).toHaveAttribute('data-status','unavailable');
  await step(page,3); await page.locator('#simple-clock-confirmed').uncheck(); await page.locator('#simple-record').click();
  await expect(page.locator('[data-algorithm="GbS1"]')).toHaveAttribute('data-status','unavailable');
  await step(page,1); await page.locator('#grinder').selectOption('LAGOM P64');
  await expect(page.locator('#mechanical-enabled')).not.toBeChecked();
  await expect(page.locator('#mechanical-slope')).toHaveValue('100');
  await expect(page.locator('#mechanical-scenario-note')).toContainText('whole printed dial number');
});
test('legacy micro-tick settings require a fresh decimal step and preserve the checked replacement', async ({page}) => {
  await page.goto('/simulator/'); await expect(page.locator('#grinder option')).toHaveCount(16);
  await page.locator('#grinder').selectOption('LAGOM 01');
  await page.locator('#simple-dial-setup summary').click(); await page.locator('#simple-step').fill('1');
  await page.evaluate(() => {
    const key = 'decaid.assisted-dialin.grinder-instances.v1', profiles = JSON.parse(localStorage.getItem(key));
    const profile = profiles.find(item=>item.model==='LAGOM 01');
    profile.stepSize=1; profile.nativeSetup={burrIdentity:profile.burrIdentity,calibrationEpoch:profile.calibrationEpoch,numericFinerDelta:-1,min:0,max:10};
    localStorage.setItem(key,JSON.stringify(profiles));
  });
  await page.reload(); await page.locator('#simple-dial-setup summary').click();
  await expect(page.locator('#simple-step')).toHaveValue('');
  await expect(page.locator('#simple-step-preset')).toContainText('different or unspecified dial unit');
  await page.locator('#simple-step').fill('0.1'); await page.locator('#simple-finer').selectOption('-1'); await page.locator('#simple-confirm-dial').check();
  await page.reload(); await page.locator('#simple-dial-setup summary').click();
  await expect(page.locator('#simple-step')).toHaveValue('0.1'); await expect(page.locator('#simple-confirm-dial')).not.toBeChecked();
});
