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
  const slug = (value) => String(value || "grinder").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "grinder";
  function storage() { try { return window.localStorage; } catch (_) { return null; } }
  function profileId(model, suffix) { return "grinder-" + slug(model) + "-" + suffix; }
  function profileFromTemplate(profile, index) {
    const model = String(profile.model || "Other known grinder");
    return { id: profileId(model, "template-" + index), name: model + " · example", model, burrIdentity: "stock burrs · zero 0 · epoch 1", calibrationEpoch: "epoch 1", zero: profile.zero ?? 0, stepSize: profile.stepSize ?? null, anchors: null, source: "shipped example; calibrate this physical grinder" };
  }
  function validProfile(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(value.id) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 128 || typeof value.model !== "string" || !value.model.trim() || value.model.length > 256 || typeof value.burrIdentity !== "string" || !value.burrIdentity.trim() || value.burrIdentity.length > 256 || typeof value.calibrationEpoch !== "string" || !value.calibrationEpoch.trim() || value.calibrationEpoch.length > 256) return false;
    return (value.zero == null || (typeof value.zero === "number" && Number.isFinite(value.zero) && Math.abs(value.zero) <= 2147483647)) && (value.stepSize == null || (typeof value.stepSize === "number" && Number.isFinite(value.stepSize) && value.stepSize > 0 && value.stepSize <= 2147483647)) && (value.anchors == null || (typeof value.anchors === "object" && !Array.isArray(value.anchors))) && (value.source == null || (typeof value.source === "string" && value.source.length <= 256));
  }
  function persistProfiles() { const store = storage(); if (!store) return; try { store.setItem(INSTANCE_KEY, JSON.stringify(grinderInstances)); store.setItem(ACTIVE_INSTANCE_KEY, activeInstanceId || ""); } catch (_) { setNotice("Your browser could not save grinder profiles; this experiment still works in memory.", true); } }
  function activeProfile() { return grinderInstances.find(profile => profile.id === activeInstanceId) || grinderInstances[0] || null; }
  function profileCalibration(profile) { return profile && profile.anchors ? { ...profile.anchors, grinderId: profile.id, model: profile.model, burrIdentity: profile.burrIdentity, calibrationEpoch: profile.calibrationEpoch } : null; }
  function setActiveProfile(id, announce) {
    const profile = grinderInstances.find(item => item.id === id); if (!profile) return;
    activeInstanceId = profile.id; $("grinder").value = profile.model; $("burrs").value = profile.burrIdentity; $("calibration").value = profile.calibrationEpoch; dialCalibration = profileCalibration(profile); persistProfiles();
    reset(); renderDialPanel(); renderInstanceManager(); if (announce) setNotice("Switched to " + profile.name + ". Shot history and algorithm memory were reset for this individual grinder.");
  }
  function ensureProfiles() {
    const store = storage(); let loaded = null;
    try { loaded = store && JSON.parse(store.getItem(INSTANCE_KEY) || "null"); } catch (_) { loaded = null; }
    if (Array.isArray(loaded) && loaded.length && loaded.length <= 100 && loaded.every(validProfile) && new Set(loaded.map(item => item.id)).size === loaded.length) grinderInstances = loaded;
    if (!grinderInstances.length) grinderInstances = [profileFromTemplate({ model: "DF64 Gen 2", zero: 0 }, 0), profileFromTemplate({ model: "DF54", zero: 0 }, 1), profileFromTemplate({ model: "E64 WS", zero: 0 }, 2)];
    let preferred = null; try { preferred = store && store.getItem(ACTIVE_INSTANCE_KEY); } catch (_) {}
    activeInstanceId = grinderInstances.some(item => item.id === preferred) ? preferred : grinderInstances[0].id;
    const profile = activeProfile(); dialCalibration = profileCalibration(profile); $("burrs").value = profile.burrIdentity; $("calibration").value = profile.calibrationEpoch;
    persistProfiles(); renderInstanceManager();
  }
  function renderInstanceManager() {
    const select = $("grinder-instance"); if (!select) return; select.replaceChildren(); grinderInstances.forEach(profile => { const option = document.createElement("option"); option.value = profile.id; text(option, profile.name + " · " + profile.model); select.append(option); }); select.value = activeInstanceId || "";
    const holder = $("grinder-profiles"); if (!holder) return; holder.replaceChildren();
    const copy = document.createElement("p"); copy.className = "hint"; text(copy, "Profile ID " + (activeInstanceId || "none") + ". Each saved unit has its own zero, step size and measured anchors."); holder.append(copy);
    const profile = activeProfile(); const profileFields = document.createElement("div"); profileFields.className = "fields compact";
    const zeroField = document.createElement("label"); text(zeroField, "Owner zero (native units)"); const zeroInput = document.createElement("input"); zeroInput.type = "number"; zeroInput.step = "any"; zeroInput.value = profile?.zero ?? 0; zeroInput.setAttribute("aria-label", "owner zero"); zeroField.append(zeroInput);
    const stepField = document.createElement("label"); text(stepField, "Owner step size (native units)"); const stepInput = document.createElement("input"); stepInput.type = "number"; stepInput.min = "0.000001"; stepInput.step = "any"; stepInput.value = profile?.stepSize ?? ""; stepInput.setAttribute("aria-label", "owner step size"); stepField.append(stepInput); profileFields.append(zeroField, stepField); holder.append(profileFields);
    const actions = document.createElement("div"); actions.className = "actions"; const buttons = {};
    [["add-grinder", "Add individual grinder"], ["rename-grinder", "Rename"], ["save-grinder", "Save current calibration"], ["remove-grinder", "Remove"]].forEach(([id, label]) => { const button = document.createElement("button"); button.id = id; button.type = "button"; text(button, label); buttons[id] = button; actions.append(button); }); holder.append(actions);
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
      const apply = document.createElement("button"); apply.type = "button"; text(apply, "Apply owner calibration"); apply.addEventListener("click", () => { try { const candidate = { ...Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.type === "number" ? Number(input.value) : input.value])), grinderId: config().grinderId }; if (Object.entries(inputs).some(([key, input]) => input.type === "number" && input.value === "")) throw new Error("all calibration numbers are required"); const checked = algorithms.toGrinderDial({ model: config().grinder, ddDum: config().start, burrIdentity: config().burrs, calibrationEpoch: config().calibration, grinderId: config().grinderId, calibration: candidate }); if (checked.status !== "normalized") throw new Error((checked.warnings || ["two valid anchors are required"])[0]); dialCalibration = candidate; const profile = activeProfile(); if (profile) { profile.anchors = { ...candidate }; persistProfiles(); } reset(); setNotice("Owner calibration applied and scoped to this individual grinder, burr set, and epoch."); } catch (error) { setNotice(error.message, true); } }); details.append(apply);
      const clear = document.createElement("button"); clear.type = "button"; text(clear, "Reset dial calibration"); clear.addEventListener("click", () => { dialCalibration = null; const profile = activeProfile(); if (profile) { profile.anchors = null; persistProfiles(); } reset(); setNotice("Dial calibration cleared; research-only coordinates remain available."); }); details.append(clear); holder.append(details);
    }
  }
  const text = (node, value) => { node.textContent = String(value); };
  const number = (id, fallback) => {
    const value = Number($(id).value);
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
    yield: number("yield", 36)
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
    const repeatable = c.target + distance / Math.max(c.plant, 0.2) + (c.dose - 18) * 0.18 - (c.yield - 36) * 0.06;
    const wave = Math.sin((pass + 1) * 1.91 + hash(c.bean) * 11) * c.noise;
    return Math.max(1, Math.round((repeatable + wave) * 10) / 10);
  }
  function engineScenario(shotRows = rows) {
    const c = config();
    return { version: 1, scope: { grinderId: c.grinderId, beanBatchId: c.bean, burrIdentity: c.burrs, calibrationEpoch: c.calibration, profile: "espresso" }, initial: { settingDdDum: c.start }, targetBrewTimeMs: Math.round(c.target * 1000), toleranceMs: Math.round(c.tolerance * 1000), bounds: { minDdDum: 0, maxDdDum: 100000 }, seed: 1, shots: shotRows.filter((row) => row.actual !== "" && Number.isFinite(Number(row.actual)) && Number(row.actual) > 0).map((row) => ({ actualBrewTimeMs: Math.round(Number(row.actual) * 1000), targetBrewTimeMs: Math.round(Number(row.target) * 1000), toleranceMs: Math.round(c.tolerance * 1000), estimatedDdDum: Math.round(Number(row.setting)), setpointDdDum: Math.round(Number(row.setting)), scope: { grinderId: row.context?.grinderId || c.grinderId, beanBatchId: row.context?.bean || c.bean, burrIdentity: row.context?.burrs || c.burrs, calibrationEpoch: row.context?.calibration || c.calibration, profile: "espresso" }, beanType: row.context?.species || c.species, roastLevel: row.context?.roast || c.roast, taste: row.taste && row.taste !== "none" ? row.taste : undefined, dose: row.context?.dose ?? c.dose, yield: row.context?.yield ?? c.yield })) };
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
    rows.push({ setting: Math.round(setting), actual: actual == null ? "" : actual, target: c.target, pressure: c.pressure, flow: c.flow, context: { bean: c.bean, species: c.species, roast: c.roast, grinder: c.grinder, grinderId: c.grinderId, burrs: c.burrs, calibration: c.calibration, dose: c.dose, yield: c.yield }, result: null });
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
    try {
      const setting = recommendation();
      addRow(setting, simulatedTime(setting, rows.length));
      const result = consumeRow(rows[rows.length - 1], rows.length - 1);
      render();
      showResult(result);
    } catch (error) { setNotice(error.message, true); }
  }
  function runAll() {
    try {
      if (!rows.length) addRow(config().start, "");
      rows.forEach((row, index) => { if (!row.result) consumeRow(row, index); });
      render();
      showResult(rows[rows.length - 1].result);
    } catch (error) { setNotice(error.message, true); }
  }
  function reset() { rows = []; render(); showResult(null); setNotice("New experiment ready."); }
  function replay() {
    try {
      const saved = rows.map((row) => ({ ...row, result: null }));
      rows = []; saved.forEach((row, index) => { rows.push(row); consumeRow(row, index); });
      render(); showResult(rows.length ? rows[rows.length - 1].result : null); setNotice("Replay completed from a fresh algorithm state.");
    } catch (error) { setNotice(error.message, true); }
  }
  function undo() { if (rows.length) { rows.pop(); rows.forEach((row, i) => { if (row.actual !== "") consumeRow(row, i); }); render(); showResult(rows.length ? rows[rows.length - 1].result : null); } }
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
      [["setting", row.setting], ["actual", row.actual], ["target", row.target], ["pressure", row.pressure], ["flow", row.flow]].forEach(([key, value]) => { const td = document.createElement("td"); const input = document.createElement("input"); input.type = "number"; input.value = value; input.step = key === "setting" ? "1" : "0.1"; input.setAttribute("aria-label", key + " for shot " + (index + 1)); input.addEventListener("change", () => { row[key] = input.value === "" ? "" : Number(input.value); row.result = null; }); td.append(input); tr.append(td); });
      const settingCell = tr.children[1], native = nativeDisplay(row.setting), nativeLine = document.createElement("small"); text(nativeLine, "Native: " + native.label + " " + native.unit); nativeLine.className = native.value == null ? "unmapped" : "mapped"; nativeLine.setAttribute("aria-label", "native dial for shot " + (index + 1)); settingCell.append(document.createElement("br"), nativeLine);
      const tasteCell = document.createElement("td"); const taste = document.createElement("select"); ["none", "balanced", "sour", "bitter", "astringent", "weak", "channeling"].forEach((value) => { const option = document.createElement("option"); option.value = value; text(option, value === "none" ? "No taste signal" : value); taste.append(option); }); taste.value = row.taste || "none"; taste.setAttribute("aria-label", "taste for shot " + (index + 1)); taste.addEventListener("change", () => { row.taste = taste.value; }); tasteCell.append(taste); tr.append(tasteCell);
      const result = document.createElement("td"); text(result, row.result ? row.result.phase + " → " + row.result.returnedDdDum + " dD" : "planned"); tr.append(result);
      const action = document.createElement("td"); const button = document.createElement("button"); button.type = "button"; text(button, "Remove"); button.addEventListener("click", () => { rows.splice(index, 1); rows.forEach((r, i) => { if (r.actual !== "") consumeRow(r, i); }); render(); }); action.append(button); tr.append(action); body.append(tr);
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
  function compare() {
    const holder = $("compare"); holder.replaceChildren(); text($("comparison-count"), rows.length + " passes");
    if (!rows.length) { const p = document.createElement("p"); p.className = "hint"; text(p, "Run one or more shots to compare them."); holder.append(p); return; }
    algorithmNames.forEach((name) => { const engineTrial = engineRun(name); const trial = engineTrial && engineTrial.shots.length ? engineTrial.shots[engineTrial.shots.length - 1].output : null; const card = document.createElement("article"); const h = document.createElement("h3"); text(h, name); const p = document.createElement("p"); const native = trial ? nativeDisplay(trial.returnedDdDum) : null; text(p, trial ? "Next: " + trial.returnedDdDum + " dD · native " + native.label + " " + native.unit + " · " + trial.phase : "Needs a completed shot"); card.append(h, p); holder.append(card); });
  }
  let catalogSources = [];
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
    visible.forEach((source) => { const card = document.createElement("article"); const h = document.createElement("h3"); text(h, source.title); const p = document.createElement("p"); text(p, source.publisher + " · " + source.kind); const facts = document.createElement("p"); text(facts, Object.entries(source.facts || {}).map(([key, value]) => factLabel(key) + ": " + factValue(value)).join(" · ")); const scope = document.createElement("p"); text(scope, "Applies to: " + Object.values(source.scope || {}).join(" · ")); const notes = document.createElement("p"); text(notes, (source.notes || []).join(" ")); const link = document.createElement("a"); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer"; text(link, "Open source"); card.append(h, p, scope, facts, notes, link); const brewTime = source.facts && source.facts.brewTimeSec; if (source.scope && source.scope.brewMethod === "espresso" && brewTime != null) { const button = document.createElement("button"); button.type = "button"; text(button, "Use as espresso starting point"); button.addEventListener("click", () => { reset(); const midpoint = value => typeof value === "number" ? value : value && Number.isFinite(value.min) && Number.isFinite(value.max) ? (value.min + value.max) / 2 : null; const dose = midpoint(source.facts.doseG); const yieldG = midpoint(source.facts.yieldG); const time = midpoint(brewTime); $("roaster").value = source.publisher || ""; if (source.scope.coffee) $("bean").value = source.scope.coffee; if (Number.isFinite(dose)) $("dose").value = dose; if (Number.isFinite(yieldG)) $("yield").value = yieldG; if (Number.isFinite(time)) $("target").value = time; setNotice("Applied available espresso dose, yield and time as a new starting point; published ranges use their midpoint. Unspecified targets stay unchanged. Confirm the coffee and equipment."); }); card.append(document.createTextNode(" "), button); } holder.append(card); });
  }
  function loadCatalog() {
    fetch("../data/reference-catalog.json", { credentials: "same-origin" }).then((response) => { if (!response.ok) throw new Error("reference catalog unavailable"); return response.json(); }).then((catalog) => { if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.sources)) throw new Error("unsupported reference catalog"); catalogSources = catalog.sources.filter((source) => typeof source.url === "string" && source.url.startsWith("https://")); text($("catalog-status"), catalogSources.length + " reviewed"); renderCatalog(); }).catch((error) => { text($("catalog-status"), "Unavailable"); const holder = $("catalog"); const p = document.createElement("p"); p.className = "hint"; text(p, error.message); holder.append(p); });
  }
  function loadDialProfiles() {
    return fetch("../data/grinder-dials.json", { credentials: "same-origin" }).then(response => { if (!response.ok) throw new Error("dial profiles unavailable"); return response.json(); }).then(value => { const list = value && Array.isArray(value.models) ? value.models : []; dialMetadata = Object.fromEntries(list.filter(profile => profile && profile.model).map(profile => [profile.model, profile])); const select = $("grinder"), selected = activeProfile()?.model || (select && select.value); if (select && list.length) { select.replaceChildren(); list.forEach(profile => { const option = document.createElement("option"); option.value = profile.model; text(option, profile.model + " · " + (profile.unit || "native")); select.append(option); }); select.value = list.some(profile => profile.model === selected) ? selected : list[0].model; } renderInstanceManager(); renderDialPanel(); }).catch(() => {});
  }
  function render() { renderTable(); renderChart(); compare(); renderCatalog(); }
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
      if (type === "manual") value = algorithms.manual({ profile: $("h-profile").value, targetTimeSec: helperValue("h-target"), actualTimeSec: helperValue("h-actual"), currentDial: helperValue("h-dial"), stepMarks: helperValue("h-step"), flavor: $("assist-taste").value, finerDirection: $("h-direction").value || undefined, numericFinerDelta: $("h-sign").value === "" ? undefined : Number($("h-sign").value) });
      if (type === "wizard") value = algorithms.proposedDd({ model: $("h-model").value, roast: $("h-roast").value, weightMg: helperValue("h-weight") * 1000 });
      if (type === "effective") value = algorithms.effectiveDd({ residue: helperValue("h-residue") / 10 }, { grindDdDum: Math.round(helperValue("h-grind")), grindDurationMs: Math.round(helperValue("h-duration")), effectiveBaseline: helperValue("h-baseline") / 10 });
      if (type === "grindtime") value = algorithms.grindTime({ mode: Number($("h-mode").value), recipeDdUm: Math.round(helperValue("h-recipe-dd")), targetDdDum: Math.round(helperValue("h-target-dd")), recipeTimeMs: Math.round(helperValue("h-recipe-time")) });
      if (type === "inverse") value = algorithms.inverseRegression([{ x: helperValue("h-p1x"), y: helperValue("h-p1y") }, { x: helperValue("h-p2x"), y: helperValue("h-p2y") }], helperValue("h-inverse-target"));
      const out = $("helper-result"); out.replaceChildren(); const summary = document.createElement("p"); const readable = typeof value === "number" ? "Estimated coordinate: " + value + " µm" : value.adjustedTimeMs != null ? (value.optional ? "Mode 3 adjusted grind time: " + value.adjustedTimeMs + " ms." : "This mode does not adjust grind time.") : value.direction ? "Direction: " + value.direction + ". " + (value.reasons || []).join(" ") : value.result != null ? "Effective setting result: " + value.result + " dD." : "Suggested setting: " + (value.proposedDd ?? "not available") + "."; text(summary, readable); const details = document.createElement("details"); const caption = document.createElement("summary"); text(caption, "Show calculation details"); const pre = document.createElement("pre"); text(pre, JSON.stringify(value, null, 2)); details.append(caption, pre); out.append(summary, details);
    } catch (error) { const out = $("helper-result"); out.replaceChildren(); const p = document.createElement("p"); text(p, error.message); out.append(p); }
  }
  async function runAssistant() {
    try {
      if (!simulationEngine || typeof simulationEngine.replayRichSuggestions !== "function") throw new Error("The rich suggestion replay engine is not loaded yet.");
      const factory = window.createPlugin || window.DecaidCreatePlugin;
      if (typeof factory !== "function") throw new Error("The shipped plugin factory is not exposed on this page yet.");
      if (!rows.some(row => row.actual !== "" && Number(row.actual) > 0)) throw new Error("Brew a shot or enter a measured time before asking for a suggestion.");
      const replay = await simulationEngine.replayRichSuggestions(factory, engineScenario(), { now: Date.now(), catalog: { bean: { name: config().bean, roaster: config().roaster, species: config().species }, batch: { roastLevel: config().roast } }, workflow: { profile: { steps: [{ type: "espresso" }] }, context: { beanBatchId: config().bean, grinderId: config().grinderId, grinderModel: config().grinder, grinderBurrs: config().burrs, targetDoseWeight: config().dose, targetYield: config().yield, grinderSetting: String(config().start), extras: { calibrationEpoch: config().calibration, beanType: config().species, roastLevel: config().roast, basket: "standard", grinderSettingUnit: "deci-micrometre", grinderInstanceId: config().grinderId } } }, settings: { TargetTimeSec: String(config().target), TimeToleranceSec: String(config().tolerance), CurrentSetting: String(config().start), SettingUnit: "deci-micrometre", BeanBatchId: config().bean, GrinderId: config().grinderId, GrinderModel: config().grinder, BurrIdentity: config().burrs, CalibrationEpoch: config().calibration, BeanType: config().species, RoastLevel: config().roast, Dose: String(config().dose), Yield: String(config().yield) } });
      const out = $("assist-result"); out.replaceChildren(); replay.suggestions.forEach((entry) => { const article = document.createElement("article"); const h = document.createElement("h3"); text(h, "Pass " + entry.shotId + " · " + (entry.stage || entry.suggestion?.status || "unavailable")); const p = document.createElement("p"); const suggestion = entry.suggestion || {}; text(p, (suggestion.direction || "retain / gather evidence") + " · confidence " + (suggestion.confidence || "not assigned") + " · evidence " + entry.evidenceCount + " comparable shot(s)"); const bean = document.createElement("p"); bean.className = "hint"; text(bean, "Bean context: " + config().bean + " · " + config().species + " · " + config().roast + ". " + (suggestion.reason || replay.disclaimer)); article.append(h, p, bean); const references = suggestion.reviewedReferences?.matches || []; references.forEach(source => { const link = document.createElement("a"); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer"; text(link, source.title); article.append(link, document.createElement("br")); }); out.append(article); });
    } catch (error) { setNotice(error.message, true); }
  }
  function watchContextChanges() {
    ["bean", "roaster", "species", "roast", "calibration", "grinder", "burrs", "dose", "yield", "target", "tolerance", "start"].forEach((id) => $(id).addEventListener("change", () => {
      if (id === "grinder") { const match = grinderInstances.find(profile => profile.model === $("grinder").value); if (match) setActiveProfile(match.id, false); else { reset(); renderDialPanel(); } return; }
      if (["calibration", "burrs"].includes(id)) { const profile = activeProfile(); if (profile) { profile.burrIdentity = $("burrs").value; profile.calibrationEpoch = $("calibration").value; profile.anchors = null; persistProfiles(); } dialCalibration = null; }
      reset(); renderDialPanel(); setNotice("Setup changed, so old shot history and dial calibration were reset to keep context honest.");
    }));
    $("grinder-instance").addEventListener("change", () => setActiveProfile($("grinder-instance").value, true));
  }
  function scenario() { return { version: 1, setup: { ...config(), grinderInstances: grinderInstances.map(profile => ({ ...profile, anchors: profile.anchors ? { ...profile.anchors } : null })), activeGrinderInstanceId: activeInstanceId }, shots: rows.map((row) => ({ setting: row.setting, actual: row.actual, target: row.target, pressure: row.pressure, flow: row.flow, taste: row.taste || "none", context: row.context || null })) }; }
  function download() { const blob = new Blob([JSON.stringify(scenario(), null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "dial-in-scenario.json"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); }
  function validImportNumber(value, min, max, integer) {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
  }
  function validateScenario(value) {
    if (!value || Object.keys(value).some(key => !["version", "setup", "shots"].includes(key)) || value.version !== 1 || !value.setup || typeof value.setup !== "object" || Array.isArray(value.setup) || !Array.isArray(value.shots) || value.shots.length > 100) throw new Error("Unsupported scenario format.");
    const setup = value.setup; const setupKeys = new Set(["algorithm", "target", "tolerance", "start", "plant", "noise", "pressure", "flow", "bean", "roaster", "species", "roast", "calibration", "grinder", "grinderId", "burrs", "dose", "yield", "dialCalibration", "grinderInstances", "activeGrinderInstanceId"]); if (Object.keys(setup).some((key) => !setupKeys.has(key))) throw new Error("Scenario setup has an unknown field.");
    if (!algorithmNames.includes(setup.algorithm) || !validImportNumber(setup.target, 1, 600, false) || !validImportNumber(setup.start, 0, 100000, true) || !validImportNumber(setup.tolerance, 0, 60, false) || !validImportNumber(setup.plant, .2, 2, false) || !validImportNumber(setup.noise, 0, 10, false) || !validImportNumber(setup.pressure, 0, 15, false) || !validImportNumber(setup.flow, 0, 20, false) || !validImportNumber(setup.dose, 1, 100, false) || !validImportNumber(setup.yield, 1, 200, false)) throw new Error("Scenario setup contains an invalid or out-of-range value.");
    ["bean", "species", "roast", "calibration", "grinder", "burrs"].forEach(key => {
      if (typeof setup[key] !== "string" || !setup[key].trim() || setup[key].length > 256) throw new Error("Setup " + key + " must be a non-empty text value.");
    });
    if (setup.roaster != null && (typeof setup.roaster !== "string" || setup.roaster.length > 256)) throw new Error("Invalid roaster name.");
    if (setup.dialCalibration != null) { const calibration = setup.dialCalibration, textKeys = ["model", "burrIdentity", "calibrationEpoch"], numberKeys = ["dialMin", "dialMax", "dialA", "ddDumA", "dialB", "ddDumB"]; if (typeof calibration !== "object" || Array.isArray(calibration) || Object.keys(calibration).some(key => !textKeys.concat(numberKeys).includes(key)) || textKeys.some(key => typeof calibration[key] !== "string" || !calibration[key].trim() || calibration[key].length > 256) || numberKeys.some(key => !validImportNumber(calibration[key], -2147483648, 2147483647, false)) || calibration.dialA === calibration.dialB || calibration.ddDumA === calibration.ddDumB) throw new Error("Invalid dial calibration anchors."); }
    if (setup.dialCalibration != null) { try { const mapped = algorithms.toGrinderDial({ model: setup.grinder, ddDum: setup.start, burrIdentity: setup.burrs, calibrationEpoch: setup.calibration, calibration: setup.dialCalibration }); if (mapped.status !== "normalized") throw new Error((mapped.warnings || ["dial calibration cannot map this scenario"])[0]); } catch (error) { throw new Error("Invalid dial calibration: " + error.message); } }
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
        const allowed = ["bean", "species", "roast", "grinder", "grinderId", "burrs", "calibration", "dose", "yield"];
        if (Object.keys(row.context).some(key => !allowed.includes(key))) throw new Error("Shot context has an unknown field.");
        allowed.filter(key => !["dose", "yield"].includes(key)).forEach(key => { if (typeof row.context[key] !== "string" || !row.context[key].trim() || row.context[key].length > 256) throw new Error("Invalid historical shot context."); });
        if (!validImportNumber(row.context.dose, 1, 100) || !validImportNumber(row.context.yield, 1, 200)) throw new Error("Invalid historical shot recipe.");
      }
    });
    value.shots.forEach((row) => { if (!row || typeof row !== "object" || Object.keys(row).some((key) => !["setting", "actual", "target", "pressure", "flow", "taste", "context"].includes(key)) || !validImportNumber(row.setting, 0, 100000, true) || !validImportNumber(row.target, 1, 600, false) || !validImportNumber(row.pressure, 0, 15, false) || !validImportNumber(row.flow, 0, 20, false) || (row.actual !== "" && !validImportNumber(row.actual, 0.1, 600, false)) || !["none", "balanced", "sour", "bitter", "astringent", "weak", "channeling"].includes(row.taste || "none") || (row.context != null && (typeof row.context !== "object" || Array.isArray(row.context) || JSON.stringify(row.context).length > 4096))) throw new Error("Scenario contains an invalid shot."); });
  }
  function importFile(event) { const file = event.target.files && event.target.files[0]; if (!file) return; if (file.size > 256 * 1024) { setNotice("Scenario file is too large.", true); return; } const reader = new FileReader(); reader.onload = () => { try { const value = JSON.parse(String(reader.result)); validateScenario(value); const importedProfiles = Array.isArray(value.setup.grinderInstances) ? value.setup.grinderInstances.map(profile => ({ ...profile, anchors: profile.anchors ? { ...profile.anchors } : null })) : null; if (importedProfiles) grinderInstances = importedProfiles; Object.keys(value.setup).forEach((key) => { if (["dialCalibration", "grinderInstances", "activeGrinderInstanceId", "grinderId"].includes(key)) return; if ($(key) && typeof value.setup[key] === "string") $(key).value = value.setup[key]; else if ($(key)) $(key).value = String(value.setup[key]); }); activeInstanceId = value.setup.activeGrinderInstanceId || value.setup.grinderId || activeInstanceId; if (!grinderInstances.some(profile => profile.id === activeInstanceId)) activeInstanceId = grinderInstances[0].id; const profile = activeProfile(); $("grinder").value = profile.model; $("burrs").value = profile.burrIdentity; $("calibration").value = profile.calibrationEpoch; dialCalibration = profileCalibration(profile) || value.setup.dialCalibration || null; if (profile && value.setup.dialCalibration && !profile.anchors) { profile.anchors = { ...value.setup.dialCalibration, grinderId: activeInstanceId }; dialCalibration = profileCalibration(profile); } persistProfiles(); renderInstanceManager(); rows = value.shots.map((row) => ({ ...row, result: null })); rows.forEach((row, index) => { if (row.actual !== "") consumeRow(row, index); }); render(); showResult(rows.length ? rows[rows.length - 1].result : null); setNotice("Scenario imported and replayed safely."); } catch (error) { setNotice(error.message, true); } }; reader.readAsText(file); }
  function init() {
    algorithms = window.createResearchAlgorithms || window.DecaidResearchAlgorithms;
    if (typeof algorithms !== "function") { setNotice("The shipped algorithm factory is not available. Open this page through the plugin package, then reload.", true); return; }
    algorithms = algorithms();
    if (typeof window.DecaidDialInSimulation === "function") simulationEngine = window.DecaidDialInSimulation(algorithms);
   
    $("next").addEventListener("click", runNext); $("run").addEventListener("click", runAll); $("reset").addEventListener("click", reset); $("replay").addEventListener("click", replay); $("undo").addEventListener("click", undo); $("export").addEventListener("click", download); $("import").addEventListener("change", importFile); $("add").addEventListener("click", () => { addRow(recommendation(), ""); render(); });
    $("algorithm").addEventListener("change", () => { reset(); setNotice("Algorithm changed, so the experiment was reset to avoid mixing histories."); }); $("theme").addEventListener("click", () => { document.body.classList.toggle("light"); text($("theme"), document.body.classList.contains("light") ? "Dark mode" : "Light mode"); });
    $("catalog-search").addEventListener("input", renderCatalog); ensureProfiles(); render(); loadCatalog(); loadDialProfiles(); setNotice("Ready. The first shot uses your starting setting and bean-aware fictional plant.");
    $("assist-taste").addEventListener("change", () => { const latest = rows.filter(row => row.actual !== "" && Number(row.actual) > 0).at(-1); if (latest) { latest.taste = $("assist-taste").value || "none"; renderTable(); } });
    $("helper").addEventListener("change", renderHelperFields); $("helper-run").addEventListener("click", runHelper); $("assist").addEventListener("click", runAssistant); renderHelperFields(); watchContextChanges();
  }
  init();
}());
