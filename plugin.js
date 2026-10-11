/* Provenance-aware shot metrics for the Decaid snapshot JSON shape.
 * Measurements are descriptive only: no extraction/channeling thresholds or
 * inferred dose/yield claims are made. */
function createBrewMetrics() {
  "use strict";
  const MAX = 20000;
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const time = (v) => {
    const n =
      v instanceof Date
        ? v.getTime()
        : typeof v === "number"
          ? v
          : Date.parse(v);
    return Number.isFinite(n) ? n : null;
  };
  function samples(shot, key) {
    const measurements = shot && shot.measurements;
    if (Array.isArray(measurements))
      return measurements.map((s) => s && s[key]).filter(Boolean);
    return [];
  }
  function ordered(raw, warnings, label) {
    const result = [];
    let previous = null;
    for (const item of raw) {
      const timestamp = time(item?.timestamp);
      if (timestamp == null) {
        warnings.push(label + " sample has invalid timestamp");
        continue;
      }
      if (previous != null && timestamp <= previous) {
        warnings.push(label + " duplicate or non-monotonic timestamp excluded");
        continue;
      }
      previous = timestamp;
      result.push({ ...item, __time: timestamp });
    }
    return result;
  }
  function distribution(values) {
    const valid = values.filter(finite);
    if (!valid.length) return { available: false, count: 0 };
    return {
      available: true,
      count: valid.length,
      min: Math.min(...valid),
      max: Math.max(...valid),
      mean: valid.reduce((a, b) => a + b / valid.length, 0),
    };
  }
  function timedMetric(list, valueKey, targetKey) {
    const values = list.filter((s) => finite(s[valueKey]));
    if (!values.length) return { available: false };
    const result = distribution(values.map((s) => s[valueKey]));
    let total = 0,
      weighted = 0;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i],
        b = list[i + 1],
        dt = b.__time - a.__time;
      if (dt <= 0 || !finite(a[valueKey]) || !finite(a[targetKey])) continue;
      weighted += Math.abs(a[valueKey] - a[targetKey]) * dt;
      total += dt;
    }
    if (total > 0) {
      result.timeWeightedMae = weighted / total;
      result.timeWeightedCoverageSec = total / 1000;
    }
    return result;
  }
  function profileSegments(list, origin) {
    const segments = [];
    for (const sample of list) {
      const frame = Number.isInteger(sample.profileFrame)
        ? sample.profileFrame
        : null;
      if (frame == null) continue;
      const last = segments[segments.length - 1];
      if (last && last.profileFrame === frame) {
        last.endElapsedSec = (sample.__time - origin) / 1000;
        last.sampleCount++;
        last.samples.push(sample);
      } else
        segments.push({
          profileFrame: frame,
          startElapsedSec: (sample.__time - origin) / 1000,
          endElapsedSec: (sample.__time - origin) / 1000,
          sampleCount: 1,
          samples: [sample],
        });
    }
    for (const segment of segments) {
      segment.pressure = timedMetric(
        segment.samples,
        "pressure",
        "targetPressure",
      );
      segment.flow = timedMetric(segment.samples, "flow", "targetFlow");
      segment.mixTemperature = timedMetric(
        segment.samples,
        "mixTemperature",
        "targetMixTemperature",
      );
      segment.groupTemperature = timedMetric(
        segment.samples,
        "groupTemperature",
        "targetGroupTemperature",
      );
      delete segment.samples;
    }
    return segments;
  }
  function scaleMetrics(list, machineStart, warnings) {
    const valid = list.filter((s) => finite(s.weight));
    if (!valid.length)
      return {
        available: false,
        sampleCount: 0,
        invalidSampleCount: list.length,
        finalMeasuredWeightG: null,
        lastPositiveWeightG: null,
        massGainG: null,
        brewFlowGPerSec: null,
        firstIncreaseElapsedSec: null,
        firstIncreaseSampleGapSec: null,
        warnings,
      };
    const first = valid[0],
      last = valid[valid.length - 1],
      positive = valid.filter((s) => s.weight > 0),
      base = first.weight;
    const endingPositive =
      list.length > 0 &&
      finite(list[list.length - 1].weight) &&
      list[list.length - 1].weight > 0;
    if (!endingPositive)
      warnings.push(
        finite(list[list.length - 1]?.weight)
          ? "final scale sample is non-positive; no final measured yield is claimed"
          : "final scale sample is invalid; no final measured yield is claimed",
      );
    const result = {
      available: true,
      sampleCount: valid.length,
      invalidSampleCount: list.length - valid.length,
      finalMeasuredWeightG: endingPositive ? last.weight : null,
      lastPositiveWeightG: positive.length
        ? positive[positive.length - 1].weight
        : null,
      massGainG: last.weight - base,
      brewFlowGPerSec: null,
      reportedWeightFlowGPerSec: distribution(
        list.map((sample) => sample.weightFlow),
      ),
      firstIncreaseElapsedSec: null,
      firstIncreaseSampleGapSec: null,
    };
    for (let i = 1; i < valid.length; i++) {
      if (valid[i].weight > base) {
        result.firstIncreaseElapsedSec =
          machineStart == null ? null : (valid[i].__time - machineStart) / 1000;
        result.firstIncreaseSampleGapSec =
          (valid[i].__time - valid[i - 1].__time) / 1000;
        break;
      }
    }
    if (valid.length > 1) {
      const dt = (last.__time - first.__time) / 1000;
      if (dt > 0) result.brewFlowGPerSec = (last.weight - first.weight) / dt;
    }
    return result;
  }
  function analyze(shot, operatorFeedback) {
    if (!shot || typeof shot !== "object" || Array.isArray(shot))
      throw new Error("shot must be an object");
    if (Array.isArray(shot.measurements) && shot.measurements.length > MAX)
      throw new Error("sample limit exceeded");
    const warnings = [];
    const machine = ordered(samples(shot, "machine"), warnings, "machine"),
      scale = ordered(samples(shot, "scale"), warnings, "scale");
    if (machine.length > MAX || scale.length > MAX)
      throw new Error("sample limit exceeded");
    const shotStart = time(shot.timestamp),
      machineStart =
        shotStart != null
          ? shotStart
          : machine.length
            ? machine[0].__time
            : null,
      machineEnd = machine.length ? machine[machine.length - 1].__time : null;
    const context = shot.recipe || shot.workflow?.context || {};
    const annotations = shot.annotations || shot.shotAnnotations || {};
    const targetDose =
        finite(context.targetDoseWeight) && context.targetDoseWeight > 0
          ? context.targetDoseWeight
          : null,
      targetYield =
        finite(context.targetYield) && context.targetYield >= 0
          ? context.targetYield
          : null,
      targetRatio =
        targetDose > 0 && targetYield != null ? targetYield / targetDose : null;
    const actualDose = finite(annotations.actualDoseWeight)
        ? annotations.actualDoseWeight
        : null,
      actualYield = finite(annotations.actualYield)
        ? annotations.actualYield
        : null;
    if (context.targetDoseWeight != null && targetDose == null)
      warnings.push("recipe dose is invalid or non-positive");
    if (context.targetYield != null && targetYield == null)
      warnings.push("recipe yield is invalid or negative");
    const analysis = {
      provenance: {
        source: "Decaid ShotSnapshot JSON",
        firmwareValidated: false,
      },
      recipeTargets: {
        doseG: targetDose,
        yieldG: targetYield,
        ratio: targetRatio,
        available: targetDose != null || targetYield != null,
      },
      annotations: {
        actualDoseG: actualDose,
        actualDoseProvenance:
          actualDose == null ? null : "saved_annotation_origin_unverified",
        actualYieldG: actualYield,
        actualYieldProvenance:
          actualYield == null ? null : "saved_annotation_origin_unverified",
        tds: finite(annotations.drinkTds) ? annotations.drinkTds : null,
        extractionYield: finite(annotations.drinkEy)
          ? annotations.drinkEy
          : null,
        enjoyment: finite(annotations.enjoyment) ? annotations.enjoyment : null,
        available: Object.keys(annotations).length > 0,
      },
      stopReason: typeof shot.stopReason === "string" ? shot.stopReason : null,
      volumeMl: Array.isArray(shot.measurements)
        ? (shot.measurements
            .map((sample) => sample?.volume)
            .filter((value) => finite(value) && value >= 0)
            .slice(-1)[0] ?? null)
        : null,
      warnings,
      elapsedSec:
        shotStart != null && machineEnd != null && machineEnd >= shotStart
          ? (machineEnd - shotStart) / 1000
          : null,
      machine: {
        sampleCount: machine.length,
        pressure: timedMetric(machine, "pressure", "targetPressure"),
        flow: timedMetric(machine, "flow", "targetFlow"),
        mixTemperature: timedMetric(
          machine,
          "mixTemperature",
          "targetMixTemperature",
        ),
        groupTemperature: timedMetric(
          machine,
          "groupTemperature",
          "targetGroupTemperature",
        ),
        profileFrameSegments: profileSegments(
          machine,
          machineStart ?? machine[0]?.__time,
        ),
        trackingDiagnostics: {
          pressure: machine.some((sample) => finite(sample.pressure)),
          flow: machine.some((sample) => finite(sample.flow)),
          mixTemperature: machine.some((sample) =>
            finite(sample.mixTemperature),
          ),
          groupTemperature: machine.some((sample) =>
            finite(sample.groupTemperature),
          ),
          calibratedThresholdsUsed: false,
        },
      },
      scale: null,
    };
    analysis.scale = scaleMetrics(scale, machineStart, warnings);
    analysis.scale.provenance =
      "Saved scale samples: grams and scale-timestamp-derived mass flow. Available samples may be partial; no machine-flow-to-weight conversion.";
    analysis.scale.ratioAgainstRecipeDose =
      analysis.scale.finalMeasuredWeightG != null && targetDose > 0
        ? analysis.scale.finalMeasuredWeightG / targetDose
        : null;
    analysis.scale.yieldDeviationFromRecipeTargetG =
      analysis.scale.finalMeasuredWeightG != null && targetYield != null
        ? analysis.scale.finalMeasuredWeightG - targetYield
        : null;
    analysis.annotations.ratio =
      actualDose > 0 && actualYield != null ? actualYield / actualDose : null;
    analysis.machine.provenance =
      "Saved machine telemetry, not beverage mass flow. Time-weighted target errors use left-sample hold over intervals with valid target data.";
    for (const s of scale) {
      delete s.__time;
    }
    for (const s of machine) {
      delete s.__time;
    }
    if (operatorFeedback && typeof operatorFeedback === "object")
      analysis.operatorFeedback = clone(operatorFeedback);
    analysis.annotations.provenance =
      "Saved annotations may contain recipe fallback values or operator input; they are not automatically measured dose/yield.";
    function validateResult(value) {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Error("metrics exceeded finite numeric bounds");
      if (value && typeof value === "object")
        Object.values(value).forEach(validateResult);
    }
    validateResult(analysis);
    return analysis;
  }
  return {
    analyze,
    maxSamples: MAX,
    provenance:
      "source-separated descriptive metrics; no automatic physical interpretation",
  };
}

/* Pure, dependency-free host replay of the normal finite GBS paths recovered
 * from HEM-HSG-HMI-S01 V01.16-24.  This file is deliberately side-effect free:
 * it does not contact a grinder, persist state, or infer physical dial sign.
 * The factory is appended to plugin.js by the integration owner. */
