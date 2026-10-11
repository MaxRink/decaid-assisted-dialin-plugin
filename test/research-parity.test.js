const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const golden = require("./research-golden.json");

function createResearchAlgorithms() {
  const context = { Math, JSON, Number, Object, Set, console };
  vm.createContext(context);
  const source = fs.readFileSync("plugin.js", "utf8");
  vm.runInContext(
    `${source}\nthis.createResearchAlgorithms = createResearchAlgorithms;`,
    context,
  );
  return context.createResearchAlgorithms();
}

const close = (actual, expected, message) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: ${actual} != ${expected}`,
  );

test("explicit manual assessments retain legacy community rule outputs without claiming probability", () => {
  for (const vector of golden.manual) {
    const result = createResearchAlgorithms().recommendManual({
      profile: vector.input.profile,
      targetTimeSec: vector.input.target_time_s,
      actualTimeSec: vector.input.actual_time_s,
      // The old community fixture used bare taste words. The product now
      // requires explicit dissatisfaction; this fixture is not firmware evidence.
      flavor: vector.input.flavor ? "too " + vector.input.flavor : undefined,
      currentDial: vector.input.current_dial,
      stepMarks: vector.input.step_marks,
      numericFinerDelta: vector.input.numeric_finer_delta,
    });
    for (const field of [
      "direction",
      "physicalTurn",
      "proposedDial",
      "requiresConfirmation",
    ]) {
      assert.equal(
        result[field] ?? null,
        vector.expected[field],
        `${vector.name}.${field}`,
      );
    }
    close(
      result.legacyScore,
      vector.expected.confidence,
      `${vector.name}.legacyScore`,
    );
    assert.equal(result.confidence, result.direction === "none" ? "none" : "heuristic");
    assert.match(result.legacyScoreProvenance, /not a probability/);
  }
});

test("GBS stateful algorithms match golden path and commit-gate vectors", () => {
  const algorithms = createResearchAlgorithms();
  for (const vector of golden.algorithms) {
    let state = algorithms.createState(vector.name);
    for (let index = 0; index < vector.calls.length; index += 1) {
      const step = algorithms.adjust(vector.name, state, vector.calls[index]);
      const expected = vector.expected[index];
      const result = step.result;
      assert.equal(
        result.phase,
        vector.name === "GbS1"
          ? expected.withinErrorWindow
            ? "within-error-window"
            : "adjust"
          : expected.phase,
        `${vector.name}[${index}].phase`,
      );
      assert.equal(
        result.candidateDdDum,
        expected.candidateDum,
        `${vector.name}[${index}].candidate`,
      );
      assert.equal(
        result.returnedDdDum,
        expected.returnedDum,
        `${vector.name}[${index}].returned`,
      );
      assert.equal(
        result.committed,
        expected.committed,
        `${vector.name}[${index}].committed`,
      );
      assert.equal(
        result.locked,
        expected.locked ?? false,
        `${vector.name}[${index}].locked`,
      );
      if (vector.name === "GbS1") {
        close(
          result.centralSec,
          expected.centralSec,
          `${vector.name}[${index}].central`,
        );
        close(
          result.correction,
          expected.correction,
          `${vector.name}[${index}].correction`,
        );
      }
      state = step.nextState;
    }
  }
});

test("inverse regression, dial-in table and DdEff boundaries match the oracle", () => {
  const algorithms = createResearchAlgorithms();
  for (const vector of golden.inverseRegression) {
    close(
      algorithms.inverseRegression(vector.points, vector.targetY),
      vector.expected,
      vector.name,
    );
  }
  for (const vector of golden.dialInRows) {
    const result = algorithms.proposedDd({
      weightMg: vector.weightMg,
      modelEnum: vector.modelEnum,
      roastDegreeIndex: vector.roastDegreeIndex,
    });
    assert.equal(
      result.proposedDd,
      vector.expectedDum,
      `dial row ${vector.modelEnum}/${vector.roastDegreeIndex}`,
    );
  }
  for (const vector of golden.signedRounding) {
    assert.equal(
      algorithms.roundAway(vector.value * 10),
      vector.expected,
      `signed round ${vector.value}`,
    );
  }
  assert.deepEqual(
    Array.from(algorithms.ddEff(golden.ddEff.initialDdDum, golden.ddEff.calls)),
    golden.ddEff.expected,
  );
  for (const vector of golden.effectiveDd) {
    const step = algorithms.effectiveDdPrediction(vector.state, vector.input);
    assert.equal(
      step.result,
      vector.expected.resultDum,
      `${vector.name}.result`,
    );
    close(
      step.nextState.residue,
      vector.expected.residueUm,
      `${vector.name}.residue`,
    );
  }
});

test("V3/V4 strict phase and DD-change boundaries match the oracle", () => {
  const algorithms = createResearchAlgorithms();
  for (const vector of golden.phaseBoundaries) {
    const step = algorithms.adjust(
      vector.algorithm,
      algorithms.createState(vector.algorithm, vector.state),
      vector.input,
    );
    assert.equal(
      step.result.phase,
      vector.expected.phase,
      `${vector.name}.phase`,
    );
    assert.equal(
      step.result.locked,
      vector.expected.locked,
      `${vector.name}.locked`,
    );
    assert.equal(
      step.result.committed,
      vector.expected.committed,
      `${vector.name}.committed`,
    );
    assert.equal(
      step.nextState.history.length,
      vector.expected.historyLength,
      `${vector.name}.history`,
    );
  }
});
