// E64 WS simulator -> E64 Decaid plugin -> grinder observation, for browser tests.
//
// Starts the private research repository's simulator (never copied here), loads
// the E64 plugin's plugin.js unchanged, and gives it a minimal Decaid host:
// host.transport WebSockets and host.devices registration. Publications become
// the GET /api/v1/grinder/info and /state documents Decaid serves (host-owned
// timestamp, no carry-forward). The real Decaid QuickJS host is exercised by
// ci/sim_host_runtime_test.dart; this bridge only lets the browser page see a
// sim-sourced value.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const SIM_TOKEN = 'mock-e64-token-0001';

function locate() {
  const simRoot = path.resolve(process.env.E64_SIM_ROOT || path.join(repoRoot, '..', 'mahlkoenig-e64ws-local-research'));
  const pluginRoot = path.resolve(process.env.E64_PLUGIN_ROOT || path.join(repoRoot, '..', 'decaid-e64ws-plugin'));
  const script = path.join(simRoot, 'tools', 'e64ws_simulator.py');
  const venv = path.join(simRoot, '.venv', 'bin', 'python');
  const python = process.env.E64_SIM_PYTHON || (fs.existsSync(venv) ? venv : 'python3');
  const missing = [];
  if (!fs.existsSync(script)) missing.push(`E64 simulator not found at ${script} (set E64_SIM_ROOT)`);
  for (const file of ['plugin.js', 'manifest.json'])
    if (!fs.existsSync(path.join(pluginRoot, file))) missing.push(`E64 plugin ${file} not found in ${pluginRoot} (set E64_PLUGIN_ROOT)`);
  return { simRoot, pluginRoot, script, python, missing };
}

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

async function waitFor(check, what, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { const value = await check(); if (value) return value; } catch (_) {}
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startSimulator(where) {
  const [port, httpPort, scalePort] = [await freePort(), await freePort(), await freePort()];
  const child = spawn(where.python, [where.script, '--host', '127.0.0.1', '--port', String(port),
    '--http-port', String(httpPort), '--scale-port', String(scalePort), '--token', SIM_TOKEN],
    { cwd: where.simRoot, stdio: ['ignore', 'ignore', 'pipe'] });
  // Never outlive the test server that started it.
  process.once('exit', () => child.kill());
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const control = `http://127.0.0.1:${httpPort}`;
  try {
    await waitFor(async () => child.exitCode === null && (await fetch(control + '/sim/state')).ok, 'the E64 simulator');
    // The WebSocket listener can come up after the control API.
    await waitFor(() => new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => resolve(false));
    }), 'the E64 simulator WebSocket');
  } catch (error) {
    child.kill();
    throw new Error(`${error.message}; simulator stderr: ${stderr.trim() || '(empty)'}`);
  }
  const post = async (route, body = {}) => {
    const response = await fetch(control + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`simulator ${route} returned ${response.status}`);
    return response.json();
  };
  return { port, control, post, stop: () => child.kill() };
}

function loadE64Plugin(where, simPort) {
  const manifest = JSON.parse(fs.readFileSync(path.join(where.pluginRoot, 'manifest.json'), 'utf8'));
  const driver = manifest.drivers.find((item) => item.type === 'grinder');
  const sockets = new Map();
  let nextHandle = 0, device = null;
  const transport = {
    open({ kind, url }) {
      if (kind !== 'websocket') return Promise.reject(new Error('only websocket transport is bridged'));
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.addEventListener('open', () => { const handle = 'ws-' + (++nextHandle); sockets.set(handle, socket); resolve({ handle }); }, { once: true });
        socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
      });
    },
    onEvent(handle, callback) {
      const socket = sockets.get(handle);
      socket.addEventListener('message', (event) => callback({ type: 'data', dataType: 'text', data: String(event.data) }));
      socket.addEventListener('close', () => callback({ type: 'close' }));
      socket.addEventListener('error', () => callback({ type: 'error' }));
    },
    send(handle, payload) {
      const socket = sockets.get(handle);
      if (!socket) return Promise.reject(new Error('closed'));
      socket.send(payload.data);
      return Promise.resolve();
    },
    close(handle) { sockets.get(handle)?.close(); sockets.delete(handle); return Promise.resolve(); },
  };
  const host = {
    log() {},
    transport,
    devices: {
      register(definition, handlers) {
        const deviceId = `plugin:${manifest.id}:${definition.driverId}:${definition.instanceId}`;
        device = { deviceId, handlers, snapshot: null };
        return Promise.resolve({ deviceId });
      },
    },
  };
  const context = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Math, Date, Number, String, Object, Array, Map, Set, Error, TextEncoder, TextDecoder, fetch, URL, encodeURIComponent, decodeURIComponent });
  vm.runInContext(fs.readFileSync(path.join(where.pluginRoot, 'plugin.js'), 'utf8') + '\nthis.createPlugin = createPlugin;', context);
  const plugin = context.createPlugin(host);
  const settings = {
    InstancesJson: JSON.stringify([{ id: 'sim', name: 'E64 WS simulator', scheme: 'ws', host: '127.0.0.1', port: simPort, pollMs: 200 }]),
    TokensJson: JSON.stringify({ sim: { host: '127.0.0.1', token: SIM_TOKEN } }),
  };
  return {
    async connect() {
      await plugin.onLoad(settings);
      if (!device) throw new Error('E64 plugin did not register a grinder');
      await device.handlers.connect({
        transport,
        // Decaid stamps each publication and never carries a field forward.
        publish: async (value) => { device.snapshot = { ...JSON.parse(JSON.stringify(value)), timestamp: new Date().toISOString() }; },
        publishInfo: async () => {},
        reportDisconnected: async () => { device.snapshot = null; },
      });
    },
    info() {
      if (!device) return null;
      return {
        deviceId: device.deviceId,
        capabilities: driver.capabilities || [],
        ...(driver.observations?.length ? { observations: driver.observations } : {}),
        ...(driver.surfaces ? { surfaces: driver.surfaces.map((surface) => ({ id: surface.id, role: surface.role, label: surface.label,
          href: `/api/v1/plugins/${manifest.id}/${surface.endpoint}?ui=1&deviceId=${encodeURIComponent(device.deviceId)}` })) } : {}),
      };
    },
    snapshot: () => device && device.snapshot,
    async stop() { await plugin.onUnload?.(); for (const socket of sockets.values()) socket.close(); },
  };
}

// Returns {sim, e64, setDd(value), stop()} or throws with the missing paths.
async function startE64SimBridge() {
  const where = locate();
  if (where.missing.length) { const error = new Error(where.missing.join('; ')); error.code = 'E64_SIM_MISSING'; throw error; }
  const sim = await startSimulator(where);
  let e64;
  try {
    e64 = loadE64Plugin(where, sim.port);
    await e64.connect();
    await waitFor(() => e64.snapshot()?.observedSetting, 'the first E64 observation');
  } catch (error) { sim.stop(); throw error; }
  return {
    sim, e64,
    async setDd(value) {
      await sim.post('/sim/action', { suffix: 'SetAgsaTargetDdValue', data: { targetDdValue: value } });
      await waitFor(() => e64.snapshot()?.observedSetting === `${value} ddValueDum`, `the E64 plugin to publish ${value} ddValueDum`);
    },
    async stop() { await e64?.stop().catch(() => {}); sim.stop(); },
  };
}

module.exports = { startE64SimBridge, locate };
