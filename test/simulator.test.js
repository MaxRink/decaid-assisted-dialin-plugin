const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const createSimulationEngine = require("../simulator/engine.js");

const source = fs.readFileSync("plugin.js", "utf8");
const context = { Math, JSON, Number, Object, Set, console, Date, Promise, URL, setTimeout, clearTimeout, queueMicrotask };
vm.createContext(context);
vm.runInContext(`${source}\nthis.createResearchAlgorithms = createResearchAlgorithms;\nthis.createPlugin = createPlugin;`, context);
const engine = createSimulationEngine(context.createResearchAlgorithms());

const scenario = (overrides = {}) => ({
  version: 1,
  scope: { grinderId: "e64-1", beanBatchId: "beans-1", burrIdentity: "stock", calibrationEpoch: "cal-1", profile: "espresso" },
  initial: { settingDdDum: 1000 },
  targetBrewTimeMs: 28000,
  toleranceMs: 1000,
  bounds: { minDdDum: 0, maxDdDum: 3000 },
  shots: [
    { actualBrewTimeMs: 32000, beanType: "arabica", roastLevel: "light", taste: "balanced" },
    { actualBrewTimeMs: 24000, reset: true, beanType: "arabica", roastLevel: "light" },
  ],
  ...overrides,
});

test("runs all shipped GBS algorithms, keeps scope, and exposes ignored bean/taste inputs", () => {
  const result = engine.run(scenario());
  assert.deepEqual(result.algorithms.map((item) => item.algorithm), ["GbS1", "GbS2", "GbS3", "GbS4", "DdEff"]);
  for (const algorithm of result.algorithms) {
    assert.deepEqual(algorithm.scope, result.scenario.scope);
    assert.equal(algorithm.shots.length, 2);
    assert.deepEqual(algorithm.shots[0].ignoredInputs, ["beanType", "roastLevel", "taste"]);
    assert.equal(algorithm.shots[1].reset, true);
    for (const pass of algorithm.shots) assert.ok(pass.applied.returnedDdDum >= 0 && pass.applied.returnedDdDum <= 3000);
  }
});

test("preserves raw shipped output while recording physical bounds and scope resets", () => {
  const result = engine.run(scenario({
    bounds: { minDdDum: 900, maxDdDum: 1100 },
    shots: [
      { actualBrewTimeMs: 32000 },
      { actualBrewTimeMs: 32000, scope: { grinderId: "e64-1", beanBatchId: "beans-2", burrIdentity: "stock", calibrationEpoch: "cal-1", profile: "espresso" } },
    ],
  }));
  for (const item of result.algorithms) {
    assert.equal(item.shots[1].scopeChanged, true);
    assert.equal(item.shots[1].reset, true);
    const expected = context.createResearchAlgorithms().adjust("GbS1", context.createResearchAlgorithms().createState("GbS1", { lastResultDum: 1000, continuousUm: 100, previousQuantizedUm: 100 }), { actualBrewTimeMs: 32000, targetBrewTimeMs: 28000, toleranceMs: 1000, estimatedDdDum: 1000, setpointDdDum: 1000 });
    if (item.algorithm === "GbS1") assert.equal(JSON.stringify(item.shots[0].output), JSON.stringify(expected.result));
    assert.ok(item.shots[0].applied.returnedDdDum >= 900 && item.shots[0].applied.returnedDdDum <= 1100);
  }
});

test("compares scope fields by value and rejects malformed taste values", () => {
  const sameScopeDifferentOrder = { profile: "espresso", calibrationEpoch: "cal-1", burrIdentity: "stock", beanBatchId: "beans-1", grinderId: "e64-1" };
  const result = engine.run(scenario({ shots: [{ actualBrewTimeMs: 32000 }, { actualBrewTimeMs: 32000, scope: sameScopeDifferentOrder }] }));
  assert.equal(result.algorithms[0].shots[1].scopeChanged, false);
  assert.throws(() => engine.run(scenario({ shots: [{ actualBrewTimeMs: 32000, taste: "sweet" }] })), /unsupported/);
});

test("uses the injected research factory and does not carry state through an explicit reset", () => {
  let creates = 0;
  let adjusts = 0;
  const original = context.createResearchAlgorithms();
  const injected = {
    createState(...args) { creates++; return original.createState(...args); },
    adjust(...args) { adjusts++; return original.adjust(...args); },
  };
  const result = createSimulationEngine(injected).run(scenario({ shots: [{ actualBrewTimeMs: 32000 }, { actualBrewTimeMs: 32000, reset: true }] }));
  assert.equal(creates, 10);
  assert.equal(adjusts, 10);
  for (const item of result.algorithms) assert.deepEqual(item.shots[0].state, item.shots[1].state);
});

