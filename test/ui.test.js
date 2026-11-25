const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("plugin.js", "utf8");

test("help links expose only fixed HTTPS issue routes and never prefill private launch context", async () => {
  const ui = await uiFixture(async () => response({}), {location: {
    href: "http://127.0.0.1/api/v1/plugins/assisted-dialin.reaplugin/ui?shotId=PRIVATE-SHOT&beanScaleId=PRIVATE-SCALE",
    pathname: "/api/v1/plugins/assisted-dialin.reaplugin/ui",
    search: "?shotId=PRIVATE-SHOT&beanScaleId=PRIVATE-SCALE",
  }});
  const footer = ui.html.match(/<footer id="pluginHelp">([\s\S]*?)<\/footer>/)?.[1];
  assert.ok(footer);
  const anchors = [...footer.matchAll(/<a\s+([^>]+)>([^<]+)<\/a>/g)];
  assert.equal(anchors.length, 11);
  const routes = anchors.map(([, attributes]) => {
    const href = attributes.match(/href="([^"]+)"/)[1];
    const url = new URL(href);
    assert.equal(url.protocol, "https:"); assert.equal(url.hostname, "github.com");
    assert.equal(url.username, ""); assert.equal(url.password, "");
    assert.match(url.pathname, /^\/[^/]+\/[^/]+\/(?:issues(?:\/new)?|security\/advisories\/new)$/);
    assert.ok([...url.searchParams.keys()].every(key => key === "template"));
    assert.match(attributes, /target="_blank"/);
    assert.match(attributes, /rel="noopener noreferrer"/);
    assert.match(attributes, /referrerpolicy="no-referrer"/);
    assert.doesNotMatch(href, /PRIVATE-/);
    return url.pathname;
  });
  assert.equal(routes.filter(route => route === "/MaxRink/decaid-assisted-dialin-plugin/issues/new").length, 6);
  assert.ok(routes.includes("/MaxRink/decaid-assisted-dialin-plugin/security/advisories/new"));
  assert.ok(anchors.some(([, attributes]) => new URL(attributes.match(/href="([^"]+)"/)[1]).searchParams.get("template") === "protocol-mock-device.yml"));
  assert.ok(routes.includes("/decentespresso/decaid/issues"));
  assert.ok(routes.includes("/decentespresso/streamline-js/issues"));
});

class Element {
  constructor(name) {
    this.name = name;
    this.listeners = {};
    this.value = "";
    this.fields = {};
    this.innerHTML = "";
    this._textContent = "";
    this.children = [];
    this.dataset = {};
    this.focused = false;
    this.elements = { namedItem: (name) => ({
      get value() { return this.owner.fields[name] ?? ""; },
      set value(value) { this.owner.fields[name] = String(value); },
      get checked() { return this.owner.fields[name] === true || this.owner.fields[name] === "on"; },
      set checked(value) { this.owner.fields[name] = value ? "on" : ""; },
      owner: this,
    }) };
    this.hidden = true;
    this.dataset = {};
  }
  set textContent(value) {
    this._textContent = String(value);
  }
  get textContent() {
    return this._textContent;
  }
  addEventListener(name, callback) {
    this.listeners[name] = callback;
  }
  click() {
    return this.listeners.click ? this.listeners.click({ target: this }) : undefined;
  }
  appendChild(child) {
    this.children.push(child);
  }
  focus() {
    this.focused = true;
  }
}

class FormDataFixture {
  constructor(form) {
    this.form = form;
  }
  get(key) {
    return this.form.fields[key] || "";
  }
}

function response(value, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => value };
}

