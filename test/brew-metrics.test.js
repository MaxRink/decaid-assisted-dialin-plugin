const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("plugin.js", "utf8");
function factory() {
  const context = { Math, JSON, Number, Object, Set, Date, console };
  vm.createContext(context);
  vm.runInContext(
    `${source}\nthis.createBrewMetrics = createBrewMetrics;`,
    context,
  );
  return context.createBrewMetrics();
}
function shot() {
  return {
    timestamp: "2026-10-11T10:00:00.000Z",
    workflow: { context: { targetDoseWeight: 18, targetYield: 36 } },
    annotations: {
      actualDoseWeight: 18.2,
      actualYield: 37,
      drinkTds: 9.1,
      drinkEy: 20.2,
      enjoyment: 4,
    },
    measurements: [
      {
        timestamp: "2026-10-11T10:00:00.000Z",
        machine: {
          timestamp: "2026-10-11T10:00:00.000Z",
          pressure: 0,
          targetPressure: 0,
          flow: 0,
          targetFlow: 0,
          mixTemperature: 90,
          targetMixTemperature: 90,
          groupTemperature: 92,
          targetGroupTemperature: 92,
          profileFrame: 1,
        },
        scale: { timestamp: "2026-10-11T10:00:00.500Z", weight: 0 },
      },
      {
        timestamp: "2026-10-11T10:00:01.000Z",
        machine: {
          timestamp: "2026-10-11T10:00:01.000Z",
          pressure: 10,
          targetPressure: 0,
          flow: 1,
          targetFlow: 2,
          mixTemperature: 91,
          targetMixTemperature: 90,
          groupTemperature: 93,
          targetGroupTemperature: 92,
          profileFrame: 1,
        },
        scale: { timestamp: "2026-10-11T10:00:02.500Z", weight: 2 },
      },
      {
        timestamp: "2026-10-11T10:00:11.000Z",
        machine: {
          timestamp: "2026-10-11T10:00:11.000Z",
          pressure: 0,
          targetPressure: 0,
          flow: 3,
          targetFlow: 2,
          mixTemperature: 92,
          targetMixTemperature: 90,
          groupTemperature: 94,
          targetGroupTemperature: 92,
          profileFrame: 2,
        },
        scale: { timestamp: "2026-10-11T10:00:10.500Z", weight: 36 },
      },
    ],
  };
}

test("analyze separates recipe targets from observed annotations", () => {
  const result = factory().analyze(shot(), { taste: "balanced" });
  assert.equal(result.recipeTargets.doseG, 18);
  assert.equal(result.recipeTargets.yieldG, 36);
  assert.equal(result.recipeTargets.ratio, 2);
  assert.equal(result.recipeTargets.available, true);
  assert.equal(result.annotations.actualDoseG, 18.2);
  assert.equal(result.annotations.actualYieldG, 37);
  assert.equal(result.annotations.actualDoseProvenance, "saved_annotation_origin_unverified");
  assert.equal(result.operatorFeedback.taste, "balanced");
  assert.equal(result.provenance.firmwareValidated, false);
});

test("machine metrics expose distributions, time-weighted target error and profile frames", () => {
  const result = factory().analyze(shot());
  assert.equal(result.elapsedSec, 11);
  assert.equal(result.machine.pressure.min, 0);
  assert.equal(result.machine.pressure.max, 10);
  assert.equal(result.machine.pressure.mean, 10 / 3);
  assert.ok(
    Math.abs(result.machine.pressure.timeWeightedMae - 100 / 11) < 1e-9,
  );
  assert.equal(result.machine.profileFrameSegments.length, 2);
  assert.equal(
    result.machine.trackingDiagnostics.calibratedThresholdsUsed,
    false,
  );
});

