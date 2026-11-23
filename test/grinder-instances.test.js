const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("plugin.js", "utf8");
const NS = "assisted-dialin.reaplugin";
const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(body)) });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
let nextId = 0;
const grinder = (fields) => ({ id: "g-" + (++nextId), archived: false, settingType: "numeric", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...fields });

// Decaid's grinder routes with the host's semantics: PUT is a shallow
// top-level merge (extras replaced wholesale), GET by id 404s when missing.
function load({ grinders = [], workflow = dfWorkflow(), shots = [], stored = {}, settings = {}, afterPut, fail, machine = "idle", routes: extra } = {}) {
  const storage = new Map(Object.entries(stored)), requests = [], workflowWrites = [], notices = [];
  let plugin;
  const routes = async (url, init = {}) => {
    const parsed = new URL(url), path = parsed.pathname, method = init.method || "GET";
    requests.push(method + " " + path);
    if (fail?.(method, path)) return ok({ error: "unavailable" }, 503);
    if (path === "/api/v1/workflow" && method === "PUT") {
      const body = JSON.parse(init.body); workflowWrites.push(body);
      // Decaid deep-merges the context; one level is enough here.
      for (const [key, value] of Object.entries(body.context?.extras || {}))
        workflow.context.extras[key] = value && typeof value === "object" ? { ...workflow.context.extras[key], ...value } : value;
      return ok(workflow);
    }
    if (path === "/api/v1/workflow") return ok(workflow);
    if (path === "/api/v1/machine/state") return ok({ state: { state: typeof machine === "function" ? machine() : machine, substate: "idle" } });
    const routed = extra?.(path);
    if (routed !== undefined) return routed === null ? ok({ error: "missing" }, 404) : ok(routed);
    if (path === "/api/v1/grinders" && method === "GET")
      return ok(grinders.filter((item) => parsed.searchParams.get("includeArchived") === "true" || !item.archived));
    if (path === "/api/v1/grinders" && method === "POST") { const record = grinder(JSON.parse(init.body)); grinders.push(record); return ok(record, 201); }
    const match = /^\/api\/v1\/grinders\/(.+)$/.exec(path);
    if (match) {
      const record = grinders.find((item) => item.id === decodeURIComponent(match[1]));
      if (!record) return ok({ error: "Grinder not found" }, 404);
      if (method === "PUT") { Object.assign(record, JSON.parse(init.body)); afterPut?.(record); }
      return ok(record);
    }
    if (path === "/api/v1/shots") return ok({ items: shots, total: shots.length });
    if (path === "/api/v1/bean-batches/batch-1") return ok({ id: "batch-1", beanId: "bean-1" });
    if (path === "/api/v1/beans/bean-1") return ok({ id: "bean-1", name: "Fixture" });
    const shot = shots.find((item) => path === "/api/v1/shots/" + item.id);
    return shot ? ok(shot) : ok({}, 404);
  };
  const host = {
    log(message) { if (process.env.DEBUG_LOG) console.log(message); },
    notify(notice) { notices.push(JSON.parse(JSON.stringify(notice))); return "n-" + notices.length; },
    storage(command) {
      if (command.type === "read") queueMicrotask(() => plugin.onEvent({ name: "storageRead", payload: { key: command.key, value: storage.get(command.key) ?? null } }));
      else { storage.set(command.key, JSON.parse(JSON.stringify(command.data))); queueMicrotask(() => plugin.onEvent({ name: "storageWrite", payload: command.data })); }
    },
  };
  const context = vm.createContext({ console, setTimeout, clearTimeout, Date, JSON, Math, Promise, URL, URLSearchParams, queueMicrotask, fetch: routes });
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  plugin = context.createPlugin(host);
  plugin.onLoad({ TargetTimeSec: 28, ...settings });
  const call = async (endpoint, method = "GET", body, query) => {
    const response = await plugin.handleHttpRequest({ endpoint, method, body, query });
    return { status: response.status, body: /json/.test(response.headers?.["Content-Type"] || "application/json") ? JSON.parse(response.body) : response.body };
  };
  return { plugin, call, storage, grinders, requests, workflowWrites, notices };
}
function dfWorkflow(context = {}, extras = { grinderSettingUnit: "marks" }) {
  return { profile: { title: "espresso", steps: [{ pump: "pressure", pressure: 9 }] },
    context: { beanBatchId: "batch-1", targetDoseWeight: 18, targetYield: 36, ...context, extras: { calibrationEpoch: "epoch-1", basket: "58mm", ...extras } } };
}
async function sourShots(h, shots, setting = "10", context = {}) {
  for (const [index, id] of ["a", "b", "c"].entries()) {
    shots.push({ id, timestamp: new Date(Date.now() - (index + 1) * 3600000).toISOString(), workflow: dfWorkflow({ grinderSetting: setting, ...context }), measurements: [] });
    assert.equal((await h.call("feedback", "POST", { shotId: id, good: false, taste: "sour", brewTimeSec: 22, brewTimeClock: "pump" })).status, 200);
  }
}

