"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("../data/grinder-mechanics.json");
const { createGrinderMechanics } = require("../src/grinder-mechanics");
const mechanics = createGrinderMechanics(catalog);
const close = (a, b) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const relative = extra => mechanics.toRelativeCoordinate({ model: "DF64 Gen 1", nativeValue: 22.25,
  baselineNativeValue: 22, signedAxialUmPerNative: 10.4, umPerResearchUnit: .1, acceptScenario: true, ...extra });
const proposal = extra => mechanics.proposeNative({ currentNativeValue: 22, requestedResearchDelta: 26,
  signedAxialUmPerNative: 10.4, umPerResearchUnit: .1, ownerStep: .5, minNative: 0, maxNative: 90,
  acceptScenario: true, ...extra });
const finiteOutputs = value => {
  if (typeof value === "number") assert.ok(Number.isFinite(value));
  else if (value && typeof value === "object") Object.values(value).forEach(finiteOutputs);
};

test("canonical catalog resolves all actual grinder names without conflating K Ultra", () => {
  const names = ["E64 WS", "E65S GbW", "E80S GbW", "DF64 Gen 1", "DF64 Gen 2", "DF54", "Niche Zero",
    "Baratza Encore ESP", "Timemore Sculptor 064S", "Timemore Sculptor 078S", "LAGOM 01", "LAGOM P64",
    "1Zpresso X-Pro", "1Zpresso J-Max", "1Zpresso K series", "Fellow Ode Gen 2"];
  assert.equal(catalog.models.length, 16);
  names.forEach(name => assert.ok(mechanics.profileFor(name), name));
  assert.equal(mechanics.profileFor("1Zpresso K-Ultra"), null);
});

test("DDD readout is distinct from baseline-relative displacement and physical offset", () => {
  for (const model of ["E64 WS", "E65S GbW", "E80S GbW"]) {
    const indicated = mechanics.estimate({ model, nativeValue: 62 });
    assert.equal(indicated.indicatedDistanceUm, 62);
    assert.equal(indicated.axialMovementUm, null);
    const delta = mechanics.estimate({ model, nativeValue: 62, baselineNativeValue: 60 });
    assert.equal(delta.axialMovementUm, 2);
    const mapped = relative({ model, nativeValue: 62, baselineNativeValue: 60, signedAxialUmPerNative: undefined });
    assert.equal(mapped.relativeCoordinate, 20);
    const physical = mechanics.toPhysicalCoordinate({ model, nativeValue: 62, baselineNativeValue: 60, zeroOffsetUm: 60 });
    assert.equal(physical.coordinate, 62);
    assert.equal(mechanics.toPhysicalCoordinate({ model, nativeValue: 62, zeroOffsetUm: 60 }).coordinate, null);
  }
});

test("P64 and LAGOM01 distinguish printed numbers from minor-line counts", () => {
  for (const [model, perLine] of [["LAGOM P64", 10], ["LAGOM 01", 7.5]]) {
    const printed = mechanics.estimate({ model, nativeValue: 1.1, baselineNativeValue: 1, nativeUnit: "printed_number" });
    close(printed.axialMovementUm, perLine);
    assert.equal(printed.nativeUnit, "printed_number");
    assert.equal(printed.nominalUmPerNative, 10 * perLine);
    const minor = mechanics.estimate({ model, nativeValue: 11, baselineNativeValue: 10 });
    close(minor.axialMovementUm, perLine);
    assert.equal(mechanics.estimate({ model, nativeValue: 1, baselineNativeValue: 0, nativeUnit: "clicks" }).status, "invalid");
  }
});

test("unknown pitch and cross-segment Encore response are never filled from unrelated candidates", () => {
  for (const model of ["Niche Zero", "Timemore Sculptor 064S", "Fellow Ode Gen 2", "Baratza Encore ESP"]) {
    assert.equal(mechanics.estimate({ model, nativeValue: 21, baselineNativeValue: 20, acceptScenario: true }).status, "unavailable");
  }
  const candidateOnly = createGrinderMechanics({ models: [{ model: "Candidate", candidates: [{ value: 1248, unit: "µm per revolution" }] }] });
  assert.equal(candidateOnly.estimate({ model: "Candidate", nativeValue: 1, baselineNativeValue: 0, acceptScenario: true }).status, "unavailable");
});

test("DF54 and DF64Gen2 scenarios require opt-in; firsthand and nominal quantities retain units", () => {
  for (const model of ["DF54", "DF64 Gen 2"]) {
    assert.equal(mechanics.estimate({ model, nativeValue: 2, baselineNativeValue: 1 }).status, "unavailable");
    const result = mechanics.estimate({ model, nativeValue: 2, baselineNativeValue: 1, acceptScenario: true });
    assert.equal(result.status, "provisional_scenario");
    assert.ok(result.axialMovementUm > 0);
    assert.equal(result.scenario.promotesToCalibration, false);
  }
  for (const [model, rate] of [["DF64 Gen 1", 10.4], ["Timemore Sculptor 078S", 30],
    ["1Zpresso X-Pro", 12.5], ["1Zpresso J-Max", 8.8], ["1Zpresso K series", 22]]) {
    close(mechanics.estimate({ model, nativeValue: 2, baselineNativeValue: 1 }).axialMovementUm, rate);
  }
});

