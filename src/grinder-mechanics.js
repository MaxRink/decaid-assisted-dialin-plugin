"use strict";

// Self-contained: the same factory is embedded in the native plugin and website.
function createGrinderMechanics(catalog) {
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const modelKey = model => String(model || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const byModel = new Map(models.map(profile => [modelKey(profile.model), profile]));
  models.forEach(profile => { if (profile.id) byModel.set(modelKey(profile.id), profile); });
  const aliases = { baratzaencoreesp: "encoreesp", "1zpressokseries": "kseries" };
  const profileFor = model => byModel.get(aliases[modelKey(model)] || modelKey(model)) || null;
  const invalid = reason => ({ status: "invalid", reason });
  const supplied = (input, key) => input[key] !== undefined;
  const validBounds = (input, minKey, maxKey, value) =>
    (!supplied(input, minKey) || finite(input[minKey])) &&
    (!supplied(input, maxKey) || finite(input[maxKey])) &&
    !(finite(input[minKey]) && finite(input[maxKey]) && input[minKey] >= input[maxKey]) &&
    !(finite(input[minKey]) && value < input[minKey]) &&
    !(finite(input[maxKey]) && value > input[maxKey]);

  function estimate(input = {}) {
    if (!input || typeof input !== "object") return invalid("Supply an input object.");
    const profile = profileFor(input.model);
    if (!profile) return { status: "unavailable", reason: "No reviewed mechanical profile exists for this grinder." };
    if (!finite(input.nativeValue) || (supplied(input, "baselineNativeValue") && !finite(input.baselineNativeValue)))
      return invalid("Native value and any supplied baseline must be finite numbers.");
    if (!validBounds(input, "nativeMin", "nativeMax", input.nativeValue)) return invalid("Native value or operating bounds are invalid.");
    if (finite(input.baselineNativeValue) && !validBounds(input, "nativeMin", "nativeMax", input.baselineNativeValue))
      return invalid("The baseline lies outside the supplied operating bounds.");
    if (profile.rangeIsOperatingBound === true && !validBounds({ nativeMin: profile.nativeRange?.min, nativeMax: profile.nativeRange?.max }, "nativeMin", "nativeMax", input.nativeValue))
      return invalid("Native value is outside the verified operating range.");
    if (profile.status === "candidate_unverified") return { status: "unavailable", reason: "Unverified candidate movement is withheld." };
    const relative = profile.relativeMovement;
    let nativeUnit = profile.nativeUnit || relative?.coordinateUnit || "native units";
    const indicated = relative?.quantity === "indicated disc distance" || profile.mapping === "native_disk_distance";
    let rate = indicated ? 1 : finite(profile.axialMovementUmPerNative) ? profile.axialMovementUmPerNative : relative?.umPerUnit;
    let scenario = null;
    if (!finite(rate)) {
      scenario = profile.exploratoryScenario;
      if (!(input.acceptScenario === true && scenario?.requiresExplicitAssumptionAcceptance === true && finite(scenario.centralUmPerUnit)))
        return { status: "unavailable", model: profile.model, reason: "No defensible scalar movement is available in this coordinate; unknown transitions and candidate-only values are withheld." };
      rate = scenario.centralUmPerUnit;
      nativeUnit = scenario.coordinateUnit || nativeUnit;
    }
    if (input.nativeUnit === "printed_number") {
      if (finite(profile.perWholePrintedNumberUm)) rate = profile.perWholePrintedNumberUm;
      else if (!/whole printed dial number/.test(nativeUnit)) return invalid("This profile does not establish movement per whole printed number.");
      nativeUnit = "printed_number";
    } else if (supplied(input, "nativeUnit") && input.nativeUnit !== nativeUnit) {
      return invalid("The requested native unit does not match this mechanical reference.");
    }
    if (!(rate > 0)) return invalid("The referenced movement per native unit must be positive and finite.");
    const base = { status: scenario ? "provisional_scenario" : "mechanical_reference", model: profile.model,
      nativeValue: input.nativeValue, nativeUnit, nominalUmPerNative: rate,
      uncertainty: scenario ? scenario.sensitivityIntervalUmPerUnit || null : profile.uncertainty,
      axialMovementUm: null, warnings: ["Nominal axial movement or indicated distance is not particle size, a calibrated espresso response, or a validated research dD mapping."] };
    if (scenario) base.scenario = scenario;
    if (indicated) base.indicatedDistanceUm = input.nativeValue;
    if (!finite(input.baselineNativeValue)) return indicated ? base : { ...base, status: "needs_baseline", reason: "Relative movement requires baselineNativeValue." };
    const delta = input.nativeValue - input.baselineNativeValue;
    const movement = delta * rate;
    if (!finite(delta) || !finite(movement)) return invalid("Relative movement overflowed the finite numeric range.");
    return { ...base, baselineNativeValue: input.baselineNativeValue, axialMovementUm: movement };
  }

  function toPhysicalCoordinate(input = {}) {
    const reference = estimate(input);
    const withheld = reason => ({ ...reference, coordinate: null, reason });
    if (!input || !finite(input.baselineNativeValue) || !finite(input.zeroOffsetUm))
      return withheld("An explicit baseline and its physical coordinate (zeroOffsetUm) are required.");
    if (!["mechanical_reference", "provisional_scenario"].includes(reference.status) || !finite(reference.axialMovementUm))
      return withheld("A sourced relative movement and explicit baseline coordinate are required.");
    // zeroOffsetUm is the declared axial coordinate AT baselineNativeValue.
    // A displayed distance is never added a second time as a displacement.
    const coordinate = input.zeroOffsetUm + reference.axialMovementUm;
    if (!finite(coordinate)) return withheld("Physical coordinate overflowed the finite numeric range.");
    return { ...reference, coordinate, coordinateUnit: "micrometres, axial coordinate from declared baseline reference",
      status: reference.status === "provisional_scenario" ? "provisional_scenario_coordinate" : "provisional_physical_coordinate",
      warnings: [...reference.warnings, "The declared baseline offset is an assumption, not independently verified calibration. Conical axial position is not surface-normal burr clearance."] };
  }

  function toRelativeCoordinate(input = {}) {
    const withheld = (status, reason) => ({ status, relativeCoordinate: null, researchCoordinate: null, reason });
    if (!input || ![input.nativeValue, input.baselineNativeValue, input.umPerResearchUnit].every(finite) || input.umPerResearchUnit <= 0 ||
        (supplied(input, "baselineResearchCoordinate") && !finite(input.baselineResearchCoordinate)))
      return withheld("invalid", "Supply finite native coordinates, a positive research unit scale, and a finite optional research baseline.");
    if ((supplied(input, "nativeUnit") && (typeof input.nativeUnit !== "string" || !input.nativeUnit.trim())) ||
        !validBounds(input, "nativeMin", "nativeMax", input.nativeValue) ||
        !validBounds(input, "nativeMin", "nativeMax", input.baselineNativeValue))
      return withheld("invalid", "Native unit, coordinates or supplied operating bounds are invalid.");
    if (input.acceptScenario !== true) return withheld("withheld", "Mapping mechanical movement to research dD requires explicit scenario acceptance.");
    const profile = profileFor(input.model);
    if (profile?.burrGeometry === "conical" && input.acceptGeometryAssumption !== true)
      return withheld("withheld", "Conical axial movement requires explicit geometry-assumption acceptance before research dD mapping.");
    const reference = estimate(input);
    let slope = input.signedAxialUmPerNative;
    let slopeProvenance = "owner_accepted_assumption";
    if (!supplied(input, "signedAxialUmPerNative")) {
      const rate = reference.nominalUmPerNative;
      const indicated = finite(reference.indicatedDistanceUm);
      slope = finite(rate) && (indicated || [1, -1].includes(input.finerSign)) ? rate * (indicated ? 1 : -input.finerSign) : null;
      slopeProvenance = "reference_magnitude_and_native_direction";
    }
    if (!finite(slope) || slope === 0) return withheld("invalid", "A finite nonzero signedAxialUmPerNative is required; no unit slope is invented.");
    const delta = input.nativeValue - input.baselineNativeValue;
    const movement = delta * slope;
    const relativeCoordinate = movement / input.umPerResearchUnit;
    const researchCoordinate = supplied(input, "baselineResearchCoordinate") ? input.baselineResearchCoordinate + relativeCoordinate : null;
    if (!finite(delta) || !finite(movement) || !finite(relativeCoordinate) || (researchCoordinate !== null && !finite(researchCoordinate)))
      return withheld("invalid", "Relative or baseline research coordinate overflowed the finite numeric range.");
    return { status: "provisional_scenario", coordinateStatus: "estimated_relative", model: typeof input.model === "string" ? input.model : null,
      nativeValue: input.nativeValue, baselineNativeValue: input.baselineNativeValue, nativeUnit: input.nativeUnit || reference.nativeUnit || "owner units",
      signedAxialUmPerNative: slope, slopeProvenance, axialMovementUm: movement, relativeCoordinate, researchCoordinate,
      warnings: ["This explicitly accepted research adapter is exploratory. Its research baseline is not an absolute physical calibration or a validation of GbS response."] };
  }

  function proposeNative(input = {}) {
    const withheld = (status, reason) => ({ status, proposedNative: null, reason });
    if (!input || ![input.currentNativeValue, input.requestedResearchDelta, input.umPerResearchUnit, input.ownerStep].every(finite) ||
        input.umPerResearchUnit <= 0 || input.ownerStep <= 0)
      return withheld("invalid", "Native proposal requires finite coordinates, a positive research unit scale and a positive owner step.");
    const slope = supplied(input, "signedAxialUmPerNative") ? input.signedAxialUmPerNative :
      finite(input.umPerNative) && input.umPerNative > 0 && [1, -1].includes(input.finerSign) ? -input.finerSign * input.umPerNative : null;
    if (!finite(slope) || slope === 0) return withheld("invalid", "Supply a finite nonzero signed slope; native movement is never inferred from a default unit slope.");
    if (input.acceptScenario !== true) return withheld("withheld", "Native proposal requires explicit acceptance of the mechanical scenario.");
    if (profileFor(input.model)?.burrGeometry === "conical" && input.acceptGeometryAssumption !== true)
      return withheld("withheld", "Conical axial movement requires explicit geometry-assumption acceptance before research dD mapping.");
    if (!validBounds(input, "minNative", "maxNative", input.currentNativeValue)) return withheld("invalid", "Current native value or operating bounds are invalid.");
    const discrete = supplied(input, "physicalIncrement");
    const origin = supplied(input, "physicalOrigin") ? input.physicalOrigin : 0;
    if ((discrete && (!finite(input.physicalIncrement) || input.physicalIncrement <= 0 || !finite(origin))) || (!discrete && supplied(input, "physicalOrigin")))
      return withheld("invalid", "A physical increment must be positive and finite; its optional numeric lattice origin must be finite.");
    const rawDelta = input.requestedResearchDelta * input.umPerResearchUnit / slope;
    if (!finite(rawDelta)) return withheld("invalid", "Requested native movement overflowed the finite numeric range.");
    const sign = Math.sign(rawDelta);
    const room = sign > 0 && finite(input.maxNative) ? input.maxNative - input.currentNativeValue :
      sign < 0 && finite(input.minNative) ? input.currentNativeValue - input.minNative : Infinity;
    const cap = Math.min(Math.abs(rawDelta), input.ownerStep, room);
    let movement = cap;
    let proposed;
    if (discrete) {
      const increment = input.physicalIncrement;
      const index = (input.currentNativeValue - origin) / increment;
      const currentIndex = Math.round(index);
      const roundoff = number => Math.min(1e-7, 8 * Number.EPSILON * Math.max(1, Math.abs(number)));
      if (!Number.isSafeInteger(currentIndex) || Math.abs(index - currentIndex) > roundoff(index))
        return withheld("invalid", "Current native setting is not on the physical setting lattice.");
      const ratio = cap / increment;
      let steps = Math.floor(ratio + roundoff(ratio));
      if (!Number.isSafeInteger(steps) || !Number.isSafeInteger(currentIndex + sign * steps))
        return withheld("invalid", "The requested lattice movement exceeds reliable numeric precision.");
      proposed = origin + (currentIndex + sign * steps) * increment;
      const epsilon = Math.min(increment * 1e-7, 8 * Number.EPSILON * Math.max(1, Math.abs(proposed), Math.abs(input.currentNativeValue)));
      if (!finite(proposed)) return withheld("invalid", "Proposed native value overflowed the finite numeric range.");
      const normalizeBoundRoundoff = value => {
        if (finite(input.minNative) && value < input.minNative && input.minNative - value <= epsilon) return input.minNative;
        if (finite(input.maxNative) && value > input.maxNative && value - input.maxNative <= epsilon) return input.maxNative;
        return value;
      };
      proposed = normalizeBoundRoundoff(proposed);
      if (!validBounds(input, "minNative", "maxNative", proposed) || Math.abs(proposed - input.currentNativeValue) > cap + epsilon) {
        steps--;
        proposed = normalizeBoundRoundoff(origin + (currentIndex + sign * steps) * increment);
      }
      if (steps <= 0 || !finite(proposed) || !validBounds(input, "minNative", "maxNative", proposed) ||
          sign * (proposed - input.currentNativeValue) <= 0 || Math.abs(proposed - input.currentNativeValue) > cap + epsilon)
        return withheld("hold", "No full physical increment fits the requested movement, owner step and operating bounds.");
      movement = Math.abs(proposed - input.currentNativeValue);
    } else {
      proposed = input.currentNativeValue + sign * movement;
      if (!finite(proposed)) return withheld("invalid", "Proposed native value overflowed the finite numeric range.");
      if (!validBounds(input, "minNative", "maxNative", proposed)) return withheld("out_of_bounds", "Proposed native value leaves the declared operating bounds.");
      if (!movement || proposed === input.currentNativeValue) return withheld("hold", "No nonzero movement fits the requested change and operating bounds.");
    }
    return { status: "estimated_relative", proposedNative: proposed, nativeDelta: proposed - input.currentNativeValue,
      rawNativeDelta: rawDelta, stepLimited: Math.abs(rawDelta) > input.ownerStep, coordinateStatus: "estimated_relative",
      warnings: ["This is at most one owner-confirmed native step under an accepted mechanical scenario, not calibration. Brew and measure again."] };
  }

  return Object.freeze({ profileFor, estimate, toPhysicalCoordinate, toRelativeCoordinate, proposeNative });
}

if (typeof module !== "undefined") module.exports = { createGrinderMechanics };