function createResearchAlgorithms() {
  "use strict";
  const grinderDialTools = createGrinderDialTools();
  const BUILD = "HEM-HSG-HMI-S01 V01.16-24";
  const finite = (v, n) => {
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new Error(n + " must be finite");
    return v;
  };
  const integer = (v, n) => {
    if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647)
      throw new Error(n + " must be a signed 32-bit integer");
    return v;
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const round = (v) =>
    finite(v, "value") >= 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5);
  const output = (v) => {
    const r = round(v);
    return integer(r, "result");
  };
  const checkInput = (i) => {
    [
      "actualBrewTimeMs",
      "targetBrewTimeMs",
      "estimatedDdDum",
      "setpointDdDum",
      "toleranceMs",
    ].forEach((k) => integer(i[k], k));
    if (i.actualBrewTimeMs < 0 || i.targetBrewTimeMs <= 0 || i.toleranceMs < 0)
      throw new Error("invalid brew timing");
  };
  const rows = Object.freeze({
    e64: Object.freeze({
      light: { coefficient: 3.5, offset: -20 },
      medium: { coefficient: 3.5, offset: 0 },
      dark: { coefficient: 3.5, offset: 20 },
    }),
    e65: Object.freeze({
      light: { coefficient: 4, offset: -20 },
      medium: { coefficient: 4, offset: 0 },
      dark: { coefficient: 4, offset: 20 },
    }),
    e80: Object.freeze({
      light: { coefficient: 6, offset: -20 },
      medium: { coefficient: 6, offset: 0 },
      dark: { coefficient: 6, offset: 20 },
    }),
  });
  function proposedDd({ weightMg, model, roast, modelEnum, roastDegreeIndex }) {
    const m = model || { 1: "e64", 2: "e65", 3: "e80" }[modelEnum];
    const r = roast || { 0: "light", 1: "medium", 2: "dark" }[roastDegreeIndex];
    finite(weightMg, "weightMg");
    if (weightMg < 0 || !rows[m] || !rows[m][r])
      throw new Error("unknown model or roast");
    const row = rows[m][r];
    const coordinate = Math.trunc(
      row.offset + row.coefficient * weightMg * 0.001 + 0.5,
    );
    return {
      model: m,
      roast: r,
      coefficient: row.coefficient,
      offset: row.offset,
      coordinateUnit: "unknown",
      proposedDd: coordinate,
    };
  }
  function inverseRegression(points, targetSec) {
    finite(targetSec, "targetSec");
    if (!Array.isArray(points) || !points.length || points.length > 6)
      throw new Error("one to six points required");
    const p = points.map((q) => ({
      x: finite(q.x, "point.x"),
      y: finite(q.y, "point.y"),
    }));
    const mx = p.reduce((s, q) => s + q.x, 0) / p.length;
    const md = p.reduce((s, q) => s + q.y - targetSec, 0) / p.length;
    const variance = p.reduce((s, q) => s + (q.x - mx) * (q.x - mx), 0);
    let slope = -2;
    if (p.length > 1 && variance > 0.001) {
      slope =
        p.reduce((s, q) => s + (q.x - mx) * (q.y - targetSec - md), 0) /
        variance;
      if (slope > -0.5) slope = -0.5;
    }
    return mx - md / slope;
  }
  function blend(current, prediction, currentWeight, predictionWeight) {
    finite(current, "current");
    finite(prediction, "prediction");
    const result = current + (prediction - current) * predictionWeight;
    return current * prediction > 0
      ? Math.max(
          Math.min(result, Math.max(current, prediction)),
          Math.min(current, prediction),
        )
      : current * currentWeight + prediction * predictionWeight;
  }
  function newState(algorithm, options) {
    const a = algorithm || "GbS1";
    const o = options || {};
    if (a === "GbS1")
      return {
        algorithm: a,
        history: [],
        continuousUm: finite(
          o.continuousUm == null ? 1 : o.continuousUm,
          "continuousUm",
        ),
        previousQuantizedUm:
          o.previousQuantizedUm == null
            ? null
            : finite(o.previousQuantizedUm, "previousQuantizedUm"),
        lastResultDum:
          o.lastResultDum == null
            ? null
            : integer(o.lastResultDum, "lastResultDum"),
      };
    if (a === "GbS2")
      return {
        algorithm: a,
        history: Array.isArray(o.history) ? clone(o.history) : [],
        lastResultDum:
          o.lastResultDum == null
            ? null
            : integer(o.lastResultDum, "lastResultDum"),
      };
    if (a === "GbS3" || a === "GbS4")
      return {
        algorithm: a,
        history: Array.isArray(o.history) ? clone(o.history) : [],
        farFactor: o.farFactor == null ? 0 : finite(o.farFactor, "farFactor"),
        midFactor: o.midFactor == null ? 0.5 : finite(o.midFactor, "midFactor"),
        nearFactor:
          o.nearFactor == null ? 1 : finite(o.nearFactor, "nearFactor"),
        filterRetention:
          o.filterRetention == null
            ? 0.5
            : finite(o.filterRetention, "filterRetention"),
        holdCyclesSetting:
          o.holdCyclesSetting == null
            ? 2
            : integer(o.holdCyclesSetting, "holdCyclesSetting"),
        holdCyclesRemaining:
          o.holdCyclesRemaining == null
            ? 2
            : integer(o.holdCyclesRemaining, "holdCyclesRemaining"),
        lastTargetDum:
          o.lastTargetDum == null
            ? null
            : integer(o.lastTargetDum, "lastTargetDum"),
        lastAdjustmentDum:
          o.lastAdjustmentDum == null
            ? null
            : integer(o.lastAdjustmentDum, "lastAdjustmentDum"),
        filteredDdTimesBrew:
          o.filteredDdTimesBrew == null
            ? null
            : finite(o.filteredDdTimesBrew, "filteredDdTimesBrew"),
        nearThresholdSec:
          o.nearThresholdSec == null
            ? 2
            : finite(o.nearThresholdSec, "nearThresholdSec"),
        keepMediumIntervalWidth: !!o.keepMediumIntervalWidth,
      };
    if (a === "DdEff")
      return {
        algorithm: a,
        initialDdDum: integer(
          o.initialDdDum == null ? 0 : o.initialDdDum,
          "initialDdDum",
        ),
        calls: 0,
      };
    throw new Error("unknown algorithm");
  }
  function v1(s, i) {
    const n = clone(s);
    const actual = i.actualBrewTimeMs * 0.001,
      target = i.targetBrewTimeMs * 0.001;
    n.history = (n.history || [])
      .map((q) => ({
        value: finite(q.value, "history.value"),
        age: integer(q.age, "history.age"),
      }))
      .filter((q) => q.age < 3)
      .map((q) => ({ value: q.value, age: q.age + 1 }));
    if (!n.history.length)
      n.history = [0, 1, 2, 3].map((age) => ({ value: actual, age }));
    else n.history.push({ value: actual, age: 0 });
    n.history.sort((a, b) => a.value - b.value);
    const vals = n.history.map((q) => q.value);
    const central =
      (vals[Math.floor((vals.length - 2) / 2)] +
        vals[Math.floor((vals.length - 2) / 2) + 1]) /
      2;
    let correction = 0,
      candidate =
        n.previousQuantizedUm == null
          ? round(n.continuousUm / 0.2) * 0.2
          : n.previousQuantizedUm;
    if (Math.abs(central - target) > 0.5) {
      const d = Math.pow(central - 5, 3);
      if (d === 0) throw new Error("V1 correction is singular");
      correction = Math.max(
        -5,
        Math.min(5, -(32768 / d + 0.2) * (target - central)),
      );
      n.continuousUm = Math.max(1, n.continuousUm + correction);
      if (
        n.previousQuantizedUm == null ||
        n.continuousUm < n.previousQuantizedUm - 0.16 ||
        n.continuousUm > n.previousQuantizedUm + 0.16
      )
        n.previousQuantizedUm = round(n.continuousUm / 0.2) * 0.2;
      candidate = n.previousQuantizedUm;
    }
    const candidateDum = output(candidate * 10);
    if (n.lastResultDum == null) n.lastResultDum = i.estimatedDdDum;
    const committed =
      Math.abs(i.actualBrewTimeMs - i.targetBrewTimeMs) >=
      Math.abs(i.toleranceMs);
    if (committed) n.lastResultDum = candidateDum;
    return {
      result: {
        algorithm: "GbS1",
        phase:
          Math.abs(central - target) <= 0.5 ? "within-error-window" : "adjust",
        candidateDdDum: candidateDum,
        returnedDdDum: n.lastResultDum,
        committed,
        locked: false,
        centralSec: central,
        correction,
      },
      nextState: n,
    };
  }
  function v2(s, i) {
    const n = clone(s);
    n.history = (n.history || []).map((q) => ({
      x: finite(q.x, "history.x"),
      y: finite(q.y, "history.y"),
    }));
    n.history.push({ x: i.setpointDdDum * 0.1, y: i.actualBrewTimeMs * 0.001 });
    if (n.history.length > 6) n.history = n.history.slice(-6);
    const pred = inverseRegression(n.history, i.targetBrewTimeMs * 0.001),
      cand = output(blend(i.setpointDdDum * 0.1, pred, 0.1, 0.9) * 10);
    if (n.lastResultDum == null) n.lastResultDum = i.estimatedDdDum;
    const committed =
      Math.abs(i.actualBrewTimeMs - i.targetBrewTimeMs) >=
      Math.abs(i.toleranceMs);
    if (committed) n.lastResultDum = cand;
    return {
      result: {
        algorithm: "GbS2",
        phase: "regression",
        candidateDdDum: cand,
        returnedDdDum: n.lastResultDum,
        committed,
        locked: false,
        predictionUm: pred,
      },
      nextState: n,
    };
  }
  function family(s, i, a) {
    const n = clone(s),
      error = Math.abs(i.actualBrewTimeMs - i.targetBrewTimeMs) * 0.001;
    if (
      n.lastTargetDum != null &&
      n.lastAdjustmentDum != null &&
      Math.abs(i.estimatedDdDum - n.lastTargetDum) > 500
    ) {
      n.lastTargetDum = i.estimatedDdDum;
      return {
        result: {
          algorithm: a,
          phase: "cancel",
          candidateDdDum: n.lastAdjustmentDum,
          returnedDdDum: n.lastAdjustmentDum,
          committed: false,
          locked: true,
        },
        nextState: n,
      };
    }
    let phase;
    if (a === "GbS4" && error < 3 && n.history.length > 2) {
      n.lastTargetDum = i.estimatedDdDum;
      if (n.lastAdjustmentDum == null)
        throw new Error("V4 near lock has no previous adjustment");
      return {
        result: {
          algorithm: a,
          phase: "near",
          candidateDdDum: n.lastAdjustmentDum,
          returnedDdDum: n.lastAdjustmentDum,
          committed: false,
          locked: true,
        },
        nextState: n,
      };
    }
    const near =
      a === "GbS3"
        ? error <= n.nearThresholdSec && n.history.length > 2
        : false;
    if (near) {
      phase = "near";
      n.holdCyclesRemaining = n.holdCyclesSetting;
    } else if (n.holdCyclesRemaining > 0) {
      n.holdCyclesRemaining--;
      phase = "near";
    } else if (
      error <=
      (a === "GbS3"
        ? n.keepMediumIntervalWidth
          ? n.nearThresholdSec + 3
          : 5
        : 5)
    ) {
      phase = "mid";
    } else {
      phase = "far";
      n.history = [];
    }
    if (phase !== "far") {
      n.history.push({
        x: i.setpointDdDum * 0.1,
        y: i.actualBrewTimeMs * 0.001,
      });
      if (n.history.length > 6) n.history = n.history.slice(-6);
    }
    const actual = i.actualBrewTimeMs * 0.001,
      target = i.targetBrewTimeMs * 0.001;
    const effective = i.estimatedDdDum * 0.1 * actual;
    n.filteredDdTimesBrew =
      n.filteredDdTimesBrew == null
        ? effective
        : effective + n.filterRetention * (n.filteredDdTimesBrew - effective);
    const hyper = n.filteredDdTimesBrew / target;
    const pred =
      n.history.length < 2 ? hyper : inverseRegression(n.history, target);
    const linear =
      n.history.length < 2
        ? hyper
        : blend(i.setpointDdDum * 0.1, pred, 0.4, 0.6);
    const factor =
      phase === "far"
        ? n.farFactor
        : phase === "mid"
          ? n.midFactor
          : n.nearFactor;
    const cand = output((hyper + (linear - hyper) * factor) * 10);
    if (n.lastTargetDum == null) n.lastTargetDum = i.estimatedDdDum;
    if (n.lastAdjustmentDum == null) n.lastAdjustmentDum = i.estimatedDdDum;
    const committed =
      Math.abs(i.actualBrewTimeMs - i.targetBrewTimeMs) >=
      Math.abs(i.toleranceMs);
    if (committed) {
      n.lastTargetDum = i.estimatedDdDum;
      n.lastAdjustmentDum = cand;
    }
    return {
      result: {
        algorithm: a,
        phase,
        candidateDdDum: cand,
        returnedDdDum: n.lastAdjustmentDum,
        committed,
        locked: false,
        predictionUm: pred,
      },
      nextState: n,
    };
  }
  function validateState(s, a) {
    if (!s || s.algorithm !== a || typeof s !== "object")
      throw new Error("state algorithm mismatch");
    if (a === "GbS1") {
      if (!Array.isArray(s.history) || s.history.length > 4)
        throw new Error("invalid V1 history");
      s.history.forEach((q) => {
        finite(q.value, "history.value");
        integer(q.age, "history.age");
        if (q.age < 0 || q.age > 3) throw new Error("invalid V1 age");
      });
      finite(s.continuousUm, "continuousUm");
      if (s.previousQuantizedUm != null)
        finite(s.previousQuantizedUm, "previousQuantizedUm");
      if (s.lastResultDum != null) integer(s.lastResultDum, "lastResultDum");
    } else if (a === "GbS2") {
      if (!Array.isArray(s.history) || s.history.length > 6)
        throw new Error("invalid V2 history");
      s.history.forEach((q) => {
        finite(q.x, "history.x");
        finite(q.y, "history.y");
      });
      if (s.lastResultDum != null) integer(s.lastResultDum, "lastResultDum");
    } else if (a === "GbS3" || a === "GbS4") {
      if (!Array.isArray(s.history) || s.history.length > 6)
        throw new Error("invalid history");
      s.history.forEach((q) => {
        finite(q.x, "history.x");
        finite(q.y, "history.y");
      });
      ["farFactor", "midFactor", "nearFactor", "filterRetention"].forEach(
        (k) => {
          finite(s[k], k);
          if (s[k] < 0 || s[k] > 1)
            throw new Error(k + " must be between 0 and 1");
        },
      );
      ["holdCyclesSetting", "holdCyclesRemaining"].forEach((k) => {
        integer(s[k], k);
        if (s[k] > 64) throw new Error(k + " is out of range");
        if (s[k] < 0) throw new Error(k + " must be non-negative");
      });
      if (s.filteredDdTimesBrew != null)
        finite(s.filteredDdTimesBrew, "filteredDdTimesBrew");
      if (s.lastTargetDum != null) integer(s.lastTargetDum, "lastTargetDum");
      if (s.lastAdjustmentDum != null)
        integer(s.lastAdjustmentDum, "lastAdjustmentDum");
      if (s.nearThresholdSec != null) {
        finite(s.nearThresholdSec, "nearThresholdSec");
        if (s.nearThresholdSec < 0)
          throw new Error("nearThresholdSec must be non-negative");
      }
    } else if (a === "DdEff") {
      integer(s.initialDdDum, "initialDdDum");
      integer(s.calls, "calls");
      if (s.calls < 0 || s.calls > 64)
        throw new Error("calls must be between 0 and 64");
    }
  }
  function adjust(algorithm, state, input) {
    const i = Object.assign({}, input);
    checkInput(i);
    validateState(state, algorithm);
    let result;
    if (algorithm === "GbS1") result = v1(state, i);
    else if (algorithm === "GbS2") result = v2(state, i);
    else if (algorithm === "GbS3" || algorithm === "GbS4")
      result = family(state, i, algorithm);
    else if (algorithm === "DdEff") {
      const n = clone(state);
      const offsets = [0, -200, 200];
      const value = n.initialDdDum + offsets[Math.floor(n.calls / 6) % 3];
      n.calls++;
      result = {
        result: {
          algorithm,
          phase: "measurement",
          candidateDdDum: value,
          returnedDdDum: value,
          committed: false,
          locked: false,
          sequence: value,
        },
        nextState: n,
      };
    } else throw new Error("unknown algorithm");
    integer(result.result.candidateDdDum, "candidateDdDum");
    integer(result.result.returnedDdDum, "returnedDdDum");
    validateState(result.nextState, algorithm);
    result.state = result.nextState;
    return result;
  }
  function effectiveDdPrediction(state, input) {
    const {
      grindDdDum,
      grindDurationMs,
      previousEffective,
      effectiveBaseline,
    } = input || {};
    integer(grindDdDum, "grindDdDum");
    integer(grindDurationMs, "grindDurationMs");
    if (grindDurationMs < 0)
      throw new Error("grindDurationMs must not be negative");
    if (
      state != null &&
      (typeof state !== "object" ||
        (state.residue != null && !Number.isFinite(state.residue)))
    )
      throw new Error("invalid effective DD state");
    const n = state ? clone(state) : { residue: null };
    const x = grindDdDum * 0.1,
      t = grindDurationMs * 0.001,
      k = Math.log(2) / 1.85;
    if (n.residue == null) {
      n.residue = x;
      return { result: round(x * 10), nextState: n };
    }
    const baseline =
      effectiveBaseline == null ? previousEffective : effectiveBaseline;
    if (!Number.isFinite(baseline))
      throw new Error("previousEffective is required after initialization");
    const a = 1 - Math.exp(-k * t),
      b = t === 0 ? 0 : 1 - a / (k * t);
    n.residue = n.residue + (x - n.residue) * a;
    const effective = baseline + (x - baseline) * b;
    return { result: round(effective * 10), nextState: n };
  }
  function grindVelocity(x) {
    return 1 + 0.0022017 * finite(x, "ddUm");
  }
  function adjustGrindTime({ mode, recipeDdUm, targetDdDum, recipeTimeMs }) {
    integer(recipeDdUm, "recipeDdUm");
    integer(targetDdDum, "targetDdDum");
    integer(recipeTimeMs, "recipeTimeMs");
    if (mode !== 3) return { adjustedTimeMs: null, optional: false };
    if (recipeDdUm < 0 || targetDdDum <= 0 || recipeTimeMs < 0)
      throw new Error("invalid grind-time input");
    return {
      adjustedTimeMs: round(
        (grindVelocity(recipeDdUm) / grindVelocity(targetDdDum * 0.1)) *
          recipeTimeMs,
      ),
      optional: true,
    };
  }
  function recommendManual(input) {
    const p = input || {},
      profiles = {
        df54: { finer: "counterclockwise", range: null, motor: true },
        df64_gen1: { finer: "clockwise", range: [0, 90], motor: true },
        df64_gen2: { finer: "clockwise", range: [0, 90], motor: true },
      };
    const profile = String(p.profile || "df54").toLowerCase(),
      selected = profiles[profile];
    if (!selected) throw new Error("unknown grinder profile");
    const target = finite(p.targetTimeSec, "targetTimeSec"),
      actual = finite(p.actualTimeSec, "actualTimeSec"),
      tol = finite(p.toleranceSec == null ? 1 : p.toleranceSec, "toleranceSec");
    if (target <= 0 || actual <= 0 || tol < 0)
      throw new Error("invalid shot time");
    const finer = p.finerDirection || selected.finer;
    if (finer !== "clockwise" && finer !== "counterclockwise")
      throw new Error("invalid finerDirection");
    const current =
      p.currentDial == null ? null : finite(p.currentDial, "currentDial");
    if (
      current != null &&
      selected.range &&
      (current < selected.range[0] || current > selected.range[1])
    )
      throw new Error("currentDial is outside selected range");
    const step = p.stepMarks == null ? null : finite(p.stepMarks, "stepMarks");
    if (step != null && step <= 0)
      throw new Error("stepMarks must be positive");
    if (
      p.numericFinerDelta != null &&
      p.numericFinerDelta !== -1 &&
      p.numericFinerDelta !== 1
    )
      throw new Error("numericFinerDelta must be -1 or 1");
    if (p.doseG != null && finite(p.doseG, "doseG") <= 0)
      throw new Error("doseG must be positive");
    if (p.yieldG != null && finite(p.yieldG, "yieldG") < 0)
      throw new Error("yieldG must not be negative");
    const flavor = String(p.flavor || "").toLowerCase(),
      dirs = [],
      reasons = [];
    if (actual < target - tol) {
      dirs.push("finer");
      reasons.push("brew time is below target");
    } else if (actual > target + tol) {
      dirs.push("coarser");
      reasons.push("brew time is above target");
    }
    if (/acidic|acid|sour|sharp|under.?extract/.test(flavor)) {
      dirs.push("finer");
      reasons.push("sensory input suggests under-extraction");
    }
    if (/bitter|dry|harsh|astringent|over.?extract/.test(flavor)) {
      dirs.push("coarser");
      reasons.push("sensory input suggests over-extraction");
    }
    const unique = [...new Set(dirs)],
      direction = unique.length === 1 ? unique[0] : "none";
    let confidence =
      unique.length === 1
        ? Math.min(0.9, 0.55 + 0.15 * (reasons.length - 1))
        : 0;
    if (unique.length > 1)
      reasons.push(
        "time and sensory signals conflict; confirm before changing grind",
      );
    if (!unique.length)
      reasons.push(
        "no signal outside the time tolerance or recognized sensory vocabulary",
      );
    const physicalTurn =
      direction === "finer"
        ? finer
        : direction === "coarser"
          ? finer === "clockwise"
            ? "counterclockwise"
            : "clockwise"
          : null;
    let proposed = null;
    if (
      direction !== "none" &&
      current != null &&
      step != null &&
      p.numericFinerDelta != null
    ) {
      let delta = p.numericFinerDelta * step;
      if (direction === "coarser") delta = -delta;
      const candidate = current + delta;
      if (
        !selected.range ||
        (candidate >= selected.range[0] && candidate <= selected.range[1])
      )
        proposed = candidate;
      else
        reasons.push(
          "numeric proposal would leave the reference range; verify the physical dial",
        );
    }
    return {
      profile,
      direction,
      physicalTurn,
      confidence,
      reasons,
      suggestedStepMarks: step,
      currentDial: current,
      proposedDial: proposed,
      requiresConfirmation: true,
      safetyNotes: [
        "recommendation only; this tool never contacts or moves a grinder",
        "use a small calibrated step and re-measure the next shot",
        "verify true zero, burr set, alignment, and the sign of the physical dial on this unit",
      ].concat(
        selected.motor
          ? ["follow the manufacturer's motor-running adjustment guidance"]
          : [],
      ),
    };
  }
  const dialIn = (model, roast, weightMg) =>
    proposedDd({ model, roast, weightMg });
  const ddEff = (initialDdDum, calls) => {
    const state = newState("DdEff", { initialDdDum });
    const values = [];
    const count = calls == null ? 18 : integer(calls, "calls");
    if (count > 64) throw new Error("calls must be between 0 and 64");
    for (let n = 0; n < count; n++) {
      const step = adjust("DdEff", state, {
        actualBrewTimeMs: 1,
        targetBrewTimeMs: 1,
        estimatedDdDum: initialDdDum,
        setpointDdDum: initialDdDum,
        toleranceMs: 0,
      });
      values.push(step.result.returnedDdDum);
      state.calls = step.nextState.calls;
    }
    return values;
  };
  const effectiveDd = (state, input) => effectiveDdPrediction(state, input);
  const grindTime = (input) => adjustGrindTime(input);
  const manual = (input) => recommendManual(input);
  return {
    firmwareBuild: BUILD,
    rows,
    roundAway: round,
    createState: newState,
    adjust,
    inverseRegression,
    proposedDd,
    dialIn,
    ddEff,
    effectiveDdPrediction,
    effectiveDd,
    grindVelocity,
    adjustGrindTime,
    grindTime,
    recommendManual,
    manual,
    normalizeGrinderSetting: grinderDialTools.normalize,
    toGrinderDial: grinderDialTools.toGrinderDial,
    grinderDialProfiles: grinderDialTools.profiles,
    profileForGrinder: grinderDialTools.profileFor,
    clicksFromTurns: grinderDialTools.clicksFromTurns,
    constants: {
      sampleLimit: 6,
      outputScale: 10,
      v1Quantum: 0.2,
      v1HysteresisBand: 0.16,
    },
  };
}
/*
 * A GBS dD value is a research coordinate in 0.1 micrometres.  Grinder
 * displays are different coordinates: E64 WS exposes micrometres, while a
 * DF64 collar exposes marks whose mechanical pitch is not published.  Keep
 * the conversion explicit so a display number is never mistaken for dD.
 */