async function uiFixture(fetchImpl, { rich = false, location } = {}) {
  let plugin;
  const host = {
    log() {},
    storage(command) {
      if (command.type === "read") {
        plugin.onEvent({
          name: "storageRead",
          payload: { key: command.key, value: {} },
        });
      }
    },
  };
  const context = {
    console,
    Date,
    JSON,
    Math,
    Promise,
    URL,
    URLSearchParams,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    FormData: FormDataFixture,
    document: null,
    location,
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  plugin = context.createPlugin(host);
  plugin.onLoad({});
  let html = (await plugin.handleHttpRequest({ endpoint: "ui", method: "GET" }))
    .body;
  const output = new Element("output");
  const recommend = new Element("recommend");
  const form = new Element("feedback");
  const suggestion = new Element("suggestion");
  const research = new Element("research");
  const beans = new Element("beans");
  const analysis = new Element("analysis");
  const loadShots = new Element("loadShots");
  const shotSelect = new Element("shotSelect");
  const returnLink = new Element("returnLink");
  const referenceDetails = new Element("reviewedReferences");
  const referenceList = new Element("referenceList");
  const dialReference = new Element("dialReference");
  const dialReferenceBody = new Element("dialReferenceBody");
  const grinderManager = new Element("grinderManager");
  const loadGrinders = new Element("loadGrinders");
  const grinderProfileSelect = new Element("grinderProfileSelect");
  const grinderModel = new Element("grinderModel");
  const grinderLabel = new Element("grinderLabel");
  const grinderBurrs = new Element("grinderBurrs");
  const grinderEpoch = new Element("grinderEpoch");
  const grinderPitchSource = new Element("grinderPitchSource");
  const grinderAnchors = new Element("grinderAnchors");
  const saveGrinder = new Element("saveGrinder");
  const selectGrinder = new Element("selectGrinder");
  const grinderManagerStatus = new Element("grinderManagerStatus");
  const grinderObservation = new Element("grinderObservation");
  const grinderObservationStatus = new Element("grinderObservationStatus");
  analysis.fields = { shotId: "shot-1" };
  form.fields = { shotId: "shot-1", notes: "<img src=x onerror=alert(1)>" };
  form.fields = {
    ...form.fields,
    taste: "sour",
    brewTimeSec: "22.5",
    burrIdentity: "stock",
    calibrationEpoch: "cal-1",
    basket: "58mm",
    settingUnit: "owner marks",
    beanBatchId: "batch-1",
    grinderId: "grinder-1",
    grinderModel: "DF64",
    dose: "18",
    yield: "36",
  };
  research.fields = {
    state: html.match(/<textarea[^>]*name="state"[^>]*>([\s\S]*?)<\/textarea>/)[1],
  };
  const sharingElements = Object.fromEntries(["researchSharing", "researchLocal", "researchEndpoint", "researchHostLimits", "researchEnable", "researchDisable", "researchRetry", "researchExport", "researchDelete", "researchStatus", "researchExportData", "grinderCurrent", "dialUnit", "dialFiner", "dialStep", "dialMin", "dialMax", "grinderAdjust", "grinderAdjustStatus", "applyToGrinder", "confirmApply", "cancelApply", "gbsComparison", "loadGbsComparison", "gbsComparisonList"].map(id => [id, new Element(id)]));
  context.document = {
    querySelector(selector) {
      return {
        output,
        "#result": output,
        "#recommend": recommend,
        "#feedback": form,
        "#suggestion": suggestion,
        "#research": research,
        "#beans": beans,
        "#analysis": analysis,
        "#loadShots": loadShots,
        "#shotSelect": shotSelect,
        "#returnLink": returnLink,
        "#reviewedReferences": referenceDetails,
        "#referenceList": referenceList,
        "#dialReference": dialReference,
        "#dialReferenceBody": dialReferenceBody,
        "#grinderManager": grinderManager,
        "#loadGrinders": loadGrinders,
        "#grinderProfileSelect": grinderProfileSelect,
        "#grinderModel": grinderModel,
        "#grinderLabel": grinderLabel,
        "#grinderBurrs": grinderBurrs,
        "#grinderEpoch": grinderEpoch,
        "#grinderPitchSource": grinderPitchSource,
        "#grinderAnchors": grinderAnchors,
        "#saveGrinder": saveGrinder,
        "#selectGrinder": selectGrinder,
        "#grinderManagerStatus": grinderManagerStatus,
        "#grinderObservation": grinderObservation,
        "#grinderObservationStatus": grinderObservationStatus,
      }[selector] || sharingElements[selector.slice(1)];
    },
    createElement() {
      return new Element("option");
    },
  };
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  vm.runInContext(script, context);
  return {
    html,
    output,
    recommend,
    form,
    suggestion,
    research,
    beans,
    analysis,
    loadShots,
    shotSelect,
    returnLink,
    referenceDetails,
    referenceList,
    dialReference,
    dialReferenceBody,
    grinderManager,
    loadGrinders,
    grinderProfileSelect,
    grinderModel,
    grinderLabel,
    grinderBurrs,
    grinderEpoch,
    grinderPitchSource,
    grinderAnchors,
    saveGrinder,
    selectGrinder,
    grinderManagerStatus,
    grinderObservation,
    grinderObservationStatus,
    context,
    sharingElements,
  };
}

test("recommendation success renders JSON as text", async () => {
  const ui = await uiFixture(async () =>
    response({ status: "recommendation", grinderSetting: "2.2" }),
  );
  await ui.recommend.onclick();
  assert.match(ui.output.textContent, /recommendation/);
  assert.match(ui.output.textContent, /2\.2/);
  assert.equal(ui.output.innerHTML, "");
});

test("live grinder observation is available from the equipment step", async () => {
  const ui = await uiFixture(async (url) => {
    if (String(url).endsWith("grinder-observation"))
      return response({ status: "available", setting: "501 ddValueDum", unit: "opaque", provenance: "live read-only" });
    return response({});
  });
  await ui.grinderObservation.click();
  assert.match(ui.grinderObservationStatus.textContent, /501 ddValueDum/);
  assert.match(ui.grinderObservationStatus.textContent, /live read-only/);
});

test("the live grinder status links the grinder plugin's diagnostics surface only on the Decaid origin", async () => {
  for (const [href, linked] of [["/api/v1/plugins/mahlkoenig-e64.reaplugin/e64-diagnostics?deviceId=d", true], ["https://example.com/x", false]]) {
    const ui = await uiFixture(async (url) => String(url).endsWith("grinder-observation")
      ? response({ status: "available", setting: "630 ddValueDum", unit: "opaque", provenance: "live", surfaces: [{ role: "diagnostics", label: "E64 diagnostics", href }] })
      : response({}));
    await ui.grinderObservation.click();
    const link = ui.grinderObservationStatus.children.find((child) => child.id === "grinderDiagnosticsLink");
    assert.equal(Boolean(link), linked, href);
    if (linked) { assert.equal(link.href, href); assert.equal(link.textContent, "E64 diagnostics"); }
  }
});

test("a suggestion that used the live grinder setting says so", async () => {
  const ui = await uiFixture(async () => response({ status: "abstain", reason: "More feedback is needed", currentSettingSource: "live-grinder-observation",
    liveGrinderObservation: { setting: "630 ddValueDum", observedAt: "2026-11-23T10:00:00.000Z" } }));
  await ui.suggestion.onclick();
  assert.match(ui.output.textContent, /read live from the connected grinder: 630 ddValueDum at 2026-11-23T10:00:00.000Z/);
});

test("an E64 display reading is shown as the grinder shows it, with its rounding disclosed", async () => {
  const ui = await uiFixture(async (url) => String(url).endsWith("grinder-observation")
    ? response({ status: "available", setting: "83", unit: "opaque", reading: { kind: "display", value: 83 }, provenance: "live" })
    : response({ status: "abstain", reason: "More feedback is needed", currentSettingSource: "live-grinder-observation", currentSettingPrecisionDd: 5,
      liveGrinderObservation: { setting: "83", observedAt: "2026-11-23T10:00:00.000Z" } }));
  await ui.grinderObservation.click();
  assert.match(ui.grinderObservationStatus.textContent, /Live grinder display: 83 \(as shown on the grinder\)/);
  await ui.suggestion.onclick();
  assert.match(ui.output.textContent, /read live from the connected grinder: 83 at .*rounds to whole micrometres \(±5 dD\)/);
});

test("the grinder picker lists Decaid grinders, saves dial-in data to the chosen one and selects it", async () => {
  const requests = [];
  const grinders = [
    { id: "g-e64", model: "Mahlkönig E64 WS", burrs: "64 mm flat (stock)", settingType: "numeric", settingSmallStep: 1, source: "mahlkoenig-e64.reaplugin", dialIn: { settingUnit: "micrometres", finerDelta: -1 } },
    { id: "g-df", model: "DF64 Gen 1", burrs: "SSP HU", settingType: "numeric", settingSmallStep: 0.5, source: null, dialIn: null },
  ];
  const ui = await uiFixture(async (url, init = {}) => {
    requests.push({ url, init });
    if (url === "grinders" && init.method === "POST") {
      const body = JSON.parse(init.body);
      return body.operation === "select" ? response({ selected: true, selectedGrinderId: body.grinderId }) : response({ saved: true, grinderId: body.grinderId, dialIn: body.dialIn });
    }
    if (url === "grinders") return response({ grinders, current: { grinderId: "g-e64", source: "workflow" } });
    return response({});
  });
  const el = ui.sharingElements;
  await ui.loadGrinders.click();
  assert.equal(ui.grinderProfileSelect.children.length, 2);
  assert.match(ui.grinderProfileSelect.children[0].textContent, /Mahlkönig E64 WS · 64 mm flat \(stock\) \(current\)/);
  assert.equal(ui.grinderProfileSelect.value, "g-e64");
  assert.equal(el.dialUnit.value, "micrometres");
  assert.equal(el.dialFiner.value, "-1");
  assert.match(el.grinderCurrent.textContent, /kept up to date by mahlkoenig-e64.reaplugin/);
  assert.equal(requests.some((r) => String(r.url).includes("/api/v1/grinders")), false, "the page never writes Decaid grinders directly");

  ui.grinderProfileSelect.value = "g-df";
  await ui.grinderProfileSelect.listeners.change({ target: ui.grinderProfileSelect });
  el.dialUnit.value = "marks"; el.dialFiner.value = "-1"; el.dialStep.value = "0.5"; el.dialMin.value = "0"; el.dialMax.value = "90";
  ui.grinderEpoch.value = "zero-1";
  ui.grinderAnchors.value = '{"dialMin":0,"dialMax":90,"dialA":0,"ddDumA":300,"dialB":90,"ddDumB":1200}';
  await ui.saveGrinder.click();
  const saved = JSON.parse(requests.find((r) => r.url === "grinders" && r.init.method === "POST").init.body);
  assert.deepEqual(saved, { grinderId: "g-df", dialIn: { settingUnit: "marks", finerDelta: -1, stepSize: 0.5, minSetting: 0, maxSetting: 90, calibrationEpoch: "zero-1",
    dialCalibration: { dialMin: 0, dialMax: 90, dialA: 0, ddDumA: 300, dialB: 90, ddDumB: 1200 } } });
  assert.match(ui.grinderManagerStatus.textContent, /Saved the dial-in data/);

  await ui.selectGrinder.click();
  const select = requests.filter((r) => r.url === "grinders" && r.init.method === "POST").map((r) => JSON.parse(r.init.body)).find((body) => body.operation === "select");
  assert.deepEqual(select, { operation: "select", grinderId: "g-df" });
  assert.equal(requests.some((r) => r.url === "settings"), false, "the host serves /settings itself, so it is never used");
});

test("the grinder picker reports malformed anchors and refused saves without losing the form", async () => {
  const ui = await uiFixture(async (url, init = {}) => url === "grinders" && init.method === "POST"
    ? response({ error: "dial-in finerDelta is invalid" }, { ok: false, status: 400 })
    : response({ grinders: [{ id: "g-df", model: "DF64 Gen 1", settingType: "numeric", dialIn: null }], current: { grinderId: null, source: null } }));
  await ui.loadGrinders.click();
  ui.grinderAnchors.value = "{bad";
  await ui.saveGrinder.click();
  assert.match(ui.grinderManagerStatus.textContent, /Anchors must be valid JSON/);
  ui.grinderAnchors.value = "";
  await ui.saveGrinder.click();
  assert.match(ui.grinderManagerStatus.textContent, /finerDelta is invalid/);
});

test("recommendation network failure surfaces a retryable safe message", async () => {
  const ui = await uiFixture(async () => {
    throw new Error("secret URL and token");
  });
  await ui.recommend.onclick();
  assert.equal(
    ui.output.textContent,
    "Could not load recommendation. Try again.",
  );
  assert.equal(ui.output.textContent.includes("secret"), false);
});

test("recommendation HTTP errors still surface a safe JSON error", async () => {
  const ui = await uiFixture(async () =>
    response(
      { error: "Assisted dial-in unavailable" },
      { ok: false, status: 503 },
    ),
  );
  await ui.recommend.onclick();
  assert.match(ui.output.textContent, /Assisted dial-in unavailable/);
  assert.equal(ui.output.innerHTML, "");
});

test("feedback mark and unmark submit through the public form", async () => {
  const requests = [];
  const ui = await uiFixture(async (url, init) => {
    requests.push({ url, init });
    return response({ saved: true, shotId: "shot-1" });
  });
  await ui.form.onsubmit({
    preventDefault() {},
    target: ui.form,
    submitter: { value: "true" },
  });
  await ui.form.onsubmit({
    preventDefault() {},
    target: ui.form,
    submitter: { value: "false" },
  });
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[0].init.body).good, true);
  assert.equal(JSON.parse(requests[1].init.body).good, false);
  assert.equal(ui.html.includes("<label>Shot ID"), true);
  assert.equal(ui.html.includes("<label>Notes"), true);
});

