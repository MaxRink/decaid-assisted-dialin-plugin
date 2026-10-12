const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("plugin.js", "utf8");

function load() {
  const calls = { fetch: 0, writes: 0, reads: 0 };
  const host = {
    log() {},
    storage(command) {
      if (command.type === "read") {
        calls.reads += 1;
        queueMicrotask(() => plugin.onEvent({name: "storageRead", payload: {key: command.key, value: null}}));
      }
      if (command.type === "write") calls.writes += 1;
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
    fetch() {
      calls.fetch += 1;
      throw new Error("research endpoint must not fetch");
    },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  const plugin = context.createPlugin(host);
  plugin.onLoad({});
  return { plugin, calls };
}

const valid = (overrides = {}) =>
  Object.assign(
    {
      operation: "adjust",
      algorithm: "GbS2",
      firmwareBuild: "HEM-HSG-HMI-S01 V01.16-24",
      coordinateUnit: "deci-micrometre",
      scope: {
        grinderId: "e64",
        beanBatchId: "batch-a",
        burrIdentity: "burr-a",
        calibrationEpoch: "cal-a",
        profile: "profile-a",
      },
      input: {
        actualBrewTimeMs: 30000,
        targetBrewTimeMs: 28000,
        estimatedDdDum: 1000,
        setpointDdDum: 1000,
        toleranceMs: 1000,
      },
    },
    overrides,
  );

async function request(plugin, body) {
  const response = await plugin.handleHttpRequest({
    endpoint: "research",
    method: "POST",
    body,
  });
  return { response, body: JSON.parse(response.body) };
}

test("research comparison endpoint returns isolated algorithm rows", async () => {
  const h = load();
  const body = valid({
    operation: "compare",
    input: { cases: {} },
  });
  const result = await request(h.plugin, body);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.results.length, 10);
  assert.equal(result.body.results.every((item) => item.status === "unavailable"), true);
  assert.match(result.body.provenance, /separate caller supplied cases/);
});

test("adjust returns a reusable state envelope and accepts it on the next call", async () => {
  const h = load();
  const first = await request(h.plugin, valid());
  assert.equal(first.response.status, 200);
  assert.equal(first.body.stateEnvelope.version, 1);
  const second = await request(
    h.plugin,
    valid({ stateEnvelope: first.body.stateEnvelope }),
  );
  assert.equal(second.response.status, 200);
  assert.equal(second.body.result.algorithm, "GbS2");
});

test("state envelope scope, build, algorithm and unit mismatches are rejected", async () => {
  const h = load();
  const first = await request(h.plugin, valid());
  for (const change of [
    { scope: { ...valid().scope, beanBatchId: "other" } },
    { firmwareBuild: "other-build" },
    { algorithm: "GbS3" },
    { coordinateUnit: "micrometre" },
  ]) {
    const body = valid(change);
    body.stateEnvelope = first.body.stateEnvelope;
    const result = await request(h.plugin, body);
    assert.equal(result.response.status, 400);
    assert.equal(result.body.code, "invalid_research_input");
  }
});

test("research rejects unknown algorithms, malformed state and unsafe bounded calls", async () => {
  const h = load();
  for (const body of [
    valid({ algorithm: "unknown" }),
    valid({
      algorithm: "GbS2",
      stateEnvelope: {
        version: 1,
        algorithm: "GbS2",
        firmwareBuild: "HEM-HSG-HMI-S01 V01.16-24",
        coordinateUnit: "deci-micrometre",
        scope: valid().scope,
        state: {
          algorithm: "GbS2",
          history: [{ x: NaN, y: 1 }],
          lastResultDum: null,
        },
      },
    }),
    {
      operation: "ddEff",
      firmwareBuild: "HEM-HSG-HMI-S01 V01.16-24",
      coordinateUnit: "deci-micrometre",
      input: { initialDdDum: 1000, calls: 65 },
    },
    {
      operation: "adjust",
      algorithm: "GbS2",
      firmwareBuild: "HEM-HSG-HMI-S01 V01.16-24",
      coordinateUnit: "deci-micrometre",
      scope: valid().scope,
      input: { ...valid().input, actualBrewTimeMs: NaN },
    },
  ]) {
    const result = await request(h.plugin, body);
    assert.equal(result.response.status, 400);
    assert.equal(result.body.code, "invalid_research_input");
  }
});

test("research rejects non-finite computed results and oversized numeric inputs", async () => {
  const h = load();
  const cases = [
    {
      operation: "inverseRegression",
      firmwareBuild: "HEM-HSG-HMI-S01 V01.16-24",
      coordinateUnit: "deci-micrometre",
      input: {
        points: [
          { x: 1e308, y: 1e308 },
          { x: -1e308, y: -1e308 },
        ],
        targetSec: 0,
      },
    },
    {
      operation: "proposedDd",
      firmwareBuild: "HEM-HSG-HMI-S01 V01.16-24",
      coordinateUnit: "deci-micrometre",
      input: { weightMg: 1e308, model: "e80", roast: "dark" },
    },
    valid({
      algorithm: "GbS3",
      input: {
        actualBrewTimeMs: 2147483647,
        targetBrewTimeMs: 1,
        estimatedDdDum: 2147483647,
        setpointDdDum: 2147483647,
        toleranceMs: 0,
      },
    }),
  ];
  for (const body of cases) {
    const result = await request(h.plugin, body);
    assert.equal(result.response.status, 400);
    assert.equal(result.body.code, "invalid_research_input");
  }
});

test("research rejects invalid envelopes, malformed JSON, unknown operations and oversized bodies", async () => {
  const h = load();
  const first = await request(h.plugin, valid());
  const invalidVersion = valid({
    stateEnvelope: { ...first.body.stateEnvelope, version: 2 },
  });
  assert.equal((await request(h.plugin, invalidVersion)).response.status, 400);
  const malformed = await h.plugin.handleHttpRequest({
    endpoint: "research",
    method: "POST",
    body: '{"operation":',
  });
  assert.equal(malformed.status, 400);
  const unknown = await request(h.plugin, { operation: "future", input: {} });
  assert.equal(unknown.response.status, 400);
  const oversized = await h.plugin.handleHttpRequest({
    endpoint: "research",
    method: "POST",
    body: " ".repeat(32769),
  });
  assert.equal(oversized.status, 400);
});

test("non-finite state cannot be normalized away by JSON serialization", async () => {
  const h = load();
  const body = valid({
    stateEnvelope: {
      version: 1,
      algorithm: "GbS2",
      firmwareBuild: "HEM-HSG-HMI-S01 V01.16-24",
      coordinateUnit: "deci-micrometre",
      scope: valid().scope,
      state: {
        algorithm: "GbS2",
        history: [{ x: NaN, y: 30 }],
        lastResultDum: null,
      },
    },
  });
  const result = await request(h.plugin, body);
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, "invalid_research_input");
});

