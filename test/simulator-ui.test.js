const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const root = require("node:path").resolve(__dirname, "..");
const pluginSource = fs.readFileSync(require("node:path").join(root, "plugin.js"), "utf8");
const engineSource = fs.readFileSync(require("node:path").join(root, "simulator/engine.js"), "utf8");
const appSource = fs.readFileSync(require("node:path").join(root, "simulator/app.js"), "utf8");

class Element {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.value = "";
    this.type = "";
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this._text = "";
    this.className = "";
    this.classList = { toggle: (name, force) => { this.className = force === false ? this.className.replace(name, "") : force === true ? this.className + " " + name : this.className.includes(name) ? this.className.replace(name, "") : this.className + " " + name; } };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent || "").join(""); }
  set innerHTML(value) { this._text = String(value); this.children = []; }
  get innerHTML() { return this._text; }
  append(...items) {
    this.children.push(...items);
    if (this.tagName === "SELECT" && !this.value) {
      const first = this.children.find((child) => child && child.tagName === "OPTION");
      if (first) this.value = first.value || first.textContent;
    }
  }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = items; this._text = ""; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name, event = {}) { const callback = this.listeners.get(name); return callback ? callback({ target: this, ...event }) : undefined; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  click() { return this.dispatch("click", { target: this }); }
  focus() {}
}

