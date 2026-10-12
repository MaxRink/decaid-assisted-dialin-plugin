"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("../data/grinder-mechanics.json");
const evidenceCatalog = require("../data/mechanics-evidence.json");
const { createGrinderMechanics } = require("../src/grinder-mechanics");

const mechanics = createGrinderMechanics(catalog);

test("known native disk distance is reported as mechanical distance only", () => {
  const result = mechanics.estimate({ model: "E64 WS", nativeValue: 500 });
  assert.equal(result.status, "mechanical_reference");
  assert.equal(result.axialMovementUm, 500);
  assert.match(result.warnings[0], /particle size/);
});

test("DF64 dial fraction is provisional and does not invent a coordinate", () => {
  const result = mechanics.estimate({ model: "DF64 Gen 1", nativeValue: 45 });
  assert.equal(result.status, "unavailable");
  const withheld = mechanics.toPhysicalCoordinate({ model: "DF64 Gen 1", nativeValue: 45, zeroOffsetUm: 0 });
  assert.equal(withheld.coordinate, null);
  assert.match(withheld.reason, /relative movement/);
});

test("relative pitch requires a baseline and explicit physical zero", () => {
  const missing = mechanics.estimate({ model: "1Zpresso X-Pro", nativeValue: 2 });
  assert.equal(missing.status, "needs_baseline");
  const result = mechanics.toPhysicalCoordinate({ model: "1Zpresso X-Pro", nativeValue: 2, baselineNativeValue: 0, zeroOffsetUm: 100 });
  assert.equal(result.status, "provisional_physical_coordinate");
  assert.equal(result.coordinate, 125);
  assert.match(result.warnings.at(-1), /must not be saved/);
});

test("unknown models and nonnumeric values are withheld", () => {
  assert.equal(mechanics.estimate({ model: "Unknown", nativeValue: 1 }).status, "unavailable");
  assert.equal(mechanics.estimate({ model: "DF54", nativeValue: "55" }).status, "invalid");
});

test("P64 nominal line movement remains a mechanical prior", () => {
  const result = mechanics.estimate({ model: "LAGOM P64", nativeValue: 2, baselineNativeValue: 0 });
  assert.equal(result.status, "mechanical_reference");
  assert.equal(result.axialMovementUm, 20);
  assert.match(result.warnings[0], /particle-size/);
});

test("full evidence catalog keeps DF64 and DF54 scenarios opt-in", () => {
  const evidence = createGrinderMechanics(evidenceCatalog);
  assert.equal(evidence.estimate({ model: "DF64 Gen 1", nativeValue: 2, baselineNativeValue: 0 }).status, "mechanical_reference");
  const df54 = evidence.estimate({ model: "DF54", nativeValue: 2, baselineNativeValue: 0 });
  assert.equal(df54.status, "unavailable");
  const accepted = evidence.estimate({ model: "DF54", nativeValue: 2, baselineNativeValue: 0, acceptScenario: true });
  assert.equal(accepted.status, "provisional_scenario");
  assert.deepEqual(accepted.uncertainty, [6, 11]);
  assert.equal(evidence.estimate({ model: "LAGOM P64", nativeValue: 1, baselineNativeValue: 0 }).axialMovementUm, 10);
});

test("relative adapter keeps offset separate and caps native proposals", () => {
  const evidence = createGrinderMechanics(evidenceCatalog);
  const relative = evidence.toRelativeCoordinate({ model: "DF64 Gen 1", nativeValue: 2, baselineNativeValue: 0, finerSign: 1, umPerResearchUnit: 10.4, baselineResearchCoordinate: 500 });
  assert.equal(relative.coordinateStatus, "estimated_relative");
  assert.equal(relative.researchCoordinate, 502);
  const proposal = evidence.proposeNative({ currentNativeValue: 40, requestedResearchDelta: 25, umPerResearchUnit: 10.4, finerSign: 1, ownerStep: 1, minNative: 0, maxNative: 90, acceptScenario: true });
  assert.equal(proposal.status, "out_of_bounds");
  assert.equal(proposal.proposedNative, 90);
  assert.equal(evidence.proposeNative({ currentNativeValue: 40, requestedResearchDelta: 1, umPerResearchUnit: 1, finerSign: 1, ownerStep: 1 }).status, "withheld");
});
