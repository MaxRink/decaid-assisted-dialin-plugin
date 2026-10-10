const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("plugin.js", "utf8");
const profile = {
  title: "espresso",
  steps: [{ pump: "pressure", pressure: 9 }],
};

function context({ beanType, roastLevel, setting = "10" } = {}) {
  return {
    beanBatchId: "batch-a",
    grinderId: "grinder-1",
    grinderModel: "DF64",
    grinderSetting: setting,
    targetDoseWeight: 18,
    targetYield: 36,
    extras: {
      burrIdentity: "stock",
      calibrationEpoch: "cal-1",
      basket: "58mm",
      grinderSettingUnit: "marks",
      ...(beanType === undefined ? {} : { beanType }),
      ...(roastLevel === undefined ? {} : { roastLevel }),
    },
  };
}

function shot(id, { beanType, roastLevel, seconds = 22 } = {}) {
  // Keep even the longest test brew fully in the past so future-timestamp
  // fencing cannot mask the flavour-direction assertions.
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  const workflow = { context: context({ beanType, roastLevel }), profile };
  const full = {
    id,
    timestamp,
    workflow,
    measurements: [
      {
        machine: {
          timestamp: new Date(
            Date.parse(timestamp) + seconds * 1000,
          ).toISOString(),
          flow: 2,
          pressure: 9,
        },
        scale: { weight: 36 },
      },
    ],
    annotations: { actualDoseWeight: 18, actualYield: 36 },
  };
  return { id, timestamp, workflow, full };
}

function response(value, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => value };
}