test("feedback network failure is surfaced without leaking notes", async () => {
  const ui = await uiFixture(async () => {
    throw new Error("private transport detail");
  });
  await ui.form.onsubmit({
    preventDefault() {},
    target: ui.form,
    submitter: { value: "true" },
  });
  assert.match(ui.output.textContent, /Could not save feedback/);
  assert.equal(
    ui.output.textContent.includes("private transport detail"),
    false,
  );
});

test("keyboard submit without a submitter does not throw", async () => {
  const ui = await uiFixture(async () => response({ saved: true }));
  await ui.form.onsubmit({ preventDefault() {}, target: ui.form });
  assert.match(ui.output.textContent, /saved|Could not/i);
});

test("feedback saves explicit taste, timing and confirmed context", async () => {
  const requests = [];
  const ui = await uiFixture(
    async (url, init) => {
      requests.push({ url, init });
      return response({
        status: "abstain",
        reason: "insufficient comparable shots",
      });
    },
    { rich: true },
  );
  await ui.form.onsubmit({
    preventDefault() {},
    target: ui.form,
    submitter: { value: "false" },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "feedback");
  const payload = JSON.parse(requests[0].init.body);
  assert.deepEqual(payload, {
    shotId: "shot-1",
    good: false,
    notes: "<img src=x onerror=alert(1)>",
    taste: "sour",
    flavour: null,
    brewTimeSec: 22.5,
    brewTimeClock: "pump",
    manualStopConfirmed: false,
    confirmedContext: {
      burrIdentity: "stock",
      calibrationEpoch: "cal-1",
      basket: "58mm",
      settingUnit: "owner marks",
      beanBatchId: "batch-1",
      grinderId: "grinder-1",
      grinderModel: "DF64",
      dose: 18,
      yield: 36,
    },
  });
  assert.match(ui.output.textContent, /insufficient comparable shots/);
  assert.equal(ui.output.innerHTML, "");
});

test("research replay posts a pinned software-only GbS2 state", async () => {
  const requests = [];
  const ui = await uiFixture(
    async (url, init) => {
      requests.push({ url, init });
      return response({
        status: "replay",
        firmwareBuild: "HEM-HSG-HMI-S01 V01.16-24",
      });
    },
    { rich: true },
  );
  await ui.research.onsubmit({ preventDefault() {}, target: ui.research });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "research");
  const payload = JSON.parse(requests[0].init.body);
  assert.equal(payload.operation, "adjust");
  assert.equal(payload.scope.grinderId, "synthetic-grinder");
  assert.equal(payload.algorithm, "GbS2");
  assert.equal(payload.coordinateUnit, "deci-micrometre");
  assert.equal(payload.stateEnvelope, undefined);
  assert.match(ui.output.textContent, /software-only|replay/i);
});

