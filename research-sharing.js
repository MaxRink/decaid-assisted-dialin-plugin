/* SPDX-License-Identifier: GPL-3.0-or-later */
// This factory has no imports: embed the same function in the browser/plugin bundle.
function createResearchSharing() {
  "use strict";
  const VERSION = 1, POLICY = 1, MAX_LOCAL = 200, MAX_QUEUE = 100, MAX_BATCH = 25;
  const enums = {
    source: ["website", "plugin"], mode: ["measured", "manual", "practice", "replay"],
    kind: ["shot", "feedback", "advice", "setting_change", "flow_summary"],
    model: ["E64 WS", "DF54", "DF64 Gen 1", "DF64 Gen 2", "EK43", "Lagom P64", "other", "unknown"],
    unit: ["micrometres", "dial-marks", "deci-micrometre", "unknown"],
    control: ["pressure", "mixed_preinfusion_flow", "flow", "mixed_dynamic_flow", "flow_preinfusion_only", "unknown"],
    clock: ["pump", "pouring", "recording", "unknown"],
    taste: ["balanced", "too_sour", "too_bitter", "too_astringent", "weak", "uneven_flow", "unknown"],
    overall: ["under-extracted", "over-extracted", "balanced", "uncertain"],
    direction: ["finer", "coarser", "none"],
    status: ["suggestion", "abstain", "retained", "invalid", "unavailable"],
    algorithm: ["manual", "native-response", "rich", "GbS1", "GbS2", "GbS3", "GbS4", "DdEff", "effectiveDd", "grindTime", "inverseRegression", "proposedDd"],
  };
  const object = value => value != null && typeof value === "object" && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const choice = (out, key, value, choices) => { if (choices.includes(value)) out[key] = value; };
  const numeric = (out, key, value, min, max) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max)
      out[key] = Math.round(value * 1000) / 1000;
  };
  const flag = (out, key, value) => { if (typeof value === "boolean") out[key] = value; };
  function sanitizeRecord(input) {
    if (!object(input)) throw new Error("Research record must be an object");
    const record = { schemaVersion: VERSION };
    for (const key of ["source", "mode", "kind"]) {
      if (!enums[key].includes(input[key])) throw new Error("Invalid research " + key);
      record[key] = input[key];
    }
    function part(key, build) {
      if (!object(input[key])) return;
      const out = {}; build(out, input[key]);
      if (Object.keys(out).length) record[key] = out;
    }
    part("grinder", (out, value) => {
      choice(out, "model", value.model, enums.model);
      choice(out, "settingUnit", value.settingUnit, enums.unit);
      numeric(out, "setting", value.setting, 0, 100000);
      numeric(out, "step", value.step, 0, 10000);
      choice(out, "finerSign", value.finerSign, [-1, 1]);
      numeric(out, "rpm", value.rpm, 0, 10000);
      numeric(out, "burrDiameterMm", value.burrDiameterMm, 20, 150);
      choice(out, "burrGeometry", value.burrGeometry, ["flat", "conical", "other", "unknown"]);
      flag(out, "ownerConfirmed", value.ownerConfirmed);
      // A number without its coordinate system is not useful research evidence.
      if (!out.settingUnit || out.settingUnit === "unknown") { delete out.setting; delete out.step; }
    });
    part("recipe", (out, value) => {
      choice(out, "controlMode", value.controlMode, enums.control);
      choice(out, "targetClock", value.targetClock, enums.clock);
      numeric(out, "targetTimeSec", value.targetTimeSec, 0.001, 600);
      numeric(out, "targetDoseG", value.targetDoseG, 0.001, 100);
      numeric(out, "targetYieldG", value.targetYieldG, 0.001, 300);
      numeric(out, "targetTemperatureC", value.targetTemperatureC, 0, 150);
      numeric(out, "targetPressureBar", value.targetPressureBar, 0, 15);
      numeric(out, "targetMachineFlowMlPerSec", value.targetMachineFlowMlPerSec, 0, 30);
    });
    part("measurements", (out, value) => {
      for (const key of ["pumpTimeSec", "pouringTimeSec", "recordingTimeSec", "preinfusionSec"])
        numeric(out, key, value[key], 0, 600);
      for (const key of ["pumpComplete", "pouringComplete", "manualStopConfirmed", "interrupted"])
        flag(out, key, value[key]);
      numeric(out, "doseG", value.doseG, 0.001, 100);
      numeric(out, "yieldG", value.yieldG, 0, 300);
      numeric(out, "meanPressureBar", value.meanPressureBar, 0, 15);
      numeric(out, "meanMachineFlowMlPerSec", value.meanMachineFlowMlPerSec, 0, 30);
      numeric(out, "meanBeverageFlowGPerSec", value.meanBeverageFlowGPerSec, 0, 30);
      numeric(out, "meanMixTemperatureC", value.meanMixTemperatureC, 0, 150);
      numeric(out, "meanGroupTemperatureC", value.meanGroupTemperatureC, 0, 150);
      numeric(out, "flowCoverageSec", value.flowCoverageSec, 0, 600);
      numeric(out, "excludedSampleCount", value.excludedSampleCount, 0, 20000);
    });
    part("coffee", (out, value) => {
      choice(out, "species", value.species, ["arabica", "robusta", "blend", "other", "unknown"]);
      choice(out, "roast", value.roast, ["light", "medium", "dark", "unknown"]);
      choice(out, "process", value.process, ["washed", "natural", "honey", "anaerobic", "other", "unknown"]);
      flag(out, "decaf", value.decaf);
      numeric(out, "daysAfterRoast", value.daysAfterRoast, 0, 365);
    });
    part("taste", (out, value) => {
      choice(out, "intent", value.intent, enums.taste);
      choice(out, "overall", value.overall, enums.overall);
      for (const key of ["acidity", "bitterness", "sweetness", "body", "astringency"])
        numeric(out, key, value[key], 0, 5);
      numeric(out, "tastingTemperatureC", value.tastingTemperatureC, 0, 150);
      numeric(out, "minutesAfterBrew", value.minutesAfterBrew, 0, 10080);
    });
    part("advice", (out, value) => {
      choice(out, "algorithm", value.algorithm, enums.algorithm);
      choice(out, "direction", value.direction, enums.direction);
      choice(out, "status", value.status, enums.status);
      choice(out, "settingUnit", value.settingUnit, enums.unit);
      numeric(out, "proposedSetting", value.proposedSetting, 0, 100000);
      numeric(out, "evidenceCount", value.evidenceCount, 0, 250);
      if (!out.settingUnit || out.settingUnit === "unknown") delete out.proposedSetting;
    });
    if (Object.keys(record).length === 4) throw new Error("No research measurements or categories supplied");
    return record;
  }
  function canonical(value) {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (object(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
    return JSON.stringify(value);
  }
  function validateRecord(value) {
    const record = sanitizeRecord(value);
    if (canonical(value) !== canonical(record)) throw new Error("Unknown, invalid or excessive-precision research fields");
    return record;
  }
  function validateBatch(value) {
    if (!object(value) || Object.keys(value).some(key => !["schemaVersion", "policyVersion", "records"].includes(key)) ||
        value.schemaVersion !== VERSION || value.policyVersion !== POLICY || !Array.isArray(value.records) ||
        !value.records.length || value.records.length > MAX_BATCH) throw new Error("Invalid research batch");
    return { schemaVersion: VERSION, policyVersion: POLICY, records: value.records.map(validateRecord) };
  }
  function endpoint(value) {
    // URL and AbortController are optional runtime adapters; the factory is QuickJS-safe.
    if (typeof value !== "string" || value.length > 2048 || !/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?(?:\/[a-z0-9._~!$&'()*+,;=:@%/-]*)?$/i.test(value))
      throw new Error("Research endpoint must be HTTPS without credentials, query or fragment");
    const authority = value.slice(8).split("/")[0], host = authority.split(":")[0];
    if (!host || host.startsWith(".") || host.endsWith(".") || host.includes("..") || /%|@/.test(authority))
      throw new Error("Invalid research endpoint host");
    return value;
  }
  function createClient(adapters) {
    if (!adapters || typeof adapters.load !== "function" || typeof adapters.save !== "function")
      throw new Error("Acknowledged local load/save adapters required");
    const fresh = () => ({ schemaVersion: VERSION, policyVersion: POLICY, localEnabled: true, sharing: false, endpoint: null,
      nextRevision: 0, records: [], queue: [] });
    const localKey = key => {
      if (typeof key !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(key)) throw new Error("Invalid local research key");
      return key;
    };
    const entry = value => {
      if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 1)
        throw new Error("Invalid local research entry");
      return { key: localKey(value.key), revision: value.revision, record: validateRecord(value.record) };
    };
    let state = fresh(), generation = 0, permitted = false, chain = Promise.resolve(), inflight = null, abort = null, storageError = null;
    const ready = Promise.resolve().then(() => adapters.load()).then(value => {
      if (value == null) return;
      if (!object(value) || value.schemaVersion !== VERSION || value.policyVersion !== POLICY ||
          typeof value.sharing !== "boolean" || typeof value.localEnabled !== "boolean" || !Number.isSafeInteger(value.nextRevision) || value.nextRevision < 0 ||
          !Array.isArray(value.records) || value.records.length > MAX_LOCAL ||
          !Array.isArray(value.queue) || value.queue.length > MAX_QUEUE) throw new Error("Invalid or outdated research storage");
      const records = value.records.map(entry), queue = value.queue.map(entry);
      for (const list of [records, queue]) {
        if (new Set(list.map(item => item.key)).size !== list.length || list.some(item => item.revision > value.nextRevision))
          throw new Error("Invalid local research revisions");
      }
      state = { schemaVersion: VERSION, policyVersion: POLICY, localEnabled: value.localEnabled, sharing: value.sharing,
        endpoint: value.endpoint == null ? null : endpoint(value.endpoint), nextRevision: value.nextRevision, records, queue };
      permitted = generation === 0 && state.sharing;
      if (!permitted) { state.sharing = false; state.queue = []; }
    }).catch(() => { state = fresh(); permitted = false; storageError = "Research storage could not be read; sharing is disabled"; });
    const serial = operation => { const result = chain.then(() => ready).then(operation); chain = result.catch(() => {}); return result; };
    async function save(next) {
      try { await adapters.save(clone(next)); state = next; storageError = null; }
      catch (_) { permitted = false; state.sharing = false; state.queue = []; generation++; abort?.(); storageError = "Research storage could not be saved; sharing is disabled"; throw new Error(storageError); }
    }
    const status = () => ({ localEnabled: state.localEnabled, sharing: permitted && state.sharing && !storageError, endpoint: state.endpoint,
      localCount: state.records.length, queuedCount: permitted ? state.queue.length : 0, error: storageError, policyVersion: POLICY });
    async function setSharing(enabled, target) {
      if (typeof enabled !== "boolean") throw new Error("Explicit sharing choice required");
      const targetEndpoint = enabled && target != null && target !== "" ? endpoint(target) : null;
      // Revoke immediately, before waiting for disk or an earlier network request.
      const requestGeneration = ++generation;
      permitted = false; abort?.();
      return serial(async () => {
        const current = requestGeneration === generation;
        await save({ ...state, sharing: current && enabled, endpoint: current ? targetEndpoint : null, queue: [] });
        permitted = current && requestGeneration === generation && enabled;
        return status();
      });
    }
    function capture(input, key) {
      const record = sanitizeRecord(input);
      if (key != null) localKey(key);
      return serial(async () => {
        if (storageError) throw new Error(storageError);
        const revision = state.nextRevision + 1;
        if (!Number.isSafeInteger(revision)) throw new Error("Local research revision limit reached; export and clear");
        const item = { key: key == null ? "entry:" + revision : key, revision, record };
        const replace = list => list.filter(prior => prior.key !== item.key).concat([item]);
        let queue = state.queue;
        if (permitted && state.sharing && (queue.length < MAX_QUEUE || queue.some(prior => prior.key === item.key))) queue = replace(queue);
        await save({ ...state, records: state.localEnabled ? replace(state.records).slice(-MAX_LOCAL) : state.records, queue, nextRevision: revision });
        return { record: clone(record), ...status() };
      });
    }
    async function flush() {
      if (inflight) return inflight;
      const operation = async () => {
        const batch = await serial(() => {
          if (!permitted || !state.sharing || storageError || !state.queue.length || !state.endpoint) return null;
          if (typeof adapters.send !== "function") throw new Error("Research transport unavailable");
          return { generation, endpoint: state.endpoint, entries: clone(state.queue.slice(0, MAX_BATCH)) };
        });
        if (!batch) return { sent: 0, ...status() };
        if (batch.generation !== generation || !permitted) return { sent: 0, ...status() };
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        abort = () => controller?.abort();
        try {
          const response = await adapters.send(batch.endpoint, { method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
            headers: { "Content-Type": "application/json" }, signal: controller?.signal,
            body: JSON.stringify({ schemaVersion: VERSION, policyVersion: POLICY, records: batch.entries.map(item => item.record) }) });
          if (!response || !response.ok || response.redirected) throw new Error("Research upload was not acknowledged");
          const receipt = await response.json();
          if (!receipt || receipt.accepted !== batch.entries.length) throw new Error("Invalid research upload acknowledgment");
          return await serial(async () => {
            if (batch.generation !== generation || !permitted) return { sent: 0, ...status() };
            const acknowledged = new Set(batch.entries.map(item => item.revision));
            await save({ ...state, queue: state.queue.filter(item => !acknowledged.has(item.revision)) });
            return { sent: batch.entries.length, ...status() };
          });
        } finally { abort = null; }
      };
      inflight = operation();
      try { return await inflight; } finally { inflight = null; }
    }
    function setLocalCollection(enabled) {
      if (typeof enabled !== "boolean") throw new Error("Explicit local collection choice required");
      return serial(async () => { await save({ ...state, localEnabled: enabled }); return status(); });
    }
    function clear() {
      generation++; permitted = false; abort?.();
      return serial(async () => { await save({ ...fresh(), localEnabled: state.localEnabled }); return status(); });
    }
    return { ready: ready.then(status), status: () => serial(status), capture, append: input => capture(input), setSharing, setLocalCollection, flush, clear,
      exportLocal: () => serial(() => ({ schemaVersion: VERSION, policyVersion: POLICY, records: state.records.map(item => clone(item.record)) })) };
  }
  return { schemaVersion: VERSION, policyVersion: POLICY, limits: { local: MAX_LOCAL, queue: MAX_QUEUE, batch: MAX_BATCH },
    sanitizeRecord, validateRecord, validateBatch, validateEndpoint: endpoint, createClient };
}
if (typeof module !== "undefined" && module.exports) module.exports = { createResearchSharing };