function createGrinderDialTools() {
  const profiles = {
    e64ws: {
      model: "E64 WS",
      visibleUnit: "micrometres",
      algorithmScale: 10,
      finerNumericDelta: -1,
      provenance: "E64 WS native micrometre coordinate; verify firmware generation",
    },
    df64: {
      model: "DF64",
      visibleUnit: "marks",
      displayRange: [0, 90],
      zeroReference: "burr touch",
      finerNumericDelta: null,
      provenance: "DF64 collar marks; dial-to-gap conversion requires owner calibration",
    },
    df64gen1: {
      model: "DF64 Gen 1",
      visibleUnit: "marks",
      displayRange: [0, 90],
      zeroReference: "burr touch",
      finerNumericDelta: null,
      provenance: "DF64 Gen 1 collar marks; dial-to-gap conversion requires owner calibration",
    },
    df64gen2: {
      model: "DF64 Gen 2",
      visibleUnit: "marks",
      displayRange: [0, 90],
      zeroReference: "burr touch",
      finerNumericDelta: null,
      provenance: "DF64 Gen 2 collar marks; dial-to-gap conversion requires owner calibration",
    },
    df54: {
      model: "DF54",
      visibleUnit: "marks",
      finerNumericDelta: null,
      provenance: "DF54 dial marks; dial-to-gap conversion requires owner calibration",
    },
    encoreesp: {
      model: "Baratza Encore ESP",
      visibleUnit: "marks",
      displayRange: [1, 40],
      visibleStep: 1,
      finerNumericDelta: null,
      provenance: "Encore ESP stepped dial; no universal marks-to-micron conversion",
    },
    nichezero: {
      model: "Niche Zero",
      visibleUnit: "dial marks",
      zeroReference: "burr touch",
      finerNumericDelta: null,
      provenance: "Niche Zero calibrated dial; burr changes require recalibration",
    },
    sculptor064s: {
      model: "Timemore Sculptor 064S",
      visibleUnit: "dial marks",
      finerNumericDelta: null,
      provenance: "Sculptor dial marks; burr variant and RPM remain calibration context",
    },
    sculptor078s: {
      model: "Timemore Sculptor 078S",
      visibleUnit: "dial marks",
      finerNumericDelta: null,
      provenance: "Sculptor dial marks; burr variant and RPM remain calibration context",
    },
    lagom01: {
      model: "LAGOM 01",
      visibleUnit: "micro-ticks",
      finerNumericDelta: null,
      visibleStep: 1,
      mechanicalStepMicrometres: 7.5,
      provenance: "LAGOM 01 manufacturer burr-gap movement per micro-tick; absolute zero still matters",
    },
    xpro: {
      model: "1Zpresso X-Pro",
      visibleUnit: "clicks",
      finerNumericDelta: null,
      visibleStep: 1,
      clicksPerRotation: 60,
      mechanicalStepMicrometres: 12.5,
      provenance: "X-Pro manufacturer burr movement per click; not a particle-size conversion",
    },
    jmax: {
      model: "1Zpresso J-Max",
      visibleUnit: "clicks",
      finerNumericDelta: null,
      visibleStep: 1,
      clicksPerRotation: 90,
      mechanicalStepMicrometres: 8.8,
      provenance: "J-Max manufacturer burr movement per click; not a particle-size conversion",
    },
    kseries: {
      model: "1Zpresso K series",
      visibleUnit: "clicks",
      finerNumericDelta: null,
      visibleStep: 1,
      clicksPerRotation: 90,
      mechanicalStepMicrometres: 22,
      provenance: "K-series manufacturer burr movement per click; not a particle-size conversion",
    },
    p64: {
      model: "LAGOM P64",
      visibleUnit: "dial marks",
      finerNumericDelta: null,
      provenance: "P64 dial coordinate; zero calibration is required after burr replacement",
    },
    fellowode: {
      model: "Fellow Ode",
      visibleUnit: "dial marks",
      finerNumericDelta: null,
      provenance: "Ode dial coordinate; burr-specific comparisons do not convert to DF64 marks",
    },
    e65s: {
      model: "E65S",
      visibleUnit: "unknown",
      finerNumericDelta: null,
      provenance: "E65S grinder coordinate; reviewed sources do not establish a numeric physical unit",
    },
    e80: {
      model: "E80",
      visibleUnit: "unknown",
      finerNumericDelta: null,
      provenance: "E80 grinder coordinate; reviewed sources do not establish a numeric physical unit",
    },
    e65sgbw: {
      model: "E65S GbW",
      visibleUnit: "micrometres (DDD readout)",
      algorithmScale: 10,
      finerNumericDelta: null,
      provenance: "E65S GbW verified DDD readout; mechanical gap and particle size remain different measurements",
    },
    e80sgbw: {
      model: "E80S GbW",
      visibleUnit: "micrometres (DDD readout)",
      algorithmScale: 10,
      finerNumericDelta: null,
      provenance: "E80S GbW verified DDD readout; mechanical gap and particle size remain different measurements",
    },
    odegen2: {
      model: "Fellow Ode Gen 2",
      visibleUnit: "dial positions",
      finerNumericDelta: null,
      provenance: "Ode Gen 2 dial positions; brewed-coffee grinder and no espresso dD conversion claimed",
    },
  };
  const aliases = {
    e64: "e64ws", "e64 ws": "e64ws", "64ws": "e64ws", "mahlkonig e64 ws": "e64ws",
    "df64 gen1": "df64gen1", "df64 gen 1": "df64gen1",
    "df64 gen2": "df64gen2", "df64 gen 2": "df64gen2",
    "encore esp": "encoreesp", "baratza encore esp": "encoreesp",
    "niche zero": "nichezero", "sculptor 064s": "sculptor064s",
    "sculptor 078s": "sculptor078s", "timemore sculptor 064s": "sculptor064s",
    "timemore sculptor 078s": "sculptor078s", "lagom 01": "lagom01",
    "1zpresso x pro": "xpro", "1zpresso x-pro": "xpro",
    "1zpresso j max": "jmax", "1zpresso j-max": "jmax", "1zpresso k": "kseries",
    "lagom p64": "p64", "fellow ode brew grinder": "fellowode", "fellow ode": "fellowode",
    "mahlkonig e65s": "e65s", "mahlkonig e80": "e80",
    "e65s gbw": "e65sgbw", "mahlkonig e65s gbw": "e65sgbw",
    "e80s gbw": "e80sgbw", "mahlkonig e80s gbw": "e80sgbw",
    "fellow ode gen 2": "odegen2", "ode gen 2": "odegen2",
    "1zpresso k series": "kseries",
  };
  const key = (value) => String(value || "").trim().toLocaleLowerCase()
    .replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ");
  const profileFor = (model) => profiles[aliases[key(model)] || key(model).replace(/[^a-z0-9]/g, "")] || null;
  const finite = (value, name) => {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`${name} must be finite`);
    return value;
  };
  const unitIsDd = (unit) => ["dd", "d d", "deci-micrometre", "deci-micrometres", "deci-micron"].includes(key(unit));
  const unitIsMicrometres = (unit) => ["um", "µm", "micron", "microns", "micrometre", "micrometres"].includes(key(unit)) || /^(?:um|µm|micrometre|micrometres)\b/.test(key(unit));
  function anchors(calibration, profile, input) {
    if (!calibration || typeof calibration !== "object" || Array.isArray(calibration)) return null;
    if (typeof calibration.model !== "string" || !calibration.burrIdentity || !calibration.calibrationEpoch)
      throw new Error("calibration.model, burrIdentity and calibrationEpoch are required");
    if (!input.burrIdentity || !input.calibrationEpoch)
      throw new Error("grinder burrIdentity and calibrationEpoch are required for calibrated conversion");
    if (calibration.unit != null && key(calibration.unit) !== key(profile.visibleUnit))
      throw new Error("calibration unit does not match grinder visible coordinate");
    if (profileFor(calibration.model)?.model !== profile.model)
      throw new Error("calibration model does not match grinder model");
    if (input.burrIdentity != null && calibration.burrIdentity !== input.burrIdentity)
      throw new Error("calibration burr identity does not match grinder");
    if (input.calibrationEpoch != null && calibration.calibrationEpoch !== input.calibrationEpoch)
      throw new Error("calibration epoch does not match grinder");
    const a = finite(calibration.dialA, "calibration.dialA");
    const b = finite(calibration.dialB, "calibration.dialB");
    const da = finite(calibration.ddDumA, "calibration.ddDumA");
    const db = finite(calibration.ddDumB, "calibration.ddDumB");
    if (a === b || da === db) throw new Error("calibration anchors must be distinct");
    const dialMin = finite(calibration.dialMin, "calibration.dialMin");
    const dialMax = finite(calibration.dialMax, "calibration.dialMax");
    if (!(dialMin < dialMax) || a < dialMin || a > dialMax || b < dialMin || b > dialMax)
      throw new Error("calibration interpolation bounds are invalid");
    const finer = calibration.finerDialDelta;
    if (finer != null && finer !== 1 && finer !== -1)
      throw new Error("calibration.finerDialDelta must be 1 or -1");
    const slope = (db - da) / (b - a);
    if (!Number.isFinite(slope) || slope === 0) throw new Error("calibration slope must be finite and non-zero");
    return { a, b, da, db, dialMin, dialMax, slope, finerDialDelta: finer ?? null };
  }
  function boundedDd(value) {
    if (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value)) || Math.round(value) < -2147483648 || Math.round(value) > 2147483647)
      throw new Error("dD result is outside the supported integer range");
    return Math.round(value);
  }
  function checkCalibrationRange(point, value) {
    if (value < point.dialMin || value > point.dialMax)
      throw new Error("value is outside owner calibration bounds");
    if (value < Math.min(point.a, point.b) || value > Math.max(point.a, point.b))
      throw new Error("value is outside owner calibration interpolation bounds");
  }
  function normalize(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("grinder setting object is required");
    const profile = profileFor(input.model);
    if (!profile) return { status: "unsupported", model: input.model ?? null, algorithm: null, visible: null, warnings: ["known grinder profile is required"] };
    const value = finite(input.value, "value");
    const unit = key(input.unit || profile.visibleUnit);
    if (unitIsDd(unit)) return { status: "normalized", model: profile.model, visible: { value, unit: "deci-micrometre" }, algorithm: { ddDum: boundedDd(value), unit: "deci-micrometre" }, profile, conversion: { kind: "already-algorithm-coordinate", provenance: "caller supplied dD; no physical dial interpretation" }, warnings: [] };
    const acceptedUnit = unit === key(profile.visibleUnit) || (profile.algorithmScale && unitIsMicrometres(unit));
    if (!acceptedUnit) throw new Error(`unit does not match ${profile.model} visible coordinate`);
    if (profile.visibleStep && !Number.isInteger(value))
      throw new Error(`${profile.model} setting must be a whole step`);
    if (profile.algorithmScale && (unit === key(profile.visibleUnit) || unitIsMicrometres(unit)))
      return { status: "normalized", model: profile.model, visible: { value, unit: profile.visibleUnit }, algorithm: { ddDum: boundedDd(value * profile.algorithmScale), unit: "deci-micrometre" }, profile, conversion: { kind: "native-scale", scale: profile.algorithmScale, provenance: profile.provenance }, warnings: [] };
    const point = anchors(input.calibration, profile, input);
    if (!point) return { status: "calibration-required", model: profile.model, visible: { value, unit: profile.visibleUnit }, algorithm: null, profile, conversion: { kind: "visible-only", provenance: profile.provenance }, warnings: ["supply two owner calibration anchors before converting this dial to dD"] };
    checkCalibrationRange(point, value);
    const ddDum = boundedDd(point.da + (value - point.a) * point.slope);
    return { status: "normalized", model: profile.model, visible: { value, unit: profile.visibleUnit }, algorithm: { ddDum, unit: "deci-micrometre" }, profile, conversion: { kind: "owner-affine-calibration", anchors: { model: profile.model, burrIdentity: input.calibration.burrIdentity, calibrationEpoch: input.calibration.calibrationEpoch, dialMin: point.dialMin, dialMax: point.dialMax, dialA: point.a, ddDumA: point.da, dialB: point.b, ddDumB: point.db }, provenance: "two owner-supplied calibration anchors" }, warnings: [] };
  }
  function toGrinderDial(input = {}) {
    const profile = profileFor(input.model);
    if (!profile) return { status: "unsupported", model: input.model ?? null, visible: null, warnings: ["known grinder profile is required"] };
    const ddDum = finite(input.ddDum, "ddDum");
    const bounded = boundedDd(ddDum);
    if (profile.algorithmScale)
      return { status: "normalized", model: profile.model, visible: { value: bounded / profile.algorithmScale, unit: profile.visibleUnit }, algorithm: { ddDum: bounded, unit: "deci-micrometre" }, conversion: { kind: "native-scale", scale: profile.algorithmScale, provenance: profile.provenance }, warnings: [] };
    const point = anchors(input.calibration, profile, input);
    if (!point) return { status: "calibration-required", model: profile.model, visible: null, algorithm: { ddDum: bounded, unit: "deci-micrometre" }, warnings: ["supply two owner calibration anchors before converting dD to this dial"] };
    const value = point.a + (bounded - point.da) / point.slope;
    checkCalibrationRange(point, value);
    const achievable = profile.visibleStep == null || Number.isInteger(value / profile.visibleStep);
    return { status: "normalized", model: profile.model, visible: { value, unit: profile.visibleUnit }, achievable, algorithm: { ddDum: bounded, unit: "deci-micrometre" }, conversion: { kind: "owner-affine-calibration", anchors: { model: profile.model, burrIdentity: input.calibration.burrIdentity, calibrationEpoch: input.calibration.calibrationEpoch, dialMin: point.dialMin, dialMax: point.dialMax, dialA: point.a, ddDumA: point.da, dialB: point.b, ddDumB: point.db }, provenance: "two owner-supplied calibration anchors" }, warnings: achievable ? [] : ["inverse setting falls between physical steps; choose a neighboring whole step"] };
  }
  function clicksFromTurns(input = {}) {
    const profile = profileFor(input.model);
    if (!profile || !profile.clicksPerRotation) throw new Error("model does not have a reviewed clicks-per-rotation scale");
    const turns = finite(input.turns, "turns"), clicks = finite(input.clicks, "clicks");
    if (!Number.isInteger(turns) || turns < 0 || !Number.isInteger(clicks) || clicks < 0 || clicks >= profile.clicksPerRotation)
      throw new Error("turns and remainder clicks must be non-negative whole counts within one rotation");
    return boundedDd(turns * profile.clicksPerRotation + clicks);
  }
  return { profiles, profileFor, normalize, toGrinderDial, clicksFromTurns };
}
/* GENERATED REFERENCE CATALOG START */
function createReferenceCatalog() {
  "use strict";
  const catalog = {"grinderDials":{"models":[{"control":"screen","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","id":"e64ws","image":{"caption":"E64 WS front product view; electronic adjustment/display is part of the unit","owner":"Mahlkönig","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://www.mahlkoenig.com/products/e64-ws-espresso-home-grinder","url":"https://www.mahlkoenig.us/cdn/shop/files/E64-WS-Black-square_700x700.webp?v=1763414639"},"markings":"Electronic disc-distance value; no universal range verified","model":"E64 WS","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/e64ws.svg","sources":[{"title":"E64 WS manufacturer or manual reference","url":"https://www.mahlkoenig.com/products/e64-ws-espresso-home-grinder"}],"unit":"µm","zero":"On-screen disk-distance calibration"},{"control":"screen","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","id":"e65sgbw","image":{"caption":"E65S GbW product view","owner":"Mahlkönig","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://www.mahlkoenig.com/products/e65s-gbw","url":"https://www.mahlkoenig.us/cdn/shop/files/E65S_GbW_-_Black_560x700.webp?v=1761340232"},"markings":"Use verified DDD distance, not an unmeasured adjustment-lever position","model":"E65S GbW","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/e65sgbw.svg","sources":[{"title":"E65S GbW manufacturer or manual reference","url":"https://www.mahlkoenig.com/products/e65s-gbw"}],"unit":"µm (DDD readout only)","zero":"Manufacturer DDD calibration"},{"control":"screen","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","id":"e80sgbw","image":{"caption":"E80S GbW product view","owner":"Mahlkönig","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://www.mahlkoenig.com/products/e80s-gbw-grinder","url":"https://www.mahlkoenig.us/cdn/shop/files/E80S_GbW_-_Black_560x700.webp?v=1761340079"},"markings":"Use verified DDD distance, not an unmeasured adjustment-lever position","model":"E80S GbW","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/e80sgbw.svg","sources":[{"title":"E80S GbW manufacturer or manual reference","url":"https://www.mahlkoenig.com/products/e80s-gbw-grinder"}],"unit":"µm (DDD readout only)","zero":"Manufacturer DDD calibration"},{"control":"collar","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","id":"df64gen1","image":{"caption":"DF64 original-generation product photograph with numbered adjustment collar visible; not a calibration measurement","owner":"DF64 Coffee","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://df64coffee.com/products/df64-single-dose-coffee-grinder","url":"https://df64coffee.com/cdn/shop/products/IMG_8737.png?v=1626712036&width=1445"},"markings":"Common 0–90-ish printed reference scale; owner-confirmed scale, not operating bounds","model":"DF64 Gen 1","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/df64gen1.svg","sources":[{"title":"DF64 Gen 1 manufacturer or manual reference","url":"https://support.clivecoffee.com/en/articles/16426035-df64-single-dose-user-manual"}],"unit":"dial marks","zero":"Owner-confirmed zero; printed zero may be offset"},{"control":"collar","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","id":"df64gen2","image":{"caption":"DF64 Gen 2 premium dial indicator close-up (optional Gen 2 accessory; not a factory-scale specification)","owner":"DF Grinders","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://dfgrinders.com/products/df64-metal-dial-indicator","url":"https://dfgrinders.com/cdn/shop/files/dial1_30fc9883-d06c-40d7-a2a2-2bf1d8cfe2d3.png?v=1759799433&width=416"},"markings":"Common 0–90-ish printed reference scale; owner-confirmed scale, not operating bounds","model":"DF64 Gen 2","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/df64gen2.svg","sources":[{"title":"DF64 Gen 2 manufacturer or manual reference","url":"https://df64coffee.com/products/df64-gen-2-single-dose-coffee-grinder"}],"unit":"dial marks","zero":"Movable indicator and burr changes require a fresh zero epoch"},{"control":"collar","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","id":"df54","image":{"caption":"DF Grinders premium dial indicator ring; dial close-up (optional DF54 accessory; not a factory-scale specification)","owner":"DF Grinders","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://dfgrinders.com/products/df54-metal-dial-indicator","url":"https://dfgrinders.com/cdn/shop/files/dial1.png?v=1759799419&width=416"},"markings":"Numbered stepless collar; confirm actual markings on your unit","model":"DF54","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/df54.svg","sources":[{"title":"DF54 manufacturer or manual reference","url":"https://dfgrinders.com/products/df54-metal-dial-indicator"}],"unit":"dial marks","zero":"Owner-confirmed indicator/zero"},{"control":"collar","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","id":"nichezero","image":{"caption":"Niche Zero with dial visible in the manufacturer's dial-in guide","owner":"Niche Coffee","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://www.nichecoffee.co.uk/blogs/exploring-coffee/how-to-dial-in-your-niche-zero","url":"https://cdn.shopify.com/s/files/1/0081/2076/2450/files/White_Niche_Zero_and_coffee_machine.jpg?v=1760088418"},"markings":"Stepless numbered collar; manufacturer examples are recipes, not safe limits","model":"Niche Zero","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/nichezero.svg","sources":[{"title":"Niche Zero manufacturer or manual reference","url":"https://www.nichecoffee.co.uk/blogs/exploring-coffee/how-to-calibrate-your-grinder-for-optimum-performance"}],"unit":"dial marks","zero":"Follow Niche calibration after relevant disassembly"},{"control":"collar","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","id":"encoreesp","image":{"caption":"Encore ESP product/carousel view; official page describes the numbered adjustment collar","owner":"Baratza / Breville","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://www.baratza.com/en-us/product/encoretm-esp-zcg495","url":"https://assets.breville.com/cdn-cgi/image/width%3D333%2Cformat%3Dauto%2Cquality%3D75/ZCG495/ZCG495_Carousel1.png"},"markings":"1–40; 1–20 espresso, 21–40 coarser/filter; steps have two resolution bands","model":"Baratza Encore ESP","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/encoreesp.svg","sources":[{"title":"Baratza Encore ESP manufacturer or manual reference","url":"https://www.baratza.com/en-dk/product/zcg495"}],"unit":"numbered settings","zero":"Shim/burr installation is calibration context"},{"control":"wheel","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","id":"sculptor064s","image":{"caption":"Sculptor 064S product view; official product page variant image","owner":"Timemore","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://www.timemore.com/products/timemore-electric-coffee-grinder-sculptor-series","url":"https://www.timemore.com/cdn/shop/files/064S.jpg?v=1713171847"},"markings":"Stepless S model; do not substitute non-S burr/scale","model":"Timemore Sculptor 064S","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/sculptor064s.svg","sources":[{"title":"Timemore Sculptor 064S manufacturer or manual reference","url":"https://www.timemore.com/pages/sculptor-related-faq"}],"unit":"dial marks","zero":"Exact model, burr and RPM; reset after zero changes"},{"control":"wheel","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","id":"sculptor078s","image":{"caption":"Sculptor 078S product view; official product page variant image","owner":"Timemore","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://www.timemore.com/products/timemore-electric-coffee-grinder-sculptor-series","url":"https://www.timemore.com/cdn/shop/files/078S.jpg?v=1713171847"},"markings":"Stepless S model; do not substitute non-S burr/scale","model":"Timemore Sculptor 078S","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/sculptor078s.svg","sources":[{"title":"Timemore Sculptor 078S manufacturer or manual reference","url":"https://www.timemore.com/pages/sculptor-related-faq"}],"unit":"dial marks","zero":"Exact model, burr and RPM; reset after zero changes"},{"control":"wheel","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","id":"lagom01","image":{"caption":"LAGOM 01 official product image","owner":"Option-O","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://www.option-o.com/lagom-01","url":"https://images.squarespace-cdn.com/content/v1/5b125642ec4eb782ce4f9947/1693535581758-AKATHPG9RWQ6M071BF8O/lagom%2B01.jpg"},"markings":"7.5 µm per micro tick for the documented configuration; not grounds diameter","model":"LAGOM 01","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/lagom01.svg","sources":[{"title":"LAGOM 01 manufacturer or manual reference","url":"https://www.option-o.com/guide-lagom-01"}],"unit":"micro-ticks","zero":"Configuration-specific zero, competition reference ±2 ticks"},{"control":"wheel","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","id":"lagomp64","image":{"caption":"LAGOM P64 official product image","owner":"Option-O","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://www.option-o.com/lagom-p64","url":"https://images.squarespace-cdn.com/content/v1/5b125642ec4eb782ce4f9947/8e408f57-ffa3-4196-bd61-4d2aab5671cf/LAGOM%2BP64.jpg"},"markings":"Do not substitute LAGOM 01 pitch; local conversion required","model":"LAGOM P64","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/lagomp64.svg","sources":[{"title":"LAGOM P64 manufacturer or manual reference","url":"https://www.option-o.com/lagomp64userguide"}],"unit":"dial micro-ticks","zero":"Recalibrate after burr replacement; generation matters"},{"control":"ring","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","id":"xpro","image":{"caption":"X-Pro official adjustment instruction image","owner":"1Zpresso","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://1zpresso.coffee/manual-xpro-en/","url":"https://i0.wp.com/1zpresso.coffee/wp-content/uploads/2022/08/3-1.jpg?fit=731%2C386&ssl=1"},"markings":"60 clicks/rotation; 12.5 µm mechanical movement per click","model":"1Zpresso X-Pro","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/xpro.svg","sources":[{"title":"1Zpresso X-Pro manufacturer or manual reference","url":"https://1zpresso.coffee/manual-xpro-en/"}],"unit":"clicks from zero","zero":"Manual zero procedure; multi-turn count must be retained"},{"control":"ring","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","id":"jmax","image":{"caption":"J-Max product image with external adjustment ring","owner":"1Zpresso","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://1zpresso.coffee/j/","url":"https://i0.wp.com/1zpresso.coffee/wp-content/uploads/2021/07/J-Max-grinder-w-closeup.jpg?fit=1333%2C1000&ssl=1"},"markings":"90 clicks/rotation; 8.8 µm mechanical movement per click","model":"1Zpresso J-Max","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/jmax.svg","sources":[{"title":"1Zpresso J-Max manufacturer or manual reference","url":"https://1zpresso.coffee/manual-jmax-en/"}],"unit":"clicks from zero","zero":"Manual zero procedure; multi-turn count must be retained"},{"control":"ring","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","id":"kseries","image":{"caption":"K-series external adjustment ring product image","owner":"1Zpresso","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://1zpresso.coffee/k/","url":"https://i0.wp.com/1zpresso.coffee/wp-content/uploads/2021/06/KPRO-new.png?fit=1000%2C800&ssl=1"},"markings":"90 clicks/rotation for reviewed K-Pro/K-Max/K-Plus; 22 µm/click; not K-Ultra","model":"1Zpresso K series","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder.","The reviewed 22 µm/click specification covers K-Pro/K-Max/K-Plus, not K-Ultra or every K-branded revision."],"schematicUrl":"../docs/grinder-dials/kseries.svg","sources":[{"title":"1Zpresso K series manufacturer or manual reference","url":"https://1zpresso.coffee/k/"}],"unit":"clicks from zero","zero":"Model-specific zero; retain complete turns and clicks"},{"control":"wheel","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","id":"odegen2","image":{"caption":"Ode Gen 2 official product image with large grind dial","owner":"Fellow","reuse":"Externally hosted copyright image; no redistribution licence verified.","sourceUrl":"https://fellowproducts.com/collections/grind-brew/products/ode-brew-grinder-gen-2?variant=40978992463972","url":"https://fellowproducts.com/cdn/shop/files/Web_PDP_OdeBrewGrinderGen2_Black_1_b979089a-570a-4024-99e7-dc5fcac0c69c.png?v=1780523585&width=1200"},"markings":"Printed 1–11 dial with intermediate clicks; brewed-coffee grinder, not espresso","model":"Fellow Ode Gen 2","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder.","Fellow Ode is a brewed-coffee grinder and is not a supported espresso grinder recommendation."],"schematicUrl":"../docs/grinder-dials/odegen2.svg","sources":[{"title":"Fellow Ode Gen 2 manufacturer or manual reference","url":"https://fellowproducts.com/pages/gear-guide-ode"}],"unit":"dial positions","zero":"Stock and SSP calibration procedures differ"}],"reviewedAt":"2026-10-11","schemaVersion":1},"reviewedAt":"2026-10-11","schemaVersion":1,"sources":[{"facts":{"brewRatio":"1:2","brewTimeSec":{"max":32,"min":28,"unit":"s"},"components":[{"name":"Altamira de Chirripó","origin":"Costa Rica","process":"white honey","roastLevel":"medium","variety":"Catuaí"},{"name":"El Meridiano","origin":"Colombia","process":"washed","roastLevel":"medium","variety":["Caturra","Colombia","Typica"]}],"doseG":19,"tastingNotes":["red apple","toffee","chocolate","hazelnut"],"temperatureC":{"max":94.5,"min":94,"unit":"C"}},"id":"squaremile-red-brick","kind":"roaster","notes":["The page says this is a starting point and machine-dependent; component percentages can change."],"publisher":"Square Mile Coffee Roasters","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"bean-specific starting recipe","brewMethod":"espresso","coffee":"Red Brick","equipment":"VA388 Black Eagle; VST 20g basket"},"title":"Red Brick espresso recipe","url":"https://shop.squaremilecoffee.com/products/red-brick"},{"facts":{"brewTimeSec":{"max":35,"min":25,"unit":"s"},"doseG":{"max":20,"min":19,"unit":"g"},"temperatureC":{"max":94,"min":93,"unit":"C"},"yieldG":{"max":45,"min":42,"unit":"g"}},"id":"tim-wendelboe-espresso","kind":"roaster","notes":["The page allows up to 50g for a more diluted cup and recommends drinking below 60C."],"publisher":"Tim Wendelboe","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic starting recipe","brewMethod":"espresso","equipment":"VST 20g basket"},"title":"How we make espresso","url":"https://timwendelboe.no/pages/how-we-make-espresso-espresso-tips"},{"facts":{"brewRatio":"1:2","brewTimeSec":28,"doseG":18,"yieldG":36},"id":"counter-culture-espresso","kind":"roaster","notes":["A general baseline; no temperature or grinder coordinate is prescribed."],"publisher":"Counter Culture Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic baseline","brewMethod":"espresso"},"title":"Guide to espresso","url":"https://counterculturecoffee.com/blogs/counter-culture-coffee/guide-to-espresso"},{"facts":{"brewRatio":{"max":2.5,"min":1.5,"unit":"ratio"},"brewTimeSec":{"max":35,"min":25,"unit":"s"},"doseG":18,"yieldG":36},"id":"counter-culture-quick-espresso","kind":"roaster","notes":["The page suggests finer below 25s and coarser above 35s as a starting adjustment; taste can override time."],"publisher":"Counter Culture Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic adjustment guide","brewMethod":"espresso"},"title":"Quick and easy espresso","url":"https://counterculturecoffee.com/pages/quick-easy-espresso"},{"facts":{"brewTimeSec":{"max":32,"min":28,"unit":"s"},"doseG":20,"grindDescription":"extra-fine","yieldG":40},"id":"blue-bottle-long-pull","kind":"roaster","notes":["No temperature is specified on the reviewed page."],"publisher":"Blue Bottle Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"method-specific starting recipe","brewMethod":"espresso","coffee":"single origin"},"title":"Single origin long-pull espresso","url":"https://bluebottlecoffee.com/us/eng/brew-guides/single-origin-espresso"},{"facts":{"brewTimeSec":{"max":210,"min":150,"unit":"s"},"doseG":{"max":27,"min":20,"unit":"g"},"temperatureC":{"max":96.1,"min":90.6,"unit":"C"},"waterG":350},"id":"blue-bottle-pourover","kind":"roaster","notes":["The page says darker roasts suit the cooler end and lighter roasts the hotter end; it gives no grinder coordinate."],"publisher":"Blue Bottle Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic method","brewMethod":"pour-over"},"title":"Pour-over guide","url":"https://bluebottlecoffee.com/us/eng/brew-guides/pour-over"},{"facts":{"brewTimeSec":{"max":360,"min":240,"unit":"s"},"doseG":59,"grindDescription":"medium-coarse","waterAmount":"6 cups (half pot)"},"id":"blue-bottle-moccamaster","kind":"roaster","notes":["The source describes a half-pot/6-cup dose. It also mentions 98g for a full pot with 10 cups; no gram-to-cup conversion is inferred."],"publisher":"Blue Bottle Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"equipment-specific batch recipe","brewMethod":"automatic filter","equipment":"Technivorm Moccamaster KBGV"},"title":"Technivorm Moccamaster guide","url":"https://bluebottlecoffee.com/us/eng/brew-guides/coffee-maker"},{"facts":{"brewTimeSec":{"max":22,"min":18,"unit":"s"},"doseG":18,"yieldG":50},"id":"lacabra-espresso","kind":"roaster","notes":["The page explicitly says its outline need not be followed exactly and discusses water chemistry."],"publisher":"La Cabra","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic starting recipe","brewMethod":"espresso"},"title":"Brew guides","url":"https://lacabra.com/pages/brewing"},{"facts":{"doseG":15,"pourScheduleSec":[0,45,90],"waterG":250},"id":"lacabra-v60","kind":"roaster","notes":["The source does not prescribe a total brew time for this V60 outline."],"publisher":"La Cabra","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic method","brewMethod":"V60"},"title":"Brew guides V60","url":"https://lacabra.com/pages/brewing"},{"facts":{"brewTimeSec":{"max":23,"min":12,"unit":"s"},"doseG":18.5,"temperatureC":93,"yieldG":{"max":45,"min":40,"unit":"g"}},"id":"prolog-espresso","kind":"roaster","notes":["The source says its bar often uses 12–14s and equipment/water/technique can make a slower shot better."],"publisher":"Prolog Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic starting recipe","brewMethod":"espresso"},"title":"Brew guides","url":"https://www.prologcoffee.com/pages/brew-guides"},{"facts":{"brewTimeSec":150,"doseG":15,"temperatureC":100,"yieldG":250},"id":"prolog-v60","kind":"roaster","notes":["The page calls this a starting point and says taste and coffee may require adjustment."],"publisher":"Prolog Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic starting recipe","brewMethod":"V60"},"title":"Brew guides V60","url":"https://www.prologcoffee.com/pages/brew-guides"},{"facts":{"brewTimeSec":24,"doseG":19,"farm":"Finca El Diviso","origin":"Colombia","producer":"Nestor Lasso","tastingNotes":["ripe raspberry","red cherry","boysenberry ice cream"],"variety":"Ombligon","yieldG":43},"id":"onyx-nestor-lasso","kind":"roaster","notes":["The page also publishes a separate 20g/280g Origami recipe; this entry is espresso only. Roast level is not inferred."],"publisher":"Onyx Coffee Lab","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"bean-specific recipe","brewMethod":"espresso","coffee":"Colombia Nestor Lasso Ombligon"},"title":"Nestor Lasso Ombligon extraction guide","url":"https://onyxcoffeelab.com/products/colombia-nestor-lasso-ombligon-26"},{"facts":{"brewTimeSec":25,"doseG":19,"origin":"Honduras","producer":"Benjamin Paz","variety":"SL28","yieldG":45},"id":"onyx-benjamin-paz","kind":"roaster","notes":["The page's espresso recipe is listed separately from the filter recipe. Processing, roast level and tasting notes are not inferred when not explicit in the reviewed extract."],"publisher":"Onyx Coffee Lab","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"bean-specific recipe","brewMethod":"espresso","coffee":"Honduras Benjamin Paz SL28"},"title":"Benjamin Paz SL28 extraction guide","url":"https://onyxcoffeelab.com/en-int/products/honduras-benjamin-paz-sl28-26"},{"facts":{"brewTimeSec":23,"doseG":19,"origin":"Colombia","variety":"Gesha","yieldG":50},"id":"onyx-el-jardin","kind":"roaster","notes":["The same page provides a separate 15g/240g filter recipe. Roast level, process and tasting notes are not inferred from the product title."],"publisher":"Onyx Coffee Lab","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"bean-specific recipe","brewMethod":"espresso","coffee":"Colombia El Jardin Gesha"},"title":"El Jardin Gesha extraction guide","url":"https://onyxcoffeelab.com/products/colombia-el-jardin-gesha"},{"facts":{"brewTimeSec":22,"doseG":18,"origin":"Costa Rica","process":"natural","tastingNotes":["grape","semi-sweet dark chocolate","fresh berries","vanilla","rich chocolate"],"variety":"Catuai","yieldG":42},"id":"onyx-las-lajas","kind":"roaster","notes":["The espresso recipe is accompanied by a distinct filter recipe; the product page describes the lot as naturally processed."],"publisher":"Onyx Coffee Lab","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"bean-specific recipe","brewMethod":"espresso","coffee":"Costa Rica Las Lajas Natural"},"title":"Las Lajas Natural extraction guide","url":"https://onyxcoffeelab.com/products/costa-rica-las-lajas-natural-25"},{"facts":{"workflow":"guided roast, dose, beverage-weight, brew-time and initial-grind-degree screens"},"id":"mahlkoenig-e64-manual","kind":"manufacturer","notes":["The reviewed PDF was not reachable during the independent audit; no numeric example values are treated as verified facts here. The workflow description is retained for context only and does not expose a calibration equation."],"publisher":"Mahlkönig","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific guided workflow","brewMethod":"espresso","grinderModel":"E64 WS"},"title":"E64 WS Espresso Home software manual","url":"https://downloads.mahlkoenig.de/Service/Mahlkoenig_E64_WS_Espresso_Home_Software_Manual.pdf"},{"facts":{"dialDirection":"clockwise=finer; counter-clockwise=coarser"},"id":"df64-clive","kind":"manufacturer","notes":["The page says the collar is sensitive and that the stock sticker may be inaccurate after SSP burr installation."],"publisher":"Clive Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model/generation-dependent mechanical guidance","grinderModel":"DF64"},"title":"DF64 Single Dose user manual","url":"https://support.clivecoffee.com/en/articles/16426035-df64-single-dose-user-manual"},{"facts":{"burrDiameterMm":40,"espressoSettingRange":{"max":20,"min":1},"filterSettingRange":{"max":40,"min":21},"rpm":550},"id":"baratza-encore-esp","kind":"manufacturer","notes":["Settings are dial coordinates, not micrometres or particle-size guarantees."],"publisher":"Baratza","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific mechanical specification","burrSKU":"M2 conical steel","grinderModel":"Encore ESP"},"title":"Encore ESP specifications","url":"https://www.baratza.com/en-dk/product/zcg495"},{"facts":{"064SUse":"pour-over and espresso","078SUse":"pour-over and espresso","078TurboUse":"pour-over focused","burrVariants":["064S flat","078S flat","078 turbo"],"rpmControl":"variable"},"id":"timemore-sculptor","kind":"manufacturer","notes":["The current product pages describe these three relevant variants; they do not support treating them as four equivalent interchangeable configurations and do not give a universal dial-to-particle-size conversion."],"publisher":"Timemore","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model and burr-variant specification","grinderModel":"Sculptor 064S/078S"},"title":"Sculptor series and burrs","url":"https://www.timemore.com/products/timemore-electric-coffee-grinder-sculptor-series"},{"facts":{"burrZero":"burr touch","postCleaningPurgeG":18},"id":"niche-zero-calibration","kind":"manufacturer","notes":["The source recommends recalibration after disassembly/cleaning; purge amount is a preparation step, not a dial conversion."],"publisher":"Niche Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific zero procedure","burrSKU":"63mm conical","grinderModel":"Niche Zero"},"title":"Niche Zero calibration","url":"https://www.nichecoffee.co.uk/blogs/exploring-coffee/how-to-calibrate-your-grinder-for-optimum-performance"},{"facts":{"burrTravelMicrometresPerClick":7.5,"rpmRange":{"max":1700,"min":200},"zeroToleranceMicroTicks":2},"id":"option-o-lagom-01","kind":"manufacturer","notes":["Burr-gap movement is not particle size or a cross-model conversion."],"publisher":"Option-O","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"configuration-specific mechanical specification","burrSKU":"Mizen 102OM flat in competition configuration","grinderModel":"LAGOM 01"},"title":"LAGOM 01 guide and competition specification","url":"https://www.option-o.com/wbrc"},{"facts":{"missesBeforeSuggestion":3},"id":"fiorenzato-adapt","kind":"manufacturer","notes":["The manufacturer describes a wired flow-meter connection and a suggestion after three extractions miss the recipe; coefficients are not published."],"publisher":"Fiorenzato","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"manufacturer product behavior claim","system":"ADAPT"},"title":"ADAPT connection system","url":"https://www.fiorenzato.com/en/adapt/"},{"facts":{"features":["Smart Profiler","Grind Analyzer","Coffee Diary"]},"id":"maro-model-1","kind":"manufacturer","notes":["The reviewed product page does not publish a Brew Companion feature, recommendation equations, grinder calibration units or an API. MARO HOME is catalogued separately only when a directly verified source supports a feature."],"publisher":"MARO Coffee Engineering","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"manufacturer product feature claim","system":"MARO Model 1"},"title":"MARO Model 1 product features","url":"https://maro.coffee/en/products/maro-model-1"},{"facts":{"finding":"below a critical grind size, extraction can decrease as grind becomes finer"},"id":"coffee-physics-uneven","kind":"research","notes":["Supports a non-monotonic caution; not a grinder calibration dataset. License/reuse terms must be checked at the repository before redistribution."],"publisher":"arXiv research preprint","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"physical model and experiment context","brewMethod":"espresso"},"title":"Uneven Extraction in Coffee Brewing","url":"https://arxiv.org/abs/2206.12373"},{"facts":{"finding":"flow influence is stronger at finer grind and higher temperature","license":"CC BY 4.0"},"id":"coffee-physics-flow-temperature","kind":"research","notes":["Particle size distribution and flow must remain context variables; source is not a dial-coordinate lookup."],"publisher":"Peer-reviewed open-access research","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"controlled experimental evidence","brewMethod":"espresso"},"title":"Influence of flow rate, particle size, and temperature on espresso extraction kinetics","url":"https://pmc.ncbi.nlm.nih.gov/articles/PMC10418593/"},{"facts":{"finding":"particle-size distribution affects bed compression, porosity and permeability"},"id":"coffee-physics-psd-compression","kind":"research","notes":["Abstract-level source review; full-text reuse rights were not established."],"publisher":"Journal of Food Engineering","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"peer-reviewed packed-bed model and experiment","brewMethod":"espresso"},"title":"Influence of particle size distribution on espresso extraction via packed bed compression","url":"https://www.sciencedirect.com/science/article/abs/pii/S0260877422003557"},{"facts":{"finding":"particle-size distribution changes espresso aromatic profile non-monotonically"},"id":"coffee-physics-psd-nonmonotonic","kind":"research","notes":["Use as a caution against assuming a single monotone grind-response curve; full-text reuse rights were not established."],"publisher":"Food Research International","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"peer-reviewed particle-distribution evidence","brewMethod":"espresso"},"title":"Espresso coffee design based on non-monotonic granulometric distribution of aromatic profile","url":"https://pubmed.ncbi.nlm.nih.gov/31285015/"},{"facts":{"finding":"particle size and filter basket design affect extraction chemistry"},"id":"coffee-physics-particle-size","kind":"research","notes":["The source does not provide a grinder dial conversion; full-text reuse rights were not established."],"publisher":"Food Chemistry","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"peer-reviewed particle-size and basket experiment","brewMethod":"espresso"},"title":"Optimization of espresso extraction through variation of particle sizes","url":"https://pubmed.ncbi.nlm.nih.gov/31982858/"},{"facts":{"burrTravelMicrometresPerClick":12.5,"clicksPerRotation":60},"id":"onezpresso-xpro","kind":"manufacturer","notes":["This is burr movement from the manufacturer manual, not particle size or an extraction response."],"publisher":"1Zpresso","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific mechanical travel","grinderModel":"X-Pro"},"title":"X-Pro user manual","url":"https://1zpresso.coffee/manual-xpro-en/"},{"facts":{"burrTravelMicrometresPerClick":8.8},"id":"onezpresso-jmax","kind":"manufacturer","notes":["The manual's click travel is mechanical burr spacing; it is not a particle-size claim."],"publisher":"1Zpresso","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific mechanical travel","grinderModel":"J-Max"},"title":"J-Max user manual","url":"https://1zpresso.coffee/wp-content/uploads/2021/08/J-Max-User-Manual-20210819.pdf"},{"facts":{"burrTravelMicrometresPerClick":22,"clicksPerRotation":90},"id":"onezpresso-k-series","kind":"manufacturer","notes":["The published click value is mechanical movement, not particle size."],"publisher":"1Zpresso","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific mechanical travel","grinderModel":"K series"},"title":"K series specifications","url":"https://1zpresso.coffee/k/"},{"facts":{"HUUse":"espresso-focused","MPUse":"pour-over first; also espresso, French press and AeroPress"},"id":"ssp-64-hu-mp-df","kind":"manufacturer","notes":["Vendor descriptions do not provide a DF64 dial offset, particle distribution or zero compatibility table."],"publisher":"DF Grinders","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"vendor brew-intent description","burrSKU":"SSP HU/MP","grinderModel":"64mm flat-burr grinders including DF64"},"title":"64mm SSP Red Speed burrs","url":"https://dfgrinders.ca/products/64mm-ssp-red-speed-burrs"},{"facts":{"relativeParticleSizeMicrometresVsStockOde":-200},"id":"ssp-64-mp-ode","kind":"manufacturer","notes":["The comparison is for referenced Ode drip settings and must not be applied to DF64 collar readings."],"publisher":"Fellow","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"Ode-specific comparison","burrSKU":"SSP Red Speed 64mm MP","grinderModel":"Fellow Ode Brew Grinder"},"title":"SSP 64mm MP brew burrs","url":"https://fellowproducts.com/products/ssp-red-speed-coated-64mm-flat-brew-burrs"},{"facts":{"recalibrateAfterBurrReplacement":true},"id":"option-o-p64-calibration","kind":"manufacturer","notes":["The guide distinguishes routine cleaning from zero calibration and says production-period calibration differs."],"publisher":"Option-O","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"generation and burr-swap calibration","grinderModel":"LAGOM P64"},"title":"LAGOM P64 zero and burr calibration guide","url":"https://www.option-o.com/lagomp64userguide"},{"facts":{"adjustWhileBurrsSpinning":true},"id":"df64-running-adjustment","kind":"manufacturer","notes":["The FAQ recommends incremental adjustment while running; purge/settling behavior is plugin policy, not a published numeric constant."],"publisher":"DF Grinders","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific operating guidance","grinderModel":"DF64"},"title":"DF64 adjustment FAQ","url":"https://df64grinders.com/faqs"},{"facts":{"burrDiameterMm":64,"burrReplacementAccess":"remove collar to access top burr"},"id":"df64-gen2-manual","kind":"manufacturer","notes":["The reviewed manual does not publish collar pitch or travel per mark."],"publisher":"Turin/DF64 manual mirror","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"generation-specific maintenance","grinderModel":"DF64 Gen 2"},"title":"DF64 Gen 2 instruction manual","url":"https://manuals.plus/asin/B0DPRWGP6L.pdf"},{"facts":{"measurement":"image-based particle-size distribution","platforms":["macOS","Unix","Windows"]},"id":"coffee-ad-astra-psd-tool","kind":"research","notes":["Use as a measurement aid; do not copy code or graphics into the plugin without checking repository license."],"publisher":"Coffee Ad Astra / Jonathan Gagné","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"measurement workflow, not calibration constants","tool":"image-based PSD analyzer"},"title":"Application to measure grind size distribution","url":"https://github.com/jgagneastro/coffeegrindsize"},{"facts":{"grinderCount":24,"sampleCount":300},"id":"coffee-ad-astra-300-psd","kind":"research","notes":["Empirical PSD observations are not a universal dial or extraction model; reuse is limited to linked factual summary."],"publisher":"Coffee Ad Astra","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"published empirical PSD observations","brewMethod":"espresso"},"title":"What I learned from analyzing 300 particle size distributions","url":"https://coffeeadastra.com/2023/09/21/what-i-learned-from-analyzing-300-particle-size-distributions-for-24-espresso-grinders/"},{"facts":{"guidance":["extract more: finer and/or longer","extract less: coarser and/or shorter","change ratio for strength"]},"id":"barista-hustle-coffee-compass","kind":"research","notes":["The publisher explicitly scopes it to filter percolation and immersion, not espresso."],"publisher":"Barista Hustle","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"taste-guidance workflow","brewMethod":"filter coffee"},"title":"Coffee Compass","url":"https://www.baristahustle.com/coffee-compass/"},{"facts":{"integrations":["Decent Scale","Acaia","Felicita","Hiroia Jimmy","Eureka Precisa","Skale2","Smart Espresso Profiler","Pressensor"],"license":"GPL-3.0","trackedFields":["grind size","grind amount","brew time","first drip"]},"id":"beanconqueror-open-source","kind":"research","notes":["Use as an integration/data-model reference; no recommendation coefficients are imported."],"publisher":"Beanconqueror","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"data model and integration precedent","tool":"open-source brew logbook"},"title":"Beanconqueror coffee logging and device integrations","url":"https://github.com/graphefruit/Beanconqueror"},{"facts":{"freshCoffeeGuidance":"lower temperature and shorter contact time","minimumRestDays":10,"wellRestedBeyondWeeks":6,"wellRestedGuidance":"higher temperature and longer contact can be tolerated"},"id":"lacabra-water-resting","kind":"roaster","notes":["The source discusses lightly roasted dense coffees, degassing and water chemistry; it does not specify a universal espresso setting."],"publisher":"La Cabra","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster guidance, not grinder calibration","brewMethod":"coffee brewing; contextual guidance"},"title":"Water and coffee: resting and water guidance","url":"https://us.lacabra.com/pages/water"},{"facts":{"exampleEspresso":{"brewTimeSec":23,"doseG":19,"yieldG":47},"filters":["coffee name","origin","process","roast level"]},"id":"onyx-brew-guides-index","kind":"roaster","notes":["The index demonstrates that Onyx scopes recipes to named coffees and roast/process metadata; the example is not a universal target."],"publisher":"Onyx Coffee Lab","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster's coffee-specific guide index","brewMethod":"filter and espresso"},"title":"Brew guides index with origin/process/roast filters","url":"https://onyxcoffeelab.com/pages/brew-guides"},{"facts":{"calibration":"manufacturer fine grinding disk distance calibration procedure","coarserDirection":"larger displayed disk distance","control":"electronic recipe grinding degree operated through display and rotary knob","displayUnit":"µm","finerDirection":"smaller displayed disk distance"},"id":"mahlkoenig-e64ws-native-distance","kind":"manufacturer","notes":["Original operating instructions page 13 defines the µm unit and direction; page 26 covers fine disk-distance calibration.","The internal research coordinate is expressed in 0.1 µm: 500 research dD equals 50 µm as a unit conversion. This does not validate firmware behavior, limits or grinder portability.","No universal user setting range or increment is inferred from the manual."],"publisher":"Mahlkönig","reuse":"linked short factual summary; manufacturer photographs and manual illustrations remain external","scope":{"applicability":"native displayed disk distance, not particle diameter or validation of recovered algorithms","grinderModel":"E64 WS"},"title":"E64 WS native grinding disk distance and zero calibration","url":"https://downloads.mahlkoenig.de/Service/Mahlkoenig_E64_WS_Espresso_Home_Original_instructions_EN.pdf"}]};
  const normalize = (value) => typeof value === "string"
    ? value.trim().toLocaleLowerCase().replace(/[\s_-]+/g, " ")
    : null;
  const matches = (source, query) => {
    const scope = source.scope || {};
    if (source.kind === "roaster" && normalize(scope.brewMethod) !== "espresso") return false;
    const model = normalize(query.grinderModel);
    const burr = normalize(query.burrIdentity);
    const bean = query.bean && typeof query.bean === "object" ? query.bean : null;
    const roaster = normalize(bean && bean.roaster);
    const beanName = normalize(bean && bean.name);
    if (!model && !burr && !roaster && !beanName) return false;
    if (burr && !model) return false;
    const exact = (actual, wanted) => wanted == null || (typeof actual === "string" && normalize(actual) === normalize(wanted));
    if (model && !exact(scope.grinderModel, query.grinderModel)) return false;
    if (model && !burr && scope.burrSKU) return false;
    if (burr && !exact(scope.burrSKU, query.burrIdentity)) return false;
    if (bean && beanName && !roaster) return false;
    if (roaster && !exact(source.publisher, bean.roaster)) return false;
    if (beanName && scope.coffee && !exact(scope.coffee, bean.name)) return false;
    return true;
  };
  return {
    schemaVersion: catalog.schemaVersion,
    reviewedAt: catalog.reviewedAt,
    sources: catalog.sources,
    grinderDials: catalog.grinderDials,
    matchReferences(query = {}) {
      if (!query || typeof query !== "object" || Array.isArray(query)) return [];
      return catalog.sources.filter((source) => matches(source, query));
    },
  };
}
/* GENERATED REFERENCE CATALOG END */

function createPlugin(host, services) {
  "use strict";
  services = services || {};
  const dialCatalog = createReferenceCatalog().grinderDials || { models: [] };
  const grinderDialTools = createGrinderDialTools();
  // The simulator supplies an in-memory API; the host uses its normal fetch.
  const apiRequest = services.fetch || fetch;

  const ID = "assisted-dialin.reaplugin";
  const API_BASE = "http://127.0.0.1:8080";
  const STORAGE_KEY = "feedback.v1";
  const MAX_PAGES = 5;
  const PAGE_SIZE = 50;
  const TASTES = [
    "balanced",
    "sour",
    "bitter",
    "astringent",
    "weak",
    "channeling",
  ];
  const CONTEXT_FIELDS = [
    "beanBatchId",
    "grinderId",
    "grinderModel",
    "burrIdentity",
    "calibrationEpoch",
    "basket",
    "dose",
    "yield",
    "settingUnit",
    "beanType",
    "roastLevel",
  ];
  let feedback = Object.create(null);
  let settings = {};
  let storageReady = false;
  let storageUnavailable = false;
  let storageWaiters = [];
  let storageWriteWaiters = [];
  let storageWriteBroken = false;
  let feedbackQueue = Promise.resolve();
  let active = false;
  let sessionEpoch = 0;
  let cachedShots = null;
  let cachedAt = 0;
  let cacheGeneration = 0;

  const json = (status, value) => ({
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  const html = (status, value) => ({
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: value,
  });

  function log(message) {
    try {
      host.log(`[dialin] ${message}`);
    } catch (_) {}
  }
  function bodyOf(request) {
    if (request && request.body && typeof request.body === "object")
      return request.body;
    if (typeof request?.body !== "string" || request.body.length === 0)
      return {};
    try {
      return JSON.parse(request.body);
    } catch (_) {
      return {};
    }
  }
  function value(value, fallback) {
    return value === undefined || value === null || value === ""
      ? fallback
      : value;
  }
  function numberOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  function textOrNull(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  function validateFlavour(input) {
    if (input == null) return null;
    if (typeof input !== "object" || Array.isArray(input))
      throw new Error("flavour must be an object");
    const result = {};
    if (!Object.keys(input).length)
      throw new Error("flavour input must contain at least one field");
    const intensities = [
      "acidity",
      "bitterness",
      "sweetness",
      "body",
      "astringency",
    ];
    for (const key of Object.keys(input)) {
      if (intensities.includes(key)) {
        if (
          !(
            numberOrNull(input[key]) >= 0 &&
            numberOrNull(input[key]) !== null &&
            input[key] <= 5
          )
        )
          throw new Error("flavour intensity must be between 0 and 5");
        result[key] = input[key];
      } else if (key === "descriptors") {
        if (
          !Array.isArray(input[key]) ||
          input[key].length > 12 ||
          input[key].some((item) => !textOrNull(item) || item.length > 64)
        )
          throw new Error("invalid flavour descriptors");
        result[key] = input[key].map((item) => item.trim());
      } else if (key === "overall") {
        if (
          ![
            "balanced",
            "under-extracted",
            "over-extracted",
            "uncertain",
          ].includes(input[key])
        )
          throw new Error("invalid overall extraction assessment");
        result[key] = input[key];
      } else throw new Error("unsupported flavour field");
    }
    return result;
  }
  function validateMeasuredBeanDose(input) {
    if (input == null) return null;
    if (typeof input !== "object" || Array.isArray(input))
      throw new Error("measuredBeanDose must be an object");
    const allowed = new Set([
      "deviceId",
      "connectionRole",
      "purpose",
      "weightG",
      "units",
      "capturedAt",
      "sampleTimestamp",
      "userConfirmed",
    ]);
    const unknown = Object.keys(input).find((key) => !allowed.has(key));
    if (unknown)
      throw new Error(`measuredBeanDose has unsupported field: ${unknown}`);
    const deviceId = textOrNull(input.deviceId);
    if (!deviceId || deviceId.length > 256)
      throw new Error("measuredBeanDose.deviceId must be a non-empty ID");
    if (input.connectionRole !== "auxiliary")
      throw new Error("measuredBeanDose.connectionRole must be auxiliary");
    if (input.purpose !== "beans")
      throw new Error("measuredBeanDose.purpose must be beans");
    if (!(typeof input.weightG === "number" && Number.isFinite(input.weightG) && input.weightG > 0))
      throw new Error("measuredBeanDose.weightG must be a finite positive number");
    if (input.units !== "g")
      throw new Error("measuredBeanDose.units must be g");
    const iso = (value, key, nullable) => {
      if (nullable && value === null) return null;
      const match =
        typeof value === "string" &&
        value.match(
          /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/,
        );
      const year = match ? Number(match[1]) : NaN;
      const month = match ? Number(match[2]) : NaN;
      const day = match ? Number(match[3]) : NaN;
      const hour = match ? Number(match[4]) : NaN;
      const minute = match ? Number(match[5]) : NaN;
      const second = match ? Number(match[6]) : NaN;
      const timezone = match?.[7];
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      const offsetMatch = timezone && timezone.match(/^[+-](\d{2}):(\d{2})$/);
      const offsetHour = offsetMatch ? Number(offsetMatch[1]) : 0;
      const offsetMinute = offsetMatch ? Number(offsetMatch[2]) : 0;
      if (
        !match ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > daysInMonth[month - 1] ||
        hour > 23 ||
        minute > 59 ||
        second > 59 ||
        offsetHour > 14 ||
        (offsetHour === 14 && offsetMinute !== 0) ||
        offsetMinute > 59 ||
        !Number.isFinite(Date.parse(value))
      )
        throw new Error(`measuredBeanDose.${key} must be an ISO datetime${nullable ? " or null" : ""}`);
      return value;
    };
    if (input.userConfirmed !== true)
      throw new Error("measuredBeanDose.userConfirmed must be true");
    return {
      deviceId,
      connectionRole: "auxiliary",
      purpose: "beans",
      weightG: input.weightG,
      units: "g",
      capturedAt: iso(input.capturedAt, "capturedAt", false),
      sampleTimestamp: iso(input.sampleTimestamp, "sampleTimestamp", true),
      userConfirmed: true,
      source: "operator-confirmed auxiliary scale capture",
    };
  }
  function tasteSignals(mark) {
    const signals = [];
    if (mark.taste) signals.push(mark.taste);
    const flavour = mark.flavour || {};
    if (flavour.overall === "under-extracted") signals.push("sour");
    if (flavour.overall === "over-extracted") signals.push("bitter");
    if (flavour.overall === "balanced") signals.push("balanced");
    if (flavour.bitterness >= 4) signals.push("bitter");
    if (flavour.astringency >= 4) signals.push("astringent");
    return signals;
  }
  async function beanContext() {
    const generation = cacheGeneration;
    const workflow = await currentWorkflow();
    const id =
      textOrNull(workflow.context.beanBatchId) ||
      textOrNull(settings.BeanBatchId);
    if (!id) return { status: "unavailable", missingData: ["beanBatchId"] };
    const batchResponse = await apiRequest(
      `${API_BASE}/api/v1/bean-batches/${encodeURIComponent(id)}`,
    );
    if (!batchResponse.ok) throw new Error("current bean batch unavailable");
    const batch = await batchResponse.json();
    if (!batch || batch.id !== id || !textOrNull(batch.beanId))
      throw new Error("invalid bean batch");
    const beanResponse = await apiRequest(
      `${API_BASE}/api/v1/beans/${encodeURIComponent(batch.beanId)}`,
    );
    if (!beanResponse.ok) throw new Error("current bean unavailable");
    const bean = await beanResponse.json();
    if (!bean || bean.id !== batch.beanId) throw new Error("invalid bean");
    if (!active || generation !== cacheGeneration)
      throw new Error("bean context changed");
    return {
      status: "available",
      beanBatchId: id,
      beanId: batch.beanId,
      bean: Object.fromEntries(
        [
          "name",
          "roaster",
          "species",
          "variety",
          "processing",
          "country",
          "region",
          "altitude",
          "decaf",
          "decafProcess",
          "producer",
        ]
          .filter((key) => bean[key] != null)
          .map((key) => [key, bean[key]]),
      ),
      batch: Object.fromEntries(
        [
          "roastLevel",
          "roastDate",
          "openDate",
          "freezeDate",
          "unfreezeDate",
          "frozen",
        ]
          .filter((key) => batch[key] != null)
          .map((key) => [key, batch[key]]),
      ),
      provenance:
        "Current editable bean catalog, fetched now. This is not a historical shot snapshot and is never backfilled into shots.",
      capturedAt: new Date().toISOString(),
      requiresHistoricalConfirmation: true,
    };
  }
  function reviewedReferenceContext(current, beanCatalog) {
    const references = createReferenceCatalog();
    const grinderMatches = references.matchReferences({
      grinderModel: current.grinderModel,
    });
    const exactBurrMatches = current.burrIdentity
      ? references.matchReferences({
          grinderModel: current.grinderModel,
          burrIdentity: current.burrIdentity,
        })
      : [];
    const bean = beanCatalog?.bean || {};
    const beanMatches = references.matchReferences({
      bean: { roaster: bean.roaster, name: bean.name },
    });
    const byId = new Map();
    grinderMatches.concat(exactBurrMatches, beanMatches).forEach((source) => {
      if (!byId.has(source.id)) byId.set(source.id, source);
    });
    return {
      schemaVersion: references.schemaVersion,
      reviewedAt: references.reviewedAt,
      matches: Array.from(byId.values()),
      provenance:
        "Matched offline reviewed references are contextual facts only; they do not alter the suggestion, infer a grinder coordinate, or backfill historical shot metadata.",
    };
  }
  async function analysis(shotId) {
    const generation = cacheGeneration;
    await loadStorage();
    await feedbackQueue;
    const full = await fullShot(shotId);
    const mark = feedback[shotId]
      ? JSON.parse(JSON.stringify(feedback[shotId]))
      : null;
    const metrics = createBrewMetrics().analyze(full, mark);
    if (mark?.measuredBeanDose) {
      const measured = mark.measuredBeanDose;
      metrics.measuredBeanDose = {
        weightG: measured.weightG,
        units: measured.units,
        deviceId: measured.deviceId,
        connectionRole: measured.connectionRole,
        purpose: measured.purpose,
        capturedAt: measured.capturedAt,
        sampleTimestamp: measured.sampleTimestamp,
        userConfirmed: measured.userConfirmed,
        source: measured.source,
      };
      metrics.annotations.actualYieldToMeasuredBeanDoseRatio =
        metrics.scale.finalMeasuredWeightG != null && measured.weightG > 0
          ? metrics.scale.finalMeasuredWeightG / measured.weightG
          : null;
    }
    if (!active || generation !== cacheGeneration)
      throw new Error("shot changed during analysis");
    return {
      shotId,
      metrics,
      measuredBeanDose: metrics.measuredBeanDose || null,
      feedback: mark,
      context: historicalContext(full, mark),
      provenance:
        "Saved full shot and plugin-local operator feedback; no physical configuration observation is inferred",
    };
  }
  function feedbackFromStorage(value) {
    if (value == null) return Object.create(null);
    if (typeof value !== "object" || Array.isArray(value)) return null;
    const result = Object.create(null);
    for (const key of Object.keys(value)) {
      if (
        !key ||
        key.length > 256 ||
        !value[key] ||
        typeof value[key] !== "object" ||
        Array.isArray(value[key]) ||
        typeof value[key].good !== "boolean"
      )
        return null;
      const entry = value[key];
      if (entry.taste != null && !TASTES.includes(entry.taste)) return null;
      if (
        entry.brewTimeSec != null &&
        !(numberOrNull(entry.brewTimeSec) > 0 && entry.brewTimeSec <= 600)
      )
        return null;
      let confirmedContext, flavour, measuredBeanDose;
      try {
        flavour = validateFlavour(entry.flavour);
        confirmedContext = validateConfirmedContext(entry.confirmedContext);
        if (entry.measuredBeanDose != null) {
          const { source: _source, ...storedMeasurement } = entry.measuredBeanDose;
          measuredBeanDose = validateMeasuredBeanDose(storedMeasurement);
        }
      } catch (_) {
        return null;
      }
      result[key] = {
        good: entry.good,
        notes: textOrNull(entry.notes)?.slice(0, 512) || null,
        updatedAt: textOrNull(entry.updatedAt)?.slice(0, 64) || null,
        taste: entry.taste || null,
        flavour,
        brewTimeSec: entry.brewTimeSec ?? null,
        confirmedContext,
        measuredBeanDose,
      };
    }
    return result;
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      const result = Object.create(null);
      Object.keys(value)
        .sort()
        .forEach((key) => {
          result[key] = canonical(value[key]);
        });
      return result;
    }
    return value;
  }
  function profileContent(profile) {
    if (!profile || !Array.isArray(profile.steps) || profile.steps.length === 0)
      return null;
    const fields = [
      "beverage_type",
      "steps",
      "tank_temperature",
      "target_weight",
      "target_volume",
      "target_volume_count_start",
      "legacy_profile_type",
      "type",
      "version",
    ];
    const content = Object.create(null);
    fields.forEach((key) => {
      if (profile[key] !== undefined) content[key] = profile[key];
    });
    return JSON.stringify(canonical(content));
  }

  function contextOf(shot, useSettings) {
    const workflow = shot?.workflow || {};
    const context = workflow.context || {};
    const extras = context.extras || {};
    const profile = workflow.profile || {};
    return {
      beanBatchId: textOrNull(
        useSettings
          ? value(context.beanBatchId, settings.BeanBatchId)
          : context.beanBatchId,
      ),
      grinderId: textOrNull(
        useSettings
          ? value(context.grinderId, settings.GrinderId)
          : context.grinderId,
      ),
      grinderModel: textOrNull(
        useSettings
          ? value(context.grinderModel, settings.GrinderModel)
          : context.grinderModel,
      ),
      burrIdentity: textOrNull(
        useSettings
          ? value(
              context.grinderBurrs,
              value(extras.burrIdentity, settings.BurrIdentity),
            )
          : value(context.grinderBurrs, extras.burrIdentity),
      ),
      calibrationEpoch: textOrNull(
        useSettings
          ? value(extras.calibrationEpoch, settings.CalibrationEpoch)
          : extras.calibrationEpoch,
      ),
      dose: numberOrNull(
        useSettings
          ? value(
              context.targetDoseWeight,
              numberOrNull(configuredNumber("Dose", NaN)),
            )
          : context.targetDoseWeight,
      ),
      yield: numberOrNull(
        useSettings
          ? value(
              context.targetYield,
              numberOrNull(configuredNumber("Yield", NaN)),
            )
          : context.targetYield,
      ),
      basket: textOrNull(
        useSettings ? value(extras.basket, settings.Basket) : extras.basket,
      ),
      beanType: textOrNull(
        useSettings
          ? value(extras.beanType, settings.BeanType)
          : extras.beanType,
      ),
      roastLevel: textOrNull(
        useSettings
          ? value(extras.roastLevel, settings.RoastLevel)
          : extras.roastLevel,
      ),
      profile: profileContent(profile),
      grinderSetting: textOrNull(
        useSettings
          ? value(context.grinderSetting, settings.CurrentSetting)
          : context.grinderSetting,
      ),
      settingUnit: textOrNull(
        useSettings
          ? value(extras.grinderSettingUnit, settings.SettingUnit)
          : extras.grinderSettingUnit,
      ),
    };
  }

  function validateConfirmedContext(context) {
    if (context == null) return {};
    if (typeof context !== "object" || Array.isArray(context))
      throw new Error("context must be an object");
    const result = Object.create(null);
    for (const key of Object.keys(context)) {
      if (!CONTEXT_FIELDS.includes(key))
        throw new Error("unsupported confirmed context field");
      if (key === "dose" || key === "yield") {
        if (!(numberOrNull(context[key]) > 0 && context[key] <= 1000))
          throw new Error("invalid confirmed dose/yield");
        result[key] = context[key];
      } else {
        const text = textOrNull(context[key]);
        if (!text || text.length > 256)
          throw new Error("invalid confirmed context");
        result[key] = text;
      }
    }
    return result;
  }
  function historicalContext(shot, mark) {
    const context = contextOf(shot, false);
    for (const [key, value] of Object.entries(mark?.confirmedContext || {})) {
      if (context[key] !== null && context[key] !== value)
        throw new Error("confirmed context conflicts with saved shot");
      context[key] = value;
    }
    return context;
  }
  async function fullShot(id) {
    const response = await apiRequest(
      `${API_BASE}/api/v1/shots/${encodeURIComponent(id)}`,
    );
    if (!response.ok) throw new Error("shot unavailable");
    const shot = await response.json();
    if (!shot || String(shot.id) !== String(id) || !shot.workflow)
      throw new Error("invalid shot");
    return shot;
  }
  async function currentWorkflow() {
    const response = await apiRequest(`${API_BASE}/api/v1/workflow`);
    if (!response.ok) throw new Error("workflow unavailable");
    const workflow = await response.json();
    if (
      !workflow ||
      typeof workflow !== "object" ||
      !workflow.profile ||
      !workflow.context
    )
      throw new Error("invalid workflow");
    return workflow;
  }

  function compare(current, candidate) {
    const missing = [];
    const mismatched = [];
    const unavailable = [];
    [
      "beanBatchId",
      "grinderId",
      "grinderModel",
      "burrIdentity",
      "calibrationEpoch",
      "dose",
      "yield",
      "basket",
      "profile",
      "settingUnit",
      "beanType",
      "roastLevel",
    ].forEach((key) => {
      const a = current[key];
      const b = candidate[key];
      if (a === null && b === null) {
        unavailable.push(key);
        return;
      }
      if (a === null || b === null) {
        missing.push(key);
        return;
      }
      if (String(a) !== String(b)) mismatched.push(key);
    });
    return {
      ok: missing.length === 0 && mismatched.length === 0,
      missing,
      mismatched,
      unavailable,
    };
  }

  async function loadStorage() {
    if (!active || storageUnavailable)
      throw new Error("feedback storage unavailable");
    if (storageReady) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        storageUnavailable = true;
        storageWaiters = storageWaiters.filter((entry) => entry !== waiter);
        reject(new Error("feedback storage timed out"));
      }, 5000);
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      storageWaiters.push(waiter);
    });
    if (!active || storageUnavailable)
      throw new Error("feedback storage unavailable");
  }
  function persist() {
    return new Promise((resolve, reject) => {
      if (!active || storageWriteBroken) {
        reject(new Error("feedback storage unavailable"));
        return;
      }
      const waiter = { resolve, reject };
      storageWriteWaiters.push(waiter);
      const timeout = setTimeout(() => {
        storageWriteBroken = true;
        storageWriteWaiters = storageWriteWaiters.filter(
          (entry) => entry !== waiter,
        );
        reject(new Error("feedback storage timed out"));
      }, 5000);
      waiter.resolve = () => {
        clearTimeout(timeout);
        resolve();
      };
      waiter.reject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      try {
        host.storage({ type: "write", key: STORAGE_KEY, data: feedback });
      } catch (error) {
        clearTimeout(timeout);
        storageWriteWaiters = storageWriteWaiters.filter(
          (entry) => entry !== waiter,
        );
        reject(new Error("feedback storage unavailable"));
      }
    });
  }
  function startStorage() {
    try {
      host.storage({ type: "read", key: STORAGE_KEY });
    } catch (_) {
      storageUnavailable = true;
      storageWaiters
        .splice(0)
        .forEach((waiter) =>
          waiter.reject(new Error("feedback storage unavailable")),
        );
    }
  }

  async function fetchShots() {
    if (cachedShots && Date.now() - cachedAt < 5000) return cachedShots;
    const result = [];
    const requestGeneration = cacheGeneration;
    let truncated = true;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await apiRequest(
        `${API_BASE}/api/v1/shots?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&order=desc`,
      );
      if (!response.ok)
        throw new Error(`Shot history unavailable (HTTP ${response.status})`);
      const data = await response.json();
      const plainArray = Array.isArray(data);
      if (!plainArray && (!data || !Array.isArray(data.items)))
        throw new Error("invalid shot history");
      const items = plainArray ? data : data.items;
      if (items.length > PAGE_SIZE) throw new Error("shot page exceeds limit");
      result.push(...items);
      const total =
        !plainArray && Number.isFinite(Number(data.total))
          ? Number(data.total)
          : null;
      if (
        items.length < PAGE_SIZE ||
        (total !== null && result.length >= total)
      ) {
        truncated = false;
        break;
      }
    }
    const snapshot = { items: result, truncated };
    if (!active) throw new Error("plugin unloaded");
    if (requestGeneration !== cacheGeneration)
      throw new Error("shot history changed");
    if (requestGeneration === cacheGeneration) cachedShots = snapshot;
    cachedAt = Date.now();
    return snapshot;
  }

  async function recommendation() {
    const requestEpoch = cacheGeneration;
    await loadStorage();
    await feedbackQueue;
    const history = await fetchShots();
    const shots = history.items;
    const workflow = await currentWorkflow();
    const recordedCurrent = contextOf({ workflow }, false);
    const current = contextOf({ workflow }, true);
    const userSuppliedCurrentFields = Object.keys(current).filter(
      (key) => recordedCurrent[key] === null && current[key] !== null,
    );
    if (requestEpoch !== cacheGeneration || !active)
      throw new Error("history changed during recommendation");
    const missingCurrent = ["beanBatchId", "grinderId", "profile"].filter(
      (key) => current[key] === null,
    );
    if (missingCurrent.length)
      return {
        status: "abstain",
        reason:
          "Current bean batch, grinder identity and profile execution content are required",
        missingData: missingCurrent,
        historyTruncated: history.truncated,
      };
    const considered = [];
    const abstentions = [];
    for (const shot of shots) {
      const mark = feedback[String(shot.id)];
      if (!mark?.good) continue;
      let candidate;
      try {
        candidate = historicalContext(shot, mark);
      } catch (_) {
        abstentions.push({
          shotId: shot.id,
          reason: "confirmed context conflicts with the saved shot",
        });
        continue;
      }
      if (!candidate.profile) {
        abstentions.push({ shotId: shot.id, missing: ["profile"] });
        continue;
      }
      if (!candidate.grinderSetting) {
        abstentions.push({
          shotId: shot.id,
          reason: "good shot has no recorded grinder setting",
        });
        continue;
      }
      const result = compare(current, candidate);
      if (result.ok)
        considered.push({
          shot,
          candidate,
          mark,
          unavailable: result.unavailable,
        });
      else
        abstentions.push({
          shotId: shot.id,
          missing: result.missing,
          mismatched: result.mismatched,
        });
    }
    considered.sort((a, b) =>
      String(b.shot.timestamp || "").localeCompare(
        String(a.shot.timestamp || ""),
      ),
    );
    if (!considered.length)
      return {
        status: "abstain",
        reason: history.truncated
          ? "Bounded history scan reached its limit; no safe recommendation can be claimed"
          : "No comparable marked-good shot found",
        missingData: abstentions.slice(0, 10),
        historyTruncated: history.truncated,
      };
    const selected = considered[0];
    return {
      status: "recommendation",
      sourceShotId: selected.shot.id,
      grinderSetting: selected.candidate.grinderSetting,
      recordedValue: true,
      comparison: {
        beanBatchId: current.beanBatchId,
        grinderId: current.grinderId,
        grinderModel: current.grinderModel,
        burrIdentity: current.burrIdentity,
        calibrationEpoch: current.calibrationEpoch,
        settingUnit: current.settingUnit,
        dose: current.dose,
        yield: current.yield,
        basket: current.basket,
        profile: "matching execution content",
        userSuppliedCurrentFields,
      },
      provenance:
        "user-marked-good local shot; workflow setting is intended, not verified hardware state",
      notes: selected.mark.notes || null,
      timestamp: selected.shot.timestamp || null,
      warnings: (selected.unavailable.length
        ? [
            `Comparison fields unavailable in both current setup and shot: ${selected.unavailable.join(", ")}`,
          ]
        : []
      ).concat(
        history.truncated
          ? ["History scan is bounded; older shots were not considered"]
          : [],
      ),
    };
  }

  function configuredNumber(key, fallback) {
    const raw = settings[key];
    if (raw == null || raw === "") return fallback;
    const parsed =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim()
          ? Number(raw)
          : NaN;
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  function dialNumber(raw) {
    return typeof raw === "string" &&
      /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim())
      ? Number(raw)
      : NaN;
  }
  function elapsedTime(shot) {
    const start = Date.parse(shot.timestamp);
    if (
      !Number.isFinite(start) ||
      !Array.isArray(shot.measurements) ||
      !shot.measurements.length
    )
      return null;
    let last = start;
    for (const measurement of shot.measurements) {
      const timestamp = Date.parse(measurement?.machine?.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < last) return null;
      last = timestamp;
    }
    const seconds = (last - start) / 1000;
    return seconds > 0 && seconds <= 600 ? seconds : null;
  }
  function dialReferenceFor(context, proposedSetting = null) {
    const profile = grinderDialTools.profileFor(context && context.grinderModel);
    if (!profile) return null;
    const normalized = String(profile.model).toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
    const catalogModel = (dialCatalog.models || []).find((item) => {
      const candidate = String(item.id || item.model || "").toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
      return candidate === normalized || grinderDialTools.profileFor(item.model)?.model === profile.model;
    }) || (profile.model === "DF64" ? { unit: "marks", zero: "Owner-confirmed zero; generation and burr identity must be recorded", markings: "Common 0–90-ish reference markings; not operating bounds", sources: [{url: "https://support.clivecoffee.com/en/articles/16426035-df64-single-dose-user-manual"}] } : null);
    const unit = textOrNull(context && context.settingUnit);
    const normalizedUnit = unit && unit.toLocaleLowerCase().replace(/[\u2010-\u2015]/g, "-").replace(/[_-]+/g, " ").trim();
    const researchCoordinate = normalizedUnit && ["dd", "d d", "deci micrometre", "deci micrometres", "deci micron"].includes(normalizedUnit);
    const profileUnit = String(profile.visibleUnit).toLocaleLowerCase();
    const nativeUnit = normalizedUnit && (normalizedUnit === profileUnit || (profile.algorithmScale && ["um", "µm", "micron", "microns", "micrometre", "micrometres"].includes(normalizedUnit)));
    let calibration = null;
    let calibrationError = null;
    if (settings.DialCalibration) {
      try {
        calibration = typeof settings.DialCalibration === "string" ? JSON.parse(settings.DialCalibration) : settings.DialCalibration;
        if (!calibration || typeof calibration !== "object" || Array.isArray(calibration)) throw new Error("DialCalibration must be a JSON object");
      } catch (error) {
        calibrationError = error.message;
      }
    }
    const toNative = (value) => {
      if (value == null || !Number.isFinite(Number(value))) return null;
      const numeric = Number(value);
      if (researchCoordinate || (nativeUnit && profile.algorithmScale)) {
        const converted = grinderDialTools.toGrinderDial({
          model: profile.model,
          ddDum: researchCoordinate ? numeric : numeric * profile.algorithmScale,
          calibration,
          burrIdentity: context.burrIdentity,
          calibrationEpoch: context.calibrationEpoch,
        });
        return converted.status === "normalized" && converted.visible ? { ...converted.visible, achievable: converted.achievable !== false } : null;
      }
      if (nativeUnit) return { value: numeric, unit: unit };
      return null;
    };
    let currentNative = null;
    let proposedNative = null;
    let nativeStatus = researchCoordinate || nativeUnit ? "available" : "unit-unrecognized";
    try {
      currentNative = toNative(context && context.grinderSetting);
      proposedNative = toNative(proposedSetting);
      if ((researchCoordinate || (nativeUnit && profile.algorithmScale)) && !currentNative) nativeStatus = calibrationError ? "invalid-calibration" : "calibration-required";
    } catch (error) {
      nativeStatus = "invalid-calibration";
      calibrationError = error.message;
    }
    return {
      model: profile.model,
      displayUnit: unit || (catalogModel && catalogModel.unit) || profile.visibleUnit,
      range: Array.isArray(profile.displayRange)
        ? { min: profile.displayRange[0], max: profile.displayRange[1] }
        : null,
      zeroMeaning: (catalogModel && catalogModel.zero) || profile.zeroReference || null,
      direction: researchCoordinate
        ? "dD is an internal research coordinate; it is not a physical dial reading"
        : profile.finerNumericDelta === -1
          ? "smaller values are finer"
          : profile.finerNumericDelta === 1
            ? "larger values are finer"
            : "fine/coarse direction requires owner calibration",
      calibrationStatus: currentNative && nativeStatus === "available"
        ? (researchCoordinate && !profile.algorithmScale ? "Owner-scoped mapping applied for display; not physical grinder certification" : "Native setting displayed in the reviewed profile unit")
        : researchCoordinate
        ? "physical dial mapping is not claimed"
        : profile.algorithmScale
          ? "native unit conversion from the reviewed grinder profile; verify firmware generation"
          : "owner calibration required before converting this dial to dD",
      notes: [profile.provenance, catalogModel && catalogModel.markings, ...(catalogModel && Array.isArray(catalogModel.notes) ? catalogModel.notes : [])].filter(Boolean).join(" "),
      photoUrl: profile.photoUrl || (catalogModel && catalogModel.image && catalogModel.image.url) || null,
      photoCaption: catalogModel && catalogModel.image ? catalogModel.image.caption : null,
      photoOwner: catalogModel && catalogModel.image ? catalogModel.image.owner : null,
      photoSourceUrl: catalogModel && catalogModel.image ? catalogModel.image.sourceUrl : null,
      sourceUrl: profile.sourceUrl || (catalogModel && catalogModel.sources && catalogModel.sources[0] && catalogModel.sources[0].url) || null,
      coordinateOnly: researchCoordinate,
      nativeStatus,
      currentNative,
      proposedNative,
      calibrationError,
      calibrationScope: calibration ? { model: calibration.model || null, burrIdentity: calibration.burrIdentity || null, calibrationEpoch: calibration.calibrationEpoch || null } : null,
    };
  }
  async function suggestion() {
    const generation = cacheGeneration;
    await loadStorage();
    await feedbackQueue;
    // Freeze feedback while awaiting full-shot requests. Subsequent changes fence the result.
    const marks = JSON.parse(JSON.stringify(feedback));
    const history = await fetchShots();
    const workflow = await currentWorkflow();
    const current = contextOf({ workflow }, true);
    const recorded = contextOf({ workflow }, false);
    const excluded = [],
      evidence = [];
    const base = {
      provider: "local-history-taste",
      requiresConfirmation: true,
      historyTruncated: history.truncated,
      sourceShotIds: [],
      excluded,
      evidence,
      provenance:
        "Saved workflow settings are intended values, not observed hardware state. Dose/yield are recipe targets. Timing is elapsed shot time, including preinfusion.",
      userSuppliedCurrentFields: Object.keys(current).filter(
        (key) => recorded[key] === null && current[key] !== null,
      ),
      dialReference: dialReferenceFor(current),
    };
    const abstain = (reason, extra = {}) => ({
      ...base,
      status: "abstain",
      reason,
      ...extra,
    });
    const missing = CONTEXT_FIELDS.filter(
      (key) => key !== "beanType" && key !== "roastLevel",
    )
      .concat("profile", "grinderSetting")
      .filter((key) => current[key] === null);
    if (!(current.dose > 0 && current.yield > 0))
      missing.push("positive dose/yield");
    if (missing.length)
      return abstain("Complete current setup and setting units are required", {
        missingData: missing,
      });
    const target = configuredNumber("TargetTimeSec", 30),
      tolerance = configuredNumber("TimeToleranceSec", 1),
      maxAge = configuredNumber("EvidenceMaxAgeDays", 14);
    if (
      !(
        target > 0 &&
        target <= 600 &&
        tolerance >= 0 &&
        tolerance < target &&
        maxAge > 0 &&
        maxAge <= 365
      )
    )
      return abstain("Invalid target time, tolerance or evidence age settings");
    const now = Date.now();
    const sorted = history.items
      .slice()
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const seen = new Set();
    for (const shot of sorted) {
      const id = String(shot.id),
        mark = marks[id];
      // Rich dial-in guidance may use an explicitly marked bad shot as
      // evidence: a negative cup is exactly what supplies the adjustment
      // direction. Basic recorded-good recommendations filter good:false
      // separately in recommendation().
      if (!mark || seen.has(id)) continue;
      seen.add(id);
      const reject = (reason) => excluded.push({ shotId: id, reason });
      const age = now - Date.parse(shot.timestamp);
      if (!Number.isFinite(age) || age < 0 || age > maxAge * 86400000) {
        reject("invalid, future or stale shot timestamp");
        continue;
      }
      let candidate;
      try {
        candidate = historicalContext(shot, mark);
      } catch (_) {
        reject("confirmed context conflicts with saved shot");
        continue;
      }
      const comparison = compare(current, candidate);
      if (
        !comparison.ok ||
        comparison.unavailable.some(
          (key) => key !== "beanType" && key !== "roastLevel",
        ) ||
        candidate.settingUnit !== current.settingUnit ||
        candidate.grinderSetting === null
      ) {
        excluded.push({
          shotId: id,
          reason:
            "setup, profile, bean type, roast level or setting units are incomplete or different",
          missing: comparison.missing,
          mismatched: comparison.mismatched,
          unavailable: comparison.unavailable,
        });
        continue;
      }
      const a = dialNumber(current.grinderSetting),
        b = dialNumber(candidate.grinderSetting);
      if (
        !(Number.isFinite(a) && Number.isFinite(b)
          ? a === b
          : current.grinderSetting === candidate.grinderSetting)
      ) {
        reject("shot used a different intended setting");
        continue;
      }
      let seconds = mark.brewTimeSec,
        timingProvenance = "operator-confirmed elapsed shot time";
      const full = await fullShot(id);
      {
        // Do not combine a stale summary's cohort with a newly edited full record.
        let complete;
        try {
          complete = historicalContext(full, mark);
        } catch (_) {
          reject("full-shot context conflicts with confirmation");
          continue;
        }
        if (
          JSON.stringify(canonical(candidate)) !==
            JSON.stringify(canonical(complete)) ||
          full.timestamp !== shot.timestamp
        ) {
          reject("shot changed during history lookup");
          continue;
        }
        if (seconds == null) {
          seconds = elapsedTime(full);
          timingProvenance =
            "saved machine timestamps: last measurement minus shot start";
        }
      }
      if (!(seconds > 0 && seconds <= 600)) {
        reject("elapsed shot time unavailable or invalid");
        continue;
      }
      evidence.push({
        shotId: id,
        elapsedTimeSec: seconds,
        timingProvenance,
        taste: mark.taste,
        flavour: mark.flavour || null,
        tasteSignals: tasteSignals(mark),
        metrics: createBrewMetrics().analyze(full, mark),
        unavailableComparisonFields: comparison.unavailable,
        good: mark.good,
        confirmedHistoricalFields: Object.keys(mark.confirmedContext || {}),
      });
      if (evidence.length === 6) break;
    }
    if (!active || generation !== cacheGeneration)
      throw new Error("history changed during suggestion");
    base.sourceShotIds = evidence.map((item) => item.shotId);
    let currentBeanCatalog = null;
    let reviewedReferences = null;
    if (evidence.length) {
      currentBeanCatalog = await beanContext();
      if (currentBeanCatalog.status !== "available")
        return abstain("Current bean catalog context is unavailable", {
          missingData: currentBeanCatalog.missingData || ["beanBatchId"],
        });
      reviewedReferences = reviewedReferenceContext(current, currentBeanCatalog);
      base.currentBeanCatalog = currentBeanCatalog;
      base.reviewedReferences = reviewedReferences;
    }
    if (evidence.length > 0 && evidence.length < 3) {
      // A new bean may have only one or two verified shots.  This path is
      // deliberately provisional: it requires the same complete setup and
      // explicit feedback as the mature cohort, but never claims a learned
      // slope from one or two observations.
      const catalog = currentBeanCatalog;
      const times = evidence
        .map((item) => item.elapsedTimeSec)
        .sort((a, b) => a - b);
      const median =
        (times[Math.floor((times.length - 1) / 2)] +
          times[Math.floor(times.length / 2)]) /
        2;
      const timeDirection =
        median < target - tolerance
          ? "finer"
          : median > target + tolerance
            ? "coarser"
            : null;
      const tastes = new Set(
        evidence.flatMap((item) => item.tasteSignals).filter(Boolean),
      );
      const timing = {
        medianElapsedTimeSec: median,
        targetTimeSec: target,
        toleranceSec: tolerance,
        timeDirection,
      };
      if (tastes.has("channeling"))
        return abstain(
          "Channeling feedback: inspect preparation before adjusting grind",
          timing,
        );
      if (tastes.has("weak"))
        return abstain(
          "Weak feedback needs extraction and preparation evidence",
          timing,
        );
      const tasteDirections = new Set();
      if (tastes.has("sour")) tasteDirections.add("finer");
      if (tastes.has("bitter") || tastes.has("astringent"))
        tasteDirections.add("coarser");
      if (
        tasteDirections.size > 1 ||
        (tastes.has("balanced") && tasteDirections.size)
      )
        return abstain("Taste feedback conflicts across provisional shots", timing);
      if (!tasteDirections.size)
        return abstain(
          tastes.has("balanced")
            ? "Balanced feedback: retain the setting and verify the target"
            : "Structured taste feedback is required alongside shot timing",
          timing,
        );
      const direction = Array.from(tasteDirections)[0];
      if (timeDirection && direction !== timeDirection)
        return abstain("Taste and timing suggest opposite adjustments", timing);
      const proposal = {
        ...base,
        ...timing,
        status: "suggestion",
        stage: "provisional",
        evidenceCount: evidence.length,
        direction,
        confidence: "provisional",
        beanContext: {
          beanBatchId: current.beanBatchId,
          beanType: current.beanType,
          roastLevel: current.roastLevel,
        },
        currentBeanCatalog: catalog,
        currentSetting: current.grinderSetting,
        settingUnit: current.settingUnit,
        proposedSetting: null,
        reason:
          "Provisional first-shot guidance from explicit taste and timing; no learned slope is claimed",
        warnings: [
          "Only one or two comparable shots are available; verify another shot before relying on this direction",
        ],
      };
      const currentNumber = dialNumber(current.grinderSetting);
      const step = configuredNumber("StepSize", 0);
      const sign = configuredNumber("NumericFinerDelta", 0);
      const min = configuredNumber("MinSetting", 0);
      const max = configuredNumber("MaxSetting", 0);
      if (
        Number.isFinite(currentNumber) &&
        step > 0 &&
        (sign === 1 || sign === -1) &&
        Number.isFinite(min) &&
        Number.isFinite(max) &&
        min < max &&
        currentNumber >= min &&
        currentNumber <= max
      ) {
        const next =
          currentNumber + step * sign * (direction === "finer" ? 1 : -1);
        if (!Number.isFinite(next) || next < min || next > max)
          return abstain(
            "The calibrated step would leave the confirmed dial bounds",
            timing,
          );
        proposal.proposedSetting = Number(next.toPrecision(12));
        proposal.numericProvenance =
          "one owner-calibrated step; not a firmware GBS prediction";
      } else {
        proposal.warnings.push(
          "Direction only: confirm a numeric setting, positive owner-calibrated step, finer sign and dial bounds",
        );
      }
      proposal.dialReference = dialReferenceFor(current, proposal.proposedSetting);
      return proposal;
    }
    if (evidence.length < 3)
      return abstain(
        "No comparable marked feedback shot is available at the current intended setting",
      );
    const times = evidence
      .map((item) => item.elapsedTimeSec)
      .sort((a, b) => a - b);
    const median =
      (times[Math.floor((times.length - 1) / 2)] +
        times[Math.floor(times.length / 2)]) /
      2;
    const timeDirection =
      median < target - tolerance
        ? "finer"
        : median > target + tolerance
          ? "coarser"
          : null;
    const tastes = new Set(
      evidence.flatMap((item) => item.tasteSignals).filter(Boolean),
    );
    const timing = {
      medianElapsedTimeSec: median,
      targetTimeSec: target,
      toleranceSec: tolerance,
      timeDirection,
    };
    if (tastes.has("channeling"))
      return abstain(
        "Channeling feedback: inspect preparation before adjusting grind",
        timing,
      );
    if (tastes.has("weak"))
      return abstain(
        "Weak feedback needs extraction and preparation evidence",
        timing,
      );
    const tasteDirections = new Set();
    if (tastes.has("sour")) tasteDirections.add("finer");
    if (tastes.has("bitter") || tastes.has("astringent"))
      tasteDirections.add("coarser");
    if (
      tasteDirections.size > 1 ||
      (tastes.has("balanced") && tasteDirections.size)
    )
      return abstain(
        "Taste feedback conflicts across comparable shots",
        timing,
      );
    if (!tasteDirections.size)
      return abstain(
        tastes.has("balanced")
          ? "Balanced feedback: retain the setting and verify the target"
          : "Structured taste feedback is required alongside shot timing",
        timing,
      );
    const direction = Array.from(tasteDirections)[0];
    if (timeDirection && direction !== timeDirection)
      return abstain("Taste and timing suggest opposite adjustments", timing);
    const proposal = {
      ...base,
      ...timing,
      status: "suggestion",
      direction,
      confidence: "heuristic",
      beanContext: {
        beanBatchId: current.beanBatchId,
        beanType: current.beanType,
        roastLevel: current.roastLevel,
      },
      currentBeanCatalog,
      reviewedReferences,
      currentSetting: current.grinderSetting,
      settingUnit: current.settingUnit,
      proposedSetting: null,
      reason: timeDirection
        ? "Taste and median elapsed time agree"
        : "Taste suggests an adjustment; median elapsed time is within the target window",
      warnings: history.truncated
        ? ["History scan is bounded; older shots were not considered"]
        : [],
    };
    if (evidence.some((item) => item.unavailableComparisonFields.length))
      proposal.warnings.push(
        "Bean type and/or roast level are missing in both records; batch identity is matched, but no roast-specific adjustment is claimed",
      );
    const currentNumber = dialNumber(current.grinderSetting),
      step = configuredNumber("StepSize", 0),
      sign = configuredNumber("NumericFinerDelta", 0),
      min = configuredNumber("MinSetting", 0),
      max = configuredNumber("MaxSetting", 0);
    if (
      !(
        Number.isFinite(currentNumber) &&
        step > 0 &&
        (sign === 1 || sign === -1) &&
        Number.isFinite(min) &&
        Number.isFinite(max) &&
        min < max &&
        currentNumber >= min &&
        currentNumber <= max
      )
    ) {
      proposal.warnings.push(
        "Direction only: confirm a numeric setting, positive owner-calibrated step, finer sign and dial bounds",
      );
    } else {
      const next =
        currentNumber + step * sign * (direction === "finer" ? 1 : -1);
      if (!Number.isFinite(next) || next < min || next > max)
        return abstain(
          "The calibrated step would leave the confirmed dial bounds",
          timing,
        );
      proposal.proposedSetting = Number(next.toPrecision(12));
      proposal.numericProvenance =
        "one owner-calibrated step; not a firmware GBS prediction";
    }
    proposal.dialReference = dialReferenceFor(current, proposal.proposedSetting);
    return proposal;
  }
  function research(request) {
    if (typeof request.body === "string" && request.body.length > 32768)
      throw new Error("research request exceeds 32 KiB");
    const data = bodyOf(request);
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      typeof data.operation !== "string" ||
      !data.input ||
      typeof data.input !== "object" ||
      Array.isArray(data.input)
    )
      throw new Error("operation and input object are required");
    if (JSON.stringify(data).length > 32768)
      throw new Error("research request exceeds 32 KiB");
    const algorithms = createResearchAlgorithms(),
      operation = data.operation;
    const native = operation !== "manual";
    if (native && data.firmwareBuild !== algorithms.firmwareBuild)
      throw new Error("acknowledge the researched firmwareBuild");
    if (native && data.coordinateUnit !== "deci-micrometre")
      throw new Error(
        "acknowledge input coordinateUnit deci-micrometre; wizard output unit remains unknown",
      );
    let result;
    if (operation === "adjust") {
      const scope = data.scope;
      if (
        !scope ||
        typeof scope !== "object" ||
        Array.isArray(scope) ||
        [
          "grinderId",
          "beanBatchId",
          "burrIdentity",
          "calibrationEpoch",
          "profile",
        ].some((key) => !textOrNull(scope[key]) || scope[key].length > 1024)
      )
        throw new Error("complete replay scope is required");
      const scopeIdentity = canonical(
        Object.fromEntries(
          [
            "grinderId",
            "beanBatchId",
            "burrIdentity",
            "calibrationEpoch",
            "profile",
          ].map((key) => [key, scope[key]]),
        ),
      );
      const envelope = data.stateEnvelope;
      if (
        envelope &&
        (envelope.version !== 1 ||
          envelope.algorithm !== data.algorithm ||
          envelope.firmwareBuild !== data.firmwareBuild ||
          envelope.coordinateUnit !== data.coordinateUnit ||
          JSON.stringify(canonical(envelope.scope)) !==
            JSON.stringify(scopeIdentity))
      )
        throw new Error(
          "state envelope version, algorithm, firmware, unit or scope mismatch",
        );
      const state = envelope
        ? envelope.state
        : algorithms.createState(data.algorithm, data.options);
      const step = algorithms.adjust(data.algorithm, state, data.input);
      result = {
        result: step.result,
        stateEnvelope: {
          version: 1,
          algorithm: data.algorithm,
          firmwareBuild: data.firmwareBuild,
          coordinateUnit: data.coordinateUnit,
          scope: scopeIdentity,
          state: step.nextState,
        },
      };
    } else if (operation === "inverseRegression")
      result = {
        result: algorithms.inverseRegression(
          data.input.points,
          data.input.targetSec,
        ),
      };
    else if (operation === "proposedDd")
      result = { result: algorithms.proposedDd(data.input) };
    else if (operation === "ddEff")
      result = {
        result: algorithms.ddEff(data.input.initialDdDum, data.input.calls),
      };
    else if (operation === "effectiveDd")
      result = {
        ...algorithms.effectiveDd(data.input.state, data.input),
        modelBoundary:
          "Second interpolation baseline is caller-selected; firmware field coupling is unresolved. The baseline and residue are micrometres, the result is deci-micrometres.",
      };
    else if (operation === "grindTime")
      result = { result: algorithms.grindTime(data.input) };
    else if (operation === "manual")
      result = { result: algorithms.manual(data.input) };
    else throw new Error("unknown research operation");
    function validateResult(value) {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Error("calculation exceeded finite numeric bounds");
      if (value && typeof value === "object")
        Object.values(value).forEach(validateResult);
    }
    validateResult(result);
    return {
      provider: native
        ? "recovered-firmware-replay"
        : "DF54/DF64-community-heuristic",
      researchRevision: "efcf12fb5366d628468ce02117f5905c32474b41",
      firmwareBuild: native ? algorithms.firmwareBuild : null,
      requiresConfirmation: true,
      provenance: native
        ? "Static recovered formulas; caller-supplied simulation inputs and state. Not hardware validation."
        : "Community manual-adjustment heuristic; not recovered GBS firmware.",
      ...result,
    };
  }

  const page = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Assisted dial-in</title>