test("research replay rejects malformed JSON without a request", async () => {
  const requests = [];
  const ui = await uiFixture(
    async (url, init) => {
      requests.push({ url, init });
      return response({});
    },
    { rich: true },
  );
  ui.research.fields.state = '{"algorithm":';
  await ui.research.onsubmit({ preventDefault() {}, target: ui.research });
  assert.equal(requests.length, 0);
  assert.equal(ui.output.textContent, "Research replay JSON is invalid.");
  assert.equal(ui.output.innerHTML, "");
});

test("richer UI renders hostile API text through textContent", async () => {
  const ui = await uiFixture(
    async () => response({ reason: "<script>private</script>" }),
    { rich: true },
  );
  await ui.suggestion.onclick();
  assert.match(ui.output.textContent, /<script>private<\/script>/);
  assert.equal(ui.output.innerHTML, "");
});

test("suggestion button uses the public GET endpoint", async () => {
  const requests = [];
  const ui = await uiFixture(async (url, init) => {
    requests.push({ url, init });
    return response({ status: "suggestion" });
  });
  await ui.suggestion.onclick();
  assert.equal(requests[0].url, "suggestion");
  assert.equal(requests[0].init, undefined);
});

test("post-brew flavour, historical bean and roast inputs are submitted with feedback", async () => {
  const requests = [];
  const ui = await uiFixture(async (url, init) => {
    requests.push({ url, init });
    return response({ saved: true });
  });
  Object.assign(ui.form.fields, {
    descriptors: "plum, chocolate",
    overall: "balanced",
    acidity: "4",
    bitterness: "0",
    beanType: "arabica",
    roastLevel: "light",
  });
  await ui.form.onsubmit({ preventDefault() {}, target: ui.form });
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body.flavour, {
    descriptors: ["plum", "chocolate"],
    overall: "balanced",
    acidity: 4,
    bitterness: 0,
  });
  assert.equal(body.confirmedContext.beanType, "arabica");
  assert.equal(body.confirmedContext.roastLevel, "light");
});
test("brew metrics and bean context UI use their public endpoints", async () => {
  const requests = [];
  const ui = await uiFixture(async (url, init) => {
    requests.push({ url, init });
    return response({ available: true });
  });
  await ui.beans.onclick();
  await ui.analysis.onsubmit({ preventDefault() {}, target: ui.analysis });
  assert.equal(requests[0].url, "bean-context");
  assert.equal(requests[0].init, undefined);
  assert.equal(requests[1].url, "analysis");
  assert.equal(JSON.parse(requests[1].init.body).shotId, "shot-1");
});

