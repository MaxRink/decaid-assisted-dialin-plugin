function createPlugin(host) {
  "use strict";

  const ID = "assisted-dialin.reaplugin";
  const API_BASE = "http://127.0.0.1:8080";
  const STORAGE_KEY = "feedback.v1";
  const MAX_PAGES = 5;
  const PAGE_SIZE = 50;
  let feedback = Object.create(null);
  let settings = {};
  let storageReady = false;
  let storageUnavailable = false;
  let storageWaiters = [];
  let storageWriteWaiters = [];
  let storageWriteBroken = false;
  let feedbackQueue = Promise.resolve();
  let active = false;
  let sessionEpoch = 0;
  let cachedShots = null;
  let cachedAt = 0;
  let cacheGeneration = 0;

  const json = (status, value) => ({status, headers: {"Content-Type": "application/json"}, body: JSON.stringify(value)});
  const html = (status, value) => ({status, headers: {"Content-Type": "text/html; charset=utf-8"}, body: value});

  function log(message) { try { host.log(`[dialin] ${message}`); } catch (_) {} }
  function bodyOf(request) {
    if (request && request.body && typeof request.body === "object") return request.body;
    if (typeof request?.body !== "string" || request.body.length === 0) return {};
    try { return JSON.parse(request.body); } catch (_) { return {}; }
  }
  function value(value, fallback) { return value === undefined || value === null || value === "" ? fallback : value; }
  function numberOrNull(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
  function textOrNull(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
  function feedbackFromStorage(value) {
    if (value == null) return Object.create(null);
    if (typeof value !== "object" || Array.isArray(value)) return null;
    const result = Object.create(null);
    for (const key of Object.keys(value)) {
      if (!key || key.length > 256 || !value[key] || typeof value[key] !== "object" || Array.isArray(value[key]) || value[key].good !== true) return null;
      result[key] = {good: true, notes: textOrNull(value[key].notes)?.slice(0, 512) || null, updatedAt: textOrNull(value[key].updatedAt)?.slice(0, 64) || null};
    }
    return result;
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      const result = Object.create(null);
      Object.keys(value).sort().forEach((key) => { result[key] = canonical(value[key]); });
      return result;
    }
    return value;
  }
  function profileContent(profile) {
    if (!profile || !Array.isArray(profile.steps) || profile.steps.length === 0) return null;
    const fields = ["beverage_type", "steps", "tank_temperature", "target_weight", "target_volume", "target_volume_count_start", "legacy_profile_type", "type", "version"];
    const content = Object.create(null);
    fields.forEach((key) => { if (profile[key] !== undefined) content[key] = profile[key]; });
    return JSON.stringify(canonical(content));
  }

  function contextOf(shot, useSettings) {
    const workflow = shot?.workflow || {};
    const context = workflow.context || {};
    const extras = context.extras || {};
    const profile = workflow.profile || {};
    return {
      beanBatchId: textOrNull(useSettings ? value(context.beanBatchId, settings.BeanBatchId) : context.beanBatchId),
      grinderId: textOrNull(useSettings ? value(context.grinderId, settings.GrinderId) : context.grinderId),
      grinderModel: textOrNull(useSettings ? value(context.grinderModel, settings.GrinderModel) : context.grinderModel),
      burrIdentity: textOrNull(useSettings ? value(context.grinderBurrs, value(extras.burrIdentity, settings.BurrIdentity)) : value(context.grinderBurrs, extras.burrIdentity)),
      calibrationEpoch: textOrNull(useSettings ? value(extras.calibrationEpoch, settings.CalibrationEpoch) : extras.calibrationEpoch),
      dose: numberOrNull(useSettings ? value(context.targetDoseWeight, numberOrNull(settings.Dose)) : context.targetDoseWeight),
      yield: numberOrNull(useSettings ? value(context.targetYield, numberOrNull(settings.Yield)) : context.targetYield),
      basket: textOrNull(useSettings ? value(extras.basket, settings.Basket) : extras.basket),
      profile: profileContent(profile),
      grinderSetting: textOrNull(context.grinderSetting),
    };
  }

  function compare(current, candidate) {
    const missing = [];
    const mismatched = [];
    const unavailable = [];
    ["beanBatchId", "grinderId", "grinderModel", "burrIdentity", "calibrationEpoch", "dose", "yield", "basket", "profile"].forEach((key) => {
      const a = current[key];
      const b = candidate[key];
      if (a === null && b === null) { unavailable.push(key); return; }
      if (a === null || b === null) { missing.push(key); return; }
      if (String(a) !== String(b)) mismatched.push(key);
    });
    return {ok: missing.length === 0 && mismatched.length === 0, missing, mismatched, unavailable};
  }

  async function loadStorage() {
    if (!active || storageUnavailable) throw new Error("feedback storage unavailable");
    if (storageReady) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { storageUnavailable = true; storageWaiters = storageWaiters.filter((entry) => entry !== waiter); reject(new Error("feedback storage timed out")); }, 5000);
      const waiter = {resolve: () => { clearTimeout(timer); resolve(); }, reject: (error) => { clearTimeout(timer); reject(error); }};
      storageWaiters.push(waiter);
    });
    if (!active || storageUnavailable) throw new Error("feedback storage unavailable");
  }
  function persist() {
    return new Promise((resolve, reject) => {
      if (!active || storageWriteBroken) { reject(new Error("feedback storage unavailable")); return; }
      const waiter = {resolve, reject};
      storageWriteWaiters.push(waiter);
      const timeout = setTimeout(() => { storageWriteBroken = true; storageWriteWaiters = storageWriteWaiters.filter((entry) => entry !== waiter); reject(new Error("feedback storage timed out")); }, 5000);
      waiter.resolve = () => { clearTimeout(timeout); resolve(); };
      waiter.reject = (error) => { clearTimeout(timeout); reject(error); };
      try { host.storage({type: "write", key: STORAGE_KEY, data: feedback}); } catch (error) { clearTimeout(timeout); storageWriteWaiters = storageWriteWaiters.filter((entry) => entry !== waiter); reject(new Error("feedback storage unavailable")); }
    });
  }
  function startStorage() {
    try { host.storage({type: "read", key: STORAGE_KEY}); } catch (_) { storageUnavailable = true; storageWaiters.splice(0).forEach((waiter) => waiter.reject(new Error("feedback storage unavailable"))); }
  }

  async function fetchShots() {
    if (cachedShots && Date.now() - cachedAt < 5000) return cachedShots;
    const result = [];
    const requestGeneration = cacheGeneration;
    let truncated = true;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await fetch(`${API_BASE}/api/v1/shots?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&order=desc`);
      if (!response.ok) throw new Error(`Shot history unavailable (HTTP ${response.status})`);
      const data = await response.json();
      const plainArray = Array.isArray(data);
      if (!plainArray && (!data || !Array.isArray(data.items))) throw new Error("invalid shot history");
      const items = plainArray ? data : data.items;
      if (items.length > PAGE_SIZE) throw new Error("shot page exceeds limit");
      result.push(...items);
      const total = !plainArray && Number.isFinite(Number(data.total)) ? Number(data.total) : null;
      if (items.length < PAGE_SIZE || (total !== null && result.length >= total)) { truncated = false; break; }
    }
    const snapshot = {items: result, truncated};
    if (!active) throw new Error("plugin unloaded");
    if (requestGeneration !== cacheGeneration) throw new Error("shot history changed");
    if (requestGeneration === cacheGeneration) cachedShots = snapshot;
    cachedAt = Date.now();
    return snapshot;
  }

  async function recommendation() {
    const requestEpoch = cacheGeneration;
    await loadStorage();
    await feedbackQueue;
    const history = await fetchShots();
    const shots = history.items;
    const workflowResponse = await fetch(`${API_BASE}/api/v1/workflow`);
    if (!workflowResponse.ok) throw new Error("workflow unavailable");
    const workflow = await workflowResponse.json();
    if (!workflow || typeof workflow !== "object" || !workflow.profile || !workflow.context) throw new Error("invalid workflow");
    const recordedCurrent = contextOf({workflow}, false);
    const current = contextOf({workflow}, true);
    const userSuppliedCurrentFields = Object.keys(current).filter((key) => recordedCurrent[key] === null && current[key] !== null);
    if (requestEpoch !== cacheGeneration || !active) throw new Error("history changed during recommendation");
    const missingCurrent = ["beanBatchId", "grinderId", "profile"].filter((key) => current[key] === null);
    if (missingCurrent.length) return {status: "abstain", reason: "Current bean batch, grinder identity and profile execution content are required", missingData: missingCurrent, historyTruncated: history.truncated};
    const considered = [];
    const abstentions = [];
    for (const shot of shots) {
      const mark = feedback[String(shot.id)];
      if (!mark?.good) continue;
      const candidate = contextOf(shot, false);
      if (!candidate.profile) { abstentions.push({shotId: shot.id, missing: ["profile"]}); continue; }
      if (!candidate.grinderSetting) { abstentions.push({shotId: shot.id, reason: "good shot has no recorded grinder setting"}); continue; }
      const result = compare(current, candidate);
      if (result.ok) considered.push({shot, candidate, mark, unavailable: result.unavailable});
      else abstentions.push({shotId: shot.id, missing: result.missing, mismatched: result.mismatched});
    }
    considered.sort((a, b) => String(b.shot.timestamp || "").localeCompare(String(a.shot.timestamp || "")));
    if (!considered.length) return {status: "abstain", reason: history.truncated ? "Bounded history scan reached its limit; no safe recommendation can be claimed" : "No comparable marked-good shot found", missingData: abstentions.slice(0, 10), historyTruncated: history.truncated};
    const selected = considered[0];
    return {
      status: "recommendation",
      sourceShotId: selected.shot.id,
      grinderSetting: selected.candidate.grinderSetting,
      recordedValue: true,
      comparison: {
        beanBatchId: current.beanBatchId, grinderId: current.grinderId,
        grinderModel: current.grinderModel, burrIdentity: current.burrIdentity,
        calibrationEpoch: current.calibrationEpoch, dose: current.dose,
        yield: current.yield, basket: current.basket,
        profile: "matching execution content", userSuppliedCurrentFields,
      },
      provenance: "user-marked-good local shot; workflow setting is intended, not verified hardware state",
      notes: selected.mark.notes || null,
      timestamp: selected.shot.timestamp || null,
      warnings: (selected.unavailable.length ? [`Comparison fields unavailable in both current setup and shot: ${selected.unavailable.join(", ")}`] : []).concat(history.truncated ? ["History scan is bounded; older shots were not considered"] : []),
    };
  }

  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Assisted dial-in</title><style>body{font:16px system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem}button{font:inherit;padding:.6rem}input{font:inherit;padding:.5rem}output{display:block;margin-top:1rem;white-space:pre-wrap}</style><h1>Assisted dial-in</h1><p>This assistant only recommends a recorded setting from a comparable shot you marked good.</p><button id="recommend">Find recommendation</button><output id="result" aria-live="polite"></output><h2>Shot feedback</h2><form id="feedback"><label>Shot ID <input required name="shotId"></label><label>Notes <input name="notes"></label><button name="good" value="true">Mark good</button><button name="good" value="false">Remove good mark</button></form><script>const out=document.querySelector('output');document.querySelector('#recommend').onclick=async()=>{out.textContent='Loading...';try{const r=await fetch('recommendation');out.textContent=JSON.stringify(await r.json(),null,2)}catch(e){out.textContent='Could not load recommendation. Try again.'}};document.querySelector('#feedback').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);out.textContent='Saving...';try{const r=await fetch('feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shotId:f.get('shotId'),good:(e.submitter?.value || 'true')==='true',notes:f.get('notes')})});out.textContent=JSON.stringify(await r.json(),null,2)}catch(e){out.textContent='Could not save feedback. Try again.'}};</script>`;

  return {
    id: ID,
    version: "0.1.0",
    onLoad(nextSettings) { sessionEpoch += 1; cacheGeneration += 1; active = true; settings = nextSettings || {}; startStorage(); },
    onUnload() { sessionEpoch += 1; active = false; cacheGeneration += 1; cachedShots = null; storageUnavailable = true; storageWaiters.splice(0).forEach((waiter) => waiter.reject(new Error("plugin unloaded"))); storageWriteWaiters.splice(0).forEach((waiter) => waiter.reject(new Error("plugin unloaded"))); },
    onEvent(event) {
      if (!active) return;
      if (event.name === "storageRead" && event.payload?.key === STORAGE_KEY) {
        if (storageUnavailable || storageReady) return;
        const restored = feedbackFromStorage(event.payload.value);
        if (!restored) { storageUnavailable = true; storageWaiters.splice(0).forEach((waiter) => waiter.reject(new Error("feedback storage unavailable"))); return; }
        feedback = restored;
        storageReady = true; storageWaiters.splice(0).forEach((waiter) => waiter.resolve());
      }
      if (event.name === "storageWrite" && !storageWriteBroken) { const waiter = storageWriteWaiters.shift(); if (waiter) waiter.resolve(); }
      if (event.name === "shotStored" || event.name === "shotUpdated" || event.name === "workflowUpdated") { cacheGeneration += 1; cachedShots = null; }
    },
    handleHttpRequest: async (request) => {
      const endpoint = request.endpoint || "";
      const requestSession = sessionEpoch;
      try {
        if (!active) throw new Error("plugin unloaded");
        if (endpoint === "ui" && request.method === "GET") return html(200, page);
        if (endpoint === "settings" && request.method === "GET") return json(200, settings);
        if (endpoint === "shots" && request.method === "GET") return json(200, {...await fetchShots(), maxPages: MAX_PAGES});
        if (endpoint === "recommendation" && request.method === "GET") return json(200, await recommendation());
        if (endpoint === "feedback" && request.method === "POST") {
          const input = bodyOf(request);
          if (!input || typeof input !== "object" || Array.isArray(input)) return json(400, {error: "feedback must be an object"});
          const shotId = textOrNull(input.shotId);
          if (!shotId || shotId.length > 256 || typeof input.good !== "boolean") return json(400, {error: "shotId and boolean good are required"});
          await loadStorage();
          feedbackQueue = feedbackQueue.catch(() => {}).then(async () => {
            if (!active || requestSession !== sessionEpoch) throw new Error("plugin unloaded");
            const previous = feedback[shotId];
            if (input.good) feedback[shotId] = {good: true, notes: textOrNull(input.notes)?.slice(0, 512) || null, updatedAt: new Date().toISOString()};
            else delete feedback[shotId];
            try { await persist(); } catch (error) { if (previous) feedback[shotId] = previous; else delete feedback[shotId]; throw error; }
          });
          await feedbackQueue;
          if (!active || requestSession !== sessionEpoch) throw new Error("plugin unloaded");
          return json(200, {saved: true, shotId});
        }
        return json(404, {error: "unknown endpoint or method"});
      } catch (error) {
        log("request failed");
        return json(503, {error: "Assisted dial-in unavailable", code: "request_failed", ...(active && (storageUnavailable || storageWriteBroken) ? {recovery: "Reload the plugin to recover feedback storage before saving or recommending again"} : {})});
      }
    },
  };
}
