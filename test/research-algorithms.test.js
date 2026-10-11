const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("plugin.js", "utf8");
const context = { Math, JSON, Number, Object, Set, console };
vm.createContext(context);
vm.runInContext(
  `${source}\nthis.createResearchAlgorithms = createResearchAlgorithms;`,
  context,
);
const algorithms = context.createResearchAlgorithms();

const input = (overrides = {}) =>
  Object.assign(
    {
      actualBrewTimeMs: 30000,
      targetBrewTimeMs: 28000,
      estimatedDdDum: 1000,
      setpointDdDum: 1000,
      toleranceMs: 1000,
    },
    overrides,
  );

test("all nine decoded dial-in rows and numeric selection are available", () => {
  for (const model of ["e64", "e65", "e80"]) {
    for (const roast of ["light", "medium", "dark"]) {
      const result = algorithms.proposedDd({ weightMg: 18000, model, roast });
      assert.equal(result.model, model);
      assert.equal(result.roast, roast);
      assert.equal(typeof result.proposedDd, "number");
    }
  }
  assert.equal(
    algorithms.proposedDd({
      weightMg: 18000,
      modelEnum: 1,
      roastDegreeIndex: 2,
    }).proposedDd,
    83,
  );
  assert.throws(() =>
    algorithms.proposedDd({
      weightMg: 18000,
      modelEnum: 4,
      roastDegreeIndex: 0,
    }),
  );
});

test("every canonical grinder dial profile has a production helper profile", () => {
  const catalog = JSON.parse(fs.readFileSync("data/grinder-dials.json", "utf8"));
  for (const item of catalog.models) {
    const profile = algorithms.profileForGrinder(item.model);
    assert.ok(profile, item.model);
    assert.equal(profile.model, item.model);
  }
  assert.equal(algorithms.profileForGrinder("1Zpresso K series").model, "1Zpresso K series");
  assert.equal(algorithms.profileForGrinder("Fellow Ode Gen 2").model, "Fellow Ode Gen 2");
});

test("grinder dial normalization keeps E64 micrometres separate from dD", () => {
  const e64 = algorithms.normalizeGrinderSetting({ model: "E64 WS", value: 123 });
  assert.equal(e64.status, "normalized");
  assert.equal(e64.visible.unit, "micrometres");
  assert.equal(e64.algorithm.ddDum, 1230);
  assert.equal(algorithms.toGrinderDial({ model: "E64 WS", ddDum: 1230 }).visible.value, 123);
});

test("DF64 marks remain visible-only until two owner calibration anchors exist", () => {
  const raw = algorithms.normalizeGrinderSetting({ model: "DF64 Gen 2", value: 10 });
  assert.equal(raw.status, "calibration-required");
  assert.equal(raw.algorithm, null);
  const calibration = { model: "DF64", burrIdentity: "stock", calibrationEpoch: "cal-1", dialMin: 0, dialMax: 90, dialA: 0, ddDumA: 300, dialB: 90, ddDumB: 1200, finerDialDelta: 1 };
  const calibrated = algorithms.normalizeGrinderSetting({ model: "DF64", value: 45, burrIdentity: "stock", calibrationEpoch: "cal-1", calibration });
  assert.equal(calibrated.status, "normalized");
  assert.equal(calibrated.algorithm.ddDum, 750);
  assert.equal(algorithms.toGrinderDial({ model: "DF64", ddDum: 750, burrIdentity: "stock", calibrationEpoch: "cal-1", calibration }).visible.value, 45);
});

test("dial normalization validates ranges and refuses ambiguous anchors", () => {
  assert.equal(algorithms.normalizeGrinderSetting({ model: "DF64", value: 91 }).status, "calibration-required");
  assert.throws(() => algorithms.normalizeGrinderSetting({ model: "DF64", value: 10, burrIdentity: "stock", calibrationEpoch: "cal-1", calibration: { model: "DF64", burrIdentity: "stock", calibrationEpoch: "cal-1", dialMin: 0, dialMax: 90, dialA: 0, ddDumA: 1, dialB: 0, ddDumB: 2 } }), /distinct/);
  assert.throws(() => algorithms.normalizeGrinderSetting({ model: "DF64", value: 10, unit: "bananas" }), /unit does not match/);
  assert.equal(algorithms.normalizeGrinderSetting({ model: "unknown", value: 1 }).status, "unsupported");
});