test("shot analysis shows the linked grinder recipe and labels grinder weight as dose evidence", async () => {
  const ui = await uiFixture(async () => response({ shotId: "shot-1", metrics: {},
    grind: { grindUuid: "g", recipe: { type: "espresso", mode: "GbW", amount: 18 }, weightG: 18.07, durationS: 8.3 },
    doseEvidence: { grams: 18.07, source: "grinder-reported ground weight" } }));
  await ui.analysis.onsubmit({ preventDefault() {}, target: ui.analysis });
  assert.match(ui.output.textContent, /Recipe: espresso\/GbW 18, ground 18\.07 g/);
  assert.match(ui.output.textContent, /Dose evidence: 18\.07 g \(grinder-reported ground weight\)/);
});

test("Apply to grinder needs a second, explicit confirmation and is only offered when Decaid owns adjustments", async () => {
  const requests = [];
  let control = { owner: "decaid", settable: true, applyAvailable: true, shadowMode: false };
  const ui = await uiFixture(async (url, init = {}) => {
    requests.push({ url, init });
    if (url === "grinder-control") return response(control);
    if (url === "apply-setting") return response({ applied: true, setting: "82" });
    return response({ status: "suggestion", direction: "finer", proposedSetting: 820, settingUnit: "deci-micrometre", evidenceCount: 3, sourceShotIds: ["a"] });
  });
  const el = ui.sharingElements;
  await ui.suggestion.onclick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(el.applyToGrinder.hidden, false);
  assert.equal(requests.some((r) => r.url === "apply-setting"), false, "nothing is applied by suggesting");
  await el.applyToGrinder.click();
  assert.equal(el.confirmApply.hidden, false);
  assert.equal(requests.some((r) => r.url === "apply-setting"), false, "the first click only asks for confirmation");
  await el.cancelApply.click();
  assert.match(el.grinderAdjustStatus.textContent, /Not applied/);
  await el.applyToGrinder.click();
  await el.confirmApply.click();
  const applied = requests.filter((r) => r.url === "apply-setting");
  assert.equal(applied.length, 1);
  assert.deepEqual(JSON.parse(applied[0].init.body), { proposedSetting: 820, settingUnit: "deci-micrometre", confirmed: true });
  assert.match(el.grinderAdjustStatus.textContent, /Applied: the grinder was asked to set 82 \(suggested 820 deci-micrometre\)/);

  control = { owner: "grinder", settable: true, applyAvailable: false, shadowMode: true };
  await ui.suggestion.onclick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(el.applyToGrinder.hidden, true);
  assert.match(el.grinderAdjustStatus.textContent, /recorded for comparison only/);
});

