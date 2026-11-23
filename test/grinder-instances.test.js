const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("plugin.js", "utf8");

function fixture(stored = null, settings = { GrinderId: "host-device", GrinderModel: "DF64 Gen 1" }, failWrites = false) {
  let plugin;
  const storage = new Map([
    ["feedback.v1", null],
    ["grinderProfiles.v1", stored],
  ]);
  const host = {
    storage(command) {
      if (command.type === "read")
        setTimeout(() => plugin.onEvent({ name: "storageRead", payload: { key: command.key, value: storage.get(command.key) } }), 0);
      if (command.type === "write") {
        if (failWrites) throw new Error("storage offline");
        storage.set(command.key, command.data);
        setTimeout(() => plugin.onEvent({ name: "storageWrite", payload: command.data }), 0);
      }
    },
    log(message) { console.log(message); },
  };
  const context = vm.createContext({ console, setTimeout, clearTimeout, Date, JSON, Math, Promise, URLSearchParams, fetch: async (url) => {
    if (url.endsWith("/workflow")) return { ok: true, status: 200, json: async () => ({ context: { beanBatchId: "b", grinderId: "host-device", grinderModel: "DF64 Gen 1" }, profile: { title: "espresso", steps: [{ pump: "pressure", pressure: 9 }] } }) };
    return { ok: true, status: 200, json: async () => ({ items: [], total: 0 }) };
  }});
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  plugin = context.createPlugin(host);
  plugin.onLoad(settings);
  return { plugin, storage };
}

const profile = (id, dialA) => ({
  id,
  label: id,
  hostGrinderId: "host-device",
  model: "DF64 Gen 1",
  burrIdentity: "SSP HU",
  calibrationEpoch: "zero-1",
  pitchSource: "owner measured two-point dial calibration",
  ownerAnchors: { dialMin: 0, dialMax: 90, dialA, ddDumA: 300, dialB: 90, ddDumB: 1200 },
});

test("individual grinder profiles are bounded CRUD records and preserve separate calibrations", async () => {
  const { plugin, storage } = fixture();
  await new Promise((resolve) => setTimeout(resolve, 2));
  for (const item of [profile("df64-kitchen", 10), profile("df64-office", 20)]) {
    const saved = await plugin.handleHttpRequest({ endpoint: "grinders", method: "POST", body: { operation: "upsert", profile: item } });
    assert.equal(saved.status, 200, saved.body);
  }
  const listed = JSON.parse((await plugin.handleHttpRequest({ endpoint: "grinders", method: "GET" })).body);
  assert.deepEqual(listed.profiles.map((item) => item.id).sort(), ["df64-kitchen", "df64-office"]);
  assert.equal(listed.profiles.find((item) => item.id === "df64-kitchen").ownerAnchors.dialA, 10);
  assert.equal(storage.get("grinderProfiles.v1").schemaVersion, 1);
});

test("profiles reject unknown fields and calibration without a stable owner identity", async () => {
  const { plugin } = fixture();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const unknown = await plugin.handleHttpRequest({ endpoint: "grinders", method: "POST", body: { ...profile("df64", 10), dangerous: true } });
  assert.equal(unknown.status, 400);
  const missing = await plugin.handleHttpRequest({ endpoint: "grinders", method: "POST", body: { operation: "upsert", profile: { ...profile("", 10) } } });
  assert.equal(missing.status, 400);
});

test("a profile bound to another host grinder is withheld", async () => {
  const { plugin } = fixture();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const result = await plugin.handleHttpRequest({ endpoint: "grinders", method: "POST", body: { operation: "upsert", profile: { ...profile("wrong-host", 10), hostGrinderId: "another-host" } } });
  assert.equal(result.status, 200);
  const listed = JSON.parse((await plugin.handleHttpRequest({ endpoint: "grinders", method: "GET" })).body);
  assert.equal(listed.profiles[0].hostGrinderId, "another-host");
});

