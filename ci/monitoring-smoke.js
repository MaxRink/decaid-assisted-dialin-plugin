/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createResearchSharing } = require('../research-sharing.js');
const collector = process.env.MONITOR_COLLECTOR_URL, prom = process.env.MONITOR_PROMETHEUS_URL, grafana = process.env.MONITOR_GRAFANA_URL;
const authorization = 'Basic ' + Buffer.from('admin:' + process.env.MONITOR_GRAFANA_PASSWORD).toString('base64');
async function waitFor(fn, label) {
  for (let n = 0; n < 240; n++) { try { const result = await fn(); if (result) return result; } catch (_) {} await new Promise(resolve => setTimeout(resolve, 500)); }
  throw new Error('Timed out: ' + label);
}
async function query(expr) { const response = await fetch(prom + '/api/v1/query?query=' + encodeURIComponent(expr)); assert.equal(response.status, 200); const value = await response.json(); assert.equal(value.status, 'success'); return value.data.result; }
(async () => {
  await Promise.all([
    waitFor(async () => (await fetch(collector + '/healthz')).ok, 'collector'),
    waitFor(async () => (await fetch(prom + '/-/ready')).ok, 'Prometheus'),
    waitFor(async () => (await fetch(grafana + '/api/health')).ok, 'Grafana')
  ]);
  const schema = createResearchSharing();
  const algorithms = ['manual','native-response','GbS1','GbS2','GbS3','GbS4','DdEff','effectiveDd','grindTime','inverseRegression','proposedDd'];
  const records = Array.from({ length: 12 }, (_, index) => schema.sanitizeRecord({ source: 'website', mode: 'practice', kind: 'shot', observationId: (index + 1).toString(16).padStart(32,'0'), revision: 1,
    grinder: { model: index % 2 ? 'DF54' : 'E64 WS', settingUnit: index % 2 ? 'dial-marks' : 'micrometres', setting: index % 2 ? 12 : 60 },
    measurements: { pumpTimeSec: 22 + index, doseG: 18, yieldG: 32 + index, meanMixTemperatureC: 91 + index % 4, meanGroupTemperatureC: 90 + index % 3, meanMachineFlowMlPerSec: 2.1, meanBeverageFlowGPerSec: 1.4, pumpComplete: true, interrupted: false },
    taste: { intent: index < 4 ? 'too_sour' : index > 8 ? 'too_bitter' : 'balanced', good: index >= 4 && index <= 8, tastingTemperatureC: 55 + index },
    approaches: algorithms.map((algorithm, position) => ({ algorithm, status: position > 7 ? 'computed' : 'suggestion', direction: position % 2 ? 'finer' : 'coarser', coordinateStatus: position < 2 ? 'native' : 'estimated_relative', settingUnit: index % 2 ? 'dial-marks' : 'micrometres', proposedSetting: (index % 2 ? 12 : 60) + (position % 2 ? -1 : 1) }))
  }));
  const response = await fetch(collector + '/v1/events', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({schemaVersion:1,policyVersion:1,records}) });
  assert.equal(response.status, 201);
  await waitFor(async () => (await query('decaid_research_retained_records')).some(item => Number(item.value[1]) === 12), 'scraped fictional observations');
  const imported = await (await fetch(grafana + '/api/dashboards/uid/decaid-research', {headers:{authorization}})).json();
  assert.equal(imported.dashboard.uid, 'decaid-research');
  const datasource = await (await fetch(grafana + '/api/datasources/uid/decaid-research', {headers:{authorization}})).json();
  assert.equal(datasource.type, 'prometheus');
  const dashboard = JSON.parse(fs.readFileSync('collector/monitoring/grafana/dashboards/research-overview.json','utf8'));
  let queries = 0;
  for (const panel of dashboard.panels) for (const target of panel.targets || []) {
    const expr = target.expr.replaceAll('$unit','dial-marks').replaceAll('$kind','shot').replaceAll('$model','.*').replaceAll('$mode','practice');
    const result = await query(expr); assert.ok(result.length, 'Populated panel: ' + panel.title); queries++;
    if (target.expr.includes('$unit')) for (const unit of ['dial-marks','micrometres']) {
      const selected = target.expr.replaceAll('$unit',unit).replaceAll('$kind','shot').replaceAll('$model','.*').replaceAll('$mode','practice');
      const isolated = await query(selected);
      assert.ok(isolated.length && isolated.every(item => item.metric.unit === unit), 'One coordinate unit per axis: ' + panel.title);
    }
  }
  assert.equal((await fetch(collector + '/metrics')).status, 404);
  const algorithmsFound = await query('count by (algorithm) (decaid_research_approaches{kind="shot",mode="practice"})');
  assert.equal(algorithmsFound.length, 11);
  if (process.env.MONITOR_SCREENSHOT_DIR) {
    await waitFor(async () => (await query('count_over_time(decaid_research_retained_records[5m])')).some(item => Number(item.value[1]) >= 2), 'two populated scrape points for visual inspection');
    const path = require('node:path');
    const { chromium } = require('@playwright/test');
    fs.mkdirSync(process.env.MONITOR_SCREENSHOT_DIR, {recursive:true});
    const browser = await chromium.launch({headless:true});
    try {
      const page = await browser.newPage({viewport:{width:1440,height:1000}});
      await page.goto(grafana + '/login');
      await page.getByLabel('Email or username').fill('admin');
      await page.getByLabel('Password', {exact:true}).fill(process.env.MONITOR_GRAFANA_PASSWORD);
      await page.getByRole('button',{name:'Log in',exact:true}).click();
      await page.waitForURL(url => !url.pathname.startsWith('/login'));
      const dashboardUrl = grafana + '/d/decaid-research?var-kind=shot&var-mode=practice&var-model=%24__all&from=now-5m&to=now';
      await page.goto(dashboardUrl);
      await page.getByText('Complete retained research snapshot',{exact:true}).waitFor({timeout:30000});
      await page.waitForTimeout(3000);
      assert.equal(await page.getByText('No data',{exact:true}).count(), 0, 'Visible dashboard panels must have data');
      await page.screenshot({path:path.join(process.env.MONITOR_SCREENSHOT_DIR,'grafana-desktop.png'),fullPage:false});
      await page.evaluate(() => window.scrollTo(0, 1100));
      await page.waitForTimeout(2000);
      await page.screenshot({path:path.join(process.env.MONITOR_SCREENSHOT_DIR,'grafana-desktop-results.png'),fullPage:false});
      await page.setViewportSize({width:390,height:844});
      await page.goto(dashboardUrl);
      await page.getByText('Complete retained research snapshot',{exact:true}).waitFor({timeout:30000});
      await page.waitForTimeout(2000);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2),'No document overflow on phone');
      await page.screenshot({path:path.join(process.env.MONITOR_SCREENSHOT_DIR,'grafana-phone.png'),fullPage:false});
    } finally { await browser.close(); }
  }
  process.stdout.write('Monitoring smoke passed: actual Prometheus scrape, Grafana provisioning, ' + queries + ' populated panel queries and all 11 algorithms. Fictional practice only.\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