test("calibration is scoped to burr and epoch and supports a reversed physical slope", () => {
  const calibration = { model: "DF64 Gen 1", burrIdentity: "SSP HU", calibrationEpoch: "2026-10-11", dialMin: 5, dialMax: 85, dialA: 20, ddDumA: 1200, dialB: 70, ddDumB: 300 };
  assert.equal(algorithms.normalizeGrinderSetting({ model: "DF64 Gen 1", value: 45, burrIdentity: "SSP HU", calibrationEpoch: "2026-10-11", calibration }).algorithm.ddDum, 750);
  assert.throws(() => algorithms.normalizeGrinderSetting({ model: "DF64 Gen 1", value: 45, burrIdentity: "stock", calibrationEpoch: "2026-10-11", calibration }), /burr identity/);
  assert.throws(() => algorithms.normalizeGrinderSetting({ model: "DF64 Gen 1", value: 45, burrIdentity: "SSP HU", calibrationEpoch: "new", calibration: { ...calibration, calibrationEpoch: "old" } }), /calibration epoch/);
  assert.throws(() => algorithms.normalizeGrinderSetting({ model: "DF64 Gen 1", value: 86, burrIdentity: "SSP HU", calibrationEpoch: "2026-10-11", calibration }), /owner calibration bounds/);
  assert.throws(() => algorithms.normalizeGrinderSetting({ model: "DF64 Gen 1", value: 10, burrIdentity: "SSP HU", calibrationEpoch: "2026-10-11", calibration }), /interpolation bounds/);
});

test("native and calibrated dD results stay within the algorithm integer range", () => {
  assert.throws(() => algorithms.normalizeGrinderSetting({ model: "E64 WS", value: 1e12 }), /integer range/);
  assert.throws(() => algorithms.toGrinderDial({ model: "E64 WS", ddDum: 1e12 }), /integer range/);
});

test("stepped inverse settings are marked unattainable instead of rounded", () => {
  const calibration = { model: "1Zpresso K series", burrIdentity: "stock", calibrationEpoch: "k-1", dialMin: 0, dialMax: 20, dialA: 0, ddDumA: 100, dialB: 10, ddDumB: 1100 };
  const result = algorithms.toGrinderDial({ model: "1Zpresso K series", ddDum: 150, burrIdentity: "stock", calibrationEpoch: "k-1", calibration });
  assert.equal(result.achievable, false);
  assert.equal(result.visible.value, 0.5);
});

test("V1 rolling median, correction and hysteretic output stay bounded", () => {
  let state = algorithms.createState("GbS1", {
    continuousUm: 10,
    previousQuantizedUm: 10,
  });
  for (const actual of [20000, 30000, 10000, 40000]) {
    const result = algorithms.adjust(
      "GbS1",
      state,
      input({ actualBrewTimeMs: actual }),
    );
    state = result.nextState;
  }
  assert.equal(state.history.length, 4);
  assert.equal(
    state.history
      .map((p) => p.value)
      .sort((a, b) => a - b)
      .join(","),
    "10,20,30,40",
  );
  assert.equal(
    algorithms.adjust(
      "GbS1",
      state,
      input({ actualBrewTimeMs: 30000, targetBrewTimeMs: 28000 }),
    ).result.committed,
    true,
  );
});

test("V2 inverse regression uses the recovered inverse orientation and six point cap", () => {
  assert.equal(algorithms.inverseRegression([{ x: 50, y: 30 }], 28), 51);
  let state = algorithms.createState("GbS2");
  for (let n = 0; n < 7; n += 1)
    state = algorithms.adjust(
      "GbS2",
      state,
      input({ setpointDdDum: 500 + n, actualBrewTimeMs: 30000 + n * 1000 }),
    ).nextState;
  assert.equal(state.history.length, 6);
});