test("the GBS comparison lists the assisted suggestion beside the grinder's next dial", async () => {
  const ui = await uiFixture(async (url) => url === "gbs-comparison"
    ? response({ rows: [{ shotId: "s1", dial: { value: 83 }, assisted: { direction: "finer", proposedSetting: 820, settingUnit: "deci-micrometre" },
      grinderNext: { shotId: "s2", dial: { value: 81 }, direction: "smaller" } }] })
    : response({}));
  const el = ui.sharingElements;
  await el.loadGbsComparison.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(el.gbsComparisonList.children[0].textContent, "Shot s1: dial 83 — assisted: finer to 820 deci-micrometre — grinder GBS next: 81");
});

test("bean weighing is sent only after explicit confirmation", async () => {
  const requests = [];
  const ui = await uiFixture(async (url, init) => {
    requests.push({ url, init });
    return response({ saved: true, shotId: "shot-1" });
  });
  Object.assign(ui.form.fields, {
    confirmBeanMeasurement: "on",
    beanScaleId: "scale-1",
    beanScaleRole: "auxiliary",
    beanWeight: "18.4",
    beanCapturedAt: "2026-10-11T12:00",
    beanSampleTimestamp: "2026-10-11T11:59",
  });
  await ui.form.onsubmit({ preventDefault() {}, target: ui.form });
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body.measuredBeanDose, {
    deviceId: "scale-1",
    connectionRole: "auxiliary",
    purpose: "beans",
    weightG: 18.4,
    units: "g",
    capturedAt: new Date("2026-10-11T12:00").toISOString(),
    sampleTimestamp: new Date("2026-10-11T11:59").toISOString(),
    userConfirmed: true,
  });
});

test("invalid confirmed bean weighing does not lock the form and can be corrected", async () => {
  const requests = [];
  const ui = await uiFixture(async (url, init) => {
    requests.push({ url, init });
    return response({ saved: true, shotId: "shot-1" });
  });
  ui.form.fields.confirmBeanMeasurement = "on";
  await ui.form.onsubmit({ preventDefault() {}, target: ui.form });
  assert.equal(requests.length, 0);
  assert.match(ui.output.textContent, /positive bean weight/);
  Object.assign(ui.form.fields, {
    beanScaleId: "scale-1",
    beanWeight: "18.4",
    beanCapturedAt: "2026-10-11T12:00",
  });
  await ui.form.onsubmit({ preventDefault() {}, target: ui.form });
  assert.equal(requests.length, 1);
});