<style>body{font:16px system-ui;max-width:46rem;margin:2rem auto;padding:0 1rem}button,input,select,textarea{font:inherit;padding:.5rem}label{display:block;margin:.5rem 0}textarea{width:100%;min-height:9rem}output{display:block;margin-top:1rem;white-space:pre-wrap}</style>
<h1>Assisted dial-in</h1>
<p>This assistant recommends recorded settings and manual guidance. It never changes a machine.</p>
<button id="recommend" type="button">Find recorded recommendation</button>
<h2>Richer suggestion</h2>
<p>Each marked shot adds evidence. Early suggestions are cautious; repeated comparable shots make the direction more reliable. Configure the current setup and timing target in plugin settings.</p>
<button id="suggestion" type="button">Suggest next step</button>
<h2>Bean context and brew analysis</h2>
<button id="beans" type="button">Show current bean and roast catalog</button>
<button id="references" type="button">Recipe and grinder references</button>
<p>The current catalog may have changed since an older brew. Confirm historical bean type and roast explicitly in that shot feedback.</p>
<label>Recent shot <select id="shotSelect"><option value="">Load shots to choose one</option></select></label>
<button id="loadShots" type="button">Load recent shots</button>
<a id="returnLink" hidden>Return to Streamline</a>
<form id="analysis"><label>Shot ID <input required name="shotId"></label><button type="submit">Analyse saved brew metrics</button></form>
<details><summary>Advanced: replay research calculations</summary>
<h2>Advanced research replay</h2>
<p><a href="https://github.com/MaxRink/decaid-assisted-dialin-plugin/blob/main/docs/GBS_GUIDE.md" target="_blank" rel="noopener">Read the calculation guide</a></p>
<form id="research">
  <p>Software replay only. The calculator does not contact hardware or infer physical dial direction.</p>
  <label>Calculator request JSON<textarea name="state" aria-label="Research replay JSON">{"operation":"adjust","algorithm":"GbS2","firmwareBuild":"HEM-HSG-HMI-S01 V01.16-24","coordinateUnit":"deci-micrometre","scope":{"grinderId":"synthetic-grinder","beanBatchId":"synthetic-beans","burrIdentity":"synthetic-burrs","calibrationEpoch":"simulation-1","profile":"synthetic-profile"},"input":{"actualBrewTimeMs":30000,"targetBrewTimeMs":28000,"estimatedDdDum":500,"setpointDdDum":500,"toleranceMs":1000}}</textarea></label>
  <p>This sample uses synthetic inputs. To replay the next shot, copy the returned stateEnvelope into the request and update input. Keep scope unchanged only for the same setup. Other operations and units are documented in README.</p>
  <button type="submit">Run software replay</button>
