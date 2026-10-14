const {test, expect} = require('@playwright/test');
const PREFIX = '/api/v1/plugins/assisted-dialin.reaplugin';
const UI = PREFIX + '/ui';
const analysisResponse = (page, shotId) => page.waitForResponse(r => new URL(r.url()).pathname === PREFIX + '/analysis' && r.request().method() === 'POST' && r.request().postDataJSON().shotId === shotId);
async function analyse(page, shotId) {
  await page.locator('nav button[data-native-step="3"]').click();
  await page.locator('#analysis [name=shotId]').fill(shotId);
  const response = analysisResponse(page, shotId);
  await page.locator('#analysis button').click();
  return (await response).json();
}
async function save(page) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === PREFIX + '/feedback' && r.request().method() === 'POST');
  await page.locator('#feedback button[value=true]').click();
  return (await response).request().postDataJSON();
}
test.beforeEach(async ({page, request, baseURL}) => {
  await request.post('/__test/reset');
  await page.route('http://127.0.0.1:8080/**', async route => {
    const url = new URL(route.request().url());
    const response = await route.fetch({url: new URL(url.pathname + url.search, baseURL).href});
    await route.fulfill({response, headers: {...response.headers(), 'access-control-allow-origin': baseURL, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS', 'access-control-allow-headers': 'content-type'}});
  });
});

test('dropdown and typed shot ownership hydrate before save', async ({page}) => {
  await page.goto(UI); await analyse(page, 'shot-1');
  await page.locator('#loadShots').click(); await page.locator('#shotSelect option[value="shot-2"]').waitFor({state:'attached'});
  await page.locator('#shotSelect').selectOption('shot-2');
  await expect(page.locator('#feedback [name=notes]')).toHaveValue('saved shot-2');
  await page.locator('#feedback [name=notes]').fill('dropdown edit'); await save(page);
  await page.reload(); await analyse(page, 'shot-2'); await expect(page.locator('#feedback [name=notes]')).toHaveValue('dropdown edit');
  await page.locator('#feedback [name=shotId]').fill('shot-1');
  await expect(page.locator('#feedback [name=notes]')).toHaveValue('saved shot-1');
});

test('feedback launch applies a fresh measurement only after hydration and keeps it unconfirmed', async ({page}) => {
  const query = new URLSearchParams({action:'feedback', shotId:'shot-1', beanScaleId:'new-scale', beanWeight:'19.1', beanCapturedAt:'2026-10-25T01:40:22.222Z'});
  await page.goto(UI + '?' + query); await page.locator('nav button[data-native-step="3"]').click();
  await expect(page.locator('#feedback [name=notes]')).toHaveValue('saved shot-1');
  await expect(page.locator('#feedback [name=beanScaleId]')).toHaveValue('new-scale');
  await expect(page.locator('#feedback [name=beanWeight]')).toHaveValue('19.1');
  await expect(page.locator('#feedback [name=confirmBeanMeasurement]')).not.toBeChecked();
});

test('failed or pending hydration gates save controls', async ({page}) => {
  await page.goto(UI); await analyse(page, 'shot-1'); await page.locator('#loadShots').click();
  await page.locator('#shotSelect option[value="shot-2"]').waitFor({state:'attached'});
  await page.route('**' + PREFIX + '/analysis', route => route.request().postDataJSON().shotId === 'shot-2' ? route.fulfill({status:503, contentType:'application/json', body:JSON.stringify({error:'Injected analysis unavailable'})}) : route.continue());
  await page.locator('#shotSelect').selectOption('shot-2');
  await expect(page.locator('#feedback button[value=true]')).toBeDisabled();
  await expect(page.locator('#result')).toContainText('Injected analysis unavailable');
});

test('explicit analysis fences an old response and gates feedback while loading', async ({page}) => {
  await page.goto(UI); await analyse(page, 'shot-1');
  let release; const blocked = new Promise(resolve => { release = resolve; });
  await page.route('**' + PREFIX + '/analysis', async route => {
    if (route.request().postDataJSON().shotId === 'shot-2') { await blocked; }
    await route.continue();
  });
  await page.locator('#analysis [name=shotId]').fill('shot-2');
  const response = analysisResponse(page, 'shot-2'); await page.locator('#analysis button').click();
  await expect(page.locator('#feedback button[value=true]')).toBeDisabled(); release(); await response;
  await expect(page.locator('#feedback [name=notes]')).toHaveValue('saved shot-2');
});