test("synthetic plant replay is deterministic and serializes validated scenarios", () => {
  const input = scenario({ seed: 42, shots: [{}, {}, {}], plant: { baseTimeMs: 28000, targetDdDum: 1100, slopeMsPerDdDum: 4, noiseMs: 10 } });
  const first = engine.run(input);
  const second = engine.run(engine.deserialize(engine.serialize(input)));
  assert.deepEqual(first, second);
  assert.equal(first.algorithms[0].shots[0].observation.source, "synthetic-plant");
});

test("rejects unknown fields, forged enums, non-finite data, and oversized scenarios", () => {
  assert.throws(() => engine.validateScenario({ ...scenario(), version: 2 }), /version/);
  assert.throws(() => engine.validateScenario({ ...scenario(), scope: { ...scenario().scope, extra: "x" } }), /unknown field/);
  assert.throws(() => engine.validateScenario({ ...scenario(), shots: [{ actualBrewTimeMs: "32000" }] }), /must be a signed/);
  assert.throws(() => engine.deserialize('{"version":1,"scope":{},"initial":{"settingDdDum":1000},"targetBrewTimeMs":28000,"toleranceMs":1000,"bounds":{"minDdDum":4,"maxDdDum":4},"shots":[]}'), /bounds/);
  assert.throws(() => engine.deserialize("x".repeat(300000)), /too large/);
});

test("replays rich bean-aware suggestions through the actual plugin factory", async () => {
  const result = await engine.replayRichSuggestions(context.createPlugin, scenario({
    scope: { grinderId: "e64-1", beanBatchId: "beans-abc", burrIdentity: "stock", calibrationEpoch: "cal-1", profile: "espresso" },
    shots: [
      { actualBrewTimeMs: 24000, taste: "sour", overall: "under-extracted" },
      { actualBrewTimeMs: 24000, taste: "sour", overall: "under-extracted" },
      { actualBrewTimeMs: 24000, taste: "sour", overall: "under-extracted" },
    ],
  }), { now: Date.now() });
  assert.equal(result.storageIsolated, true);
  assert.equal(result.suggestions.length, 3);
  assert.equal(result.suggestions[0].feedback.saved, true);
  assert.equal(result.suggestions[0].stage, "provisional");
  assert.equal(result.suggestions[0].evidenceCount, 1);
  assert.equal(result.suggestions[2].suggestion.status, "suggestion", JSON.stringify(result.suggestions));
  assert.equal(result.suggestions[2].stage, null);
  assert.equal(result.suggestions[2].evidenceCount, 3);
  assert.equal(result.suggestions[2].beanContext.beanBatchId, "beans-abc");
  assert.equal(result.suggestions[2].beanContext.beanId, "beans-abc:bean");
});

test("rich replay leaves taste blank when the game supplies no taste", async () => {
  const result = await engine.replayRichSuggestions(context.createPlugin, scenario({
    scope: { grinderId: "e64-1", beanBatchId: "arbitrary-batch", burrIdentity: "stock", calibrationEpoch: "cal-1", profile: "espresso" },
    shots: [{ actualBrewTimeMs: 28000, taste: "none" }],
  }), { now: Date.now() });
  assert.equal(result.suggestions[0].suggestion.status, "abstain");
  assert.match(result.suggestions[0].suggestion.reason, /Structured taste/);
  assert.equal(result.suggestions[0].beanContext.beanBatchId, "arbitrary-batch");
});

test("rich replay creates chronological synthetic plant observations", async () => {
  const result = await engine.replayRichSuggestions(context.createPlugin, scenario({
    plant: { baseTimeMs: 28000, targetDdDum: 1000, slopeMsPerDdDum: 2, noiseMs: 0 },
    shots: [{}, {}, {}],
  }), { now: Date.now() });
  assert.ok(result.shots[0].timestamp < result.shots[1].timestamp);
  assert.deepEqual(result.shots.map((shot) => shot.actualBrewTimeMs), [28000, 28000, 28000]);
  assert.equal(result.shots[0].workflow.context.beanBatchId, "beans-1");
});

 test("rich replay never converts sour or bitter descriptors into extraction assessments", async () => {
  for (const taste of ["sour", "bitter"]) {
    const result = await engine.replayRichSuggestions(context.createPlugin, scenario({ shots: [{ actualBrewTimeMs: 28000, taste }] }), { now: Date.now() });
    assert.equal(result.suggestions[0].feedback.flavour ?? null, null);
    const evidence = result.suggestions[0].suggestion.evidence || [];
    assert.ok(evidence.every(item => item.flavour == null || item.flavour.overall == null));
  }
 });

test("rich replay rejects a target-only shot instead of manufacturing an observed success", async () => {
  await assert.rejects(engine.replayRichSuggestions(context.createPlugin, scenario({shots: [{}]})), /target is not an observation/);
});