</form>
</details>
<output id="result" aria-live="polite"></output>
<details id="reviewedReferences" hidden><summary>Reviewed references used for this suggestion</summary><ul id="referenceList"></ul></details>
<details id="dialReference" hidden><summary>Physical grinder dial reference</summary><div id="dialReferenceBody"></div></details>
<h2>Feedback after a brew</h2>
<form id="feedback">
  <label>Shot ID <input required name="shotId"></label>
  <label>Notes <input name="notes"></label>
  <label>Flavour descriptors <input name="descriptors" placeholder="plum, chocolate, floral"></label>
  <label>Overall extraction assessment <select name="overall"><option value="">Unspecified</option><option value="balanced">Balanced</option><option value="under-extracted">Under-extracted</option><option value="over-extracted">Over-extracted</option><option value="uncertain">Uncertain</option></select></label>
  <p>Optional intensities: 0 absent, 5 very strong. Acidity alone does not prove under-extraction.</p>
  <label>Acidity <input name="acidity" type="number" min="0" max="5" step="1"></label>
  <label>Bitterness <input name="bitterness" type="number" min="0" max="5" step="1"></label>
  <label>Sweetness <input name="sweetness" type="number" min="0" max="5" step="1"></label>
  <label>Body <input name="body" type="number" min="0" max="5" step="1"></label>
  <label>Astringency <input name="astringency" type="number" min="0" max="5" step="1"></label>
  <label>Taste
    <select name="taste">
      <option value="">No taste signal</option>
      <option value="balanced">Balanced</option>
      <option value="sour">Sour / acidic</option>
      <option value="bitter">Bitter / dry</option>
      <option value="astringent">Astringent / harsh</option>
      <option value="weak">Weak</option>
      <option value="channeling">Channeling</option>
    </select>
  </label>
  <label>Brew time (seconds, optional) <input name="brewTimeSec" type="number" min="0" step="0.1"></label>
  <details>
    <summary>Confirm historical context manually</summary>
    <p>These values are sent only when you confirm them. Today's settings never fill historical shot data.</p>
    <label>Bean type / species or blend <input name="beanType" autocomplete="off"></label>
    <label>Roast level <input name="roastLevel" autocomplete="off"></label>
    <label>Burr identity <input name="burrIdentity" autocomplete="off"></label>
    <label>Calibration epoch <input name="calibrationEpoch" autocomplete="off"></label>
    <label>Basket <input name="basket" autocomplete="off"></label>
    <label>Setting unit <input name="settingUnit" placeholder="owner-calibrated marks" autocomplete="off"></label>
    <label>Bean batch ID <input name="beanBatchId" autocomplete="off"></label>
    <label>Grinder identity <input name="grinderId" autocomplete="off"></label>
    <label>Grinder model <input name="grinderModel" autocomplete="off"></label>
    <label>Dose (g) <input name="dose" type="number" min="0" step="0.1"></label>
    <label>Yield (g) <input name="yield" type="number" min="0" step="0.1"></label>
  </details>
  <details>
    <summary>Optional bean weighing record</summary>
    <p>This is a separate scale observation. It is never silently used as the recipe dose or historical shot dose.</p>
    <label><input name="confirmBeanMeasurement" type="checkbox"> Confirm these beans were weighed for this shot</label>
    <label>Scale device ID <input name="beanScaleId" autocomplete="off"></label>
    <label>Scale role <input name="beanScaleRole" value="auxiliary" readonly></label>
    <label>Bean weight (g) <input name="beanWeight" type="number" min="0" step="0.01"></label>
    <label>Captured at <input name="beanCapturedAt" type="datetime-local"></label>
    <label>Scale sample timestamp (optional) <input name="beanSampleTimestamp" type="datetime-local"></label>
  </details>
  <button name="good" value="true">Mark good</button>
  <button name="good" value="false">Mark as not a good result</button>
