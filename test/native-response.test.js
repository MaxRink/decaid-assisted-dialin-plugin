const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const sandbox = vm.createContext({});
vm.runInContext(fs.readFileSync("plugin.js", "utf8") + "\nthis.algorithms = createResearchAlgorithms();", sandbox);
const recommend = input => JSON.parse(JSON.stringify(sandbox.algorithms.recommendNativeResponse(input)));
const scope = { beanId: "batch-a", grinderId: "df64-owner-1", burrIdentity: "stock-burrs",
  calibrationEpoch: "zero-1", settingUnit: "marks", doseG: 18, yieldG: 36,
  profile: "saved-pressure-recipe-v1", clock: "pump", controlMode: "pressure" };
const shots = pairs => pairs.map(([setting, timeSec], index) => ({ id: "shot-" + index,
  setting, timeSec, scope: { ...scope }, clockConfirmed: true, recipeConfirmed: true }));
const request = (pairs = [[22, 36], [22.25, 34], [22.5, 32]], extra = {}) => ({
  scope: { ...scope }, shots: shots(pairs), currentSetting: pairs.at(-1)?.[0] ?? 22,
  targetTimeSec: 28, toleranceSec: .5, stepNative: .25, numericFinerDelta: -1,
  bounds: { min: 0, max: 90 }, clockConfirmed: true, recipeConfirmed: true,
  stepConfirmed: true, taste: "too bitter", ...extra,
});
const noMovement = result => {
  assert.equal(result.proposedSetting, null);
  assert.equal(result.suggestedTrial, null);
};

test("learns a bounded native-mark response without pitch, zero offset or dD", () => {
  const input = request(), before = JSON.stringify(input), result = recommend(input);
  assert.equal(result.status, "suggestion");
  assert.equal(result.direction, "coarser");
  assert.equal(result.settingUnit, "marks");
  assert.equal(result.fit.slopeSecPerNativeUnit, -8);
  assert.equal(result.fit.rawTargetSetting, 23);
  assert.equal(result.proposedSetting, 22.75);
  assert.equal(result.fit.stepLimited, true);
  assert.equal(result.fit.extrapolated, true);
  assert.equal(result.fit.validated, false);
  assert.equal(result.fit.repeatabilityMeasured, false);
  assert.match(result.policy.interpretation, /not validated scientific thresholds/);
  assert.match(result.provenance, /no physical pitch/);
  assert.equal(JSON.stringify(input), before);
});

test("native fit is invariant to a coordinate offset and a changed scale or numeric sign", () => {
  const original = request(), expected = recommend(original);
  for (const [scale, offset] of [[10, 500], [-4, 100]]) {
    const transform = value => value * scale + offset;
    const converted = structuredClone(original);
    converted.scope.settingUnit = "owner native divisions";
    converted.currentSetting = transform(original.currentSetting);
    converted.stepNative *= Math.abs(scale);
    converted.numericFinerDelta *= Math.sign(scale);
    converted.bounds = { min: Math.min(transform(0), transform(90)), max: Math.max(transform(0), transform(90)) };
    converted.shots.forEach(shot => { shot.setting = transform(shot.setting); shot.scope = { ...converted.scope }; });
    const result = recommend(converted);
    assert.equal(result.status, "suggestion");
    assert.equal(result.proposedSetting, transform(expected.proposedSetting));
    assert.equal(result.fit.rawTargetSetting, transform(expected.fit.rawTargetSetting));
    assert.equal(result.fit.slopeSecPerNativeUnit, expected.fit.slopeSecPerNativeUnit / scale);
  }
});

test("first and second settings offer only a separately labelled owner-step experiment", () => {
  for (const [pairs, reason] of [
    [[[22, 34]], "first_setting"],
    [[[22, 34], [22.25, 31]], "two_settings_provisional"],
  ]) {
    const input = request(pairs), result = recommend(input);
    assert.equal(result.status, "collecting");
    assert.equal(result.reasonCode, reason);
    assert.equal(result.proposedSetting, null);
    assert.equal(result.fit.rawTargetSetting, null);
    assert.equal(result.suggestedTrial.setting, input.currentSetting + .25);
    assert.equal(result.suggestedTrial.learned, false);
  }
  const repeated = recommend(request([[22, 34], [22, 34], [22, 34]]));
  assert.equal(repeated.reasonCode, "first_setting");
  assert.equal(repeated.fit.distinctSettings, 1);
});

