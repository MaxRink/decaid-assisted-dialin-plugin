const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("plugin.js", "utf8");

class Element {
  constructor(name) {
    this.name = name;
    this.listeners = {};
    this.value = "";
    this.fields = {};
    this.innerHTML = "";
    this._textContent = "";
    this.children = [];
    this.focused = false;
    this.hidden = true;
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
    state: html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1],
  };
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
      }[selector];
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
    context,
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
          groupTemperature: { timeWeightedMae: 0.1 },
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
  assert.match(ui.output.textContent, /Measured bean ratio: 0/);
  assert.match(ui.output.textContent, /Warnings: sample gap \| partial scale data/);
  assert.match(ui.output.textContent, /These are descriptive differences/);
  assert.equal(ui.output.textContent.includes("\\n"), false);
  assert.ok(ui.output.textContent.includes("\n"));
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
  assert.equal(ui.dialReferenceBody.children[2].href, "https://example.test/df64-guide");
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
