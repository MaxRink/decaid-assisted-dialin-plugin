/*
 * Deterministic, DOM-free scenario runner for the simulator page.
 *
 * The research implementation is injected at construction time.  Keeping
 * this adapter separate means the simulator exercises the same shipped
 * functions as the plugin instead of growing a second copy of the equations.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.DecaidDialInSimulation = factory;
})(typeof globalThis === "object" ? globalThis : this, function createSimulationEngine(research) {
  "use strict";

  if (!research || typeof research.createState !== "function" || typeof research.adjust !== "function")
    throw new Error("research algorithms are required");

  const ALGORITHMS = ["GbS1", "GbS2", "GbS3", "GbS4", "DdEff"];
  const MAX_SHOTS = 100;
  const MAX_JSON = 256 * 1024;
  const INT_MIN = -2147483648;
  const INT_MAX = 2147483647;
  const DEFAULT_BOUNDS = Object.freeze({ minDdDum: 0, maxDdDum: 100000 });
  const SCOPE_KEYS = ["grinderId", "beanBatchId", "burrIdentity", "calibrationEpoch", "profile"];
  const SHOT_KEYS = [
    "actualBrewTimeMs", "targetBrewTimeMs", "toleranceMs", "estimatedDdDum",
    "setpointDdDum", "reset", "scope", "taste", "flavour", "overall", "beanType", "roastLevel", "dose", "yield",
  ];
  const PLANT_KEYS = ["baseTimeMs", "targetDdDum", "slopeMsPerDdDum", "noiseMs"];
  const TASTES = ["balanced", "sour", "bitter", "astringent", "weak", "channeling"];

  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  function finite(v, name) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(name + " must be finite");
    return v;
  }
  function integer(v, name) {
    if (!Number.isInteger(v) || v < INT_MIN || v > INT_MAX) throw new Error(name + " must be a signed 32-bit integer");
    return v;
  }
  function keys(value, allowed, name) {
    if (!isObject(value)) throw new Error(name + " must be an object");
    Object.keys(value).forEach((key) => {
      if (!allowed.includes(key)) throw new Error(name + " has unknown field " + key);
    });
  }
  function text(value, name) {
    if (typeof value !== "string" || !value.trim() || value.length > 256) throw new Error(name + " must be a non-empty string");
    return value;
  }
  function scope(value) {
    keys(value, SCOPE_KEYS, "scope");
    SCOPE_KEYS.forEach((key) => { if (value[key] != null) text(value[key], "scope." + key); });
    return clone(value);
  }
  function bounds(value) {
    const b = value == null ? DEFAULT_BOUNDS : value;
    keys(b, ["minDdDum", "maxDdDum"], "bounds");
    integer(b.minDdDum, "bounds.minDdDum");
    integer(b.maxDdDum, "bounds.maxDdDum");
    if (b.minDdDum < 0 || b.maxDdDum <= b.minDdDum) throw new Error("invalid setting bounds");
    return { minDdDum: b.minDdDum, maxDdDum: b.maxDdDum };
  }
  function clamp(value, b) {
    return Math.max(b.minDdDum, Math.min(b.maxDdDum, integer(value, "algorithm result")));
  }
  function seedValue(value) {
    if (value == null) return null;
    return integer(value, "seed") >>> 0;
  }
  function randomUnit(seed, index) {
    let x = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  }
  function plantTime(plant, setting, shotIndex, seed) {
    keys(plant, PLANT_KEYS, "plant");
    ["baseTimeMs", "targetDdDum", "slopeMsPerDdDum", "noiseMs"].forEach((key) => finite(plant[key], "plant." + key));
    if (plant.baseTimeMs <= 0 || plant.noiseMs < 0) throw new Error("invalid synthetic plant");
    const noise = seed == null ? 0 : plant.noiseMs * (randomUnit(seed, shotIndex) * 2 - 1);
    return Math.round(plant.baseTimeMs + plant.slopeMsPerDdDum * (setting - plant.targetDdDum) + noise);
  }
  function shot(value, index, fallbackTarget, fallbackTolerance) {
    keys(value, SHOT_KEYS, "shots[" + index + "]");
    ["actualBrewTimeMs", "targetBrewTimeMs", "toleranceMs", "estimatedDdDum", "setpointDdDum"].forEach((key) => {
      if (value[key] != null) integer(value[key], "shots[" + index + "]." + key);
    });
    const target = value.targetBrewTimeMs == null ? fallbackTarget : value.targetBrewTimeMs;
    const tolerance = value.toleranceMs == null ? fallbackTolerance : value.toleranceMs;
    if (target <= 0 || tolerance < 0 || (value.actualBrewTimeMs != null && value.actualBrewTimeMs < 0)) throw new Error("invalid shot timing");
    if (value.reset != null && typeof value.reset !== "boolean") throw new Error("reset must be boolean");
    if (value.scope != null) scope(value.scope);
    ["taste", "flavour", "beanType", "roastLevel"].forEach((key) => { if (value[key] != null) text(value[key], "shots[" + index + "]." + key); });
    ["dose", "yield"].forEach((key) => { if (value[key] != null && !(Number.isFinite(value[key]) && value[key] > 0 && value[key] <= 1000)) throw new Error("shots[" + index + "]." + key + " must be positive"); });
    if (value.overall != null && !["under-extracted", "over-extracted", "balanced", "uncertain"].includes(value.overall)) throw new Error("overall must be an explicit supported assessment");
    if (value.taste != null && value.taste !== "none" && !TASTES.includes(value.taste)) throw new Error("shots[" + index + "].taste is unsupported");
    return { ...clone(value), taste: value.taste === "none" ? null : value.taste, targetBrewTimeMs: target, toleranceMs: tolerance };
  }
  function validateScenario(input) {
    keys(input, ["version", "scope", "initial", "targetBrewTimeMs", "toleranceMs", "bounds", "seed", "plant", "shots"], "scenario");
    if (input.version !== 1) throw new Error("scenario.version must be 1");
    const sc = scope(input.scope);
    keys(input.initial, ["settingDdDum"], "initial");
    integer(input.initial.settingDdDum, "initial.settingDdDum");
    const target = integer(input.targetBrewTimeMs, "targetBrewTimeMs");
    const tolerance = integer(input.toleranceMs, "toleranceMs");
    if (target <= 0 || tolerance < 0) throw new Error("invalid scenario timing");
    const b = bounds(input.bounds);
    if (input.initial.settingDdDum < b.minDdDum || input.initial.settingDdDum > b.maxDdDum) throw new Error("initial setting is outside bounds");
    if (!Array.isArray(input.shots) || input.shots.length > MAX_SHOTS) throw new Error("shots must contain at most 100 entries");
    const shots = input.shots.map((value, index) => shot(value, index, target, tolerance));
    if (input.plant != null) plantTime(input.plant, input.initial.settingDdDum, 0, seedValue(input.seed));
    return { version: 1, scope: sc, initial: { settingDdDum: input.initial.settingDdDum }, targetBrewTimeMs: target, toleranceMs: tolerance, bounds: b, seed: seedValue(input.seed), ...(input.plant ? { plant: clone(input.plant) } : {}), shots };
  }
  function stateOptions(algorithm, scenario) {
    if (algorithm === "DdEff") return { initialDdDum: scenario.initial.settingDdDum };
    if (algorithm === "GbS1") return { lastResultDum: scenario.initial.settingDdDum, continuousUm: scenario.initial.settingDdDum * 0.1, previousQuantizedUm: scenario.initial.settingDdDum * 0.1 };
    if (algorithm === "GbS2" || algorithm === "GbS3" || algorithm === "GbS4") return { lastResultDum: scenario.initial.settingDdDum, lastAdjustmentDum: scenario.initial.settingDdDum, lastTargetDum: scenario.initial.settingDdDum };
    return {};
  }
  function sameScope(a, b) { return SCOPE_KEYS.every((key) => (a[key] == null ? null : a[key]) === (b[key] == null ? null : b[key])); }
  function runOne(algorithm, scenario) {
    let state = null;
    let current = scenario.initial.settingDdDum;
    let previousScope = null;
    const trace = [];
    scenario.shots.forEach((planned, shotIndex) => {
      const shotScope = planned.scope == null ? scenario.scope : planned.scope;
      const scopeChanged = previousScope !== null && !sameScope(shotScope, previousScope);
      const reset = state == null || planned.reset === true || scopeChanged;
      if (reset) { state = research.createState(algorithm, stateOptions(algorithm, scenario)); current = scenario.initial.settingDdDum; }
      const setpoint = planned.setpointDdDum == null ? current : planned.setpointDdDum;
      const estimated = planned.estimatedDdDum == null ? setpoint : planned.estimatedDdDum;
      if (setpoint < scenario.bounds.minDdDum || setpoint > scenario.bounds.maxDdDum || estimated < scenario.bounds.minDdDum || estimated > scenario.bounds.maxDdDum) throw new Error("shot setting is outside bounds");
      const actual = planned.actualBrewTimeMs == null
        ? (scenario.plant ? plantTime(scenario.plant, setpoint, shotIndex, scenario.seed) : null)
        : planned.actualBrewTimeMs;
      if (actual == null) throw new Error("each shot needs actualBrewTimeMs or a synthetic plant");
      const input = { actualBrewTimeMs: actual, targetBrewTimeMs: planned.targetBrewTimeMs, toleranceMs: planned.toleranceMs, estimatedDdDum: estimated, setpointDdDum: setpoint };
      const raw = research.adjust(algorithm, state, input);
      state = raw.nextState;
      const applied = {
        candidateDdDum: clamp(raw.result.candidateDdDum, scenario.bounds),
        returnedDdDum: clamp(raw.result.returnedDdDum, scenario.bounds),
      };
      current = applied.returnedDdDum;
      previousScope = clone(shotScope);
      trace.push({ shotIndex, reset, scopeChanged, input: clone(input), output: clone(raw.result), applied, state: clone(state), scope: clone(shotScope), usedInputs: ["actualBrewTimeMs", "targetBrewTimeMs", "toleranceMs", "estimatedDdDum", "setpointDdDum"], ignoredInputs: ["beanType", "roastLevel", "taste", "flavour"].filter((key) => planned[key] != null), observation: { source: planned.actualBrewTimeMs == null ? "synthetic-plant" : "explicit" } });
    });
    return { algorithm, scope: clone(scenario.scope), shots: trace, finalSettingDdDum: current };
  }
  function run(input) {
    const scenario = validateScenario(input);
    return { scenario, algorithms: ALGORITHMS.map((algorithm) => runOne(algorithm, scenario)) };
  }
  function serialize(input) {
    const scenario = validateScenario(input);
    const value = JSON.stringify(scenario);
    if (value.length > MAX_JSON) throw new Error("scenario is too large");
    return value;
  }
  function deserialize(value) {
    if (typeof value !== "string" || value.length > MAX_JSON) throw new Error("serialized scenario is too large or not text");
    let parsed;
    try { parsed = JSON.parse(value); } catch (_) { throw new Error("serialized scenario is invalid JSON"); }
    return validateScenario(parsed);
  }
  async function replayRichSuggestions(pluginFactory, input, options) {
    if (typeof pluginFactory !== "function") throw new Error("plugin factory is required");
    const scenario = validateScenario(input);
    const o = options || {};
    const now = o.now == null ? Date.now() : o.now;
    if (!Number.isSafeInteger(now)) throw new Error("now must be a safe integer timestamp");
    const workflow = clone(o.workflow || {
      profile: { steps: [{ name: "Synthetic pressure extraction", pump: "pressure", pressure: 9, seconds: 30 }] },
      context: {
        beanBatchId: scenario.scope.beanBatchId,
        grinderId: scenario.scope.grinderId,
        grinderModel: scenario.scope.grinderId,
        grinderBurrs: scenario.scope.burrIdentity,
        targetDoseWeight: 18,
        targetYield: 36,
        grinderSetting: String(scenario.initial.settingDdDum),
        extras: { calibrationEpoch: scenario.scope.calibrationEpoch, beanType: "arabica", roastLevel: "medium", basket: "standard", grinderSettingUnit: "deci-micrometre" },
      },
    });
    const settings = clone(o.settings || {
      TargetTimeSec: String(scenario.targetBrewTimeMs / 1000), TargetTimeClock: "pump", TimeToleranceSec: String(scenario.toleranceMs / 1000), EvidenceMaxAgeDays: "14",
      CurrentSetting: String(scenario.initial.settingDdDum), SettingUnit: "deci-micrometre", StepSize: "1", NumericFinerDelta: "1", MinSetting: String(scenario.bounds.minDdDum), MaxSetting: String(scenario.bounds.maxDdDum), Dose: "18", Yield: "36",
      BeanBatchId: scenario.scope.beanBatchId, GrinderId: scenario.scope.grinderId, GrinderModel: scenario.scope.grinderId, BurrIdentity: scenario.scope.burrIdentity, CalibrationEpoch: scenario.scope.calibrationEpoch, BeanType: "arabica", RoastLevel: "medium", Basket: "standard",
    });
    const plannedShots = o.shots || scenario.shots;
    const records = plannedShots.map((planned, index) => {
      const id = String(planned.id || "simulation-shot-" + (index + 1));
      const stamp = new Date(now - (plannedShots.length - index) * 60000).toISOString();
      const shotWorkflow = clone(planned.workflow || workflow);
      const shotScope = planned.scope || scenario.scope;
      const extras = { ...(shotWorkflow.context?.extras || {}), calibrationEpoch: shotScope.calibrationEpoch, beanType: planned.beanType || shotWorkflow.context?.extras?.beanType || "arabica", roastLevel: planned.roastLevel || shotWorkflow.context?.extras?.roastLevel || "medium", grinderSettingUnit: shotWorkflow.context?.extras?.grinderSettingUnit || "deci-micrometre" };
      shotWorkflow.context = { ...shotWorkflow.context, beanBatchId: shotScope.beanBatchId, beanId: shotWorkflow.context?.beanId || (shotScope.beanBatchId ? shotScope.beanBatchId + ":bean" : null), grinderId: shotScope.grinderId, grinderModel: shotWorkflow.context?.grinderModel || shotScope.grinderId, grinderBurrs: shotScope.burrIdentity, targetDoseWeight: planned.dose == null ? (shotWorkflow.context?.targetDoseWeight || 18) : planned.dose, targetYield: planned.yield == null ? (shotWorkflow.context?.targetYield || 36) : planned.yield, extras, grinderSetting: String(planned.setpointDdDum == null ? scenario.initial.settingDdDum : planned.setpointDdDum) };
      const setting = planned.setpointDdDum == null ? scenario.initial.settingDdDum : planned.setpointDdDum;
      const observedTime = planned.actualBrewTimeMs == null && scenario.plant ? plantTime(scenario.plant, setting, index, scenario.seed) : (planned.actualBrewTimeMs == null ? null : planned.actualBrewTimeMs);
      if (observedTime == null) throw new Error("each shot needs actualBrewTimeMs or a synthetic plant; a target is not an observation");
      return { id, timestamp: stamp, workflow: shotWorkflow, actualBrewTimeMs: observedTime, measurements: [{ machine: { timestamp: new Date(Date.parse(stamp) + observedTime).toISOString() } }] };
    });
    const store = {};
    let activeWorkflow = workflow;
    let visibleRecords = [];
    let instance;
    const host = {
      log() {},
      storage(event) {
        if (event.type === "read") queueMicrotask(() => instance && instance.onEvent({ name: "storageRead", payload: { key: event.key, value: store[event.key] || null } }));
        if (event.type === "write") { store[event.key] = clone(event.data); queueMicrotask(() => instance && instance.onEvent({ name: "storageWrite", payload: { key: event.key } })); }
      },
    };
    const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(value) });
    const fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/v1/workflow") return response(activeWorkflow);
      if (path === "/api/v1/shots") return response({ items: visibleRecords, total: visibleRecords.length });
      const match = path.match(/^\/api\/v1\/shots\/([^/]+)$/);
      if (match) return response(visibleRecords.find((item) => item.id === decodeURIComponent(match[1])) || {}, visibleRecords.some((item) => item.id === decodeURIComponent(match[1])) ? 200 : 404);
      const batchMatch = path.match(/^\/api\/v1\/bean-batches\/([^/]+)$/);
      if (batchMatch) {
        const batchId = decodeURIComponent(batchMatch[1]);
        const context = activeWorkflow.context || {};
        if (batchId !== context.beanBatchId) return response({}, 404);
        const catalog = o.catalog?.batch || {};
        return response({ id: batchId, beanId: context.beanId, roastLevel: context.extras?.roastLevel, ...catalog });
      }
      const beanMatch = path.match(/^\/api\/v1\/beans\/([^/]+)$/);
      if (beanMatch) {
        const beanId = decodeURIComponent(beanMatch[1]);
        const context = activeWorkflow.context || {};
        if (beanId !== context.beanId) return response({}, 404);
        const catalog = o.catalog?.bean || {};
        return response({ id: beanId, name: "Synthetic bean", species: context.extras?.beanType || "Arabica", variety: [], processing: null, ...catalog });
      }
      return response({}, 404);
    };
    instance = pluginFactory(host, { fetch });
    if (!instance || typeof instance.onLoad !== "function" || typeof instance.handleHttpRequest !== "function") throw new Error("plugin factory returned an invalid plugin");
    instance.onLoad(settings);
    const suggestions = [];
    try {
      for (const [index, record] of records.entries()) {
        activeWorkflow = record.workflow;
        visibleRecords = records.slice(0, index + 1);
        const context = activeWorkflow.context || {};
        instance.onLoad({ ...settings, CurrentSetting: context.grinderSetting, BeanBatchId: context.beanBatchId, GrinderId: context.grinderId, GrinderModel: context.grinderModel, BurrIdentity: context.grinderBurrs, CalibrationEpoch: context.extras?.calibrationEpoch, BeanType: context.extras?.beanType, RoastLevel: context.extras?.roastLevel, Dose: String(context.targetDoseWeight), Yield: String(context.targetYield), SettingUnit: context.extras?.grinderSettingUnit });
        const planned = plannedShots[records.indexOf(record)] || {};
        const taste = planned.taste == null || planned.taste === "none" ? null : planned.taste;
        const flavour = planned.overall ? { overall: planned.overall } : null;
        const feedback = await instance.handleHttpRequest({ endpoint: "feedback", method: "POST", body: { shotId: record.id, good: false, taste, flavour, brewTimeSec: record.actualBrewTimeMs / 1000, brewTimeClock: "pump", notes: "Simulation input: synthetic or explicitly supplied pump duration, not a measured machine clock." } });
        if (feedback.status !== 200) throw new Error("simulated feedback was rejected");
        const suggestion = await instance.handleHttpRequest({ endpoint: "suggestion", method: "GET" });
        const suggestionBody = JSON.parse(suggestion.body);
        const catalogResponse = await instance.handleHttpRequest({ endpoint: "bean-context", method: "GET" });
        suggestions.push({ shotId: record.id, feedback: JSON.parse(feedback.body), suggestion: suggestionBody, beanContext: catalogResponse.status === 200 ? JSON.parse(catalogResponse.body) : null, stage: suggestionBody.stage || null, evidenceCount: Array.isArray(suggestionBody.evidence) ? suggestionBody.evidence.length : 0 });
      }
    } finally { if (typeof instance.onUnload === "function") instance.onUnload(); }
    return { scope: clone(scenario.scope), shots: records.map((record) => ({ id: record.id, timestamp: record.timestamp, actualBrewTimeMs: record.actualBrewTimeMs, workflow: clone(record.workflow) })), suggestions, storageIsolated: true, synthetic: true, disclaimer: "Suggestion results use the shipped plugin policy against synthetic records; they are not grinder measurements." };
  }
  return Object.freeze({ algorithms: ALGORITHMS.slice(), maxShots: MAX_SHOTS, validateScenario, run, replay: run, serialize, deserialize, replayRichSuggestions });
});
