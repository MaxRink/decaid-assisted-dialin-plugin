const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("plugin.js", "utf8");
const workflow = {
  profile: { name: "espresso", steps: [{ pump: "pressure", pressure: 9 }] },
  context: {
    beanBatchId: "batch-a",
    grinderId: "g-1",
    grinderModel: "DF64",
    grinderSetting: "10",
    targetDoseWeight: 18,
    targetYield: 36,
    extras: {
      burrIdentity: "stock",
      calibrationEpoch: "cal-1",
      basket: "58mm",
      grinderSettingUnit: "marks",
    },
  },
};
const shot = {
  id: "shot-a",
  timestamp: "2026-10-10T10:00:00.000Z",
  workflow,
  measurements: [
    {
      machine: {
        timestamp: "2026-10-10T10:00:05.000Z",
        flow: 1.2,
        pressure: 8.5,
      },
      scale: { timestamp: "2026-10-10T10:00:05.000Z", weight: 2 },
    },
    {
      machine: { timestamp: "2026-10-10T10:00:30.000Z", flow: 2, pressure: 9 },
      scale: { timestamp: "2026-10-10T10:00:30.000Z", weight: 36 },
    },
  ],
  annotations: { actualDoseWeight: 18, actualYield: 36 },
};
const jsonResponse = (value, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function load({ fetchImpl, stored = {} } = {}) {
  let plugin;
  const calls = [];
  const host = {
    log() {},
    storage(command) {
      calls.push(command);
      if (command.type === "read")
        setTimeout(
          () =>
            plugin.onEvent({
              name: "storageRead",
              payload: { key: command.key, value: stored },
            }),
          0,
        );
      if (command.type === "write")
        setTimeout(
          () => plugin.onEvent({ name: "storageWrite", payload: command.data }),
          0,
        );
    },
  };
  const context = {
    console,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Set,
    Promise,
    URL,
    URLSearchParams,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  plugin = context.createPlugin(host);
  plugin.onLoad({});
  return { plugin, calls };
}

function apiFetch({
  currentWorkflow = workflow,
  full = shot,
  batch,
  bean,
  failures = {},
} = {}) {
  return async (url) => {
    if (url.endsWith("/api/v1/workflow"))
      return failures.workflow || jsonResponse(currentWorkflow);
    if (url.endsWith("/api/v1/shots/shot-a"))
      return failures.shot || jsonResponse(full);
    if (url.endsWith("/api/v1/bean-batches/batch-a"))
      return (
        failures.batch ||
        jsonResponse(
          batch || { id: "batch-a", beanId: "bean-a", roastLevel: "light" },
        )
      );
    if (url.endsWith("/api/v1/beans/bean-a"))
      return (
        failures.bean ||
        jsonResponse(
          bean || {
            id: "bean-a",
            name: "Test",
            roaster: "Roaster",
            variety: "Bourbon",
            processing: "washed",
            decaf: false,
          },
        )
      );
    throw new Error(`unexpected fetch ${url}`);
  };
}

async function request(plugin, endpoint, method, body) {
  const response = await plugin.handleHttpRequest({ endpoint, method, body });
  return { response, body: response.body ? JSON.parse(response.body) : null };
}

test("analysis returns metrics, historical context and persisted feedback from the full shot route", async () => {
  const h = load({ fetchImpl: apiFetch() });
  const saved = await request(h.plugin, "feedback", "POST", {
    shotId: "shot-a",
    good: true,
    taste: "sour",
  });
  assert.equal(saved.response.status, 200);
  const result = await request(h.plugin, "analysis", "POST", {
    shotId: "shot-a",
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.shotId, "shot-a");
  assert.equal(result.body.feedback.taste, "sour");
  assert.equal(result.body.context.beanBatchId, "batch-a");
  assert.equal(result.body.metrics.elapsedSec, 30);
  assert.equal(result.body.metrics.machine.sampleCount, 2);
  assert.equal(result.body.metrics.scale.finalMeasuredWeightG, 36);
});

test("analysis validates input and fails safely for upstream 404 or malformed full shots", async () => {
  const h = load({
    fetchImpl: apiFetch({ failures: { shot: jsonResponse({}, 404) } }),
  });
  for (const body of [null, {}, { shotId: "" }, { shotId: "x".repeat(257) }]) {
    const result = await request(h.plugin, "analysis", "POST", body);
    assert.equal(result.response.status, 400);
  }
  const failed = await request(h.plugin, "analysis", "POST", {
    shotId: "shot-a",
  });
  assert.equal(failed.response.status, 503);
  assert.equal(failed.body.code, "request_failed");
  const malformed = load({
    fetchImpl: apiFetch({ failures: { shot: jsonResponse({ id: "shot-a" }) } }),
  });
  const invalid = await request(malformed.plugin, "analysis", "POST", {
    shotId: "shot-a",
  });
  assert.equal(invalid.response.status, 503);
  assert.equal(invalid.body.code, "request_failed");
});

test("analysis fences late shot fetches after shotUpdated and unload", async () => {
  const shotFetch = deferred();
  const h = load({
    fetchImpl: apiFetch({ failures: { shot: shotFetch.promise } }),
  });
  const pending = request(h.plugin, "analysis", "POST", { shotId: "shot-a" });
  await new Promise((resolve) => setTimeout(resolve, 1));
  h.plugin.onEvent({ name: "shotUpdated" });
  shotFetch.resolve(jsonResponse(shot));
  assert.equal((await pending).response.status, 503);

  const unloadFetch = deferred();
  const u = load({
    fetchImpl: apiFetch({ failures: { shot: unloadFetch.promise } }),
  });
  const late = request(u.plugin, "analysis", "POST", { shotId: "shot-a" });
  await new Promise((resolve) => setTimeout(resolve, 1));
  u.plugin.onUnload();
  unloadFetch.resolve(jsonResponse(shot));
  assert.equal((await late).response.status, 503);
});

test("bean-context reports current catalog properties with explicit provenance", async () => {
  const h = load({
    fetchImpl: apiFetch({
      bean: {
        id: "bean-a",
        name: "Ethiopia",
        roaster: "R",
        variety: "Heirloom",
        processing: "natural",
        decaf: true,
      },
      batch: { id: "batch-a", beanId: "bean-a", roastLevel: "medium" },
    }),
  });
  const result = await request(h.plugin, "bean-context", "GET");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.status, "available");
  assert.equal(result.body.bean.variety, "Heirloom");
  assert.equal(result.body.bean.processing, "natural");
  assert.equal(result.body.bean.decaf, true);
  assert.equal(result.body.batch.roastLevel, "medium");
  assert.match(
    result.body.provenance,
    /current.*catalog|historical.*not|not.*historical/i,
  );
  assert.equal(result.body.requiresHistoricalConfirmation, true);
});

test("bean-context is unavailable without a batch and fails safely for wrong IDs or API errors", async () => {
  const absent = load({
    fetchImpl: apiFetch({
      currentWorkflow: {
        ...workflow,
        context: { ...workflow.context, beanBatchId: null },
      },
    }),
  });
  const missing = await request(absent.plugin, "bean-context", "GET");
  assert.equal(missing.response.status, 200);
  assert.equal(missing.body.status, "unavailable");
  const wrongBatch = load({
    fetchImpl: apiFetch({
      failures: { batch: jsonResponse({ id: "other", beanId: "bean-a" }) },
    }),
  });
  assert.equal(
    (await request(wrongBatch.plugin, "bean-context", "GET")).response.status,
    503,
  );
  const wrongBean = load({
    fetchImpl: apiFetch({ failures: { bean: jsonResponse({ id: "other" }) } }),
  });
  assert.equal(
    (await request(wrongBean.plugin, "bean-context", "GET")).response.status,
    503,
  );
  const apiError = load({
    fetchImpl: apiFetch({ failures: { batch: jsonResponse({}, 500) } }),
  });
  const failed = await request(apiError.plugin, "bean-context", "GET");
  assert.equal(failed.response.status, 503);
  assert.equal(failed.body.code, "request_failed");
});

test("bean-context fences a late workflow fetch after workflowUpdated", async () => {
  const workflowFetch = deferred();
  const h = load({
    fetchImpl: apiFetch({ failures: { workflow: workflowFetch.promise } }),
  });
  const pending = request(h.plugin, "bean-context", "GET");
  await new Promise((resolve) => setTimeout(resolve, 1));
  h.plugin.onEvent({ name: "workflowUpdated" });
  workflowFetch.resolve(jsonResponse(workflow));
  assert.equal((await pending).response.status, 503);
});
