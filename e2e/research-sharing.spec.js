const {test, expect} = require('@playwright/test');
const step = (page, n) => page.locator(`button[data-wizard-step="${n}"]`).click();
async function shot(page, time) {
  await step(page, 1); await page.locator('#simple-current-dial').fill('20');
  await step(page, 3); await page.locator('#simple-time').fill(String(time));
  await page.locator('#simple-taste').selectOption('too sour');
  await page.locator('#simple-clock-confirmed').check(); await page.locator('#simple-pressure-confirmed').check();
  await page.locator('#simple-record').click();
}
test('local research export filters personal text and replaces an amended shot without remote sharing', async ({page}) => {
  let posts = 0; page.on('request', request => { if (request.method() === 'POST') posts++; });
  await page.goto('/simulator/');
  await page.locator('#bean').fill('PRIVATE COFFEE NAME');
  await shot(page, 22); await shot(page, 24);
  await page.locator('#research-sharing-title').click();
  await expect(page.locator('#research-sharing-status')).toContainText('1 record(s)');
  await expect(page.locator('#research-sharing-consent')).not.toBeChecked();
  await expect(page.locator('#research-sharing-consent')).toBeDisabled();
  const downloadPromise = page.waitForEvent('download'); await page.locator('#research-sharing-export').click();
  const download = await downloadPromise, fs = require('node:fs');
  const raw = fs.readFileSync(await download.path(), 'utf8'), archive = JSON.parse(raw);
  expect(archive.records).toHaveLength(1); expect(archive.records[0].measurements.pumpTimeSec).toBe(24);
  expect(raw).not.toMatch(/PRIVATE|beanId|grinderId|native-shot|calibrationEpoch|timestamp/);
  expect(posts).toBe(0);
  await page.locator('#research-local-enabled').uncheck(); await page.reload();
  await page.locator('#research-sharing-title').click();
  await expect(page.locator('#research-local-enabled')).not.toBeChecked();
  await page.locator('#research-sharing-delete').click();
  await expect(page.locator('#research-sharing-status')).toContainText('deleted');
});
test('configured research collector sends only on explicit consent and Send; opt-out clears queue', async ({page}) => {
  const batches = [];
  await page.route('https://collector.example/v1/events', async route => {
    const request = route.request(), body = request.postDataJSON(); batches.push(body);
    await route.fulfill({status:200, contentType:'application/json', body:JSON.stringify({accepted:body.records.length})});
  });
  await page.goto('/simulator/'); await page.locator('#view-mode').selectOption('expert');
  await page.locator('#research-sharing-title').click();
  await page.getByText('Configure your research collector', {exact:true}).click();
  await page.locator('#research-sharing-endpoint').fill('https://collector.example/v1/events');
  await page.locator('#research-sharing-apply').click();
  await expect(page.locator('#research-sharing-consent')).toBeEnabled();
  await page.locator('#research-sharing-consent').check();
  await shot(page, 22); await shot(page, 24);
  await expect(page.locator('#research-sharing-status')).toContainText('1 queued'); expect(batches).toHaveLength(0);
  await page.locator('#research-sharing-send').click();
  await expect(page.locator('#research-sharing-status')).toContainText('0 queued');
  expect(batches).toHaveLength(1); expect(batches[0].records).toHaveLength(1); expect(batches[0].records[0].measurements.pumpTimeSec).toBe(24);
  await shot(page, 25); await expect(page.locator('#research-sharing-status')).toContainText('1 queued');
  await page.locator('#research-sharing-disable').click(); await page.reload();
  await page.locator('#research-sharing-title').click();
  await expect(page.locator('#research-sharing-consent')).not.toBeChecked();
  await expect(page.locator('#research-sharing-status')).toContainText('0 queued');
  expect(batches).toHaveLength(1);
});