test("scale metrics use only scale timestamps and preserve positive measured final mass", () => {
  const result = factory().analyze(shot());
  assert.equal(result.scale.finalMeasuredWeightG, 36);
  assert.equal(result.scale.massGainG, 36);
  assert.equal(result.scale.brewFlowGPerSec, 3.6);
  assert.equal(result.scale.firstIncreaseElapsedSec, 2.5);
  assert.equal(result.scale.firstIncreaseSampleGapSec, 2);
  assert.equal(result.scale.reportedWeightFlowGPerSec.available, false);
  assert.equal(result.elapsedSec, 11);
});

test("missing and invalid samples are explicit and do not produce NaN", () => {
  const value = shot();
  value.volume = 250;
  value.measurements = [
    {
      machine: { timestamp: "2026-10-11T10:00:00Z", pressure: NaN },
      scale: { timestamp: "2026-10-11T10:00:00Z", weight: -1 },
    },
    {
      machine: { timestamp: "2026-10-11T10:00:01Z", pressure: NaN },
      scale: { timestamp: "2026-10-11T10:00:00.500Z", weight: 2, weightFlow: 1 },
    },
    {
      machine: { timestamp: "2026-10-11T10:00:02Z", pressure: NaN },
      scale: { timestamp: "2026-10-11T10:00:01Z", weight: -1, weightFlow: 2 },
    },
  ];
  const result = factory().analyze(value);
  assert.equal(result.scale.available, true);
  assert.equal(result.scale.finalMeasuredWeightG, null);
  assert.equal(result.scale.lastPositiveWeightG, 2);
  assert.equal(result.machine.pressure.available, false);
  assert.equal(result.scale.brewFlowGPerSec, 0);
  assert.equal(result.scale.massGainG, 0);
  assert.equal(JSON.stringify(result).includes("NaN"), false);
  assert.equal(result.scale.reportedWeightFlowGPerSec.mean, 1.5);
});

test("volume is reported separately and never converted into measured weight", () => {
  const value = shot();
  value.measurements.forEach((measurement) => {
    measurement.volume = 250;
    delete measurement.scale;
  });
  const result = factory().analyze(value);
  assert.equal(result.scale.available, false);
  assert.equal(result.volumeMl, 250);
  assert.equal(result.annotations.actualYieldG, 37);
});

test("elapsed metrics use shot origin, including pre-machine time, and frame offsets use that origin", () => {
  const value = shot();
  value.timestamp = "2026-10-11T10:00:00.000Z";
  value.measurements = [
    {machine: {timestamp: "2026-10-11T10:00:01.000Z", pressure: 1, profileFrame: 7}, scale: {timestamp: "2026-10-11T10:00:01.500Z", weight: 0}},
    {machine: {timestamp: "2026-10-11T10:00:02.000Z", pressure: 2, profileFrame: 7}, scale: {timestamp: "2026-10-11T10:00:02.000Z", weight: 2}},
    {machine: {timestamp: "2026-10-11T10:00:04.000Z", pressure: 3, profileFrame: 8}, scale: {timestamp: "2026-10-11T10:00:03.000Z", weight: 3}},
  ];
  const result = factory().analyze(value);
  assert.equal(result.elapsedSec, 4);
  assert.equal(result.scale.firstIncreaseElapsedSec, 2);
  assert.equal(result.machine.profileFrameSegments[0].startElapsedSec, 1);
});

test("overflow in derived metrics is rejected instead of emitting non-finite output", () => {
  const value = shot();
  value.measurements = [
    {machine: {timestamp: "2026-10-11T10:00:00.000Z", pressure: 1e308, targetPressure: 0}},
    {machine: {timestamp: "2050-10-11T10:00:00.000Z", pressure: -1e308, targetPressure: 0}},
  ];
  assert.throws(() => factory().analyze(value), /finite numeric bounds/);
});

test("sample bound and caller immutability are enforced", () => {
  const value = shot();
  value.measurements = Array.from({ length: 20001 }, (_, i) => ({
    machine: {
      timestamp: `2026-10-11T10:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`,
      pressure: 1,
    },
  }));
  const original = JSON.stringify(value);
  assert.throws(() => factory().analyze(value));
  assert.equal(JSON.stringify(value), original);
});