test("V3 and V4 expose phase boundaries, cancellation and lock-in", () => {
  let state = algorithms.createState("GbS3", { holdCyclesRemaining: 0 });
  let result = algorithms.adjust(
    "GbS3",
    state,
    input({ actualBrewTimeMs: 33000 }),
  );
  assert.equal(result.result.phase, "mid");
  state = result.nextState;
  state.lastTargetDum = 1000;
  state.lastAdjustmentDum = 1100;
  result = algorithms.adjust("GbS3", state, input({ estimatedDdDum: 1601 }));
  assert.equal(result.result.phase, "cancel");
  state = algorithms.createState("GbS4", {
    holdCyclesRemaining: 0,
    history: [
      { x: 50, y: 20 },
      { x: 51, y: 21 },
      { x: 52, y: 22 },
    ],
    lastTargetDum: 1000,
    lastAdjustmentDum: 1100,
  });
  result = algorithms.adjust("GbS4", state, input({ actualBrewTimeMs: 25001 }));
  assert.equal(result.result.phase, "near");
  assert.equal(result.result.locked, true);
});

test("DdEff follows six-call initial, minus 200, plus 200 sequence", () => {
  let state = algorithms.createState("DdEff", { initialDdDum: 1000 });
  const values = [];
  for (let n = 0; n < 18; n += 1) {
    const result = algorithms.adjust("DdEff", state, input());
    values.push(result.result.returnedDdDum);
    state = result.nextState;
  }
  assert.deepEqual(
    values,
    [
      1000, 1000, 1000, 1000, 1000, 1000, 800, 800, 800, 800, 800, 800, 1200,
      1200, 1200, 1200, 1200, 1200,
    ],
  );
});

test("effective DD predictor and grind-time adjustment use explicit units", () => {
  let prediction = algorithms.effectiveDdPrediction(null, {
    grindDdDum: 500,
    grindDurationMs: 1000,
  });
  assert.equal(prediction.result, 500);
  prediction = algorithms.effectiveDdPrediction(prediction.nextState, {
    grindDdDum: 600,
    grindDurationMs: 1000,
    previousEffective: 50,
  });
  assert.ok(Number.isInteger(prediction.result));
  assert.equal(
    algorithms.adjustGrindTime({
      mode: 2,
      recipeDdUm: 50,
      targetDdDum: 500,
      recipeTimeMs: 1000,
    }).optional,
    false,
  );
  assert.equal(
    algorithms.adjustGrindTime({
      mode: 3,
      recipeDdUm: 50,
      targetDdDum: 500,
      recipeTimeMs: 1000,
    }).optional,
    true,
  );
});

test("manual DF guidance abstains on conflicting time and taste signals", () => {
  const result = algorithms.recommendManual({
    targetTimeSec: 30,
    actualTimeSec: 20,
    flavor: "too bitter",
    finerDirection: "clockwise",
  });
  assert.equal(result.direction, "none");
  assert.equal(result.requiresConfirmation, true);
});

test("manual taste guidance requires explicit intent and never interprets free-text negation", () => {
  const input = { profile: "df64_gen2", targetTimeSec: 30, actualTimeSec: 30,
    currentDial: 15, stepMarks: 1, numericFinerDelta: -1 };
  for (const flavor of ["pleasant acidity", "not bitter", "not sour", "sour", "bitter", "astringent", "sweet and acidic"]) {
    const result = algorithms.recommendManual({ ...input, flavor });
    assert.equal(result.direction, "none", flavor);
    assert.equal(result.proposedDial, null, flavor);
    assert.equal(result.confidence, "none");
  }
  for (const [flavor, direction, proposedDial] of [
    ["too sour", "finer", 14], ["too acidic", "finer", 14],
    ["too bitter", "coarser", 16], ["too astringent", "coarser", 16],
    ["under-extracted", "finer", 14], ["over-extracted", "coarser", 16],
  ]) {
    const result = algorithms.recommendManual({ ...input, flavor });
    assert.equal(result.direction, direction, flavor);
    assert.equal(result.proposedDial, proposedDial, flavor);
    assert.equal(result.confidence, "heuristic");
    assert.equal(result.legacyScore, 0.55);
    assert.match(result.legacyScoreProvenance, /not a probability/);
    assert.match(result.provenance, /not a measured extraction diagnosis/);
  }
});