test("relative research mapping requires explicit acceptance and conical geometry assumption", () => {
  assert.equal(relative({ acceptScenario: false }).relativeCoordinate, null);
  assert.equal(relative({ model: "1Zpresso X-Pro", signedAxialUmPerNative: 12.5 }).relativeCoordinate, null);
  const accepted = relative({ model: "1Zpresso X-Pro", nativeValue: 2, baselineNativeValue: 0,
    signedAxialUmPerNative: 12.5, acceptGeometryAssumption: true });
  assert.equal(accepted.relativeCoordinate, 250);
  assert.equal(accepted.status, "provisional_scenario");
  assert.equal(proposal({ model: "1Zpresso X-Pro" }).proposedNative, null);
});

test("signed mechanical-to-research mapping round trips both directions without losing the pitch", () => {
  for (const slope of [10.4, -10.4, .01, -75, 100]) {
    for (const change of [-.25, .25]) {
      const mapped = relative({ nativeValue: 22 + change, signedAxialUmPerNative: slope });
      close(mapped.relativeCoordinate, change * slope / .1);
      const back = proposal({ signedAxialUmPerNative: slope, requestedResearchDelta: mapped.relativeCoordinate });
      close(back.proposedNative, 22 + change);
      assert.equal(back.status, "estimated_relative");
    }
  }
});

test("relative adapter is invariant to a native coordinate translation and retains explicit research offset", () => {
  const mapped = relative({ baselineResearchCoordinate: 500 });
  assert.equal(mapped.researchCoordinate, 526);
  const translated = relative({ nativeValue: 122.25, baselineNativeValue: 122, baselineResearchCoordinate: 1500 });
  assert.equal(translated.relativeCoordinate, mapped.relativeCoordinate);
  assert.equal(translated.researchCoordinate, 1526);
  assert.equal(relative().researchCoordinate, null);
});

test("source-derived direction is explicit and the zero displacement still maps to zero", () => {
  assert.equal(relative({ signedAxialUmPerNative: undefined, finerSign: -1 }).relativeCoordinate, 26);
  assert.equal(relative({ signedAxialUmPerNative: undefined, finerSign: 1 }).relativeCoordinate, -26);
  assert.equal(relative({ signedAxialUmPerNative: undefined, finerSign: -1, nativeValue: 22 }).relativeCoordinate, 0);
  assert.equal(relative({ signedAxialUmPerNative: undefined }).relativeCoordinate, null);
});

test("no missing or invalid slope silently becomes one micrometre per native unit", () => {
  for (const signedAxialUmPerNative of [undefined, null, "10.4", 0, NaN, Infinity]) {
    assert.equal(proposal({ signedAxialUmPerNative }).proposedNative, null);
  }
  const explicitMagnitude = proposal({ signedAxialUmPerNative: undefined, umPerNative: 10.4, finerSign: -1 });
  assert.equal(explicitMagnitude.proposedNative, 22.25);
});

test("continuous owner step is a movement cap and never an absolute rounding grid", () => {
  assert.equal(proposal({ currentNativeValue: 22.1, requestedResearchDelta: 1000, ownerStep: .25 }).proposedNative, 22.35);
  assert.equal(proposal({ requestedResearchDelta: 10.4 }).proposedNative, 22.1);
  assert.equal(proposal({ requestedResearchDelta: -1000, ownerStep: .25 }).proposedNative, 21.75);
  assert.equal(proposal({ currentNativeValue: 89.9, requestedResearchDelta: 1000 }).proposedNative, 90);
});

test("discrete proposals quantize toward current, never beyond raw movement or owner step", () => {
  const base = { currentNativeValue: 12, signedAxialUmPerNative: 1, umPerResearchUnit: 1, physicalIncrement: 1, ownerStep: 1.5 };
  assert.equal(proposal({ ...base, requestedResearchDelta: 1.5 }).proposedNative, 13);
  assert.equal(proposal({ ...base, requestedResearchDelta: -1.5 }).proposedNative, 11);
  for (const requestedResearchDelta of [.5, .6, -.6]) {
    const held = proposal({ ...base, requestedResearchDelta });
    assert.equal(held.status, "hold");
    assert.equal(held.proposedNative, null);
  }
  assert.equal(proposal({ ...base, requestedResearchDelta: 4, ownerStep: .5 }).status, "hold");
});

