/* The simulator is deliberately a thin UI. All dial-in calculations come from
 * createResearchAlgorithms in the shipped plugin; this file only supplies a
 * bounded fictional plant and presents the returned state. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const algorithmNames = ["GbS1", "GbS2", "GbS3", "GbS4", "DdEff"];
  const descriptions = {
    GbS1: "Remembers a small recent window and moves smoothly.",
    GbS2: "Draws a line through recent settings and times.",
    GbS3: "Uses far, middle, and near phases, then holds briefly.",
    GbS4: "Behaves like GbS3 and locks when it is very close.",
    DdEff: "Samples a starting setting, then two deliberate offsets."
  };
  let algorithms;
  let simulationEngine;
  let rows = [];
  let dialCalibration = null;
  let dialMetadata = {};
  const INSTANCE_KEY = "decaid.assisted-dialin.grinder-instances.v1";
  const ACTIVE_INSTANCE_KEY = "decaid.assisted-dialin.active-grinder-instance.v1";
  let grinderInstances = [];
  let activeInstanceId = null;
  let viewMode = "simple";
  let simpleShots = [], simpleProposal = null, simplePractice = false;
  let simpleEditingShot = false, simpleComparisonStale = false;
  const nativeSetupEdited = new Set();
  let nextNativeShotId = 1;
  let navigateSimple = () => {};
  let mechanics = null, mechanicsCatalog = null, mechanicalSetupScope = null;
  let researchSeries = null;

  const RESEARCH_KEY = "decaid.assisted-dialin.research.v1";
  const RESEARCH_ENDPOINT_KEY = "decaid.assisted-dialin.research-endpoint.v1";
  let researchFactory = null, researchClient = null, researchEndpoint = null;
  const researchSession = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

  async function renderResearchSharing(message) {
    if (!researchClient) return;
    const state = await researchClient.status();
    if ($("research-sharing-title")) text($("research-sharing-title"), "Local archive " + (state.localEnabled ? "on" : "off") + " · remote sharing " + (state.sharing ? "on" : "off"));
    $("research-local-enabled").checked = state.localEnabled;
    $("research-sharing-consent").checked = state.sharing;
    $("research-sharing-consent").disabled = !researchEndpoint || Boolean(state.error);
    $("research-sharing-send").disabled = !state.sharing || !state.queuedCount || Boolean(state.error);
    text($("research-sharing-status"), message || (state.error ? "Research storage is unavailable. Remote sharing is off. " + state.error :
      "Local archive " + (state.localEnabled ? "on" : "off") + ": " + state.localCount + " record(s). Remote sharing " + (state.sharing ? "on" : "off") + "; " + state.queuedCount + " queued. " + (researchEndpoint ? "Nothing is sent until you choose Send queued records." : "No collector is configured.")));
    text($("research-sharing-destination"), researchEndpoint ? "Collector: " + researchEndpoint : "");
  }
  async function researchAction(action, message) {
    try { await action(); await renderResearchSharing(message); }
    catch (error) { await renderResearchSharing("Research action failed: " + error.message); }
  }
  function researchUnit(unit) {
    return {marks: "dial-marks", "µm": "micrometres", "decimal dial numbers": "printed-decimal", "printed numbers": "printed-decimal"}[unit] || unit || "unknown";
  }
  function researchRecord(shot, c, proposedSetting) {
    const settingUnit = researchUnit(shot.scope.settingUnit);
    const native = ["suggestion", "hold"].includes(shot.nativeResponse?.status);
    const model = c.grinder === "Other known grinder" ? "other" : c.grinder;
    const moved = proposedSetting !== shot.setting;
    return researchFactory.sanitizeRecord({source: "website", kind: "shot", mode: shot.practice ? "practice" : "manual", researchSeries: shot.researchSeries, shotOrdinal: shot.researchOrdinal, approaches: shot.researchApproaches,
      grinder: {model, settingUnit, setting: shot.setting, step: simpleNumber("simple-step"), finerSign: Number($("simple-finer").value), ownerConfirmed: $("simple-confirm-dial").checked === true},
      recipe: {controlMode: shot.scope.controlMode, targetClock: shot.clockConfirmed ? "pump" : "unknown", targetTimeSec: shot.target, targetDoseG: c.dose, targetYieldG: c.yield},
      measurements: shot.clockConfirmed ? {pumpTimeSec: shot.time, pumpComplete: true} : {},
      coffee: {species: String(c.species).toLowerCase(), roast: c.roast},
      taste: {...(shot.taste ? {good: shot.taste === "balanced"} : {}), intent: {"too sour": "too_sour", "too bitter": "too_bitter", "too astringent": "too_astringent", channeling: "uneven_flow"}[shot.taste] || shot.taste || "unknown", tastingTemperatureC: shot.temperature, minutesAfterBrew: shot.minutes},
      advice: {algorithm: shot.chosenMechanical?.algorithm || (native ? "native-response" : "manual"), coordinateStatus: shot.chosenMechanical?.coordinateStatus || "native", status: moved ? "suggestion" : "retained", direction: moved ? (proposedSetting - shot.setting) * Number($("simple-finer").value) > 0 ? "finer" : "coarser" : "none", settingUnit, proposedSetting, evidenceCount: native ? shot.nativeResponse?.fit?.points?.length : undefined}});
  }
  function captureResearchShot(shot, c, proposedSetting) {
    if (!researchClient) return;
    try {
      const scope = JSON.stringify([shot.scope, shot.target, shot.tolerance, shot.practice]);
      if (!researchSeries || researchSeries.scope !== scope) researchSeries = {scope, id: researchFactory.randomId(), count: 0};
      if (shot.researchSeries !== researchSeries.id) { shot.researchSeries = researchSeries.id; shot.researchOrdinal = ++researchSeries.count; }
      const record = researchRecord(shot, c, proposedSetting);
      researchAction(() => researchClient.capture(record, researchSession + ":" + shot.id));
    } catch (_) { text($("research-sharing-status"), "This shot could not be added to the research archive. Your dial-in history is still available."); }
  }
  function initializeResearchSharing() {
    if (!$("research-sharing-consent")) return;
    $("research-sharing-consent").disabled = true;
    if (typeof window.createResearchSharing !== "function") { text($("research-sharing-status"), "Research archiving is unavailable. Your dial-in tools still work."); return; }
    researchFactory = window.createResearchSharing();
    try {
      const saved = storage()?.getItem(RESEARCH_ENDPOINT_KEY);
      const configured = saved === null || saved === undefined ? window.DECAID_RESEARCH_CONFIG?.endpoint : saved;
      if (configured) researchEndpoint = researchFactory.validateEndpoint(configured);
    } catch (_) { researchEndpoint = null; }
    $("research-sharing-endpoint").value = researchEndpoint || "";
    researchClient = researchFactory.createClient({
      load: async () => { const store = storage(); if (!store) throw new Error("Browser storage is unavailable."); return JSON.parse(store.getItem(RESEARCH_KEY) || "null"); },
      save: async state => { const store = storage(); if (!store) throw new Error("Browser storage is unavailable."); store.setItem(RESEARCH_KEY, JSON.stringify(state)); },
      send: (url, init) => fetch(url, init)
    });
    researchClient.ready.then(async state => {
      if (state.sharing && state.endpoint !== researchEndpoint) await researchClient.setSharing(false);
      await renderResearchSharing();
    }).catch(() => { text($("research-sharing-status"), "Research storage could not be opened. Remote sharing is off."); });
    $("research-local-enabled").addEventListener("change", () => researchAction(() => researchClient.setLocalCollection($("research-local-enabled").checked)));
    $("research-sharing-consent").addEventListener("change", () => researchAction(() => researchClient.setSharing($("research-sharing-consent").checked, researchEndpoint)));
    $("research-sharing-disable").addEventListener("click", () => researchAction(() => researchClient.setSharing(false)));
    $("research-sharing-delete").addEventListener("click", () => researchAction(() => researchClient.clear(), "All local research records and queued records were deleted. Remote sharing is off."));
    $("research-sharing-send").addEventListener("click", () => researchAction(() => researchClient.flush()));
    $("research-sharing-apply").addEventListener("click", () => researchAction(async () => {
      const entered = $("research-sharing-endpoint").value.trim();
      const endpoint = entered ? researchFactory.validateEndpoint(entered) : null;
      await researchClient.setSharing(false);
      const store = storage(); if (!store) throw new Error("Browser storage is unavailable.");
      store.setItem(RESEARCH_ENDPOINT_KEY, endpoint || ""); researchEndpoint = endpoint;
    }));
    $("research-sharing-export").addEventListener("click", () => researchAction(async () => {
      const archive = await researchClient.exportLocal();
      const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], {type: "application/json"}));
      link.download = "dial-in-research.json"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0);
    }, "Research file saved locally. Nothing was sent to a collector."));
  }

  const slug = (value) => String(value || "grinder").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "grinder";
  function storage() { try { return window.localStorage; } catch (_) { return null; } }
  function profileId(model, suffix) { return "grinder-" + slug(model) + "-" + suffix; }
  function profileFromTemplate(profile, index) {
    const model = String(profile.model || "Other known grinder");
    return { id: profileId(model, "template-" + index), name: model + " · example", model, burrIdentity: "stock burrs · zero 0 · epoch 1", calibrationEpoch: "epoch 1", zero: profile.zero ?? 0, stepSize: profile.stepSize ?? null, anchors: null, source: "shipped example; calibrate this physical grinder" };
  }
  function validProfile(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(value.id) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 128 || typeof value.model !== "string" || !value.model.trim() || value.model.length > 256 || typeof value.burrIdentity !== "string" || !value.burrIdentity.trim() || value.burrIdentity.length > 256 || typeof value.calibrationEpoch !== "string" || !value.calibrationEpoch.trim() || value.calibrationEpoch.length > 256) return false;
    if (value.nativeSetup != null) { const setup = value.nativeSetup; if (!setup || typeof setup !== "object" || Array.isArray(setup) || typeof setup.burrIdentity !== "string" || typeof setup.calibrationEpoch !== "string" || (setup.settingUnit != null && (typeof setup.settingUnit !== "string" || !setup.settingUnit.trim() || setup.settingUnit.length > 64)) || ![-1, 1].includes(setup.numericFinerDelta) || [setup.min, setup.max].some(bound => bound != null && (typeof bound !== "number" || !Number.isFinite(bound)))) return false; }
    return (value.zero == null || (typeof value.zero === "number" && Number.isFinite(value.zero) && Math.abs(value.zero) <= 2147483647)) && (value.stepSize == null || (typeof value.stepSize === "number" && Number.isFinite(value.stepSize) && value.stepSize > 0 && value.stepSize <= 2147483647)) && (value.anchors == null || (typeof value.anchors === "object" && !Array.isArray(value.anchors))) && (value.source == null || (typeof value.source === "string" && value.source.length <= 256));
  }
  function persistProfiles() { const store = storage(); if (!store) return; try { store.setItem(INSTANCE_KEY, JSON.stringify(grinderInstances)); store.setItem(ACTIVE_INSTANCE_KEY, activeInstanceId || ""); } catch (_) { setNotice("Your browser could not save grinder profiles; this experiment still works in memory.", true); } }
  function activeProfile() { return grinderInstances.find(profile => profile.id === activeInstanceId) || grinderInstances[0] || null; }
  function profileCalibration(profile) { return profile && profile.anchors ? { ...profile.anchors, grinderId: profile.id, model: profile.model, burrIdentity: profile.burrIdentity, calibrationEpoch: profile.calibrationEpoch } : null; }
  function setActiveProfile(id, announce) {
    const profile = grinderInstances.find(item => item.id === id); if (!profile) return;
    activeInstanceId = profile.id; $("grinder").value = profile.model; $("burrs").value = profile.burrIdentity; $("calibration").value = profile.calibrationEpoch; dialCalibration = profileCalibration(profile); persistProfiles();
    clearSimpleSetup(); reset(true); renderDialPanel(); renderInstanceManager(); applyNativeDefaults(); if (announce) setNotice("Switched to " + profile.name + ". Start a fresh shot for this grinder.");
  }
  function ensureProfiles() {
    const store = storage(); let loaded = null;
    try { loaded = store && JSON.parse(store.getItem(INSTANCE_KEY) || "null"); } catch (_) { loaded = null; }
    if (Array.isArray(loaded) && loaded.length && loaded.length <= 100 && loaded.every(validProfile) && new Set(loaded.map(item => item.id)).size === loaded.length) grinderInstances = loaded;
    if (!grinderInstances.length) grinderInstances = [profileFromTemplate({ model: "DF64 Gen 2", zero: 0 }, 0), profileFromTemplate({ model: "DF54", zero: 0 }, 1), profileFromTemplate({ model: "E64 WS", zero: 0 }, 2)];
    let preferred = null; try { preferred = store && store.getItem(ACTIVE_INSTANCE_KEY); } catch (_) {}
    activeInstanceId = grinderInstances.some(item => item.id === preferred) ? preferred : grinderInstances[0].id;
    const profile = activeProfile(); $("grinder").value = profile.model; dialCalibration = profileCalibration(profile); $("burrs").value = profile.burrIdentity; $("calibration").value = profile.calibrationEpoch;
    persistProfiles(); renderInstanceManager();
  }
  function renderInstanceManager() {
    const select = $("grinder-instance"); if (!select) return; select.replaceChildren(); grinderInstances.forEach(profile => { const option = document.createElement("option"); option.value = profile.id; text(option, profile.name); select.append(option); }); select.value = activeInstanceId || "";
    const holder = $("grinder-profiles"); if (!holder) return; holder.replaceChildren();
    const copy = document.createElement("p"); copy.className = "hint expert-only"; text(copy, "Profile ID " + (activeInstanceId || "none") + ". Each saved unit has its own zero, step size and measured anchors."); holder.append(copy);
    const profile = activeProfile(); const profileFields = document.createElement("div"); profileFields.className = "fields compact expert-only";
    const zeroField = document.createElement("label"); text(zeroField, "Owner zero (native units)"); const zeroInput = document.createElement("input"); zeroInput.type = "number"; zeroInput.step = "any"; zeroInput.value = profile?.zero ?? 0; zeroInput.setAttribute("aria-label", "owner zero"); zeroField.append(zeroInput);
    const stepField = document.createElement("label"); text(stepField, "Owner step size (native units)"); const stepInput = document.createElement("input"); stepInput.type = "number"; stepInput.min = "0.000001"; stepInput.step = "any"; stepInput.value = profile?.stepSize ?? ""; stepInput.setAttribute("aria-label", "owner step size"); stepField.append(stepInput); profileFields.append(zeroField, stepField); holder.append(profileFields);
    const actions = document.createElement("div"); actions.className = "actions"; const buttons = {};
    [["add-grinder", "Add individual grinder"], ["rename-grinder", "Rename"], ["save-grinder", "Save current calibration"], ["remove-grinder", "Remove"]].forEach(([id, label]) => { const button = document.createElement("button"); button.id = id; button.type = "button"; text(button, label); buttons[id] = button; if (id === "save-grinder" || id === "remove-grinder") button.className = "expert-only"; actions.append(button); }); holder.append(actions);
    buttons["add-grinder"].addEventListener("click", () => { const model = $("grinder").value || "Other known grinder"; const profile = { id: profileId(model, "custom-" + Date.now().toString(36) + "-" + grinderInstances.length), name: model + " · my grinder " + (grinderInstances.length + 1), model, burrIdentity: $("burrs").value || "stock burrs", calibrationEpoch: $("calibration").value || "epoch 1", zero: 0, stepSize: null, anchors: null, source: "owner-created; calibration required" }; grinderInstances.push(profile); setActiveProfile(profile.id, true); });
    buttons["rename-grinder"].addEventListener("click", () => { const profile = activeProfile(); if (!profile) return; const name = window.prompt ? window.prompt("Name this individual grinder", profile.name) : profile.name; if (typeof name === "string" && name.trim() && name.length <= 128) { profile.name = name.trim(); persistProfiles(); renderInstanceManager(); setNotice("Individual grinder renamed."); } else if (name != null) setNotice("A grinder name is required and must be at most 128 characters.", true); });
    buttons["save-grinder"].addEventListener("click", () => { const profile = activeProfile(); if (!profile) return; const zero = Number(zeroInput.value); const step = stepInput.value === "" ? null : Number(stepInput.value); if (!Number.isFinite(zero) || Math.abs(zero) > 2147483647 || (step != null && (!Number.isFinite(step) || step <= 0 || step > 2147483647))) { setNotice("Owner zero must be finite; step size must be positive when supplied.", true); return; } profile.model = $("grinder").value; profile.burrIdentity = $("burrs").value; profile.calibrationEpoch = $("calibration").value; profile.zero = zero; profile.stepSize = step; profile.anchors = dialCalibration ? { ...dialCalibration } : null; profile.source = "owner-updated; calibrate this physical grinder"; persistProfiles(); renderInstanceManager(); renderDialPanel(); setNotice("Saved this grinder's identity and calibration anchors."); });
    buttons["remove-grinder"].addEventListener("click", () => { if (grinderInstances.length <= 1) { setNotice("Keep at least one individual grinder profile.", true); return; } grinderInstances = grinderInstances.filter(profile => profile.id !== activeInstanceId); activeInstanceId = grinderInstances[0].id; setActiveProfile(activeInstanceId, true); });
  }
  const safeHttps = (value) => { try { const url = new URL(value, window.location.href); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch (_) { return null; } };
  function reusableImage(image) {
    if (!image || image.renderAllowed !== true || typeof image.license !== "string" || typeof image.licenseUrl !== "string") return false;
    const license = image.license.trim().toLowerCase().replace(/\s+/g, " ");
    return ["cc0", "public domain", "cc by", "cc by-sa", "cc by 4.0", "cc by-sa 4.0"].includes(license) && safeHttps(image.licenseUrl) !== null;
  }
  function dialProfile() {
    const name = config().grinder;
    const shipped = algorithms && typeof algorithms.profileForGrinder === "function" ? algorithms.profileForGrinder(name) : algorithms && algorithms.grinderDialProfiles ? Object.values(algorithms.grinderDialProfiles).find(profile => profile.model === name) : null;
    const metadata = dialMetadata[name] || Object.values(dialMetadata).find(profile => profile.model === name) || {};
    return shipped ? { ...metadata, ...shipped, image: metadata.image, schematicUrl: metadata.schematicUrl, sources: metadata.sources } : metadata;
  }
  function dialConversion(dd) {
    if (!algorithms || typeof algorithms.toGrinderDial !== "function") return { status: "unsupported", visible: null, warnings: ["shipped grinder helper unavailable"] };
    try { return algorithms.toGrinderDial({ model: config().grinder, ddDum: dd, burrIdentity: config().burrs, calibrationEpoch: config().calibration, ...(dialCalibration?.grinderId ? { grinderId: config().grinderId } : {}), calibration: dialCalibration }); } catch (error) { return { status: "error", visible: null, warnings: [error.message] }; }
  }
  function nativeDisplay(dd) {
    const profile = dialProfile() || {}, result = dialConversion(dd), value = result.visible && result.visible.value;
    if (value == null) return { value: null, label: result.status === "error" ? "calibration invalid" : "calibration required", unit: profile.visibleUnit || profile.unit || "native dial" };
    const rounded = Number.isFinite(value) ? Number(value.toFixed(3)) : value;
    const count = profile.clicksPerRotation && Number.isInteger(value) && value >= 0
      ? " (" + Math.floor(value / profile.clicksPerRotation) + " full turns + " + value % profile.clicksPerRotation + " clicks from zero)" : "";
    return { value: rounded, label: String(rounded) + count + (result.achievable === false ? " (between physical steps; choose a neighboring step)" : ""), unit: result.visible.unit || profile.visibleUnit || profile.unit || "native dial" };
  }
  function renderDialPanel() {
    const holder = $("dial-panel"); if (!holder) return;
    holder.replaceChildren();
    const profile = dialProfile() || {}, heading = document.createElement("strong"); text(heading, "Physical dial view · " + (profile.model || config().grinder));
    const info = document.createElement("p"); info.className = "hint"; text(info, (profile.visibleUnit || profile.unit || "native dial") + ". " + (profile.provenance || "Research dD remains the algorithm input.")); holder.append(heading, info);
    const image = profile.image || profile.photo, externalImage = reusableImage(image) ? safeHttps(image.url) : null, schematic = typeof profile.schematicUrl === "string" ? profile.schematicUrl : null, imageUrl = externalImage || schematic; if (imageUrl) { const figure = document.createElement("figure"), img = document.createElement("img"), caption = document.createElement("figcaption"); img.src = imageUrl; img.alt = externalImage ? (image?.caption || (profile.model || config().grinder) + " dial reference photo") : (profile.model || config().grinder) + " dial schematic"; img.loading = "lazy"; if (externalImage && schematic) img.addEventListener("error", () => { img.src = schematic; img.alt = (profile.model || config().grinder) + " dial schematic"; text(caption, "Repository dial schematic"); }); text(caption, externalImage ? (image?.caption || "Licensed dial reference photo") : "Repository dial schematic"); figure.append(img, caption); if (image && safeHttps(image.sourceUrl)) { const link = document.createElement("a"); link.href = safeHttps(image.sourceUrl); link.target = "_blank"; link.rel = "noopener noreferrer"; text(link, "Image source · " + (image.owner || "external reference")); figure.append(link); } if (externalImage) { const credit = document.createElement("small"); text(credit, "Photo credit: " + (image.attribution || image.owner || "licensed source") + " · Licence: " + image.license); figure.append(credit); const license = document.createElement("a"); license.href = safeHttps(image.licenseUrl); license.target = "_blank"; license.rel = "noopener noreferrer"; text(license, "View image licence"); figure.append(license); } holder.append(figure); }
    const current = nativeDisplay(config().start), native = document.createElement("p"); text(native, "Current research coordinate " + config().start + " dD → " + current.label + " " + current.unit); holder.append(native);
    const nativeField = document.createElement("label"); text(nativeField, "Native grinder setting (editable)"); const nativeInput = document.createElement("input"); nativeInput.type = "number"; nativeInput.step = "any"; nativeInput.value = current.value == null ? "" : current.value; nativeInput.setAttribute("aria-label", "native grinder setting"); nativeInput.addEventListener("change", () => { if (nativeInput.value === "") return; try { const converted = algorithms.normalizeGrinderSetting({ model: config().grinder, value: Number(nativeInput.value), burrIdentity: config().burrs, calibrationEpoch: config().calibration, ...(dialCalibration?.grinderId ? { grinderId: config().grinderId } : {}), calibration: dialCalibration }); if (converted.status !== "normalized") throw new Error((converted.warnings || ["native setting needs calibration"])[0]); $("start").value = String(converted.algorithm.ddDum); if (rows.length) reset(); else renderDialPanel(); setNotice("Native setting converted to the research coordinate using the shipped grinder profile."); } catch (error) { setNotice(error.message, true); renderDialPanel(); } }); nativeField.append(nativeInput); holder.append(nativeField);
    {
      const details = document.createElement("details"), summary = document.createElement("summary"); text(summary, "Enter two measured anchors for this grinder"); details.append(summary);
      const draft = dialCalibration ? { ...dialCalibration } : { model: config().grinder, burrIdentity: config().burrs, calibrationEpoch: config().calibration };
      const inputs = {};
      [["model", "Grinder model", draft.model], ["burrIdentity", "Burr identity", draft.burrIdentity], ["calibrationEpoch", "Calibration epoch", draft.calibrationEpoch], ["dialMin", "Native dial minimum", draft.dialMin ?? ""], ["dialMax", "Native dial maximum", draft.dialMax ?? ""], ["dialA", "Native dial at anchor 1", draft.dialA ?? ""], ["ddDumA", "Research dD at anchor 1", draft.ddDumA ?? ""], ["dialB", "Native dial at anchor 2", draft.dialB ?? ""], ["ddDumB", "Research dD at anchor 2", draft.ddDumB ?? ""]].forEach(([key, label, value]) => { const field = document.createElement("label"); text(field, label); const input = document.createElement("input"); input.type = key === "model" || key === "burrIdentity" || key === "calibrationEpoch" ? "text" : "number"; input.step = "any"; input.value = value; input.readOnly = key === "model" || key === "burrIdentity" || key === "calibrationEpoch"; input.setAttribute("aria-label", label); inputs[key] = input; field.append(input); details.append(field); });
      const apply = document.createElement("button"); apply.type = "button"; text(apply, "Apply owner calibration"); apply.addEventListener("click", () => { try { const candidate = { ...Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.type === "number" ? Number(input.value) : input.value])), grinderId: config().grinderId }; if (Object.entries(inputs).some(([key, input]) => input.type === "number" && input.value === "")) throw new Error("all calibration numbers are required"); const checked = algorithms.toGrinderDial({ model: config().grinder, ddDum: config().start, burrIdentity: config().burrs, calibrationEpoch: config().calibration, grinderId: config().grinderId, calibration: candidate }); if (checked.status !== "normalized") throw new Error((checked.warnings || ["two valid anchors are required"])[0]); dialCalibration = candidate; const profile = activeProfile(); if (profile) { profile.anchors = { ...candidate }; persistProfiles(); } reset(true); setNotice("Owner calibration applied and scoped to this individual grinder, burr set, and epoch."); } catch (error) { setNotice(error.message, true); } }); details.append(apply);
      const clear = document.createElement("button"); clear.type = "button"; text(clear, "Reset dial calibration"); clear.addEventListener("click", () => { dialCalibration = null; const profile = activeProfile(); if (profile) { profile.anchors = null; persistProfiles(); } reset(true); setNotice("Dial calibration cleared; research-only coordinates remain available."); }); details.append(clear); holder.append(details);
    }
  }
  const text = (node, value) => { node.textContent = String(value); };
  const number = (id, fallback) => {
    const node = $(id);
    const value = Number(node ? node.value : fallback);
    return Number.isFinite(value) ? value : fallback;
  };
  const config = () => ({
    algorithm: $("algorithm").value,
    target: number("target", 28),
    tolerance: number("tolerance", 1),
    start: Math.round(number("start", 500)),
    plant: number("plant", 1),
    noise: number("noise", 0.8),
    pressure: number("pressure", 9),
    flow: number("flow", 2.2),
    bean: $("bean").value,
    roaster: $("roaster").value,
    species: $("species").value,
    roast: $("roast").value,
    calibration: $("calibration").value,
    grinder: $("grinder").value,
    grinderId: activeInstanceId || $("grinder").value,
    burrs: $("burrs").value,
    dose: number("dose", 18),
    yield: number("yield", 36),
    preinfusionSec: number("preinfusion", 0),
    preinfusionPressure: number("preinfusion-pressure", 2)
    ,dialCalibration: profileCalibration(activeProfile()) || dialCalibration
  });
  function setNotice(message, error) {
    const node = $("notice");
    text(node, message || "");
    node.className = error ? "notice error" : "notice";
  }
  function hash(value) {
    let result = 2166136261;
    for (let i = 0; i < value.length; i += 1) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
    return (result >>> 0) / 4294967295;
  }
  function simulatedTime(setting, pass) {
    const c = config();
    const ideal = 470 + Math.round((hash(c.bean + c.burrs + c.grinder) - 0.5) * 180);
    const distance = (ideal - setting) * 0.021;
    // The target is a comparison criterion, never a cause in the synthetic plant.
    // Yield adds a small positive hydraulic path; it must not make a larger beverage faster.
    const repeatable = 28 + distance / Math.max(c.plant, 0.2) + (c.dose - 18) * 0.18 + (c.yield - 36) * 0.06;
    const wave = Math.sin((pass + 1) * 1.91 + hash(c.bean) * 11) * c.noise;
    return Math.max(1, Math.round((repeatable + wave) * 10) / 10);
  }
  function engineScenario(shotRows = rows, c = config()) {
    return { version: 1, scope: { grinderId: c.grinderId, beanBatchId: c.bean, burrIdentity: c.burrs, calibrationEpoch: c.calibration, profile: "espresso" }, initial: { settingDdDum: c.start }, targetBrewTimeMs: Math.round(c.target * 1000), toleranceMs: Math.round(c.tolerance * 1000), bounds: { minDdDum: 0, maxDdDum: 100000 }, seed: 1, shots: shotRows.filter((row) => row.actual !== "" && Number.isFinite(Number(row.actual)) && Number(row.actual) > 0).map((row) => ({ actualBrewTimeMs: Math.round(Number(row.actual) * 1000), targetBrewTimeMs: Math.round(Number(row.target) * 1000), toleranceMs: Math.round(c.tolerance * 1000), estimatedDdDum: Math.round(Number(row.setting)), setpointDdDum: Math.round(Number(row.setting)), scope: { grinderId: row.context?.grinderId || c.grinderId, beanBatchId: row.context?.bean || c.bean, burrIdentity: row.context?.burrs || c.burrs, calibrationEpoch: row.context?.calibration || c.calibration, profile: "espresso" }, beanType: row.context?.species || c.species, roastLevel: row.context?.roast || c.roast, taste: row.taste && row.taste !== "none" ? row.taste : undefined, overall: row.overall || undefined, dose: row.context?.dose ?? c.dose, yield: row.context?.yield ?? c.yield })) };
  }
  function engineRun(name, shotRows = rows) {
    if (!simulationEngine || !shotRows.length) return null;
    return simulationEngine.run(engineScenario(shotRows)).algorithms.find((entry) => entry.algorithm === name) || null;
  }
  function recommendation() {
    const result = engineRun(config().algorithm);
    return result ? result.finalSettingDdDum : config().start;
  }
  function addRow(setting, actual) {
    if (rows.length >= 100) throw new Error("An experiment can contain at most 100 shots.");
    const c = config();
    rows.push({ setting: Math.round(setting), actual: actual == null ? "" : actual, target: c.target, pressure: c.pressure, flow: c.flow, preinfusionSec: c.preinfusionSec, preinfusionPressure: c.preinfusionPressure, context: { bean: c.bean, species: c.species, roast: c.roast, grinder: c.grinder, grinderId: c.grinderId, burrs: c.burrs, calibration: c.calibration, dose: c.dose, yield: c.yield, preinfusionSec: c.preinfusionSec, preinfusionPressure: c.preinfusionPressure }, result: null });
  }
  function consumeRow(row, index) {
    const setting = Number(row.setting);
    if (!Number.isInteger(setting)) throw new Error("Every planned setting must be a whole dD number.");
    if (row.actual === "" || row.actual == null) row.actual = simulatedTime(setting, index);
    if (!Number.isFinite(Number(row.actual)) || Number(row.actual) <= 0) throw new Error("Each brew time must be a positive number.");
    row.actual = Math.round(Number(row.actual) * 10) / 10;
    const trial = engineRun(config().algorithm, rows.slice(0, index + 1));
    row.result = trial.shots[trial.shots.length - 1].output;
    return row.result;
  }
  function runNext() {
    invalidateAssistant();
    try {
      const setting = recommendation();
      addRow(setting, simulatedTime(setting, rows.length));
      const result = consumeRow(rows[rows.length - 1], rows.length - 1);
      render();
      showResult(result);
    } catch (error) { setNotice(error.message, true); }
  }
  function runAll() {
    invalidateAssistant();
    try {
      if (!rows.length) addRow(config().start, "");
      rows.forEach((row, index) => { if (!row.result) consumeRow(row, index); });
      render();
      showResult(rows[rows.length - 1].result);
    } catch (error) { setNotice(error.message, true); }
  }
  function reset(preserveNative) { invalidateAssistant(); if (preserveNative !== true) clearSimpleShots(); else { if (simpleShots.length && JSON.stringify(simpleShots.at(-1).scope) !== JSON.stringify(nativeScope())) simpleEditingShot = false; invalidateSimpleAdvice(); } rows = []; render(); showResult(null); setNotice(viewMode === "simple" ? "Ready for a fresh coffee." : "New experiment ready."); }
  function replay() {
    invalidateAssistant();
    try {
      const saved = rows.map((row) => ({ ...row, result: null }));
      rows = []; saved.forEach((row, index) => { rows.push(row); consumeRow(row, index); });
      render(); showResult(rows.length ? rows[rows.length - 1].result : null); setNotice("Replay completed from a fresh algorithm state.");
    } catch (error) { setNotice(error.message, true); }
  }
  function undo() { invalidateAssistant(); if (rows.length) { rows.pop(); rows.forEach((row, i) => { if (row.actual !== "") consumeRow(row, i); }); render(); showResult(rows.length ? rows[rows.length - 1].result : null); } }
  function showResult(result) {
    const box = $("result"); box.replaceChildren();
    if (!result) { const p = document.createElement("p"); text(p, "Run a shot to see the first recommendation."); box.append(p); return; }
    const dl = document.createElement("dl");
    const candidateNative = nativeDisplay(result.candidateDdDum), returnedNative = nativeDisplay(result.returnedDdDum);
    [["Phase", result.phase], ["Candidate", result.candidateDdDum + " dD · native " + candidateNative.label + " " + candidateNative.unit], ["Returned", result.returnedDdDum + " dD · native " + returnedNative.label + " " + returnedNative.unit], ["Decision", result.locked ? "hold / locked" : result.committed ? "committed" : "available"]].forEach(([key, value]) => { const dt = document.createElement("dt"); const dd = document.createElement("dd"); text(dt, key); text(dd, value); dl.append(dt, dd); });
    box.append(dl);
    const trace = engineRun(config().algorithm);
    if (trace && trace.shots.length) {
      const details = document.createElement("details"), summary = document.createElement("summary");
      text(summary, "Inputs and memory for each shot"); details.append(summary);
      trace.shots.forEach((pass, index) => {
        const item = document.createElement("p");
        text(item, "Shot " + (index + 1) + ": " + pass.input.actualBrewTimeMs / 1000 + " s against " + pass.input.targetBrewTimeMs / 1000 + " s; setting " + pass.input.setpointDdDum + " dD. " + (pass.reset ? "Fresh memory. " : "Previous memory retained. ") + "Phase: " + pass.output.phase + "."); details.append(item);
        const memory = document.createElement("details"), caption = document.createElement("summary"), code = document.createElement("pre");
        text(caption, "Advanced: exact algorithm memory and output"); text(code, JSON.stringify({ input: pass.input, output: pass.output, state: pass.state, applied: pass.applied, scope: pass.scope }, null, 2)); memory.append(caption, code); details.append(memory);
      }); box.append(details);
    }
    const p = document.createElement("p"); p.className = "hint"; text(p, descriptions[$("algorithm").value] + " Inputs used here: " + (config().algorithm === "DdEff" ? "starting setting and pass count; timing and taste are ignored." : "brew time, target, current setting, and tolerance. Bean and taste identify the experiment but do not change the native GBS formula.")); box.append(p);
  }
  function renderTable() {
    const body = $("shots"); body.replaceChildren();
    rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      [index + 1].forEach((value) => { const td = document.createElement("td"); text(td, value); tr.append(td); });
      [["setting", row.setting], ["actual", row.actual], ["target", row.target], ["pressure", row.pressure], ["flow", row.flow]].forEach(([key, value]) => { const td = document.createElement("td"); const input = document.createElement("input"); input.type = "number"; input.value = value; input.step = key === "setting" ? "1" : "0.1"; input.setAttribute("aria-label", key + " for shot " + (index + 1)); input.addEventListener("change", () => { row[key] = input.value === "" ? "" : Number(input.value); row.result = null; invalidateAssistant(); }); td.append(input); tr.append(td); });
      const settingCell = tr.children[1], native = nativeDisplay(row.setting), nativeLine = document.createElement("small"); text(nativeLine, "Native: " + native.label + " " + native.unit); nativeLine.className = native.value == null ? "unmapped" : "mapped"; nativeLine.setAttribute("aria-label", "native dial for shot " + (index + 1)); settingCell.append(document.createElement("br"), nativeLine);
      const tasteCell = document.createElement("td"); const taste = document.createElement("select"); ["none", "balanced", "sour", "bitter", "astringent", "weak", "channeling"].forEach((value) => { const option = document.createElement("option"); option.value = value; text(option, ({none: "No taste signal", sour: "Too sour", bitter: "Too bitter", astringent: "Too astringent"}[value] || value)); taste.append(option); }); taste.value = row.taste || "none"; taste.setAttribute("aria-label", "taste for shot " + (index + 1)); taste.addEventListener("change", () => { row.taste = taste.value; invalidateAssistant(); }); tasteCell.append(taste); const overall = document.createElement("select"); ["", "uncertain", "balanced", "under-extracted", "over-extracted"].forEach(value => { const option = document.createElement("option"); option.value = value; text(option, value || "Extraction unspecified"); overall.append(option); }); overall.value = row.overall || ""; overall.setAttribute("aria-label", "overall extraction for shot " + (index + 1)); overall.addEventListener("change", () => { row.overall = overall.value; invalidateAssistant(); }); tasteCell.append(overall); tr.append(tasteCell);
      const result = document.createElement("td"); text(result, row.result ? row.result.phase + " → " + row.result.returnedDdDum + " dD" : "planned"); tr.append(result);
      const action = document.createElement("td"); const button = document.createElement("button"); button.type = "button"; text(button, "Remove"); button.addEventListener("click", () => { invalidateAssistant(); rows.splice(index, 1); rows.forEach((r, i) => { if (r.actual !== "") consumeRow(r, i); }); render(); }); action.append(button); tr.append(action); body.append(tr);
    });
  }
  function svgNode(name, attrs) { const node = document.createElementNS("http://www.w3.org/2000/svg", name); Object.keys(attrs).forEach((key) => node.setAttribute(key, attrs[key])); return node; }
  function renderChart() {
    const holder = $("chart"); holder.replaceChildren();
    const completed = rows.filter(row => row.actual !== "" && Number(row.actual) > 0);
    const svg = svgNode("svg", { viewBox: "0 0 800 540", role: "presentation" });
    const c = config(), width = 690 / Math.max(completed.length, 1);
    const timeMax = Math.max(c.target * 1.4, ...completed.map(row => Number(row.actual)), 10);
    const traces = algorithmNames.map(name => engineRun(name));
    const settings = traces.flatMap(trace => trace ? trace.shots.map(pass => pass.output.returnedDdDum) : []);
    const settingMin = Math.min(c.start, ...settings), settingMax = Math.max(c.start + 1, ...settings);
    const pad = Math.max(10, (settingMax - settingMin) * .1), low = settingMin - pad, high = settingMax + pad;
    const label = (x, y, value) => { const node = svgNode("text", { x, y, fill: "currentColor", "font-size": 12 }); node.textContent = value; svg.append(node); };
    label(65, 18, "Brew time (seconds)"); label(65, 292, "Algorithm setting (dD) — separate scale");
    [0, .5, 1].forEach(fraction => {
      const y = 225 - fraction * 185;
      svg.append(svgNode("line", { x1: 65, y1: y, x2: 780, y2: y, stroke: "#526073" })); label(4, y + 4, (timeMax * fraction).toFixed(1) + " s");
      const sy = 510 - fraction * 190;
      svg.append(svgNode("line", { x1: 65, y1: sy, x2: 780, y2: sy, stroke: "#526073" })); label(4, sy + 4, Math.round(low + (high - low) * fraction));
    });
    completed.forEach((row, index) => {
      const x = 80 + index * width, y = 225 - Number(row.actual) / timeMax * 185, targetY = 225 - Number(row.target) / timeMax * 185;
      svg.append(svgNode("line", { x1: x, y1: 225, x2: x, y2: y, stroke: "#7dd3fc", "stroke-width": 9 }));
      svg.append(svgNode("line", { x1: x - 12, y1: targetY, x2: x + 12, y2: targetY, stroke: "#a7e57b", "stroke-width": 3 })); label(x, 246, "Shot " + (index + 1)); label(x, 534, index + 1);
    });
    const colors = ["#f59e0b", "#f472b6", "#c084fc", "#4ade80", "#fb7185"];
    traces.forEach((trace, index) => {
      if (!trace) return;
      const points = trace.shots.map((pass, shotIndex) => [80 + shotIndex * width, 510 - (pass.output.returnedDdDum - low) / (high - low) * 190]);
      if (points.length > 1) svg.append(svgNode("polyline", { points: points.map(point => point.join(",")).join(" "), fill: "none", stroke: colors[index], "stroke-width": 2 }));
      points.forEach(([cx, cy], shotIndex) => { const dot = svgNode("circle", { cx, cy, r: 3, fill: colors[index] }); const title = svgNode("title", {}), returned = trace.shots[shotIndex].output.returnedDdDum, native = nativeDisplay(returned); title.textContent = algorithmNames[index] + " shot " + (shotIndex + 1) + ": " + returned + " dD · native " + native.label + " " + native.unit; dot.append(title); svg.append(dot); });
    });
    holder.append(svg);
    renderDialPanel();
  }
  function renderFlowChart() {
    const holder = $("flow-chart"); if (!holder) return;
    holder.replaceChildren();
    const completed = rows.filter(row => row.actual !== "" && Number(row.actual) > 0);
    if (!completed.length) { const p = document.createElement("p"); p.className = "hint"; text(p, "Run a shot to plot recorded pressure and flow context."); holder.append(p); return; }
    const svg = svgNode("svg", { viewBox: "0 0 800 320", role: "presentation" });
    const maxFlow = Math.max(1, ...completed.map(row => Number(row.flow) || 0));
    const maxPressure = Math.max(1, ...completed.map(row => Number(row.pressure) || 0));
    const x = index => 80 + index * (690 / Math.max(completed.length - 1, 1));
    const yFlow = value => 270 - (Number(value) || 0) / maxFlow * 190;
    const yPressure = value => 270 - (Number(value) || 0) / maxPressure * 190;
    const label = (xPos, yPos, value) => { const node = svgNode("text", { x: xPos, y: yPos, fill: "currentColor", "font-size": 12 }); node.textContent = value; svg.append(node); };
    label(10, 24, "Pressure (bar) and flow (g/s) by completed pass");
    [[completed.map((row, index) => [x(index), yFlow(row.flow)]), "#7dd3fc", "Flow"], [completed.map((row, index) => [x(index), yPressure(row.pressure)]), "#f59e0b", "Pressure"]].forEach(([points, color, name]) => {
      svg.append(svgNode("polyline", { points: points.map(point => point.join(",")).join(" "), fill: "none", stroke: color, "stroke-width": 3 }));
      points.forEach(([cx, cy], index) => { const dot = svgNode("circle", { cx, cy, r: 4, fill: color }); const title = svgNode("title", {}); title.textContent = name + " pass " + (index + 1) + ": " + (name === "Flow" ? completed[index].flow + " g/s" : completed[index].pressure + " bar"); dot.append(title); svg.append(dot); });
    });
    completed.forEach((row, index) => { const passLabel = svgNode("text", { x: x(index) - 8, y: 292, fill: "currentColor", "font-size": 12 }); passLabel.textContent = String(index + 1); svg.append(passLabel); if (Number(row.preinfusionSec) > 0) { const phase = svgNode("line", { x1: x(index) - 10, y1: 45, x2: x(index) - 10, y2: 270, stroke: "#c084fc", "stroke-dasharray": "4 4" }); const title = svgNode("title", {}); title.textContent = "Preinfusion: " + row.preinfusionSec + " s at " + row.preinfusionPressure + " bar"; phase.append(title); svg.append(phase); } });
    const legend = document.createElement("p"); legend.className = "hint"; text(legend, "Blue = recorded/simulated flow; amber = recorded/simulated pressure; purple markers = preinfusion context. These pass averages are not a replacement for timestamped DFlow traces.");
    holder.append(svg, legend);
  }
  function compare() {
    const holder = $("compare"); holder.replaceChildren(); text($("comparison-count"), rows.length + " passes");
    if (!rows.length) { const p = document.createElement("p"); p.className = "hint"; text(p, "Run one or more shots to compare them."); holder.append(p); return; }
    algorithmNames.forEach((name) => { const engineTrial = engineRun(name); const trial = engineTrial && engineTrial.shots.length ? engineTrial.shots[engineTrial.shots.length - 1].output : null; const card = document.createElement("article"); const h = document.createElement("h3"); text(h, name); const p = document.createElement("p"); const native = trial ? nativeDisplay(trial.returnedDdDum) : null; text(p, trial ? "Next: " + trial.returnedDdDum + " dD · native " + native.label + " " + native.unit + " · " + trial.phase : "Needs a completed shot"); card.append(h, p); if (viewMode === "expert" && trial) { const detail = document.createElement("p"); detail.className = "hint"; text(detail, "Candidate " + trial.candidateDdDum + " dD · returned " + trial.returnedDdDum + " dD · " + (trial.committed ? "committed" : trial.locked ? "held/locked" : "available") + "."); card.append(detail); } holder.append(card); });
  }
  let catalogSources = [];
  let referencePage = 1;
  let coffeeCatalogProducts = [];
  let coffeeCatalogPage = 1;
  let coffeeCatalogUnavailable = false;
  const factLabels = { doseG: "Dose (g)", yieldG: "Beverage yield (g)", waterG: "Water (g)", brewTimeSec: "Brew time (s)", temperatureC: "Temperature (°C)", brewRatio: "Brew ratio", rpm: "RPM", burrDiameterMm: "Burr diameter (mm)", tastingNotes: "Roaster tasting notes" };
  function factLabel(key) { return factLabels[key] || key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, letter => letter.toUpperCase()); }
  function factValue(value) {
    if (Array.isArray(value)) return value.map(factValue).join("; ");
    if (value && typeof value === "object") {
      if (Number.isFinite(value.min) && Number.isFinite(value.max)) return value.min + "–" + value.max + (value.unit ? " " + value.unit.replace("C", "°C") : "");
      return Object.entries(value).map(([key, child]) => factLabel(key) + ": " + factValue(child)).join(", ");
    }
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return String(value);
  }
  function renderCatalog() {
    const holder = $("catalog"); if (!holder) return; holder.replaceChildren();
    const query = $("catalog-search").value.trim().toLowerCase();
    const visible = catalogSources.filter((source) => JSON.stringify(source).toLowerCase().includes(query));
    if (!visible.length) { const p = document.createElement("p"); p.className = "hint"; text(p, "No matching reviewed references."); holder.append(p); return; }
    visible.slice(0, referencePage * 12).forEach((source) => { const card = document.createElement("article"); const h = document.createElement("h3"); text(h, source.title); const p = document.createElement("p"); text(p, source.publisher + " · " + source.kind); const facts = document.createElement("p"); text(facts, Object.entries(source.facts || {}).map(([key, value]) => factLabel(key) + ": " + factValue(value)).join(" · ")); const scope = document.createElement("p"); text(scope, "Applies to: " + Object.values(source.scope || {}).join(" · ")); const notes = document.createElement("p"); text(notes, (source.notes || []).join(" ")); const link = document.createElement("a"); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer"; text(link, "Open source"); card.append(h, p, scope, facts, notes, link); const brewTime = source.facts && source.facts.brewTimeSec; if (source.scope && source.scope.brewMethod === "espresso" && brewTime != null) { const button = document.createElement("button"); button.type = "button"; text(button, "Use as espresso starting point"); button.addEventListener("click", () => { reset(); const midpoint = value => typeof value === "number" ? value : value && Number.isFinite(value.min) && Number.isFinite(value.max) ? (value.min + value.max) / 2 : null; const dose = midpoint(source.facts.doseG); const yieldG = midpoint(source.facts.yieldG); const time = midpoint(brewTime); $("roaster").value = source.publisher || ""; if (source.scope.coffee) $("bean").value = source.scope.coffee; if (Number.isFinite(dose)) $("dose").value = dose; if (Number.isFinite(yieldG)) $("yield").value = yieldG; if (Number.isFinite(time)) $("target").value = time; setNotice("Applied available espresso dose, yield and time as a new starting point; published ranges use their midpoint. Unspecified targets stay unchanged. Confirm the coffee and equipment."); }); card.append(document.createTextNode(" "), button); } holder.append(card); });
    if (visible.length > referencePage * 12) { const more = document.createElement("button"); text(more, "Show 12 more references"); more.addEventListener("click", () => { referencePage++; renderCatalog(); }); holder.append(more); }
  }
  function renderCoffeeCatalog() {
    const holder = $("coffee-catalog"); if (!holder) return; if (coffeeCatalogUnavailable) { showResourceRetry(holder, "Coffee catalogue unavailable. You can still enter your coffee by hand.", "Retry coffee catalogue", loadCoffeeCatalog); return; } holder.replaceChildren(); const query = ($( "coffee-catalog-search")?.value || "").trim().toLowerCase(); const products = coffeeCatalogProducts.filter(product => JSON.stringify(product).toLowerCase().includes(query));
    products.slice(0, coffeeCatalogPage * 10).forEach(product => { const card = document.createElement("article"); const h = document.createElement("h3"); text(h, product.name || product.title || "Unnamed coffee"); const p = document.createElement("p"); text(p, [product.publisher, product.category, product.roastLevel].filter(Boolean).join(" · ") || "Metadata incomplete"); const button = document.createElement("button"); button.type = "button"; text(button, "Use explicit fields"); button.addEventListener("click", () => { if (product.beanEligible !== true) { setNotice("This catalogue entry lacks confirmed whole-bean format. Keep it as a reference and confirm the physical product separately.", true); return; } reset(); if (product.name) $("bean").value = product.name; if (product.species) $("species").value = product.species; if (product.roastLevel) $("roast").value = product.roastLevel; if (product.publisher) $("roaster").value = product.publisher; setNotice("Applied explicit catalogue fields only. Confirm the bean batch and equipment before brewing."); }); card.append(h, p, button); holder.append(card); });
    if (products.length > coffeeCatalogPage * 10) { const more = document.createElement("button"); more.type = "button"; text(more, "Show 10 more coffees (" + (products.length - coffeeCatalogPage * 10) + " remaining)"); more.addEventListener("click", () => { coffeeCatalogPage += 1; renderCoffeeCatalog(); }); holder.append(more); }
    if (!products.length) { const p = document.createElement("p"); p.className = "hint"; text(p, "No matching coffee catalogue entries."); holder.append(p); }
  }
  function loadCatalog() {
    fetch("../data/reference-catalog.json", { credentials: "same-origin" }).then((response) => { if (!response.ok) throw new Error("reference catalog unavailable"); return response.json(); }).then((catalog) => { if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.sources)) throw new Error("unsupported reference catalog"); catalogSources = catalog.sources.filter((source) => typeof source.url === "string" && source.url.startsWith("https://")); text($("catalog-status"), catalogSources.length + " reviewed"); renderCatalog(); }).catch((error) => { text($("catalog-status"), "Unavailable"); const holder = $("catalog"); const p = document.createElement("p"); p.className = "hint"; text(p, error.message); holder.append(p); });
  }
  function showResourceRetry(holder, message, label, retry) {
    if (!holder) return;
    const note = document.createElement("p"), button = document.createElement("button");
    note.className = "hint"; text(note, message); button.type = "button"; text(button, label);
    button.addEventListener("click", () => { button.disabled = true; text(button, "Retrying…"); return retry(); });
    holder.replaceChildren(note, button);
  }
  function loadCoffeeCatalog() { return fetch("../data/coffee-catalog.json", { credentials: "same-origin" }).then(response => { if (!response.ok) throw new Error("coffee catalogue unavailable"); return response.json(); }).then(value => { if (!Array.isArray(value?.products)) throw new Error("unsupported coffee catalogue"); coffeeCatalogProducts = value.products; coffeeCatalogUnavailable = false; renderCoffeeCatalog(); }).catch(() => { coffeeCatalogUnavailable = true; renderCoffeeCatalog(); }); }
  function loadDialProfiles() {
    return fetch("../data/grinder-dials.json", { credentials: "same-origin" }).then(response => { if (!response.ok) throw new Error("dial profiles unavailable"); return response.json(); }).then(value => { const list = value && Array.isArray(value.models) ? value.models : []; if (!list.length) throw new Error("unsupported grinder references"); $("grinder-load-status")?.replaceChildren(); dialMetadata = Object.fromEntries(list.filter(profile => profile && profile.model).map(profile => [profile.model, profile])); const select = $("grinder"), selected = (select && select.value) || activeProfile()?.model; if (select && list.length) { select.replaceChildren(); list.forEach(profile => { const option = document.createElement("option"); option.value = profile.model; text(option, profile.model + " · " + (profile.unit || "native")); select.append(option); }); select.value = list.some(profile => profile.model === selected) ? selected : list[0].model; } renderInstanceManager(); renderDialPanel(); applyNativeDefaults(); renderSimpleRecipe(); }).catch(() => showResourceRetry($("grinder-load-status"), "Extra grinder references unavailable. You can keep using your selected grinder and enter its settings yourself.", "Retry grinder references", loadDialProfiles));
  }
  function render() { renderSimpleRecipe(); renderTable(); renderChart(); renderFlowChart(); compare(); renderCatalog(); compareAllCalculators(); }
  function inputField(id, label, value, step) { const wrapper = document.createElement("label"); text(wrapper, label); const input = document.createElement("input"); input.id = id; input.type = "number"; input.value = value; input.step = step || "1"; wrapper.append(input); return wrapper; }
  function renderHelperFields() {
    const holder = $("helper-fields"); holder.replaceChildren();
    const type = $("helper").value;
    if (type === "manual") { const profile = document.createElement("label"); text(profile, "Grinder profile"); const profileSelect = document.createElement("select"); profileSelect.id = "h-profile"; [["df54", "DF54"], ["df64_gen1", "DF64 Gen 1"], ["df64_gen2", "DF64 Gen 2"]].forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; text(option, label); profileSelect.append(option); }); profile.append(profileSelect); const direction = document.createElement("label"); text(direction, "Finer direction"); const directionSelect = document.createElement("select"); directionSelect.id = "h-direction"; [["", "Use profile default"], ["clockwise", "Clockwise"], ["counterclockwise", "Counter-clockwise"]].forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; text(option, label); directionSelect.append(option); }); direction.append(directionSelect); const sign = document.createElement("label"); text(sign, "Numeric finer sign"); const signSelect = document.createElement("select"); signSelect.id = "h-sign"; [["", "Not calibrated"], ["1", "+1"], ["-1", "-1"]].forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; text(option, label); signSelect.append(option); }); sign.append(signSelect); holder.append(profile, inputField("h-target", "Target seconds", 28, .1), inputField("h-actual", "Actual seconds", 32, .1), inputField("h-dial", "Current dial", 20), inputField("h-step", "Step marks", 1, .1), direction, sign); }
    if (type === "wizard") { const model = document.createElement("label"); text(model, "Grinder"); const modelSelect = document.createElement("select"); modelSelect.id = "h-model"; [["e64", "E64"], ["e65", "E65"], ["e80", "E80"]].forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; text(option, label); modelSelect.append(option); }); model.append(modelSelect); const roast = document.createElement("label"); text(roast, "Roast"); const roastSelect = document.createElement("select"); roastSelect.id = "h-roast"; ["light", "medium", "dark"].forEach((value) => { const option = document.createElement("option"); text(option, value); roastSelect.append(option); }); roast.append(roastSelect); holder.append(model, roast, inputField("h-weight", "Dose (g)", 18, .1)); const note = document.createElement("p"); note.className = "hint"; text(note, "The firmware coordinate unit is unknown; this is a model-and-roast starting coordinate, not micrometres."); holder.append(note); }
    if (type === "effective") holder.append(inputField("h-grind", "Grind coordinate (dD)", 500), inputField("h-duration", "Grind duration (ms)", 3000), inputField("h-baseline", "Explicit baseline (dD)", 500), inputField("h-residue", "Previous residue (dD)", 500));
    if (type === "grindtime") { const mode = document.createElement("label"); text(mode, "Firmware mode"); const select = document.createElement("select"); select.id = "h-mode"; [1, 2, 3].forEach((value) => { const option = document.createElement("option"); option.value = value; text(option, "Mode " + value); select.append(option); }); mode.append(select); holder.append(mode, inputField("h-recipe-dd", "Recipe coordinate (µm)", 50), inputField("h-target-dd", "Target coordinate (dD)", 500), inputField("h-recipe-time", "Recipe time (ms)", 3000)); }
    if (type === "inverse") holder.append(inputField("h-p1x", "Point 1 setting (µm)", 50), inputField("h-p1y", "Point 1 seconds", 32, .1), inputField("h-p2x", "Point 2 setting (µm)", 60), inputField("h-p2y", "Point 2 seconds", 25, .1), inputField("h-inverse-target", "Target seconds", 28, .1));
  }
  function helperValue(id) { return Number($(id).value); }
  function runHelper() {
    try {
      const type = $("helper").value; let value;
      if (type === "manual") value = algorithms.manual({ profile: $("h-profile").value, targetTimeSec: helperValue("h-target"), actualTimeSec: helperValue("h-actual"), currentDial: helperValue("h-dial"), stepMarks: helperValue("h-step"), flavor: ({sour: "too sour", bitter: "too bitter", astringent: "too astringent"}[$("assist-taste").value] || $("assist-taste").value), finerDirection: $("h-direction").value || undefined, numericFinerDelta: $("h-sign").value === "" ? undefined : Number($("h-sign").value) });
      if (type === "wizard") value = algorithms.proposedDd({ model: $("h-model").value, roast: $("h-roast").value, weightMg: helperValue("h-weight") * 1000 });
      if (type === "effective") value = algorithms.effectiveDd({ residue: helperValue("h-residue") / 10 }, { grindDdDum: Math.round(helperValue("h-grind")), grindDurationMs: Math.round(helperValue("h-duration")), effectiveBaseline: helperValue("h-baseline") / 10 });
      if (type === "grindtime") value = algorithms.grindTime({ mode: Number($("h-mode").value), recipeDdUm: Math.round(helperValue("h-recipe-dd")), targetDdDum: Math.round(helperValue("h-target-dd")), recipeTimeMs: Math.round(helperValue("h-recipe-time")) });
      if (type === "inverse") value = algorithms.inverseRegression([{ x: helperValue("h-p1x"), y: helperValue("h-p1y") }, { x: helperValue("h-p2x"), y: helperValue("h-p2y") }], helperValue("h-inverse-target"));
      const out = $("helper-result"); out.replaceChildren(); const summary = document.createElement("p"); const readable = typeof value === "number" ? "Estimated coordinate: " + value + " µm" : value.adjustedTimeMs !== undefined ? (value.optional ? "Mode 3 adjusted grind time: " + value.adjustedTimeMs + " ms." : "This mode does not adjust grind time.") : value.direction ? "Direction: " + value.direction + ". " + (value.reasons || []).join(" ") : value.result != null ? "Effective setting result: " + value.result + " dD." : "Suggested setting: " + (value.proposedDd ?? "not available") + "."; text(summary, readable); const details = document.createElement("details"); const caption = document.createElement("summary"); text(caption, "Show calculation details"); const pre = document.createElement("pre"); text(pre, JSON.stringify(value, null, 2)); details.append(caption, pre); out.append(summary, details);
    } catch (error) { const out = $("helper-result"); out.replaceChildren(); const p = document.createElement("p"); text(p, error.message); out.append(p); }
  }
  async function runAssistant() {
    const generation = ++assistantGeneration, c = config();
    try {
      if (importedShot) return await runImportedAssistant(generation);
      if (!simulationEngine || typeof simulationEngine.replayRichSuggestions !== "function") throw new Error("The rich suggestion replay engine is not loaded yet.");
      const factory = window.createPlugin || window.DecaidCreatePlugin;
      if (typeof factory !== "function") throw new Error("The shipped plugin factory is not exposed on this page yet.");
      if (!rows.some(row => row.actual !== "" && Number(row.actual) > 0)) throw new Error("Brew a shot or enter a measured time before asking for a suggestion.");
      const replay = await simulationEngine.replayRichSuggestions(factory, engineScenario(), { now: Date.now(), catalog: { bean: { name: c.bean, roaster: c.roaster, species: c.species }, batch: { roastLevel: c.roast } }, workflow: { profile: { name: "Fictional pressure experiment", steps: [{ pump: "pressure", pressure: 9 }] }, context: { beanBatchId: c.bean, grinderId: c.grinderId, grinderModel: c.grinder, grinderBurrs: c.burrs, targetDoseWeight: c.dose, targetYield: c.yield, grinderSetting: String(c.start), extras: { calibrationEpoch: c.calibration, beanType: c.species, roastLevel: c.roast, basket: "standard", grinderSettingUnit: "deci-micrometre", grinderInstanceId: c.grinderId } } }, settings: { TargetTimeSec: String(c.target), TimeToleranceSec: String(c.tolerance), CurrentSetting: String(c.start), SettingUnit: "deci-micrometre", BeanBatchId: c.bean, GrinderId: c.grinderId, GrinderModel: c.grinder, BurrIdentity: c.burrs, CalibrationEpoch: c.calibration, BeanType: c.species, RoastLevel: c.roast, Dose: String(c.dose), Yield: String(c.yield) } });
      if (generation !== assistantGeneration) return;
      const out = $("assist-result"); out.replaceChildren(); replay.suggestions.forEach((entry) => { const article = document.createElement("article"); const h = document.createElement("h3"); text(h, "Pass " + entry.shotId + " · " + (entry.stage || entry.suggestion?.status || "unavailable")); const p = document.createElement("p"); const suggestion = entry.suggestion || {}; text(p, (suggestion.direction || "retain / gather evidence") + " · confidence " + (suggestion.confidence || "not assigned") + " · evidence " + entry.evidenceCount + " comparable shot(s)"); const bean = document.createElement("p"); bean.className = "hint"; text(bean, "Bean context: " + c.bean + " · " + c.species + " · " + c.roast + ". " + (suggestion.reason || replay.disclaimer)); article.append(h, p, bean); const references = suggestion.reviewedReferences?.matches || []; references.forEach(source => { const link = document.createElement("a"); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer"; text(link, source.title); article.append(link, document.createElement("br")); }); out.append(article); });
    } catch (error) { setNotice(error.message, true); }
  }
  function watchContextChanges() {
    ["bean", "roaster", "species", "roast", "calibration", "grinder", "burrs", "dose", "yield", "target", "tolerance", "start"].forEach((id) => $(id).addEventListener("change", () => {
      if (id === "grinder") { clearSimpleSetup(); const match = grinderInstances.find(profile => profile.model === $("grinder").value); if (match) setActiveProfile(match.id, false); else { const profile = profileFromTemplate({model: $("grinder").value}, grinderInstances.length); grinderInstances.push(profile); setActiveProfile(profile.id, false); } return; }
      if (["calibration", "burrs"].includes(id)) { clearSimpleSetup(); const profile = activeProfile(); if (profile) { profile.burrIdentity = $("burrs").value; profile.calibrationEpoch = $("calibration").value; profile.anchors = null; persistProfiles(); } dialCalibration = null; }
      if (["bean", "roaster", "species", "roast", "dose", "yield", "burrs", "calibration"].includes(id)) { $("simple-clock-confirmed").checked = false; $("simple-pressure-confirmed").checked = false; }
      reset(true); renderDialPanel(); applyNativeDefaults(); setNotice(viewMode === "simple" ? "Your setup changed. Old shots stay in history; only matching shots can be compared." : "Setup changed, so old shot history and dial calibration were reset to keep context honest.");
    }));
    $("simple-profile-name")?.addEventListener("change", () => { simpleEditingShot = false; $("simple-pressure-confirmed").checked = false; invalidateSimpleAdvice(); });
    $("grinder-instance").addEventListener("change", () => setActiveProfile($("grinder-instance").value, true));
  }
  function scenario() { return { version: 1, setup: { ...config(), viewMode, grinderInstances: grinderInstances.map(profile => ({ ...profile, anchors: profile.anchors ? { ...profile.anchors } : null })), activeGrinderInstanceId: activeInstanceId }, shots: rows.map((row) => ({ setting: row.setting, actual: row.actual, target: row.target, pressure: row.pressure, flow: row.flow, preinfusionSec: row.preinfusionSec || 0, preinfusionPressure: row.preinfusionPressure || 0, taste: row.taste || "none", overall: row.overall || "", context: row.context || null })) }; }
  function download() { const blob = new Blob([JSON.stringify(scenario(), null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "dial-in-scenario.json"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); }
  function validImportNumber(value, min, max, integer) {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
  }
  function validateScenario(value) {
    if (!value || Object.keys(value).some(key => !["version", "setup", "shots"].includes(key)) || value.version !== 1 || !value.setup || typeof value.setup !== "object" || Array.isArray(value.setup) || !Array.isArray(value.shots) || value.shots.length > 100) throw new Error("Unsupported scenario format.");
    const setup = value.setup; const setupKeys = new Set(["algorithm", "target", "tolerance", "start", "plant", "noise", "pressure", "flow", "preinfusionSec", "preinfusionPressure", "bean", "roaster", "species", "roast", "calibration", "grinder", "grinderId", "burrs", "dose", "yield", "viewMode", "dialCalibration", "grinderInstances", "activeGrinderInstanceId"]); if (Object.keys(setup).some((key) => !setupKeys.has(key))) throw new Error("Scenario setup has an unknown field.");
    if (!algorithmNames.includes(setup.algorithm) || !validImportNumber(setup.target, 1, 600, false) || !validImportNumber(setup.start, 0, 100000, true) || !validImportNumber(setup.tolerance, 0, 60, false) || !validImportNumber(setup.plant, .2, 2, false) || !validImportNumber(setup.noise, 0, 10, false) || !validImportNumber(setup.pressure, 0, 15, false) || !validImportNumber(setup.flow, 0, 20, false) || !validImportNumber(setup.dose, 1, 100, false) || !validImportNumber(setup.yield, 1, 200, false) || (setup.preinfusionSec != null && !validImportNumber(setup.preinfusionSec, 0, 30, false)) || (setup.preinfusionPressure != null && !validImportNumber(setup.preinfusionPressure, 0, 15, false)) || (setup.viewMode != null && !["simple", "expert"].includes(setup.viewMode))) throw new Error("Scenario setup contains an invalid or out-of-range value.");
    ["bean", "species", "roast", "calibration", "grinder", "burrs"].forEach(key => {
      if (typeof setup[key] !== "string" || !setup[key].trim() || setup[key].length > 256) throw new Error("Setup " + key + " must be a non-empty text value.");
    });
    if (setup.roaster != null && (typeof setup.roaster !== "string" || setup.roaster.length > 256)) throw new Error("Invalid roaster name.");
    if (setup.dialCalibration != null) { const calibration = setup.dialCalibration, textKeys = ["model", "burrIdentity", "calibrationEpoch", "grinderId"], numberKeys = ["dialMin", "dialMax", "dialA", "ddDumA", "dialB", "ddDumB"]; if (typeof calibration !== "object" || Array.isArray(calibration) || Object.keys(calibration).some(key => !textKeys.concat(numberKeys).includes(key)) || textKeys.some(key => typeof calibration[key] !== "string" || !calibration[key].trim() || calibration[key].length > 256) || numberKeys.some(key => !validImportNumber(calibration[key], -2147483648, 2147483647, false)) || calibration.dialA === calibration.dialB || calibration.ddDumA === calibration.ddDumB) throw new Error("Invalid dial calibration anchors."); }
    if (setup.dialCalibration != null) { try { const mapped = algorithms.toGrinderDial({ model: setup.grinder, ddDum: setup.start, burrIdentity: setup.burrs, calibrationEpoch: setup.calibration, grinderId: setup.dialCalibration.grinderId, calibration: setup.dialCalibration }); if (mapped.status !== "normalized") throw new Error((mapped.warnings || ["dial calibration cannot map this scenario"])[0]); } catch (error) { throw new Error("Invalid dial calibration: " + error.message); } }
    if (setup.grinderId != null && (typeof setup.grinderId !== "string" || !setup.grinderId.trim() || setup.grinderId.length > 128)) throw new Error("Invalid active grinder profile ID.");
    if (setup.activeGrinderInstanceId != null && (typeof setup.activeGrinderInstanceId !== "string" || !setup.activeGrinderInstanceId.trim() || setup.activeGrinderInstanceId.length > 128)) throw new Error("Invalid active grinder profile ID.");
    if (setup.grinderInstances != null) {
      if (!Array.isArray(setup.grinderInstances) || setup.grinderInstances.length < 1 || setup.grinderInstances.length > 100 || setup.grinderInstances.some(profile => !validProfile(profile)) || new Set(setup.grinderInstances.map(profile => profile.id)).size !== setup.grinderInstances.length) throw new Error("Invalid individual grinder profiles.");
      const existingById = new Map(grinderInstances.map(profile => [profile.id, profile]));
      setup.grinderInstances.forEach(profile => { const existing = existingById.get(profile.id); if (existing && JSON.stringify(existing) !== JSON.stringify(profile)) throw new Error("Imported grinder profile ID conflicts with an existing unit."); });
      if (setup.activeGrinderInstanceId && !setup.grinderInstances.some(profile => profile.id === setup.activeGrinderInstanceId)) throw new Error("Imported active grinder profile is missing.");
    }
    value.shots.forEach(row => {
      if (row.context != null) {
        const allowed = ["bean", "species", "roast", "grinder", "grinderId", "burrs", "calibration", "dose", "yield", "preinfusionSec", "preinfusionPressure"];
        if (Object.keys(row.context).some(key => !allowed.includes(key))) throw new Error("Shot context has an unknown field.");
        allowed.filter(key => !["dose", "yield", "preinfusionSec", "preinfusionPressure"].includes(key)).forEach(key => { if (typeof row.context[key] !== "string" || !row.context[key].trim() || row.context[key].length > 256) throw new Error("Invalid historical shot context."); });
        if (!validImportNumber(row.context.dose, 1, 100) || !validImportNumber(row.context.yield, 1, 200)) throw new Error("Invalid historical shot recipe.");
      }
    });
    value.shots.forEach((row) => { if (!row || typeof row !== "object" || Object.keys(row).some((key) => !["setting", "actual", "target", "pressure", "flow", "preinfusionSec", "preinfusionPressure", "taste", "overall", "context"].includes(key)) || !validImportNumber(row.setting, 0, 100000, true) || !validImportNumber(row.target, 1, 600, false) || !validImportNumber(row.pressure, 0, 15, false) || !validImportNumber(row.flow, 0, 20, false) || (row.preinfusionSec != null && !validImportNumber(row.preinfusionSec, 0, 30, false)) || (row.preinfusionPressure != null && !validImportNumber(row.preinfusionPressure, 0, 15, false)) || (row.overall != null && !["", "under-extracted", "over-extracted", "balanced", "uncertain"].includes(row.overall)) || (row.actual !== "" && !validImportNumber(row.actual, 0.1, 600, false)) || !["none", "balanced", "sour", "bitter", "astringent", "weak", "channeling"].includes(row.taste || "none") || (row.context != null && (typeof row.context !== "object" || Array.isArray(row.context) || JSON.stringify(row.context).length > 4096))) throw new Error("Scenario contains an invalid shot."); });
  }
  function importFile(event) { const file = event.target.files && event.target.files[0]; if (!file) return; if (file.size > 256 * 1024) { setNotice("Scenario file is too large.", true); return; } const reader = new FileReader(); reader.onload = () => { try { const value = JSON.parse(String(reader.result)); if (value.setup && value.setup.dialCalibration && !value.setup.dialCalibration.grinderId) value.setup.dialCalibration = { ...value.setup.dialCalibration, grinderId: value.setup.activeGrinderInstanceId || value.setup.grinderId || activeInstanceId }; validateScenario(value); simulationEngine.run(engineScenario(value.shots, value.setup)); const importedProfiles = Array.isArray(value.setup.grinderInstances) ? value.setup.grinderInstances.map(profile => ({ ...profile, anchors: profile.anchors ? { ...profile.anchors } : null })) : null; if (importedProfiles) grinderInstances = importedProfiles; const inputIds = { preinfusionSec: "preinfusion", preinfusionPressure: "preinfusion-pressure", viewMode: "view-mode" }; Object.keys(value.setup).forEach((key) => { if (["dialCalibration", "grinderInstances", "activeGrinderInstanceId", "grinderId"].includes(key)) return; const input = $(inputIds[key] || key); if (input && typeof value.setup[key] === "string") input.value = value.setup[key]; else if (input) input.value = String(value.setup[key]); }); activeInstanceId = value.setup.activeGrinderInstanceId || value.setup.grinderId || activeInstanceId; if (!grinderInstances.some(profile => profile.id === activeInstanceId)) activeInstanceId = grinderInstances[0].id; const profile = activeProfile(); $("grinder").value = profile.model; $("burrs").value = profile.burrIdentity; $("calibration").value = profile.calibrationEpoch; dialCalibration = profileCalibration(profile) || value.setup.dialCalibration || null; if (profile && value.setup.dialCalibration) { profile.anchors = { ...value.setup.dialCalibration, grinderId: activeInstanceId }; dialCalibration = profileCalibration(profile); } clearSimpleSetup(); clearSimpleShots(); viewMode = value.setup.viewMode || viewMode; document.body.classList.toggle("simple-mode", viewMode === "simple"); if ($("view-mode")) $("view-mode").value = viewMode; invalidateAssistant(); persistProfiles(); renderInstanceManager(); rows = value.shots.map((row) => ({ ...row, result: null })); rows.forEach((row, index) => { if (row.actual !== "") consumeRow(row, index); }); render(); showResult(rows.length ? rows[rows.length - 1].result : null); setNotice("Scenario imported and replayed safely."); } catch (error) { setNotice(error.message, true); } }; reader.readAsText(file); }
  let uiTools, supplemental, importedShot = null, importedMetrics = null, importedFeedback = {}, assistantGeneration = 0, traceGeneration = 0;
  function invalidateAssistant() { assistantGeneration++; compareAllCalculators(); const holder = $("assist-result"); if (holder) { holder.replaceChildren(); text(holder, "Evidence changed. Run the assessment again."); } }
  function clearImportedTrace() { traceGeneration++; importedShot = null; importedMetrics = null; importedFeedback = {}; if ($("manual-stop-confirmed")) $("manual-stop-confirmed").checked = false; $("actual-shot-trace")?.replaceChildren(); if ($("actual-shot-details")) text($("actual-shot-details"), ""); if ($("shot-trace-status")) text($("shot-trace-status"), "No saved trace imported."); if ($("actual-shot-time")) $("actual-shot-time").value = ""; invalidateAssistant(); }
  function useImportedClock() { const clock = $("actual-shot-clock")?.value || "pump", measured = importedMetrics?.timing?.[clock]; const input = $("actual-shot-time"); if (input) input.value = measured && (clock === "recording" || measured.complete) && Number.isFinite(measured.durationSec) ? String(measured.durationSec) : ""; invalidateAssistant(); }
  function importShotTrace(event) {
    const file = event.target.files?.[0]; if (!file) return; const generation = ++traceGeneration;
    if (file.size > 4 * 1024 * 1024) { setNotice("Saved shot exceeds the 4 MiB limit. Existing trace retained.", true); return; }
    const reader = new FileReader(); reader.onload = () => { if (generation !== traceGeneration) return; try { const parsed = JSON.parse(String(reader.result)), shot = parsed.shot || parsed; if (!shot || typeof shot !== "object" || Array.isArray(shot) || !Array.isArray(shot.measurements) || shot.measurements.length > 20000 || !Number.isFinite(Date.parse(shot.timestamp))) throw new Error("Use a full saved shot with a valid timestamp and at most 20,000 measurements."); const metrics = window.createBrewMetrics().analyze(shot, null); if (!metrics.trace?.points?.length) throw new Error("The shot has no valid timestamped trace. Existing trace retained."); const feedback = parsed.shot && parsed.feedback || {}; if (feedback.taste != null && !["balanced","sour","bitter","astringent","weak","channeling"].includes(feedback.taste)) throw new Error("Invalid saved taste feedback."); if (feedback.manualStopConfirmed != null && typeof feedback.manualStopConfirmed !== "boolean") throw new Error("Invalid manual-stop confirmation: expected a boolean."); const flavour = feedback.flavour || {}; if (flavour.overall && !["under-extracted","over-extracted","balanced","uncertain"].includes(flavour.overall)) throw new Error("Invalid overall feedback."); if (flavour.tastingTemperatureC != null && (!Number.isFinite(flavour.tastingTemperatureC) || flavour.tastingTemperatureC < 0 || flavour.tastingTemperatureC > 150)) throw new Error("Invalid tasting temperature."); if (flavour.sinceBrewMin != null && (!Number.isFinite(flavour.sinceBrewMin) || flavour.sinceBrewMin < 0 || flavour.sinceBrewMin > 10080)) throw new Error("Invalid tasting delay."); if (feedback.brewTimeSec != null && (!Number.isFinite(feedback.brewTimeSec) || feedback.brewTimeSec <= 0 || feedback.brewTimeSec > 600 || !["pump","pouring","recording"].includes(feedback.brewTimeClock || "pump"))) throw new Error("Invalid saved timing feedback."); importedShot = shot; importedMetrics = metrics; importedFeedback = feedback; if ($("manual-stop-confirmed")) $("manual-stop-confirmed").checked = feedback.manualStopConfirmed === true; $("assist-taste").value = feedback.taste || ""; if ($("assist-overall")) $("assist-overall").value = flavour.overall || ""; if ($("taste-temperature")) $("taste-temperature").value = flavour.tastingTemperatureC ?? ""; if ($("taste-minutes")) $("taste-minutes").value = flavour.sinceBrewMin ?? ""; uiTools.renderTrace($("actual-shot-trace"), metrics); text($("actual-shot-details"), JSON.stringify(metrics, null, 2)); text($("shot-trace-status"), "Imported " + (shot.id || "unnamed saved shot") + ": " + shot.measurements.length + " records. Actual saved profile steps remain authoritative."); useImportedClock(); if (feedback.brewTimeSec != null) { $("actual-shot-clock").value = feedback.brewTimeClock || "pump"; $("actual-shot-time").value = String(feedback.brewTimeSec); } invalidateAssistant(); setNotice("Real saved-shot measurements analysed. Synthetic pass history was not rewritten."); } catch (error) { setNotice(error.message, true); } }; reader.onerror = () => setNotice("Could not read this saved shot. Existing trace retained.", true); reader.readAsText(file);
  }
  function currentImportedFeedback() {
    const flavour = {}; const overall = $("assist-overall")?.value; if (overall) flavour.overall = overall; const temperature = $("taste-temperature")?.value, minutes = $("taste-minutes")?.value;
    if (temperature !== undefined && temperature !== "") flavour.tastingTemperatureC = Number(temperature);
    if (minutes !== undefined && minutes !== "") flavour.sinceBrewMin = Number(minutes);
    const actual = $("actual-shot-time")?.value;
    return {shotId: importedShot.id || "imported-shot", good: false, manualStopConfirmed: $("manual-stop-confirmed")?.checked === true, taste: $("assist-taste").value || null, flavour: Object.keys(flavour).length ? flavour : null, ...(actual ? {brewTimeSec: Number(actual), brewTimeClock: $("actual-shot-clock").value} : {})};
  }
  async function runImportedAssistant(generation) {
    const shot = JSON.parse(JSON.stringify(importedShot)), feedback = currentImportedFeedback(), c = config(); shot.id = feedback.shotId;
    const response = value => ({ok: true, status: 200, json: async () => value}); let instance; const store = {};
    const host = {log() {}, storage(event) { if (event.type === "read") queueMicrotask(() => instance.onEvent({name: "storageRead", payload: {key: event.key, value: store[event.key] || null}})); if (event.type === "write") { store[event.key] = event.data; queueMicrotask(() => instance.onEvent({name: "storageWrite", payload: {key: event.key}})); } }};
    instance = window.createPlugin(host, {fetch: async url => { const path = new URL(url).pathname; if (path === "/api/v1/workflow") return response(shot.workflow || {}); if (path === "/api/v1/shots") return response({items: [shot], total: 1}); if (path === "/api/v1/shots/" + encodeURIComponent(shot.id)) return response(shot); const bean = shot.bean || shot.workflow?.context?.bean, batch = shot.beanBatch || shot.workflow?.context?.beanBatch; if (path.startsWith("/api/v1/beans/") && bean) return response(bean); if (path.startsWith("/api/v1/bean-batches/") && batch) return response(batch); return {ok: false, status: 404, json: async () => ({})}; }});
    instance.onLoad({TargetTimeSec: String(c.target), TargetTimeClock: $("actual-shot-clock")?.value || "pump", TimeToleranceSec: String(c.tolerance)});
    try { const saved = await instance.handleHttpRequest({endpoint: "feedback", method: "POST", body: feedback}); if (saved.status !== 200) throw new Error(JSON.parse(saved.body).error || "Feedback rejected"); const result = await instance.handleHttpRequest({endpoint: "suggestion", method: "GET"}); const body = JSON.parse(result.body); if (generation !== assistantGeneration) return; importedFeedback = feedback; const holder = $("assist-result"); holder.replaceChildren(); const summary = document.createElement("p"); text(summary, "Saved shot " + shot.id + " · " + body.status + " · " + (body.direction || "retain / gather evidence") + ". " + (body.reason || "")); holder.append(summary); const why = document.createElement("p"); text(why, "This assessment used the imported timestamps, controller steps and recorded context. Missing bean catalogue or calibration stays unavailable. " + (body.warnings || []).join(" ")); holder.append(why); const detail = document.createElement("details"), caption = document.createElement("summary"), pre = document.createElement("pre"); text(caption, "Why / complete evidence"); text(pre, JSON.stringify(body, null, 2)); detail.append(caption, pre); holder.append(detail); } finally { instance.onUnload(); }
  }
  function mechanicalNativeUnit() { return ["LAGOM P64", "LAGOM 01"].includes(config().grinder) ? "printed_number" : undefined; }
  function renderMechanicalSetup(reset = false) {
    if (!$("mechanical-enabled")) return;
    const scope = JSON.stringify([config().grinderId, config().burrs, config().calibration]);
    if (reset || scope !== mechanicalSetupScope) {
      mechanicalSetupScope = scope; $("mechanical-enabled").checked = false; $("mechanical-absolute-enabled").checked = false; $("mechanical-zero-assumed").checked = false;
      $("mechanical-reference").value = "0"; $("mechanical-offset").value = ""; $("mechanical-slope").value = ""; $("mechanical-scenario").value = "central";
    }
    const profile = mechanics?.profileFor(config().grinder), scenario = profile?.exploratoryScenario, choice = $("mechanical-scenario").value;
    const preview = mechanics?.estimate({model: config().grinder, nativeUnit: mechanicalNativeUnit(), nativeValue: 1, baselineNativeValue: 0, acceptScenario: true});
    const central = config().grinder === "LAGOM 01" ? null : preview?.axialMovementUm, interval = scenario?.sensitivityIntervalUmPerUnit;
    if (choice !== "owner") {
      const value = choice === "lower" ? interval?.[0] : choice === "upper" ? interval?.[1] : central;
      $("mechanical-slope").value = Number.isFinite(value) ? String(value) : "";
    }
    const holder = $("mechanical-source-note"); holder.replaceChildren();
    const note = document.createElement("p");
    text(note, profile ? config().grinder + ": " + (scenario?.rationale || profile.relativeMovement?.status || "No uniform movement estimate is established for this model.") + " " + (profile.uncertainty?.reason || "") : "No reviewed movement estimate is available. You may enter your own rough assumption in the dial units you use above."); holder.append(note);
    (profile?.sourceIds || []).forEach(id => { const source = mechanicsCatalog?.sources?.[id]; if (!source || !safeHttps(source.url)) return; const link = document.createElement("a"); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer"; text(link, source.title); const line = document.createElement("p"); line.append(link); holder.append(line); });
    const slope = simpleNumber("mechanical-slope");
    text($("mechanical-scenario-note"), (slope > 0 ? "Chosen assumption: approximately " + Number(slope.toPrecision(6)) + " µm per " + (mechanicalNativeUnit() === "printed_number" ? "whole printed dial number" : simpleUnit()) + ". " : "Enter a positive movement estimate or choose an available scenario. ") + (interval ? "Sensitivity choices " + interval[0] + "–" + interval[1] + " are analyst-chosen scenarios, not confidence bounds. " : "No measured uncertainty interval is supplied. ") + "This estimates burr movement, not particle size or shot time." + (config().grinder === "LAGOM 01" ? " LAGOM 01 variants are not selected here; enter an explicit owner assumption for your printed-number coordinate." : ""));
    text($("mechanical-status"), !mechanics ? "Mechanical estimate tools are unavailable." : $("mechanical-enabled").checked ? "Rough estimates are enabled for this setup. Record a shot to compare them." : "Rough estimates are off.");
  }
  function mechanicalInput() {
    if (!$("mechanical-enabled")?.checked || !mechanics) return {reason: "Choose the optional rough estimate and acknowledge its assumptions first."};
    if (dialProfile()?.espressoAdjustment?.espressoSupported === false) return {reason: "This grinder is not supported for espresso."};
    const slope = simpleNumber("mechanical-slope"), baseline = simpleNumber("mechanical-reference"), sign = simpleNumber("simple-finer");
    const step = simpleNumber("simple-step"), min = simpleNumber("simple-bound-min"), max = simpleNumber("simple-bound-max"), current = simpleNumber("simple-current-dial");
    if (!(slope > 0) || baseline == null) return {reason: "Enter a positive rough movement per dial unit and a reference setting."};
    if (!$("simple-confirm-dial").checked || ![-1, 1].includes(sign) || !(step > 0)) return {reason: "Check your small step and finer direction before using the rough estimate."};
    if (min == null || max == null || !(min < max) || current < min || current > max) return {reason: "Enter and check both ends of your allowed trial window. The current setting must be inside it."};
    const zeroAssumed = $("mechanical-zero-assumed").checked, absolute = zeroAssumed || $("mechanical-absolute-enabled").checked, offset = zeroAssumed ? 0 : simpleNumber("mechanical-offset");
    if (absolute && (offset == null || offset < 0)) return {reason: "Enter the assumed gap at your reference setting, or turn off the absolute reference."};
    return {model: config().grinder, nativeUnit: mechanicalNativeUnit(), signedAxialUmPerNative: -sign * slope, baselineNativeValue: baseline, baselineResearchCoordinate: absolute ? offset * 10 : 1000,
      umPerResearchUnit: .1, acceptScenario: true, acceptGeometryAssumption: true, ownerStep: step, minNative: min, maxNative: max, physicalIncrement: nativeResolution(), currentNativeValue: current,
      coordinateStatus: absolute ? "estimated_absolute" : "estimated_relative", absolute};
  }
  function mechanicalCases(latest, failures) {
    const setup = mechanicalInput(), output = {cases: {}, setup, alternatives: {}};
    if (setup.reason) return output;
    if (!latest?.clockConfirmed || !latest?.pressureConfirmed) { setup.reason = "Confirm the same pump clock and pressure recipe before using a timing estimate."; return output; }
    let start = simpleShots.length - 1;
    while (start > 0) { const prior = simpleShots[start - 1]; if (JSON.stringify(prior.scope) !== JSON.stringify(latest.scope) || !prior.clockConfirmed || !prior.pressureConfirmed || prior.setting < setup.minNative || prior.setting > setup.maxNative) break; start--; }
    const inputs = (origin) => simpleShots.slice(start).map(shot => {
      const mapped = mechanics.toRelativeCoordinate({...setup, baselineResearchCoordinate: origin, nativeValue: shot.setting});
      const coordinate = mapped.researchCoordinate;
      if (!Number.isFinite(coordinate) || coordinate < 10 || coordinate > 2147483647) throw new Error(mapped.reason || "The assumed reference leaves the numerical range; choose another reference.");
      return {actualBrewTimeMs: Math.round(shot.time * 1000), targetBrewTimeMs: Math.round(shot.target * 1000), toleranceMs: Math.round(shot.tolerance * 1000), estimatedDdDum: Math.round(coordinate), setpointDdDum: Math.round(coordinate)};
    });
    try {
      output.cases = replayCases(inputs(setup.baselineResearchCoordinate), failures, setup.absolute ? algorithmNames.slice(0, 4) : ["GbS1", "GbS2"]);
      if (!setup.absolute) output.alternatives = replayCases(inputs(setup.baselineResearchCoordinate + 1000), {}, ["GbS1", "GbS2"]);
    } catch (error) { setup.reason = error.message; output.cases = {}; }
    return output;
  }
  function mechanicalProposal(row, estimated) {
    if (row.status !== "computed" || !estimated?.cases[row.algorithm]) return null;
    const input = estimated.cases[row.algorithm].input, delta = row.result.returnedDdDum - input.estimatedDdDum;
    const alternate = estimated.alternatives[row.algorithm];
    if (!estimated.setup.absolute) {
      if (!alternate) return {status: "withheld", reason: "The relative-reference consistency check is unavailable."};
      const check = algorithms.compareAll({cases: {[row.algorithm]: alternate}}).results.find(item => item.algorithm === row.algorithm);
      if (check?.status !== "computed" || check.result.returnedDdDum - alternate.input.estimatedDdDum !== delta) return {status: "withheld", reason: "Changing the temporary reference changes this result. An absolute assumption is needed before trying it."};
    }
    const result = mechanics.proposeNative({...estimated.setup, requestedResearchDelta: delta});
    return {...result, coordinateStatus: estimated.setup.coordinateStatus};
  }
  function canTryMechanical(latest, proposal) {
    if (!latest || simpleComparisonStale || !Number.isFinite(proposal?.proposedNative) || proposal.proposedNative === latest.setting) return false;
    if (!latest.clockConfirmed || !latest.pressureConfirmed || !latest.taste || ["balanced", "weak", "channeling"].includes(latest.taste)) return false;
    if (["suggestion", "hold", "abstain"].includes(latest.nativeResponse?.status)) return false;
    const intent = latest.taste === "too sour" ? "finer" : ["too bitter", "too astringent"].includes(latest.taste) ? "coarser" : null;
    const direction = (proposal.proposedNative - latest.setting) * Number($("simple-finer").value) > 0 ? "finer" : "coarser";
    return intent === direction && (latest.time < latest.target - latest.tolerance ? direction === "finer" : latest.time > latest.target + latest.tolerance ? direction === "coarser" : false);
  }
  function chooseMechanical(latest, algorithm, proposal) {
    if (!canTryMechanical(latest, proposal) || latest !== simpleShots.at(-1)) return;
    simpleProposal = proposal.proposedNative; latest.chosenMechanical = {algorithm, coordinateStatus: proposal.coordinateStatus};
    latest.action = "Your chosen estimated trial: from " + latest.setting + " to " + Number(simpleProposal.toFixed(6)) + " " + simpleUnit() + ".";
    latest.why = "You chose " + algorithm + " using a rough mechanical assumption. Keep the recipe unchanged, then measure and taste the next shot.";
    const holder = $("simple-advice"); holder.replaceChildren(); const heading = document.createElement("h3"), why = document.createElement("p"); text(heading, latest.action); text(why, latest.why); holder.append(heading, why);
    captureResearchShot(latest, config(), simpleProposal); navigateSimple(4);
  }
  function initializeMechanical() {
    if (typeof window.createGrinderMechanics === "function" && typeof window.createGrinderMechanicsCatalog === "function") { mechanicsCatalog = window.createGrinderMechanicsCatalog(); mechanics = window.createGrinderMechanics(mechanicsCatalog); }
    renderMechanicalSetup();
    ["mechanical-enabled", "mechanical-scenario", "mechanical-slope", "mechanical-reference", "mechanical-offset", "mechanical-absolute-enabled", "mechanical-zero-assumed"].forEach(id => $(id)?.addEventListener("change", () => {
      if (id === "mechanical-slope") $("mechanical-scenario").value = "owner";
      if (id === "mechanical-zero-assumed") $("mechanical-absolute-enabled").checked = false;
      if (id === "mechanical-absolute-enabled") $("mechanical-zero-assumed").checked = false;
      renderMechanicalSetup(); invalidateSimpleAdvice();
    }));
    $("mechanical-use-current")?.addEventListener("click", () => { const current = simpleNumber("simple-current-dial"); if (current != null) $("mechanical-reference").value = String(current); $("mechanical-zero-assumed").checked = false; invalidateSimpleAdvice(); });
  }

  function replayCases(shots, failures, names = algorithmNames) {
    const cases = {}, first = shots[0]?.setpointDdDum;
    if (first == null) return cases;
    names.forEach(name => {
      const options = name === "DdEff" ? {initialDdDum: first} : name === "GbS1"
        ? {lastResultDum: first, continuousUm: first * .1, previousQuantizedUm: first * .1}
        : {lastResultDum: first, lastAdjustmentDum: first, lastTargetDum: first};
      try {
        let state = algorithms.createState(name, options);
        for (const input of shots.slice(0, -1)) state = algorithms.adjust(name, state, input).nextState;
        cases[name] = {state, input: shots.at(-1)};
      } catch (error) { failures[name] = error.message; }
    });
    return cases;
  }
  const comparisonHelp = {
    GbS1: ["Smooth recent shots", "Smooths recent brew times and makes a bounded change. It keeps the returned setting when the latest time is inside the tolerance."],
    GbS2: ["Learn from settings and times", "Fits a line to up to six recorded setting/time pairs, then moves partway toward the target-time estimate. With too little variation it uses a firmware fallback."],
    GbS3: ["Blend two timing models", "Blends an inverse timing response with a fitted line. Its phase and hold counter choose the blend; an early near phase does not prove the shot is near the target. It cancels when the supplied setting moves too far from its previous target."],
    GbS4: ["Blend, then lock", "Uses the phase-based timing model and can lock its previous setting after enough shots are close to the target. It does not judge flavour."],
    DdEff: ["Plan test measurements", "Repeats the starting coordinate six times, then tests lower and higher coordinates. It ignores time and taste. This is a measurement sequence, not next-coffee advice."],
    effectiveDd: ["Estimate a grind's settling", "Models how the effective setting approaches the new setting over the measured grind duration, using the previous baseline and retained state. It does not measure particle size."],
    grindTime: ["Estimate grinding time", "Only firmware mode 3 scales the recipe grind time using a modeled grind-speed ratio. Other modes keep the recipe time. This does not guarantee the dose weight."],
    inverseRegression: ["Fit measured points", "Fits the supplied setting/time pairs and estimates the setting for the target time. The firmware fallback and slope limit can affect it; it does not bound extrapolation."],
    proposedDd: ["Look up a starting point", "Uses the selected grinder, roast and dose in a recovered research table. The output unit is unknown, so it cannot tell you a number on your grinder."],
    manual: ["Your taste and small dial step", "Uses your time, target and taste preference. It holds when you like the coffee or the signals conflict; a numbered move needs your confirmed step and finer direction."]
  };
  const missingComparison = {
    effectiveDd: "Needs a measured grind duration, current coordinate, previous effective baseline and retained state. Use the optional measurements form below; leave unknown values blank.",
    grindTime: "Needs the firmware mode, recipe grind time and verified recipe/target coordinates. Use the optional measurements form below; leave unknown values blank.",
    inverseRegression: "Needs at least two measured setting/time points on the same clock, in verified research units. Use the optional measurements form below.",
    proposedDd: "Needs an explicitly chosen supported grinder, roast and dose. Its unknown output unit cannot be used as a dial setting; choose the known coffee and grinder details first."
  };
  function compareAllCalculators() {
    const holder = $("all-comparison-results"); if (!holder || !algorithms) return;
    try {
      const cases = supplemental?.cases() || {}, reasons = {}, failures = {};
      const latest = simpleShots.at(-1), matchingScope = latest && JSON.stringify(latest.scope) === JSON.stringify(nativeScope()), matchingTarget = latest && latest.target === config().target && latest.tolerance === config().tolerance;
      let source = "No completed shot yet. Every approach is listed below.", timing, measurement, importedMappingMatches = false, estimated = null;
      const useRecorded = viewMode === "simple" || simpleShots.length > 0 && $("comparison-source")?.value !== "experiment";
      if (useRecorded) {
        delete cases.manual;
        source = latest && !simpleComparisonStale ? (latest.practice ? "Fictional practice " : "Recorded shot ") + simpleShots.length + " · " + latest.time + " seconds against " + latest.target + " seconds. Research models do not use taste, bean type or roast; manual guidance uses your taste preference." : "Record this shot to refresh the comparisons. No missing measurement is guessed.";
        if (simpleComparisonStale) measurement = "Inputs changed. Record this shot again to refresh its results; it replaces the previous entry until you continue to a new shot.";
        else if (!latest) measurement = "Needs a recorded shot with its measured grinder coordinate.";
        else if (!matchingTarget) measurement = "The target time or tolerance changed. Refresh the recorded shot before comparing recommendations.";
        else if (!matchingScope) measurement = "The coffee, grinder, burrs, zero, calibration or recipe changed. Record a completed shot in this setup; historical shots remain separate.";
        else if (latest.coordinate == null) measurement = "These firmware research tools require an independently measured conversion for this grinder. Learn from my shots works directly in your dial units without that conversion. Only add research anchors if you have actually measured them.";
        timing = measurement;
        if (!timing && !latest.clockConfirmed) timing = "Confirm timing from pump start and stopping at the target cup weight. Different clocks cannot be compared.";
        else if (!timing && !latest.pressureConfirmed) timing = "A programmed flow target can control shot time. These timing-only models cannot recommend a grind change from that time.";
        for (const names of [algorithmNames.slice(0, 4), ["DdEff"]]) {
          const sequence = names[0] === "DdEff";
          if (sequence ? measurement : timing) continue;
          // Missing coordinates break every replay; clock/profile gaps only break timing models.
          let start = simpleShots.length - 1;
          while (start > 0) {
            const previous = simpleShots[start - 1];
            if (previous.coordinate == null || JSON.stringify(previous.scope) !== JSON.stringify(latest.scope) || !sequence && (!previous.clockConfirmed || !previous.pressureConfirmed)) break;
            start--;
          }
          const shots = simpleShots.slice(start).map(shot => ({actualBrewTimeMs: Math.round(shot.time * 1000), targetBrewTimeMs: Math.round(shot.target * 1000), toleranceMs: Math.round(shot.tolerance * 1000), estimatedDdDum: shot.coordinate, setpointDdDum: shot.coordinate}));
          Object.assign(cases, replayCases(shots, failures, names));
          source += sequence ? " Measurement sequence uses " + shots.length + " recorded coordinate(s)." : " Each timing model independently replays " + shots.length + " comparable shot(s), using the settings you actually brewed.";
        }
        if (latest?.manualInput && matchingScope && matchingTarget && !simpleComparisonStale) cases.manual = {input: latest.manualInput};
        else reasons.manual = simpleComparisonStale || latest && (!matchingScope || !matchingTarget) ? measurement : latest?.why || "Brew, time and taste your coffee first. Confirm your own small dial movement for a numbered adjustment.";
      } else if (importedShot) {
        const context = importedShot.workflow?.context || {}, raw = context.grinderSetting, actual = $("actual-shot-time")?.value, unit = context.extras?.grinderSettingUnit;
        source = "Imported saved shot · independent research comparison. Actual controller steps remain authoritative.";
        const c = config(), extras = context.extras || {};
        importedMappingMatches = [[context.grinderId, c.grinderId], [extras.grinderInstanceId, c.grinderId], [context.grinderModel, c.grinder], [context.grinderBurrs || extras.burrIdentity, c.burrs], [extras.calibrationEpoch, c.calibration]].every(([saved, current]) => typeof saved === "string" && saved.trim() !== "" && saved === current);
        if (raw == null || !String(raw).trim() || !Number.isInteger(Number(raw)) || unit !== "deci-micrometre") measurement = "Needs the saved grinder coordinate in verified research units.";
        timing = measurement;
        if (!timing && importedMetrics?.trace?.recommendation?.status === "abstain") timing = "This saved profile uses flow control or a flow limiter. Time alone cannot support a grind change.";
        else if (!timing && !["pressure", "mixed_preinfusion_flow"].includes(importedMetrics?.trace?.controlMode)) timing = "The saved profile does not establish pressure-controlled extraction. Unknown control mode cannot support timing-only advice.";
        else if (!timing && /error|disconnected|stopping.?backstop/i.test(importedMetrics?.stopReason || "")) timing = "This shot ended with an error or disconnect. Repeat the recipe before interpreting a timing-only grind change.";
        else if (!timing && /api.?stop|app.?stop/i.test(importedMetrics?.stopReason || "") && !$("manual-stop-confirmed")?.checked) timing = "Confirm that this manually stopped shot reached its intended recipe before comparing it.";
        else if (!timing && ($("actual-shot-clock")?.value !== "pump" || !importedMetrics?.timing?.pump?.complete || !actual || !(Number(actual) > 0) || Math.abs(Number(actual) - importedMetrics.timing.pump.durationSec) > .001)) timing = "The recipe target is pump-start time. Select the complete observed pump clock; a pouring, recording or unverified override time cannot be compared with that target.";
        if (!measurement) {
          // DdEff ignores timing; use valid neutral fields when the imported clock is unavailable.
          const input = {actualBrewTimeMs: 0, targetBrewTimeMs: 1, toleranceMs: 0, estimatedDdDum: Number(raw), setpointDdDum: Number(raw)};
          Object.assign(cases, replayCases([input], failures, ["DdEff"]));
          if (!timing) Object.assign(cases, replayCases([{...input, actualBrewTimeMs: Math.round(Number(actual) * 1000), targetBrewTimeMs: Math.round(c.target * 1000), toleranceMs: Math.round(c.tolerance * 1000)}], failures, algorithmNames.slice(0, 4)));
        }
      } else {
        const completed = rows.filter(row => row.actual !== "" && Number(row.actual) > 0);
        if (completed.length) { Object.assign(cases, replayCases(engineScenario(completed).shots, failures)); source = "Expert experiment · independent replay of the same entered or fictional shot inputs. These research models ignore taste."; }
      }
      if (useRecorded && latest && latest.coordinate == null && matchingScope && matchingTarget && !simpleComparisonStale && $("mechanical-enabled")?.checked) {
        estimated = mechanicalCases(latest, failures); Object.assign(cases, estimated.cases);
        source += " Optional mechanical estimates use the selected assumption, never measured calibration.";
      }
      const tableModel = {"E64 WS": "e64", "E65S GbW": "e65", "E80S GbW": "e80"}[config().grinder], tableRoast = config().roast.trim().toLowerCase();
      if (useRecorded && matchingScope && matchingTarget && !cases.proposedDd && latest?.pressureConfirmed && !simpleComparisonStale && tableModel && ["light", "medium", "dark"].includes(tableRoast) && latest.scope?.doseG > 0) cases.proposedDd = {input: {model: tableModel, roast: tableRoast, weightMg: latest.scope.doseG * 1000}};
      algorithmNames.forEach(name => { const reason = estimated?.cases[name] ? null : estimated && name !== "DdEff" ? estimated.setup.reason || "This model needs an explicitly accepted absolute reference; the relative-only estimate enables GbS1 and GbS2." : name === "DdEff" ? measurement : timing; if (reason) { delete cases[name]; reasons[name] = reason; } });
      text($("all-comparison-context"), source);
      holder.replaceChildren();
      const approachSnapshots = [];
      algorithms.compareAll({cases}).results.forEach(row => {
        if (failures[row.algorithm]) row = {...row, status: "invalid", result: null, reason: failures[row.algorithm]};
        const card = document.createElement("article"), heading = document.createElement("h3"), label = document.createElement("p"), answer = document.createElement("p"), why = document.createElement("p");
        card.setAttribute("data-algorithm", row.algorithm); card.setAttribute("data-status", row.status);
        text(heading, row.algorithm + " · " + row.status); label.className = "hint"; text(label, comparisonHelp[row.algorithm][0]);
        const value = row.result;
        let recommendation = reasons[row.algorithm] || missingComparison[row.algorithm] || "Needs a completed shot with verified timing and grinder coordinates.";
        let explanation = comparisonHelp[row.algorithm][1];
        if (row.status === "computed") {
          if (value.returnedDdDum != null) {
            const mapped = importedShot && !useRecorded && !importedMappingMatches ? {status: "unavailable"} : dialConversion(value.returnedDdDum);
            recommendation = mapped.status === "normalized" ? (row.algorithm === "DdEff" ? "Measurement plan coordinate: " : "Timing model returns: ") + Number(mapped.visible.value.toFixed(6)) + " " + mapped.visible.unit + "." + (mapped.achievable === false ? " This lies between physical steps; verify an achievable mark." : "") : importedShot && !useRecorded ? "Research model returns " + value.returnedDdDum + " dD. Native conversion is withheld: the saved individual grinder, model, burrs and calibration epoch must exactly match the current setup, with a usable scoped conversion." : "Research result available; a verified calibration is needed to show it on your dial.";
            explanation += " Current phase: " + value.phase + ". " + (row.algorithm === "DdEff" ? "The returned coordinate follows the test sequence, not a timing correction." : value.locked ? "The model is locked and returns its previous setting." : value.committed === false ? "It holds the returned setting even if its internal candidate differs." : "It returns the model's calculated setting.");
            if (row.algorithm !== "DdEff") {
              const input = cases[row.algorithm].input, actual = input.actualBrewTimeMs / 1000, target = input.targetBrewTimeMs / 1000, gap = Number(Math.abs(actual - target).toFixed(3));
              explanation += " Latest measured time: " + actual + " seconds; target: " + target + " seconds (" + (gap === 0 ? "on target" : gap + " seconds " + (actual < target ? "faster" : "slower")) + "). Tolerance: " + input.toleranceMs / 1000 + " seconds.";
            }
            if (value.centralSec != null) explanation += " Smoothed time: " + Number(value.centralSec.toFixed(2)) + " seconds.";
            if (useRecorded && row.algorithm !== "DdEff") explanation += " Your recorded dial was " + latest.setting + " " + simpleUnit() + ". This is a timing-only comparison; it does not override your taste-based next step above.";
          } else if (row.algorithm === "manual") {
            recommendation = useRecorded ? latest.manualAction || latest.action : value.proposedDial != null ? "Suggested dial: " + value.proposedDial + "." : "Direction only: " + value.direction + "; confirm your small step before a numbered move.";
            explanation = useRecorded ? (latest.manualWhy || latest.why) + " " + comparisonHelp.manual[1] : (value.reasons || []).join(". ") + ". " + explanation;
          } else if (row.algorithm === "grindTime") recommendation = value.adjustedTimeMs == null ? "Keep the recipe grind time; this mode does not adjust it." : "Estimated grind time: " + Number((value.adjustedTimeMs / 1000).toFixed(3)) + " seconds.";
          else if (row.algorithm === "proposedDd") recommendation = "Table result: " + value.proposedDd + " (unit unknown). Do not use this number on your dial.";
          else if (row.algorithm === "inverseRegression") recommendation = "Estimated research setting: " + Number(value.toFixed(3)) + " micrometres. Verify calibration and measured-point range before using it.";
          else recommendation = "Estimated effective research coordinate: " + value.result + ". This is a model estimate, not a dial command.";
        } else if (row.status === "invalid") recommendation = "Check the supplied measurements: " + row.reason;
        const mechanical = mechanicalProposal(row, estimated);
        if (mechanical) {
          card.setAttribute("data-coordinate-status", mechanical.coordinateStatus || estimated.setup.coordinateStatus);
          text(heading, row.algorithm + " · estimated");
          recommendation = Number.isFinite(mechanical.proposedNative) ? (canTryMechanical(latest, mechanical) ? "Estimated trial: " : "Model estimate only: ") + Number(mechanical.proposedNative.toFixed(6)) + " " + simpleUnit() + " (currently " + latest.setting + ")." + (canTryMechanical(latest, mechanical) ? "" : " Follow your measured or taste-based next step above.") : "Estimated trial withheld: " + (mechanical.reason || "No achievable small step is available.");
          explanation = comparisonHelp[row.algorithm][1] + " Uses approximately " + Number(Math.abs(estimated.setup.signedAxialUmPerNative).toPrecision(6)) + " µm per dial unit under your chosen " + (estimated.setup.absolute ? "absolute-zero assumption" : "relative-only assumption") + ". Any offered trial respects your checked small step, allowed window and physical clicks.";
        }
        const snapshot = {algorithm: row.algorithm, status: row.status, coordinateStatus: mechanical?.coordinateStatus || (row.algorithm === "manual" ? "native" : latest?.coordinate != null && algorithmNames.includes(row.algorithm) ? "measured" : "unknown")};
        let snapshotSetting = mechanical?.proposedNative;
        if (!mechanical && row.status === "computed" && value?.returnedDdDum != null && useRecorded) { const mapped = dialConversion(value.returnedDdDum); if (mapped.status === "normalized") snapshotSetting = mapped.visible.value; }
        if (row.algorithm === "manual" && row.status === "computed") snapshotSetting = value.direction === "none" ? latest?.setting : value.proposedDial;
        const checkedStep = simpleNumber("simple-step"), checkedMin = simpleNumber("simple-bound-min"), checkedMax = simpleNumber("simple-bound-max");
        if (useRecorded && latest && $("simple-confirm-dial").checked && Number.isFinite(snapshotSetting) && Math.abs(snapshotSetting - latest.setting) <= checkedStep + 1e-9 && (checkedMin == null || snapshotSetting >= checkedMin) && (checkedMax == null || snapshotSetting <= checkedMax)) Object.assign(snapshot, {settingUnit: researchUnit(simpleUnit()), proposedSetting: snapshotSetting, direction: snapshotSetting === latest.setting ? "none" : (snapshotSetting - latest.setting) * Number($("simple-finer").value) > 0 ? "finer" : "coarser"});
        approachSnapshots.push(snapshot);
        const supplied = cases[row.algorithm];
        if (row.status === "computed" && supplied && row.algorithm === "proposedDd") explanation += " Chosen inputs: " + supplied.input.model + ", " + supplied.input.roast + " roast, " + supplied.input.weightMg / 1000 + " g coffee.";
        if (row.status === "computed" && supplied && row.algorithm === "grindTime") explanation += " Chosen mode: " + supplied.input.mode + "; recipe grind time: " + supplied.input.recipeTimeMs / 1000 + " seconds.";
        if (row.status === "computed" && supplied && row.algorithm === "effectiveDd") explanation += " Measured grind duration: " + supplied.input.grindDurationMs / 1000 + " seconds; supplied baseline: " + supplied.input.effectiveBaseline + " micrometres.";
        if (row.status === "computed" && supplied && row.algorithm === "inverseRegression") explanation += " Uses " + supplied.points.length + " supplied points; target time: " + supplied.targetSec + " seconds.";
        text(answer, recommendation); text(why, (row.status === "computed" ? "Why: " : "Why this tool is unavailable: ") + explanation); card.append(heading, label, answer, why);
        if (mechanical && canTryMechanical(latest, mechanical)) { const choose = document.createElement("button"); choose.type = "button"; text(choose, "Try this estimated approach"); choose.addEventListener("click", () => chooseMechanical(latest, row.algorithm, mechanical)); card.append(choose); }
        if (row.status !== "computed") {
          if (algorithmNames.includes(row.algorithm)) {
            if (latest && latest.coordinate == null && row.algorithm !== "DdEff") guideTo(card, "Set up a rough estimate (optional)", "mechanical-setup", "mechanical-reference");
            else if (latest && latest.coordinate == null) guideTo(card, "About measured research conversion", "research-calibration");
            else guideTo(card, "Check the recorded shot", "simple-brew", "simple-time");
          } else if (row.algorithm === "manual") guideTo(card, "Check my small dial step", "simple-dial-setup", "simple-step");
          else if (row.algorithm === "proposedDd") guideTo(card, "Check grinder and coffee details", "simple-grinder-context", "roast");
          else guideTo(card, "Add this tool’s measured inputs", "research-inputs", "lab-" + row.algorithm + "-enabled");
        }
        if (cases[row.algorithm]) { const details = document.createElement("details"), summary = document.createElement("summary"), pre = document.createElement("pre"); text(summary, "Exact inputs and calculation"); text(pre, JSON.stringify({case: cases[row.algorithm], ...(mechanical ? {mechanicalAssumptions: estimated.setup, boundedNativeResult: mechanical, relativeOriginCheck: estimated.setup.absolute ? "not applicable" : "compared against origin shifted by 1000 dD", sourceProfile: mechanics.profileFor(config().grinder)} : {}), ...row}, null, 2)); details.append(summary, pre); card.append(details); }
        holder.append(card);
      });
      if (useRecorded && latest && matchingScope && matchingTarget && !simpleComparisonStale) {
        const response = latest.nativeResponse;
        latest.researchApproaches = approachSnapshots.concat([{algorithm: "native-response", status: response?.status || "unavailable", coordinateStatus: "native", ...(Number.isFinite(response?.proposedSetting) ? {settingUnit: researchUnit(simpleUnit()), proposedSetting: response.proposedSetting, direction: response.direction} : {})}]);
      }
    } catch (error) { holder.replaceChildren(); text(holder, "Comparison could not be refreshed: " + error.message); }
  }
  function initializeEvidenceUi() {
    uiTools = window.createDialinUiTools(document); supplemental = uiTools.supplementalInputs($("all-comparison-inputs"), "lab");
    $("export-shot-trace")?.addEventListener("click", () => { if (!importedShot) { setNotice("Import a saved shot first.", true); return; } const blob = new Blob([JSON.stringify({shot: importedShot, feedback: currentImportedFeedback()}, null, 2)], {type: "application/json"}), link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "analysed-shot-and-feedback.json"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); });
    $("shot-trace-import")?.addEventListener("change", importShotTrace); $("clear-shot-trace")?.addEventListener("click", clearImportedTrace); $("actual-shot-clock")?.addEventListener("change", useImportedClock); $("actual-shot-time")?.addEventListener("input", invalidateAssistant); $("compare-all-lab")?.addEventListener("click", compareAllCalculators);
    $("all-comparison-inputs")?.addEventListener("change", compareAllCalculators);
    $("comparison-source")?.addEventListener("change", compareAllCalculators);
    $("manual-stop-confirmed")?.addEventListener("change", invalidateAssistant);
    ["taste-temperature", "taste-minutes", "assist-overall"].forEach(id => $(id)?.addEventListener("input", invalidateAssistant));
    if ($("profile-picker")) fetch("../data/decent-profiles.json").then(response => { if (!response.ok) throw new Error("Profile references unavailable"); return response.json(); }).then(catalog => uiTools.profilePicker($("profile-picker"), catalog)).catch(error => text($("profile-picker"), error.message));
  }

  function simpleUnit() { return dialProfile()?.visibleUnit || dialProfile()?.unit || "dial units"; }
  function simpleNumber(id) {
    const value = $(id)?.value;
    return value != null && String(value).trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  }
  function clearSimpleShots() {
    researchSeries = null;
    simpleShots = []; simpleProposal = null; simpleEditingShot = false; simpleComparisonStale = false;
    $("simple-history")?.replaceChildren();
    if ($("simple-advice")) text($("simple-advice"), "Brew a coffee and enter its time and taste first.");
    if ($("simple-continue")) $("simple-continue").disabled = true;
    if ($("simple-time")) $("simple-time").value = "";
    if ($("simple-taste")) $("simple-taste").value = "";
    if ($("simple-clock-confirmed")) $("simple-clock-confirmed").checked = false;
    compareAllCalculators(); renderNativeResponse();
  }
  function clearSimpleSetup() {
    renderMechanicalSetup(true);
    simplePractice = false; nativeSetupEdited.clear();
    if ($("simple-pressure-confirmed")) $("simple-pressure-confirmed").checked = false;
    ["simple-current-dial", "simple-step", "simple-finer", "simple-bound-min", "simple-bound-max"].forEach(id => { if ($(id)) $(id).value = ""; });
    if ($("simple-confirm-dial")) $("simple-confirm-dial").checked = false;
    if ($("simple-practice")) $("simple-practice").hidden = true;
    if ($("simple-practice-status")) text($("simple-practice-status"), "");
  }
  function renderSimpleRecipe() {
    if (!$("simple-recipe-summary")) return;
    const c = config(), dial = simpleNumber("simple-current-dial"), unit = simpleUnit();
    $("simple-step").placeholder = unit === "micrometres" ? "For example, 2 micrometres" : "For example, 0.5 of a mark";
    text($("simple-unit"), "Use the " + unit + " shown on your own grinder. If you have no starting setting, use its espresso starting guide first.");
    text($("simple-recipe-summary"), c.dose + " g coffee → " + c.yield + " g in your cup, aiming for about " + c.target + " seconds from pump start.");
    text($("simple-brew-summary"), (simplePractice ? "Fictional practice · " : "") + c.bean + ": " + c.dose + " g coffee, " + c.yield + " g in your cup" + (dial == null ? ". Read your grinder setting before brewing." : ", grinder at " + dial + " " + unit + "."));
  }
  function invalidateSimpleAdvice() {
    simpleProposal = null; simpleComparisonStale = simpleEditingShot; compareAllCalculators(); renderNativeResponse();
    if ($("simple-continue")) $("simple-continue").disabled = true;
    if ($("simple-advice")) text($("simple-advice"), "Your inputs changed. Enter this shot again to get a fresh next step.");
  }
  function applyNativeDefaults() {
    renderMechanicalSetup();
    if (!$("simple-step")) return;
    const profile = activeProfile(), metadata = dialProfile(), preset = metadata?.espressoAdjustment;
    const saved = profile?.model === config().grinder ? profile : null;
    const owner = saved?.nativeSetup;
    const unit = simpleUnit(), savedUnit = owner?.settingUnit;
    const legacyP64 = config().grinder === "LAGOM P64" && [undefined, "marks", "dial marks"].includes(savedUnit) && researchUnit(unit) === "printed-decimal";
    const sameUnit = savedUnit ? researchUnit(savedUnit) === researchUnit(unit) || legacyP64 : config().grinder !== "LAGOM 01";
    const sameSetup = sameUnit && owner?.burrIdentity === config().burrs && owner?.calibrationEpoch === config().calibration;
    const savedStep = sameUnit ? saved?.stepSize : null;
    const proposed = {"simple-step": savedStep ?? preset?.stepNative, "simple-finer": sameSetup ? owner.numericFinerDelta : preset?.numericFinerDelta,
      "simple-bound-min": sameSetup ? owner.min : null, "simple-bound-max": sameSetup ? owner.max : null};
    Object.entries(proposed).forEach(([id, value]) => { if ($(id) && !nativeSetupEdited.has(id) && $(id).value === "" && Number.isFinite(value)) $(id).value = String(value); });
    const holder = $("simple-step-preset"); if (holder) {
      holder.replaceChildren(); const note = document.createElement("p");
      const basis = {reviewer_observed_increment: "Observed in a firsthand review", cautious_product_heuristic: "A cautious trial chosen for this product", manufacturer_native_increment: "Published native adjustment increment"}[preset?.basis] || "Proposed trial from the reviewed model notes";
      text(note, saved?.stepSize != null && !sameUnit ? "Your old saved step used a different or unspecified dial unit. Enter a fresh step in " + unit + " and check it on this grinder." : savedStep != null ? "Your saved step for this individual grinder is proposed here. Check it again after setup changes." + (legacyP64 ? " The old P64 dial-mark label is read as decimal printed numbers." : "") : preset?.stepNative != null ? basis + ": " + preset.stepNative + " " + simpleUnit() + ". " + (preset.note || "") : "No numeric step is assumed for this model. Enter a small step you can make reliably. " + (preset?.note || "")); holder.append(note);
      (preset?.sources || []).forEach(source => { const href = safeHttps(source.url); if (!href) return; const link = document.createElement("a"); link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; text(link, source.title); holder.append(link, document.createElement("br")); });
      if (preset?.espressoSupported === false) { const warning = document.createElement("p"); text(warning, "This model is not supported for espresso. No espresso dial adjustment will be proposed."); holder.append(warning); }
    }
    const range = metadata?.displayRange;
    if ($("simple-bounds-help")) text($("simple-bounds-help"), (Array.isArray(range) ? "Printed reference: " + range[0] + "–" + range[1] + " " + simpleUnit() + ". This is not a safe operating window; zero may mean burr contact. " : "No universal operating range is known. ") + "For learning, enter the lowest and highest settings you permit for this coffee. Leave blank until you have checked them.");
  }
  function saveNativeSetup() {
    const profile = activeProfile(), step = simpleNumber("simple-step"), sign = Number($("simple-finer")?.value);
    if (simplePractice || !profile || profile.model !== config().grinder || !$("simple-confirm-dial")?.checked || !(step > 0) || ![-1, 1].includes(sign)) return;
    profile.stepSize = step;
    profile.nativeSetup = {settingUnit: simpleUnit(), burrIdentity: config().burrs, calibrationEpoch: config().calibration, numericFinerDelta: sign, min: simpleNumber("simple-bound-min"), max: simpleNumber("simple-bound-max")};
    persistProfiles();
  }
  function nativeScope() {
    const c = config();
    return {beanId: JSON.stringify([c.bean, c.roaster, c.species, c.roast]), grinderId: c.grinderId, burrIdentity: c.burrs, calibrationEpoch: JSON.stringify([c.calibration, c.dialCalibration ? ["grinderId", "model", "burrIdentity", "calibrationEpoch", "dialMin", "dialMax", "dialA", "ddDumA", "dialB", "ddDumB"].map(key => c.dialCalibration[key] ?? null) : null]),
      settingUnit: simpleUnit(), doseG: c.dose, yieldG: c.yield, profile: $("simple-profile-name")?.value || "", clock: "pump", controlMode: $("simple-pressure-confirmed")?.checked ? "pressure" : "unknown"};
  }
  function nativeResolution() {
    const profile = dialProfile();
    return profile?.visibleUnit === "clicks" || profile?.model === "Baratza Encore ESP" ? profile.visibleStep : undefined;
  }
  function nativeResponse() {
    const latest = simpleShots.at(-1);
    if (!latest || !algorithms.recommendNativeResponse) return null;
    if (dialProfile()?.espressoAdjustment?.espressoSupported === false) return {status: "abstain", reasonCode: "unsupported_grinder", reason: "This grinder is not supported for espresso; no espresso adjustment is proposed."};
    return algorithms.recommendNativeResponse({scope: nativeScope(), currentSetting: simpleNumber("simple-current-dial"), targetTimeSec: config().target, toleranceSec: config().tolerance,
      stepNative: simpleNumber("simple-step"), nativeResolution: nativeResolution(), numericFinerDelta: Number($("simple-finer")?.value), bounds: {min: simpleNumber("simple-bound-min"), max: simpleNumber("simple-bound-max")},
      stepConfirmed: $("simple-confirm-dial")?.checked === true, clockConfirmed: latest.clockConfirmed, recipeConfirmed: latest.pressureConfirmed,
      taste: latest.taste, prepConcern: ["weak", "channeling"].includes(latest.taste), shots: simpleShots.map(shot => ({id: shot.id, setting: shot.setting, timeSec: shot.time, taste: shot.taste,
        scope: shot.scope, clockConfirmed: shot.clockConfirmed, recipeConfirmed: shot.pressureConfirmed, prepConcern: ["weak", "channeling"].includes(shot.taste)}))});
  }
  function guideTo(holder, label, destination, field, advance) {
    const button = document.createElement("button"); button.type = "button"; text(button, label);
    button.addEventListener("click", () => {
      if (advance) { $("simple-continue")?.click(); return; }
      const step = destination === "research-inputs" ? 4 : destination === "simple-brew" ? 3 : destination === "simple-profile-name" ? 2 : 1;
      navigateSimple(step); const panel = $(destination); if (panel) { panel.classList.toggle("expert-only", false); panel.open = true; panel.scrollIntoView?.({block: "start"}); }
      if (field) { const input = $(field), details = input?.closest?.("details"); if (details) details.open = true; input?.focus(); }
    }); holder.append(button);
  }
  function renderNativeResponse(response = nativeResponse()) {
    const holder = $("native-response"); if (!holder) return;
    holder.replaceChildren();
    if (!response) { text(holder, "Record a completed shot with its actual dial setting and time. Keep the coffee, dose, cup weight and machine recipe unchanged as you compare."); guideTo(holder, "Record a measured shot", "simple-brew", "simple-time"); return; }
    holder.setAttribute("data-status", response.status); holder.setAttribute("data-reason", response.reasonCode);
    const summary = document.createElement("p");
    text(summary, simpleComparisonStale ? "Inputs changed. Record the corrected shot to refresh the comparison; it will replace the last entry." : response.reason); holder.append(summary);
    if (simpleComparisonStale) { guideTo(holder, "Refresh the recorded shot", "simple-brew", "simple-record"); return; }
    if (response.status === "suggestion") { const next = document.createElement("p"); text(next, "Bounded next test: " + Number(response.proposedSetting.toFixed(6)) + " " + simpleUnit() + ". This estimate uses your measured shots and moves at most your confirmed step."); holder.append(next); }
    else if (response.suggestedTrial) { const trial = document.createElement("p"); text(trial, "Optional owner trial: " + Number(response.suggestedTrial.setting.toFixed(6)) + " " + simpleUnit() + ". This is one small step to collect evidence, not a learned prediction."); holder.append(trial); }
    if (response.reasonCode === "invalid_setup" || response.reasonCode === "confirmation_required") guideTo(holder, "Check step, direction and allowed trial window", "simple-dial-setup", "simple-bound-min");
    else if (response.reasonCode === "incomplete_scope") {
      if (!$("simple-profile-name")?.value.trim()) guideTo(holder, "Name this machine recipe", "simple-profile-name", "simple-profile-name");
      else guideTo(holder, "Check coffee and grinder details", "simple-grinder-context", "burrs");
    }
    else if (["unsupported_controller", "no_eligible_shot", "taste_required"].includes(response.reasonCode)) guideTo(holder, "Check this shot and recipe", "simple-brew", "simple-pressure-confirmed");
    else if (response.status === "hold" && response.reasonCode !== "balanced") guideTo(holder, "Repeat the current setting", "simple-brew", "simple-time", true);
    const fit = response.fit;
    if (fit) {
      const details = document.createElement("details"), caption = document.createElement("summary"); text(caption, "Measured settings and timing diagnostics"); details.append(caption);
      const points = document.createElement("ul"); (fit.points || []).forEach(point => { const row = document.createElement("li"); text(row, point.setting + " " + simpleUnit() + " → " + Number(point.timeSec.toFixed(3)) + " s median, " + point.count + " shot(s), " + Number(point.repeatRangeSec.toFixed(3)) + " s spread."); points.append(row); }); details.append(points);
      const diagnostics = document.createElement("p"); text(diagnostics, (fit.slopeSecPerNativeUnit == null ? "A timing slope is not available yet." : "Local timing slope: " + Number(fit.slopeSecPerNativeUnit.toFixed(3)) + " seconds per " + simpleUnit() + ".") + (fit.rawTargetSetting == null ? "" : " The full line points toward " + Number(fit.rawTargetSetting.toFixed(3)) + " " + simpleUnit() + "; this raw estimate is not an instruction to jump there.") + " " + (fit.repeatabilityMeasured ? "Repeats are included." : "No same-setting repeat has measured repeatability yet.")); details.append(diagnostics);
      const policy = document.createElement("p"); text(policy, "This is a local timing estimate, not a measurement of extraction or a conversion of dial marks to micrometres. The stability checks are software screening rules, not validated confidence percentages."); details.append(policy); holder.append(details);
    }
    if (response.excluded?.length) { const excluded = document.createElement("p"); text(excluded, "Older shots outside the current matching recipe, setup or local setting window are left out; they remain in your history."); holder.append(excluded); }
  }
  function recordSimpleShot() {
    const c = config(), current = simpleNumber("simple-current-dial"), actual = simpleNumber("simple-time"), taste = $("simple-taste").value;
    const fail = message => { text($("simple-brew-status"), message); };
    if (!simpleEditingShot && simpleShots.length >= 100) return fail("This session has 100 shots. Start a new coffee to begin another session.");
    if (!c.bean.trim()) return fail("Enter your coffee name in step 1.");
    if (!$("simple-profile-name")?.value.trim()) {
      fail("Enter the machine recipe name in step 2 before recording this shot.");
      guideTo($("simple-brew-status"), "Name this machine recipe", "simple-profile-name", "simple-profile-name");
      return;
    }
    if (current == null) return fail("Read the dial on your grinder and enter its current setting in step 1.");
    if (nativeResolution() === 1 && !Number.isInteger(current)) return fail("Enter the whole click setting used on this grinder, including complete turns for total-click scales.");
    if (actual == null || actual <= 0 || actual > 600) return fail("Enter the time you measured, between 0 and 600 seconds.");
    if (![c.dose, c.yield, c.target].every(value => value > 0) || c.dose > 100 || c.yield > 200 || c.target > 600) return fail("Check the dose, cup weight and target time in your recipe.");
    const temperature = simpleNumber("simple-temperature"), minutes = simpleNumber("simple-minutes");
    if ((temperature != null && (temperature < 0 || temperature > 150)) || (minutes != null && (minutes < 0 || minutes > 10080))) return fail("Check the optional temperature and tasting time.");
    const profile = {"DF54": "df54", "DF64": "df64_gen1", "DF64 Gen 1": "df64_gen1", "DF64 Gen 2": "df64_gen2", "E64 WS": "e64ws"}[c.grinder];
    const step = simpleNumber("simple-step"), sign = Number($("simple-finer").value), confirmed = $("simple-confirm-dial").checked && step > 0 && [-1, 1].includes(sign);
    let manualInput = null;
    let action = "Keep the grinder at " + current + " " + simpleUnit() + ".", why, result = null;
    if (dialProfile()?.espressoAdjustment?.espressoSupported === false) why = "This grinder is not supported for espresso. No espresso dial adjustment is proposed.";
    else if (!$("simple-clock-confirmed").checked) why = "Repeat this recipe, timing from pump start and stopping at the target cup weight. We need the same timing method before comparing shots.";
    else if (!$("simple-pressure-confirmed").checked) why = "Check the recipe on your machine first. A programmed flow target can change the meaning of shot time, so time alone cannot tell us to move the dial.";
    else if (!taste) why = "Let the coffee cool enough to sip comfortably, then taste it. Enter whether you like it or which taste you want to change.";
    else if (["weak", "channeling"].includes(taste)) why = taste === "channeling" ? "Repeat the recipe with an evenly prepared coffee bed. Uneven flow needs a preparation check before a grind change." : "Check the weighed coffee and cup weight, then repeat. A weak taste alone does not tell us which way to turn.";
    else if (!profile) why = "This grinder does not have a supported small-step rule here yet. Keep this measured shot as your starting point; use the grinder’s own adjustment guide.";
    else {
      try {
        manualInput = {profile, currentDial: current, actualTimeSec: actual, targetTimeSec: c.target, toleranceSec: c.tolerance, flavor: taste, ...(profile === "e64ws" ? {settingUnit: "micrometres"} : {}), ...(confirmed ? {...(profile === "e64ws" ? {stepNative: step} : {stepMarks: step}), numericFinerDelta: sign} : {})};
        result = algorithms.recommendManual(manualInput);
      } catch (error) { return fail("Check your grinder setting: " + error.message); }
      if (taste === "balanced") why = "You like this coffee. Repeat the same recipe and setting; you do not need to chase the timer.";
      else if (result.direction === "none") why = "The time and taste do not point to the same change. Repeat the same recipe and taste again once it has cooled.";
      else if (!confirmed) why = "Before a numbered adjustment, open “Set up one small dial movement” in step 1 and confirm a small step and which way the numbers move when you turn finer.";
      else if (result.proposedDial == null) why = "That step would leave the reference dial range. Check your grinder’s limits before making a change.";
      else {
        const movement = step === 0.5 && simpleUnit() === "marks" ? "half a mark" : step + " " + simpleUnit();
        action = (profile === "e64ws" ? "Set " : "Turn ") + result.direction + " by " + movement + ": from " + current + " to " + Number(result.proposedDial.toFixed(6)) + " " + simpleUnit() + ".";
        why = "Try this one small change because " + (actual < c.target - c.tolerance ? "your shot ran faster than your target" : actual > c.target + c.tolerance ? "your shot ran slower than your target" : "you want the taste to change") + ". Keep the coffee weight and cup weight the same, then time and taste again.";
      }
    }
    let coordinate = null;
    try { const normalized = algorithms.normalizeGrinderSetting({model: c.grinder, value: current, burrIdentity: c.burrs, calibrationEpoch: c.calibration, grinderId: c.grinderId, calibration: dialCalibration}); if (normalized.status === "normalized") coordinate = normalized.algorithm.ddDum; } catch (_) { /* Native response does not need a research conversion. */ }
    const shot = {id: simpleEditingShot ? simpleShots.at(-1).id : "native-shot-" + nextNativeShotId++, ...(simpleEditingShot ? {researchSeries: simpleShots.at(-1).researchSeries, researchOrdinal: simpleShots.at(-1).researchOrdinal} : {}), scope: nativeScope(), setting: current, time: actual, taste, temperature, minutes, practice: simplePractice,
      target: c.target, tolerance: c.tolerance, clockConfirmed: $("simple-clock-confirmed").checked, pressureConfirmed: $("simple-pressure-confirmed").checked, coordinate, manualInput, manualAction: action, manualWhy: why};
    if (simpleEditingShot) simpleShots[simpleShots.length - 1] = shot; else simpleShots.push(shot);
    simpleEditingShot = true; simpleComparisonStale = false;
    const learned = nativeResponse();
    simpleProposal = result?.direction !== "none" ? result?.proposedDial ?? current : current;
    if (learned?.status === "suggestion" && Number.isFinite(learned.proposedSetting)) {
      simpleProposal = learned.proposedSetting;
      action = "Try " + Number(simpleProposal.toFixed(6)) + " " + simpleUnit() + " next (currently " + current + ").";
      why = "Your matching measured shots support this small " + learned.direction + " test. Keep the recipe unchanged and measure again.";
    } else if (["repeat_variation", "wrong_or_flat_slope", "latest_plateau", "latest_reversal", "response_below_tolerance", "unstable_fit", "fit_direction_conflict", "operating_bounds", "native_resolution"].includes(learned?.reasonCode)) {
      simpleProposal = current; action = "Keep the grinder at " + current + " " + simpleUnit() + " and repeat the shot."; why = learned.reason;
    } else if (!profile && learned?.suggestedTrial) {
      simpleProposal = learned.suggestedTrial.setting; action = "Optional small trial: from " + current + " to " + Number(simpleProposal.toFixed(6)) + " " + simpleUnit() + ".";
      why = "This uses the step you checked, not a learned prediction. Keep the recipe unchanged and record what happens.";
    }
    if (learned?.suggestedTrial && profile && simpleProposal !== current) why += " This is an owner-confirmed trial, not a learned prediction yet.";
    const min = simpleNumber("simple-bound-min"), max = simpleNumber("simple-bound-max");
    if (min != null && max != null && !(min < max) || min != null && simpleProposal < min || max != null && simpleProposal > max) {
      simpleProposal = current; action = "Keep the grinder at " + current + " " + simpleUnit() + "."; why = "The proposed move is outside your allowed trial window. Check the window before changing the dial."; shot.manualAction = action; shot.manualWhy = why;
    }
    shot.action = action; shot.why = why; shot.nativeResponse = learned; saveNativeSetup();
    const holder = $("simple-advice"); holder.replaceChildren();
    const heading = document.createElement("h3"), reason = document.createElement("p"); text(heading, action); text(reason, why); holder.append(heading, reason);
    if (!confirmed) guideTo(holder, "Check my small step", "simple-dial-setup", "simple-step");
    if (!shot.clockConfirmed || !shot.pressureConfirmed) guideTo(holder, "Check my recorded recipe", "simple-brew", "simple-clock-confirmed");
    if (result) { const details = document.createElement("details"), summary = document.createElement("summary"), explanation = document.createElement("p"); text(summary, "Why this suggestion?"); text(explanation, (result.reasons || []).join(". ") + ". This is a cautious taste experiment using the small step you confirmed, not a measured extraction diagnosis or a prediction of your grinder’s response."); details.append(summary, explanation); holder.append(details); }
    if (simplePractice) { const note = document.createElement("p"); note.className = "hint"; text(note, "Practice only: these are fictional shot times and a fictional checked dial. They do not predict your grinder’s response."); holder.append(note); }
    if (simpleProposal !== current) { const note = document.createElement("p"); note.className = "hint"; text(note, "Move the dial yourself, following your grinder’s adjustment instructions. This page cannot move it."); holder.append(note); }
    $("simple-history").replaceChildren();
    simpleShots.forEach((saved, index) => { const entry = document.createElement("li"); text(entry, (saved.practice ? "Practice " : "Shot ") + (index + 1) + " · " + saved.setting + " " + (saved.scope?.settingUnit || simpleUnit()) + " · " + saved.time + " s · " + (saved.taste || "not tasted")); $("simple-history").append(entry); });
    compareAllCalculators(); renderNativeResponse(learned); captureResearchShot(shot, c, simpleProposal);
    $("simple-continue").disabled = false; text($("simple-brew-status"), ""); setNotice("Shot recorded. Your next step is below."); navigateSimple(4);
  }
  function initializeNativeRestoration() {
    const ids = ["simple-step", "simple-finer", "simple-bound-min", "simple-bound-max", "simple-confirm-dial"];
    const clearConfirmation = () => {
      const wasChecked = $("simple-confirm-dial")?.checked;
      if ($("simple-confirm-dial")) $("simple-confirm-dial").checked = false;
      if (wasChecked) invalidateSimpleAdvice();
    };
    const restore = () => {
      clearConfirmation();
      // Browsers may restore form state after our script runs. Only the saved,
      // unit-checked profile can supply initial setup values; acknowledgement is fresh.
      ids.forEach(id => { if ($(id)) $(id).disabled = true; });
      const finish = () => {
        ids.filter(id => id !== "simple-confirm-dial").forEach(id => { if ($(id) && !nativeSetupEdited.has(id)) $(id).value = ""; });
        clearConfirmation();
        applyNativeDefaults();
        ids.forEach(id => { if ($(id)) $(id).disabled = false; });
      };
      // pageshow precedes some browsers' persisted-form restoration.
      if (window.addEventListener) setTimeout(finish, 0); else finish();
    };
    ids.forEach(id => { if ($(id)) { $(id).autocomplete = "off"; $(id).disabled = true; } });
    clearConfirmation();
    if (window.addEventListener) window.addEventListener("pageshow", restore);
    else restore();
  }
  function initializeSimple() {
    if (!$("simple-record")) return;
    $("simple-record").addEventListener("click", recordSimpleShot);
    ["simple-current-dial", "simple-step", "simple-finer", "simple-bound-min", "simple-bound-max", "simple-confirm-dial", "simple-time", "simple-taste", "simple-clock-confirmed", "simple-pressure-confirmed", "simple-temperature", "simple-minutes"].forEach(id => {
      const changed = () => {
        if (["simple-step", "simple-finer", "simple-bound-min", "simple-bound-max"].includes(id)) { nativeSetupEdited.add(id); $("simple-confirm-dial").checked = false; }
        if (id === "simple-confirm-dial") saveNativeSetup();
        invalidateSimpleAdvice(); renderSimpleRecipe();
      };
      $(id)?.addEventListener("change", changed);
      if (["simple-step", "simple-finer", "simple-bound-min", "simple-bound-max"].includes(id)) $(id)?.addEventListener("input", changed);
    });
    $("simple-reset-defaults")?.addEventListener("click", () => {
      const profile = activeProfile(); if (profile) { profile.stepSize = null; delete profile.nativeSetup; persistProfiles(); }
      nativeSetupEdited.clear(); ["simple-step", "simple-finer", "simple-bound-min", "simple-bound-max"].forEach(id => { $(id).value = ""; }); $("simple-confirm-dial").checked = false;
      applyNativeDefaults(); invalidateSimpleAdvice();
    });
    $("simple-zero-changed")?.addEventListener("click", () => {
      const profile = activeProfile(); if (!profile) return;
      profile.calibrationEpoch = "owner-change-" + Date.now(); profile.anchors = null; $("calibration").value = profile.calibrationEpoch; dialCalibration = null;
      persistProfiles(); clearSimpleSetup(); applyNativeDefaults(); simpleEditingShot = false; invalidateSimpleAdvice(); renderDialPanel(); renderSimpleRecipe();
      setNotice("Burr/zero change recorded. Old shots stay in history but will not be used for the new setup.");
    });
    $("simple-continue").addEventListener("click", () => {
      if (simpleProposal == null) return;
      $("simple-current-dial").value = String(simpleProposal); simpleProposal = null; simpleEditingShot = false;
      $("simple-time").value = ""; $("simple-taste").value = ""; $("simple-clock-confirmed").checked = false;
      $("simple-temperature").value = ""; $("simple-minutes").value = "";
      $("simple-continue").disabled = true; setNotice("Use the new setting, then brew and taste again."); renderSimpleRecipe(); navigateSimple(3);
    });
    $("simple-start-practice").addEventListener("click", () => {
      $("grinder").value = "DF64 Gen 2"; const profile = grinderInstances.find(item => item.model === "DF64 Gen 2"); if (profile) setActiveProfile(profile.id, false);
      clearSimpleShots(); simplePractice = true;
      $("simple-current-dial").value = "20"; $("simple-step").value = "0.5"; $("simple-finer").value = "-1"; $("simple-bound-min").value = "15"; $("simple-bound-max").value = "25"; $("simple-confirm-dial").checked = true;
      $("simple-pressure-confirmed").checked = true; $("simple-practice").hidden = false;
      setNotice("Fictional practice is on. These example times do not predict a real grinder.");
      text($("simple-practice-status"), "Fictional practice is on. Example dial: 20 marks, half-mark steps, lower numbers finer. Start a new coffee before using real measurements.");
      renderSimpleRecipe(); navigateSimple(2);
    });
    $("simple-practice").addEventListener("click", () => {
      if (!simplePractice) return;
      const offset = [-6, -2, 0][Math.min(simpleShots.length, 2)];
      $("simple-time").value = String(Math.max(1, config().target + offset)); $("simple-clock-confirmed").checked = true;
      $("simple-taste").value = offset ? "too sour" : "balanced"; recordSimpleShot();
    });
    $("simple-new").addEventListener("click", () => { clearSimpleSetup(); clearSimpleShots(); applyNativeDefaults(); renderSimpleRecipe(); navigateSimple(1); });
    applyNativeDefaults(); renderSimpleRecipe(); renderNativeResponse();
  }

  function init() {
    algorithms = window.createResearchAlgorithms || window.DecaidResearchAlgorithms;
    if (typeof algorithms !== "function") { setNotice("The shipped algorithm factory is not available. Open this page through the plugin package, then reload.", true); return; }
    algorithms = algorithms();
    initializeEvidenceUi();
    if (typeof window.DecaidDialInSimulation === "function") simulationEngine = window.DecaidDialInSimulation(algorithms);
   
    $("next").addEventListener("click", runNext); $("run").addEventListener("click", runAll); $("reset").addEventListener("click", reset); $("replay").addEventListener("click", replay); $("undo").addEventListener("click", undo); $("export").addEventListener("click", download); $("import").addEventListener("change", importFile); $("add").addEventListener("click", () => { addRow(recommendation(), ""); render(); });
    const wizardButtons = typeof document.querySelectorAll === "function" ? [...document.querySelectorAll("[data-wizard-step]")].filter(button => button.tagName === "BUTTON") : [];
    const wizardPanels = typeof document.querySelectorAll === "function" ? [...document.querySelectorAll("section[data-wizard-step]")] : [];
    let wizardStep = 1;
    const wizardNames = ["Coffee and grinder", "Your recipe", "Brew and taste", "Your next step"];
    const showWizardStep = (step, focus = true) => { wizardStep = Math.max(1, Math.min(4, step)); wizardPanels.forEach(panel => { panel.hidden = Number(panel.getAttribute("data-wizard-step")) !== wizardStep; }); wizardButtons.forEach(button => { const active = Number(button.getAttribute("data-wizard-step")) === wizardStep; button.setAttribute("aria-current", active ? "step" : "false"); }); const status = $("wizard-status"); if (status) text(status, "Step " + wizardStep + " of 4 · " + wizardNames[wizardStep - 1]); const back = $("wizard-back"), next = $("wizard-next"); if (back) back.disabled = wizardStep === 1; if (next) { next.disabled = false; next.hidden = viewMode === "simple" && wizardStep >= 3; text(next, wizardStep === 1 ? "Next: recipe" : wizardStep === 2 ? "Next: brew and taste" : "Next"); } if (focus) { const panel = wizardPanels.find(item => !item.hidden && !item.className.split(" ").includes(viewMode === "simple" ? "expert-only" : "simple-only")); if (panel) { panel.setAttribute("tabindex", "-1"); panel.focus?.({preventScroll: true}); panel.scrollIntoView?.({block: "start"}); } } };
    navigateSimple = showWizardStep;
    wizardButtons.forEach(button => button.addEventListener("click", () => showWizardStep(Number(button.getAttribute("data-wizard-step")))));
    $("wizard-back")?.addEventListener("click", () => showWizardStep(wizardStep - 1)); $("wizard-next")?.addEventListener("click", () => showWizardStep(wizardStep + 1)); showWizardStep(1, false);
    const mode = $("view-mode"); if (mode) { try { viewMode = window.localStorage?.getItem("decaid.assisted-dialin.view-mode") === "expert" ? "expert" : "simple"; } catch (_) {} mode.value = viewMode; document.body.classList.toggle("simple-mode", viewMode === "simple"); mode.addEventListener("change", () => { viewMode = mode.value === "expert" ? "expert" : "simple"; document.body.classList.toggle("simple-mode", viewMode === "simple"); try { window.localStorage?.setItem("decaid.assisted-dialin.view-mode", viewMode); } catch (_) {} showWizardStep(wizardStep); render(); }); }
    $("algorithm").addEventListener("change", () => { reset(); setNotice("Algorithm changed, so the experiment was reset to avoid mixing histories."); }); let lightTheme = false;
    try { lightTheme = storage()?.getItem("decaid.assisted-dialin.theme") === "light"; } catch (_) {}
    document.body.classList.toggle("light", lightTheme); text($("theme"), lightTheme ? "Dark mode" : "Light mode");
    $("theme").addEventListener("click", () => { lightTheme = !lightTheme; document.body.classList.toggle("light", lightTheme); text($("theme"), lightTheme ? "Dark mode" : "Light mode"); try { storage()?.setItem("decaid.assisted-dialin.theme", lightTheme ? "light" : "dark"); } catch (_) {} });
    $("catalog-search").addEventListener("input", () => { referencePage = 1; renderCatalog(); }); $("coffee-catalog-search")?.addEventListener("input", () => { coffeeCatalogPage = 1; renderCoffeeCatalog(); }); ensureProfiles(); render(); loadCatalog(); loadCoffeeCatalog(); loadDialProfiles().finally(clearRestoredDialConfirmation); setNotice(viewMode === "simple" ? "Choose your coffee and grinder, then continue to the recipe for your first shot." : "Ready. The first shot uses your starting setting and bean-aware fictional plant.");
    $("assist-overall")?.addEventListener("change", () => { invalidateAssistant(); const latest = rows.filter(row => row.actual !== "" && Number(row.actual) > 0).at(-1); if (latest) { latest.overall = $("assist-overall").value; renderTable(); } });
    $("assist-taste").addEventListener("change", () => { invalidateAssistant(); const latest = rows.filter(row => row.actual !== "" && Number(row.actual) > 0).at(-1); if (latest) { latest.taste = $("assist-taste").value || "none"; renderTable(); } });
    $("helper").addEventListener("change", renderHelperFields); $("helper-run").addEventListener("click", runHelper); $("assist").addEventListener("click", runAssistant); renderHelperFields(); watchContextChanges(); initializeSimple(); initializeResearchSharing(); initializeMechanical(); initializeNativeRestoration();
  }
  init();
}());
