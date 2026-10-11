const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');

// Parse the delivered page controls, then exercise its unmodified script against
// the real plugin HTTP handlers. Layout is covered separately in browser QA.
class Node {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = attributes;
    this.id = attributes.id || '';
    this.value = attributes.value || '';
    this.hidden = Object.hasOwn(attributes, 'hidden');
    this.disabled = Object.hasOwn(attributes, 'disabled');
    this.className = attributes.class || '';
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this._text = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(event, handler, options = false) { (this.listeners[event] ||= []).push({ handler, capture: options === true || options?.capture === true }); }
  async dispatch(type, fields = {}) {
    let stopped = false;
    const event = { target: this, preventDefault() {}, stopImmediatePropagation() { stopped = true; }, ...fields };
    const listeners = this.listeners[type] || [];
    const ordered = [...listeners.filter(item => item.capture).map(item => item.handler), this['on' + type], ...listeners.filter(item => !item.capture).map(item => item.handler)];
    for (const handler of ordered) { if (stopped) break; if (handler) await handler(event); }
  }
  async click() { if (!this.disabled) return this.dispatch('click'); }
  focus() {}
}
function documentFor(html) {
  const nodes = [...html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)].map((match) => {
    const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)')?/g)].map(attribute => [attribute[1], attribute[2] ?? attribute[3] ?? '']));
    return new Node(match[1], attrs);
  });
  const byId = new Map(nodes.filter(node => node.id).map(node => [node.id, node]));
  const document = {
    querySelector(selector) {
      const field = selector.match(/^#([\w-]+) input\[name=["']?([\w-]+)["']?\]$/);
      if (field) return nodes.find(node => node.attributes.name === field[2]);
      return byId.get(selector.slice(1)) || null;
    },
    querySelectorAll(selector) {
      if (selector === '.expert-panel') return nodes.filter(node => node.className.split(' ').includes('expert-panel'));
      if (selector === '#feedback button') return [];
      const attr = selector.match(/^(section)?\[([\w-]+)\]$/);
      if (attr) return nodes.filter(node => (!attr[1] || node.tagName === 'SECTION') && Object.hasOwn(node.attributes, attr[2]));
      return [];
    },
    createElement: tag => new Node(tag),
    createElementNS: (_ns, tag) => new Node(tag),
  };
  return { document, byId, nodes };
}
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const savedShot = (unit = 'deci-micrometre') => ({
  id: 'shot-integration', timestamp: '2026-10-11T08:00:00.000Z',
  workflow: {
    profile: { name: 'Pressure espresso', steps: [{ name: 'Preinfusion', seconds: 4, pump: 'flow', flow: 3 }, { name: 'Extraction', seconds: 25, pump: 'pressure', pressure: 9 }] },
    context: { beanBatchId: 'batch-1', grinderId: 'grinder-1', grinderModel: 'E64 WS', grinderSetting: '630', targetDoseWeight: 18, targetYield: 36, extras: { grinderSettingUnit: unit, burrIdentity: 'stock', calibrationEpoch: 'epoch-1', basket: '58mm' } },
  },
  measurements: [0, 1, 2, 3, 4, 10, 11, 12, 29].map(seconds => ({
    machine: { timestamp: new Date(Date.parse('2026-10-11T08:00:00.000Z') + seconds * 1000).toISOString(), flow: seconds < 4 ? 3 : 2, pressure: seconds < 4 ? 3 : 9 },
    scale: { timestamp: new Date(Date.parse('2026-10-11T08:00:00.000Z') + seconds * 1000).toISOString(), weight: Math.max(0, seconds - 4) * 1.4 },
  })),
});
async function integratedPage({ shot = savedShot(), coreFetch } = {}) {
  let plugin;
  const requests = [];
  const host = {
    log() {},
    storage(command) {
      queueMicrotask(() => plugin.onEvent({ name: command.type === 'read' ? 'storageRead' : 'storageWrite', payload: command.type === 'read' ? { key: command.key, value: {} } : command.data }));
    },
  };
  const core = async (url, init = {}) => {
    if (coreFetch) { const result = await coreFetch(url, init); if (result) return result; }
    const pathname = new URL(url, 'http://127.0.0.1:8080').pathname;
    if (pathname === '/api/v1/shots/' + shot.id) return response(shot);
    if (pathname === '/api/v1/workflow') return response(shot.workflow);
    throw new Error('Unexpected host API request: ' + url);
  };
  const backend = { URL, URLSearchParams, setTimeout, clearTimeout, fetch: core };
  vm.createContext(backend);
  vm.runInContext(source, backend);
  plugin = backend.createPlugin(host);
  plugin.onLoad({});
  const page = await plugin.handleHttpRequest({ endpoint: 'ui', method: 'GET' });
  const dom = documentFor(page.body);
  const frontend = {
    ...dom, URL, URLSearchParams, setTimeout, clearTimeout,
    location: { pathname: '/plugins/assisted/ui', href: 'http://127.0.0.1:8080/plugins/assisted/ui', search: '' },
    FormData: class { constructor(form) { this.form = form; } get(key) { return this.form.fields?.[key] ?? ''; } },
    fetch: async (url, init = {}) => {
      if (String(url).includes('/api/v1/')) return core(url, init);
      const endpoint = String(url).split('/').at(-1);
      const result = await plugin.handleHttpRequest({ endpoint, method: init.method || 'GET', body: init.body });
      requests.push({ endpoint, input: init.body ? JSON.parse(init.body) : null, status: result.status, body: JSON.parse(result.body) });
      return response(JSON.parse(result.body), result.status);
    },
  };
  vm.createContext(frontend);
  vm.runInContext(page.body.match(/<script>([\s\S]*)<\/script>/)[1], frontend);
  const analyse = async (shotId = shot.id) => {
    const form = dom.byId.get('analysis');
    form.fields = { shotId };
    await form.dispatch('submit');
  };
  return { ...dom, requests, plugin, analyse, frontend };
}