</form>
<script>
const out=document.querySelector('#result');
const basePath=typeof location!=='undefined'&&location.pathname?location.pathname.endsWith('/ui')?location.pathname.slice(0,-3):location.pathname:'';
const requestState={generation:0};
const endpoint=name=>basePath?basePath+'/'+name:name;
const fail=(message,generation)=>{if(generation===undefined||generation===requestState.generation)out.textContent=message;};
const failRequest=(error,message)=>{if(!error.generation||error.generation===requestState.generation)fail(message);};
const value=(object,...keys)=>{for(const key of keys)if(object&&object[key]!==null&&object[key]!==undefined&&object[key]!=='')return object[key];return null;};
const referenceDetails=document.querySelector('#reviewedReferences');const referenceList=document.querySelector('#referenceList');const dialDetails=document.querySelector('#dialReference');const dialBody=document.querySelector('#dialReferenceBody');
const humanKey=key=>{const labels={doseG:'Dose (g)',yieldG:'Beverage yield (g)',brewTimeSec:'Brew time (s)',temperatureC:'Temperature (°C)',flowMlPerSec:'Flow (ml/s)',pressureBar:'Pressure (bar)'};return labels[key]||String(key).replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]+/g,' ').replace(/^./,char=>char.toUpperCase());};
const humanFact=(key,value)=>{if(value===null||value===undefined||value==='')return 'not recorded';if(Array.isArray(value))return value.map(item=>humanFact(key,item)).join(', ');if(typeof value==='object'){if(value.min!==undefined||value.max!==undefined){const low=value.min===undefined?'':String(value.min);const high=value.max===undefined?'':String(value.max);return low&&high?low+'–'+high+(value.unit?' '+value.unit:''):low||high+(value.unit?' '+value.unit:'');}return Object.entries(value).map(([childKey,childValue])=>humanKey(childKey)+': '+humanFact(childKey,childValue)).join('; ');}return String(value)+(key==='temperatureC'?' °C':'');};
const humanFacts=object=>Object.entries(object||{}).map(([key,value])=>humanKey(key)+': '+humanFact(key,value)).join('; ');
const safeReferenceUrl=url=>{try{const parsed=new URL(String(url));return parsed.protocol==='https:'&&!parsed.username&&!parsed.password?parsed.href:null;}catch(e){return null;}};
const dialValue=(reference,...keys)=>{for(const key of keys)if(reference&&reference[key]!==null&&reference[key]!==undefined&&reference[key]!=='')return reference[key];return null;};
const formatDialValue=(value,unit)=>value===null||value===undefined||value===''?'unavailable':String(value)+(unit?' '+unit:'');
const renderDialReference=body=>{if(!dialDetails||!dialBody)return;dialBody.textContent='';const reference=body&&body.dialReference;if(!reference||typeof reference!=='object'){dialDetails.hidden=true;return;}const unit=dialValue(reference,'displayUnit','unit')||body.settingUnit||null;const model=dialValue(reference,'model','name')||body.grinderModel;const coordinateOnly=reference.coordinateOnly===true;const nativeAvailable=reference.nativeStatus==='available'&&reference.currentNative;const currentNative=nativeAvailable?reference.currentNative:null;const proposedNative=reference.nativeStatus==='available'&&reference.proposedNative?reference.proposedNative:null;const range=reference.range&&typeof reference.range==='object'?reference.range:null;const lines=[model&&(nativeAvailable?'Grinder: '+model:'Grinder profile: '+model),nativeAvailable&&'Current physical dial: '+formatDialValue(currentNative.value,currentNative.unit),nativeAvailable&&proposedNative&&'Suggested physical dial: '+formatDialValue(proposedNative.value,proposedNative.unit),!nativeAvailable&&body.currentSetting!==undefined&&(coordinateOnly?'Current research coordinate: ':'Recorded setting: ')+formatDialValue(body.currentSetting,unit),!nativeAvailable&&body.proposedSetting!==undefined&&body.proposedSetting!==null&&(coordinateOnly?'Suggested research coordinate: ':'Suggested recorded setting: ')+formatDialValue(body.proposedSetting,unit),range&&nativeAvailable&&('Reference markings: '+formatDialValue(range.min,unit)+' to '+formatDialValue(range.max,unit)+' (not operating limits)'),dialValue(reference,'zeroMeaning','zeroPoint')&&'Zero point: '+dialValue(reference,'zeroMeaning','zeroPoint'),dialValue(reference,'direction','finerDirection')&&'Direction: '+dialValue(reference,'direction','finerDirection'),dialValue(reference,'calibrationStatus','calibration')&&'Calibration: '+dialValue(reference,'calibrationStatus','calibration'),reference.calibrationError&&'Native conversion withheld: '+reference.calibrationError,dialValue(reference,'notes','conversionNote')&&'How to read it: '+dialValue(reference,'notes','conversionNote')].filter(Boolean);const text=document.createElement('p');text.textContent=lines.join(' — ');dialBody.appendChild(text);const imageUrl=safeReferenceUrl(dialValue(reference,'photoUrl','imageUrl'));if(imageUrl){const image=document.createElement('img');image.src=imageUrl;image.alt=reference.photoCaption||(model||'Grinder')+' dial reference photo';image.loading='lazy';if(image.style)image.style.maxWidth='100%';dialBody.appendChild(image);if(reference.photoOwner){const credit=document.createElement('p');credit.textContent=[reference.photoCaption,'Photo: '+reference.photoOwner].filter(Boolean).join(' — ');dialBody.appendChild(credit);}}const sourceUrl=safeReferenceUrl(dialValue(reference,'photoSourceUrl','sourceUrl'));if(sourceUrl){const link=document.createElement('a');link.href=sourceUrl;link.target='_blank';link.rel='noopener';link.textContent='Open dial reference source';dialBody.appendChild(link);}dialDetails.hidden=false;};
const renderReferenceDetails=references=>{if(!referenceDetails||!referenceList)return;referenceList.textContent='';const matches=references&&Array.isArray(references.matches)?references.matches:[];if(!matches.length){referenceDetails.hidden=true;return;}matches.forEach(source=>{const item=document.createElement('li');const link=document.createElement('a');const safeUrl=safeReferenceUrl(source.url);if(safeUrl){link.href=safeUrl;link.target='_blank';link.rel='noopener';}link.textContent=source.title||source.publisher||'Reviewed reference';item.appendChild(link);const details=document.createElement('p');const scope=source.scope&&typeof source.scope==='object'?humanFacts(source.scope):String(source.scope||'Contextual reference');const facts=humanFacts(source.facts);const notes=Array.isArray(source.notes)?source.notes.join(' '):String(source.notes||'');details.textContent=[source.publisher,scope&&'Scope: '+scope,facts&&'Facts: '+facts,notes&&'Notes: '+notes].filter(Boolean).join(' — ');item.appendChild(details);referenceList.appendChild(item);});referenceDetails.hidden=false;};