async function load({
  shots = [],
  stored = null,
  currentContext = context(),
  settings = {},
  beanBatch = null,
} = {}) {
  let plugin;
  const events = [];
  const fullById = new Map(shots.map((entry) => [entry.id, entry.full]));
  const host = {
    log(message) {
      events.push(message);
    },
    storage(command) {
      if (command.type === "read")
        setTimeout(
          () =>
            plugin.onEvent({
              name: "storageRead",
              payload: { key: command.key, value: stored },
            }),
          0,
        );
      if (command.type === "write") {
        events.push({ stored: command.data });
        setTimeout(
          () => plugin.onEvent({ name: "storageWrite", payload: command.data }),
          0,
        );
      }
    },
  };
  const fetchStub = async (url) => {
    if (url.endsWith("/workflow"))
      return response({ context: currentContext, profile });
    if (url.includes("/shots?"))
      return response({
        items: shots.map(({ full, ...summary }) => summary),
        total: shots.length,
      });
    const match = url.match(/\/shots\/([^/?]+)$/);
    if (match)
      return fullById.has(decodeURIComponent(match[1]))
        ? response(fullById.get(decodeURIComponent(match[1])))
        : response({}, { ok: false, status: 404 });
    if (beanBatch && url.endsWith(`/bean-batches/${beanBatch.id}`))
      return response(beanBatch);
    return response({}, { ok: false, status: 404 });
  };
  const vmContext = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Math,
    Promise,
    URLSearchParams,
    fetch: fetchStub,
    btoa: (s) => Buffer.from(s).toString("base64"),
  };
  vm.createContext(vmContext);
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, vmContext);
  plugin = vmContext.createPlugin(host);
  plugin.onLoad({
    TargetTimeSec: 30,
    TimeToleranceSec: 1,
    EvidenceMaxAgeDays: 14,
    StepSize: 0.5,
    NumericFinerDelta: -1,
    MinSetting: 0,
    MaxSetting: 90,
    ...settings,
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  return { plugin, events };
}

async function feedback(plugin, id, extra = {}) {
  const { taste = "sour", ...rest } = extra;
  return plugin.handleHttpRequest({
    endpoint: "feedback",
    method: "POST",
    body: { shotId: id, good: true, taste, ...rest },
  });
}

test("accepts structured flavour feedback and preserves it through reload", async () => {
  const entry = shot("flavour-1");
  const first = await load({ shots: [entry] });
  const flavour = {
    descriptors: ["plum", "bright"],
    acidity: 4,
    sweetness: 3,
    body: 2,
    astringency: 1,
    overall: "under-extracted",
  };
  assert.equal(
    (await feedback(first.plugin, entry.id, { flavour })).status,
    200,
  );
  const stored = first.events
    .filter((event) => event && event.stored)
    .at(-1).stored;
  assert.deepEqual(
    JSON.parse(JSON.stringify(stored[entry.id].flavour)),
    flavour,
  );
  const second = await load({ shots: [entry], stored });
  const analysis = await second.plugin.handleHttpRequest({
    endpoint: "analysis",
    method: "POST",
    body: { shotId: entry.id },
  });
  assert.equal(analysis.status, 200);
  const body = JSON.parse(analysis.body);
  assert.deepEqual(body.feedback.flavour, flavour);
  assert.ok(body.analyzeMetrics || body.metrics);
});

test("rejects malformed flavour values, unknown keys and oversized descriptors", async () => {
  const entry = shot("invalid-flavour");
  const { plugin } = await load({ shots: [entry] });
  const invalid = [
    {},
    { descriptors: "sour" },
    { descriptors: ["x"], acidity: 6 },
    { descriptors: ["x"], bitterness: -1 },
    { descriptors: ["x"], unknown: 1 },
    { descriptors: Array.from({ length: 13 }, () => "x") },
    { descriptors: ["x".repeat(65)] },
    { descriptors: ["x"], overall: "maybe" },
  ];
  for (const flavour of invalid) {
    const result = await feedback(plugin, entry.id, { flavour });
    assert.equal(result.status, 400, JSON.stringify(flavour));
  }
});

test("invalid persisted flavour fails closed on reload", async () => {
  const entry = shot("corrupt-flavour");
  const stored = {
    [entry.id]: {
      good: true,
      taste: "sour",
      flavour: { descriptors: ["x"], unknown: true },
    },
  };
  const { plugin } = await load({ shots: [entry], stored });
  const result = await plugin.handleHttpRequest({
    endpoint: "analysis",
    method: "POST",
    body: { shotId: entry.id },
  });
  assert.equal(result.status, 503);
});

test("derives flavour guidance conservatively", async () => {
  const cases = [
    [{ overall: "under-extracted" }, "finer"],
    [{ overall: "over-extracted" }, "coarser"],
    [{ overall: "balanced" }, null],
    [{ overall: "uncertain" }, null],
    [{ bitterness: 4 }, "coarser"],
    [{ astringency: 5 }, "coarser"],
    [{ acidity: 5 }, null],
  ];
  for (const [flavour, expected] of cases) {
    const entries = [0, 1, 2].map((index) =>
      shot(`guidance-${JSON.stringify(flavour)}-${index}`, { seconds: 30 }),
    );
    const { plugin } = await load({ shots: entries });
    for (const entry of entries) {
      assert.equal(
        (await feedback(plugin, entry.id, { taste: null, flavour })).status,
        200,
      );
    }
    const result = await plugin.handleHttpRequest({
      endpoint: "suggestion",
      method: "GET",
    });
    const body = JSON.parse(result.body);
    if (expected) {
      assert.equal(result.status, 200, JSON.stringify(flavour));
      assert.equal(
        body.status,
        "suggestion",
        `${JSON.stringify(flavour)}: ${JSON.stringify(body)}`,
      );
      assert.equal(body.direction, expected, JSON.stringify(flavour));
    } else {
      assert.equal(body.status, "abstain", JSON.stringify(flavour));
    }
  }
});

test("known bean or roast mismatch excludes a shot; missing metadata is disclosed", async () => {
  const current = context({ beanType: "washed", roastLevel: "light" });
  const entries = [
    shot("known-mismatch", { beanType: "natural", roastLevel: "light" }),
    shot("legacy-missing"),
  ];
  const { plugin } = await load({ shots: entries, currentContext: current });
  await feedback(plugin, entries[0].id);
  await feedback(plugin, entries[1].id);
  const body = JSON.parse(
    (await plugin.handleHttpRequest({ endpoint: "suggestion", method: "GET" }))
      .body,
  );
  assert.equal(body.status, "abstain");
  assert.ok(
    body.excluded.some((entry) => entry.shotId === "known-mismatch"),
    JSON.stringify(body),
  );
  assert.ok(
    body.excluded.some(
      (entry) =>
        entry.shotId === "legacy-missing" &&
        /missing|metadata|bean|roast/i.test(entry.reason),
    ),
    JSON.stringify(body),
  );
});

test("both missing bean and roast metadata remains backward compatible with a warning", async () => {
  const entries = [shot("legacy-a"), shot("legacy-b"), shot("legacy-c")];
  const { plugin } = await load({ shots: entries });
  for (const entry of entries)
    await feedback(plugin, entry.id, {
      flavour: { overall: "under-extracted" },
    });
  const body = JSON.parse(
    (await plugin.handleHttpRequest({ endpoint: "suggestion", method: "GET" }))
      .body,
  );
  assert.equal(body.status, "suggestion");
  assert.ok(
    (body.warnings || []).some((warning) =>
      /bean|roast|metadata/i.test(warning),
    ),
  );
});

test("explicit historical bean and roast confirmation fills legacy metadata", async () => {
  const entries = [
    shot("confirmed-a"),
    shot("confirmed-b"),
    shot("confirmed-c"),
  ];
  const { plugin } = await load({
    shots: entries,
    currentContext: context({ beanType: "washed", roastLevel: "light" }),
  });
  for (const entry of entries) {
    const result = await feedback(plugin, entry.id, {
      confirmedContext: { beanType: "washed", roastLevel: "light" },
      flavour: { overall: "under-extracted" },
    });
    assert.equal(result.status, 200);
  }
  const body = JSON.parse(
    (await plugin.handleHttpRequest({ endpoint: "suggestion", method: "GET" }))
      .body,
  );
  assert.equal(body.status, "suggestion");
  assert.ok(
    body.evidence.every((item) =>
      item.confirmedHistoricalFields.includes("beanType"),
    ),
  );
});