test("physical bounds choose only achievable lattice points and invalid current cannot be rounded silently", () => {
  const base = { currentNativeValue: 12, signedAxialUmPerNative: 1, umPerResearchUnit: 1, physicalIncrement: 1, ownerStep: 4, requestedResearchDelta: 4 };
  assert.equal(proposal({ ...base, maxNative: 13.5 }).proposedNative, 13);
  assert.equal(proposal({ ...base, maxNative: 12.5 }).status, "hold");
  assert.equal(proposal({ ...base, currentNativeValue: 12.5 }).status, "invalid");
  assert.equal(proposal({ ...base, currentNativeValue: 12.5, physicalOrigin: .5 }).proposedNative, 16.5);
  assert.equal(proposal({ ...base, requestedResearchDelta: -4, minNative: 10.5 }).proposedNative, 11);
});

test("decimal physical increments tolerate representation error without changing the grid", () => {
  const result = proposal({ currentNativeValue: .35, signedAxialUmPerNative: 1, umPerResearchUnit: 1,
    requestedResearchDelta: .15, ownerStep: .2, physicalIncrement: .1, physicalOrigin: .05 });
  close(result.proposedNative, .45);
});

test("bounded proposal invariants hold over signs, steps, requested deltas and fractional boundaries", () => {
  for (const current of [-12, 0, 12]) for (const sign of [-1, 1]) for (const requested of [.1, .5, .99, 1, 1.5, 2, 4, 40])
    for (const cap of [.25, 1, 1.5, 3]) {
      const lower = current - 2.5, upper = current + 2.5;
      const result = proposal({ currentNativeValue: current, signedAxialUmPerNative: sign * 2, umPerResearchUnit: .1,
        requestedResearchDelta: requested * 20, ownerStep: cap, minNative: lower, maxNative: upper, physicalIncrement: 1 });
      if (result.proposedNative === null) { assert.equal(result.status, "hold"); continue; }
      assert.ok(Number.isInteger(result.proposedNative));
      const delta = result.proposedNative - current;
      assert.equal(Math.sign(delta), sign);
      assert.ok(Math.abs(delta) <= cap && Math.abs(delta) <= requested);
      assert.ok(result.proposedNative >= lower && result.proposedNative <= upper);
    }
});

test("nonnumeric coordinates and malformed bounds or resolution fail closed", () => {
  for (const value of [null, "2", NaN, Infinity]) {
    assert.equal(relative({ model: "Unknown", nativeValue: value }).relativeCoordinate, null);
    assert.equal(relative({ baselineResearchCoordinate: value }).researchCoordinate, null);
    assert.equal(proposal({ physicalIncrement: value }).proposedNative, null);
    assert.equal(proposal({ minNative: value }).proposedNative, null);
  }
  assert.equal(proposal({ minNative: 30, maxNative: 20 }).status, "invalid");
  assert.equal(proposal({ currentNativeValue: 100 }).status, "invalid");
  assert.equal(proposal({ physicalOrigin: 0 }).status, "invalid");
  assert.equal(mechanics.estimate({ model: "DF54", nativeValue: "2", baselineNativeValue: 0, acceptScenario: true }).status, "invalid");
});

test("overflow never escapes as a nominal coordinate, movement or proposal", () => {
  const results = [
    mechanics.estimate({ model: "1Zpresso X-Pro", nativeValue: 1e308, baselineNativeValue: -1e308 }),
    mechanics.estimate({ model: "DF54", nativeValue: 1e308, baselineNativeValue: 0, acceptScenario: true }),
    mechanics.toPhysicalCoordinate({ model: "E64 WS", nativeValue: 1e308, baselineNativeValue: 0, zeroOffsetUm: 1e308 }),
    relative({ model: "Unknown", nativeValue: 1e308, baselineNativeValue: 0, signedAxialUmPerNative: 1,
      umPerResearchUnit: 1, baselineResearchCoordinate: 1e308 }),
    proposal({ currentNativeValue: 1e308, requestedResearchDelta: 1e308, signedAxialUmPerNative: 1,
      umPerResearchUnit: 1, ownerStep: 1e308, minNative: undefined, maxNative: undefined }),
  ];
  results.forEach(finiteOutputs);
  assert.equal(results[0].status, "invalid");
  assert.equal(results[1].status, "invalid");
  assert.equal(results[2].coordinate, null);
  assert.equal(results[3].researchCoordinate, null);
  assert.equal(results[4].proposedNative, null);
});

test("embedded factory runs without module helpers and preserves caller inputs and evidence", () => {
  const vm = require("node:vm");
  const before = JSON.stringify(catalog);
  const factory = vm.runInNewContext("(" + createGrinderMechanics.toString() + ")");
  const embedded = factory(catalog);
  const input = { currentNativeValue: 12, requestedResearchDelta: 1.5, signedAxialUmPerNative: 1,
    umPerResearchUnit: 1, ownerStep: 1.5, physicalIncrement: 1, acceptScenario: true };
  const snapshot = JSON.stringify(input);
  assert.equal(embedded.proposeNative(input).proposedNative, 13);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(JSON.stringify(catalog), before);
});