test("the current grinder is the workflow's, then the plugin's choice, then the only grinder", async () => {
  const df = grinder({ model: "DF64 Gen 1", burrs: "SSP HU" }), e64 = grinder({ model: "Mahlkönig E64 WS" });
  let h = load({ grinders: [df, e64], workflow: dfWorkflow({ grinderId: e64.id }) });
  assert.deepEqual((await h.call("grinders")).body.current, { grinderId: e64.id, source: "workflow" });
  h = load({ grinders: [df, e64] });
  assert.deepEqual((await h.call("grinders")).body.current, { grinderId: null, source: null }, "two grinders and no choice: none");
  assert.equal((await h.call("grinders", "POST", { operation: "select", grinderId: df.id })).status, 200);
  assert.deepEqual((await h.call("grinders")).body.current, { grinderId: df.id, source: "plugin-selection" });
  assert.equal((await h.call("grinders", "POST", { operation: "select", grinderId: "missing" })).status, 400);
  h = load({ grinders: [df, grinder({ model: "Old", archived: true })] });
  assert.deepEqual((await h.call("grinders")).body.current, { grinderId: df.id, source: "single-grinder" });
});

test("the plugin's grinder choice survives a reload", async () => {
  const df = grinder({ model: "DF64 Gen 1" }), e64 = grinder({ model: "Mahlkönig E64 WS" });
  const first = load({ grinders: [df, e64] });
  await first.call("grinders", "POST", { operation: "select", grinderId: e64.id });
  const second = load({ grinders: [df, e64], stored: { "grinderProfiles.v1": first.storage.get("grinderProfiles.v1") } });
  assert.deepEqual((await second.call("grinders")).body.current, { grinderId: e64.id, source: "plugin-selection" });
});