test("34,31,31 seconds at 22,22.25,22.5 marks asks for a repeat rather than extrapolating", () => {
  const result = recommend(request([[22, 34], [22.25, 31], [22.5, 31]], { toleranceSec: 1 }));
  assert.equal(result.status, "hold");
  assert.equal(result.reasonCode, "latest_plateau");
  assert.equal(result.fit.slopeSecPerNativeUnit, -6);
  assert.equal(result.fit.latestDistinctTimeChangeSec, 0);
  assert.equal(result.fit.rawTargetSetting, null);
  assert.match(result.reason, /Repeat the current setting/);
  noMovement(result);
});

test("wrong sign, a recent reversal, curvature and repeat variation never acquire fallback slopes", () => {
  for (const [pairs, reason] of [
    [[[22, 30], [22.25, 32], [22.5, 34]], "wrong_or_flat_slope"],
    [[[22, 36], [22.25, 30], [22.5, 32]], "latest_reversal"],
    [[[22, 50], [22.25, 34], [22.5, 32]], "unstable_fit"],
    [[[22, 36], [22.25, 34], [22.5, 32], [22.5, 35]], "repeat_variation"],
  ]) {
    const result = recommend(request(pairs));
    assert.equal(result.status, "hold");
    assert.equal(result.reasonCode, reason);
    noMovement(result);
  }
});

test("uses setting medians while explicitly retaining measured repeat spread", () => {
  const result = recommend(request([[22, 36], [22, 36.2], [22.25, 34], [22.5, 32], [22.5, 32.2]]));
  assert.equal(result.status, "suggestion");
  assert.equal(result.fit.repeatabilityMeasured, true);
  assert.equal(result.fit.points[0].timeSec, 36.1);
  assert.ok(Math.abs(result.fit.maxRepeatRangeSec - .2) < 1e-10);
});

test("a changed scope is a continuity break, even when older and newest shots match again", () => {
  for (const key of sandbox.algorithms.nativeResponseContract.scopeFields) {
    const input = request();
    input.shots[1].scope[key] = typeof scope[key] === "number" ? scope[key] + 1 : "different";
    const result = recommend(input);
    assert.equal(result.status, "collecting", key);
    assert.deepEqual(result.sourceShotIds, ["shot-2"], key);
    assert.equal(result.fit.distinctSettings, 1, key);
    assert.equal(result.excluded[0].reason, "scope_changed", key);
    assert.equal(result.excluded[0].olderHistoryWithheld, 1, key);
  }
});

test("unconfirmed timing, preparation concerns, malformed samples and repeated IDs break continuity", () => {
  for (const change of [{ clockConfirmed: false }, { recipeConfirmed: false },
    { prepConcern: true }, { taste: "weak" }, { taste: "channeling" },
    { timeSec: 0 }, { timeSec: "34" }, { id: "shot-2" }]) {
    const input = request(); Object.assign(input.shots[1], change);
    const result = recommend(input);
    assert.deepEqual(result.sourceShotIds, ["shot-2"]);
    assert.equal(result.fit.distinctSettings, 1);
    assert.equal(result.proposedSetting, null);
  }
  const currentBad = request(); currentBad.shots.at(-1).clockConfirmed = false;
  noMovement(recommend(currentBad));
});

test("unsupported controllers and missing scope or confirmations cannot become native advice", () => {
  for (const controlMode of ["flow", "mixed_dynamic_flow", "flow_preinfusion_only", "unknown"])
    noMovement(recommend(request(undefined, { scope: { ...scope, controlMode } })));
  for (const key of sandbox.algorithms.nativeResponseContract.scopeFields) {
    const input = request(); delete input.scope[key];
    assert.equal(recommend(input).reasonCode, "incomplete_scope");
  }
  for (const key of ["clockConfirmed", "recipeConfirmed", "stepConfirmed"]) {
    const input = request(); delete input[key];
    assert.equal(recommend(input).reasonCode, "confirmation_required");
  }
  for (const extra of [{ targetTimeSec: undefined }, { toleranceSec: undefined },
    { stepNative: undefined }, { numericFinerDelta: undefined }, { bounds: undefined }])
    noMovement(recommend(request(undefined, extra)));
});

