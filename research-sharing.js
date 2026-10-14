/* SPDX-License-Identifier: GPL-3.0-or-later */
// This factory has no imports: embed the same function in the browser/plugin bundle.
function createResearchSharing() {
  "use strict";
  const VERSION = 1, POLICY = 1, MAX_LOCAL = 200, MAX_QUEUE = 100, MAX_BATCH = 25;
  const enums = {
    source: ["website", "plugin"], mode: ["measured", "manual", "practice", "replay"],
    kind: ["shot", "feedback", "advice", "setting_change", "flow_summary"],
    model: ["E64 WS", "E65S GbW", "E80S GbW", "DF54", "DF64 Gen 1", "DF64 Gen 2", "Niche Zero", "Baratza Encore ESP", "Timemore Sculptor 064S", "Timemore Sculptor 078S", "LAGOM 01", "LAGOM P64", "1Zpresso X-Pro", "1Zpresso J-Max", "1Zpresso K series", "Fellow Ode Gen 2", "EK43", "other", "unknown"],
    unit: ["micrometres", "dial-marks", "deci-micrometre", "clicks", "total-clicks", "numbered-settings", "micro-ticks", "printed-decimal", "dial-positions", "µm", "µm (DDD readout only)", "dial marks", "numbered settings", "dial micro-ticks", "clicks from zero", "dial positions", "unknown"],
    control: ["pressure", "mixed_preinfusion_flow", "flow", "mixed_dynamic_flow", "flow_preinfusion_only", "unknown"],
    clock: ["pump", "pouring", "recording", "unknown"],
    taste: ["balanced", "too_sour", "too_bitter", "too_astringent", "weak", "uneven_flow", "unknown"],
    overall: ["under-extracted", "over-extracted", "balanced", "uncertain"],
    direction: ["finer", "coarser", "none"],
    status: ["suggestion", "abstain", "retained", "hold", "collecting", "computed", "invalid", "unavailable"],
    algorithm: ["manual", "native-response", "rich", "GbS1", "GbS2", "GbS3", "GbS4", "DdEff", "effectiveDd", "grindTime", "inverseRegression", "proposedDd"],
  };
  const object = value => value != null && typeof value === "object" && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const canonicalUnit = value => ["decimal dial numbers", "printed numbers"].includes(value) ? "printed-decimal" : value;
  const choice = (out, key, value, choices) => { if (choices.includes(value)) out[key] = value; };
  const numeric = (out, key, value, min, max) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max)
      out[key] = Math.round(value * 1000) / 1000;
  };
  const flag = (out, key, value) => { if (typeof value === "boolean") out[key] = value; };
  const validId = value => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
  function randomId() {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
      return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    }
    // Record keys are not secrets or authentication tokens. No personal input is used.
    return Array.from({ length: 4 }, () => Math.floor(Math.random() * 4294967296).toString(16).padStart(8, "0")).join("");
  }
  function sanitizeRecord(input) {
    if (!object(input)) throw new Error("Research record must be an object");
    const record = { schemaVersion: VERSION };
    for (const key of ["source", "mode", "kind"]) {
      if (!enums[key].includes(input[key])) throw new Error("Invalid research " + key);
      record[key] = input[key];
    }
    if (validId(input.observationId) && Number.isSafeInteger(input.revision) && input.revision > 0) {
      record.observationId = input.observationId; record.revision = input.revision;
    }
    if (validId(input.researchSeries)) record.researchSeries = input.researchSeries;
    if (record.researchSeries && Number.isInteger(input.shotOrdinal) && input.shotOrdinal >= 1 && input.shotOrdinal <= 10000) record.shotOrdinal = input.shotOrdinal;
    function part(key, build) {
      if (!object(input[key])) return;
      const out = {}; build(out, input[key]);
      if (Object.keys(out).length) record[key] = out;
    }
    part("grinder", (out, value) => {
      choice(out, "model", value.model, enums.model);
      choice(out, "settingUnit", canonicalUnit(value.settingUnit), enums.unit);
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
      choice(out, "profileFamily", value.profileFamily, ["traditional", "flow", "bloom", "turbo", "allonge", "adaptive", "unknown"]);
      choice(out, "preinfusionSource", value.preinfusionSource, ["recorded", "owner_entered", "programmed", "synthetic", "unknown"]);
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
      flag(out, "good", value.good);
      choice(out, "intent", value.intent, enums.taste);
      choice(out, "overall", value.overall, enums.overall);
      for (const key of ["acidity", "bitterness", "sweetness", "body", "astringency"])
        numeric(out, key, value[key], 0, 5);
      numeric(out, "tastingTemperatureC", value.tastingTemperatureC, 0, 150);
      numeric(out, "minutesAfterBrew", value.minutesAfterBrew, 0, 10080);
    });
    const advice = (out, value) => {
      choice(out, "algorithm", value.algorithm, enums.algorithm);
      choice(out, "coordinateStatus", value.coordinateStatus, ["native", "measured", "estimated_relative", "estimated_absolute", "unknown"]);
      choice(out, "direction", value.direction, enums.direction);
      choice(out, "status", value.status, enums.status);
      choice(out, "settingUnit", canonicalUnit(value.settingUnit), enums.unit);
      numeric(out, "proposedSetting", value.proposedSetting, 0, 100000);
      numeric(out, "evidenceCount", value.evidenceCount, 0, 250);
      if (!out.settingUnit || out.settingUnit === "unknown") delete out.proposedSetting;
    };
    part("advice", advice);
    if (Array.isArray(input.approaches)) {
      const approaches = input.approaches.slice(0, 11).filter(object).map(value => { const out = {}; advice(out, value); return out; }).filter(value => value.algorithm);
      if (approaches.length) record.approaches = approaches;
    }
    if (Array.isArray(input.phases)) {
      const phases = input.phases.slice(0, 12).filter(object).map(value => {
        const out = {};
        choice(out, "role", value.role, ["preinfusion", "extraction", "decline", "bloom", "outside_pump", "unknown"]);
        choice(out, "source", value.source, ["recorded_frame", "recorded_substate", "recorded_annotation", "owner_entered", "programmed_target", "synthetic", "unknown"]);
        choice(out, "control", value.control, ["pressure", "flow", "unknown"]);
        for (const key of ["startSec", "endSec", "durationSec", "coverageSec"]) numeric(out, key, value[key], 0, 600);
        for (const key of ["meanPressureBar", "targetPressureBar"]) numeric(out, key, value[key], 0, 15);
        for (const key of ["meanMachineFlowMlPerSec", "targetMachineFlowMlPerSec", "meanBeverageFlowGPerSec"]) numeric(out, key, value[key], 0, 30);
        numeric(out, "meanTemperatureC", value.meanTemperatureC, 0, 150);
        return out;
      }).filter(value => Object.keys(value).length);
      if (phases.length) record.phases = phases;
    }
    if (!Object.keys(record).some(key => ["grinder", "recipe", "measurements", "coffee", "taste", "advice", "approaches", "phases"].includes(key))) throw new Error("No research measurements or categories supplied");
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
    return { schemaVersion: VERSION, policyVersion: POLICY, records: value.records.map(record => { const clean = validateRecord(record); if (!validId(clean.observationId) || !clean.revision) throw new Error("Observation identity required for upload"); return clean; }) };
  }
  function endpoint(value) {
    // URL and AbortController are optional runtime adapters; the factory is QuickJS-safe.
    if (typeof value !== "string" || value.length > 2048 || !/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?(?:\/[a-z0-9._~!$&'()*+,;=:@%/-]*)?$/i.test(value))
      throw new Error("Research endpoint must be HTTPS without credentials, query or fragment");
    const authority = value.slice(8).split("/")[0], host = authority.split(":")[0];
    if (!host || host.startsWith(".") || host.endsWith(".") || host.includes("..") || /%|@/.test(authority))
      throw new Error("Invalid research endpoint host");
    const port = authority.split(":")[1];
    if (port != null && (+port < 1 || +port > 65535)) throw new Error("Invalid research endpoint port");
    return value;
  }
  function observationContent(record) { const out = { ...record }; delete out.observationId; delete out.revision; return out; }
  // Non-security fingerprint used only for bounded local duplicate suppression.
  function fingerprint(value) {
    const text = canonical(value); let a = 2166136261, b = 5381;
    for (let n = 0; n < text.length; n++) { a = Math.imul(a ^ text.charCodeAt(n), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(n); }
    return text.length + ":" + (a >>> 0).toString(16) + ":" + (b >>> 0).toString(16);
  }
  function createClient(adapters) {
    if (!adapters || typeof adapters.load !== "function" || typeof adapters.save !== "function")
      throw new Error("Acknowledged local load/save adapters required");
    const fresh = () => ({ schemaVersion: VERSION, policyVersion: POLICY, localEnabled: true, sharing: false, endpoint: null,
      nextRevision: 0, records: [], queue: [], fingerprints: [] });
    const localKey = key => {
      if (typeof key !== "string" || !key.length || key.length > 256) throw new Error("Invalid local research key");
      return key;
    };
    const entry = value => {
      if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 1)
        throw new Error("Invalid local research entry");
      return { key: localKey(value.key), revision: value.revision, record: validateRecord(value.record) };
    };
    let state = fresh(), generation = 0, permitted = false, pendingConsent = null, chain = Promise.resolve(), inflight = null, abort = null, storageError = null;
    const decode = value => {
      if (value == null) return;
      if (!object(value) || value.schemaVersion !== VERSION || value.policyVersion !== POLICY ||
          typeof value.sharing !== "boolean" || typeof value.localEnabled !== "boolean" || !Number.isSafeInteger(value.nextRevision) || value.nextRevision < 0 ||
          !Array.isArray(value.records) || value.records.length > MAX_LOCAL ||
          !Array.isArray(value.queue) || value.queue.length > MAX_QUEUE || !Array.isArray(value.fingerprints) || value.fingerprints.length > MAX_LOCAL) throw new Error("Invalid or outdated research storage");
      const records = value.records.map(entry), queue = value.queue.map(entry);
      for (const list of [records, queue]) {
        if (new Set(list.map(item => item.key)).size !== list.length || list.some(item => item.revision > value.nextRevision))
          throw new Error("Invalid local research revisions");
      }
      const fingerprints = value.fingerprints.map(item => {
        if (!object(item) || typeof item.fingerprint !== "string" || !/^\d+:[a-f0-9]+:[a-f0-9]+$/.test(item.fingerprint)) throw new Error("Invalid local research fingerprint");
        if (!validId(item.observationId) || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error("Invalid observation ledger");
        return { key: localKey(item.key), fingerprint: item.fingerprint, observationId: item.observationId, revision: item.revision };
      });
      return { schemaVersion: VERSION, policyVersion: POLICY, localEnabled: value.localEnabled, sharing: value.sharing,
        endpoint: value.endpoint == null ? null : endpoint(value.endpoint), nextRevision: value.nextRevision, records, queue, fingerprints };
    };
    const updatePermission = () => { permitted = state.sharing && pendingConsent === null && !storageError; };
    const install = value => { state = decode(value) || fresh(); updatePermission(); };
    const ready = Promise.resolve().then(() => adapters.load()).then(install).catch(() => { state = fresh(); permitted = false; storageError = "Research storage could not be read; sharing is disabled"; });
    const refresh = async () => {
      if (typeof adapters.reload !== "function") return;
      try { install(await adapters.reload()); }
      catch (_) { permitted = false; abort?.(); storageError = "Research storage could not be read; sharing is disabled"; throw new Error(storageError); }
    };
    const serial = operation => {
      const result = chain.then(() => ready).then(() => {
        const run = async () => { await refresh(); return operation(); };
        return typeof adapters.withLock === "function" ? adapters.withLock(run) : run();
      });
      chain = result.catch(() => {}); return result;
    };
    async function save(next, resetError = false) {
      try { await adapters.save(clone(next)); state = next; if (resetError) storageError = null; updatePermission(); }
      catch (_) { permitted = false; abort?.(); storageError = "Research storage could not be saved; sharing is disabled"; throw new Error(storageError); }
    }
    const status = () => ({ localEnabled: state.localEnabled, sharing: permitted && state.sharing && !storageError, endpoint: state.endpoint,
      localCount: state.records.length, queuedCount: permitted ? state.queue.length : 0, error: storageError, policyVersion: POLICY });
    async function setSharing(enabled, target) {
      if (typeof enabled !== "boolean") throw new Error("Explicit sharing choice required");
      const targetEndpoint = enabled && target != null && target !== "" ? endpoint(target) : null;
      // Revoke immediately, before waiting for disk or an earlier network request.
      const requestGeneration = ++generation;
      pendingConsent = requestGeneration; permitted = false; abort?.();
      return serial(async () => {
        if (requestGeneration !== generation) return status();
        await save({ ...state, sharing: enabled, endpoint: targetEndpoint, queue: [], fingerprints: [] }, true);
        if (requestGeneration === generation) pendingConsent = null;
        updatePermission();
        return status();
      });
    }
    function capture(input, key) {
      const record = sanitizeRecord(observationContent(input));
      if (key != null) localKey(key);
      return serial(async () => {
        if (storageError) throw new Error(storageError);
        if (!state.localEnabled && !permitted) return { record: clone(record), ...status() };
        const digest = fingerprint(record);
        const queued = key == null ? null : state.queue.find(item => item.key === key);
        const known = key == null ? [] : state.records.filter(item => item.key === key).concat(queued ? [queued] : []);
        const ledger = key == null ? null : state.fingerprints.find(item => item.key === key);
        // The archive can intentionally stop changing while transport state and
        // its fingerprint ledger continue to advance (for example when local
        // collection is switched off). Always carry identity/revision forward
        // from the newest known observation, rather than preferring the archive.
        const prior = known.reduce((latest, item) => !latest || item.record.revision > latest.record.revision ||
          item.record.revision === latest.record.revision && item.revision > latest.revision ? item : latest, null);
        const latestRevision = Math.max(prior?.record.revision || 0, ledger?.revision || 0);
        const latestObservationId = ledger && ledger.revision >= (prior?.record.revision || 0) ? ledger.observationId : prior?.record.observationId;
        // An archive retained while collection was off can predate a correction
        // whose transport ledger was deleted or evicted.
        const duplicate = permitted ? queued : prior;
        if (duplicate && duplicate.record.revision === latestRevision && canonical(observationContent(duplicate.record)) === canonical(record) ||
          ledger && ledger.revision === latestRevision && ledger.fingerprint === digest)
          return { record: clone(record), ...status() };
        const revision = state.nextRevision + 1;
        if (!Number.isSafeInteger(revision)) throw new Error("Local research revision limit reached; export and clear");
        const observationId = latestObservationId || (typeof adapters.randomId === "function" ? adapters.randomId() : randomId());
        if (!validId(observationId)) throw new Error("Random observation key must contain 32 lowercase hexadecimal characters");
        const observationRevision = Math.max(latestRevision, state.nextRevision) + 1;
        const item = { key: key == null ? "entry:" + revision : key, revision, record: { ...record, observationId, revision: observationRevision } };
        const replace = list => list.filter(prior => prior.key !== item.key).concat([item]);
        let queue = state.queue;
        if (permitted && state.sharing && (queue.length < MAX_QUEUE || queue.some(prior => prior.key === item.key))) queue = replace(queue);
        const fingerprints = permitted ? state.fingerprints.filter(prior => prior.key !== item.key).concat([{ key: item.key, fingerprint: digest, observationId, revision: observationRevision }]).slice(-MAX_LOCAL) : [];
        await save({ ...state, fingerprints, records: state.localEnabled ? replace(state.records).slice(-MAX_LOCAL) : state.records, queue, nextRevision: revision });
        return { record: clone(record), ...status() };
      });
    }
    async function flush() {
      if (inflight) return inflight;
      const operation = async () => {
        const batch = await serial(() => {
          if (!permitted || !state.sharing || storageError || !state.queue.length || !state.endpoint) return null;
          if (typeof adapters.send !== "function") throw new Error("Research transport unavailable");
          const entries = [];
          for (const item of state.queue.slice(0, MAX_BATCH)) {
            if (JSON.stringify(entries.concat([item]).map(entry => entry.record)).length > 60000) break;
            entries.push(item);
          }
          const controller = typeof AbortController === "function" ? new AbortController() : null;
          abort = () => controller?.abort();
          // Start the request before releasing the storage lock. Awaiting it must
          // not block another tab's deletion, opt-out, or new observation.
          const response = adapters.send(state.endpoint, { method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
            headers: { "Content-Type": "application/json" }, signal: controller?.signal,
            body: JSON.stringify({ schemaVersion: VERSION, policyVersion: POLICY, records: entries.map(item => item.record) }) });
          return { generation, endpoint: state.endpoint, entries: clone(entries), response: Promise.resolve(response).then(value => ({ value }), error => ({ error })) };
        });
        if (!batch) return { sent: 0, ...status() };
        try {
          const result = await batch.response;
          if (result.error) throw result.error;
          const response = result.value;
          if (!response || !response.ok || response.redirected) throw new Error("Research upload was not acknowledged");
          const receipt = await response.json();
          if (!receipt || receipt.accepted !== batch.entries.length) throw new Error("Invalid research upload acknowledgment");
          return await serial(async () => {
            if (batch.generation !== generation || !permitted || state.endpoint !== batch.endpoint) return { sent: 0, ...status() };
            const identity = item => item.record.observationId + ":" + item.record.revision + ":" + item.revision;
            const acknowledged = new Set(batch.entries.map(identity));
            const queue = state.queue.filter(item => !acknowledged.has(identity(item)));
            if (queue.length !== state.queue.length) await save({ ...state, queue });
            return { sent: batch.entries.length, ...status() };
          });
        } finally { abort = null; }
      };
      inflight = operation();
      try { return await inflight; } finally { inflight = null; }
    }
    function setLocalCollection(enabled) {
      if (typeof enabled !== "boolean") throw new Error("Explicit local collection choice required");
      return serial(async () => { await save({ ...state, localEnabled: enabled, fingerprints: enabled || permitted ? state.fingerprints : [] }); return status(); });
    }
    function clear() {
      const requestGeneration = ++generation;
      pendingConsent = requestGeneration; permitted = false; abort?.();
      return serial(async () => {
        await save({ ...fresh(), localEnabled: state.localEnabled }, true);
        if (requestGeneration === generation) pendingConsent = null;
        updatePermission();
        return status();
      });
    }
    return { ready: ready.then(status), status: () => serial(status), capture, append: input => capture(input), setSharing, setLocalCollection, flush, clear,
      exportLocal: () => serial(() => ({ schemaVersion: VERSION, policyVersion: POLICY, records: state.records.map(item => clone(item.record)) })) };
  }
  return { schemaVersion: VERSION, policyVersion: POLICY, limits: { local: MAX_LOCAL, queue: MAX_QUEUE, batch: MAX_BATCH },
    sanitizeRecord, validateRecord, validateBatch, validateEndpoint: endpoint, randomId, createClient };
}
if (typeof module !== "undefined" && module.exports) module.exports = { createResearchSharing };
