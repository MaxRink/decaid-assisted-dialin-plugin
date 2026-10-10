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
    constants: {
      sampleLimit: 6,
      outputScale: 10,
      v1Quantum: 0.2,
      v1HysteresisBand: 0.16,
    },
  };
}
function createPlugin(host) {
  "use strict";

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
    const batchResponse = await fetch(
      `${API_BASE}/api/v1/bean-batches/${encodeURIComponent(id)}`,
    );
    if (!batchResponse.ok) throw new Error("current bean batch unavailable");
    const batch = await batchResponse.json();
    if (!batch || batch.id !== id || !textOrNull(batch.beanId))
      throw new Error("invalid bean batch");
    const beanResponse = await fetch(
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
  async function analysis(shotId) {
    const generation = cacheGeneration;
    await loadStorage();
    await feedbackQueue;
    const full = await fullShot(shotId);
    const mark = feedback[shotId]
      ? JSON.parse(JSON.stringify(feedback[shotId]))
      : null;
    const metrics = createBrewMetrics().analyze(full, mark);
    if (!active || generation !== cacheGeneration)
      throw new Error("shot changed during analysis");
    return {
      shotId,
      metrics,
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
      let confirmedContext, flavour;
      try {
        flavour = validateFlavour(entry.flavour);
        confirmedContext = validateConfirmedContext(entry.confirmedContext);
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
    const response = await fetch(
      `${API_BASE}/api/v1/shots/${encodeURIComponent(id)}`,
    );
    if (!response.ok) throw new Error("shot unavailable");
    const shot = await response.json();
    if (!shot || String(shot.id) !== String(id) || !shot.workflow)
      throw new Error("invalid shot");
    return shot;
  }
  async function currentWorkflow() {
    const response = await fetch(`${API_BASE}/api/v1/workflow`);
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
      const response = await fetch(
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
    if (evidence.length < 3)
      return abstain(
        "At least three recent comparable feedback shots at the current intended setting are required",
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
<p>Save feedback for at least three comparable shots first. Configure the current setup and timing target in plugin settings.</p>
<button id="suggestion" type="button">Suggest a manual adjustment</button>
<h2>Bean context and brew analysis</h2>
<button id="beans" type="button">Show current bean and roast catalog</button>
<p>The current catalog may have changed since an older brew. Confirm historical bean type and roast explicitly in that shot feedback.</p>
<form id="analysis"><label>Shot ID <input required name="shotId"></label><button type="submit">Analyse saved brew metrics</button></form>
<h2>Advanced research replay</h2>
<form id="research">
  <p>Software replay only. The calculator does not contact hardware or infer physical dial direction.</p>
  <label>Calculator request JSON<textarea name="state" aria-label="Research replay JSON">{"operation":"adjust","algorithm":"GbS2","firmwareBuild":"HEM-HSG-HMI-S01 V01.16-24","coordinateUnit":"deci-micrometre","scope":{"grinderId":"synthetic-grinder","beanBatchId":"synthetic-beans","burrIdentity":"synthetic-burrs","calibrationEpoch":"simulation-1","profile":"synthetic-profile"},"input":{"actualBrewTimeMs":30000,"targetBrewTimeMs":28000,"estimatedDdDum":500,"setpointDdDum":500,"toleranceMs":1000}}</textarea></label>
  <p>This sample uses synthetic inputs. To replay the next shot, copy the returned stateEnvelope into the request and update input. Keep scope unchanged only for the same setup. Other operations and units are documented in README.</p>
  <button type="submit">Run software replay</button>
</form>
<output id="result" aria-live="polite"></output>
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
  <button name="good" value="true">Mark good</button>
  <button name="good" value="false">Remove good mark</button>
</form>
<script>
const out=document.querySelector('#result');
const show=async (url, init)=>{const r=await fetch(url,init);const body=await r.json();out.textContent=JSON.stringify(body,null,2);};
const fail=(message)=>{out.textContent=message;};
document.querySelector('#recommend').onclick=async()=>{out.textContent='Loading...';try{await show('recommendation')}catch(e){fail('Could not load recommendation. Try again.')}};
document.querySelector('#suggestion').onclick=async()=>{out.textContent='Calculating...';try{await show('suggestion')}catch(e){fail('Could not calculate suggestion. Try again.')}};
document.querySelector('#beans').onclick=async()=>{out.textContent='Loading bean context...';try{await show('bean-context')}catch(e){fail('Could not load current bean context. Try again.')}};
document.querySelector('#analysis').onsubmit=async e=>{e.preventDefault();out.textContent='Analysing brew...';try{await show('analysis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shotId:new FormData(e.target).get('shotId')})})}catch(e){fail('Could not analyse the brew. Try again.')}};
document.querySelector('#research').onsubmit=async e=>{e.preventDefault();let data;try{data=JSON.parse(new FormData(e.target).get('state'))}catch(e){fail('Research replay JSON is invalid.');return}out.textContent='Replaying software state...';try{await show('research',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})}catch(e){fail('Could not run research replay. Try again.')}};
document.querySelector('#feedback').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);const context={};['burrIdentity','calibrationEpoch','basket','settingUnit','beanBatchId','grinderId','grinderModel','beanType','roastLevel'].forEach(k=>{const v=f.get(k);if(v)context[k]=v});['dose','yield'].forEach(k=>{const v=f.get(k);if(v!=='')context[k]=Number(v)});const raw=f.get('brewTimeSec');const flavour={};const descriptors=f.get('descriptors');if(descriptors.trim())flavour.descriptors=descriptors.split(',').map(v=>v.trim()).filter(Boolean);const overall=f.get('overall');if(overall)flavour.overall=overall;['acidity','bitterness','sweetness','body','astringency'].forEach(k=>{const v=f.get(k);if(v!=='')flavour[k]=Number(v)});out.textContent='Saving...';try{await show('feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shotId:f.get('shotId'),good:(e.submitter?.value||'true')==='true',notes:f.get('notes'),taste:f.get('taste')||null,flavour:Object.keys(flavour).length?flavour:null,brewTimeSec:raw===''?null:Number(raw),confirmedContext:context})})}catch(e){fail('Could not save feedback. Try again.')}};
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
          let confirmedContext, flavour;
          try {
            flavour = validateFlavour(input.flavour);
            confirmedContext = validateConfirmedContext(input.confirmedContext);
          } catch (_) {
            return json(400, { error: "invalid confirmed historical context" });
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