const render=({endpoint:name,body})=>{
  if(name==='recommendation')return body.status==='recommendation'?'Recorded recommendation\\nSetting: '+body.grinderSetting+'\\nSource shot: '+body.sourceShotId+'\\n\\n'+(body.notes||'No note saved.'):'No safe recommendation\\n'+(body.reason||'Comparable history is unavailable.');
  if(name==='suggestion'){const evidenceCount=body.evidenceCount??(body.sourceShotIds||[]).length;if(body.status!=='suggestion'&&body.status!=='provisional'&&body.status!=='established')return 'No safe adjustment\\n'+(body.reason||'The evidence is incomplete or conflicting.');const provisional=body.status==='provisional'||(body.status==='suggestion'&&evidenceCount<3);const heading=provisional?'Early manual next step':'Manual adjustment suggestion';const caution=provisional?'One or two comparable shots are only an early signal. Confirm the next brew and keep collecting evidence.':'Repeated comparable shots support this direction; confirm it manually before changing the grinder.';const reference=body.dialReference&&typeof body.dialReference==='object'?body.dialReference:null;const unit=(reference&&(reference.displayUnit||reference.unit))||body.settingUnit||'';const cn=reference&&reference.nativeStatus==='available'&&reference.currentNative;const pn=reference&&reference.nativeStatus==='available'&&reference.proposedNative;const research=reference&&reference.coordinateOnly;const current=cn?formatDialValue(cn.value,cn.unit):body.currentSetting==null?'unavailable':formatDialValue(body.currentSetting,unit);const proposed=pn?formatDialValue(pn.value,pn.unit)+(pn.achievable===false?' (between physical steps; choose a neighboring step)':''):body.proposedSetting==null?'confirm manually':formatDialValue(body.proposedSetting,unit);const currentLabel=cn?'Current physical dial':research?'Current research coordinate':'Recorded setting';const proposedLabel=pn?'Proposed physical dial':research?'Proposed research coordinate':'Proposed recorded setting';return heading+'\\nDirection: '+(body.direction||'confirm manually')+'\\n'+currentLabel+': '+current+'\\n'+proposedLabel+': '+proposed+'\\nEvidence shots: '+evidenceCount+'\\n\\n'+caution+'\\n'+(body.reason||'');}
  if(name==='references'){const sources=body.sources||[];return 'Reviewed recipe and grinder references\\n'+sources.map(source=>(source.title||source.publisher||'Reference')+'\\n'+(safeReferenceUrl(source.url)||'')+'\\n'+(source.scope?'Scope: '+(typeof source.scope==='object'?humanFacts(source.scope):source.scope):'')+'\\n'+(source.facts?'Facts: '+humanFacts(source.facts):'')+'\\n'+(Array.isArray(source.notes)?'Notes: '+source.notes.join(' '):'')).join('\\n\\n')+'\\n\\n'+(body.provenance||'');}
  if(name==='bean-context'){const bean=body.bean||{},batch=body.batch||{};if(body.status!=='available')return 'Bean context unavailable\\n'+(body.missingData||[]).join(', ');const nameLine=[bean.name,bean.roaster].filter(Boolean).join(' — ')||'Unknown bean';const species=bean.species?'\\nSpecies: '+bean.species:'';return 'Current bean catalog\\n'+nameLine+species+(bean.variety?'\\nVariety: '+(Array.isArray(bean.variety)?bean.variety.join(', '):bean.variety):'')+'\\nProcessing: '+(bean.processing||'unknown')+'\\nOrigin: '+[bean.country,bean.region].filter(Boolean).join(', ')+'\\nRoast: '+(batch.roastLevel||'unknown')+(batch.roastDate?' ('+batch.roastDate+')':'')+'\\n\\n'+(body.provenance||'');}
  if(name==='analysis'){const metrics=body.metrics||{},machine=metrics.machine||{},scale=metrics.scale||{};const mae=part=>part&&part.timeWeightedMae!==undefined?Number(part.timeWeightedMae).toFixed(2):'unavailable';const feedback=body.feedback?(body.feedback.good?'good':'not marked good')+(body.feedback.flavour&&body.feedback.flavour.overall?', '+body.feedback.flavour.overall:''):'none';const measured=body.measuredBeanDose||metrics.measuredBeanDose;const measuredText=measured?'\\nBeans weighed for this shot: '+measured.weightG+' g ('+measured.deviceId+', '+measured.connectionRole+')':'\\nBeans weighed for this shot: none recorded';const warnings=(metrics.warnings||[]).concat(scale.warnings||[]);const warningText=warnings.length?'\\nWarnings: '+warnings.join(' | '):'';return 'Saved brew analysis: '+body.shotId+'\\nElapsed: '+(metrics.elapsedSec??'unavailable')+' s\\nAverage pressure difference from target: '+mae(machine.pressure)+' bar\\nAverage flow difference from target: '+mae(machine.flow)+' ml/s\\nAverage mix temperature difference from target: '+mae(machine.mixTemperature)+' °C\\nAverage group temperature difference from target: '+mae(machine.groupTemperature)+' °C\\nScale yield: '+(scale.finalMeasuredWeightG??'unavailable')+' g\\nScale flow: '+(scale.brewFlowGPerSec??'unavailable')+' g/s'+measuredText+'\\nMeasured bean ratio: '+((metrics.annotations&&metrics.annotations.actualYieldToMeasuredBeanDoseRatio)??'unavailable')+warningText+'\\n\\nThese are descriptive differences from recorded targets; they do not diagnose extraction.\\nFeedback: '+feedback+'\\n'+(body.provenance||'');}
  if(name==='feedback')return body.saved?'Feedback saved for shot '+body.shotId+'.':(body.reason||body.error||'Feedback was not saved.');
  return body.provenance?body.provenance+'\\n\\n'+JSON.stringify(body,null,2):JSON.stringify(body,null,2);
};
const show=async(name,init,label)=>{const generation=++requestState.generation;out.textContent=label||'Loading...';try{const r=await fetch(endpoint(name),init);const body=await r.json();if(!r.ok){if(generation===requestState.generation)out.textContent=body.error||'The request could not be completed.';return body;}if(generation===requestState.generation){out.textContent=render({endpoint:name,body});renderReferenceDetails(body.reviewedReferences);renderDialReference(body);}return body;}catch(e){e.generation=generation;fail('Could not load this information. Try again.',generation);throw e;}};
const setShotId=id=>{const input=document.querySelector('#analysis input[name="shotId"]');const feedback=document.querySelector('#feedback input[name="shotId"]');if(input&&id)input.value=id;if(feedback&&id)feedback.value=id;};
const refreshShots=async()=>{const generation=++requestState.generation;out.textContent='Loading recent shots...';try{const r=await fetch(endpoint('shots'));const body=await r.json();if(!r.ok)throw new Error('request failed');if(generation!==requestState.generation)return;const select=document.querySelector('#shotSelect');if(select&&typeof document.createElement==='function'){select.textContent='';(body.items||[]).forEach(shot=>{const option=document.createElement('option');option.value=String(shot.id);option.textContent=String(shot.id)+' — '+(shot.timestamp||'undated');select.appendChild(option);});if(body.items?.length)setShotId(String(body.items[0].id));}out.textContent='Loaded '+(body.items||[]).length+' recent shots. Choose one for analysis or feedback.';}catch(e){fail('Could not load recent shots. Try again.',generation);}};
document.querySelector('#recommend').onclick=async()=>{try{await show('recommendation',undefined,'Loading recommendation...')}catch(e){failRequest(e,'Could not load recommendation. Try again.')}};
document.querySelector('#suggestion').onclick=async()=>{try{await show('suggestion',undefined,'Calculating suggestion...')}catch(e){failRequest(e,'Could not calculate suggestion. Try again.')}};
document.querySelector('#beans').onclick=async()=>{try{await show('bean-context',undefined,'Loading bean context...')}catch(e){failRequest(e,'Could not load current bean context. Try again.')}};
const referencesButton=document.querySelector('#references');if(referencesButton)referencesButton.onclick=async()=>{try{await show('references',undefined,'Loading reviewed references...')}catch(e){failRequest(e,'Could not load references. Try again.')}};
const loadShotsButton=document.querySelector('#loadShots');
if(loadShotsButton)loadShotsButton.onclick=refreshShots;
const shotSelect=document.querySelector('#shotSelect');
if(shotSelect)shotSelect.onchange=e=>setShotId(e.target.value);
document.querySelector('#analysis').onsubmit=async e=>{e.preventDefault();try{await show('analysis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shotId:new FormData(e.target).get('shotId')})},'Analysing saved brew...')}catch(e){failRequest(e,'Could not analyse the brew. Try again.')}};
document.querySelector('#research').onsubmit=async e=>{e.preventDefault();let data;try{data=JSON.parse(new FormData(e.target).get('state'))}catch(e){fail('Research replay JSON is invalid.');return}try{await show('research',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)},'Replaying software state...')}catch(e){failRequest(e,'Could not run research replay. Try again.')}};
let feedbackBusy=false;const feedbackForm=document.querySelector('#feedback');const feedbackButtons=typeof document.querySelectorAll==='function'?document.querySelectorAll('#feedback button'):[];const resetFeedbackBusy=()=>{feedbackBusy=false;feedbackButtons.forEach(button=>button.disabled=false);};feedbackForm.onsubmit=async e=>{e.preventDefault();if(feedbackBusy)return;feedbackBusy=true;feedbackButtons.forEach(button=>button.disabled=true);try{const f=new FormData(e.target);const context={};['burrIdentity','calibrationEpoch','basket','settingUnit','beanBatchId','grinderId','grinderModel','beanType','roastLevel'].forEach(k=>{const v=f.get(k);if(v)context[k]=v});['dose','yield'].forEach(k=>{const v=f.get(k);if(v!=='')context[k]=Number(v)});const raw=f.get('brewTimeSec');const flavour={};const descriptors=f.get('descriptors');if(descriptors.trim())flavour.descriptors=descriptors.split(',').map(v=>v.trim()).filter(Boolean);const overall=f.get('overall');if(overall)flavour.overall=overall;['acidity','bitterness','sweetness','body','astringency'].forEach(k=>{const v=f.get(k);if(v!=='')flavour[k]=Number(v)});const measurementConfirmed=f.get('confirmBeanMeasurement')==='on'||f.get('confirmBeanMeasurement')==='true';let measuredBeanDose=null;if(measurementConfirmed){const weight=Number(f.get('beanWeight'));const capturedAt=f.get('beanCapturedAt');const scaleId=f.get('beanScaleId');const capturedDate=capturedAt?new Date(capturedAt):null;const sampleValue=f.get('beanSampleTimestamp');const sampleDate=sampleValue?new Date(sampleValue):null;if(!scaleId||!Number.isFinite(weight)||weight<=0||!capturedDate||Number.isNaN(capturedDate.getTime())||(sampleDate&&!Number.isFinite(sampleDate.getTime()))){throw new Error('Confirm a positive bean weight, scale ID and valid capture time.');}measuredBeanDose={deviceId:scaleId,connectionRole:'auxiliary',purpose:'beans',weightG:weight,units:'g',capturedAt:capturedDate.toISOString(),sampleTimestamp:sampleDate?sampleDate.toISOString():null,userConfirmed:true};}await show('feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shotId:f.get('shotId'),good:(e.submitter?.value||'true')==='true',notes:f.get('notes'),taste:f.get('taste')||null,flavour:Object.keys(flavour).length?flavour:null,brewTimeSec:raw===''?null:Number(raw),confirmedContext:context,...(measuredBeanDose?{measuredBeanDose}: {})})},'Saving feedback...');}catch(e){if(e.message&&e.message.startsWith('Confirm a positive'))fail(e.message);else failRequest(e,'Could not save feedback. Try again.');}finally{resetFeedbackBusy();}};
try{const query=new URLSearchParams(typeof location!=='undefined'&&location.search?location.search:'');const shotId=query.get('shotId');if(shotId)setShotId(shotId);const action=query.get('action');if(action==='analyze'&&shotId)show('analysis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shotId:shotId})},'Analysing saved brew...').catch(e=>failRequest(e,'Could not analyse the brew. Try again.'));if(action==='feedback'){const feedbackShot=document.querySelector('#feedback input[name=\"shotId\"]');if(feedbackShot&&feedbackShot.focus)feedbackShot.focus();}const measurementFields={beanScaleId:query.get('beanScaleId'),beanScaleRole:query.get('beanScaleRole')||'auxiliary',beanWeight:query.get('beanWeight'),beanCapturedAt:query.get('beanCapturedAt'),beanSampleTimestamp:query.get('beanSampleTimestamp')};Object.keys(measurementFields).forEach(key=>{const input=document.querySelector('#feedback input[name=\"'+key+'\"]');if(input&&measurementFields[key])input.value=measurementFields[key];});const returnValue=query.get('returnTo')||query.get('return');const returnLink=document.querySelector('#returnLink');if(returnLink&&returnValue){const here=typeof location!=='undefined'?new URL(location.href):new URL('http://127.0.0.1/');const target=new URL(returnValue,here.href);if((target.protocol===here.protocol&&(target.protocol==='http:'||target.protocol==='https:'))&&!target.username&&!target.password&&target.hostname===here.hostname&&target.pathname.startsWith('/')){returnLink.href=target.href;returnLink.hidden=false;}}}catch(e){}
</script>`;

  return {
    id: ID,
    version: "0.2.0",
    onLoad(nextSettings) {
      sessionEpoch += 1;
      cacheGeneration += 1;
      active = true;
      settings = nextSettings || {};
      startStorage();
    },
    onUnload() {
      sessionEpoch += 1;
      active = false;
      cacheGeneration += 1;
      cachedShots = null;
      storageUnavailable = true;
      storageWaiters
        .splice(0)
        .forEach((waiter) => waiter.reject(new Error("plugin unloaded")));
      storageWriteWaiters
        .splice(0)
        .forEach((waiter) => waiter.reject(new Error("plugin unloaded")));
    },
    onEvent(event) {
      if (!active) return;
      if (event.name === "storageRead" && event.payload?.key === STORAGE_KEY) {
        if (storageUnavailable || storageReady) return;
        const restored = feedbackFromStorage(event.payload.value);
        if (!restored) {
          storageUnavailable = true;
          storageWaiters
            .splice(0)
            .forEach((waiter) =>
              waiter.reject(new Error("feedback storage unavailable")),
            );
          return;
        }
        feedback = restored;
        storageReady = true;
        storageWaiters.splice(0).forEach((waiter) => waiter.resolve());
      }
      if (event.name === "storageWrite" && !storageWriteBroken) {
        const waiter = storageWriteWaiters.shift();
        if (waiter) waiter.resolve();
      }
      if (
        event.name === "shotStored" ||
        event.name === "shotUpdated" ||
        event.name === "workflowUpdated"
      ) {
        cacheGeneration += 1;
        cachedShots = null;
      }
    },
    handleHttpRequest: async (request) => {
      const endpoint = request.endpoint || "";
      const requestSession = sessionEpoch;
      try {
        if (!active) throw new Error("plugin unloaded");
        if (endpoint === "ui" && request.method === "GET")
          return html(200, page);
        if (endpoint === "settings" && request.method === "GET")
          return json(200, settings);
        if (endpoint === "shots" && request.method === "GET")
          return json(200, { ...(await fetchShots()), maxPages: MAX_PAGES });
        if (endpoint === "recommendation" && request.method === "GET")
          return json(200, await recommendation());
        if (endpoint === "suggestion" && request.method === "GET")
          return json(200, await suggestion());
        if (endpoint === "bean-context" && request.method === "GET")
          return json(200, await beanContext());
        if (endpoint === "analysis" && request.method === "POST") {
          const input = bodyOf(request),
            id = textOrNull(input?.shotId);
          if (!id || id.length > 256)
            return json(400, { error: "shotId is required" });
          return json(200, await analysis(id));
        }
        if (endpoint === "references" && request.method === "GET") {
          const catalog = createReferenceCatalog();
          return json(200, {
            schemaVersion: catalog.schemaVersion,
            reviewedAt: catalog.reviewedAt,
            sources: catalog.sources,
            provenance:
              "Offline reviewed reference catalog; source facts remain scoped examples and are not universal targets, calibration, or device observations.",
            attribution:
              "Each source record retains its publisher, URL, scope, facts, notes and reuse boundary.",
          });
        }
        if (endpoint === "research" && request.method === "POST") {
          try {
            return json(200, research(request));
          } catch (error) {
            return json(400, {
              error: error.message,
              code: "invalid_research_input",
            });
          }
        }
        if (endpoint === "feedback" && request.method === "POST") {
          const input = bodyOf(request);
          if (!input || typeof input !== "object" || Array.isArray(input))
            return json(400, { error: "feedback must be an object" });
          const shotId = textOrNull(input.shotId);
          if (!shotId || shotId.length > 256 || typeof input.good !== "boolean")
            return json(400, { error: "shotId and boolean good are required" });
          if (
            input.taste != null &&
            input.taste !== "" &&
            !TASTES.includes(input.taste)
          )
            return json(400, { error: "unsupported taste" });
          if (
            input.brewTimeSec != null &&
            !(numberOrNull(input.brewTimeSec) > 0 && input.brewTimeSec <= 600)
          )
            return json(400, {
              error:
                "elapsed shot time must be positive and at most 600 seconds",
            });
          let confirmedContext, flavour, measuredBeanDose;
          try {
            flavour = validateFlavour(input.flavour);
            confirmedContext = validateConfirmedContext(input.confirmedContext);
          } catch (error) {
            if (input.measuredBeanDose != null) {
              try {
                measuredBeanDose = validateMeasuredBeanDose(input.measuredBeanDose);
              } catch (measurementError) {
                return json(400, { error: measurementError.message });
              }
            }
            return json(400, { error: "invalid confirmed historical context" });
          }
          try {
            measuredBeanDose = validateMeasuredBeanDose(input.measuredBeanDose);
          } catch (error) {
            return json(400, { error: error.message });
          }
          if (Object.keys(confirmedContext).length) {
            const shot = await fullShot(shotId);
            try {
              historicalContext(shot, { confirmedContext });
            } catch (_) {
              return json(400, {
                error: "confirmed context conflicts with the saved shot",
              });
            }
          }
          await loadStorage();
          feedbackQueue = feedbackQueue
            .catch(() => {})
            .then(async () => {
              if (!active || requestSession !== sessionEpoch)
                throw new Error("plugin unloaded");
              cacheGeneration += 1;
              cachedShots = null;
              const previous = feedback[shotId];
              feedback[shotId] = {
                good: input.good,
                notes: textOrNull(input.notes)?.slice(0, 512) || null,
                updatedAt: new Date().toISOString(),
                taste: input.taste || null,
                flavour,
                brewTimeSec: input.brewTimeSec ?? null,
                confirmedContext,
                measuredBeanDose,
              };
              try {
                await persist();
              } catch (error) {
                if (previous) feedback[shotId] = previous;
                else delete feedback[shotId];
                throw error;
              }
            });
          await feedbackQueue;
          if (!active || requestSession !== sessionEpoch)
            throw new Error("plugin unloaded");
          return json(200, { saved: true, shotId });
        }
        return json(404, { error: "unknown endpoint or method" });
      } catch (error) {
        log("request failed");
        return json(503, {
          error: "Assisted dial-in unavailable",
          code: "request_failed",
          ...(active && (storageUnavailable || storageWriteBroken)
            ? {
                recovery:
                  "Reload the plugin to recover feedback storage before saving or recommending again",
              }
            : {}),
        });
      }
    },
  };
}
