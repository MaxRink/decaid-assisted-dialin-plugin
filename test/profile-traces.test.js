const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const context = vm.createContext({});
vm.runInContext(`${fs.readFileSync("plugin.js", "utf8")}\nthis.metrics = createBrewMetrics();`, context);
const analyze = value => JSON.parse(JSON.stringify(context.metrics.analyze(value)));
const origin = Date.parse("2026-10-11T10:00:00Z");
const timestamp = seconds => new Date(origin + seconds * 1000).toISOString();
// Controller fields from Decaid assets/defaultProfiles/D-Flow____default.json,
// normalized to numeric Profile.toJson values as stored in a brewed shot.
const dFlow = { title: "D-Flow / default", target_volume_count_start: 2, steps: [
  { name: "Filling", pump: "pressure", pressure: 3, seconds: 25, weight: 5, exit: { type: "pressure", condition: "over", value: 1.5 }, limiter: { value: 0, range: .2 } },
  { name: "Infusing", pump: "pressure", pressure: 3, seconds: 60, weight: 4, limiter: { value: 0, range: .2 } },
  { name: "Pouring", pump: "flow", flow: 1.7, seconds: 127, limiter: { value: 8.5, range: .2 } },
] };
const machine = (seconds, frame, substate, more = {}) => ({
  timestamp: timestamp(seconds), profileFrame: frame, flow: 1.7, targetFlow: 1.7,
  pressure: 3, targetPressure: 3, mixTemperature: 88, targetMixTemperature: 88,
  groupTemperature: 87, targetGroupTemperature: 88,
  ...(substate ? { state: { state: substate === "idle" ? "idle" : "espresso", substate } } : {}), ...more,
});
const shot = (measurements, profile = dFlow) => ({ timestamp: timestamp(0), workflow: { profile }, measurements });

test("real D-Flow frames delimit infusion at 2-8 seconds, not 25-85", () => {
  const measurements = Array.from({ length: 11 }, (_, i) => ({ machine: machine(i, i < 2 ? 0 : i < 8 ? 1 : 2), scale: { timestamp: timestamp(i), weight: i < 2 ? 0 : (i - 2) * .5 } }));
  const value = shot(measurements);
  value.phases = [{ name: "Infusing", startSec: 25, endSec: 85 }];
  const result = analyze(value);
  assert.deepEqual(result.trace.phases.map(p => [p.name, p.startSec, p.endSec]), [["Filling", 0, 2], ["Infusing", 2, 8], ["Pouring", 8, 10]]);
  assert.equal(result.trace.phases[1].pump, "pressure");
  assert.equal(result.trace.phases[2].pump, "flow");
  assert.equal(result.trace.phases[2].target, 1.7);
  assert.deepEqual(result.trace.phases[2].limiter, { value: 8.5, range: .2, unit: "bar" });
  assert.equal(result.trace.preinfusion.durationSec, 8);
  assert.equal(result.trace.preinfusion.source, "recorded_profile_frame");
  assert.equal(result.trace.controlMode, "mixed_dynamic_flow");
  assert.equal(result.trace.recommendation.status, "abstain");
  assert.equal(result.trace.preinfusion.extractionElapsedSec, null);
});

test("positive pressure-step flow limiter gates time advice regardless of profile title", () => {
  const profile = { title: "Arbitrary edited profile", steps: [{ name: "Extraction", pump: "pressure", pressure: 9, seconds: 60, limiter: { value: 2, range: .2 } }] };
  let result = analyze(shot([{ machine: machine(0, 0) }, { machine: machine(1, 0) }], profile));
  assert.equal(result.trace.controlMode, "mixed_dynamic_flow");
  assert.equal(result.trace.recommendation.status, "abstain");
  profile.steps[0].limiter.value = 0;
  profile.title = "D-Flow name on an unrelated edited recipe";
  assert.equal(analyze(shot([], profile)).trace.controlMode, "pressure");
});

test("unknown frames stay unmapped and gaps split repeated frame runs", () => {
  const result = analyze(shot([machine(0, 0), machine(1, 0), machine(9, 0), machine(10, 99), machine(11), machine(12, 2)].map(machine => ({ machine }))));
  assert.deepEqual(result.trace.phases.map(p => [p.startSec, p.endSec]), [[0, 1], [9, 10], [10, 10], [11, 12], [12, 12]]);
  assert.equal(result.trace.phases[2].mapping, "unknown");
  assert.equal(result.trace.phases[2].role, "unknown");
  assert.equal(result.trace.phases[3].mapping, "unknown");
  assert.equal(result.trace.preinfusion.durationSec, 2);
  assert.equal(result.machine.flow.timeWeightedCoverageSec, 4);
});

test("maximum profile durations without observed boundaries do not become phase times", () => {
  const result = analyze(shot([{ machine: machine(0) }, { machine: machine(10) }]));
  assert.deepEqual(result.trace.phases, []);
  assert.equal(result.trace.preinfusion.available, false);
});

test("beverage rates use scale timestamps independently of interleaved machine timestamps", () => {
  const result = analyze(shot([{ scale: { timestamp: timestamp(0), weight: 0 } }, { machine: machine(.5, 0) }, { scale: { timestamp: timestamp(2), weight: 6 } }, { machine: machine(3, 1) }, { scale: { timestamp: timestamp(4), weight: 10 } }]));
  const points = result.trace.points;
  assert.equal(points.find(p => p.tSec === 2).beverageFlowGPerSec, 3);
  assert.equal(points.find(p => p.tSec === 2).beverageFlowStartSec, 0);
  assert.equal(points.find(p => p.tSec === 4).beverageFlowGPerSec, 2);
  assert.equal(points.find(p => p.tSec === 3).beverageFlowGPerSec, undefined);
  assert.equal(points[0].beverageFlowGPerSec, null);
  assert.equal(result.trace.beverageFlow.integral, 10);
  assert.equal(result.trace.beverageFlow.mean, 2.5);
});

