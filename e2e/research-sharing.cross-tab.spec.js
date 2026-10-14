const { test, expect } = require('@playwright/test');

const endpointA = 'https://collector.example/v1/events';
const endpointB = 'https://other-collector.example/v1/events';

async function configure(page, endpoint = endpointA) {
  await page.goto('/simulator/');
  await page.locator('#view-mode').selectOption('expert');
  await page.locator('#research-sharing-title').click();
  await page.getByText('Configure your research collector', { exact: true }).click();
  await page.locator('#research-sharing-endpoint').fill(endpoint);
  await page.locator('#research-sharing-apply').click();
  await expect(page.locator('#research-sharing-consent')).toBeEnabled();
  await page.locator('#research-sharing-consent').check();
}

async function record(page, time = 22) {
  await page.locator('button[data-wizard-step="1"]').click();
  await page.locator('#simple-current-dial').fill('20');
  await page.locator('button[data-wizard-step="3"]').click();
  await page.locator('#simple-time').fill(String(time));
  await page.locator('#simple-taste').selectOption('too sour');
  await page.locator('#simple-clock-confirmed').check();
  await page.locator('#simple-pressure-confirmed').check();
  await page.locator('#simple-record').click();
  await expect(page.locator('#research-sharing-status')).toContainText('queued');
}

async function routeCollector(context, batches) {
  await context.route('https://collector.example/**', async route => {
    const request = route.request();
    if (request.method() === 'POST') batches.push({ endpoint: request.url(), body: request.postDataJSON() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: request.postDataJSON().records.length }) });
  });
  await context.route('https://other-collector.example/**', async route => {
    const request = route.request();
    if (request.method() === 'POST') batches.push({ endpoint: request.url(), body: request.postDataJSON() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: request.postDataJSON().records.length }) });
  });
}

test.describe('research sharing two-tab storage fences', () => {
  test('a stale tab cannot send after another tab deletes all data', async ({ browser }) => {
    const context = await browser.newContext();
    const batches = []; await routeCollector(context, batches);
    const a = await context.newPage(); const b = await context.newPage();
    await configure(a); await record(a);
    await b.goto('/simulator/'); await b.locator('#research-sharing-title').click();
    await expect(b.locator('#research-sharing-status')).toContainText('1 queued');
    await a.locator('#research-sharing-delete').click();
    await expect(a.locator('#research-sharing-status')).toContainText('deleted');
    await b.locator('#research-sharing-send').click();
    await expect(b.locator('#research-sharing-status')).toContainText('0 queued');
    expect(batches).toHaveLength(0);
    await context.close();
  });

  test('a stale tab cannot send after another tab opts out', async ({ browser }) => {
    const context = await browser.newContext();
    const batches = []; await routeCollector(context, batches);
    const a = await context.newPage(); const b = await context.newPage();
    await configure(a); await record(a);
    await b.goto('/simulator/'); await b.locator('#research-sharing-title').click();
    await expect(b.locator('#research-sharing-status')).toContainText('1 queued');
    await a.locator('#research-sharing-disable').click();
    await b.locator('#research-sharing-send').click();
    await expect(b.locator('#research-sharing-consent')).not.toBeChecked();
    expect(batches).toHaveLength(0);
    await context.close();
  });

  test('an endpoint change revokes the old destination in a stale tab', async ({ browser }) => {
    const context = await browser.newContext();
    const batches = []; await routeCollector(context, batches);
    const a = await context.newPage(); const b = await context.newPage();
    await configure(a, endpointA); await record(a);
    await b.goto('/simulator/'); await b.locator('#research-sharing-title').click();
    await expect(b.locator('#research-sharing-status')).toContainText('1 queued');
    await a.locator('#research-sharing-endpoint').fill(endpointB);
    await a.locator('#research-sharing-apply').click();
    await b.locator('#research-sharing-send').click();
    expect(batches).toHaveLength(0);
    await context.close();
  });

  test('concurrent captures from two tabs are merged instead of losing one', async ({ browser }) => {
    const context = await browser.newContext();
    const a = await context.newPage(); const b = await context.newPage();
    await configure(a); await b.goto('/simulator/');
    await Promise.all([record(a, 22), record(b, 24)]);
    await a.locator('#research-sharing-title').click();
    await expect(a.locator('#research-sharing-status')).toContainText('2 record(s)');
    const downloadPromise = a.waitForEvent('download');
    await a.locator('#research-sharing-export').click();
    const download = await downloadPromise;
    const archive = JSON.parse(require('node:fs').readFileSync(await download.path(), 'utf8'));
    expect(archive.records).toHaveLength(2);
    await context.close();
  });
});