test("dial-in data is stored in the grinder record's namespaced extras and keeps other plugins' keys", async () => {
  const e64 = grinder({ model: "Mahlkönig E64 WS", extras: { source: "mahlkoenig-e64.reaplugin", instanceId: "sim", lastSeenAt: "2026-11-23T00:00:00Z" } });
  const h = load({ grinders: [e64] });
  const saved = await h.call("grinders", "POST", { grinderId: e64.id, dialIn: { settingUnit: "micrometres", finerDelta: -1, stepSize: 5, minSetting: 0, maxSetting: 200, calibrationEpoch: "burrs-2026" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(e64.extras.source, "mahlkoenig-e64.reaplugin");
  assert.equal(e64.extras.lastSeenAt, "2026-11-23T00:00:00Z");
  assert.equal(e64.extras[NS].finerDelta, -1);
  assert.equal(e64.extras[NS].schemaVersion, 1);
  assert.equal(e64.model, "Mahlkönig E64 WS", "user-owned fields are never written");
  const listed = (await h.call("grinders")).body.grinders[0];
  assert.equal(listed.source, "mahlkoenig-e64.reaplugin");
  assert.equal(listed.dialIn.stepSize, 5);
  for (const dialIn of [{ finerDelta: 2 }, { minSetting: 10, maxSetting: 1 }, { unknown: true }, { stepSize: -1 }])
    assert.equal((await h.call("grinders", "POST", { grinderId: e64.id, dialIn })).status, 400, JSON.stringify(dialIn));
});

test("a concurrent extras rewrite by another plugin is detected and the merge retried", async () => {
  const e64 = grinder({ model: "Mahlkönig E64 WS", extras: { source: "mahlkoenig-e64.reaplugin" } });
  let raced = false;
  // Right after our write, the E64 plugin replaces extras from a stale read.
  const h = load({ grinders: [e64], afterPut: (record) => {
    if (!raced && record.extras?.[NS]) { raced = true; record.extras = { source: "mahlkoenig-e64.reaplugin", lastSeenAt: "now" }; }
  } });
  assert.equal((await h.call("grinders", "POST", { grinderId: e64.id, dialIn: { finerDelta: 1 } })).status, 200);
  assert.equal(raced, true);
  assert.equal(e64.extras[NS].finerDelta, 1);
  assert.equal(e64.extras.lastSeenAt, "now", "the other plugin's update is kept too");
});

test("suggestions use the record's model, burrs and small step, with the grinder's dial-in data winning", async () => {
  const df = grinder({ model: "DF64 Gen 1", burrs: "SSP HU", settingSmallStep: 1, extras: { [NS]: { finerDelta: -1, settingUnit: "marks" } } });
  const shots = [];
  const h = load({ grinders: [df], shots, workflow: dfWorkflow({ grinderId: df.id, grinderSetting: "10", grinderModel: "DF64 Gen 1", grinderBurrs: "SSP HU" }) });
  await sourShots(h, shots, "10", { grinderId: df.id, grinderModel: "DF64 Gen 1", grinderBurrs: "SSP HU" });
  let body = (await h.call("suggestion")).body;
  assert.equal(body.status, "suggestion", body.reason);
  assert.deepEqual(body.grinder, { id: df.id, model: "DF64 Gen 1", settingType: "numeric", source: "workflow" });
  assert.equal(body.proposedSetting, 9, "settingSmallStep is the default step");
  df.extras[NS].stepSize = 2;
  body = (await h.call("suggestion")).body;
  assert.equal(body.proposedSetting, 8, "a calibrated step wins");
});

test("preset grinders never get a number: the neighbouring preset is proposed", async () => {
  const preset = grinder({ model: "Preset grinder", burrs: "stock", settingType: "preset", settingValues: ["Fine", "Medium", "Coarse"], extras: { [NS]: { finerDelta: -1 } } });
  const shots = [];
  const h = load({ grinders: [preset], shots, workflow: dfWorkflow({ grinderId: preset.id, grinderSetting: "Medium", grinderModel: "Preset grinder", grinderBurrs: "stock" }, { grinderSettingUnit: "preset" }) });
  await sourShots(h, shots, "Medium", { grinderId: preset.id, grinderModel: "Preset grinder", grinderBurrs: "stock" });
  shots.forEach((shot) => { shot.workflow.context.extras.grinderSettingUnit = "preset"; });
  const body = (await h.call("suggestion")).body;
  assert.equal(body.status, "suggestion", body.reason);
  assert.equal(body.proposedSetting, null);
  assert.equal(body.proposedPreset, "Fine");
});

test("legacy grinder profiles move into Decaid records once, without duplicates or overwriting user fields", async () => {
  const bound = grinder({ model: "DF64 Gen 1", burrs: "User-edited burrs" });
  const e64 = grinder({ model: "Mahlkönig E64 WS", extras: { source: "mahlkoenig-e64.reaplugin" } });
  const already = grinder({ model: "DF54", extras: { [NS]: { calibrationEpoch: "user-set" } } });
  const anchors = { dialMin: 0, dialMax: 90, dialA: 0, ddDumA: 300, dialB: 90, ddDumB: 1200 };
  const profile = (id, fields) => ({ id, label: id, hostGrinderId: "missing", model: "DF64 Gen 1", burrIdentity: "SSP HU", calibrationEpoch: "zero-1", pitchSource: "owner", ownerAnchors: null, ...fields });
  const legacy = { key: "grinderProfiles.v1", schemaVersion: 1, selectedProfileId: "kitchen", profiles: {
    kitchen: profile("kitchen", { hostGrinderId: bound.id, ownerAnchors: { ...anchors, grinderId: "kitchen", model: "DF64 Gen 1", burrIdentity: "SSP HU", calibrationEpoch: "zero-1" } }),
    e64: profile("e64", { model: "E64 WS", burrIdentity: "stock" }),
    df54: profile("df54", { model: "DF54", burrIdentity: "stock" }),
    office: profile("office", { model: "LAGOM P64", burrIdentity: "SSP MP" }),
  } };
  const grinders = [bound, e64, already];
  const h = load({ grinders, stored: { "grinderProfiles.v1": legacy } });
  const first = (await h.call("grinders")).body;
  assert.deepEqual(first.migration, { completed: false, migrated: 4, legacyProfiles: 4 });
  assert.equal(bound.burrs, "User-edited burrs", "user-edited fields stay");
  assert.equal(bound.extras[NS].migratedFrom, "kitchen");
  assert.deepEqual(bound.extras[NS].dialCalibration, anchors);
  assert.equal(e64.extras[NS].migratedFrom, "e64", "the E64 plugin's record is adopted, not duplicated");
  assert.equal(e64.extras.source, "mahlkoenig-e64.reaplugin");
  assert.deepEqual(already.extras[NS], { calibrationEpoch: "user-set" }, "existing dial-in data is never overwritten");
  const created = grinders.find((item) => item.model === "LAGOM P64");
  assert.equal(created.extras[NS].migratedFrom, "office");
  assert.equal(created.burrs, "SSP MP");
  assert.equal(first.selectedGrinderId, bound.id, "the selected legacy profile becomes the selected grinder");
  const count = grinders.length;
  const second = (await h.call("grinders")).body;
  assert.equal(second.migration.completed, true);
  assert.equal(grinders.length, count, "re-running creates nothing");
  // A fresh load that lost the migration marker still finds the created record by migratedFrom.
  const lostMarker = { ...legacy };
  const again = load({ grinders, stored: { "grinderProfiles.v1": lostMarker } });
  await again.call("grinders");
  assert.equal(grinders.length, count);
});

test("a feedback write acknowledgement never acknowledges a pending grinder-store write", async () => {
  const df = grinder({ model: "DF64 Gen 1" });
  const writes = [];
  let plugin;
  const host = {
    log() {},
    storage(command) {
      if (command.type === "read") setTimeout(() => plugin.onEvent({ name: "storageRead", payload: { key: command.key, value: null } }), 0);
      else writes.push(command);
    },
  };
  const context = vm.createContext({ console, setTimeout, clearTimeout, Date, JSON, Math, Promise, URL, URLSearchParams, queueMicrotask,
    fetch: async (url) => { const path = new URL(url).pathname; return path === "/api/v1/grinders/" + df.id ? ok(df) : path === "/api/v1/grinders" ? ok([df]) : ok({}, 404); } });
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  plugin = context.createPlugin(host);
  plugin.onLoad({});
  const settled = (promise) => { const state = { done: false }; promise.then((value) => { state.done = true; state.value = value; }); return state; };
  const feedback = settled(plugin.handleHttpRequest({ endpoint: "feedback", method: "POST", body: { shotId: "shot-1", good: true } }));
  const select = settled(plugin.handleHttpRequest({ endpoint: "grinders", method: "POST", body: { operation: "select", grinderId: df.id } }));
  await settle();
  const ack = (key) => plugin.onEvent({ name: "storageWrite", payload: writes.filter((command) => command.key === key).at(-1).data });
  ack("feedback.v1");
  await settle(); await settle();
  assert.equal(feedback.value.status, 200);
  assert.equal(select.done, false, "the grinder store was acknowledged before its own write");
  // Acknowledge every grinder-store write in order (the migration marker, then the choice).
  for (let i = 0; i < 3 && !select.done; i++) {
    for (const command of writes.filter((item) => item.key === "grinderProfiles.v1").splice(0)) plugin.onEvent({ name: "storageWrite", payload: command.data });
    writes.splice(0, writes.length, ...writes.filter((item) => item.key !== "grinderProfiles.v1"));
    await settle();
  }
  assert.equal(select.value.status, 200);
});

test("dial-in data in force for the workflow's grinder is snapshotted into the active workflow's namespaced extras, only on change", async () => {
  const df = grinder({ model: "DF64 Gen 1", burrs: "SSP HU" }), other = grinder({ model: "DF54" });
  const workflow = dfWorkflow({ grinderId: df.id });
  workflow.context.extras["mahlkoenig-e64.reaplugin"] = { untouched: true };
  const h = load({ grinders: [df, other], workflow });
  const first = await h.call("grinders", "POST", { grinderId: df.id, dialIn: { calibrationEpoch: "zero-2", settingUnit: "marks", finerDelta: -1 } });
  assert.equal(first.body.workflowSnapshot, "written");
  assert.deepEqual(h.workflowWrites, [{ context: { extras: { [NS]: { schemaVersion: 1, grinderId: df.id, calibrationEpoch: "zero-2", settingUnit: "marks", finerDelta: -1, stepSize: null } } } }]);
  assert.deepEqual(workflow.context.extras["mahlkoenig-e64.reaplugin"], { untouched: true }, "only this plugin's key is sent");
  assert.equal((await h.call("grinders", "POST", { grinderId: df.id, dialIn: { calibrationEpoch: "zero-2", settingUnit: "marks", finerDelta: -1 } })).body.workflowSnapshot, "unchanged");
  assert.equal((await h.call("grinders", "POST", { grinderId: df.id, dialIn: { calibrationEpoch: "zero-3", settingUnit: "marks", finerDelta: -1 } })).body.workflowSnapshot, "rate-limited");
  assert.equal((await h.call("grinders", "POST", { grinderId: other.id, dialIn: { finerDelta: 1 } })).body.workflowSnapshot, "not-current");
  assert.equal(h.workflowWrites.length, 1);
  h.plugin.onEvent({ name: "workflowUpdated", payload: workflow });
  await settle();
  assert.equal(h.workflowWrites.length, 1, "workflow events never cause a write");
});

test("a stored shot's workflow snapshot is the primary grinder record; plugin links only fill older shots", async () => {
  const e64 = grinder({ model: "Mahlkönig E64 WS" });
  const snapshot = (extras) => ({ id: "snap", timestamp: new Date(Date.now() - 60000).toISOString(), measurements: [],
    workflow: { profile: { title: "espresso", steps: [{ pump: "pressure", pressure: 9 }] },
      context: { grinderId: e64.id, grinderModel: "Mahlkönig E64 WS", beanBatchId: "batch-1", extras: { grinderSettingUnit: "micrometres", ...extras } } } });
  const shot = snapshot({ "mahlkoenig-e64.reaplugin": { displayedSetting: "83", unit: "µm", ddValueDum: 827, lastGrind: { targetWeightGr: 18, resultWeightGr: 18.07, motorRunTimeMs: 8300 } },
    [NS]: { calibrationEpoch: "zero-2" } });
  const stale = { key: "grinderObservations.v1", schemaVersion: 1, shots: { snap: { display: 90, observedAt: new Date().toISOString(),
    grind: { grindUuid: null, completedAt: new Date(Date.now() - 90000).toISOString(), success: true, recipe: {}, targets: {}, weightG: 17.5 } } } };
  const h = load({ grinders: [e64], shots: [shot], stored: { "grinderObservations.v1": stale } });
  const analysis = (await h.call("analysis", "POST", { shotId: "snap" })).body;
  assert.equal(analysis.context.grinderSetting, "83");
  assert.equal(analysis.context.grinderSettingSource, "workflow-snapshot");
  assert.equal(analysis.context.calibrationEpoch, "zero-2", "this plugin's snapshotted extras fill the calibration epoch");
  assert.equal(analysis.grind.source, "workflow-snapshot");
  assert.equal(analysis.grind.weightG, 18.07);
  assert.equal(analysis.linkedGrind.weightG, 17.5, "the plugin's own link is still reported");
  assert.deepEqual(analysis.doseEvidence, { grams: 18.07, source: "grinder-reported ground weight (workflow snapshot)" });
  const old = load({ grinders: [e64], shots: [snapshot({})], stored: { "grinderObservations.v1": stale } });
  const fallback = (await old.call("analysis", "POST", { shotId: "snap" })).body;
  assert.equal(fallback.context.grinderSetting, "90");
  assert.equal(fallback.context.grinderSettingSource, "recorded-live-observation");
  assert.equal(fallback.grind.weightG, 17.5);
});

test("analysis links a shot uploaded by Decaid's Visualizer plugin, on visualizer.coffee or a self-hosted https site", async () => {
  const shot = { id: "up", timestamp: new Date().toISOString(), measurements: [], annotations: { extras: { visualizerId: "abc-123" } },
    workflow: { profile: { title: "espresso", steps: [{ pump: "pressure", pressure: 9 }] }, context: { beanBatchId: "batch-1", extras: {} } } };
  assert.deepEqual((await load({ shots: [shot] }).call("analysis", "POST", { shotId: "up" })).body.visualizer, { id: "abc-123", url: "https://visualizer.coffee/shots/abc-123" });
  assert.equal((await load({ shots: [shot], settings: { VisualizerBaseUrl: "https://visualizer.example.org/" } }).call("analysis", "POST", { shotId: "up" })).body.visualizer.url,
    "https://visualizer.example.org/shots/abc-123");
  assert.equal((await load({ shots: [shot], settings: { VisualizerBaseUrl: "http://insecure.example" } }).call("analysis", "POST", { shotId: "up" })).body.visualizer.url,
    "https://visualizer.coffee/shots/abc-123", "only https bases are used");
  const none = { ...shot, annotations: {} };
  assert.equal((await load({ shots: [none] }).call("analysis", "POST", { shotId: "up" })).body.visualizer, null);
});

test("an interrupted migration keeps finished profiles and resumes where it stopped", async () => {
  const profile = (id, model) => ({ id, label: id, hostGrinderId: "missing", model, burrIdentity: "stock", calibrationEpoch: "zero-1", pitchSource: "owner", ownerAnchors: null });
  const legacy = { key: "grinderProfiles.v1", schemaVersion: 1, selectedProfileId: null,
    profiles: { a: profile("a", "DF64 Gen 1"), b: profile("b", "LAGOM P64") } };
  const df = grinder({ model: "DF64 Gen 1" }), grinders = [df];
  let down = true;
  const h = load({ grinders, stored: { "grinderProfiles.v1": legacy }, fail: (method, path) => down && method === "POST" && path === "/api/v1/grinders" });
  const first = (await h.call("grinders")).body;
  assert.deepEqual(first.migration, { completed: false, migrated: 1, legacyProfiles: 2 }, "the adopted profile is kept despite the failed create");
  assert.equal(df.extras[NS].migratedFrom, "a");
  down = false;
  await h.call("grinders");
  assert.equal(grinders.filter((item) => item.model === "LAGOM P64").length, 1);
  assert.equal((await h.call("grinders")).body.migration.completed, true);
  assert.equal(grinders.length, 2);
});

test("the setup assistant is its own endpoint (and ui?view=setup), and reports what is still missing", async () => {
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  assert.deepEqual(manifest.surfaces.find((surface) => surface.role === "setup"), { id: "setup", role: "setup", endpoint: "setup", label: "Set up assisted dial-in" });
  assert.ok(manifest.api.some((item) => item.id === "setup"));
  assert.ok(!manifest.api.some((item) => item.id === "settings"), "Decaid's own settings route shadows a plugin endpoint of that name");
  const visible = Object.entries(manifest.settings).filter(([, value]) => !value.hidden).map(([key]) => key);
  assert.deepEqual(visible, ["TargetTimeSec", "TargetTimeClock", "TimeToleranceSec", "RecommendationNotices", "EvidenceMaxAgeDays", "VisualizerBaseUrl"]);
  assert.equal(Object.values(manifest.settings).filter((value) => value.hidden).length, 18);
  for (const [key, value] of Object.entries(manifest.settings)) assert.ok(value.label && value.description, key);
  assert.deepEqual(Object.keys(manifest.settings.TargetTimeClock.valueLabels), manifest.settings.TargetTimeClock.values);

  const df = grinder({ model: "DF64 Gen 1", burrs: "SSP HU", settingSmallStep: 1 });
  const h = load({ grinders: [df], settings: { TargetTimeSec: 0 } });
  const page = await h.call("setup");
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Set up assisted dial-in<\/title>/);
  assert.match(page.body, /<script data-pu>/);
  const script = page.body.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script, { filename: "setup-assistant.js" });
  assert.equal((await h.call("ui", "GET", undefined, { view: "setup" })).body, page.body);
  assert.deepEqual((await h.call("setup", "GET", undefined, { status: "1" })).body,
    { needsSetup: true, missing: ["dial", "targetTime"], grinderId: df.id, grinderSource: "single-grinder" });
  await h.call("grinders", "POST", { grinderId: df.id, dialIn: { settingUnit: "marks", finerDelta: -1 } });
  h.plugin.onLoad({ TargetTimeSec: 28 });
  assert.deepEqual((await h.call("setup", "GET", undefined, { status: "1" })).body,
    { needsSetup: false, missing: [], grinderId: df.id, grinderSource: "single-grinder" }, "the record's small step is the default step");
  assert.equal((await h.call("settings")).status, 404, "no shadowed plugin settings endpoint");
});

// Background recommendations: computed after a stored shot and after feedback,
// kept with the shot, shown as one notice and copied into the workflow.
const debounce = () => new Promise((resolve) => setTimeout(resolve, 1800));
const unloadAfter = [];
test.afterEach(() => unloadAfter.splice(0).forEach((plugin) => plugin.onUnload()));
async function recentShotChain(options = {}) {
  const df = grinder({ model: "DF64 Gen 1", burrs: "SSP HU", settingSmallStep: 1, extras: { [NS]: { finerDelta: -1, settingUnit: "marks" } } });
  const context = { grinderId: df.id, grinderSetting: "10", grinderModel: "DF64 Gen 1", grinderBurrs: "SSP HU" };
  const shots = [], workflow = dfWorkflow(context);
  workflow.context.extras[NS] = { schemaVersion: 1, grinderId: df.id, settingUnit: "marks" };
  const h = load({ grinders: [df], shots, workflow, ...options });
  unloadAfter.push(h.plugin);
  await sourShots(h, shots, "10", context);
  const shot = (id, ageMs) => ({ id, timestamp: new Date(Date.now() - ageMs).toISOString(), workflow: dfWorkflow(context), measurements: [] });
  return { h, df, shots, workflow, shot };
}

test("a stored shot gets its next-step recommendation in the background: brew log, one notice, workflow snapshot", async () => {
  const { h, shots, workflow, shot } = await recentShotChain();
  shots.unshift(shot("new", 30000));
  h.plugin.onEvent({ name: "shotStored", payload: { id: "new" } });
  await debounce();
  const first = (await h.call("recommendations", "GET", undefined, { shotId: "new" })).body.recommendation;
  assert.equal(first.status, "suggestion");
  assert.equal(first.trigger, "shotStored");
  assert.match(first.message, /^Next shot: grind 1 .*finer \(10 → 9\)\.$/);
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.notices[0], { id: "recommendation", message: first.message, action: { id: "open", label: "Open dial-in", type: "openPluginSurface", surfaceId: "dialin" } });
  // A host without the openPluginSurface action rejects it; the notice is sent again without one.
  h.plugin.onEvent({ name: "notificationResult", payload: { requestId: "n-1", id: "recommendation", status: "rejected", reason: "validation" } });
  assert.deepEqual(h.notices[1], { id: "recommendation", message: first.message });
  assert.equal(h.workflowWrites.length, 1);
  assert.equal(h.workflowWrites[0].context.extras[NS].recommendation.afterShotId, "new");
  assert.deepEqual(workflow.context.extras[NS].settingUnit, "marks", "the dial-in fields under the same key stay");
  assert.equal(workflow.context.extras[NS].recommendation.message, first.message);
  // Feedback for the shot refreshes the same notice with the shot's time.
  assert.equal((await h.call("feedback", "POST", { shotId: "new", good: false, taste: "sour", brewTimeSec: 23, brewTimeClock: "pump" })).status, 200);
  await debounce();
  const second = (await h.call("recommendations", "GET", undefined, { shotId: "new" })).body.recommendation;
  assert.equal(second.trigger, "feedback");
  assert.match(second.message, /; last shot 23 s vs target 28 s\.$/);
  assert.equal(h.notices.length, 3);
  assert.deepEqual(h.notices[2], { id: "recommendation", message: second.message }, "same notice id, no action once rejected");
  assert.equal(h.workflowWrites.length, 1, "a second workflow write waits for the 30 s write interval");
  // Saving the same feedback again changes nothing visible.
  await h.call("feedback", "POST", { shotId: "new", good: false, taste: "sour", brewTimeSec: 23, brewTimeClock: "pump" });
  await debounce();
  assert.equal(h.notices.length, 3);
  const batch = (await h.call("recommendations", "GET", undefined, { shotIds: "new,a" })).body;
  assert.deepEqual(Object.keys(batch.recommendations), ["new", "a"]);
  assert.equal(batch.recommendations.a, null, "older history shots get none");
  assert.equal((await h.call("recommendations")).body.latest[0].shotId, "new");
  assert.equal((await h.call("recommendations", "GET", undefined, { shotIds: "../x" })).status, 400);
  assert.equal((await h.call("analysis", "POST", { shotId: "new" })).body.recommendation.message, second.message);
});