test("manual timing stays tied to the supplied target and balanced taste retains the setting", () => {
  const input = { profile: "df64_gen2", actualTimeSec: 20, flavor: "not bitter" };
  assert.equal(algorithms.manual({ ...input, targetTimeSec: 30 }).direction, "finer");
  assert.equal(algorithms.manual({ ...input, targetTimeSec: 15 }).direction, "coarser");
  assert.equal(algorithms.manual({ ...input, targetTimeSec: 20 }).direction, "none");
  const balanced = algorithms.manual({ ...input, targetTimeSec: 30, flavor: "balanced" });
  assert.equal(balanced.direction, "none");
  assert.equal(balanced.legacyScore, 0);
  assert.match(balanced.reasons.join(" "), /retain the setting/);
});

test("invalid adjustment does not mutate caller state", () => {
  const state = algorithms.createState("GbS2");
  const before = JSON.stringify(state);
  assert.throws(() =>
    algorithms.adjust("GbS2", state, input({ actualBrewTimeMs: NaN })),
  );
  assert.equal(JSON.stringify(state), before);
});

test("state validation rejects non-finite, overlong and out-of-range state before cloning", () => {
  const invalid = algorithms.createState("GbS2");
  invalid.history = [{ x: NaN, y: 20 }];
  assert.throws(() => algorithms.adjust("GbS2", invalid, input()));
  const tooLong = algorithms.createState("GbS3");
  tooLong.history = Array.from({ length: 7 }, () => ({ x: 1, y: 1 }));
  assert.throws(() => algorithms.adjust("GbS3", tooLong, input()));
  const badFactor = algorithms.createState("GbS4");
  badFactor.nearFactor = 2;
  assert.throws(() => algorithms.adjust("GbS4", badFactor, input()));
});

test("V1 reports its deadband and DdEff remains a measurement result", () => {
  let state = algorithms.createState("GbS1", {
    continuousUm: 10,
    previousQuantizedUm: 10,
  });
  const within = algorithms.adjust(
    "GbS1",
    state,
    input({ actualBrewTimeMs: 28500 }),
  );
  assert.equal(within.result.phase, "within-error-window");
  const measurement = algorithms.adjust(
    "DdEff",
    algorithms.createState("DdEff", { initialDdDum: 1000 }),
    input(),
  );
  assert.equal(measurement.result.committed, false);
});

test("effective DD keeps residue and explicitly selected interpolation baseline separate", () => {
  const prediction = algorithms.effectiveDd(
    { residue: 50 },
    { grindDdDum: 600, grindDurationMs: 1000, effectiveBaseline: 50 },
  );
  // Independent recovered expression: b = 1-(1-exp(-ln(2)/1.85))/(ln(2)/1.85).
  const k = Math.log(2) / 1.85;
  const b = 1 - (1 - Math.exp(-k)) / k;
  assert.equal(prediction.result, Math.floor((50 + (60 - 50) * b) * 10 + 0.5));
  assert.ok(
    Math.abs(prediction.nextState.residue - (50 + 10 * (1 - Math.exp(-k)))) <
      1e-12,
  );
  assert.throws(() =>
    algorithms.effectiveDd(
      { residue: 50 },
      { grindDdDum: 600, grindDurationMs: 1000 },
    ),
  );
  assert.equal(
    algorithms.effectiveDd(
      { residue: 50 },
      { grindDdDum: 600, grindDurationMs: 0, effectiveBaseline: 50 },
    ).result,
    500,
  );
});


test("hand-grinder settings retain full rotations instead of wrapping the dial", () => {
  assert.equal(algorithms.clicksFromTurns({model: "1Zpresso X-Pro", turns: 2, clicks: 14}), 134);
  assert.equal(algorithms.clicksFromTurns({model: "1Zpresso J-Max", turns: 2, clicks: 14}), 194);
  assert.throws(() => algorithms.clicksFromTurns({model: "1Zpresso X-Pro", turns: 0, clicks: 60}), /whole counts/);
  assert.throws(() => algorithms.clicksFromTurns({model: "1Zpresso K series", turns: 1.5, clicks: 0}), /whole counts/);
  assert.throws(() => algorithms.clicksFromTurns({model: "DF64", turns: 1, clicks: 1}), /reviewed clicks/);
});