test("selected profile survives a plugin restart without changing host grinder identity", async () => {
  const first = fixture();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const saved = await first.plugin.handleHttpRequest({ endpoint: "grinders", method: "POST", body: { operation: "upsert", profile: profile("df64-kitchen", 10) } });
  assert.equal(saved.status, 200);
  const forbidden = await first.plugin.handleHttpRequest({ endpoint: "settings", method: "POST", body: { GrinderProfileId: "df64-kitchen", GrinderId: "must-not-change" } });
  assert.equal(forbidden.status, 400);
  const selected = await first.plugin.handleHttpRequest({ endpoint: "settings", method: "POST", body: { GrinderProfileId: "df64-kitchen" } });
  assert.equal(selected.status, 200);
  assert.equal(JSON.parse(selected.body).GrinderId, "host-device");
  assert.equal(first.storage.get("grinderProfiles.v1").selectedProfileId, "df64-kitchen");
  const second = fixture(first.storage.get("grinderProfiles.v1"));
  await new Promise((resolve) => setTimeout(resolve, 2));
  const settings = JSON.parse((await second.plugin.handleHttpRequest({ endpoint: "settings", method: "GET" })).body);
  assert.equal(settings.GrinderProfileId, "df64-kitchen");
  assert.equal(settings.GrinderId, "host-device");
});

test("selected profile is not acknowledged when plugin storage cannot write", async () => {
  const first = fixture();
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal((await first.plugin.handleHttpRequest({ endpoint: "grinders", method: "POST", body: { operation: "upsert", profile: profile("df64-kitchen", 10) } })).status, 200);
  const failing = fixture(first.storage.get("grinderProfiles.v1"), { GrinderId: "host-device", GrinderModel: "DF64 Gen 1" }, true);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const response = await failing.plugin.handleHttpRequest({ endpoint: "settings", method: "POST", body: { GrinderProfileId: "df64-kitchen" } });
  assert.equal(response.status, 503);
  assert.equal(JSON.parse((await failing.plugin.handleHttpRequest({ endpoint: "settings", method: "GET" })).body).GrinderProfileId, undefined);
});

test("a legacy calibration is withheld when the current host grinder has an identity", async () => {
  const { plugin } = fixture();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const response = await plugin.handleHttpRequest({ endpoint: "suggestion", method: "GET" });
  assert.equal(response.status, 200);
});

test("selected individual grinder is persisted and restored with the profile store", async () => {
  const first = fixture();
  await new Promise((resolve) => setTimeout(resolve, 2));
  await first.plugin.handleHttpRequest({ endpoint: "grinders", method: "POST", body: { operation: "upsert", profile: profile("df64-kitchen", 10) } });
  const selected = await first.plugin.handleHttpRequest({ endpoint: "settings", method: "POST", body: { GrinderProfileId: "df64-kitchen" } });
  assert.equal(selected.status, 200);
  const persisted = first.storage.get("grinderProfiles.v1");
  assert.equal(persisted.selectedProfileId, "df64-kitchen");
  const second = fixture(persisted);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const readback = JSON.parse((await second.plugin.handleHttpRequest({ endpoint: "settings", method: "GET" })).body);
  assert.equal(readback.GrinderProfileId, "df64-kitchen");
});

