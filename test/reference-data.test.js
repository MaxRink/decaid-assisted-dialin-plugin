const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "plugin.js"), "utf8");

test("reference catalog generator is deterministic and validates its source", () => {
  const result = spawnSync(
    process.env.PYTHON || "python3",
    [path.join(root, "scripts/embed-reference-data.py"), "--check"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const generated = source.slice(
    source.indexOf("/* GENERATED REFERENCE CATALOG START */"),
    source.indexOf("/* GENERATED REFERENCE CATALOG END */"),
  );
  assert.equal(generated.toLowerCase().includes("</script"), false);
});

test("embedded reference matching stays conservative and source scoped", () => {
  const context = { JSON, Object, Array, String, Set };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.catalog = createReferenceCatalog();`, context);
  const catalog = context.catalog;
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(catalog.sources.length > 0);
  assert.equal(catalog.matchReferences({}).length, 0);
  assert.equal(catalog.matchReferences({ grinderModel: undefined }).length, 0);
  assert.equal(catalog.matchReferences({ bean: { roaster: "Unknown Roaster" } }).length, 0);
  const df64 = catalog.matchReferences({ grinderModel: "DF64" });
  assert.ok(df64.length >= 1);
  assert.ok(df64.every((source) => source.scope.grinderModel === "DF64"));
  assert.equal(catalog.matchReferences({ grinderModel: "DF64", burrIdentity: "SSP HU" }).length, 0);
  assert.equal(
    catalog.matchReferences({
      bean: { name: "Red Brick", roaster: "Square Mile Coffee Roasters" },
    })[0].id,
    "squaremile-red-brick",
  );
  assert.equal(
    catalog.matchReferences({
      bean: { name: "Red Brick", roaster: "Other Roaster" },
    }).length,
    0,
  );
  assert.ok(
    catalog
      .matchReferences({ bean: { roaster: "Counter Culture Coffee" } })
      .some((source) => source.id === "counter-culture-espresso"),
  );
  const blueBottle = catalog.matchReferences({ bean: { roaster: "Blue Bottle Coffee" } });
  assert.ok(blueBottle.length >= 1);
  assert.ok(blueBottle.every((source) => source.scope.brewMethod === "espresso"));
  assert.equal(catalog.matchReferences({ burrIdentity: "unknown-burr" }).length, 0);
});

test("references endpoint returns bounded offline catalog with attribution", async () => {
  let plugin;
  const context = {
    console,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    Set,
    URLSearchParams,
    fetch: async () => {
      throw new Error("references endpoint must not fetch");
    },
    setTimeout,
    clearTimeout,
  };
  const host = {
    log() {},
    storage(command) {
      if (command.type === "read")
        queueMicrotask(() =>
          plugin.onEvent({
            name: "storageRead",
            payload: { key: command.key, value: {} },
          }),
        );
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  plugin = context.createPlugin(host);
  plugin.onLoad({});
  const response = await plugin.handleHttpRequest({
    endpoint: "references",
    method: "GET",
  });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.schemaVersion, 1);
  assert.ok(body.sources.length >= 20 && body.sources.length <= 128);
  assert.match(body.provenance, /offline reviewed reference catalog/i);
  assert.match(body.attribution, /publisher/i);
  assert.equal(typeof body.sources[0].url, "string");
  plugin.onUnload();
});


test("known dial references are available offline and keep physical models separate", () => {
  const context = { JSON, Object, Array, String, Set, Number, Math };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.catalog = createReferenceCatalog(); this.dials = createGrinderDialTools();`, context);
  const models = context.catalog.grinderDials.models;
  assert.equal(models.length, 16);
  for (const model of models) {
    assert.ok(context.dials.profileFor(model.model), `missing shipped profile: ${model.model}`);
    assert.ok(fs.existsSync(path.join(root, "docs/grinder-dials", model.id + ".svg")));
    assert.match(model.zero, /./);
    if (model.image) {
      const url = new URL(model.image.url);
      assert.equal(url.protocol, "https:");
      assert.equal(url.username + url.password, "");
      assert.match(model.image.caption, /./);
      assert.match(model.image.owner, /./);
    }
  }
  const df64 = models.filter(model => /^DF64/.test(model.model));
  assert.equal(df64.length, 2);
  assert.notEqual(df64[0].id, df64[1].id);
  assert.ok(context.catalog.sources.some(source => source.id === "mahlkoenig-e64ws-native-distance"));
});