function uiFixture(catalog = { schemaVersion: 1, sources: [] }, persistentStorage = null, unavailable = {}) {
  const dialData = JSON.parse(fs.readFileSync(require("node:path").join(root, "data/grinder-dials.json"), "utf8"));
  const ids = [
    "mechanical-setup", "mechanical-zero-assumed", "mechanical-enabled", "mechanical-scenario", "mechanical-slope", "mechanical-reference", "mechanical-offset", "mechanical-absolute-enabled", "mechanical-source-note", "mechanical-scenario-note", "mechanical-status", "mechanical-use-current",
    "research-local-enabled", "research-sharing-consent", "research-sharing-status", "research-sharing-destination", "research-sharing-export", "research-sharing-send", "research-sharing-disable", "research-sharing-delete", "research-sharing-endpoint", "research-sharing-apply",
    "simple-bound-min", "simple-bound-max", "simple-step-preset", "simple-bounds-help", "simple-reset-defaults", "simple-zero-changed", "simple-profile-name", "native-response", "research-calibration", "research-inputs", "simple-dial-setup", "simple-grinder-context", "simple-brew",
    "wizard-status", "grinder-load-status", "coffee-catalog", "coffee-catalog-search",
    "simple-current-dial", "simple-step", "simple-finer", "simple-confirm-dial", "simple-unit", "simple-start-practice", "simple-practice-status", "simple-time", "simple-taste", "simple-clock-confirmed", "simple-pressure-confirmed", "simple-temperature", "simple-minutes", "simple-record", "simple-practice", "simple-brew-status", "simple-advice", "simple-continue", "simple-new", "simple-history", "simple-recipe-summary", "simple-brew-summary",
    "view-mode", "notice", "theme", "algorithm", "grinder", "grinder-instance", "grinder-profiles", "add-grinder", "rename-grinder", "save-grinder", "remove-grinder", "burrs", "bean", "roaster", "species", "roast", "calibration", "dose", "yield", "target", "start", "tolerance", "plant", "noise", "pressure", "flow", "next", "run", "reset", "add", "undo", "shots", "assist-profile", "assist-dial", "assist-taste", "assist-overall", "assist", "assist-result", "helper", "helper-fields", "helper-run", "helper-result", "replay", "result", "explain", "comparison-count", "compare", "chart", "dial-panel", "export", "import", "catalog-status", "catalog-search", "catalog", "profile-picker", "all-comparison-inputs", "all-comparison-results", "all-comparison-context", "comparison-source", "compare-all-lab", "shot-trace-import", "clear-shot-trace", "export-shot-trace", "shot-trace-status", "actual-shot-trace", "actual-shot-details", "actual-shot-time", "actual-shot-clock", "taste-temperature", "taste-minutes", "manual-stop-confirmed",
  ];
  const elements = new Map(ids.map((id) => [id, new Element("div", id)]));
  elements.get("simple-profile-name").value = "My pressure espresso";
  ["algorithm", "grinder", "species", "roast", "assist-profile", "assist-taste", "helper", "theme"].forEach((id) => { elements.get(id).tagName = "SELECT"; });
  ["dose", "yield", "target", "start", "tolerance", "plant", "noise", "pressure", "flow", "assist-dial", "catalog-search"].forEach((id) => { elements.get(id).tagName = "INPUT"; });
  Object.assign(elements.get("algorithm"), { value: "GbS1" });
  Object.assign(elements.get("grinder"), { value: "DF64 Gen 2" });
  Object.assign(elements.get("burrs"), { value: "stock burrs · zero 0 · epoch 1" });
  Object.assign(elements.get("bean"), { value: "Washed Ethiopia" });
  Object.assign(elements.get("species"), { value: "Arabica" });
  Object.assign(elements.get("roast"), { value: "light" });
  Object.assign(elements.get("calibration"), { value: "epoch 1" });
  Object.assign(elements.get("dose"), { value: "18" });
  Object.assign(elements.get("yield"), { value: "36" });
  Object.assign(elements.get("target"), { value: "28" });
  Object.assign(elements.get("start"), { value: "500" });
  Object.assign(elements.get("tolerance"), { value: "1" });
  Object.assign(elements.get("plant"), { value: "1" });
  Object.assign(elements.get("noise"), { value: "0.8" });
  Object.assign(elements.get("pressure"), { value: "9" });
  Object.assign(elements.get("flow"), { value: "2.2" });
  Object.assign(elements.get("assist-profile"), { value: "df64_gen2" });
  Object.assign(elements.get("assist-taste"), { value: "" });
  Object.assign(elements.get("helper"), { value: "manual" });
  elements.get("actual-shot-clock").value = "pump";
  const document = {
    body: new Element("body"),
    getElementById(id) {
      const walk = (node) => {
        if (node && node.id === id) return node;
        for (const child of (node && node.children) || []) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return elements.get(id) || [...elements.values()].map(walk).find(Boolean) || null;
    },
    createElement(tag) { return new Element(tag); },
    createElementNS(_namespace, tag) { return new Element(tag); },
    createTextNode(value) { const node = new Element("text"); node.textContent = value; return node; },
  };
  const downloads = [], windowEvents = new Map();
  class BlobFixture {
    constructor(parts, options) { this.parts = parts; this.type = options?.type || ""; this.size = parts.reduce((sum, part) => sum + String(part).length, 0); }
  }
  class FileReaderFixture {
    readAsText(file) { this.result = file.text; if (this.onload) this.onload(); }
  }
  const URLFixture = URL;
  URLFixture.createObjectURL = (blob) => { downloads.push(blob); return "blob:simulator"; };
  URLFixture.revokeObjectURL = () => {};
  const context = {
    console,
    addEventListener(name, listener) { windowEvents.set(name, listener); },
    Date,
    JSON,
    Math,
    Number,
    Object,
    Set,
    Promise,
    URL,
    URLSearchParams,
    location: { href: "https://example.test/simulator/" },
    DECAID_RESEARCH_CONFIG: unavailable.researchConfig,
    document,
    window: null,
    globalThis: null,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    fetch: async (url) => ({ ok: !(String(url).includes("grinder-dials") && unavailable.grinders || String(url).includes("coffee-catalog") && unavailable.coffee), json: async () => String(url).includes("coffee-catalog") ? {products: [{name: "Retry coffee", beanEligible: true}]} : String(url).includes("grinder-dials") ? dialData : String(url).includes("decent-profiles") ? JSON.parse(fs.readFileSync(require("node:path").join(root, "data/decent-profiles.json"), "utf8")) : catalog }),
    localStorage: persistentStorage || { data: new Map(), getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }, setItem(key, value) { this.data.set(key, String(value)); }, removeItem(key) { this.data.delete(key); } },
    Blob: BlobFixture,
    FileReader: FileReaderFixture,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${pluginSource}\nthis.createResearchAlgorithms = createResearchAlgorithms; this.createResearchSharing = typeof createResearchSharing === "function" ? createResearchSharing : undefined; this.createGrinderMechanics = typeof createGrinderMechanics === "function" ? createGrinderMechanics : undefined; this.createGrinderMechanicsCatalog = typeof createGrinderMechanicsCatalog === "function" ? createGrinderMechanicsCatalog : undefined;`, context);
  vm.runInContext(engineSource, context);
  vm.runInContext(appSource, context);
  return { context, elements, downloads, windowEvents };
}

test("simulator UI runs a first shot and renders every comparison algorithm", () => {
  const ui = uiFixture();
  ui.elements.get("next").click();
  assert.equal(ui.elements.get("shots").children.length, 1);
  assert.match(ui.elements.get("result").textContent, /Candidate/);
  assert.equal(ui.elements.get("compare").children.length, 5);
  assert.match(ui.elements.get("comparison-count").textContent, /1 passes/);
  assert.ok(ui.elements.get("chart").children.length > 0);
  assert.match(ui.elements.get("chart").textContent, /Brew time \(seconds\)|Algorithm setting \(dD\)/);
  assert.match(ui.elements.get("notice").textContent, /first shot/i);
});

test("simulator keeps research dD separate and saves owner dial anchors", () => {
  const ui = uiFixture();
  assert.match(ui.elements.get("dial-panel").textContent, /calibration required|dial mark/i);
  ui.elements.get("next").click();
  ui.elements.get("export").click();
  const saved = JSON.parse(ui.downloads[0].parts.join(""));
  saved.setup.dialCalibration = { model: "DF64 Gen 2", burrIdentity: "stock burrs · zero 0 · epoch 1", calibrationEpoch: "epoch 1", dialMin: 0, dialMax: 90, dialA: 0, ddDumA: 300, dialB: 90, ddDumB: 1200 };
  ui.elements.get("reset").click();
  ui.elements.get("import").dispatch("change", { target: { files: [{ size: JSON.stringify(saved).length, text: JSON.stringify(saved) }] } });
  assert.match(ui.elements.get("dial-panel").textContent, /500 dD → 20 marks/);
  assert.match(ui.elements.get("shots").textContent, /Native: 20 marks/);
});

function panelInput(ui, label) {
  const walk = (node) => { if (node && node.attributes?.["aria-label"] === label) return node; for (const child of node?.children || []) { const found = walk(child); if (found) return found; } return null; };
  return walk(ui.elements.get("dial-panel"));
}

function managerButton(ui, label) {
  const walk = (node) => { if (node && node.tagName === "BUTTON" && node.textContent === label) return node; for (const child of node?.children || []) { const found = walk(child); if (found) return found; } return null; };
  return walk(ui.elements.get("grinder-profiles"));
}

test("simulator keeps same-model grinder units independent and restores them from local storage", async () => {
  const first = uiFixture();
  await new Promise(setImmediate);
  first.elements.get("grinder").value = "DF64 Gen 1";
  first.elements.get("grinder").dispatch("change");
  managerButton(first, "Add individual grinder").click();
  const firstId = first.elements.get("grinder-instance").value;
  first.elements.get("burrs").value = "SSP HU · unit A";
  first.elements.get("burrs").dispatch("change");
  managerButton(first, "Save current calibration").click();
  managerButton(first, "Add individual grinder").click();
  const secondId = first.elements.get("grinder-instance").value;
  assert.notEqual(firstId, secondId);
  first.elements.get("burrs").value = "stock · unit B";
  first.elements.get("burrs").dispatch("change");
  managerButton(first, "Save current calibration").click();
  assert.equal(first.elements.get("grinder-instance").children.length, 6);
  first.elements.get("grinder-instance").value = firstId;
  first.elements.get("grinder-instance").dispatch("change");
  assert.equal(first.elements.get("burrs").value, "SSP HU · unit A");
  const restored = uiFixture({ schemaVersion: 1, sources: [] }, first.context.localStorage);
  await new Promise(setImmediate);
  restored.elements.get("grinder-instance").value = secondId;
  restored.elements.get("grinder-instance").dispatch("change");
  assert.equal(restored.elements.get("burrs").value, "stock · unit B");
  assert.match(restored.elements.get("grinder-profiles").textContent, new RegExp(secondId));
});

test("simulator rejects a conflicting imported grinder ID without losing the active history", () => {
  const ui = uiFixture();
  ui.elements.get("next").click();
  ui.elements.get("export").click();
  const saved = JSON.parse(ui.downloads[0].parts.join(""));
  saved.setup.grinderInstances[0].model = "DF54";
  const text = JSON.stringify(saved);
  ui.elements.get("import").dispatch("change", { target: { files: [{ size: text.length, text }] } });
  assert.match(ui.elements.get("notice").textContent, /conflicts/i);
  assert.equal(ui.elements.get("shots").children.length, 1);
});

test("simulator uses shipped E64 micrometre normalization and exposes all dial profiles", async () => {
  const ui = uiFixture();
  await new Promise(setImmediate);
  assert.equal(ui.elements.get("grinder").children.length, 16);
  ui.elements.get("grinder").value = "E64 WS";
  ui.elements.get("grinder").dispatch("change");
  await new Promise(setImmediate);
  assert.match(ui.elements.get("dial-panel").textContent, /500 dD → 50 micrometres/);
  const native = panelInput(ui, "native grinder setting"); native.value = "55"; native.dispatch("change");
  assert.equal(ui.elements.get("start").value, "550");
  assert.match(ui.elements.get("dial-panel").textContent, /550 dD → 55 micrometres/);
  assert.ok(ui.elements.get("dial-panel").children.some(child => child.tagName === "FIGURE"));
});

test("simulator applies, rejects, and clears a scoped DF64 calibration without losing the active mapping", () => {
  const ui = uiFixture();
  const values = { "Native dial minimum": 0, "Native dial maximum": 90, "Native dial at anchor 1": 0, "Research dD at anchor 1": 0, "Native dial at anchor 2": 90, "Research dD at anchor 2": 3000 };
  Object.entries(values).forEach(([label, value]) => { const input = panelInput(ui, label); input.value = String(value); input.dispatch("change"); });
  const apply = ui.elements.get("dial-panel").children.flatMap(node => node.children || []).find(node => node.textContent === "Apply owner calibration");
  apply.click();
  assert.match(ui.elements.get("dial-panel").textContent, /500 dD → 15 marks/);
  const bad = panelInput(ui, "Research dD at anchor 2"); bad.value = ""; bad.dispatch("change"); apply.click();
  assert.match(ui.elements.get("dial-panel").textContent, /500 dD → 15 marks/);
  const clear = ui.elements.get("dial-panel").children.flatMap(node => node.children || []).find(node => node.textContent === "Reset dial calibration");
  clear.click();
  assert.match(ui.elements.get("dial-panel").textContent, /calibration required/);
  ui.elements.get("burrs").value = "SSP HU"; ui.elements.get("burrs").dispatch("change");
  assert.match(ui.elements.get("dial-panel").textContent, /calibration required/);
});

test("simulator UI replays, resets, and exposes the shipped supporting calculators", () => {
  const ui = uiFixture();
  ui.elements.get("next").click();
  ui.elements.get("next").click();
  assert.equal(ui.elements.get("shots").children.length, 2);
  ui.elements.get("replay").click();
  assert.match(ui.elements.get("notice").textContent, /Replay completed/);
  assert.equal(ui.elements.get("shots").children.length, 2);
  ui.elements.get("reset").click();
  assert.equal(ui.elements.get("shots").children.length, 0);
  for (const helper of ["manual", "wizard", "effective", "grindtime", "inverse"]) {
    ui.elements.get("helper").value = helper;
    ui.elements.get("helper").dispatch("change");
    ui.elements.get("helper-run").click();
    const result = ui.elements.get("helper-result").textContent;
    assert.ok(result.length > 0, helper);
    assert.doesNotMatch(result, /Cannot read properties|undefined is not/i, helper);
    assert.doesNotMatch(result, /must be finite|invalid input|unknown model|unknown grinder/i, helper);
  }
  const research = ui.context.createResearchAlgorithms();
  assert.equal(research.grindTime({ mode: 1, recipeDdUm: 50, targetDdDum: 500, recipeTimeMs: 3000 }).adjustedTimeMs, null);
  assert.equal(research.grindTime({ mode: 2, recipeDdUm: 50, targetDdDum: 500, recipeTimeMs: 3000 }).adjustedTimeMs, null);
  assert.equal(
    research.grindTime({ mode: 3, recipeDdUm: 50, targetDdDum: 500, recipeTimeMs: 3000 }).adjustedTimeMs,
    3000,
  );
  ui.elements.get("helper").value = "wizard";
  ui.elements.get("helper").dispatch("change");
  ui.elements.get("helper-run").click();
  assert.match(ui.elements.get("helper-result").textContent, /coordinateUnit.*unknown/);
});

test("simulator UI keeps blank planned shots unbrewed until run is requested", () => {
  const ui = uiFixture();
  ui.elements.get("add").click();
  assert.equal(ui.elements.get("shots").children.length, 1);
  assert.match(ui.elements.get("shots").textContent, /planned/);
  ui.elements.get("run").click();
  assert.doesNotThrow(() => ui.elements.get("replay").click());
  assert.doesNotMatch(ui.elements.get("notice").textContent, /error/i);
});

test("simulator UI resets history when algorithm or starting setting changes", () => {
  const ui = uiFixture();
  ui.elements.get("next").click();
  assert.equal(ui.elements.get("shots").children.length, 1);
  ui.elements.get("algorithm").value = "GbS2";
  ui.elements.get("algorithm").dispatch("change");
  assert.equal(ui.elements.get("shots").children.length, 0);
  ui.elements.get("next").click();
  ui.elements.get("start").value = "700";
  ui.elements.get("start").dispatch("change");
  assert.equal(ui.elements.get("shots").children.length, 0);
});

test("simulator first-shot assistant handles no taste and explicit sour taste", async () => {
  const ui = uiFixture();
  ui.elements.get("next").click();
  const row = ui.elements.get("shots").children[0];
  row.children[2].children[0].value = "24";
  row.children[2].children[0].dispatch("change");
  await ui.elements.get("assist").click();
  assert.match(ui.elements.get("assist-result").textContent, /confidence/, ui.elements.get("notice").textContent);
  assert.match(ui.elements.get("assist-result").textContent, /provisional|Bean context/);
  row.children[6].children[0].value = "sour";
  row.children[6].children[0].dispatch("change");
  row.children[6].children[1].value = "under-extracted"; row.children[6].children[1].dispatch("change");
  await ui.elements.get("assist").click();
  assert.match(ui.elements.get("assist-result").textContent, /finer|provisional/);
  assert.match(ui.elements.get("assist-result").textContent, /Bean context/);
  assert.doesNotMatch(ui.elements.get("notice").textContent, /503|error/i);
});

test("simulator export/import preserves a blank planned shot, taste, and context", () => {
  const ui = uiFixture();
  ui.elements.get("add").click();
  const row = ui.elements.get("shots").children[0];
  row.children[6].children[0].value = "sour";
  row.children[6].children[0].dispatch("change");
  ui.elements.get("export").click();
  assert.equal(ui.downloads.length, 1);
  const saved = JSON.parse(ui.downloads[0].parts.join(""));
  assert.equal(saved.version, 1);
  assert.equal(saved.shots[0].actual, "");
  assert.equal(saved.shots[0].taste, "sour");
  assert.equal(saved.shots[0].context.bean, "Washed Ethiopia");
  ui.elements.get("reset").click();
  ui.elements.get("import").dispatch("change", { target: { files: [{ size: ui.downloads[0].size, text: JSON.stringify(saved) }] } });
  assert.match(ui.elements.get("notice").textContent, /imported/i);
  assert.match(ui.elements.get("shots").textContent, /planned/);
  assert.equal(ui.elements.get("shots").children[0].children[6].children[0].value, "sour");
});

test("simulator import rejects unknown fields, numeric strings, and oversized files without losing the experiment", () => {
  const ui = uiFixture();
  ui.elements.get("next").click();
  const before = ui.elements.get("shots").textContent;
  const base = { version: 1, setup: { algorithm: "GbS1", target: 28, tolerance: 1, start: 500, plant: 1, noise: 0.8, pressure: 9, flow: 2.2, bean: "Washed Ethiopia", species: "Arabica", roast: "light", calibration: "epoch 1", grinder: "DF64 Gen 2", burrs: "stock", dose: 18, yield: 36 }, shots: [] };
  for (const value of [
    { ...base, setup: { ...base.setup, unexpected: true } },
    { ...base, setup: { ...base.setup, start: "500" } },
  ]) {
    ui.elements.get("import").dispatch("change", { target: { files: [{ size: JSON.stringify(value).length, text: JSON.stringify(value) }] } });
    assert.match(ui.elements.get("notice").textContent, /unknown|invalid/i);
    assert.equal(ui.elements.get("shots").textContent, before);
  }
  ui.elements.get("import").dispatch("change", { target: { files: [{ size: 256 * 1024 + 1, text: "{}" }] } });
  assert.match(ui.elements.get("notice").textContent, /too large/i);
  assert.equal(ui.elements.get("shots").textContent, before);
});


test("reviewed recipe adoption keeps ranges explicit and filter recipes informational", async () => {
  const catalog = JSON.parse(fs.readFileSync(require("node:path").join(root, "data/reference-catalog.json"), "utf8"));
  const ui = uiFixture(catalog);
  await new Promise(setImmediate);
  while (ui.elements.get("catalog").children.some(node => node.tagName === "BUTTON")) ui.elements.get("catalog").children.find(node => node.tagName === "BUTTON").click();
  assert.equal(ui.elements.get("catalog").children.length, catalog.sources.length);
  const cards = ui.elements.get("catalog").children;
  const filter = cards.find(card => card.textContent.includes("Pour-over guide"));
  assert.equal(filter.children.some(child => child.tagName === "BUTTON"), false);
  const recipe = cards.find(card => card.textContent.includes("How we make espresso"));
  assert.match(recipe.textContent, /19–20 g/);
  recipe.children.find(child => child.tagName === "BUTTON").click();
  assert.equal(Number(ui.elements.get("dose").value), 19.5);
  assert.equal(Number(ui.elements.get("yield").value), 43.5);
  assert.equal(Number(ui.elements.get("target").value), 30);
  assert.equal(ui.elements.get("roaster").value, "Tim Wendelboe");
  assert.match(ui.elements.get("notice").textContent, /midpoint/);
});

test("bean-specific roaster references reach actual first-shot suggestion provenance", async () => {
  const catalog = JSON.parse(fs.readFileSync(require("node:path").join(root, "data/reference-catalog.json"), "utf8"));
  const ui = uiFixture(catalog);
  await new Promise(setImmediate);
  const recipe = ui.elements.get("catalog").children.find(card => card.textContent.includes("Red Brick espresso recipe"));
  recipe.children.find(child => child.tagName === "BUTTON").click();
  ui.elements.get("next").click();
  const time = ui.elements.get("shots").children[0].children[2].children[0];
  time.value = 24; time.dispatch("change");
  ui.elements.get("assist-taste").value = "sour";
  ui.elements.get("assist-taste").dispatch("change");
  ui.elements.get("assist-overall").value = "under-extracted"; ui.elements.get("assist-overall").dispatch("change");
  await ui.elements.get("assist").click();
  assert.match(ui.elements.get("assist-result").textContent, /provisional/);
  assert.match(ui.elements.get("assist-result").textContent, /Red Brick espresso recipe/);
  assert.match(ui.elements.get("assist-result").textContent, /finer/);
});


test("real saved-shot import uses measured traces, preserves unknown pump time and round-trips sensory input", () => {
  const ui = uiFixture();
  const shot = {id: "recorded-1", timestamp: "2026-10-11T08:00:00Z", workflow: {profile: {steps: [{pump: "pressure", pressure: 9}]}, context: {}}, measurements: [0, 1, 2, 10, 11].map(second => ({machine: {timestamp: new Date(Date.parse("2026-10-11T08:00:00Z") + second * 1000).toISOString(), flow: 2, pressure: 9, mixTemperature: 93}, scale: {timestamp: new Date(Date.parse("2026-10-11T08:00:00Z") + second * 1000).toISOString(), weight: second}}))};
  const open = value => ui.elements.get("shot-trace-import").dispatch("change", {target: {files: [{size: JSON.stringify(value).length, text: JSON.stringify(value)}]}});
  open(shot);
  assert.match(ui.elements.get("shot-trace-status").textContent, /recorded-1/);
  const metrics = JSON.parse(ui.elements.get("actual-shot-details").textContent);
  assert.equal(metrics.trace.machineFlow.gapCount, 1);
  assert.equal(ui.elements.get("actual-shot-time").value, "", "recording time must not masquerade as pump time");
  assert.ok(ui.elements.get("actual-shot-trace").children.some(node => node.tagName === "SVG"));
  ui.elements.get("taste-temperature").value = "52";
  ui.elements.get("taste-minutes").value = "3";
  ui.elements.get("assist-overall").value = "uncertain";
  ui.elements.get("export-shot-trace").click();
  const exported = JSON.parse(ui.downloads.at(-1).parts.join(""));
  assert.equal(exported.feedback.flavour.tastingTemperatureC, 52);
  assert.equal(exported.feedback.flavour.overall, "uncertain");
  ui.elements.get("clear-shot-trace").click(); open(exported);
  assert.equal(Number(ui.elements.get("taste-temperature").value), 52);
  assert.equal(ui.elements.get("assist-overall").value, "uncertain");
  open({timestamp: "not-a-date", measurements: []});
  assert.match(ui.elements.get("shot-trace-status").textContent, /recorded-1/, "bad import must retain the previous trace");
});

test("profile browser exposes all stock and supplemental references without replacing experiment inputs", async () => {
  const ui = uiFixture(); await new Promise(setImmediate);
  const holder = ui.elements.get("profile-picker"), select = holder.children[0].children[0];
  assert.equal(select.children.length, 105);
  const before = ui.elements.get("target").value;
  select.value = select.children[1].value; select.dispatch("change");
  assert.match(holder.textContent, /saved|authoritative|runtime/i);
  assert.equal(ui.elements.get("target").value, before);
});

test("structured supplemental inputs compute all ten isolated algorithms", () => {
  const ui = uiFixture(); ui.elements.get("view-mode").value = "expert"; ui.elements.get("view-mode").dispatch("change"); ui.elements.get("next").click();
  const values = {
    effectiveDd: {grindDdDum: 500, grindDurationMs: 3000, effectiveBaseline: 50, residue: 50},
    grindTime: {mode: 3, recipeDdUm: 50, targetDdDum: 500, recipeTimeMs: 3000},
    inverseRegression: {x1: 50, y1: 32, x2: 60, y2: 25, targetSec: 28},
    proposedDd: {model: "e64", roast: "light", dose: 18},
    manual: {profile: "df64_gen2", targetTimeSec: 28, actualTimeSec: 24, currentDial: 20, stepMarks: 1, numericFinerDelta: "-1", flavor: "too sour"},
  };
  for (const [algorithm, fields] of Object.entries(values)) {
    const enabled = ui.context.document.getElementById("lab-" + algorithm + "-enabled"); enabled.checked = true; enabled.dispatch("change");
    for (const [key, value] of Object.entries(fields)) ui.context.document.getElementById("lab-" + algorithm + "-" + key).value = String(value);
  }
  ui.elements.get("compare-all-lab").click();
  const rows = ui.elements.get("all-comparison-results").children;
  assert.equal(rows.length, 10, ui.elements.get("all-comparison-results").textContent);
  for (const row of rows) assert.match(row.children[0].textContent, /computed$/, row.textContent);
});

test("reset fences an in-flight simulator suggestion", async () => {
  const ui = uiFixture(); ui.elements.get("next").click();
  const pending = ui.elements.get("assist").click(); ui.elements.get("reset").click(); await pending;
  assert.doesNotMatch(ui.elements.get("assist-result").textContent, /Pass simulation-shot/);
  assert.match(ui.elements.get("assist-result").textContent, /Evidence changed/);
});

test("manual comparison accepts the selectable adjustment intents and retains nonactionable results", () => {
  const ui = uiFixture(), field = key => ui.context.document.getElementById("lab-manual-" + key);
  ui.elements.get("view-mode").value = "expert"; ui.elements.get("view-mode").dispatch("change");
  field("enabled").checked = true; field("enabled").dispatch("change");
  for (const [key, value] of Object.entries({profile: "df64_gen2", targetTimeSec: 28, actualTimeSec: 28, currentDial: 20, stepMarks: 1, numericFinerDelta: "-1"})) field(key).value = String(value);
  const options = field("flavor").children.map(node => node.value);
  for (const [flavor, direction, proposedDial] of [["too sour", "finer", 19], ["too bitter", "coarser", 21], ["too astringent", "coarser", 21], ["balanced", "none", null], ["weak", "none", null], ["channeling", "none", null]]) {
    assert.ok(options.includes(flavor), flavor + " must be selectable"); field("flavor").value = flavor;
    ui.elements.get("compare-all-lab").click();
    const row = ui.elements.get("all-comparison-results").children.find(node => node.children[0].textContent.startsWith("manual ·"));
    assert.match(row.children[0].textContent, /computed$/);
    const result = JSON.parse(row.children.find(node => node.tagName === "DETAILS").children[1].textContent).result;
    assert.equal(result.direction, direction, flavor); assert.equal(result.proposedDial, proposedDial, flavor);
    if (["weak", "channeling"].includes(flavor)) assert.match(result.reasons.join(" "), /not.*used|not state a recognized/);
  }
});

test("saved-shot manual-stop confirmation survives import, editing, API feedback and export", async () => {
  const ui = uiFixture(), shot = {id: "manually-stopped", timestamp: "2026-10-11T08:00:00Z", stopReason: "appStop", workflow: {profile: {steps: [{pump: "pressure", pressure: 9}]}, context: {}}, measurements: [0, 1].map(second => ({machine: {timestamp: new Date(Date.parse("2026-10-11T08:00:00Z") + second * 1000).toISOString(), flow: 2, pressure: 9}}))};
  const open = value => ui.elements.get("shot-trace-import").dispatch("change", {target: {files: [{size: JSON.stringify(value).length, text: JSON.stringify(value)}]}});
  const save = () => { ui.elements.get("export-shot-trace").click(); return JSON.parse(ui.downloads.at(-1).parts.join("")); };
  open({shot, feedback: {manualStopConfirmed: true}});
  assert.equal(ui.elements.get("manual-stop-confirmed").checked, true);
  assert.equal(save().feedback.manualStopConfirmed, true);
  const submitted = [], factory = ui.context.createPlugin;
  ui.context.createPlugin = (...args) => { const instance = factory(...args), handle = instance.handleHttpRequest; instance.handleHttpRequest = request => { if (request.endpoint === "feedback") submitted.push(request.body); return handle(request); }; return instance; };
  await ui.elements.get("assist").click();
  assert.equal(submitted.at(-1).manualStopConfirmed, true, "actual shipped feedback API receives owner confirmation");
  ui.elements.get("manual-stop-confirmed").checked = false; ui.elements.get("manual-stop-confirmed").dispatch("change");
  assert.match(ui.elements.get("assist-result").textContent, /Evidence changed/);
  const declined = save(); assert.equal(declined.feedback.manualStopConfirmed, false);
  open(declined); assert.equal(ui.elements.get("manual-stop-confirmed").checked, false);
  open({shot, feedback: {manualStopConfirmed: "true"}});
  assert.match(ui.elements.get("notice").textContent, /expected a boolean/);
  assert.equal(save().feedback.manualStopConfirmed, false, "invalid input retains previous explicit choice");
  open({shot, feedback: {manualStopConfirmed: true}}); ui.elements.get("clear-shot-trace").click();
  assert.equal(ui.elements.get("manual-stop-confirmed").checked, false, "confirmation cannot leak into another shot");
});


test("beginner flow uses the shipped native rule and carries half-mark steps across shots", () => {
  const ui = uiFixture(), field = id => ui.elements.get("simple-" + id);
  field("current-dial").value = "20"; field("step").value = "0.5"; field("finer").value = "-1"; field("confirm-dial").checked = true;
  field("clock-confirmed").checked = true; field("pressure-confirmed").checked = true;
  field("time").value = "22"; field("taste").value = "too sour"; field("record").click();
  assert.match(field("advice").textContent, /Turn finer by half a mark: from 20 to 19.5 marks/);
  assert.doesNotMatch(field("advice").textContent, /dD|GbS|under.extracted/);
  field("continue").click(); assert.equal(field("current-dial").value, "19.5");
  assert.equal(field("clock-confirmed").checked, false);
  field("time").value = "26"; field("taste").value = "too sour"; field("clock-confirmed").checked = true; field("record").click();
  assert.match(field("advice").textContent, /from 19.5 to 19 marks/);
  field("continue").click(); field("time").value = "28"; field("taste").value = "balanced"; field("clock-confirmed").checked = true; field("record").click();
  assert.match(field("advice").textContent, /Keep the grinder at 19 marks/);
  assert.equal(field("history").children.length, 3);
});

test("beginner advice requires checked dial movement, clock and pressure recipe", () => {
  const ui = uiFixture(), field = id => ui.elements.get("simple-" + id);
  field("current-dial").value = "20"; field("time").value = "22"; field("taste").value = "too sour";
  field("record").click(); assert.match(field("advice").textContent, /timing from pump start/);
  field("clock-confirmed").checked = true; field("record").click(); assert.match(field("advice").textContent, /programmed flow target/);
  field("pressure-confirmed").checked = true; field("taste").value = ""; field("record").click(); assert.match(field("advice").textContent, /cool enough to sip/);
  field("taste").value = "too sour"; field("record").click(); assert.match(field("advice").textContent, /confirm a small step/);
  field("step").value = "0.5"; field("finer").value = "-1"; field("confirm-dial").checked = true;
  field("taste").value = "too bitter"; field("record").click(); assert.match(field("advice").textContent, /do not point to the same change/);
  field("time").value = "34"; field("record").click(); assert.match(field("advice").textContent, /Turn coarser.*20 to 20.5 marks/);
  field("taste").value = "weak"; field("record").click(); assert.match(field("advice").textContent, /weak taste alone/);
});

test("fictional practice completes three shots without creating an owner conversion", () => {
  const ui = uiFixture(), field = id => ui.elements.get("simple-" + id);
  field("start-practice").click();
  for (let i = 0; i < 3; i++) { field("practice").click(); if (i < 2) field("continue").click(); }
  assert.equal(field("history").children.length, 3);
  assert.match(field("advice").textContent, /Keep the grinder at 19 marks/);
  assert.match(field("advice").textContent, /fictional shot times/);
  assert.match(ui.elements.get("dial-panel").textContent, /calibration required/);
  field("new").click(); assert.equal(field("confirm-dial").checked, false); assert.equal(field("current-dial").value, "");
});

test("beginner E64 uses native micrometres and a fresh owner-confirmed step", () => {
  const ui = uiFixture(), field = id => ui.elements.get("simple-" + id);
  field("start-practice").click();
  ui.elements.get("grinder").value = "E64 WS"; ui.elements.get("grinder").dispatch("change");
  assert.equal(field("current-dial").value, ""); assert.equal(field("step").value, "");
  assert.equal(field("confirm-dial").checked, false); assert.equal(field("pressure-confirmed").checked, false);
  field("current-dial").value = "60"; field("step").value = "2"; field("finer").value = "-1"; field("confirm-dial").checked = true;
  field("clock-confirmed").checked = true; field("pressure-confirmed").checked = true; field("time").value = "22"; field("taste").value = "too sour";
  field("record").click();
  assert.match(field("advice").textContent, /Set finer by 2 micrometres: from 60 to 58 micrometres/);
  assert.doesNotMatch(field("advice").textContent, /clockwise|marks|dD|Practice only/);
  field("time").value = "26"; field("time").dispatch("change"); assert.equal(field("continue").disabled, true);
  field("continue").click(); assert.equal(field("current-dial").value, "60", "stale proposal cannot be applied");
  field("record").click(); field("continue").click(); assert.equal(field("current-dial").value, "58");
  field("new").click(); assert.equal(field("pressure-confirmed").checked, false);
});


test("simulator restores the selected theme and still works when storage is unavailable", () => {
  const first = uiFixture(); first.elements.get("theme").click();
  const restored = uiFixture(undefined, first.context.localStorage);
  assert.match(restored.context.document.body.className, /light/);
  assert.equal(restored.elements.get("theme").textContent, "Dark mode");
  const unavailable = uiFixture(undefined, {getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }});
  assert.doesNotThrow(() => unavailable.elements.get("theme").click());
  assert.match(unavailable.context.document.body.className, /light/);
});


test("unavailable coffee and grinder references show retry and recover without losing shots", async () => {
  const unavailable = {coffee: true, grinders: true}, ui = uiFixture(undefined, null, unavailable);
  await new Promise(setImmediate);
  assert.match(ui.elements.get("coffee-catalog").textContent, /Coffee catalogue unavailable/);
  assert.match(ui.elements.get("grinder-load-status").textContent, /grinder references unavailable/);
  ui.elements.get("next").click(); assert.equal(ui.elements.get("shots").children.length, 1);
  ui.elements.get("coffee-catalog-search").dispatch("input");
  const coffeeRetry = ui.elements.get("coffee-catalog").children.find(node => node.tagName === "BUTTON");
  assert.equal(coffeeRetry.textContent, "Retry coffee catalogue");
  await coffeeRetry.click(); assert.match(ui.elements.get("coffee-catalog").textContent, /Retry coffee catalogue/);
  unavailable.coffee = false; unavailable.grinders = false;
  ui.elements.get("grinder").value = "DF64 Gen 1";
  await ui.elements.get("coffee-catalog").children.find(node => node.tagName === "BUTTON").click();
  await ui.elements.get("grinder-load-status").children.find(node => node.tagName === "BUTTON").click();
  assert.match(ui.elements.get("coffee-catalog").textContent, /Retry coffee/);
  assert.doesNotMatch(ui.elements.get("coffee-catalog").textContent, /unavailable/);
  assert.equal(ui.elements.get("grinder-load-status").textContent, "");
  assert.equal(ui.elements.get("grinder").value, "DF64 Gen 1", "retry retains the current grinder choice");
  assert.equal(ui.elements.get("grinder").children.length, 16);
  assert.equal(ui.elements.get("shots").children.length, 1);
});

function comparisonCard(ui, name) {
  return ui.elements.get("all-comparison-results").children.find(node => node.attributes["data-algorithm"] === name);
}
function comparisonValue(ui, name) {
  return JSON.parse(comparisonCard(ui, name).children.find(node => node.tagName === "DETAILS").children[1].textContent);
}
function openComparisonShot(ui, shot) {
  const value = JSON.stringify(shot);
  ui.elements.get("shot-trace-import").dispatch("change", {target: {files: [{size: value.length, text: value}]}});
}
function comparisonShot() {
  const timestamp = "2026-10-11T08:00:00Z";
  return {id: "comparison", timestamp, workflow: {profile: {steps: [{pump: "pressure", pressure: 9}]}, context: {grinderSetting: "600", extras: {grinderSettingUnit: "deci-micrometre"}}}, measurements: require("./shot-fixtures").timedMeasurements(timestamp, 22)};
}

test("research timing models retain untasted shots while manual advice waits for taste", () => {
  const ui = uiFixture(), field = id => ui.elements.get("simple-" + id);
  ui.elements.get("grinder").value = "E64 WS"; ui.elements.get("grinder").dispatch("change");
  field("current-dial").value = "60"; field("pressure-confirmed").checked = true;
  for (const taste of ["", "weak", "channeling"]) {
    field("time").value = "22"; field("clock-confirmed").checked = true; field("taste").value = taste; field("record").click();
    for (const name of ["GbS1", "GbS2", "GbS3", "GbS4"]) assert.equal(comparisonCard(ui, name).attributes["data-status"], "computed");
    assert.equal(comparisonCard(ui, "manual").attributes["data-status"], "unavailable");
    assert.equal(comparisonValue(ui, "GbS2").case.state.history.length, ["", "weak", "channeling"].indexOf(taste));
    field("continue").click();
  }
});

test("measurement sequence advances without clock, pressure or taste but still requires a coordinate", () => {
  const ui = uiFixture(), field = id => ui.elements.get("simple-" + id);
  ui.elements.get("grinder").value = "E64 WS"; ui.elements.get("grinder").dispatch("change");
  field("current-dial").value = "60";
  for (let index = 0; index < 7; index++) {
    field("time").value = "22"; field("record").click();
    assert.equal(comparisonCard(ui, "GbS2").attributes["data-status"], "unavailable");
    assert.equal(comparisonValue(ui, "DdEff").result.returnedDdDum, index < 6 ? 600 : 400);
    field("continue").click();
  }
  ui.elements.get("grinder").value = "DF64 Gen 2"; ui.elements.get("grinder").dispatch("change");
  field("current-dial").value = "20"; field("time").value = "22"; field("record").click();
  assert.equal(comparisonCard(ui, "DdEff").attributes["data-status"], "unavailable");
});

test("unknown imported extraction mode blocks timing models but not the coordinate measurement plan", () => {
  const ui = uiFixture(); ui.elements.get("view-mode").value = "expert"; ui.elements.get("view-mode").dispatch("change");
  const shot = comparisonShot(); delete shot.workflow.profile;
  openComparisonShot(ui, shot);
  assert.equal(comparisonCard(ui, "GbS2").attributes["data-status"], "unavailable");
  assert.match(comparisonCard(ui, "GbS2").textContent, /Unknown control mode/);
  assert.equal(comparisonValue(ui, "DdEff").result.returnedDdDum, 600);
  shot.workflow.profile = {steps: [{pump: "pressure", pressure: 9}]}; openComparisonShot(ui, shot);
  assert.equal(comparisonCard(ui, "GbS2").attributes["data-status"], "computed");
  ui.elements.get("actual-shot-clock").value = "recording"; ui.elements.get("actual-shot-clock").dispatch("change");
  assert.equal(comparisonCard(ui, "GbS2").attributes["data-status"], "unavailable");
  assert.equal(comparisonValue(ui, "DdEff").result.returnedDdDum, 600);
});

test("imported native mapping requires exact individual grinder, model, burr and epoch matches", () => {
  const ui = uiFixture(); ui.elements.get("grinder").value = "E64 WS"; ui.elements.get("grinder").dispatch("change");
  ui.elements.get("view-mode").value = "expert"; ui.elements.get("view-mode").dispatch("change");
  ui.elements.get("export").click(); const setup = JSON.parse(ui.downloads.at(-1).parts.join("")).setup;
  const shot = comparisonShot(); Object.assign(shot.workflow.context, {grinderId: setup.grinderId, grinderModel: setup.grinder, grinderBurrs: setup.burrs});
  Object.assign(shot.workflow.context.extras, {grinderInstanceId: setup.grinderId, calibrationEpoch: setup.calibration});
  openComparisonShot(ui, shot);
  assert.match(comparisonCard(ui, "GbS2").textContent, /Timing model returns: .* micrometres/);
  assert.doesNotMatch(comparisonCard(ui, "GbS2").textContent, /Native conversion is withheld/);
  for (const [container, key] of [[shot.workflow.context,"grinderId"], [shot.workflow.context,"grinderModel"], [shot.workflow.context,"grinderBurrs"], [shot.workflow.context.extras,"grinderInstanceId"], [shot.workflow.context.extras,"calibrationEpoch"]]) {
    const original = container[key];
    for (const value of ["", "different"]) { container[key] = value; openComparisonShot(ui, shot); assert.match(comparisonCard(ui, "GbS2").textContent, /Native conversion is withheld/, key); }
    container[key] = original;
  }
});

test("Simple mode never borrows an imported expert scenario as recorded coffee", () => {
  const ui = uiFixture(); ui.elements.get("view-mode").value = "expert"; ui.elements.get("view-mode").dispatch("change");
  ui.elements.get("next").click(); ui.elements.get("export").click();
  const scenario = ui.downloads.at(-1).parts.join("");
  ui.elements.get("import").dispatch("change", {target: {files: [{size: scenario.length, text: scenario}]}});
  assert.equal(comparisonCard(ui, "GbS2").attributes["data-status"], "computed");
  ui.elements.get("view-mode").value = "simple"; ui.elements.get("view-mode").dispatch("change");
  for (const name of ["GbS1", "GbS2", "GbS3", "GbS4", "DdEff", "manual"]) assert.equal(comparisonCard(ui, name).attributes["data-status"], "unavailable");
  assert.equal(ui.elements.get("simple-history").children.length, 0);
});


function nativeSession(ui, target = 28) {
  const field = id => ui.elements.get("simple-" + id);
  ui.elements.get("target").value = String(target);
  field("step").value = "0.25"; field("finer").value = "-1";
  field("bound-min").value = "20"; field("bound-max").value = "25"; field("confirm-dial").checked = true;
  return (setting, time, taste = "too bitter") => {
    field("current-dial").value = String(setting); field("time").value = String(time); field("taste").value = taste;
    field("clock-confirmed").checked = true; field("pressure-confirmed").checked = true; field("record").click();
  };
}

test("native learner holds the exact 22/34, 22.25/31, 22.5/31 plateau and repeated plateau", () => {
  const ui = uiFixture(), record = nativeSession(ui);
  for (const [setting, time] of [[22,34],[22.25,31],[22.5,31],[22.5,31]]) {
    if (ui.elements.get("simple-history").children.length) ui.elements.get("simple-continue").click();
    record(setting, time);
  }
  assert.equal(ui.elements.get("native-response").attributes["data-reason"], "latest_plateau");
  assert.match(ui.elements.get("simple-advice").textContent, /Keep the grinder at 22.5 marks and repeat/);
  assert.match(ui.elements.get("native-response").textContent, /22.5 marks.*31 s median, 2 shot/);
  assert.equal(ui.elements.get("simple-history").children.length, 4);
  assert.match(ui.elements.get("dial-panel").textContent, /calibration required/);
  ui.elements.get("simple-continue").click(); assert.equal(ui.elements.get("simple-current-dial").value, "22.5");
});

test("stable native response uses measured points while balanced and prep feedback still hold", () => {
  const ui = uiFixture(), record = nativeSession(ui, 25);
  for (const [setting,time] of [[22,34],[22.25,31],[22.5,28]]) {
    if (ui.elements.get("simple-history").children.length) ui.elements.get("simple-continue").click();
    record(setting,time);
  }
  assert.equal(ui.elements.get("native-response").attributes["data-status"], "suggestion");
  assert.match(ui.elements.get("simple-advice").textContent, /Try 22.75 marks next/);
  assert.match(ui.elements.get("native-response").textContent, /Local timing slope: -12 seconds per marks/);
  assert.match(ui.elements.get("native-response").textContent, /raw estimate is not an instruction/);
  record(22.5,28,"balanced"); assert.match(ui.elements.get("simple-advice").textContent, /Keep the grinder at 22.5/);
  record(22.5,28,"channeling"); assert.match(ui.elements.get("simple-advice").textContent, /evenly prepared/);
});

test("native setup guidance and context changes retain recorded history without mixing recipes", () => {
  const ui = uiFixture(), record = nativeSession(ui);
  record(22,34); ui.elements.get("simple-continue").click(); record(22.25,31);
  ui.elements.get("simple-bound-min").value = ""; ui.elements.get("simple-bound-min").dispatch("change");
  ui.elements.get("simple-bound-min").value = "20"; ui.elements.get("simple-confirm-dial").checked = true;
  record(22.25,31); assert.equal(ui.elements.get("simple-history").children.length, 2, "reconfirming setup replaces current entry");
  ui.elements.get("simple-zero-changed").click();
  assert.equal(ui.elements.get("simple-history").children.length, 2);
  assert.equal(ui.elements.get("simple-confirm-dial").checked, false);
  ui.elements.get("simple-bound-min").value = "20"; ui.elements.get("simple-bound-max").value = "25"; ui.elements.get("simple-finer").value = "-1"; ui.elements.get("simple-confirm-dial").checked = true;
  record(22.5,30);
  assert.equal(ui.elements.get("native-response").attributes["data-reason"], "first_setting");
  assert.match(ui.elements.get("native-response").textContent, /Older shots.*left out/);
  assert.equal(ui.elements.get("simple-history").children.length, 3);
});

test("presets remain unconfirmed, respect edits, and remember each owner's step separately", async () => {
  const ui = uiFixture();
  ui.elements.get("simple-step").value = "0.25"; ui.elements.get("simple-step").dispatch("input");
  await new Promise(setImmediate);
  assert.equal(ui.elements.get("simple-step").value, "0.25", "metadata load cannot overwrite an edited step");
  assert.equal(ui.elements.get("simple-bound-min").value, "", "printed scale is not a safe trial window");
  assert.equal(ui.elements.get("simple-confirm-dial").checked, false);
  ui.elements.get("simple-finer").value = "-1"; ui.elements.get("simple-confirm-dial").checked = true; ui.elements.get("simple-confirm-dial").dispatch("change");
  const firstId = ui.elements.get("grinder-instance").value;
  managerButton(ui, "Add individual grinder").click();
  assert.equal(ui.elements.get("simple-step").value, "0.5", "another unit uses its proposed preset");
  assert.equal(ui.elements.get("simple-confirm-dial").checked, false);
  ui.elements.get("grinder-instance").value = firstId; ui.elements.get("grinder-instance").dispatch("change");
  assert.equal(ui.elements.get("simple-step").value, "0.25");
  const reloaded = uiFixture(undefined, ui.context.localStorage); await new Promise(setImmediate);
  assert.equal(reloaded.elements.get("simple-step").value, "0.25");
  reloaded.elements.get("grinder").value = "E65S GbW"; reloaded.elements.get("grinder").dispatch("change");
  assert.equal(reloaded.elements.get("simple-step").value, "", "unknown preset stays blank");
});

test("research starting table seeds only supported model, known roast and confirmed dose", () => {
  const ui = uiFixture(), field = id => ui.elements.get("simple-" + id);
  ui.elements.get("grinder").value = "E64 WS"; ui.elements.get("grinder").dispatch("change");
  field("current-dial").value = "60"; field("time").value = "22"; field("clock-confirmed").checked = true; field("pressure-confirmed").checked = true; field("taste").value = "too sour"; field("record").click();
  assert.equal(comparisonCard(ui,"proposedDd").attributes["data-status"], "computed");
  assert.deepEqual(JSON.parse(JSON.stringify(comparisonValue(ui,"proposedDd").case.input)), {model:"e64",roast:"light",weightMg:18000});
  assert.match(comparisonCard(ui,"proposedDd").textContent, /unit unknown.*Do not use this number on your dial/);
  assert.equal(comparisonCard(ui,"effectiveDd").attributes["data-status"], "unavailable");
  ui.elements.get("roast").value = "unknown"; ui.elements.get("roast").dispatch("change");
  field("clock-confirmed").checked = true; field("pressure-confirmed").checked = true; field("record").click();
  assert.equal(comparisonCard(ui,"proposedDd").attributes["data-status"], "unavailable");
});

test("Ode rejects espresso learning even when owner supplied a complete trial window", async () => {
  const ui = uiFixture(); await new Promise(setImmediate);
  ui.elements.get("grinder").value = "Fellow Ode Gen 2"; ui.elements.get("grinder").dispatch("change");
  const record = nativeSession(ui); record(22,34);
  assert.equal(ui.elements.get("native-response").attributes["data-reason"], "unsupported_grinder");
  assert.match(ui.elements.get("simple-advice").textContent, /not supported for espresso/);
  ui.elements.get("simple-continue").click(); assert.equal(ui.elements.get("simple-current-dial").value, "22");
});


test("each supplied native bound applies independently to manual fallback", () => {
  const ui = uiFixture(), field = id => ui.elements.get("simple-" + id);
  field("current-dial").value = "20"; field("step").value = "0.5"; field("finer").value = "-1"; field("confirm-dial").checked = true;
  field("clock-confirmed").checked = true; field("pressure-confirmed").checked = true;
  field("bound-min").value = "20"; field("bound-max").value = ""; field("time").value = "22"; field("taste").value = "too sour"; field("record").click();
  assert.match(field("advice").textContent, /Keep the grinder at 20 marks/);
  assert.match(comparisonCard(ui,"manual").textContent, /outside your allowed trial window/);
  field("bound-min").value = ""; field("bound-max").value = "20"; field("time").value = "34"; field("taste").value = "too bitter"; field("record").click();
  assert.match(field("advice").textContent, /Keep the grinder at 20 marks/);
});

test("context changes withhold every recorded research replay and starting table until a fresh shot", () => {
  const ui = uiFixture(), field = id => ui.elements.get("simple-" + id);
  ui.elements.get("grinder").value = "E64 WS"; ui.elements.get("grinder").dispatch("change");
  field("current-dial").value = "60"; field("time").value = "22"; field("clock-confirmed").checked = true; field("pressure-confirmed").checked = true; field("taste").value = "too sour"; field("record").click();
  assert.equal(comparisonCard(ui,"GbS2").attributes["data-status"], "computed");
  ui.elements.get("bean").value = "Different coffee"; ui.elements.get("bean").dispatch("change");
  for (const name of ["GbS1","GbS2","GbS3","GbS4","DdEff","manual","proposedDd"]) assert.equal(comparisonCard(ui,name).attributes["data-status"], "unavailable", name);
  field("clock-confirmed").checked = true; field("pressure-confirmed").checked = true; field("record").click();
  assert.equal(comparisonValue(ui,"GbS2").case.state.history.length, 0, "new replay does not borrow old-coffee regression");
  assert.equal(field("history").children.length, 2, "historical shots remain visible");
});


test("replacing calibration anchors fences historical research coordinates even with the same epoch label", () => {
  const ui = uiFixture(), field = id => ui.elements.get("simple-" + id);
  const calibrate = dd => {
    for (const [label,value] of Object.entries({"Native dial minimum":0,"Native dial maximum":90,"Native dial at anchor 1":0,"Research dD at anchor 1":0,"Native dial at anchor 2":90,"Research dD at anchor 2":dd})) panelInput(ui,label).value = String(value);
    ui.elements.get("dial-panel").children.flatMap(node => node.children || []).find(node => node.textContent === "Apply owner calibration").click();
  };
  calibrate(3000);
  field("current-dial").value = "21"; field("time").value = "22"; field("clock-confirmed").checked = true; field("pressure-confirmed").checked = true; field("taste").value = "too sour"; field("record").click();
  assert.equal(comparisonCard(ui,"GbS2").attributes["data-status"], "computed");
  calibrate(6000);
  assert.equal(comparisonCard(ui,"GbS2").attributes["data-status"], "unavailable");
  assert.equal(field("history").children.length, 1);
  field("time").value = "25"; field("record").click();
  assert.equal(comparisonValue(ui,"GbS2").case.state.history.length, 0);
  assert.equal(field("history").children.length, 2);
});

test("changed target and tolerance refresh the last recorded shot instead of inventing a repeat", () => {
  const ui = uiFixture(), field = id => ui.elements.get("simple-" + id);
  ui.elements.get("grinder").value = "E64 WS"; ui.elements.get("grinder").dispatch("change");
  field("current-dial").value = "60"; field("time").value = "22"; field("clock-confirmed").checked = true; field("pressure-confirmed").checked = true; field("taste").value = "too sour"; field("record").click();
  for (const [id,value] of [["target","25"],["tolerance","2"]]) {
    ui.elements.get(id).value = value; ui.elements.get(id).dispatch("change");
    assert.equal(comparisonCard(ui,"GbS2").attributes["data-status"], "unavailable");
    assert.equal(comparisonCard(ui,"manual").attributes["data-status"], "unavailable");
    field("record").click(); assert.equal(field("history").children.length, 1);
  }
  assert.equal(comparisonValue(ui,"GbS2").case.input.targetBrewTimeMs, 25000);
  assert.equal(comparisonValue(ui,"GbS2").case.input.toleranceMs, 2000);
});

const settleResearch = () => new Promise(resolve => setImmediate(resolve));
function recordResearchFixture(ui, time = 22) {
  const field = id => ui.elements.get("simple-" + id);
  field("current-dial").value = "20"; field("step").value = "0.5"; field("finer").value = "-1"; field("confirm-dial").checked = true;
  field("clock-confirmed").checked = true; field("pressure-confirmed").checked = true;
  field("time").value = String(time); field("taste").value = "too sour"; field("record").click();
}

test("research archive defaults local-only and exports amended shots without personal details", async () => {
  const ui = uiFixture(); await settleResearch();
  const calls = []; ui.context.fetch = async (...args) => { calls.push(args); throw new Error("Unexpected remote request"); };
  ui.elements.get("bean").value = "PERSONAL COFFEE NAME"; ui.elements.get("roaster").value = "PERSONAL ROASTER";
  recordResearchFixture(ui); await settleResearch();
  assert.equal(ui.elements.get("research-local-enabled").checked, true);
  assert.equal(ui.elements.get("research-sharing-consent").checked, false);
  assert.equal(ui.elements.get("research-sharing-consent").disabled, true);
  assert.match(ui.elements.get("research-sharing-status").textContent, /1 record\(s\).*0 queued/);
  recordResearchFixture(ui, 24); await settleResearch();
  await ui.elements.get("research-sharing-export").click();
  const exported = JSON.parse(ui.downloads.at(-1).parts.join(""));
  assert.equal(exported.records.length, 1, "amendment replaces the record");
  assert.equal(exported.records[0].measurements.pumpTimeSec, 24);
  assert.equal(exported.records[0].grinder.settingUnit, "dial-marks");
  assert.equal(exported.records[0].taste.intent, "too_sour");
  assert.equal(exported.records[0].advice.proposedSetting, 19.5);
  assert.doesNotMatch(JSON.stringify(exported), /PERSONAL|grinderId|beanId|native-shot|timestamp|burrIdentity|calibrationEpoch|token|serial/i);
  assert.equal(calls.length, 0);
});

test("remote research requires consent and explicit send; opt-out and local-off persist", async () => {
  const ui = uiFixture(); await settleResearch();
  const calls = []; ui.context.fetch = async (url, init) => { calls.push({url, init}); return {ok: true, json: async () => ({accepted: JSON.parse(init.body).records.length})}; };
  const endpoint = ui.elements.get("research-sharing-endpoint"); endpoint.value = "https://collector.example/records";
  await ui.elements.get("research-sharing-apply").click();
  assert.equal(ui.elements.get("research-sharing-consent").checked, false);
  ui.elements.get("research-sharing-consent").checked = true; await ui.elements.get("research-sharing-consent").dispatch("change");
  recordResearchFixture(ui); await settleResearch(); recordResearchFixture(ui, 23); await settleResearch();
  assert.match(ui.elements.get("research-sharing-status").textContent, /1 queued/);
  assert.equal(calls.length, 0);
  await ui.elements.get("research-sharing-send").click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.credentials, "omit"); assert.equal(calls[0].init.redirect, "error");
  const batch = JSON.parse(calls[0].init.body); assert.equal(batch.records.length, 1); assert.equal(batch.records[0].measurements.pumpTimeSec, 23);
  recordResearchFixture(ui, 24); await settleResearch();
  await ui.elements.get("research-sharing-disable").click();
  ui.elements.get("research-local-enabled").checked = false; await ui.elements.get("research-local-enabled").dispatch("change");
  const restored = uiFixture(undefined, ui.context.localStorage); await settleResearch();
  assert.equal(restored.elements.get("research-sharing-consent").checked, false);
  assert.equal(restored.elements.get("research-local-enabled").checked, false);
  assert.match(restored.elements.get("research-sharing-status").textContent, /1 record\(s\).*0 queued/);
  recordResearchFixture(restored); await settleResearch();
  await restored.elements.get("research-sharing-export").click();
  assert.equal(JSON.parse(restored.downloads.at(-1).parts.join("")).records.length, 1);
  await restored.elements.get("research-sharing-delete").click();
  await restored.elements.get("research-sharing-export").click();
  assert.equal(JSON.parse(restored.downloads.at(-1).parts.join("")).records.length, 0);
});

test("research endpoint changes revoke consent and unsafe endpoints cannot enable sharing", async () => {
  const ui = uiFixture(); await settleResearch();
  const endpoint = ui.elements.get("research-sharing-endpoint");
  endpoint.value = "https://collector.example/records?token=private"; await ui.elements.get("research-sharing-apply").click();
  assert.match(ui.elements.get("research-sharing-status").textContent, /HTTPS without credentials, query or fragment/);
  assert.equal(ui.elements.get("research-sharing-consent").disabled, true);
  endpoint.value = "https://collector.example/records"; await ui.elements.get("research-sharing-apply").click();
  ui.elements.get("research-sharing-consent").checked = true; await ui.elements.get("research-sharing-consent").dispatch("change");
  recordResearchFixture(ui); await settleResearch();
  endpoint.value = "https://another.example/records"; await ui.elements.get("research-sharing-apply").click();
  assert.equal(ui.elements.get("research-sharing-consent").checked, false);
  assert.match(ui.elements.get("research-sharing-status").textContent, /0 queued/);
  assert.match(ui.elements.get("research-sharing-destination").textContent, /another.example/);
});

test("deployment research destination never grants consent and unknown measured clocks stay unknown", async () => {
  const ui = uiFixture(undefined, null, {researchConfig: {endpoint: "https://deployment.example/records"}}); await settleResearch();
  assert.equal(ui.elements.get("research-sharing-consent").checked, false);
  assert.equal(ui.elements.get("research-sharing-consent").disabled, false);
  assert.match(ui.elements.get("research-sharing-destination").textContent, /deployment.example/);
  recordResearchFixture(ui);
  ui.elements.get("simple-clock-confirmed").checked = false;
  ui.elements.get("simple-pressure-confirmed").checked = false;
  ui.elements.get("simple-record").click(); await settleResearch();
  await ui.elements.get("research-sharing-export").click();
  const record = JSON.parse(ui.downloads.at(-1).parts.join("")).records[0];
  assert.equal(record.recipe.targetClock, "unknown");
  assert.equal(record.measurements?.pumpTimeSec, undefined);
  assert.equal(record.measurements?.recordingTimeSec, undefined);
  assert.equal(record.measurements?.doseG, undefined);
  assert.equal(record.recipe.targetDoseG, 18);
  assert.equal(record.advice.direction, "none");
});

test("blank machine recipes cannot record and their recovery opens the recipe step", () => {
  const ui = uiFixture(), record = nativeSession(ui), field = id => ui.elements.get("simple-" + id);
  let focused = false; field("profile-name").focus = () => { focused = true; };
  field("profile-name").value = "   "; record(22, 34);
  assert.equal(field("history").children.length, 0);
  assert.match(field("brew-status").textContent, /machine recipe name in step 2/);
  field("brew-status").children.find(node => node.tagName === "BUTTON").click();
  assert.match(ui.elements.get("wizard-status").textContent, /Step 2 of 4/);
  assert.equal(focused, true);
  field("profile-name").value = "My pressure recipe"; record(22, 34);
  assert.equal(field("history").children.length, 1);
  field("profile-name").value = ""; field("profile-name").dispatch("change");
  focused = false;
  ui.elements.get("native-response").children.find(node => node.tagName === "BUTTON").click();
  assert.match(ui.elements.get("wizard-status").textContent, /Step 2 of 4/);
  assert.equal(focused, true, "an incomplete recipe points back to its own field");
  record(23, 30); assert.equal(field("history").children.length, 1, "failed recording retains measured history");
});

test("physical click grinders never propose a fractional setting while stepless marks can", () => {
  for (const model of ["1Zpresso X-Pro", "1Zpresso J-Max", "1Zpresso K series", "Baratza Encore ESP", "DF64 Gen 2"]) {
    const ui = uiFixture(), field = id => ui.elements.get("simple-" + id);
    ui.elements.get("grinder").value = model; ui.elements.get("grinder").dispatch("change");
    const record = nativeSession(ui, 24);
    field("step").value = "1"; field("bound-min").value = "5"; field("bound-max").value = "20";
    for (const [setting, time] of [[10, 34], [11, 30], [12, 26]]) {
      if (field("history").children.length) field("continue").click();
      record(setting, time);
    }
    if (model === "DF64 Gen 2") {
      assert.equal(ui.elements.get("native-response").attributes["data-status"], "suggestion");
      assert.match(field("advice").textContent, /Try 12.5 marks next/);
      field("continue").click(); assert.equal(field("current-dial").value, "12.5");
    } else {
      assert.equal(ui.elements.get("native-response").attributes["data-reason"], "native_resolution", model);
      assert.match(field("advice").textContent, /Keep the grinder at 12 /, model);
      field("continue").click(); assert.equal(field("current-dial").value, "12", model);
      record(12.5, 24); assert.equal(field("history").children.length, 3, model);
      assert.match(field("brew-status").textContent, /whole click setting/, model);
    }
  }
});

test("LAGOM 01 printed decimal dial requires an owner step instead of adding one micro-tick", async () => {
  const ui = uiFixture(); await new Promise(setImmediate);
  ui.elements.get("grinder").value = "LAGOM 01"; ui.elements.get("grinder").dispatch("change");
  assert.equal(ui.elements.get("simple-step").value, "");
  assert.equal(ui.elements.get("simple-confirm-dial").checked, false);
  assert.match(ui.elements.get("simple-step-preset").textContent, /No numeric step is assumed|printed|tick.to.number/i);
  const field = id => ui.elements.get("simple-" + id);
  field("current-dial").value = "2.3"; field("time").value = "34"; field("taste").value = "too bitter";
  field("finer").value = "-1"; field("bound-min").value = "2"; field("bound-max").value = "3";
  field("clock-confirmed").checked = true; field("pressure-confirmed").checked = true; field("record").click();
  assert.equal(field("history").children.length, 1, "decimal native observations remain valid");
  assert.equal(ui.elements.get("native-response").attributes["data-reason"], "invalid_setup");
  field("continue").click(); assert.equal(field("current-dial").value, "2.3", "unknown tick scale cannot move the dial by one printed number");
});


test("boot and restored pages clear dial confirmation without erasing the owner step", async () => {
  const ui = uiFixture(), confirmation = ui.elements.get("simple-confirm-dial"), step = ui.elements.get("simple-step");
  ui.windowEvents.get("pageshow")({persisted: false});
  step.value = "99"; confirmation.checked = true;
  assert.equal(confirmation.disabled, true, "setup stays unavailable during browser restoration");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(confirmation.checked, false, "browser-restored approval is cleared before setup becomes interactive");
  assert.equal(step.value, "0.5", "unconfirmed restored input is replaced by the model preset");
  assert.equal(confirmation.disabled, false);
  assert.equal(confirmation.autocomplete, "off");
  const record = nativeSession(ui); record(22, 34);
  assert.equal(ui.elements.get("simple-continue").disabled, false);
  ui.windowEvents.get("pageshow")({persisted: true});
  assert.equal(confirmation.checked, false);
  assert.equal(ui.elements.get("simple-continue").disabled, true, "restored advice cannot retain an approved movement");
  confirmation.checked = true;
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(confirmation.checked, false, "form restoration after pageshow is also cleared");
  assert.equal(step.value, "0.25");
});

function enableMechanicalFixture(ui, absolute = false) {
  ui.elements.get("simple-bound-min").value = "15"; ui.elements.get("simple-bound-max").value = "25";
  ui.elements.get("mechanical-reference").value = "0";
  ui.elements.get("mechanical-enabled").checked = true;
  ui.elements.get("mechanical-zero-assumed").checked = absolute;
}
function researchCard(ui, name) { return ui.elements.get("all-comparison-results").children.find(card => card.attributes["data-algorithm"] === name); }

test("rough mechanical assumptions enable bounded native first-shot estimates without calibration", async () => {
  const ui = uiFixture(); await settleResearch();
  assert.equal(ui.elements.get("mechanical-enabled").checked, false);
  assert.equal(ui.elements.get("mechanical-zero-assumed").checked, false);
  assert.equal(ui.elements.get("mechanical-slope").value, "10.4");
  assert.match(ui.elements.get("mechanical-scenario-note").textContent, /8–13.*not confidence bounds/);
  enableMechanicalFixture(ui); recordResearchFixture(ui); await settleResearch();
  for (const name of ["GbS1", "GbS2"]) {
    const card = researchCard(ui, name);
    assert.equal(card.attributes["data-status"], "computed");
    assert.equal(card.attributes["data-coordinate-status"], "estimated_relative");
    assert.match(card.textContent, /Estimated trial:.*marks/);
  }
  for (const name of ["GbS3", "GbS4", "DdEff"]) assert.equal(researchCard(ui, name).attributes["data-status"], "unavailable");
  assert.match(ui.elements.get("simple-advice").textContent, /from 20 to 19.5 marks/, "native manual guidance stays primary");
  const choose = researchCard(ui, "GbS1").children.find(node => node.textContent === "Try this estimated approach");
  assert.ok(choose); choose.click(); await settleResearch();
  assert.match(ui.elements.get("simple-advice").textContent, /Your chosen estimated trial/);
  ui.elements.get("simple-continue").click();
  const proposed = Number(ui.elements.get("simple-current-dial").value); assert.ok(proposed >= 19.5 && proposed < 20);
  const profiles = JSON.parse(ui.context.localStorage.getItem("decaid.assisted-dialin.grinder-instances.v1"));
  assert.ok(profiles.every(profile => profile.anchors == null), "assumptions never become owner anchors");
});

test("rough zero explicitly enables absolute models, while taste and measured plateau keep priority", async () => {
  const ui = uiFixture(); await settleResearch(); enableMechanicalFixture(ui, true); recordResearchFixture(ui);
  for (const name of ["GbS3", "GbS4"]) assert.equal(researchCard(ui, name).attributes["data-coordinate-status"], "estimated_absolute");
  ui.elements.get("simple-taste").value = "balanced"; ui.elements.get("simple-record").click();
  assert.match(ui.elements.get("simple-advice").textContent, /Keep the grinder at 20/);
  for (const name of ["GbS1", "GbS2", "GbS3", "GbS4"]) assert.ok(!researchCard(ui, name).children.some(node => node.textContent === "Try this estimated approach"));
  ui.elements.get("simple-new").click(); enableMechanicalFixture(ui);
  for (const [index, [setting, time]] of [[22,34],[22.25,31],[22.5,31]].entries()) {
    if (index) ui.elements.get("simple-continue").click();
    ui.elements.get("simple-current-dial").value = String(setting); ui.elements.get("simple-step").value = "0.25"; ui.elements.get("simple-finer").value = "-1"; ui.elements.get("simple-confirm-dial").checked = true;
    ui.elements.get("simple-time").value = String(time); ui.elements.get("simple-taste").value = "too bitter"; ui.elements.get("simple-clock-confirmed").checked = true; ui.elements.get("simple-pressure-confirmed").checked = true; ui.elements.get("simple-record").click();
  }
  assert.match(ui.elements.get("simple-advice").textContent, /Keep the grinder at 22.5.*repeat/);
  assert.ok(!researchCard(ui, "GbS1").children.some(node => node.textContent === "Try this estimated approach"));
});

test("mechanical input gaps hold, and changing grinders revokes the assumption", async () => {
  const ui = uiFixture(); await settleResearch(); enableMechanicalFixture(ui); ui.elements.get("simple-bound-max").value = ""; recordResearchFixture(ui);
  assert.equal(researchCard(ui, "GbS1").attributes["data-status"], "unavailable");
  assert.match(researchCard(ui, "GbS1").textContent, /both ends/);
  ui.elements.get("simple-bound-max").value = "25"; ui.elements.get("simple-clock-confirmed").checked = false; ui.elements.get("simple-record").click();
  assert.equal(researchCard(ui, "GbS1").attributes["data-status"], "unavailable");
  ui.elements.get("grinder").value = "DF54"; ui.elements.get("grinder").dispatch("change");
  assert.equal(ui.elements.get("mechanical-enabled").checked, false);
  assert.match(ui.elements.get("mechanical-source-note").textContent, /unverified|transcript/i);
  ui.elements.get("grinder").value = "LAGOM P64"; ui.elements.get("grinder").dispatch("change");
  assert.equal(Number(ui.elements.get("mechanical-slope").value), 100);
  assert.match(ui.elements.get("mechanical-scenario-note").textContent, /whole printed dial number/);
  assert.equal(ui.elements.get("simple-step").value, "0.1");
});

test("research exports keep series ordinals, corrections, all approaches and actual native categories", async () => {
  const ui = uiFixture(); await settleResearch(); recordResearchFixture(ui); await settleResearch();
  recordResearchFixture(ui, 24); await settleResearch();
  ui.elements.get("simple-continue").click(); recordResearchFixture(ui, 26); await settleResearch();
  await ui.elements.get("research-sharing-export").click();
  let records = JSON.parse(ui.downloads.at(-1).parts.join("")).records;
  assert.equal(records.length, 2); assert.equal(records[0].researchSeries, records[1].researchSeries);
  assert.match(records[0].researchSeries, /^[a-f0-9]{32}$/); assert.deepEqual(records.map(record => record.shotOrdinal), [1,2]);
  assert.equal(records[0].measurements.doseG, undefined); assert.equal(records[0].recipe.targetDoseG, 18);
  assert.equal(records[0].approaches.length, 11); assert.ok(records[0].approaches.some(row => row.algorithm === "native-response"));
  const firstSeries = records[0].researchSeries;
  ui.elements.get("bean").value = "PRIVATE SECOND COFFEE"; ui.elements.get("bean").dispatch("change"); recordResearchFixture(ui); await settleResearch();
  ui.elements.get("grinder").value = "1Zpresso J-Max"; ui.elements.get("grinder").dispatch("change"); recordResearchFixture(ui); await settleResearch();
  await ui.elements.get("research-sharing-export").click(); records = JSON.parse(ui.downloads.at(-1).parts.join("")).records;
  assert.notEqual(records[2].researchSeries, firstSeries); assert.equal(records[2].shotOrdinal, 1);
  assert.equal(records[3].grinder.model, "1Zpresso J-Max"); assert.equal(records[3].grinder.settingUnit, "clicks"); assert.equal(records[3].grinder.setting, 20);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE SECOND COFFEE/);
});

test("owner slope works for an unknown model while sub-click mechanical trials stay withheld", async () => {
  const ui = uiFixture(); await settleResearch();
  ui.elements.get("grinder").value = "Other known grinder"; ui.elements.get("grinder").dispatch("change");
  assert.equal(ui.elements.get("mechanical-slope").value, "");
  ui.elements.get("mechanical-slope").value = "5"; ui.elements.get("mechanical-slope").dispatch("change");
  enableMechanicalFixture(ui); recordResearchFixture(ui);
  assert.equal(researchCard(ui, "GbS1").attributes["data-coordinate-status"], "estimated_relative");
  ui.elements.get("grinder").value = "1Zpresso J-Max"; ui.elements.get("grinder").dispatch("change");
  enableMechanicalFixture(ui); recordResearchFixture(ui);
  ui.elements.get("simple-step").value = "1"; ui.elements.get("simple-record").click();
  const card = researchCard(ui, "GbS1");
  assert.match(card.textContent, /withheld|Estimated trial: 19 clicks/);
  assert.doesNotMatch(card.textContent, /Estimated trial: 19\.[0-9]+ clicks/);
});

test("relative mechanical proposals withhold a result that depends on the temporary origin", async () => {
  const ui = uiFixture(); await settleResearch(); enableMechanicalFixture(ui);
  ui.elements.get("mechanical-reference").value = "29.5";
  recordResearchFixture(ui);
  const card = researchCard(ui, "GbS1");
  assert.equal(card.attributes["data-status"], "computed");
  assert.match(card.textContent, /temporary reference changes this result/);
  assert.ok(!card.children.some(node => node.textContent === "Try this estimated approach"));
});


test("LAGOM research records retain decimal printed coordinates", async () => {
  for (const model of ["LAGOM 01", "LAGOM P64"]) {
  const ui = uiFixture(); await settleResearch();
  ui.elements.get("grinder").value = model; ui.elements.get("grinder").dispatch("change");
  recordResearchFixture(ui);
  ui.elements.get("simple-current-dial").value = "2.1"; ui.elements.get("simple-step").value = "0.1"; ui.elements.get("simple-record").click(); await settleResearch();
  await ui.elements.get("research-sharing-export").click();
  const record = JSON.parse(ui.downloads.at(-1).parts.join("")).records[0];
  assert.equal(record.grinder.model, model); assert.equal(record.grinder.settingUnit, "printed-decimal");
  assert.equal(record.grinder.setting, 2.1); assert.equal(record.grinder.step, .1);
  }
});

test("legacy LAGOM micro-tick steps cannot silently become decimal-number steps", async () => {
  const ui = uiFixture(); await settleResearch();
  ui.elements.get("grinder").value = "LAGOM 01"; ui.elements.get("grinder").dispatch("change");
  ui.elements.get("simple-step").value = "1"; ui.elements.get("simple-finer").value = "-1";
  ui.elements.get("simple-confirm-dial").checked = true; ui.elements.get("simple-confirm-dial").dispatch("change");
  const key = "decaid.assisted-dialin.grinder-instances.v1";
  const profiles = JSON.parse(ui.context.localStorage.getItem(key));
  const lagom = profiles.find(profile => profile.model === "LAGOM 01"); delete lagom.nativeSetup.settingUnit;
  ui.context.localStorage.setItem(key, JSON.stringify(profiles));
  const old = uiFixture(undefined, ui.context.localStorage); await settleResearch();
  assert.equal(old.elements.get("simple-step").value, ""); assert.equal(old.elements.get("simple-finer").value, "");
  assert.equal(old.elements.get("simple-confirm-dial").checked, false);
  assert.match(old.elements.get("simple-step-preset").textContent, /different or unspecified dial unit/);
  old.elements.get("simple-step").value = "0.1"; old.elements.get("simple-finer").value = "-1";
  old.elements.get("simple-confirm-dial").checked = true; old.elements.get("simple-confirm-dial").dispatch("change");
  const current = uiFixture(undefined, old.context.localStorage); await settleResearch();
  assert.equal(current.elements.get("simple-step").value, "0.1"); assert.equal(current.elements.get("simple-confirm-dial").checked, false);
  assert.equal(JSON.parse(current.context.localStorage.getItem(key)).find(profile => profile.model === "LAGOM 01").nativeSetup.settingUnit, "decimal dial numbers");
});

test("legacy P64 micro-tick steps are cleared before decimal-number migration", async () => {
  const ui = uiFixture(); await settleResearch();
  ui.elements.get("grinder").value = "LAGOM P64"; ui.elements.get("grinder").dispatch("change");
  ui.elements.get("simple-step").value = "1"; ui.elements.get("simple-finer").value = "-1";
  ui.elements.get("simple-confirm-dial").checked = true; ui.elements.get("simple-confirm-dial").dispatch("change");
  const key = "decaid.assisted-dialin.grinder-instances.v1";
  const profiles = JSON.parse(ui.context.localStorage.getItem(key));
  const p64 = profiles.find(profile => profile.model === "LAGOM P64");
  p64.nativeSetup.settingUnit = "dial micro-ticks";
  ui.context.localStorage.setItem(key, JSON.stringify(profiles));
  const restored = uiFixture(undefined, ui.context.localStorage); await settleResearch();
  assert.equal(restored.elements.get("simple-step").value, "");
  assert.equal(restored.elements.get("simple-finer").value, "");
  assert.equal(restored.elements.get("simple-confirm-dial").checked, false);
  assert.match(restored.elements.get("simple-step-preset").textContent, /different or unspecified dial unit/);
});