test("a feedback write ack never acknowledges a pending grinder profile write", async () => {
  // Decaid acknowledges a write with the written data only (no key).
  const writes = [];
  let plugin;
  const host = {
    storage(command) {
      if (command.type === "read")
        setTimeout(() => plugin.onEvent({ name: "storageRead", payload: { key: command.key, value: null } }), 0);
      else writes.push(command);
    },
    log() {},
  };
  const context = vm.createContext({ console, setTimeout, clearTimeout, Date, JSON, Math, Promise, fetch: async () => { throw new Error("offline"); } });
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  plugin = context.createPlugin(host);
  plugin.onLoad({});
  const ack = (key) => plugin.onEvent({ name: "storageWrite", payload: writes.find((command) => command.key === key).data });
  const settled = (promise) => { const state = { done: false }; promise.then((value) => { state.done = true; state.value = value; }); return state; };
  const feedback = settled(plugin.handleHttpRequest({ endpoint: "feedback", method: "POST", body: { shotId: "shot-1", good: true } }));
  const grinder = settled(plugin.handleHttpRequest({ endpoint: "grinders", method: "POST", body: { operation: "upsert", profile: profile("df64-kitchen", 10) } }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(writes.map((command) => command.key).sort(), ["feedback.v1", "grinderProfiles.v1"]);
  ack("feedback.v1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(feedback.done, true);
  assert.equal(feedback.value.status, 200);
  assert.equal(grinder.done, false, "grinder profile was acknowledged before its own write");
  ack("grinderProfiles.v1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(grinder.value.status, 200);
});

test("DELETE never creates or replaces a grinder profile", async () => {
  const { plugin } = fixture();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const created = await plugin.handleHttpRequest({ endpoint: "grinders", method: "DELETE", body: { profile: profile("df64-kitchen", 10) } });
  assert.equal(created.status, 400);
  assert.equal(JSON.parse((await plugin.handleHttpRequest({ endpoint: "grinders", method: "GET" })).body).profiles.length, 0);
  await plugin.handleHttpRequest({ endpoint: "grinders", method: "POST", body: { operation: "upsert", profile: profile("df64-kitchen", 10) } });
  const deleted = await plugin.handleHttpRequest({ endpoint: "grinders", method: "DELETE", body: { id: "df64-kitchen" } });
  assert.equal(deleted.status, 200, deleted.body);
  assert.equal(JSON.parse((await plugin.handleHttpRequest({ endpoint: "grinders", method: "GET" })).body).profiles.length, 0);
});

test("an unusable individual profile keeps its own calibration error when DialCalibration is also set", async () => {
  const stored = { schemaVersion: 1, profiles: { "wrong-host": { ...profile("wrong-host", 10), hostGrinderId: "another-host" } } };
  const { plugin } = fixture(stored, { GrinderId: "host-device", GrinderModel: "DF64 Gen 1", GrinderProfileId: "wrong-host",
    DialCalibration: JSON.stringify({ dialMin: 0, dialMax: 90, dialA: 0, ddDumA: 300, dialB: 90, ddDumB: 1200 }) });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const body = JSON.parse((await plugin.handleHttpRequest({ endpoint: "suggestion", method: "GET" })).body);
  assert.match(body.dialReference.calibrationError, /individual/);
  assert.doesNotMatch(body.dialReference.calibrationError, /DialCalibration/);
});

test("a grinder chosen on the plugin page survives reload until the host setting changes", async () => {
  const hostSettings = (id) => ({ GrinderId: "host-device", GrinderModel: "DF64 Gen 1", GrinderProfileId: id });
  const first = fixture(null, hostSettings("host-choice"));
  await new Promise((resolve) => setTimeout(resolve, 2));
  for (const id of ["host-choice", "page-choice", "newer-host"])
    assert.equal((await first.plugin.handleHttpRequest({ endpoint: "grinders", method: "POST", body: { operation: "upsert", profile: profile(id, 10) } })).status, 200);
  assert.equal((await first.plugin.handleHttpRequest({ endpoint: "settings", method: "POST", body: { GrinderProfileId: "page-choice" } })).status, 200);
  const stored = first.storage.get("grinderProfiles.v1");
  const selectedAfterReload = async (settings) => {
    const next = fixture(JSON.parse(JSON.stringify(stored)), settings);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return JSON.parse((await next.plugin.handleHttpRequest({ endpoint: "settings", method: "GET" })).body).GrinderProfileId;
  };
  assert.equal(await selectedAfterReload(hostSettings("host-choice")), "page-choice");
  assert.equal(await selectedAfterReload(hostSettings("newer-host")), "newer-host", "a later host setting change wins");
});