test('real analysis response renders its nested trace and comparison uses the selected saved shot', async () => {
  const page = await integratedPage();
  await page.analyse();
  const analysis = page.requests.find(request => request.endpoint === 'analysis');
  assert.equal(analysis.status, 200);
  assert.ok(analysis.body.metrics.trace.points.length > 0);
  assert.equal(page.byId.get('traceGraph').hidden, false, 'the actual metrics.trace response must reach the graph');
  assert.ok(page.byId.get('traceGraphBody').children.some(child => child.tagName === 'SVG'));
  page.byId.get('compare-actual').value = '29';
  page.byId.get('compare-target').value = '26.5';
  await page.byId.get('compareAll').click();
  const comparison = page.requests.find(request => request.endpoint === 'research');
  assert.ok(comparison, page.byId.get('comparisonRows').textContent);
  assert.equal(comparison.status, 200, JSON.stringify(comparison.body));
  assert.equal(comparison.input.input.cases.GbS2.input.actualBrewTimeMs, 29000);
  assert.equal(comparison.input.input.cases.GbS2.input.targetBrewTimeMs, 26500);
  assert.equal(comparison.input.input.cases.GbS2.input.setpointDdDum, 630);
  assert.equal(comparison.body.results.length, 10);
  assert.equal(page.byId.get('comparisonRows').children.length, 10);
  for (const row of comparison.body.results.filter(row => ['GbS1', 'GbS2', 'GbS3', 'GbS4', 'DdEff'].includes(row.algorithm))) assert.equal(row.status, 'computed', row.algorithm + ': ' + (row.reason || ''));
  assert.equal(comparison.body.results.find(row => row.algorithm === 'grindTime').status, 'unavailable');
});

test('native wizard reveals successful analysis and never invents dD inputs for a native dial', async () => {
  const page = await integratedPage({ shot: savedShot('marks') });
  assert.equal(page.byId.get('coffeeStep').hidden, false);
  await page.analyse();
  assert.equal(page.byId.get('traceStep').hidden, false, 'the analysis result must be visible after submit');
  page.byId.get('compare-actual').value = '29';
  page.byId.get('compare-target').value = '28';
  await page.byId.get('compareAll').click();
  assert.equal(Object.keys(page.requests.find(request => request.endpoint === 'research').input.input.cases).length, 0);
  assert.match(page.byId.get('comparisonRows').textContent, /deci-micrometre|calibrat/i);
});


test('a failed newly selected shot cannot reuse an older graph or comparison input', async () => {
  const page = await integratedPage();
  await page.analyse();
  assert.equal(page.byId.get('traceGraph').hidden, false);
  await page.analyse('missing-shot');
  assert.equal(page.requests.filter(request => request.endpoint === 'analysis').at(-1).status, 503);
  assert.equal(page.byId.get('traceGraph').hidden, true, 'old trace must not be presented as the newly requested shot');
  page.byId.get('compare-actual').value = '29';
  page.byId.get('compare-target').value = '28';
  await page.byId.get('compareAll').click();
  assert.equal(Object.keys(page.requests.find(request => request.endpoint === 'research').input.input.cases).length, 0, 'comparison requires a successful current analysis');
});

test('comparison distinguishes a missing saved grinder setting from a valid zero coordinate', async () => {
  for (const setting of [null, '0']) {
    const shot = savedShot();
    shot.workflow.context.grinderSetting = setting;
    const page = await integratedPage({ shot });
    await page.analyse();
    page.byId.get('compare-actual').value = '29';
  page.byId.get('compare-target').value = '28';
    await page.byId.get('compareAll').click();
    const comparisons = page.requests.filter(request => request.endpoint === 'research');
    assert.equal(!!comparisons[0].input.input.cases.GbS2, setting !== null, 'missing setting must not be coerced to zero');
    if (setting !== null) assert.equal(comparisons[0].input.input.cases.GbS2.input.setpointDdDum, 0);
  }
});