test("background recommendations: no notice for imports or when turned off, and no workflow write during a shot", async () => {
  let chain = await recentShotChain();
  chain.shots.unshift(chain.shot("old", 2 * 3600000), chain.shot("half-hour", 30 * 60000));
  chain.h.plugin.onEvent({ name: "shotStored", payload: { id: "old" } });
  chain.h.plugin.onEvent({ name: "shotStored", payload: { id: "half-hour" } });
  await debounce();
  assert.equal((await chain.h.call("recommendations", "GET", undefined, { shotId: "old" })).body.recommendation, null);
  assert.ok((await chain.h.call("recommendations", "GET", undefined, { shotId: "half-hour" })).body.recommendation, "kept in the brew log");
  assert.equal(chain.h.notices.length, 0, "only a shot from the last 15 minutes is announced");

  chain = await recentShotChain({ settings: { RecommendationNotices: "off" }, machine: "espresso" });
  chain.shots.unshift(chain.shot("quiet", 10000));
  chain.h.plugin.onEvent({ name: "shotStored", payload: { id: "quiet" } });
  await debounce();
  assert.ok((await chain.h.call("recommendations", "GET", undefined, { shotId: "quiet" })).body.recommendation);
  assert.equal(chain.h.notices.length, 0);
  assert.equal(chain.h.workflowWrites.length, 0, "never written while the machine is pulling a shot");
});

test("bean context follows the workflow's bean batch (a real Decaid bean), not the plugin setting", async () => {
  const batch = "81dc5fae-0000-4000-8000-000000000001", bean = "8ce30f0b-0000-4000-8000-000000000001";
  const workflow = dfWorkflow({ beanBatchId: batch });
  const h = load({ workflow, settings: { BeanBatchId: "batch-1" }, routes: (path) =>
    path === "/api/v1/bean-batches/" + batch ? { id: batch, beanId: bean, roastDate: "2026-11-09T00:00:00.000", roastLevel: "medium-light" }
    : path === "/api/v1/beans/" + bean ? { id: bean, roaster: "Kaffeemacher", name: "Apas", archived: false } : undefined });
  const body = (await h.call("bean-context")).body;
  assert.equal(body.status, "available");
  assert.equal(body.beanBatchId, batch);
  assert.deepEqual(body.bean, { name: "Apas", roaster: "Kaffeemacher" });
  assert.deepEqual(body.batch, { roastLevel: "medium-light", roastDate: "2026-11-09T00:00:00.000" });
});
