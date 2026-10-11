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

function uiFixture(catalog = { schemaVersion: 1, sources: [] }, persistentStorage = null) {
  const dialData = JSON.parse(fs.readFileSync(require("node:path").join(root, "data/grinder-dials.json"), "utf8"));
  const ids = [
    "notice", "theme", "algorithm", "grinder", "grinder-instance", "grinder-profiles", "add-grinder", "rename-grinder", "save-grinder", "remove-grinder", "burrs", "bean", "roaster", "species", "roast", "calibration", "dose", "yield", "target", "start", "tolerance", "plant", "noise", "pressure", "flow", "next", "run", "reset", "add", "undo", "shots", "assist-profile", "assist-dial", "assist-taste", "assist", "assist-result", "helper", "helper-fields", "helper-run", "helper-result", "replay", "result", "explain", "comparison-count", "compare", "chart", "dial-panel", "export", "import", "catalog-status", "catalog-search", "catalog",
  ];
  const elements = new Map(ids.map((id) => [id, new Element("div", id)]));
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
  const downloads = [];
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
    document,
    window: null,
    globalThis: null,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    fetch: async (url) => ({ ok: true, json: async () => String(url).includes("grinder-dials") ? dialData : catalog }),
    localStorage: persistentStorage || { data: new Map(), getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }, setItem(key, value) { this.data.set(key, String(value)); }, removeItem(key) { this.data.delete(key); } },
    Blob: BlobFixture,
    FileReader: FileReaderFixture,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${pluginSource}\nthis.createResearchAlgorithms = createResearchAlgorithms;`, context);
  vm.runInContext(engineSource, context);
  vm.runInContext(appSource, context);
  return { context, elements, downloads };
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
  assert.equal(first.elements.get("grinder-instance").children.length, 5);
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
  await ui.elements.get("assist").click();
  assert.match(ui.elements.get("assist-result").textContent, /provisional/);
  assert.match(ui.elements.get("assist-result").textContent, /Red Brick espresso recipe/);
  assert.match(ui.elements.get("assist-result").textContent, /finer/);
});
