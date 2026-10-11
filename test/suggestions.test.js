const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { timedMeasurements } = require("./shot-fixtures");

const source = fs.readFileSync("plugin.js", "utf8");

const profile = {
  title: "espresso",
  steps: [{ pump: "pressure", pressure: 9 }],
};
const context = ({ setting = "10", complete = true } = {}) => ({
  beanBatchId: "batch-a",
  grinderId: "grinder-1",
  grinderModel: "DF64",
  grinderSetting: setting,
  targetDoseWeight: 18,
  targetYield: 36,
  ...(complete
    ? {
        grinderBurrs: "stock",
        extras: {
          calibrationEpoch: "cal-1",
          basket: "58mm",
          grinderSettingUnit: "marks",
        },
      }
    : {}),
});

function shot(id, ageMs, seconds, options = {}) {
  const timestamp = new Date(Date.now() - ageMs).toISOString();
  const fullContext =
    options.fullContext ||
    context({
      setting: options.setting || "10",
      complete: options.complete !== false,
    });
  const summaryContext = options.summaryContext || fullContext;
  const measurements =
    options.measurements === undefined
      ? timedMeasurements(timestamp, seconds)
      : options.measurements;
  return {
    id,
    timestamp,
    workflow: { context: summaryContext, profile },
    full: {
      id,
      timestamp,
      workflow: { context: fullContext, profile },
      measurements,
    },
  };
}

function response(value, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => value };
}

