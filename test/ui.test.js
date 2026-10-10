const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('plugin.js', 'utf8');

class Element {
  constructor(name) {
    this.name = name;
    this.listeners = {};
    this.value = '';
    this.fields = {};
    this.innerHTML = '';
    this._textContent = '';
  }
  set textContent(value) { this._textContent = String(value); }
  get textContent() { return this._textContent; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}

class FormDataFixture {
  constructor(form) {
    this.form = form;
  }
  get(key) { return this.form.fields[key] || ''; }
}

function response(value, {ok = true, status = 200} = {}) {
  return {ok, status, json: async () => value};
}

async function uiFixture(fetchImpl) {
  let plugin;
  const host = {
    log() {},
    storage(command) {
      if (command.type === 'read') {
        plugin.onEvent({name: 'storageRead', payload: {key: command.key, value: {}}});
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
  const html = (await plugin.handleHttpRequest({endpoint: 'ui', method: 'GET'})).body;
  const output = new Element('output');
  const recommend = new Element('recommend');
  const form = new Element('feedback');
  form.fields = {shotId: 'shot-1', notes: '<img src=x onerror=alert(1)>'};
  context.document = {
    querySelector(selector) {
      return {output, '#recommend': recommend, '#feedback': form}[selector];
    },
  };
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  vm.runInContext(script, context);
  return {html, output, recommend, form, context};
}

test('recommendation success renders JSON as text', async () => {
  const ui = await uiFixture(async () => response({status: 'recommendation', grinderSetting: '2.2'}));
  await ui.recommend.onclick();
  assert.match(ui.output.textContent, /recommendation/);
  assert.match(ui.output.textContent, /2\.2/);
  assert.equal(ui.output.innerHTML, '');
});

test('recommendation network failure surfaces a retryable safe message', async () => {
  const ui = await uiFixture(async () => { throw new Error('secret URL and token'); });
  await ui.recommend.onclick();
  assert.equal(ui.output.textContent, 'Could not load recommendation. Try again.');
  assert.equal(ui.output.textContent.includes('secret'), false);
});

test('recommendation HTTP errors still surface a safe JSON error', async () => {
  const ui = await uiFixture(async () => response({error: 'Assisted dial-in unavailable'}, {ok: false, status: 503}));
  await ui.recommend.onclick();
  assert.match(ui.output.textContent, /Assisted dial-in unavailable/);
  assert.equal(ui.output.innerHTML, '');
});

test('feedback mark and unmark submit through the public form', async () => {
  const requests = [];
  const ui = await uiFixture(async (url, init) => {
    requests.push({url, init});
    return response({saved: true, shotId: 'shot-1'});
  });
  await ui.form.onsubmit({preventDefault() {}, target: ui.form, submitter: {value: 'true'}});
  await ui.form.onsubmit({preventDefault() {}, target: ui.form, submitter: {value: 'false'}});
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[0].init.body).good, true);
  assert.equal(JSON.parse(requests[1].init.body).good, false);
  assert.equal(ui.html.includes('<label>Shot ID'), true);
  assert.equal(ui.html.includes('<label>Notes'), true);
});

test('feedback network failure is surfaced without leaking notes', async () => {
  const ui = await uiFixture(async () => { throw new Error('private transport detail'); });
  await assert.rejects(
    ui.form.onsubmit({preventDefault() {}, target: ui.form, submitter: {value: 'true'}}),
  );
  assert.equal(ui.output.textContent.includes('private transport detail'), false);
});

test('keyboard submit without a submitter does not throw', async () => {
  const ui = await uiFixture(async () => response({saved: true}));
  await ui.form.onsubmit({preventDefault() {}, target: ui.form});
  assert.match(ui.output.textContent, /saved|Could not/i);
});

