"use strict";

function createGrinderMechanics(catalog) {
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const modelKey = (model) => String(model || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const byModel = new Map(models.map((profile) => [modelKey(profile.model), profile]));

  function profileFor(model) {
    return byModel.get(modelKey(model)) || null;
  }

  function estimate(input = {}) {
    const profile = profileFor(input.model);
    if (!profile) return { status: "unavailable", reason: "No reviewed mechanical profile exists for this grinder." };
    const value = input.nativeValue;
    if (!finite(value)) return { status: "invalid", reason: "nativeValue must be finite." };
    if (profile.status === "candidate_unverified") return { status: "unavailable", model: profile.model, nativeValue: value, uncertainty: profile.uncertainty, reason: "This candidate estimate is not verified and is withheld from conversion." };
    const relative = profile.relativeMovement || null;
    const nativeUnit = profile.nativeUnit || relative?.coordinateUnit || "native units";
    const min = finite(input.nativeMin) ? input.nativeMin : profile.nativeRange?.min;
    const max = finite(input.nativeMax) ? input.nativeMax : profile.nativeRange?.max;
    if (profile.rangeIsOperatingBound === true && finite(min) && finite(max) && (value < min || value > max)) return { status: "invalid", reason: "nativeValue is outside the verified operating range." };
    if (profile.nativeUnit === "micrometres" || relative?.umPerUnit === 1 && /micrometre/i.test(nativeUnit)) {
      return { status: "mechanical_reference", model: profile.model, nativeValue: value, nativeUnit, axialMovementUm: value, uncertainty: profile.uncertainty, warnings: ["This is an indicated burr-disk distance, not particle size or a calibrated espresso response."] };
    }
    const movementPerUnit = finite(profile.axialMovementUmPerNative) ? profile.axialMovementUmPerNative : relative?.umPerUnit;
    if (finite(movementPerUnit)) {
      if (!finite(input.baselineNativeValue)) return { status: "needs_baseline", model: profile.model, nativeValue: value, nativeUnit: profile.nativeUnit, uncertainty: profile.uncertainty, reason: "A pitch is a relative movement; provide baselineNativeValue before estimating axial displacement." };
      return { status: "mechanical_reference", model: profile.model, nativeValue: value, baselineNativeValue: input.baselineNativeValue, nativeUnit, axialMovementUm: (value - input.baselineNativeValue) * movementPerUnit, uncertainty: profile.uncertainty, warnings: ["Mechanical movement is a relative geometry prior; it does not establish an espresso setting or particle-size conversion."] };
    }
    const scenario = profile.exploratoryScenario;
    if (scenario && input.acceptScenario === true && scenario.requiresExplicitAssumptionAcceptance === true && finite(scenario.centralUmPerUnit)) {
      if (!finite(input.baselineNativeValue)) return { status: "needs_baseline", model: profile.model, nativeValue: value, nativeUnit: scenario.coordinateUnit || nativeUnit, uncertainty: scenario.sensitivityIntervalUmPerUnit || null, reason: "This is an explicit scenario candidate; provide baselineNativeValue." };
      return { status: "provisional_scenario", model: profile.model, nativeValue: value, baselineNativeValue: input.baselineNativeValue, nativeUnit: scenario.coordinateUnit || nativeUnit, axialMovementUm: (value - input.baselineNativeValue) * scenario.centralUmPerUnit, uncertainty: scenario.sensitivityIntervalUmPerUnit || null, scenario, warnings: ["This candidate is an explicit engineering scenario, not a measured default or owner calibration."] };
    }
    const candidate = Array.isArray(profile.candidates) && profile.candidates.find(item => item && item.usableAsDefault !== true && input.acceptScenario === true && finite(item.value) && /µm|um/i.test(String(item.unit || "")));
    if (candidate) {
      if (!finite(input.baselineNativeValue)) return { status: "needs_baseline", model: profile.model, nativeValue: value, nativeUnit, uncertainty: profile.uncertainty, reason: "This is an explicit scenario candidate; provide baselineNativeValue." };
      return { status: "provisional_scenario", model: profile.model, nativeValue: value, baselineNativeValue: input.baselineNativeValue, nativeUnit, axialMovementUm: (value - input.baselineNativeValue) * candidate.value, candidate, warnings: ["This candidate is an explicit engineering scenario, not a measured default or owner calibration."] };
    }
    return { status: "unavailable", model: profile.model, nativeValue: value, nativeUnit, uncertainty: profile.uncertainty, reason: "No defensible pitch or dial-range prior is available." };
  }

  function toPhysicalCoordinate(input = {}) {
    const estimateResult = estimate(input);
    if (!['mechanical_reference', 'provisional_scenario'].includes(estimateResult.status) || !finite(input.zeroOffsetUm)) return { ...estimateResult, coordinate: null, reason: "A sourced relative movement and explicit physical zero offset are required." };
    return { ...estimateResult, coordinate: input.zeroOffsetUm + estimateResult.axialMovementUm, coordinateUnit: "µm from declared physical zero", status: estimateResult.status === 'provisional_scenario' ? "provisional_scenario_coordinate" : "provisional_physical_coordinate", warnings: [...(estimateResult.warnings || []), "This physical coordinate is provisional and must not be saved as owner calibration without owner verification."] };
  }

  function toRelativeCoordinate(input = {}) {
    const estimateResult = estimate(input);
    if (!['mechanical_reference', 'provisional_scenario'].includes(estimateResult.status)) return { ...estimateResult, relativeCoordinate: null };
    const finerSign = input.finerSign === -1 ? -1 : input.finerSign === 1 ? 1 : null;
    if (finerSign === null || !finite(input.umPerResearchUnit) || input.umPerResearchUnit <= 0) return { ...estimateResult, relativeCoordinate: null, reason: "finerSign and an explicit mechanical-to-research slope are required for a relative coordinate." };
    const relativeCoordinate = estimateResult.axialMovementUm * finerSign / input.umPerResearchUnit;
    const absolute = finite(input.baselineResearchCoordinate) ? input.baselineResearchCoordinate + relativeCoordinate : null;
    return { ...estimateResult, relativeCoordinate, researchCoordinate: absolute, coordinateStatus: "estimated_relative", warnings: [...(estimateResult.warnings || []), "Relative research movement is an exploratory adapter; it has no absolute calibration offset."] };
  }

  function proposeNative(input = {}) {
    const required = ['currentNativeValue', 'requestedResearchDelta', 'umPerResearchUnit', 'finerSign', 'ownerStep'];
    if (required.some(key => !finite(input[key])) || input.umPerResearchUnit <= 0 || input.ownerStep <= 0 || ![1, -1].includes(input.finerSign)) return { status: "invalid", reason: "Native proposal requires an explicit slope, direction and owner step." };
    if (input.acceptScenario !== true) return { status: "withheld", reason: "Native proposal requires explicit acceptance of the mechanical scenario." };
    const rawDelta = input.requestedResearchDelta * input.umPerResearchUnit / input.finerSign;
    let proposed = input.currentNativeValue + rawDelta;
    proposed = Math.round(proposed / input.ownerStep) * input.ownerStep;
    if (finite(input.physicalIncrement) && input.physicalIncrement > 0) proposed = Math.round(proposed / input.physicalIncrement) * input.physicalIncrement;
    if (finite(input.minNative) && proposed < input.minNative) return { status: "out_of_bounds", proposedNative: input.minNative, reason: "Requested movement is below the owner-declared native bound." };
    if (finite(input.maxNative) && proposed > input.maxNative) return { status: "out_of_bounds", proposedNative: input.maxNative, reason: "Requested movement is above the owner-declared native bound." };
    return { status: "estimated_relative", proposedNative: proposed, coordinateStatus: "estimated_relative", warnings: ["This is a bounded owner-step proposal under an accepted mechanical scenario; it is not calibration."] };
  }

  return Object.freeze({ profileFor, estimate, toPhysicalCoordinate, toRelativeCoordinate, proposeNative });
}

if (typeof module !== "undefined") module.exports = { createGrinderMechanics };
