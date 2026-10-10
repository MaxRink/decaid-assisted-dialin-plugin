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

async function uiFixture(fetchImpl, { rich = false } = {}) {
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
      }[selector];
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