test("balanced, conflicting, absent or descriptive taste cannot be overridden by a fit", () => {
  for (const [taste, reason] of [["balanced", "balanced"], ["too sour", "taste_time_conflict"],
    ["", "taste_required"], ["not bitter", "taste_required"], ["pleasant acidity", "taste_required"],
    ["weak", "preparation_or_weakness_concern"], ["channeling", "preparation_or_weakness_concern"]]) {
    const result = recommend(request(undefined, { taste }));
    assert.equal(result.reasonCode, reason); noMovement(result);
  }
  const onTarget = recommend(request(undefined, { targetTimeSec: 32 }));
  assert.equal(onTarget.reasonCode, "target_window"); noMovement(onTarget);
});

test("only the observed current setting and confirmed operating range may receive a proposal", () => {
  const changed = recommend(request(undefined, { currentSetting: 22.6 }));
  assert.equal(changed.reasonCode, "current_setting_unobserved"); noMovement(changed);
  const bounded = recommend(request(undefined, { bounds: { min: 0, max: 22.6 } }));
  assert.equal(bounded.reasonCode, "operating_bounds"); noMovement(bounded);
  const firstBounded = recommend(request([[22.5, 34]], { bounds: { min: 0, max: 22.6 } }));
  noMovement(firstBounded);
});

test("local fitting excludes older distant settings without rejoining earlier history", () => {
  const result = recommend(request([[20, 80], [22, 36], [22.25, 34], [22.5, 32]]));
  assert.equal(result.status, "suggestion");
  assert.deepEqual(result.sourceShotIds, ["shot-1", "shot-2", "shot-3"]);
  assert.equal(result.excluded[0].reason, "outside_local_window");
  assert.equal(result.fit.slopeSecPerNativeUnit, -8);
});

test("all timing clocks require exact shot-to-current agreement", () => {
  for (const clock of ["pump", "pouring", "recording"]) {
    const input = request(); input.scope.clock = clock;
    input.shots.forEach(shot => { shot.scope.clock = clock; });
    assert.equal(recommend(input).status, "suggestion");
    input.shots.at(-1).scope.clock = clock === "pump" ? "pouring" : "pump";
    noMovement(recommend(input));
  }
});

test("the separate native learner does not change the ten recovered and manual comparison cases", () => {
  assert.equal(sandbox.algorithms.compareAll({ cases: {} }).results.length, 10);
  assert.ok(Object.isFrozen(sandbox.algorithms.nativeResponseContract.policy));
  assert.ok(Object.isFrozen(sandbox.algorithms.nativeResponseContract.scopeFields));
});

test("missing and non-finite setup or oversized histories never yield a movement", () => {
  noMovement(recommend({}));
  for (const extra of [{ currentSetting: Infinity }, { targetTimeSec: NaN },
    { toleranceSec: -1 }, { stepNative: 0 }, { stepNative: Number.MAX_VALUE },
    { bounds: { min: 22.5, max: 22.5 } }, { numericFinerDelta: 0 },
    { shots: new Array(101).fill(null) }]) noMovement(recommend(request(undefined, extra)));
  const input = request([[1e200, 36], [1e200 + 1e190, 34], [1e200 + 2e190, 32]],
    { stepNative: 1e190, bounds: { min: 0, max: 1e201 } });
  const raw = sandbox.algorithms.recommendNativeResponse(input);
  const checkFinite = value => {
    if (typeof value === "number") assert.ok(Number.isFinite(value));
    else if (value && typeof value === "object") Object.values(value).forEach(checkFinite);
  };
  checkFinite(raw);
  noMovement(JSON.parse(JSON.stringify(raw)));
});