test("research operations are read-only and do not use network or storage writes", async t => {
  const h = load();
  t.after(() => h.plugin.onUnload());
  await new Promise(setImmediate); // Settle independent onLoad storage reads.
  const before = {...h.calls};
  const cases = [
    valid(),
    {
      operation: "inverseRegression",
      firmwareBuild: "HEM-HSG-HMI-S01 V01.16-24",
      coordinateUnit: "deci-micrometre",
      input: { points: [{ x: 50, y: 30 }], targetSec: 28 },
    },
    {
      operation: "proposedDd",
      firmwareBuild: "HEM-HSG-HMI-S01 V01.16-24",
      coordinateUnit: "deci-micrometre",
      input: { weightMg: 18000, model: "e64", roast: "medium" },
    },
    {
      operation: "ddEff",
      firmwareBuild: "HEM-HSG-HMI-S01 V01.16-24",
      coordinateUnit: "deci-micrometre",
      input: { initialDdDum: 1000, calls: 18 },
    },
    {
      operation: "effectiveDd",
      firmwareBuild: "HEM-HSG-HMI-S01 V01.16-24",
      coordinateUnit: "deci-micrometre",
      input: { state: null, grindDdDum: 500, grindDurationMs: 1000 },
    },
    {
      operation: "grindTime",
      firmwareBuild: "HEM-HSG-HMI-S01 V01.16-24",
      coordinateUnit: "deci-micrometre",
      input: { mode: 3, recipeDdUm: 50, targetDdDum: 500, recipeTimeMs: 1000 },
    },
  ];
  for (const body of cases)
    assert.equal((await request(h.plugin, body)).response.status, 200);
  assert.equal(before.fetch, 0);
  assert.equal(before.writes, 0);
  assert.deepEqual(h.calls, before);
});