test("resets, negative weights, invalid weights and long gaps break beverage rates", () => {
  const readings = [[0, 0], [1, 2], [2, 0], [3, -1], [4, 2], [5, 4], [6, null], [7, 8], [20, 20], [21, 22]];
  const result = analyze(shot(readings.map(([t, weight]) => ({ scale: { timestamp: timestamp(t), weight } }))));
  assert.deepEqual(result.trace.points.map(p => p.beverageFlowGPerSec), [null, 2, null, null, null, 2, null, null, null, 2]);
  assert.equal(result.trace.beverageFlow.coverageSec, 3);
  assert.equal(result.trace.beverageFlow.integral, 6);
  assert.equal(result.scale.brewFlowGPerSec, 2);
  assert.equal(result.scale.brewFlowCoverageSec, 3);
});

test("target errors require valid endpoints and do not bridge gaps", () => {
  const result = analyze(shot([[0, 2], [1, null], [2, 2], [10, 2], [11, 2]].map(([t, flow]) => ({ machine: machine(t, 0, null, { flow, targetFlow: 1 }) }))));
  assert.equal(result.machine.flow.timeWeightedCoverageSec, 1);
  assert.equal(result.machine.flow.timeWeightedMae, 1);
  assert.equal(result.machine.flow.skippedGapCount, 1);
});

test("native pump and pouring clocks exclude preheat and post-pump settling", () => {
  function brew(preparation) {
    const data = Array.from({ length: preparation }, (_, i) => ({ machine: machine(i, 0, "preparingForShot") }));
    for (let t = preparation; t < preparation + 10; t++) data.push({ machine: machine(t, t < preparation + 2 ? 0 : 2, t < preparation + 2 ? "preinfusion" : "pouring") });
    data.push({ machine: machine(preparation + 10, 2, "pouringDone") }, { machine: machine(preparation + 13, 2, "idle") });
    return analyze(shot(data));
  }
  const a = brew(2), b = brew(7);
  assert.equal(a.timing.recording.durationSec, 15);
  assert.equal(b.timing.recording.durationSec - a.timing.recording.durationSec, 5);
  assert.equal(a.timing.pump.durationSec, 10);
  assert.equal(b.timing.pump.durationSec, 10);
  assert.equal(a.timing.pouring.durationSec, 8);
  assert.equal(b.timing.pouring.durationSec, 8);
  assert.equal(a.timing.preinfusion.durationSec, 2);
  assert.equal(a.timing.pump.complete, true);
  assert.equal(a.trace.phases[0].role, "outside_pump");
  assert.equal(a.trace.points[0].mixTemperatureC, 88);
  assert.equal(a.trace.points[0].groupTemperatureC, 87);
  assert.equal(a.trace.timeOrigin, "recording_start");
});

test("missing state, boundaries or coverage cannot claim a complete brew clock", () => {
  const noState = analyze(shot([{ machine: machine(0, 0) }, { machine: machine(1, 2) }]));
  assert.equal(noState.timing.pump.available, false);
  assert.equal(noState.timing.pump.durationSec, null);
  const noStart = analyze(shot([{ machine: machine(0, 0, "preinfusion") }, { machine: machine(1, 2, "pouring") }, { machine: machine(2, 2, "pouringDone") }]));
  assert.equal(noStart.timing.pump.durationSec, null);
  assert.equal(noStart.timing.pump.complete, false);
  assert.equal(noStart.timing.pouring.durationSec, 1);
  const gap = analyze(shot([{ machine: machine(0, 0, "preparingForShot") }, { machine: machine(1, 0, "preinfusion") }, { machine: machine(10, 2, "pouring") }, { machine: machine(11, 2, "pouringDone") }]));
  assert.equal(gap.timing.pump.complete, false);
  assert.equal(gap.timing.pump.durationSec, null);
});

test("discarded invalid or nonmonotonic machine timestamps invalidate native clock completeness", () => {
  const valid = [machine(0, 0, "preparingForShot"), machine(1, 0, "preinfusion"),
    machine(2, 2, "pouring"), machine(3, 2, "pouring"), machine(4, 2, "pouringDone")];
  const baseline = analyze(shot(valid.map(machine => ({ machine }))));
  assert.equal(baseline.timing.pump.complete, true);
  assert.equal(baseline.timing.pouring.complete, true);
  for (const badTimestamp of ["invalid timestamp", timestamp(1.5)]) {
    const badBoundary = { ...machine(2.5, 2, "idle"), timestamp: badTimestamp };
    const data = [...valid.slice(0, 3), badBoundary, ...valid.slice(3)];
    const result = analyze(shot(data.map(machine => ({ machine }))));
    assert.equal(result.timing.pump.available, true);
    assert.equal(result.timing.pump.complete, false);
    assert.equal(result.timing.pump.durationSec, null);
    assert.equal(result.timing.pouring.complete, false);
    assert.equal(result.timing.pouring.durationSec, null);
    assert.equal(result.trace.preinfusion.extractionElapsedSec, null);
    assert.equal(result.timing.pump.timestampIntegrity, "excluded_samples");
    assert.ok(result.timing.pump.coverageSec > 0);
    assert.ok(result.warnings.some(warning => /machine .*timestamp/.test(warning)));
  }
});
