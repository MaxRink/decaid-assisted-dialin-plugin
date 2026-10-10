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
  let storageWaiters = [];
  let cachedShots = null;
  let cachedAt = 0;

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

  function contextOf(shot) {
    const workflow = shot?.workflow || {};
    const context = workflow.context || {};
    const extras = context.extras || {};
    const profile = workflow.profile || {};
    return {
      beanBatchId: textOrNull(value(context.beanBatchId, settings.BeanBatchId)),
      grinderId: textOrNull(value(context.grinderId, settings.GrinderId)),
      grinderModel: textOrNull(value(context.grinderModel, settings.GrinderModel)),
      burrIdentity: textOrNull(value(extras.burrIdentity, settings.BurrIdentity)),
      calibrationEpoch: textOrNull(value(extras.calibrationEpoch, settings.CalibrationEpoch)),
      dose: numberOrNull(value(context.targetDoseWeight, numberOrNull(settings.Dose))),
      yield: numberOrNull(value(context.targetYield, numberOrNull(settings.Yield))),
      basket: textOrNull(value(extras.basket, settings.Basket)),
      profile: textOrNull(value(profile.id, value(profile.title, settings.ProfileId))),
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
    if (storageReady) return;
    await new Promise((resolve) => storageWaiters.push(resolve));
  }
  function persist() {
    try { host.storage({type: "write", key: STORAGE_KEY, data: feedback}); } catch (error) { log(`feedback save failed: ${error.message}`); }
  }
  function startStorage() {
    try { host.storage({type: "read", key: STORAGE_KEY}); } catch (_) { storageReady = true; storageWaiters.splice(0).forEach((resolve) => resolve()); }
  }

  async function fetchShots() {
    if (cachedShots && Date.now() - cachedAt < 5000) return cachedShots;
    const result = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await fetch(`${API_BASE}/api/v1/shots?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&order=desc`);
      if (!response.ok) throw new Error(`Shot history unavailable (HTTP ${response.status})`);
      const data = await response.json();
      const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
      result.push(...items);
      if (items.length < PAGE_SIZE || result.length >= Number(data.total || result.length)) break;
    }
    cachedShots = result;
    cachedAt = Date.now();
    return result;
  }

  async function recommendation() {
    await loadStorage();
    const shots = await fetchShots();
    const current = contextOf({workflow: {context: settings, profile: {id: settings.ProfileId}}});
    const required = ["beanBatchId", "grinderId"];
    const missingCurrent = required.filter((key) => current[key] === null);
    if (missingCurrent.length) return {status: "abstain", reason: "Enter the current bean batch and grinder identity before comparing shots", missingData: missingCurrent};
    const considered = [];
    const abstentions = [];
    for (const shot of shots) {
      const mark = feedback[String(shot.id)];
      if (!mark?.good) continue;
      const candidate = contextOf(shot);
      if (!candidate.grinderSetting) { abstentions.push({shotId: shot.id, reason: "good shot has no recorded grinder setting"}); continue; }
      const result = compare(current, candidate);
      if (result.ok) considered.push({shot, candidate, mark, unavailable: result.unavailable});
      else if (result.missing.length) abstentions.push({shotId: shot.id, missing: result.missing});
    }
    considered.sort((a, b) => String(b.shot.timestamp || "").localeCompare(String(a.shot.timestamp || "")));
    if (!considered.length) return {status: "abstain", reason: "No comparable marked-good shot found", missingData: abstentions.slice(0, 10)};
    const selected = considered[0];
    return {
      status: "recommendation",
      sourceShotId: selected.shot.id,
      grinderSetting: selected.candidate.grinderSetting,
      recordedValue: true,
      provenance: "user-marked-good local shot; workflow setting is intended, not verified hardware state",
      notes: selected.mark.notes || null,
      timestamp: selected.shot.timestamp || null,
      warnings: selected.unavailable.length ? [`Comparison fields unavailable in both current setup and shot: ${selected.unavailable.join(", ")}`] : [],
    };
  }

  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Assisted dial-in</title><style>body{font:16px system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem}button{font:inherit;padding:.6rem}output{display:block;margin-top:1rem;white-space:pre-wrap}</style><h1>Assisted dial-in</h1><p>This assistant only recommends a recorded setting from a comparable shot you marked good.</p><button id="recommend">Find recommendation</button><output id="result" aria-live="polite"></output><h2>Mark a shot good</h2><form id="feedback"><input required name="shotId" placeholder="Shot ID"><input name="notes" placeholder="Notes"><button>Save feedback</button></form><script>const out=document.querySelector('output');document.querySelector('#recommend').onclick=async()=>{out.textContent='Loading...';const r=await fetch('recommendation');out.textContent=JSON.stringify(await r.json(),null,2)};document.querySelector('#feedback').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);const r=await fetch('feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shotId:f.get('shotId'),good:true,notes:f.get('notes')})});out.textContent=JSON.stringify(await r.json(),null,2)};</script>`;

  return {
    id: ID,
    version: "0.1.0",
    onLoad(nextSettings) { settings = nextSettings || {}; startStorage(); },
    onUnload() { cachedShots = null; },
    onEvent(event) {
      if (event.name === "storageRead" && event.payload?.key === STORAGE_KEY) {
        feedback = event.payload.value && typeof event.payload.value === "object" ? event.payload.value : Object.create(null);
        storageReady = true; storageWaiters.splice(0).forEach((resolve) => resolve());
      }
      if (event.name === "storageWrite") storageReady = true;
      if (event.name === "shotStored" || event.name === "shotUpdated") cachedShots = null;
    },
    __httpRequestHandler: async (request) => {
      const endpoint = request.endpoint || "";
      try {
        if (endpoint === "ui" && request.method === "GET") return html(200, page);
        if (endpoint === "settings" && request.method === "GET") return json(200, settings);
        if (endpoint === "shots" && request.method === "GET") return json(200, {items: await fetchShots(), maxPages: MAX_PAGES});
        if (endpoint === "recommendation" && request.method === "GET") return json(200, await recommendation());
        if (endpoint === "feedback" && request.method === "POST") {
          const input = bodyOf(request);
          const shotId = textOrNull(input.shotId);
          if (!shotId || input.good !== true) return json(400, {error: "shotId and good:true are required"});
          await loadStorage();
          feedback[shotId] = {good: true, notes: textOrNull(input.notes), updatedAt: new Date().toISOString()};
          persist();
          return json(200, {saved: true, shotId});
        }
        return json(404, {error: "unknown endpoint or method"});
      } catch (error) {
        log(`request failed: ${error.message}`);
        return json(503, {error: "Assisted dial-in unavailable", detail: String(error.message)});
      }
    },
  };
}