test("launch action analyses the selected shot and permits a same-host return port", async () => {
  const requests = [];
  const ui = await uiFixture(
    async (url, init) => {
      requests.push({ url, init });
      return response({ shotId: "shot-9", metrics: {}, feedback: null });
    },
    {
      location: {
        pathname: "/api/v1/plugins/assisted-dialin.reaplugin/ui",
        search: "?shotId=shot-9&action=analyze&return=http%3A%2F%2Flocalhost%3A3000%2Fshots%2F9",
        href: "http://localhost:8080/api/v1/plugins/assisted-dialin.reaplugin/ui?shotId=shot-9",
        origin: "http://localhost:8080",
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[0].url, "/api/v1/plugins/assisted-dialin.reaplugin/analysis");
  assert.equal(JSON.parse(requests[0].init.body).shotId, "shot-9");
  assert.equal(ui.returnLink.href, "http://localhost:3000/shots/9");
});

test("return navigation rejects hostile schemes, hosts and credentials", async () => {
  for (const target of [
    "javascript:alert(1)",
    "https://evil.example/steal",
    "http://user:pass@localhost:3000/private",
  ]) {
    const ui = await uiFixture(
      async () => response({ status: "abstain" }),
      {
        location: {
          pathname: "/api/v1/plugins/assisted-dialin.reaplugin/ui",
          search: `?returnTo=${encodeURIComponent(target)}`,
          href: "http://localhost:8080/api/v1/plugins/assisted-dialin.reaplugin/ui",
          origin: "http://localhost:8080",
        },
      },
    );
    assert.equal(ui.returnLink.hidden, true);
  }
});

test("a skin-local return path resolves on the skin server port from webui status", async () => {
  const cases = [
    ["/skin/history", { serving: true, port: 3000 }, "http://localhost:3000/skin/history"],
    ["/skin/history", { serving: false, port: 3000 }, null],
    ["/\\evil.example/x", { serving: true, port: 3000 }, null],
    ["//evil.example/x", { serving: true, port: 3000 }, null],
  ];
  for (const [target, status, expected] of cases) {
    const ui = await uiFixture(
      async (url) => (String(url).endsWith("/api/v1/webui/server/status") ? response(status) : response({ status: "abstain" })),
      { location: { pathname: "/api/v1/plugins/assisted-dialin.reaplugin/ui", search: `?return=${encodeURIComponent(target)}`,
        href: "http://localhost:8080/api/v1/plugins/assisted-dialin.reaplugin/ui", origin: "http://localhost:8080" } },
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    if (expected) { assert.equal(ui.returnLink.hidden, false, target); assert.equal(ui.returnLink.href, expected); }
    else assert.equal(ui.returnLink.hidden, true, target);
  }
});

test("a stale shot-list response cannot replace a newer list", async () => {
  let resolveFirst;
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  let calls = 0;
  const ui = await uiFixture(async (url) => {
    calls += 1;
    if (calls === 1) return first;
    return response({ items: [{ id: "new", timestamp: "now" }] });
  });
  const oldRefresh = ui.loadShots.onclick();
  const newRefresh = ui.loadShots.onclick();
  await newRefresh;
  resolveFirst(response({ items: [{ id: "old", timestamp: "before" }] }));
  await oldRefresh;
  assert.equal(ui.shotSelect.children[0].value, "new");
});

test("analysis rendering explains target differences and preserves zero metrics", async () => {
  const ui = await uiFixture(async () =>
    response({
      shotId: "shot-1",
      metrics: {
        elapsedSec: 25,
        machine: {
          pressure: { timeWeightedMae: 0 },
          flow: { timeWeightedMae: 0.25 },
          mixTemperature: { timeWeightedMae: 0 },
          groupTemperature: { timeWeightedMae: null },
        },
        scale: { finalMeasuredWeightG: 40, brewFlowGPerSec: 2, warnings: ["partial scale data"] },
        annotations: { actualYieldToMeasuredBeanDoseRatio: 0 },
        warnings: ["sample gap"],
      },
      feedback: { good: false, flavour: { overall: "balanced" } },
      provenance: "Saved full shot",
    }),
  );
  await ui.analysis.onsubmit({ preventDefault() {}, target: ui.analysis });
  assert.match(ui.output.textContent, /Average pressure difference from target: 0\.00 bar/);
  assert.match(ui.output.textContent, /Average group temperature difference from target: unavailable °C/);
  assert.match(ui.output.textContent, /Measured bean ratio: 0/);
  assert.match(ui.output.textContent, /Warnings: sample gap \| partial scale data/);
  assert.match(ui.output.textContent, /These are descriptive differences/);
  assert.equal(ui.output.textContent.includes("\\n"), false);
  assert.ok(ui.output.textContent.includes("\n"));
});

test("analysis hydrates the selected shot and a later shot cannot inherit its feedback", async () => {
  const ui = await uiFixture(async (url) => {
    if (url === "analysis") return response({
      shotId: "shot-1",
      metrics: {},
      feedback: {
        good: true,
        notes: "first shot",
        taste: "sour",
        flavour: { overall: "under-extracted", descriptors: ["citrus"], servingTemperatureC: 61 },
        confirmedContext: { beanType: "washed", grinderRpm: 1200 },
        manualStopConfirmed: true,
        measuredBeanDose: { deviceId: "scale-1", connectionRole: "auxiliary", weightG: 18.2, units: "g", capturedAt: "2026-10-11T12:00:00.000Z", sampleTimestamp: null, userConfirmed: true },
      },
    });
    return response({});
  });
  await ui.analysis.onsubmit({ preventDefault() {}, target: ui.analysis });
  assert.equal(ui.form.fields.notes, "first shot");
  assert.equal(ui.form.fields.taste, "sour");
  assert.equal(ui.form.fields.overall, "under-extracted");
  assert.equal(ui.form.fields.beanWeight, "18.2");
  assert.equal(ui.form.fields.confirmBeanMeasurement, "on");
  ui.shotSelect.onchange({ target: { value: "shot-2" } });
  assert.equal(ui.form.fields.notes, "");
  assert.equal(ui.form.fields.taste, "");
  assert.equal(ui.form.fields.beanWeight, "");
  assert.equal(ui.form.fields.confirmBeanMeasurement, "");
});

test("matched references render as safe human-readable source details", async () => {
  const ui = await uiFixture(async () =>
    response({
      status: "provisional",
      direction: "finer",
      evidenceCount: 1,
      reviewedReferences: {
        matches: [{
          title: "Example guide",
          publisher: "Example publisher",
          url: "https://example.test/guide",
          scope: { applicability: "model-specific" },
          facts: { brewTimeSec: { min: 20, max: 30, unit: "s" } },
          notes: ["Use as a scoped example"],
        }],
      },
    }),
  );
  await ui.suggestion.onclick();
  assert.equal(ui.referenceDetails.hidden, false);
  assert.equal(ui.referenceList.children.length, 1);
  const item = ui.referenceList.children[0];
  assert.equal(item.children[0].textContent, "Example guide");
  assert.equal(item.children[0].href, "https://example.test/guide");
  assert.match(item.children[1].textContent, /Brew time \(s\): 20–30 s/);
  assert.match(item.children[1].textContent, /scoped example/);
  assert.equal(item.children[1].innerHTML, "");
});

test("suggestion renders the physical grinder dial scale and safe photo source", async () => {
  const ui = await uiFixture(async () =>
    response({
      status: "provisional",
      direction: "finer",
      evidenceCount: 1,
      currentSetting: "10",
      proposedSetting: 11,
      settingUnit: "marks",
      dialReference: {
        model: "DF64",
        displayUnit: "marks",
        range: { min: 0, max: 90 },
        zeroMeaning: "burrs touching",
        direction: "higher numbers are coarser; lower numbers are finer",
        calibrationStatus: "owner-calibrated zero; verify after burr changes",
        nativeStatus: "available",
        currentNative: { value: 10, unit: "marks" },
        proposedNative: { value: 11, unit: "marks" },
      photoUrl: "https://example.test/df64-dial.jpg",
      photoRenderAllowed: true,
      photoLicense: "CC BY",
      photoLicenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        sourceUrl: "https://example.test/df64-guide",
      },
    }),
  );
  await ui.suggestion.onclick();
  assert.match(ui.output.textContent, /Current physical dial: 10 marks/);
  assert.match(ui.output.textContent, /Proposed physical dial: 11 marks/);
  assert.equal(ui.dialReference.hidden, false);
  assert.match(ui.dialReferenceBody.children[0].textContent, /Reference markings: 0 marks to 90 marks/);
  assert.match(ui.dialReferenceBody.children[0].textContent, /burrs touching/);
  assert.equal(ui.dialReferenceBody.children[1].src, "https://example.test/df64-dial.jpg");
  assert.equal(ui.dialReferenceBody.children[2].href, "https://creativecommons.org/licenses/by/4.0/");
  assert.equal(ui.dialReferenceBody.children[3].href, "https://example.test/df64-guide");
});


test("unmapped dD stays research-only in the primary suggestion output", async () => {
  const ui = await uiFixture(async () => response({status: "suggestion", evidenceCount: 1, direction: "finer", currentSetting: 500, proposedSetting: 490, settingUnit: "deci-micrometre", dialReference: {model: "DF64", coordinateOnly: true, nativeStatus: "calibration-required", displayUnit: "deci-micrometre"}}));
  await ui.suggestion.onclick();
  assert.match(ui.output.textContent, /Current research coordinate: 500 deci-micrometre/);
  assert.match(ui.output.textContent, /Proposed research coordinate: 490 deci-micrometre/);
  assert.doesNotMatch(ui.output.textContent, /physical dial/);
});

test("native micron display uses converted values rather than the raw dD", async () => {
  const ui = await uiFixture(async () => response({status: "suggestion", evidenceCount: 1, direction: "finer", currentSetting: 500, proposedSetting: 490, settingUnit: "deci-micrometre", dialReference: {model: "E64 WS", coordinateOnly: true, nativeStatus: "available", displayUnit: "deci-micrometre", currentNative: {value: 50, unit: "micrometres"}, proposedNative: {value: 49, unit: "micrometres", achievable: true}}}));
  await ui.suggestion.onclick();
  assert.match(ui.output.textContent, /Current physical dial: 50 micrometres/);
  assert.match(ui.output.textContent, /Proposed physical dial: 49 micrometres/);
  assert.doesNotMatch(ui.output.textContent, /physical dial: 500/);
});


test("a transport failure reaches the panel even when only the upload entry is set", async () => {
  // status().error is a storage failure; a stalled or rejected upload is
  // reported in uploadError and must be shown, not just left in the JSON.
  const state = {localEnabled:true,sharing:true,endpoint:"https://collector.example/v1/events",localCount:2,queuedCount:1,error:null,
    uploadError:"Research upload timed out after 30 seconds; queued records stay local for a later retry"};
  const ui = await uiFixture(async (url, init = {}) => {
    if (url === "sharing") return response(state);
    return response({records:[]});
  });
  const el = ui.sharingElements;
  await el.researchRetry.click();
  assert.match(el.researchStatus.textContent, /pending uploads/);
  assert.match(el.researchStatus.textContent, /timed out after 30 seconds/, "the transport failure is visible");
  assert.match(el.researchStatus.textContent, /queued records stay local/);
});

test("research controls save explicit choices and show offline errors without posting from the browser to a collector", async () => {
  const calls = [];
  let state = {localEnabled:true,sharing:false,endpoint:null,localCount:2,queuedCount:0};
  const ui = await uiFixture(async (url, init = {}) => {
    calls.push({url,init});
    assert.ok(["sharing", "sharing-export"].includes(url));
    const input = init.body ? JSON.parse(init.body) : null;
    if (url === "sharing-export") return response({records:[{source:"plugin",measurements:{doseG:18}}]});
    if (init.method === "DELETE") state = {...state,sharing:false,localCount:0,queuedCount:0};
    else if (input?.operation === "retry") state = {...state,error:"Research upload failed; queued records remain local."};
    else if (input?.operation === "local") state = {...state,localEnabled:input.enabled};
    else if (input?.sharing === true) {
      if (!input.acknowledgeHostLimits) return response({error:"Acknowledge the host upload limits before sharing"},{ok:false,status:400});
      state = {...state,sharing:true,endpoint:input.endpoint};
    } else if (input?.sharing === false) state = {...state,sharing:false,endpoint:null,queuedCount:0};
    return response(state);
  });
  const el=ui.sharingElements;
  el.researchEndpoint.value="https://collector.example/v1/events";
  await el.researchEnable.click();assert.match(el.researchStatus.textContent,/Acknowledge/);
  el.researchHostLimits.checked=true;await el.researchEnable.click();assert.equal(state.sharing,true);
  assert.equal(JSON.parse(calls.at(-1).init.body).acknowledgeHostLimits,true);
  await el.researchRetry.click();assert.match(el.researchStatus.textContent,/upload failed/);
  await el.researchDisable.click();assert.equal(state.sharing,false);assert.equal(state.localCount,2);
  await el.researchExport.click();assert.match(el.researchExportData.textContent,/doseG/);assert.equal(el.researchExportData.hidden,false);
  await el.researchDelete.click();assert.equal(state.localCount,0);
});