async function load({
  shots = [],
  stored = null,
  settings = {},
  routeError = null,
  deferFull = false,
  currentContext = context(),
  currentProfile = profile,
} = {}) {
  const events = [];
  const fullById = new Map(shots.map((entry) => [entry.id, entry.full]));
  let plugin;
  let releaseFull;
  const fullWait = new Promise((resolve) => {
    releaseFull = resolve;
  });
  const host = {
    log(message) {
      events.push(message);
    },
    storage(command) {
      if (command.type === "read")
        setTimeout(
          () =>
            plugin.onEvent({
              name: "storageRead",
              payload: { key: command.key, value: stored },
            }),
          0,
        );
      if (command.type === "write") {
        events.push({ stored: command.data });
        setTimeout(
          () => plugin.onEvent({ name: "storageWrite", payload: command.data }),
          0,
        );
      }
    },
  };
  const fetchStub = async (url) => {
    if (routeError && routeError.test(url))
      return response({ error: "fixture failure" }, { ok: false, status: 500 });
    if (url.endsWith("/workflow"))
      return response({ context: currentContext, profile: currentProfile });
    if (url.includes("/shots?"))
      return response({
        items: shots.map(({ full, ...summary }) => summary),
        total: shots.length,
      });
    const match = url.match(/\/shots\/([^/?]+)$/);
    if (match) {
      if (deferFull) await fullWait;
      return fullById.has(decodeURIComponent(match[1]))
        ? response(fullById.get(decodeURIComponent(match[1])))
        : response({}, { ok: false, status: 404 });
    }
    if (url.endsWith("/bean-batches/batch-a"))
      return response({ id: "batch-a", beanId: "bean-a", roastLevel: "light" });
    if (url.endsWith("/beans/bean-a"))
      return response({ id: "bean-a", name: "Fixture bean", species: "arabica", processing: "washed" });
    return response({}, { ok: false, status: 404 });
  };
  const contextVm = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Math,
    Promise,
    URLSearchParams,
    fetch: fetchStub,
    btoa: (s) => Buffer.from(s).toString("base64"),
  };
  vm.createContext(contextVm);
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, contextVm);
  plugin = contextVm.createPlugin(host);
  plugin.onLoad({
    TargetTimeSec: 30,
    TimeToleranceSec: 1,
    EvidenceMaxAgeDays: 14,
    StepSize: 0.5,
    NumericFinerDelta: -1,
    MinSetting: 0,
    MaxSetting: 90,
    ...settings,
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  return { plugin, events, releaseFull, contextVm };
}

async function mark(plugin, id, taste = "sour", confirmedContext, brewTimeSec) {
  const body = { shotId: id, good: true, taste };
  if (confirmedContext) body.confirmedContext = confirmedContext;
  if (brewTimeSec !== undefined) body.brewTimeSec = brewTimeSec;
  const result = await plugin.handleHttpRequest({
    endpoint: "feedback",
    method: "POST",
    body,
  });
  assert.equal(result.status, 200, result.body);
}

async function suggest(plugin) {
  const result = await plugin.handleHttpRequest({
    endpoint: "suggestion",
    method: "GET",
  });
  return { response: result, body: JSON.parse(result.body) };
}

function cohort({ taste = "sour", complete = true } = {}) {
  return [20_000, 22_000, 24_000].map((ageMs, index) =>
    shot(`shot-${index}`, ageMs, 20 + index * 2, { complete }),
  );
}

test("requires three recent complete shots and returns the median timing with calibrated proposal", async () => {
  const { plugin } = await load({ shots: cohort() });
  for (const entry of cohort()) await mark(plugin, entry.id, "sour");
  const { response, body } = await suggest(plugin);
  assert.equal(response.status, 200);
  assert.equal(body.status, "suggestion");
  assert.equal(body.sourceShotIds.length, 3);
  assert.equal(body.medianElapsedTimeSec, 22);
  assert.equal(body.timeDirection, "finer");
  assert.equal(body.direction, "finer");
  assert.equal(body.currentSetting, "10");
  assert.equal(body.proposedSetting, 9.5);
  assert.equal(body.settingUnit, "marks");
  assert.equal(body.requiresConfirmation, true);
  assert.equal(body.currentBeanCatalog.status, "available");
  assert.ok(body.reviewedReferences.matches.some((source) => source.id === "df64-clive"));
  assert.match(body.reviewedReferences.matches.find((source) => source.id === "df64-clive").url, /^https:\/\//);
  assert.equal(
    body.evidence[0].timingProvenance,
    "recorded_machine_substates: pump clock",
  );
});

test("missing historical fields are accepted only with explicit full-shot confirmation", async () => {
  const entries = cohort({ complete: false });
  const { plugin } = await load({ shots: entries });
  const confirmedContext = {
    burrIdentity: "stock",
    calibrationEpoch: "cal-1",
    basket: "58mm",
    settingUnit: "marks",
  };
  for (const entry of entries)
    await mark(plugin, entry.id, "sour", confirmedContext);
  const { body } = await suggest(plugin);
  assert.equal(body.status, "suggestion");
  assert.deepEqual(
    body.evidence[0].confirmedHistoricalFields.sort(),
    Object.keys(confirmedContext).sort(),
  );
  entries[0].full.workflow.context.extras = { basket: "different" };
  const conflict = await plugin.handleHttpRequest({
    endpoint: "feedback",
    method: "POST",
    body: {
      shotId: entries[0].id,
      good: true,
      taste: "sour",
      confirmedContext: { ...confirmedContext, basket: "wrong" },
    },
  });
  assert.equal(conflict.status, 400);
});

test("stale, future and malformed timing evidence are excluded", async () => {
  const entries = [
    ...cohort(),
    shot("stale", 15 * 86400000, 20),
    shot("future", -60_000, 20),
    shot("nonmonotonic", 30_000, 20, {
      measurements: [
        { machine: { timestamp: new Date(Date.now() - 30_000).toISOString() } },
        { machine: { timestamp: new Date(Date.now() - 31_000).toISOString() } },
      ],
    }),
  ];
  const { plugin } = await load({ shots: entries });
  for (const entry of entries) await mark(plugin, entry.id, "sour");
  const { body } = await suggest(plugin);
  assert.equal(body.status, "suggestion");
  assert.equal(body.sourceShotIds.length, 3);
  assert.ok(
    body.excluded.some(
      (entry) => entry.shotId === "stale" && /stale/.test(entry.reason),
    ),
  );
  assert.ok(
    body.excluded.some(
      (entry) => entry.shotId === "future" && /future/.test(entry.reason),
    ),
  );
  assert.ok(
    body.excluded.some(
      (entry) =>
        entry.shotId === "nonmonotonic" &&
        /unavailable|invalid|boundaries are incomplete/.test(entry.reason),
    ),
  );
});

for (const [taste, reason] of [
  ["channeling", "Channeling"],
  ["weak", "Weak"],
  ["balanced", "Balanced"],
]) {
  test(`abstains for ${taste} feedback`, async () => {
    const { plugin } = await load({ shots: cohort() });
    for (const entry of cohort()) await mark(plugin, entry.id, taste);
    const { body } = await suggest(plugin);
    assert.equal(body.status, "abstain");
    assert.match(body.reason, new RegExp(reason));
  });
}

test("abstains when taste and timing directions conflict", async () => {
  const { plugin } = await load({ shots: cohort() });
  for (const entry of cohort()) await mark(plugin, entry.id, "bitter");
  const { body } = await suggest(plugin);
  assert.equal(body.status, "abstain");
  assert.match(body.reason, /opposite|conflict/i);
});

test("good false feedback persists while ordinary good-shot lookup excludes it", async () => {
  const entries = cohort();
  const { plugin, events } = await load({ shots: entries });
  const result = await plugin.handleHttpRequest({
    endpoint: "feedback",
    method: "POST",
    body: { shotId: entries[0].id, good: false, taste: "sour" },
  });
  assert.equal(result.status, 200);
  const stored = events.find((entry) => entry && entry.stored).stored;
  assert.equal(stored[entries[0].id].good, false);
  assert.equal(stored[entries[0].id].taste, "sour");
  const { body } = await suggest(plugin);
  assert.equal(body.status, "suggestion");
  assert.equal(body.stage, "provisional");
  assert.equal(body.evidenceCount, 1);
  assert.deepEqual(body.sourceShotIds, [entries[0].id]);
  assert.equal(body.direction, "finer");
  assert.equal(body.proposedSetting, 9.5);
});

test("missing numeric calibration returns direction only", async () => {
  const { plugin } = await load({
    shots: cohort(),
    settings: {
      StepSize: "",
      NumericFinerDelta: "",
      MinSetting: "",
      MaxSetting: "",
    },
  });
  for (const entry of cohort()) await mark(plugin, entry.id, "sour");
  const { body } = await suggest(plugin);
  assert.equal(body.status, "suggestion");
  assert.equal(body.proposedSetting, null);
  assert.ok(body.warnings.some((warning) => /Direction only/.test(warning)));
});

test("full-shot API failure returns safe 503", async () => {
  const { plugin } = await load({
    shots: cohort(),
    routeError: /\/shots\/shot-0$/,
  });
  for (const entry of cohort()) await mark(plugin, entry.id, "sour");
  const { response } = await suggest(plugin);
  assert.equal(response.status, 503);
  assert.equal(response.body.includes("fixture failure"), false);
});

test("late full-shot result is fenced after a new shot event", async () => {
  const entries = cohort();
  const { plugin, releaseFull } = await load({
    shots: entries,
    deferFull: true,
  });
  for (const entry of entries) await mark(plugin, entry.id, "sour");
  const pending = suggest(plugin);
  await new Promise((resolve) => setTimeout(resolve, 2));
  plugin.onEvent({ name: "shotStored", payload: {} });
  releaseFull();
  const { response } = await pending;
  assert.equal(response.status, 503);
});

test("late full-shot result is fenced after workflow and feedback changes", async () => {
  for (const eventName of ["workflowUpdated"]) {
    const entries = cohort();
    const { plugin, releaseFull } = await load({
      shots: entries,
      deferFull: true,
    });
    for (const entry of entries) await mark(plugin, entry.id, "sour");
    const pending = suggest(plugin);
    await new Promise((resolve) => setTimeout(resolve, 2));
    plugin.onEvent({ name: eventName, payload: {} });
    releaseFull();
    assert.equal((await pending).response.status, 503);
  }
  const entries = cohort();
  const { plugin, releaseFull } = await load({
    shots: entries,
    deferFull: true,
  });
  for (const entry of entries) await mark(plugin, entry.id, "sour");
  const pending = suggest(plugin);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const update = plugin.handleHttpRequest({
    endpoint: "feedback",
    method: "POST",
    body: { shotId: "new-mark", good: true, taste: "sour", brewTimeSec: 20 },
  });
  await update;
  releaseFull();
  assert.equal((await pending).response.status, 503);
});

test("excludes each changed cohort field instead of mixing evidence", async () => {
  for (const field of [
    "calibrationEpoch",
    "burrIdentity",
    "settingUnit",
    "profile",
    "grinderSetting",
  ]) {
    const entries = cohort();
    const changed = entries[0];
    if (field === "profile") {
      changed.workflow.profile = {
        title: "espresso",
        steps: [{ pump: "flow", flow: 4 }],
      };
      changed.full.workflow.profile = changed.workflow.profile;
    } else if (field === "settingUnit") {
      changed.workflow.context.extras.grinderSettingUnit = "degrees";
      changed.full.workflow.context.extras.grinderSettingUnit = "degrees";
    } else if (field === "grinderSetting") {
      changed.workflow.context.grinderSetting = "11";
      changed.full.workflow.context.grinderSetting = "11";
    } else {
      if (field === "calibrationEpoch") {
        changed.workflow.context.extras.calibrationEpoch = "cal-2";
        changed.full.workflow.context.extras.calibrationEpoch = "cal-2";
      } else {
        changed.workflow.context.grinderBurrs = "replacement";
        changed.full.workflow.context.grinderBurrs = "replacement";
      }
    }
    const { plugin } = await load({ shots: entries });
    for (const entry of entries) await mark(plugin, entry.id, "sour");
    const { body } = await suggest(plugin);
    assert.equal(body.status, "suggestion", field);
    assert.equal(body.stage, "provisional", field);
    assert.equal(body.evidenceCount, 2, field);
    assert.ok(
      body.excluded.some((entry) => entry.shotId === changed.id),
      field,
    );
  }
});

test("missing current setting units abstain instead of guessing", async () => {
  const current = context();
  delete current.extras.grinderSettingUnit;
  const { plugin } = await load({ shots: cohort(), currentContext: current });
  for (const entry of cohort()) await mark(plugin, entry.id, "sour");
  const { body } = await suggest(plugin);
  assert.equal(body.status, "abstain");
  assert.ok(body.missingData.includes("settingUnit"));
});

test("calibrated numeric proposal abstains when the step leaves bounds", async () => {
  const { plugin } = await load({
    shots: cohort(),
    settings: { MinSetting: 9.8, MaxSetting: 90 },
  });
  for (const entry of cohort()) await mark(plugin, entry.id, "sour");
  const { body } = await suggest(plugin);
  assert.equal(body.status, "abstain");
  assert.match(body.reason, /bounds/);
});

test("recommendation rejects a historical setting-unit mismatch", async () => {
  const entries = [shot("unit-mismatch", 20_000, 20)];
  entries[0].workflow.context.extras.grinderSettingUnit = "degrees";
  const { plugin } = await load({ shots: entries });
  const marked = await plugin.handleHttpRequest({
    endpoint: "feedback",
    method: "POST",
    body: { shotId: entries[0].id, good: true },
  });
  assert.equal(marked.status, 200);
  const result = await plugin.handleHttpRequest({
    endpoint: "recommendation",
    method: "GET",
  });
  const body = JSON.parse(result.body);
  assert.equal(body.status, "abstain");
});

test("operator-confirmed timing survives reload alongside full-shot metrics", async () => {
  const entries = cohort();
  const first = await load({ shots: entries });
  for (const [index, entry] of entries.entries())
    await mark(first.plugin, entry.id, "sour", undefined, 20 + index * 2);
  const stored = first.events
    .filter((entry) => entry && entry.stored)
    .at(-1).stored;
  const second = await load({
    shots: entries,
    stored,
  });
  const { response, body } = await suggest(second.plugin);
  assert.equal(response.status, 200);
  assert.equal(body.status, "suggestion");
  assert.ok(
    body.evidence.every(
      (entry) =>
        entry.timingProvenance === "operator-confirmed pump time",
    ),
  );
});

test("a blank, absent or invalid target never becomes an implicit 30-second goal", async () => {
  for (const target of [undefined, null, "", "  ", false, 0, -1, "not a number"]) {
    const entry = shot("target", 60_000, 20);
    const { plugin } = await load({ shots: [entry], settings: { TargetTimeSec: target } });
    await mark(plugin, entry.id);
    const { body } = await suggest(plugin);
    assert.equal(body.status, "abstain", String(target));
    assert.ok(body.missingData.includes("TargetTimeSec"));
  }
});

test("pump, pouring and recording targets use distinct observed clocks", async () => {
  for (const [clock, expected] of [["pump", 20], ["pouring", 19], ["recording", 21]]) {
    const entry = shot("clocks", 60_000, 20);
    const { plugin } = await load({ shots: [entry], settings: { TargetTimeClock: clock } });
    await mark(plugin, entry.id);
    const { body } = await suggest(plugin);
    assert.equal(body.status, "suggestion", JSON.stringify(body));
    assert.equal(body.medianElapsedTimeSec, expected);
    assert.equal(body.targetTimeClock, clock);
    assert.equal(body.evidence[0].brewTimeClock, clock);
  }
});

test("missing native boundaries require an operator time on the matching clock", async () => {
  const entry = shot("partial", 60_000, 20);
  entry.full.measurements = entry.full.measurements.slice(1, -1);
  const { plugin, events } = await load({ shots: [entry] });
  await mark(plugin, entry.id);
  let result = await suggest(plugin);
  assert.equal(result.body.status, "abstain");
  assert.match(result.body.excluded[0].reason, /boundaries are incomplete/);
  const save = async (clock) => plugin.handleHttpRequest({ endpoint: "feedback", method: "POST",
    body: { shotId: entry.id, good: false, taste: "sour", brewTimeSec: 20, brewTimeClock: clock } });
  assert.equal((await save("pouring")).status, 200);
  result = await suggest(plugin);
  assert.match(result.body.excluded[0].reason, /different clock/);
  assert.equal((await save("pump")).status, 200);
  result = await suggest(plugin);
  assert.equal(result.body.status, "suggestion");
  assert.equal(result.body.evidence[0].timingProvenance, "operator-confirmed pump time");
  const stored = events.filter(event => event.stored).at(-1).stored;
  assert.equal(stored.partial.brewTimeClock, "pump");
  const reloaded = await load({ shots: [entry], stored });
  assert.equal((await suggest(reloaded.plugin)).body.status, "suggestion");
});

test("preheat and settling do not change pump-time evidence", async () => {
  const entry = shot("extra-recording", 60_000, 20);
  const start = Date.parse(entry.timestamp);
  const extra = (second, substate) => ({ machine: { timestamp: new Date(start + second * 1000).toISOString(),
    state: { state: "espresso", substate }, pressure: 0, flow: 0 } });
  entry.full.measurements.forEach(sample => {
    sample.machine.timestamp = new Date(Date.parse(sample.machine.timestamp) + 4000).toISOString();
  });
  entry.full.measurements.unshift(extra(0, "preparingForShot"));
  entry.full.measurements.push(extra(28, "idle"));
  const { plugin } = await load({ shots: [entry] });
  await mark(plugin, entry.id);
  const { body } = await suggest(plugin);
  assert.equal(body.status, "suggestion", JSON.stringify(body));
  assert.equal(body.medianElapsedTimeSec, 20);
  assert.equal(body.evidence[0].metrics.timing.recording.durationSec, 28);
});

test("manual stops require recipe completion confirmation without an invented yield tolerance", async () => {
  for (const yieldG of [10, 36, 36.1]) {
    const entry = shot("manual-stop", 60_000, 20);
    entry.full.stopReason = "appStop";
    entry.full.measurements.at(-1).scale = { timestamp: entry.full.measurements.at(-1).machine.timestamp, weight: yieldG };
    const { plugin, events } = await load({ shots: [entry] });
    await mark(plugin, entry.id);
    const withheld = await suggest(plugin);
    assert.equal(withheld.body.status, "abstain");
    assert.match(withheld.body.excluded[0].reason, /manually stopped/);
    assert.doesNotMatch(withheld.body.excluded[0].reason, /before.*yield/);
    const saved = await plugin.handleHttpRequest({ endpoint: "feedback", method: "POST",
      body: { shotId: entry.id, good: false, taste: "sour", manualStopConfirmed: true } });
    assert.equal(saved.status, 200);
    const stored = events.filter(event => event.stored).at(-1).stored;
    assert.equal(stored[entry.id].manualStopConfirmed, true);
    const reloaded = await load({ shots: [entry], stored });
    const accepted = await suggest(reloaded.plugin);
    assert.equal(accepted.body.status, "suggestion");
    assert.equal(accepted.body.evidence[0].manualStopConfirmed, true);
  }
});

test("feedback rejects invalid clocks, detached clock labels and nonboolean stop confirmation", async () => {
  const { plugin } = await load();
  for (const extra of [{ brewTimeSec: 20, brewTimeClock: "total" }, { brewTimeClock: "pump" },
    { manualStopConfirmed: "true" }]) {
    const result = await plugin.handleHttpRequest({ endpoint: "feedback", method: "POST",
      body: { shotId: "invalid-clock", good: false, ...extra } });
    assert.equal(result.status, 400);
  }
});


test("a matching operator clock cannot make unknown or flow-only controllers eligible", async () => {
  for (const steps of [[], [{ pump: "unsupported" }], [{ pump: "flow", flow: 2 }],
    [{ name: "Preinfusion", pump: "flow", flow: 2 }],
    [{ pump: "pressure", pressure: 9, limiter: { value: 2 } }]]) {
    const currentProfile = { steps };
    const entry = shot("controller", 60_000, 20);
    entry.workflow.profile = currentProfile;
    entry.full.workflow.profile = currentProfile;
    const { plugin } = await load({ shots: [entry], currentProfile });
    await mark(plugin, entry.id, "sour", undefined, 20);
    const { body } = await suggest(plugin);
    assert.equal(body.status, "abstain", JSON.stringify(steps));
    assert.match(body.reason, steps.length ? /profile control cannot support/ : /Complete current setup/);
  }
});
