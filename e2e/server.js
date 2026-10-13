// Browser fixture: real plugin handlers, simulated Decaid API and storage only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sessions = new Map();
const json = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => structuredClone(body)});
const clone = value => structuredClone(value);
function savedShot(id = 'shot-1') {
  const start = Date.now() - 60000;
  const dynamic = id === 'shot-2';
  const workflow = {profile: {name: dynamic ? 'D-Flow' : 'Pressure espresso', steps: [
    {name: 'Fill', pump: 'flow', flow: 4, seconds: 5},
    {name: dynamic ? 'Infusing' : 'Extraction', pump: 'pressure', pressure: 9, seconds: 30, ...(dynamic ? {limiter: {value: 2, range: 1}} : {})},
  ]}, context: {beanBatchId: 'batch-1', beanId: 'bean-1', grinderId: 'grinder-1', grinderModel: 'E64 WS', grinderSetting: id === 'shot-3' ? '20' : '630', targetDoseWeight: 18, targetYield: 36, extras: {burrIdentity: 'stock', calibrationEpoch: 'epoch-1', basket: '58mm', grinderSettingUnit: id === 'shot-3' ? 'dial-mark' : 'deci-micrometre', beanType: 'Arabica', roastLevel: 'medium'}}};
  return {id, bean: {id: 'bean-1', name: 'Fixture coffee', roaster: 'Owner', species: 'Arabica'}, beanBatch: {id: 'batch-1', beanId: 'bean-1', roastLevel: 'medium'}, timestamp: new Date(start).toISOString(), workflow, finalStopReason: 'targetWeight', measurements: Array.from({length: 32}, (_,n) => ({machine: {timestamp: new Date(start+n*1000).toISOString(), ...(id === 'shot-3' ? {} : {state: {state: 'espresso', substate: n === 0 ? 'preparingForShot' : n < 5 ? 'preinfusion' : n < 30 ? 'pouring' : 'pouringDone'}}), profileFrame: n < 5 ? 0 : 1, pressure: n < 5 ? 3 : 9, targetPressure: n < 5 ? 3 : 9, flow: n < 5 ? 4 : 1.8, targetFlow: n < 5 ? 4 : null, mixTemperature: 93, targetMixTemperature: 93, groupTemperature: 92.5, targetGroupTemperature: 93}, scale: {timestamp: new Date(start+n*1000).toISOString(), weight: n < 5 ? 0 : Math.min(36, (n-5)*1.44)}}))};
}
function newSession() {
  const shots = ['shot-1', 'shot-2', 'shot-3'].map(savedShot);
  const state = {shots, workflow: clone(shots[0].workflow), beans: [{id: 'bean-1', name: 'Fixture coffee', roaster: 'Owner', species: 'Arabica'}], grinders: [{id: 'grinder-1', model: 'E64 WS', burrs: 'stock', settingType: 'numeric'}], storage: {}, requests: [], config: {}, grinderObservation: {info: {observations: ['setting'], capabilities: []}, snapshot: {timestamp: new Date().toISOString(), state: 'idle', observedSetting: '501 ddValueDum'}}, settings: {TargetTimeSec: 30, StepSize: 10, NumericFinerDelta: -1}};
  state.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://127.0.0.1');
    const pathname = u.pathname;
    state.requests.push({path: pathname, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null});
    if (state.config.delayPath === pathname) await new Promise(resolve => setTimeout(resolve, state.config.delayMs || 250));
    if (state.config.failPath === pathname) return json({error: 'Injected host failure'}, state.config.status || 503);
    if (pathname === '/api/v1/workflow') return json(state.workflow);
    if (pathname === '/api/v1/grinder/info') return json((state.config.grinderObservation || state.grinderObservation).info);
    if (pathname === '/api/v1/grinder/state') return json((state.config.grinderObservation || state.grinderObservation).snapshot);
    if (pathname === '/api/v1/shots') return json({items: state.shots.map(({id,timestamp,workflow}) => ({id,timestamp,workflow})), total: state.shots.length});
    if (pathname.startsWith('/api/v1/shots/')) return json(state.shots.find(s => s.id === decodeURIComponent(pathname.split('/').at(-1))) || {error: 'No such shot'}, state.shots.some(s => s.id === decodeURIComponent(pathname.split('/').at(-1))) ? 200 : 404);
    if (pathname === '/api/v1/beans' && init.method === 'POST') { const item = {id: 'bean-' + randomUUID(), ...JSON.parse(init.body)}; state.beans.push(item); return json(item, 201); }
    if (pathname === '/api/v1/beans') return json(state.beans);
    if (pathname.startsWith('/api/v1/beans/')) return json(state.beans.find(b => b.id === pathname.split('/').at(-1)) || {error: 'No such bean'});
    if (pathname.startsWith('/api/v1/bean-batches/')) return json({id: 'batch-1', beanId: 'bean-1', roastLevel: 'medium'});
    if (pathname === '/api/v1/grinders' && init.method === 'POST') { const item = {id: 'grinder-' + randomUUID(), ...JSON.parse(init.body)}; state.grinders.push(item); return json(item, 201); }
    if (pathname === '/api/v1/grinders') return json(state.grinders);
    if (pathname.startsWith('/api/v1/grinders/')) { const id = pathname.split('/').at(-1), item = state.grinders.find(g => g.id === id); if (!item) return json({error: 'No such grinder'}, 404); if (init.method === 'PUT' || init.method === 'PATCH') Object.assign(item, JSON.parse(init.body)); return json(item); }
    return json({error: 'Fixture does not implement ' + pathname}, 404);
  };
  reload(state);
  return state;
}
function reload(state) {
  state.plugin?.onUnload();
  let plugin;
  const host = {log() {}, storage(command) {
    if (command.type === 'read') setImmediate(() => plugin.onEvent({name: 'storageRead', payload: {key: command.key, value: clone(state.storage[command.key] || {})}}));
    if (command.type === 'write') {
      if (state.config.storageFail) return;
      state.storage[command.key] = clone(command.data);
      setImmediate(() => plugin.onEvent({name: 'storageWrite', payload: {key: command.key}}));
    }
  }};
  const context = {console, Date, JSON, Math, Number, Object, Set, Promise, URL, URLSearchParams, setTimeout, clearTimeout, fetch: state.fetch};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'plugin.js'), 'utf8') + '\nthis.factory=createPlugin;', context);
  plugin = context.factory(host, {fetch: state.fetch});
  plugin.onLoad(state.settings);
  state.plugin = plugin;
}
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/plain'};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const cookie = req.headers.cookie?.match(/(?:^|; )dialin-test=([^;]+)/)?.[1];
    let id = cookie, state = sessions.get(id);
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 5 * 1024 * 1024) throw new Error('Fixture request too large'); }
    const body = raw ? JSON.parse(raw) : undefined;
    if (url.pathname === '/__test/reset' || !state && url.pathname.startsWith('/api/')) { id = randomUUID(); state = newSession(); sessions.set(id,state); res.setHeader('Set-Cookie', `dialin-test=${id}; Path=/; HttpOnly; SameSite=Lax`); }
    const send = (body, status = 200) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); };
    if (url.pathname === '/__test/reset') return send({id});
    if (url.pathname === '/__test/config') { Object.assign(state.config, body); if (body.shots) state.shots = body.shots; if (body.workflow) state.workflow = body.workflow; return send({ok: true}); }
    if (url.pathname === '/__test/reload') { reload(state); return send({ok: true}); }
    if (url.pathname === '/__test/state') return send({beans: state.beans, grinders: state.grinders, storage: state.storage, requests: state.requests, workflow: state.workflow, shots: state.shots});
    if (url.pathname.startsWith('/api/v1/plugins/assisted-dialin.reaplugin/')) {
      const endpoint = url.pathname.split('/').at(-1);
      const reply = await state.plugin.handleHttpRequest({endpoint, method: req.method, query: Object.fromEntries(url.searchParams), body});
      res.writeHead(reply.status, {'Content-Type': endpoint === 'ui' ? 'text/html; charset=utf-8' : 'application/json'}); return res.end(reply.body);
    }
    if (url.pathname.startsWith('/api/')) { const reply = await state.fetch(url.href, {method: req.method, ...(raw ? {body: raw} : {})}); return send(await reply.json(), reply.status); }
    const filename = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/simulator/index.html' : url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
    if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return send({error: 'Not found'}, 404);
    res.writeHead(200, {'Content-Type': types[path.extname(filename)] || 'application/octet-stream'}); fs.createReadStream(filename).pipe(res);
  } catch (error) { res.writeHead(500, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error: error.message})); }
});
server.listen(Number(process.env.DIALIN_TEST_PORT || 9017), '127.0.0.1');
process.on('SIGTERM', () => { for (const state of sessions.values()) state.plugin.onUnload(); server.close(() => process.exit(0)); });
module.exports = {savedShot};