test('rendered machine curves preserve telemetry gaps rather than connecting missing intervals', async () => {
  const page = await integratedPage();
  await page.analyse();
  const trace = page.requests.find(request => request.endpoint === 'analysis').body.metrics.trace;
  assert.ok(trace.machineFlow.gapCount >= 2, 'fixture has real missing telemetry intervals');
  const svg = page.byId.get('traceGraphBody').children.find(child => child.tagName === 'SVG');
  const curves = svg.children.filter(child => child.tagName === 'POLYLINE');
  assert.ok(curves.length >= 4, 'machine flow and pressure each have two disconnected runs');
  // The renderer maps elapsed time to x=50..730 over the fixture's 29 seconds.
  const largestAllowedXGap = 680 * 5 / 29 + 0.01;
  for (const curve of curves) {
    const xs = curve.getAttribute('points').split(' ').map(pair => Number(pair.split(',')[0]));
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] <= largestAllowedXGap, 'a curve bridges more than 5 seconds of absent telemetry');
  }
});

const descendants = node => [node, ...node.children.flatMap(descendants)];
async function loadCatalogCard(page, predicate) {
  await page.byId.get('loadCoffeeCatalog').click();
  const products = page.requests.find(request => request.endpoint === 'coffee-catalog').body.products;
  const product = products.find(predicate);
  assert.ok(product, 'catalogue fixture contains the required product format');
  const search = page.byId.get('nativeCoffeeSearch'); search.value = product.name; await search.dispatch('input');
  const card = page.byId.get('coffeeCatalog').children.find(node => node.children.some(child => child.tagName === 'STRONG' && child.textContent === product.name));
  assert.ok(card, product.name + ' must be accessible in the rendered catalogue');
  const button = descendants(card).find(node => node.tagName === 'BUTTON');
  return { product, card, button };
}

test('catalogue preview is read-only and concurrent confirmation imports a bean once with host readback', async () => {
  const beans = [], calls = [];
  const page = await integratedPage({ coreFetch: async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    if (!pathname.startsWith('/api/v1/beans')) return null;
    calls.push({ url, method: init.method || 'GET' });
    if (pathname === '/api/v1/beans' && init.method === 'POST') {
      const bean = { ...JSON.parse(init.body), id: 'bean-' + (beans.length + 1) };
      beans.push(bean);
      return response(bean, 201);
    }
    if (pathname === '/api/v1/beans') return response(beans.map(bean => ({ ...bean })));
    return response(beans.find(bean => pathname.endsWith('/' + bean.id)));
  } });
  const { card, button } = await loadCatalogCard(page, product => product.beanEligible === true);
  await button.click();
  assert.equal(beans.length, 0, 'preview must not write a bean');
  const decaf = descendants(card).find(node => node.tagName === 'SELECT'); if (decaf) decaf.value = 'no';
  await Promise.all([button.click(), button.click()]);
  assert.equal(beans.length, 1, 'pending double-click must not create duplicate beans');
  assert.ok(calls.some(call => call.method === 'GET' && new URL(call.url).pathname === '/api/v1/beans/' + beans[0].id), 'success requires reading back the stored bean');
  await button.click();
  assert.equal(beans.length, 1, 'retry must reuse the previously imported catalogue identity');
  assert.match(card.textContent, /readback|already imported|saved/i);
});

test('known non-bean catalogue formats cannot be confirmed into the host bean database', async () => {
  const writes = [];
  const page = await integratedPage({ coreFetch: async (url, init = {}) => {
    if (!new URL(url).pathname.startsWith('/api/v1/beans')) return null;
    if (init.method === 'POST') { writes.push(JSON.parse(init.body)); return response({ id: 'bad-import' }, 201); }
    return response([]);
  } });
  const { button } = await loadCatalogCard(page, product => product.beanEligible === false && ['green-bean', 'capsule', 'ready-to-drink', 'bundle'].includes(product.format));
  if (button) { await button.click(); await button.click(); }
  assert.equal(writes.length, 0, 'an unsupported format must not become an ordinary bean through generic confirmation');
});

test('a failed duplicate lookup does not create an unchecked second bean', async () => {
  const writes = [];
  const page = await integratedPage({ coreFetch: async (url, init = {}) => {
    if (!new URL(url).pathname.startsWith('/api/v1/beans')) return null;
    if (init.method === 'POST') { writes.push(JSON.parse(init.body)); return response({ id: 'duplicate' }, 201); }
    return response({ error: 'bean catalogue temporarily unavailable' }, 503);
  } });
  const { button, card } = await loadCatalogCard(page, product => product.beanEligible === true);
  await button.click();
  const decaf = descendants(card).find(node => node.tagName === 'SELECT'); if (decaf) decaf.value = 'no';
  await button.click();
  assert.equal(writes.length, 0, 'cannot safely deduplicate when the host bean lookup failed');
});

test('analysis rendered inside an initially hidden wizard step keeps phone graph labels readable', async () => {
  const page = await integratedPage();
  page.document.documentElement = {clientWidth: 375};
  page.byId.get('traceGraphBody').clientWidth = 0;
  await page.analyse();
  const plots = page.byId.get('traceGraphBody').children.filter(child => child.tagName === 'SVG');
  assert.ok(plots.length > 0);
  for (const plot of plots) {
    const width = Number(plot.getAttribute('viewBox').split(' ')[2]);
    assert.ok(width <= 375 && width >= 300, 'hidden-step charts must use available phone width');
  }
});
