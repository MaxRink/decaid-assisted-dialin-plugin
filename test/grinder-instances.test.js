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
        setTimeout(() => plugin.onEvent({ name: "storageWrite", payload: { key: command.key, value: command.data } }), 0);
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