test("side-by-side comparison keeps each algorithm case isolated and labels missing cases", () => {
  const comparison = algorithms.compareAll({
    cases: {
      GbS1: {
        state: algorithms.createState("GbS1"),
        input: input({ actualBrewTimeMs: 30000 }),
      },
      manual: { actualTimeSec: 30, targetTimeSec: 30, profile: "df54" },
    },
  });
  assert.equal(comparison.schemaVersion, 1);
  assert.equal(comparison.results.length, 10);
  assert.equal(comparison.results.find((item) => item.algorithm === "GbS1").status, "computed");
  assert.equal(comparison.results.find((item) => item.algorithm === "GbS2").status, "unavailable");
  assert.match(comparison.provenance, /separate caller supplied cases/);
});


test("DdEff convenience replay enforces both call-count bounds", () => {
  for (const calls of [-2147483648, -1, 65])
    assert.throws(() => algorithms.ddEff(1000, calls), /between 0 and 64/);
  assert.equal(algorithms.ddEff(1000, 0).length, 0);
  assert.equal(algorithms.ddEff(1000, 64).length, 64);
  assert.deepEqual(Array.from(algorithms.ddEff(1000, 7)), [1000, 1000, 1000, 1000, 1000, 1000, 800]);
});


test("E64 manual advice uses only owner-supplied native micrometre steps", () => {
  const base = {profile: "e64ws", settingUnit: "micrometres", currentDial: 60,
    actualTimeSec: 20, targetTimeSec: 30, flavor: "too sour"};
  for (const missing of [{}, {stepNative: 2}, {numericFinerDelta: -1}]) {
    const result = algorithms.manual({...base, ...missing});
    assert.equal(result.direction, "finer");
    assert.equal(result.proposedDial, null);
    assert.equal(result.physicalTurn, null);
  }
  const result = algorithms.manual({...base, stepNative: 2, numericFinerDelta: -1});
  assert.equal(result.proposedDial, 58);
  assert.equal(result.settingUnit, "micrometres");
  assert.equal(result.suggestedStepNative, 2);
  assert.equal(result.physicalTurn, null);
  assert.equal(result.suggestedStepMarks, undefined);
  assert.match(result.nativeStepProvenance, /no particle-size, dD-response or physical rotation inference/);
  const coarser = algorithms.manual({...base, actualTimeSec: 40, flavor: "too bitter",
    stepNative: 2, numericFinerDelta: -1});
  assert.equal(coarser.proposedDial, 62);
  assert.equal(coarser.physicalTurn, null);
  assert.equal(algorithms.manual({...base, stepNative: 2, numericFinerDelta: 1}).proposedDial, 62);
});

test("E64 manual advice rejects mixed units and withholds contradictory or invalid movements", () => {
  const base = {profile: "e64ws", settingUnit: "micrometres", currentDial: 60,
    actualTimeSec: 20, targetTimeSec: 30, flavor: "too sour", stepNative: 2, numericFinerDelta: -1};
  for (const extra of [{settingUnit: undefined}, {settingUnit: "deci-micrometre"},
    {stepMarks: 1}, {finerDirection: "clockwise"}, {stepNative: 0}, {stepNative: -1},
    {stepNative: Infinity}, {currentDial: -1}, {numericFinerDelta: 0}])
    assert.throws(() => algorithms.manual({...base, ...extra}));
  for (const extra of [{flavor: "balanced"}, {flavor: "too bitter"},
    {currentDial: 1}, {currentDial: Number.MAX_VALUE, stepNative: Number.MAX_VALUE, numericFinerDelta: 1}]) {
    const result = algorithms.manual({...base, ...extra});
    assert.equal(result.proposedDial, null);
    assert.equal(result.physicalTurn, null);
  }
});
