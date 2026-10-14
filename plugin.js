/* Provenance-aware shot metrics for the Decaid snapshot JSON shape.
 * Measurements are descriptive only: no extraction/channeling thresholds or
 * inferred dose/yield claims are made. */
function createBrewMetrics() {
  "use strict";
  const MAX = 20000;
  const MAX_GAP_MS = 5000;
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
      weighted = 0,
      skippedGaps = 0;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i],
        b = list[i + 1],
        dt = b.__time - a.__time;
      if (dt <= 0 || dt > MAX_GAP_MS || !finite(a[valueKey]) || !finite(b[valueKey]) ||
          !finite(a[targetKey]) || !finite(b[targetKey])) {
        if (dt > 5000) skippedGaps++;
        continue;
      }
      weighted += Math.abs(a[valueKey] - a[targetKey]) * dt;
      total += dt;
    }
    if (total > 0) {
      result.timeWeightedMae = weighted / total;
      result.timeWeightedCoverageSec = total / 1000;
    }
    result.skippedGapCount = skippedGaps;
    return result;
  }
  function frameRuns(list, origin) {
    const runs = [];
    for (let i = 0; i < list.length; i++) {
      const sample = list[i], previous = list[i - 1];
      const frame = Number.isInteger(sample.profileFrame) && sample.profileFrame >= 0
        ? sample.profileFrame : null;
      const substate = typeof sample.state?.substate === "string" ? sample.state.substate : null;
      const machineState = typeof sample.state?.state === "string" ? sample.state.state : null;
      const elapsed = (sample.__time - origin) / 1000;
      const contiguous = previous && sample.__time - previous.__time <= MAX_GAP_MS;
      const last = runs[runs.length - 1];
      if (last && contiguous && (frame != null || substate != null)) {
        last.endElapsedSec = elapsed;
        last.coverageSec += (sample.__time - previous.__time) / 1000;
      }
      if (last && contiguous && last.profileFrame === frame && last.machineSubstate === substate && last.machineState === machineState) {
        last.sampleCount++;
        last.samples.push(sample);
      } else {
        runs.push({ profileFrame: frame, machineSubstate: substate, machineState,
          startElapsedSec: elapsed, endElapsedSec: elapsed, coverageSec: 0,
          sampleCount: 1, samples: [sample] });
      }
    }
    return runs;
  }
  function profileSegments(list, origin) {
    const segments = frameRuns(list, origin);
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
        brewFlowCoverageSec: 0,
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
      brewFlowCoverageSec: 0,
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
    let measuredGain = 0;
    for (let i = 1; i < list.length; i++) {
      if (beverageRate(list[i - 1], list[i]) == null) continue;
      measuredGain += list[i].weight - list[i - 1].weight;
      result.brewFlowCoverageSec += (list[i].__time - list[i - 1].__time) / 1000;
    }
    if (result.brewFlowCoverageSec > 0)
      result.brewFlowGPerSec = measuredGain / result.brewFlowCoverageSec;
    return result;
  }
  function stateTiming(machine, origin, timestampsComplete = true) {
    const substate = (sample) => typeof sample?.state?.substate === "string"
      ? sample.state.substate : null;
    function window(names) {
      const active = (sample) => sample?.state?.state === "espresso" && names.includes(substate(sample));
      const first = machine.findIndex(active);
      let last = first, coverageSec = 0, gapCount = 0, interrupted = false;
      for (let i = 0; i < machine.length; i++) {
        if (active(machine[i])) last = i;
        if (i === machine.length - 1 || !active(machine[i])) continue;
        const dt = machine[i + 1].__time - machine[i].__time;
        if (dt > MAX_GAP_MS) { gapCount++; continue; }
        if (substate(machine[i + 1]) == null) { interrupted = true; continue; }
        coverageSec += dt / 1000;
      }
      if (first >= 0) {
        for (let i = first; i <= last; i++) if (!active(machine[i])) interrupted = true;
      }
      const before = first > 0 ? machine[first - 1] : null;
      const after = first >= 0 ? machine[last + 1] : null;
      const startObserved = before && substate(before) != null && !active(before) &&
        machine[first].__time - before.__time <= MAX_GAP_MS;
      const endObserved = after && substate(after) != null && !active(after) &&
        after.__time - machine[last].__time <= MAX_GAP_MS;
      const complete = !!(timestampsComplete && first >= 0 && startObserved && endObserved && !gapCount && !interrupted);
      return { available: first >= 0, complete,
        durationSec: complete ? (after.__time - machine[first].__time) / 1000 : null,
        startSec: first >= 0 ? (machine[first].__time - origin) / 1000 : null,
        endSec: endObserved ? (after.__time - origin) / 1000 : null,
        coverageSec, gapCount, source: "recorded_machine_substates",
        timestampIntegrity: timestampsComplete ? "valid" : "excluded_samples",
        interpretation: "First observed active substate to first observed following substate; missing boundaries or telemetry gaps leave duration unknown." };
    }
    return { pump: window(["preinfusion", "pouring"]),
      pouring: window(["pouring"]), preinfusion: window(["preinfusion"]) };
  }
  // Derivatives belong to adjacent scale timestamps, never merged machine points.
  function beverageRate(a, b) {
    if (!a || !b || !finite(a.weight) || !finite(b.weight) || a.weight < 0 || b.weight < 0)
      return null;
    const dt = b.__time - a.__time;
    return dt > 0 && dt <= MAX_GAP_MS && b.weight >= a.weight
      ? (b.weight - a.weight) / (dt / 1000) : null;
  }
  // Flow telemetry is not beverage flow. Keep both traces and skip intervals
  // across missing telemetry so a long gap cannot become invented extraction.
  function traceMetrics(machine, scale, shot, origin, warnings, machineTimestampsComplete) {
    const finitePoint = (value) => finite(value);
    function integrate(list, valueKey) {
      let area = 0, coverage = 0, gaps = 0, peak = null, min = null, count = 0;
      const values = [];
      for (const item of list) {
        if (finitePoint(item[valueKey])) {
          values.push(item[valueKey]); count++;
          peak = peak == null ? item[valueKey] : Math.max(peak, item[valueKey]);
          min = min == null ? item[valueKey] : Math.min(min, item[valueKey]);
        }
      }
      for (let i = 0; i < list.length - 1; i++) {
        const a = list[i], b = list[i + 1], dt = b.__time - a.__time;
        if (!(dt > 0) || dt > MAX_GAP_MS) { if (dt > MAX_GAP_MS) gaps++; continue; }
        if (!finitePoint(a[valueKey]) || !finitePoint(b[valueKey])) continue;
        area += ((a[valueKey] + b[valueKey]) / 2) * dt / 1000;
        coverage += dt / 1000;
      }
      return {
        available: count > 0,
        sampleCount: count,
        mean: coverage > 0 ? area / coverage : null,
        integral: coverage > 0 ? area : null,
        min, max: peak, coverageSec: coverage,
        gapCount: gaps,
      };
    }
    function massRate(list, valueKey) {
      let gain = 0, weightedRate = 0, coverage = 0, gaps = 0, resetCount = 0, min = null, max = null, count = 0;
      for (const item of list) if (finitePoint(item[valueKey])) count++;
      for (let i = 0; i < list.length - 1; i++) {
        const a = list[i], b = list[i + 1], dt = b.__time - a.__time;
        if (!(dt > 0) || dt > MAX_GAP_MS) { if (dt > MAX_GAP_MS) gaps++; continue; }
        if (!finitePoint(a[valueKey]) || !finitePoint(b[valueKey])) continue;
        if (b[valueKey] < a[valueKey]) { resetCount++; continue; }
        const rate = beverageRate(a, b);
        if (rate == null) continue;
        gain += b[valueKey] - a[valueKey];
        weightedRate += rate * dt / 1000;
        coverage += dt / 1000;
        min = min == null ? rate : Math.min(min, rate);
        max = max == null ? rate : Math.max(max, rate);
      }
      return { available: count > 0, sampleCount: count,
        mean: coverage > 0 ? weightedRate / coverage : null,
        integral: coverage > 0 ? gain : null, min, max,
        coverageSec: coverage, gapCount: gaps, resetCount };
    }
    const profile = shot?.workflow?.profile || shot?.profile || {};
    const steps = Array.isArray(profile.steps) ? profile.steps : [];
    const number = (value) => finite(value) ? value :
      typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
    const countStart = number(profile.target_volume_count_start);
    const infusionName = (name) => /pre.?infus|infus|bloom|soak|fill/i.test(String(name || ""));
    const preStep = (step, index) => Number.isInteger(countStart) && countStart > 0 && index < countStart || infusionName(step?.name);
    const controlSteps = steps.filter((step) => step && typeof step === "object");
    const hasFlowStep = controlSteps.some((step) => step.pump === "flow");
    const hasPressureStep = controlSteps.some((step) => step.pump === "pressure");
    const extractionFlow = steps.some((step, index) => step?.pump === "flow" && !preStep(step, index));
    const hybridLimiter = controlSteps.some((step) => number(step.limiter?.value) > 0);
    const unsupportedControl = controlSteps.some((step) => !["flow", "pressure"].includes(step.pump));
    const controlMode = unsupportedControl ? "unknown" : hybridLimiter
      ? (hasPressureStep ? "mixed_dynamic_flow" : hasFlowStep ? "flow" : "unknown")
      : hasPressureStep && hasFlowStep ? (extractionFlow ? "mixed_dynamic_flow" : "mixed_preinfusion_flow")
      : hasFlowStep ? (extractionFlow ? "flow" : "flow_preinfusion_only")
      : hasPressureStep ? "pressure" : "unknown";
    let phases = { items: [], source: "unavailable" };
    if (machine.some((sample) => Number.isInteger(sample.profileFrame) || sample.state?.substate)) {
      phases.source = "recorded_profile_frame";
      phases.items = frameRuns(machine, origin).map((run) => {
        const step = run.profileFrame == null ? null : steps[run.profileFrame];
        const inactive = run.machineState != null && run.machineState !== "espresso" ||
          run.machineSubstate != null && !["preinfusion", "pouring"].includes(run.machineSubstate);
        const mapped = !inactive && step && ["flow", "pressure"].includes(step.pump);
        const role = inactive ? "outside_pump" : run.machineSubstate === "preinfusion" ? "preinfusion" :
          mapped ? (preStep(step, run.profileFrame) ? "preinfusion" : "extraction") : "unknown";
        return { name: inactive ? run.machineSubstate : mapped ? step.name || `frame ${run.profileFrame}` : "Unknown profile phase",
          profileFrame: run.profileFrame, machineSubstate: run.machineSubstate, machineState: run.machineState,
          startSec: run.startElapsedSec, endSec: run.endElapsedSec,
          coverageSec: run.coverageSec, source: "recorded_profile_frame", role,
          roleProvenance: run.machineSubstate === "preinfusion" ? "recorded_machine_substate" :
            mapped ? "saved_step_name_or_volume_accounting_boundary" : "unavailable",
          pump: mapped ? step.pump : null, target: mapped ? number(step[step.pump]) : null,
          targetUnit: mapped ? (step.pump === "flow" ? "ml/s" : "bar") : null,
          limiter: mapped && number(step.limiter?.value) > 0
            ? { value: number(step.limiter.value), range: number(step.limiter.range),
                unit: step.pump === "flow" ? "bar" : "ml/s" } : null,
          mapping: mapped ? "saved_profile_step" : "unknown",
          samples: run.samples };
      });
    } else {
      const candidates = [shot?.phases, shot?.phaseEvents, shot?.profilePhases,
        shot?.annotations?.phases, shot?.workflow?.phases];
      const explicit = candidates.find((value) => Array.isArray(value) && value.length) || [];
      const lastSec = machine.length ? (machine[machine.length - 1].__time - origin) / 1000 : null;
      phases.items = explicit.flatMap((phase) => {
        const start = phase?.startSec ?? phase?.start, end = phase?.endSec ?? phase?.end;
        if (!finite(start) || !finite(end) || start < 0 || end < start || lastSec == null || end > lastSec) return [];
        return [{ name: String(phase.name || "Recorded phase"), startSec: start, endSec: end,
          role: infusionName(phase.name) ? "preinfusion" : "unknown", source: "recorded_phase_boundary" }];
      });
      if (phases.items.length) phases.source = "recorded_phase_boundary";
    }
    const phaseStats = phases.items.map((phase) => {
      const inWindow = phase.samples || machine.filter((item) => {
        const elapsed = (item.__time - origin) / 1000;
        return elapsed >= phase.startSec && elapsed <= phase.endSec;
      });
      const scaleWindow = scale.filter((item) => {
        const elapsed = (item.__time - origin) / 1000;
        return elapsed >= phase.startSec && elapsed <= phase.endSec;
      });
      const { samples: ignored, ...details } = phase;
      return { ...details, machineFlow: integrate(inWindow, "flow"),
        beverageMass: massRate(scaleWindow, "weight"), sampleCount: inWindow.length };
    });
    const preStats = phaseStats.filter((phase) => phase.role === "preinfusion");
    const points = [];
    const byTime = new Map();
    for (const item of machine) byTime.set(item.__time, { tSec: (item.__time - origin) / 1000,
      machineFlow: finite(item.flow) ? item.flow : null, targetFlow: finite(item.targetFlow) ? item.targetFlow : null,
      pressure: finite(item.pressure) ? item.pressure : null, targetPressure: finite(item.targetPressure) ? item.targetPressure : null,
      mixTemperatureC: finite(item.mixTemperature) ? item.mixTemperature : null,
      targetMixTemperatureC: finite(item.targetMixTemperature) ? item.targetMixTemperature : null,
      groupTemperatureC: finite(item.groupTemperature) ? item.groupTemperature : null,
      targetGroupTemperatureC: finite(item.targetGroupTemperature) ? item.targetGroupTemperature : null,
      profileFrame: Number.isInteger(item.profileFrame) ? item.profileFrame : null,
      machineSubstate: item.state?.substate || null });
    for (let i = 0; i < scale.length; i++) {
      const item = scale[i], previous = scale[i - 1];
      const point = byTime.get(item.__time) || { tSec: (item.__time - origin) / 1000 };
      point.beverageWeightG = finite(item.weight) ? item.weight : null;
      point.beverageFlowGPerSec = beverageRate(previous, item);
      point.beverageFlowStartSec = point.beverageFlowGPerSec == null ? null : (previous.__time - origin) / 1000;
      byTime.set(item.__time, point);
    }
    [...byTime.values()].sort((a, b) => a.tSec - b.tSec).slice(0, 600).forEach((point) => points.push(point));
    if (points.length < byTime.size) warnings.push("flow trace is bounded to 600 points");
    const machineFlow = integrate(machine, "flow");
    const beverageMass = massRate(scale, "weight");
    const flowValues = machine.filter((item) => finite(item.flow)).map((item) => item.flow);
    let flowJumps = 0;
    for (let i = 1; i < machine.length; i++) {
      if (!finite(machine[i].flow) || !finite(machine[i - 1].flow) ||
          machine[i].__time - machine[i - 1].__time > MAX_GAP_MS ||
          machine[i].profileFrame !== machine[i - 1].profileFrame) continue;
      const target = finite(machine[i].targetFlow) ? Math.abs(machine[i].targetFlow) : 1;
      if (Math.abs(machine[i].flow - machine[i - 1].flow) > Math.max(0.5, target * 0.5)) flowJumps++;
    }
    const scaleResets = beverageMass.resetCount || 0;
    const observations = flowValues.length >= 5 && machineFlow.coverageSec >= 2 ? {
      status: "observed_trace",
      flowSampleCount: flowValues.length,
      flowJumpCount: flowJumps,
      observedWeightDecreaseCount: scaleResets,
      possibleIrregularity: flowJumps > 0,
      possiblePrepIssue: null,
      alternatives: ["profile transition", "sensor/telemetry gap", "scale reset or drip timing", "dose/distribution or grinder variation"],
      explanation: "Irregularity is descriptive. A puck-preparation cause cannot be distinguished from profile transitions, sensor behavior, scale resets or grinder variation without a matched baseline and sensory evidence.",
    } : {
      status: "insufficient_trace_coverage",
      possibleIrregularity: null,
      possiblePrepIssue: null,
      alternatives: ["record a longer, time-aligned machine and beverage trace"],
    };
    return {
      available: machineFlow.available || beverageMass.available,
      timeOrigin: time(shot.timestamp) != null ? "recording_start" :
        machine.length ? "first_machine_sample" : scale.length ? "first_scale_sample" : "unavailable",
      timeOriginTimestamp: origin,
      controlMode,
      controlModeProvenance: controlMode === "unknown" ? "profile control mode unavailable" : "saved workflow profile pump modes and positive opposite-variable limiters",
      machineFlow: { ...machineFlow, unit: "ml/s", source: "machine_telemetry" },
      beverageFlow: { ...beverageMass, unit: "g/s", source: "scale_mass_derivative", interpretation: "beverage mass rate; not machine inlet flow" },
      phases: phaseStats,
      observations,
      preinfusion: preStats.length ? {
        available: true,
        durationSec: preStats.reduce((sum, phase) => sum + phase.endSec - phase.startSec, 0),
        durationProvenance: "covered_observed_phase_intervals_not_complete_physical_wetting_time",
        coverageSec: preStats.reduce((sum, phase) => sum + (phase.coverageSec ?? phase.machineFlow.coverageSec), 0),
        startSec: Math.min(...preStats.map((phase) => phase.startSec)),
        endSec: Math.max(...preStats.map((phase) => phase.endSec)),
        source: phases.source,
        machineFlow: preStats.map((phase) => phase.machineFlow),
        beverageMass: preStats.map((phase) => phase.beverageMass),
        extractionElapsedSec: stateTiming(machine, origin, machineTimestampsComplete).pouring.durationSec,
        warning: "Observed controller phases are not direct measurements of puck saturation. Names and volume-count boundaries describe profile intent.",
      } : { available: false, source: phases.source, reason: "No observed mapped preinfusion boundary; programmed maximum durations are not measured phases" },
      points,
      recommendation: ["flow", "mixed_dynamic_flow"].includes(controlMode)
        ? { status: "abstain", reason: "Flow-controlled or flow-limited profile: elapsed time alone is not evidence for a grind change; compare the saved flow and beverage traces plus taste feedback." }
        : { status: "descriptive", reason: "Trace metrics describe the saved signals; grind direction still needs comparable shots and sensory evidence." },
      provenance: "Flow graph preserves nonuniform timestamps. Machine flow and beverage mass flow are separate signals; intervals over 5 seconds are excluded from integration.",
    };
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
        brewTemperatureC: finite(annotations.brewTemperatureC)
          ? annotations.brewTemperatureC
          : null,
        tastingTemperatureC: finite(annotations.tastingTemperatureC)
          ? annotations.tastingTemperatureC
          : null,
        servingTemperatureC: finite(annotations.servingTemperatureC)
          ? annotations.servingTemperatureC
          : null,
        enjoyment: finite(annotations.enjoyment) ? annotations.enjoyment : null,
        available: Object.keys(annotations).length > 0,
      },
      stopReason:
        typeof shot.stopReason === "string"
          ? shot.stopReason
          : typeof shot.finalStopReason === "string"
            ? shot.finalStopReason
            : typeof shot.finalStopReason?.name === "string"
              ? shot.finalStopReason.name
              : typeof shot.shotDecisionReason === "string"
                ? shot.shotDecisionReason
                : null,
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
      trace: null,
      timing: null,
      elapsedSecProvenance: "recording_duration_including_possible_preparation_and_settling",
    };
    analysis.scale = scaleMetrics(scale, machineStart, warnings);
    const traceOrigin = machineStart ?? scale[0]?.__time ?? null;
    const machineTimestampsComplete = samples(shot, "machine").length === machine.length;
    analysis.trace = traceMetrics(machine, scale, shot, traceOrigin, warnings, machineTimestampsComplete);
    analysis.timing = {
      recording: { durationSec: analysis.elapsedSec, startTimestamp: machineStart,
        endTimestamp: machineEnd, source: "recording_timestamps" },
      ...stateTiming(machine, traceOrigin, machineTimestampsComplete),
    };
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
      "Saved machine telemetry, not beverage mass flow. Time-weighted target errors use left-sample hold over intervals up to 5 seconds with valid measurements and targets at both ends.";
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
      // The convenience ddEff batch helper intentionally caps callers at 64;
      // retained engine state keeps the six/six/six cycle beyond that bound.
      if (s.calls < 0)
        throw new Error("calls must be non-negative");
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
        e64ws: { finer: null, range: null, motor: false, native: true },
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
    if (selected.native && p.settingUnit !== "micrometres")
      throw new Error("E64 WS requires its native micrometres setting unit");
    if (selected.native && (p.stepMarks != null || p.finerDirection != null))
      throw new Error("E64 WS uses stepNative and numericFinerDelta, not dial marks or rotation");
    if (!selected.native && p.stepNative != null)
      throw new Error("dial-mark profiles use stepMarks");
    const finer = selected.native ? null : p.finerDirection || selected.finer;
    if (!selected.native && finer !== "clockwise" && finer !== "counterclockwise")
      throw new Error("invalid finerDirection");
    const current =
      p.currentDial == null ? null : finite(p.currentDial, "currentDial");
    if (
      current != null &&
      selected.range &&
      (current < selected.range[0] || current > selected.range[1])
    )
      throw new Error("currentDial is outside selected range");
    if (selected.native && current != null && current < 0)
      throw new Error("native micrometres must not be negative");
    const stepKey = selected.native ? "stepNative" : "stepMarks";
    const step = p[stepKey] == null ? null : finite(p[stepKey], stepKey);
    if (step != null && step <= 0)
      throw new Error(stepKey + " must be positive");
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
    const flavor = String(p.flavor || "").trim().toLowerCase(),
      dirs = [],
      reasons = [];
    if (actual < target - tol) {
      dirs.push("finer");
      reasons.push("brew time is below target");
    } else if (actual > target + tol) {
      dirs.push("coarser");
      reasons.push("brew time is above target");
    }
    // Only explicit assessments express a desired change; free prose cannot
    // reliably distinguish pleasant acidity or negated bitterness.
    if (["too sour", "too acidic", "under-extracted"].includes(flavor)) {
      dirs.push("finer");
      reasons.push("operator assessment supports a finer test as a taste heuristic; extraction is not measured");
    }
    if (["too bitter", "too astringent", "over-extracted"].includes(flavor)) {
      dirs.push("coarser");
      reasons.push("operator assessment supports a coarser test as a taste heuristic; extraction is not measured");
    }
    const unique = [...new Set(dirs)],
      direction = flavor !== "balanced" && unique.length === 1 ? unique[0] : "none";
    const legacyScore =
      direction !== "none"
        ? Math.min(0.9, 0.55 + 0.15 * (reasons.length - 1))
        : 0;
    if (flavor === "balanced")
      reasons.push("balanced feedback: retain the setting and review the time target");
    else if (flavor && !["none", "too sour", "too acidic", "too bitter", "too astringent", "under-extracted", "over-extracted"].includes(flavor))
      reasons.push("taste text does not state a recognized adjustment intent and was not used");
    if (unique.length > 1)
      reasons.push(
        "time and sensory signals conflict; confirm before changing grind",
      );
    if (!unique.length)
      reasons.push(
        "no signal outside the time tolerance or recognized sensory vocabulary",
      );
    const physicalTurn = selected.native ? null :
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
        Number.isFinite(candidate) && (!selected.native || candidate >= 0) &&
        (!selected.range ||
        (candidate >= selected.range[0] && candidate <= selected.range[1]))
      )
        proposed = candidate;
      else
        reasons.push(
          selected.native
            ? "native proposal is non-finite or below zero; verify the grinder's permitted settings"
            : "numeric proposal would leave the reference range; verify the physical dial",
        );
    }
    return {
      profile,
      direction,
      physicalTurn,
      confidence: direction === "none" ? "none" : "heuristic",
      legacyScore,
      legacyScoreProvenance: "Legacy community rule score for recognized signals; not a probability, measured confidence or firmware output",
      provenance: "Bounded manual experiment using an owner-supplied time target and explicit taste assessment; not a measured extraction diagnosis or a learned grind response",
      reasons,
      ...(selected.native ? {
        settingUnit: "micrometres",
        suggestedStepNative: step,
        nativeStepProvenance: "One owner-confirmed step on the native display; no particle-size, dD-response or physical rotation inference",
      } : { suggestedStepMarks: step }),
      currentDial: current,
      proposedDial: proposed,
      requiresConfirmation: true,
      safetyNotes: [
        "recommendation only; this tool never contacts or moves a grinder",
        "use a small calibrated step and re-measure the next shot",
        selected.native
          ? "verify the native display, owner-confirmed step and numeric finer sign, and permitted settings on this grinder"
          : "verify true zero, burr set, alignment, and the sign of the physical dial on this unit",
      ].concat(
        selected.motor
          ? ["follow the manufacturer's motor-running adjustment guidance"]
          : [],
      ),
    };
  }
  // A separate local model in seconds per native setting unit. None of the
  // recovered firmware constants, fallback slopes or dD conversions apply.
  const nativeResponseContract = Object.freeze({
    schemaVersion: 1,
    inputFields: Object.freeze(["scope", "shots", "currentSetting", "targetTimeSec", "toleranceSec", "stepNative", "numericFinerDelta", "bounds", "nativeResolution", "nativeOrigin", "clockConfirmed", "recipeConfirmed", "stepConfirmed", "taste"]),
    shotFields: Object.freeze(["id", "setting", "timeSec", "scope", "clockConfirmed", "recipeConfirmed", "taste", "prepConcern"]),
    resultStatuses: Object.freeze(["collecting", "hold", "abstain", "suggestion"]),
    scopeFields: Object.freeze(["beanId", "grinderId", "burrIdentity", "calibrationEpoch", "settingUnit", "doseG", "yieldG", "profile", "clock", "controlMode"]),
    clocks: Object.freeze(["pump", "pouring", "recording"]),
    controlModes: Object.freeze(["pressure", "mixed_preinfusion_flow"]),
    requiredConfirmations: Object.freeze(["clockConfirmed", "recipeConfirmed", "stepConfirmed"]),
    policy: Object.freeze({
      maxInputShots: 100, maxFitShots: 12, localRadiusSteps: 2, minimumDistinctSettings: 3,
      interpretation: "Software screening policy, not validated scientific thresholds or a confidence probability. Timing tolerance is the owner's acceptance window, not an estimated measurement uncertainty.",
    }),
    resolution: "Optional nativeResolution is the positive physical setting increment; nativeOrigin defaults to numeric coordinate zero, not burr contact. Current and recorded settings must lie on this lattice. Proposals round toward the current setting within the owner step and operating bounds. Omit for continuous settings.",
    interpretation: "Native settings and measured times must describe a chronological, unchanged recipe and grinder session. Bounds and step are owner-confirmed native operating values. This estimates a local timing response, not extraction or a micron conversion.",
  });
  function recommendNativeResponse(input) {
    const p = input || {}, contract = nativeResponseContract;
    const result = {
      method: "native-response", status: "abstain", proposedSetting: null, suggestedTrial: null,
      direction: null, settingUnit: typeof p.scope?.settingUnit === "string" ? p.scope.settingUnit : null, fit: null,
      sourceShotIds: [], excluded: [], requiresConfirmation: true,
      policy: { ...contract.policy },
      provenance: "Local measured seconds per native setting unit; no physical pitch, particle-size, firmware dD or extraction diagnosis is inferred",
    };
    const finish = (status, reasonCode, reason) => ({ ...result, status, reasonCode, reason });
    const isFinite = value => typeof value === "number" && Number.isFinite(value);
    const scopeValid = scope => scope && typeof scope === "object" && !Array.isArray(scope) &&
      contract.scopeFields.every(key => ["doseG", "yieldG"].includes(key)
        ? isFinite(scope[key]) && scope[key] > 0
        : typeof scope[key] === "string" && scope[key].trim() !== "" && scope[key].length <= 512) &&
      contract.clocks.includes(scope.clock);
    if (!scopeValid(p.scope))
      return finish("abstain", "incomplete_scope", "Record the bean batch, individual grinder, burrs, calibration epoch, native unit, dose, yield, profile and timing clock.");
    if (!contract.controlModes.includes(p.scope.controlMode))
      return finish("abstain", "unsupported_controller", "This timing response requires confirmed pressure-led extraction; a flow-controlled or unknown profile is not eligible.");
    if (![p.currentSetting, p.targetTimeSec, p.toleranceSec, p.stepNative, p.bounds?.min, p.bounds?.max].every(isFinite) ||
        !(p.targetTimeSec > 0 && p.targetTimeSec <= 600 && p.toleranceSec >= 0 && p.toleranceSec < p.targetTimeSec &&
          p.stepNative > 0 && p.bounds.min < p.bounds.max && p.currentSetting >= p.bounds.min && p.currentSetting <= p.bounds.max) ||
        ![-1, 1].includes(p.numericFinerDelta))
      return finish("abstain", "invalid_setup", "Supply an explicit target, tolerance, current native setting, positive owner step, finer-number direction and valid operating bounds.");
    const discrete = p.nativeResolution !== undefined;
    const origin = p.nativeOrigin === undefined ? 0 : p.nativeOrigin;
    if ((discrete && (!isFinite(p.nativeResolution) || p.nativeResolution <= 0 || !isFinite(origin))) ||
        (!discrete && p.nativeOrigin !== undefined))
      return finish("abstain", "invalid_native_resolution", "Supply a positive finite physical setting increment and an optional finite native coordinate origin, or omit both for a continuous dial.");
    const latticeIndex = setting => {
      const index = (setting - origin) / p.nativeResolution;
      const nearest = Math.round(index);
      const tolerance = Math.min(1e-7, 8 * Number.EPSILON * Math.max(1, Math.abs(index)));
      return Number.isSafeInteger(nearest) && Math.abs(index - nearest) <= tolerance ? nearest : null;
    };
    const currentIndex = discrete ? latticeIndex(p.currentSetting) : null;
    if (discrete && currentIndex === null)
      return finish("abstain", "invalid_native_setting", "The current setting is not an achievable physical increment in this native coordinate.");
    if (discrete) { result.nativeResolution = p.nativeResolution; result.nativeOrigin = origin; }
    // Quantize toward the observed setting, after limiting both travel and range.
    // The tolerance handles binary representation only; it cannot add a physical increment.
    const achievableSetting = delta => {
      if (!discrete) return p.currentSetting + delta;
      const sign = Math.sign(delta);
      const distance = Math.min(Math.abs(delta), p.stepNative,
        sign > 0 ? p.bounds.max - p.currentSetting : p.currentSetting - p.bounds.min);
      const ratio = distance / p.nativeResolution;
      let increments = Math.floor(ratio + Math.min(1e-7, 8 * Number.EPSILON * Math.max(1, Math.abs(ratio))));
      const index = currentIndex + sign * increments;
      if (!Number.isSafeInteger(increments) || !Number.isSafeInteger(index)) return null;
      let setting = origin + index * p.nativeResolution;
      const epsilon = Math.min(p.nativeResolution * 1e-7,
        8 * Number.EPSILON * Math.max(1, Math.abs(setting), Math.abs(p.currentSetting)));
      if (!Number.isFinite(setting)) return null;
      if (setting < p.bounds.min || setting > p.bounds.max || Math.abs(setting - p.currentSetting) > distance + epsilon) {
        increments--;
        setting = origin + (currentIndex + sign * increments) * p.nativeResolution;
      }
      return increments > 0 && setting >= p.bounds.min && setting <= p.bounds.max &&
        sign * (setting - p.currentSetting) > 0 && Math.abs(setting - p.currentSetting) <= distance + epsilon ? setting : null;
    };
    const resolutionHold = () => finish("hold", "native_resolution", "No full physical setting increment fits the requested movement, confirmed owner step and operating bounds. Retain the setting and reassess the target or repeat the shot.");
    if (contract.requiredConfirmations.some(key => p[key] !== true))
      return finish("abstain", "confirmation_required", "Confirm the matching timing clock, unchanged completed recipe, and owner step before interpreting the native response.");
    if (!Array.isArray(p.shots) || p.shots.length > contract.policy.maxInputShots)
      return finish("abstain", "invalid_shots", "Supply at most 100 chronological measured shots.");
    const sameScope = scope => scopeValid(scope) && contract.scopeFields.every(key => scope[key] === p.scope[key]);
    const selected = [], seen = new Set();
    const radius = p.stepNative * contract.policy.localRadiusSteps;
    if (!Number.isFinite(radius)) return finish("abstain", "invalid_setup", "The native step exceeds finite numeric bounds.");
    // Stop at an ineligible record. Filtering it out would reconnect different
    // recipes or conditions across a break in the recorded session.
    for (let i = p.shots.length - 1; i >= 0 && selected.length < contract.policy.maxFitShots; i--) {
      const shot = p.shots[i];
      let reason = null;
      if (!shot || typeof shot.id !== "string" || !shot.id.trim() || seen.has(shot.id)) reason = "invalid_or_duplicate_shot";
      else if (!sameScope(shot.scope)) reason = "scope_changed";
      else if (shot.clockConfirmed !== true || shot.recipeConfirmed !== true) reason = "unconfirmed_clock_or_recipe";
      else if (shot.prepConcern === true || ["weak", "channeling"].includes(shot.taste)) reason = "preparation_or_weakness_concern";
      else if (!isFinite(shot.setting) || !isFinite(shot.timeSec) || !(shot.timeSec > 0 && shot.timeSec <= 600) ||
          shot.setting < p.bounds.min || shot.setting > p.bounds.max) reason = "invalid_measurement";
      else if (discrete && latticeIndex(shot.setting) === null) reason = "unachievable_setting";
      else if (Math.abs(shot.setting - p.currentSetting) > radius) reason = "outside_local_window";
      if (reason) {
        result.excluded.push({ shotId: shot?.id || null, index: i, reason, olderHistoryWithheld: i });
        break;
      }
      seen.add(shot.id); selected.push(shot);
    }
    selected.reverse();
    result.sourceShotIds = selected.map(shot => shot.id);
    result.policy.localRadiusNative = radius;
    if (!selected.length)
      return finish("collecting", "no_eligible_shot", "Record a completed shot at the current native setting with the same recipe and clock.");
    const latest = selected[selected.length - 1];
    if (latest.setting !== p.currentSetting)
      return finish("abstain", "current_setting_unobserved", "The current setting differs from the latest measured shot. Record this setting before proposing another move.");
    const taste = typeof p.taste === "string" ? p.taste.trim().toLowerCase() : "";
    if (taste === "balanced") return finish("hold", "balanced", "You like this coffee; retain the setting rather than chase the timer.");
    if (p.prepConcern === true || ["weak", "channeling"].includes(taste))
      return finish("abstain", "preparation_or_weakness_concern", "Check preparation and the completed dose and yield before learning a grind response.");
    const tasteDirection = ["too sour", "too acidic", "under-extracted"].includes(taste) ? "finer" :
      ["too bitter", "too astringent", "over-extracted"].includes(taste) ? "coarser" : null;
    if (!tasteDirection) return finish("abstain", "taste_required", "Record the taste you want to change; descriptive flavour words do not establish an adjustment intent.");
    const timeDirection = latest.timeSec < p.targetTimeSec - p.toleranceSec ? "finer" :
      latest.timeSec > p.targetTimeSec + p.toleranceSec ? "coarser" : null;
    if (!timeDirection) return finish("hold", "target_window", "The latest time is within your target window. A timing fit does not justify another change for taste alone.");
    if (timeDirection !== tasteDirection)
      return finish("abstain", "taste_time_conflict", "Taste and timing suggest opposite changes. Repeat and reassess rather than letting the fit override taste.");
    result.direction = timeDirection;
    const median = values => {
      const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
    };
    const groups = new Map();
    selected.forEach(shot => {
      if (!groups.has(shot.setting)) groups.set(shot.setting, []);
      groups.get(shot.setting).push(shot.timeSec);
    });
    const points = [...groups].map(([setting, times]) => ({ setting, timeSec: median(times), count: times.length,
      repeatRangeSec: Math.max(...times) - Math.min(...times) }));
    const maxRepeatRangeSec = Math.max(...points.map(point => point.repeatRangeSec));
    const fit = { points, measuredShotCount: selected.length, distinctSettings: points.length,
      maxRepeatRangeSec, repeatabilityMeasured: points.some(point => point.count > 1),
      slopeSecPerNativeUnit: null, rawTargetSetting: null,
      rawEstimateInterpretation: "Exploratory local line estimate only; never an instruction to jump to this setting",
      validated: false };
    result.fit = fit;
    if (maxRepeatRangeSec > p.toleranceSec)
      return finish("hold", "repeat_variation", "Repeated times at the same setting vary more than your tolerance. Repeat the current setting and check consistency before learning a movement.");
    const line = values => {
      const mx = values.reduce((sum, point) => sum + point.setting / values.length, 0);
      const my = values.reduce((sum, point) => sum + point.timeSec / values.length, 0);
      const xx = values.reduce((sum, point) => sum + (point.setting - mx) ** 2, 0);
      const xy = values.reduce((sum, point) => sum + (point.setting - mx) * (point.timeSec - my), 0);
      return { mx, my, slope: xx > 0 ? xy / xx : null };
    };
    const trial = () => {
      const delta = p.stepNative * p.numericFinerDelta * (timeDirection === "finer" ? 1 : -1);
      const setting = achievableSetting(delta);
      if (setting !== null && Number.isFinite(setting) && setting >= p.bounds.min && setting <= p.bounds.max)
        result.suggestedTrial = { setting, delta: setting - p.currentSetting, direction: timeDirection, settingUnit: p.scope.settingUnit,
          learned: false, provenance: "At most one confirmed owner step supported by taste and timing; an exploratory trial, not a fitted prediction" };
    };
    if (points.length < 2) {
      trial();
      if (discrete && !result.suggestedTrial) return resolutionHold();
      return finish("collecting", "first_setting", "One measured setting cannot reveal a response slope. Try at most the confirmed small step, then record the result.");
    }
    const model = line(points);
    if (!Number.isFinite(model.slope) || !Number.isFinite(model.mx) || !Number.isFinite(model.my))
      return finish("abstain", "nonfinite_fit", "The measured coordinates do not support a finite local fit.");
    fit.slopeSecPerNativeUnit = model.slope;
    if (model.slope * p.numericFinerDelta <= 0)
      return finish("hold", "wrong_or_flat_slope", "The observed response is flat or opposes the confirmed finer direction. Repeat the current setting; do not force a fallback slope.");
    const previousDifferent = selected.slice(0, -1).reverse().find(shot => shot.setting !== latest.setting);
    const currentPoint = points.find(point => point.setting === latest.setting);
    const previousPoint = points.find(point => point.setting === previousDifferent?.setting);
    fit.latestDistinctTimeChangeSec = previousPoint ? currentPoint.timeSec - previousPoint.timeSec : null;
    if (previousPoint && Math.abs(fit.latestDistinctTimeChangeSec) <= p.toleranceSec)
      return finish("hold", "latest_plateau", "The last distinct settings produced indistinguishable times within your tolerance. Repeat the current setting before extrapolating.");
    if (previousPoint && fit.latestDistinctTimeChangeSec * (currentPoint.setting - previousPoint.setting) * p.numericFinerDelta <= 0)
      return finish("hold", "latest_reversal", "The most recent setting change opposed the expected timing response. Repeat the current setting before trusting the older trend.");
    if (Math.abs(model.slope * p.stepNative) <= p.toleranceSec)
      return finish("hold", "response_below_tolerance", "The fitted change over one owner step is no larger than your tolerance. Gather repeat measurements before using the fit.");
    if (points.length < contract.policy.minimumDistinctSettings) {
      trial();
      if (discrete && !result.suggestedTrial) return resolutionHold();
      return finish("collecting", "two_settings_provisional", "Two settings show only a provisional response. One further confirmed small trial can test whether it repeats; no learned setting is proposed yet.");
    }
    const maxResidual = Math.max(...points.map(point => Math.abs(point.timeSec - (model.my + model.slope * (point.setting - model.mx)))));
    const leaveOneOut = points.map((_, index) => line(points.filter((point, i) => i !== index)).slope);
    fit.maxResidualSec = Number.isFinite(maxResidual) ? maxResidual : null;
    fit.leaveOneOutSlopes = leaveOneOut.map(slope => Number.isFinite(slope) ? slope : null);
    if (!Number.isFinite(maxResidual) || maxResidual > p.toleranceSec || leaveOneOut.some(slope => !Number.isFinite(slope) || slope * p.numericFinerDelta <= 0))
      return finish("hold", "unstable_fit", "The local response changes when a measurement is omitted or misses your tolerance. Repeat the current setting before trusting a line.");
    const rawTarget = model.mx + (p.targetTimeSec - model.my) / model.slope;
    if (!Number.isFinite(rawTarget)) return finish("abstain", "nonfinite_fit", "The target does not produce a finite estimate.");
    fit.rawTargetSetting = rawTarget;
    const delta = Math.max(-p.stepNative, Math.min(p.stepNative, rawTarget - p.currentSetting));
    const direction = delta * p.numericFinerDelta > 0 ? "finer" : "coarser";
    if (delta === 0 || direction !== timeDirection)
      return finish("hold", "fit_direction_conflict", "The fitted target conflicts with the latest timing and taste direction. Retain the setting and repeat.");
    const proposed = achievableSetting(delta);
    if (discrete) fit.resolutionLimited = proposed !== p.currentSetting + delta;
    if (proposed === null) return resolutionHold();
    if (!Number.isFinite(proposed) || proposed < p.bounds.min || proposed > p.bounds.max)
      return finish("hold", "operating_bounds", "The bounded trial would leave the confirmed operating range. Verify the grinder limits before changing it.");
    result.proposedSetting = proposed;
    fit.stepLimited = Math.abs(rawTarget - p.currentSetting) > p.stepNative;
    fit.extrapolated = proposed < Math.min(...points.map(point => point.setting)) || proposed > Math.max(...points.map(point => point.setting));
    return finish("suggestion", "bounded_local_fit", "The local measured response supports at most one owner-confirmed step. Brew and measure again; the line is a provisional timing model, not an extraction prediction.");
  }
  const dialIn = (model, roast, weightMg) =>
    proposedDd({ model, roast, weightMg });
  function compareAll(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("comparison input must be an object");
    const cases = input.cases && typeof input.cases === "object" && !Array.isArray(input.cases)
      ? input.cases : {};
    const definitions = [
      ["GbS1", "adaptive replay", "adjust"], ["GbS2", "adaptive replay", "adjust"],
      ["GbS3", "adaptive replay", "adjust"], ["GbS4", "adaptive replay", "adjust"],
      ["DdEff", "measurement-result replay", "adjust"], ["effectiveDd", "prediction", "effectiveDd"],
      ["grindTime", "time calculator", "grindTime"], ["inverseRegression", "regression calculator", "inverseRegression"],
      ["proposedDd", "research table", "proposedDd"], ["manual", "community heuristic", "manual"],
    ];
    const results = definitions.map(([algorithm, kind, operation]) => {
      const value = cases[algorithm];
      const base = { algorithm, kind, operation, comparable: false, status: "unavailable", result: null,
        provenance: kind === "community heuristic" ? "community/manual heuristic" : "recovered-firmware or research calculator; inputs remain caller supplied" };
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        base.reason = "No isolated input case supplied; algorithms never share state.";
        return base;
      }
      try {
        if (operation === "adjust") {
          const state = value.state || newState(algorithm, value.options);
          const step = adjust(algorithm, state, value.input || {});
          base.result = step.result; base.nextState = step.nextState; base.comparable = true; base.status = "computed";
        } else if (operation === "effectiveDd") {
          base.result = effectiveDd(value.state || null, value.input || value); base.comparable = true; base.status = "computed";
        } else if (operation === "grindTime") {
          base.result = grindTime(value.input || value); base.comparable = true; base.status = "computed";
        } else if (operation === "inverseRegression") {
          base.result = inverseRegression(value.points, value.targetSec); base.comparable = true; base.status = "computed";
        } else if (operation === "proposedDd") {
          base.result = proposedDd(value.input || value); base.comparable = true; base.status = "computed";
        } else if (operation === "manual") {
          base.result = manual(value.input || value); base.comparable = true; base.status = "computed";
        }
      } catch (error) { base.status = "invalid"; base.reason = error.message; }
      return base;
    });
    return { schemaVersion: 1, results, provenance: "Side-by-side calculations use separate caller supplied cases; no algorithm state or units are pooled." };
  }
  const ddEff = (initialDdDum, calls) => {
    const state = newState("DdEff", { initialDdDum });
    const values = [];
    const count = calls == null ? 18 : integer(calls, "calls");
    if (count < 0 || count > 64) throw new Error("calls must be between 0 and 64");
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
    recommendNativeResponse,
    nativeResponseContract,
    manual,
    compareAll,
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
      visibleUnit: "decimal dial numbers",
      finerNumericDelta: null,
      provenance: "LAGOM 01 printed coordinate; minor-line movement and model variant must be confirmed separately; absolute zero still matters",
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
      visibleUnit: "decimal dial numbers",
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
    if (input.grinderId && !calibration.grinderId)
      throw new Error("calibration.grinderId is required; explicitly adopt this calibration into an individual grinder profile");
    if (input.grinderId && calibration.grinderId !== input.grinderId)
      throw new Error("calibration grinder identity does not match grinder");
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
  const catalog = {"coffeeCatalog":{"products":[{"availability":"unknown","beanEligible":false,"category":"filter","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"bundle","id":"kaffeemacher-filterkaffee-abo","name":"Abenteuer Filter Abo","origin":null,"process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/filterkaffee-abo"},{"availability":"unknown","beanEligible":false,"category":"filter","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-amigo-filterkaffee","name":"Amigo, Filterkaffee","origin":null,"process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/amigo-filterkaffee"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":true,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-apas-decaf","name":"Apas Decaf, Entkoffeinierter Espresso aus Brasilien","origin":"Brasilien","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":"blend","url":"https://kaffeemacher.ch/products/apas-decaf"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-apas-espresso","name":"Apas, Espresso aus Brasilien","origin":"Brasilien","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/apas-espresso"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-bharath","name":"Bharath - Espresso aus Indien","origin":"Indien","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/bharath"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-compadre","name":"Compadre, italienischer Espresso","origin":null,"process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":"blend","url":"https://kaffeemacher.ch/products/compadre"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"bundle","id":"kaffeemacher-kaffee-geschenkset","name":"Das Kaffee-Geschenkset","origin":null,"process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/kaffee-geschenkset"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":true,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-dipilto-decaf","name":"Dipilto - Decaf Espresso aus Nicaragua","origin":"Nicaragua","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":"blend","url":"https://kaffeemacher.ch/products/dipilto-decaf"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-dreispitz-espresso","name":"Dreispitz, Espresso Blend","origin":null,"process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":"blend","url":"https://kaffeemacher.ch/products/dreispitz-espresso"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-el-boton","name":"El Botón - Kaffee für den Vollautomaten","origin":null,"process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/el-boton"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-felix-deutscher-meister-espresso","name":"Felix – Meisterschaftskaffee aus Kolumbien","origin":"Kolumbien","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/felix-deutscher-meister-espresso"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-flhor-cafe-creme","name":"Flhor - Kaffee aus Honduras","origin":"Honduras","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/flhor-cafe-creme"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-henrique-espresso","name":"Henrique, Espresso aus Brasilien","origin":"Brasilien","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/henrique-espresso"},{"availability":"unknown","beanEligible":false,"category":"filter","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-ichamama-filterkaffee","name":"Ichamama, Filterkaffee aus Kenia","origin":"Kenia","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/ichamama-filterkaffee"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-komal-espresso","name":"Komal, Espresso aus Indien","origin":"Indien","process":"natural","publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/komal-espresso"},{"availability":"unknown","beanEligible":false,"category":"filter","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-lacarolina-filter","name":"La Carolina, Filterkaffee aus Ecuador","origin":"Ecuador","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/lacarolina-filter"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-laconserva-espresso","name":"La Conserva – Espresso aus Guatemala","origin":"Guatemala","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/laconserva-espresso"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-mano","name":"Mano, Espresso Blend","origin":null,"process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":"blend","url":"https://kaffeemacher.ch/products/mano"},{"availability":"unknown","beanEligible":false,"category":"filter","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-meya-filterkaffee","name":"Meya, Filterkaffee aus Mexiko","origin":"Mexiko","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/meya-filterkaffee"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"green-bean","id":"kaffeemacher-rohkaffee-brasilien-apas","name":"Rohkaffee: Brasilien, Apas","origin":null,"process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/rohkaffee-brasilien-apas"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"green-bean","id":"kaffeemacher-rohkaffee-brasilien-henrique","name":"Rohkaffee: Brasilien, Henrique","origin":null,"process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/rohkaffee-brasilien-henrique"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"green-bean","id":"kaffeemacher-rohkaffee-fhlor-honduras","name":"Rohkaffee: Honduras, Flhor","origin":null,"process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/rohkaffee-fhlor-honduras"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-shyira-espresso","name":"Shyira - Espresso aus Ruanda","origin":"Ruanda","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/shyira-espresso"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":true,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-sueno","name":"Sueño, Decaf Espresso aus Mexiko","origin":"Mexiko","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":"blend","url":"https://kaffeemacher.ch/products/sueno"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Shopify product_type and explicit product tags/title"],"format":"unknown","id":"kaffeemacher-toca-espresso","name":"Toca, Espresso aus Mexiko","origin":"Mexiko","process":null,"publisher":"Kaffeemacher","recommendedBrew":null,"roastLevel":null,"sourceId":"kaffeemacher-catalog","tastingDescriptors":[],"type":null,"url":"https://kaffeemacher.ch/products/toca-espresso"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD product name identifies an advent calendar; product-level bundle classification takes precedence over a Whole Beans variant"],"format":"bundle","id":"coffee-circle-adventskalender","name":"Coffee Circle Coffee Advent Calendar","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/adventskalender"},{"availability":"unknown","beanEligible":true,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-apas-espresso","name":"Apas 100% Arabica Espresso","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"espresso","url":"https://www.coffeecircle.com/en/k/apas-espresso"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-arara","name":"Arara Premium Coffee","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/arara"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-buna-dimaa","name":"Buna Dimaa Arabica coffee for fully automatic machines","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/buna-dimaa"},{"availability":"unknown","beanEligible":true,"category":"decaf","decaf":true,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-buna-dimaa-decaf","name":"Buna Dimaa Decaf Coffee","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/buna-dimaa-decaf"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"ready-to-drink","id":"coffee-circle-cascara","name":"Cascara Tea","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"ready-to-drink","url":"https://www.coffeecircle.com/en/k/cascara"},{"availability":"unknown","beanEligible":true,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-cerrado","name":"Cerrado Brazilian Espresso","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"espresso","url":"https://www.coffeecircle.com/en/k/cerrado"},{"availability":"unknown","beanEligible":true,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-chire-espresso","name":"Chire Espresso Premium Espresso","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"espresso","url":"https://www.coffeecircle.com/en/k/chire-espresso"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"ready-to-drink","id":"coffee-circle-cold-brew","name":"Nitro Cold Brew Classic & Latte - Coffee Circle","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"ready-to-drink","url":"https://www.coffeecircle.com/en/k/cold-brew"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-cold-brew-kaffee","name":"a cold brew coffee set of your choice","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/cold-brew-kaffee"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-daterra","name":"Daterra coffee","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/daterra"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"ready-to-drink","id":"coffee-circle-drip-bags","name":"Drip Bags","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"ready-to-drink","url":"https://www.coffeecircle.com/en/k/drip-bags"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-drip-bags-probierset","name":"Drip Bags Probierset online kaufen - Coffee Circle","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/drip-bags-probierset"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-eq-cafe-crema-100","name":"EQ. CAFE CREMA 100 for the Siemens EQ","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/eq-cafe-crema-100"},{"availability":"unknown","beanEligible":true,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-eq-espresso-60","name":"EQ. ESPRESSO 60 for the Siemens EQ","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"espresso","url":"https://www.coffeecircle.com/en/k/eq-espresso-60"},{"availability":"unknown","beanEligible":true,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-eq-espresso-75","name":"EQ. ESPRESSO 75 for the Siemens EQ","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"espresso","url":"https://www.coffeecircle.com/en/k/eq-espresso-75"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-eq-kaffee-set","name":"EQ. coffee Set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/eq-kaffee-set"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-espresso-dunkel-set","name":"dark roast espresso set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/espresso-dunkel-set"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-espresso-entdecker-set","name":"Espresso Explorer Set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/espresso-entdecker-set"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-espresso-probierset","name":"Espresso Tasting Set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/espresso-probierset"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-espresso-set","name":"Espresso Set Medium Roast","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/espresso-set"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-explorer-set","name":"filter coffee tasting set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/explorer-set"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-explorer-set-espresso","name":"Espresso Explorer Set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/explorer-set-espresso"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-filterkaffee-entdecker-set","name":"Filter Coffee Discovery Set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/filterkaffee-entdecker-set"},{"availability":"unknown","beanEligible":true,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-francisco-lopez-espresso","name":"Espresso Francisco Lopez","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"espresso","url":"https://www.coffeecircle.com/en/k/francisco-lopez-espresso"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-frenchpress-kaffee-set","name":"French press Coffees","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/frenchpress-kaffee-set"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-geschenkabo","name":"Gift Subscription - Coffee Circle","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/geschenkabo"},{"availability":"unknown","beanEligible":true,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-grano-gayo-espresso","name":"Grano Gayo Italian Roast Espresso","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"espresso","url":"https://www.coffeecircle.com/en/k/grano-gayo-espresso"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-hambella","name":"Hambella Premium Coffee","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/hambella"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-herbstkaffee-set","name":"autumn coffee set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/herbstkaffee-set"},{"availability":"unknown","beanEligible":true,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-house-blend-espresso","name":"Espresso House Blend","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"espresso","url":"https://www.coffeecircle.com/en/k/house-blend-espresso"},{"availability":"unknown","beanEligible":false,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-kaffee-espresso-probierset","name":"Filter Coffee & Espresso tasting set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/kaffee-espresso-probierset"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-kaffee-probierset","name":"filter coffee tasting set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/kaffee-probierset"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-kaffee-set-kraeftige-roestung","name":"Dark Roast Filter Coffee Set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/kaffee-set-kraeftige-roestung"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-kaffee-vollmundig-set","name":"Filter Coffee Set Full-Bodied Roast","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/kaffee-vollmundig-set"},{"availability":"unknown","beanEligible":false,"category":"decaf","decaf":true,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"capsule","id":"coffee-circle-kaffeekapseln-decaf","name":"Kaffeekapseln Decaf online kaufen - Coffee Circle","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"capsule","url":"https://www.coffeecircle.com/en/k/kaffeekapseln-decaf"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"capsule","id":"coffee-circle-kaffeekapseln-grano-gayo","name":"Kaffeekapseln Grano Gayo online kaufen - Coffee Circle","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"capsule","url":"https://www.coffeecircle.com/en/k/kaffeekapseln-grano-gayo"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"capsule","id":"coffee-circle-kaffeekapseln-limu","name":"Kaffeekapseln Limu online kaufen - Coffee Circle","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"capsule","url":"https://www.coffeecircle.com/en/k/kaffeekapseln-limu"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-kaffeekapseln-probierset","name":"coffee capsules sample set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/kaffeekapseln-probierset"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"capsule","id":"coffee-circle-kaffeekapseln-yirga-santos","name":"Kaffeekapseln Yirga Santos online kaufen - Coffee Circle","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"capsule","url":"https://www.coffeecircle.com/en/k/kaffeekapseln-yirga-santos"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-kapseln-yirgasantos-multipack","name":"Multipack Capsules Yirga Santos","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/kapseln-yirgasantos-multipack"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-karibu","name":"Karibu Arabica Highland Coffee","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/karibu"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-limu","name":"Limu Arabica Highland Coffee","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/limu"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-low-caf-set","name":"Low Caf Set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/low-caf-set"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-multipack-kapseln-decaf","name":"Multipack Capsules Yirga Santos","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/multipack-kapseln-decaf"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-multipack-kapseln-grano-gayo","name":"multipack capsules Grano Gayo","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/multipack-kapseln-grano-gayo"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-multipack-kapseln-limu","name":"multipack capsules Grano Gayo","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/multipack-kapseln-limu"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-rungeto","name":"Rungeto Premium Coffee","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/rungeto"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-san-jose","name":"San José Premium Coffee","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/san-jose"},{"availability":"unknown","beanEligible":true,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-sidamo-espresso","name":"Sidamo 100% Arabica Espresso","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"espresso","url":"https://www.coffeecircle.com/en/k/sidamo-espresso"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-sierra-nevada","name":"Sierra Nevada coffee","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/sierra-nevada"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-tiga-terra","name":"Tiga Terra Omniroast Coffee","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/tiga-terra"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-toleyo","name":"Toleyo filter coffee for fully automatic machines","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/toleyo"},{"availability":"unknown","beanEligible":false,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD name and canonical URL"],"format":"bundle","id":"coffee-circle-vollautomaten-probierset","name":"Fully Automatic Machine testing set","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"bundle","url":"https://www.coffeecircle.com/en/k/vollautomaten-probierset"},{"availability":"unknown","beanEligible":true,"category":"espresso","decaf":true,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-yirga-santos-decaf","name":"Yirga Santos Decaf Espresso Blend","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"espresso","url":"https://www.coffeecircle.com/en/k/yirga-santos-decaf"},{"availability":"unknown","beanEligible":true,"category":"espresso","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-yirga-santos-espresso","name":"Yirga Santos Espresso Blend","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"espresso","url":"https://www.coffeecircle.com/en/k/yirga-santos-espresso"},{"availability":"unknown","beanEligible":true,"category":"unknown","decaf":null,"factSources":["Coffee Circle Product JSON-LD variant explicitly names Whole Beans"],"format":"whole-bean","id":"coffee-circle-yirgacheffe","name":"Yirgacheffe coffee","origin":null,"process":null,"publisher":"Coffee Circle","recommendedBrew":null,"roastLevel":null,"sourceId":"coffee-circle-catalog","tastingDescriptors":[],"type":"filter-or-omni","url":"https://www.coffeecircle.com/en/k/yirgacheffe"}],"retrievedAt":"2026-10-11","schemaVersion":1,"scope":"Published product facts that were available from the named roaster catalog pages. Missing facts remain null; this snapshot is not a stock or price feed.","sources":[{"catalogUrl":"https://kaffeemacher.ch/collections/klassisch-kraeftig/espresso%2C%20online","coverage":{"omittedReason":"Historical collection-only snapshot retained as provenance; current products are in kaffeemacher-catalog.","pagination":"replaced by Kaffeemacher product-sitemap snapshot","status":"superseded"},"id":"kaffeemacher-espresso","publisher":"Kaffeemacher","retrievedAt":"2026-10-11"},{"catalogUrl":"https://www.coffeecircle.com/sitemap.xml","coverage":{"omittedReason":"Non-coffee /en/p/ merchandise and duplicate language routes excluded; bundles, capsules and ready-to-drink products retained with their format.","pagination":"official sitemap, 57 /en/k/ coffee product routes; page titles and Product JSON-LD reviewed","status":"complete"},"id":"coffee-circle-catalog","publisher":"Coffee Circle","retrievedAt":"2026-10-11"},{"catalogUrl":"https://kaffeemacher.ch/sitemap_products_1.xml?from=420080321&to=10318050197602","coverage":{"omittedReason":"Non-coffee merchandise excluded by product_type.","pagination":"Shopify product sitemap and products.json limit=250; 145 published records examined","status":"complete"},"id":"kaffeemacher-catalog","publisher":"Kaffeemacher","retrievedAt":"2026-10-11"}]},"decentProfiles":{"canonicalSnapshot":{"branch":"main","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","directory":"de1plus/profiles","fileCount":88,"repository":"decentespresso/de1app","scope":"Every tracked .tcl file, including hidden, manual, tea, filter, cleaning and calibration profiles. Also all 10 profile files and 6 generated D-Flow presets from the four pinned A/D-Flow submodules. Other installed or user-created profiles are outside this snapshot.","treeComplete":true},"families":[{"id":"pressure_constant","label":"Constant-pressure extraction","reason":"At unchanged dose, yield, basket and temperature, measured extraction time can help compare resistance only while pressure is achieved and no flow limiter controls the shot.","wholeShotTimeGrindPolicy":"conditional"},{"id":"pressure_declining","label":"Declining-pressure extraction","reason":"Compare the same pressure trajectory and yield; rising flow as programmed pressure declines is not automatically channeling, and whole-shot duration is not a universal target.","wholeShotTimeGrindPolicy":"conditional"},{"id":"pressure_rising","label":"Rising-pressure extraction","reason":"Compare against the programmed pressure ramp; an increase in pressure is intentional. Use phase-aligned measurements with the same recipe.","wholeShotTimeGrindPolicy":"conditional"},{"id":"lever_pressure","label":"Lever-style pressure extraction","reason":"Infusion, pressure rise and decline have distinct purposes. Evaluate extraction at matching pressure stages and keep infusion, ratio and temperature fixed.","wholeShotTimeGrindPolicy":"conditional"},{"id":"lever_with_flow_tail","label":"Lever-style extraction with flow fallback","reason":"Pressure-led extraction can switch to a flow-limited rescue tail; whole-shot time combines different controllers. Inspect the actual reached frames and limiter engagement.","wholeShotTimeGrindPolicy":"abstain"},{"id":"flow_fixed","label":"Flow-led extraction","reason":"The controller sets water flow; resistance primarily changes pressure until a pressure limiter engages. Elapsed time alone cannot identify a grind change.","wholeShotTimeGrindPolicy":"abstain"},{"id":"allonge_flow","label":"Allonge with flow-led extraction","reason":"Long ratio and high programmed flow are recipe intent. Compare pressure response, actual beverage flow, ratio and taste; do not chase a conventional espresso duration.","wholeShotTimeGrindPolicy":"abstain"},{"id":"bloom_flow","label":"Bloom then flow-led extraction","reason":"Separate fill, low/no-flow bloom and extraction. Bloom duration or drip mass is profile-specific; extraction flow is commanded.","wholeShotTimeGrindPolicy":"abstain"},{"id":"bloom_pressure","label":"Dynamic bloom then pressure-led extraction","reason":"A pressure-exit bloom intentionally changes length with resistance. Compare bloom and pressure extraction separately; total time is not a single grind-response signal.","wholeShotTimeGrindPolicy":"abstain"},{"id":"turbo_pressure","label":"Turbo-style pressure extraction","reason":"Short/high-flow brewing is intended by this profile. Compare the same phase and recipe, not a universal 25-30 second target; a flow cap may override pressure.","wholeShotTimeGrindPolicy":"conditional"},{"id":"adaptive_flow_scan","label":"Adaptive flow selection","reason":"The profile scans successive flow settings and exits according to measured flow. Grind can change the selected operating point; compare reached frames and achieved targets.","wholeShotTimeGrindPolicy":"abstain"},{"id":"adaptive_mixed","label":"Adaptive mixed pressure and flow","reason":"Measured exits, pressurization and flow ramps couple timing to controller response. Compare phase-specific targets and traces, not a global time error.","wholeShotTimeGrindPolicy":"abstain"},{"id":"a_flow","label":"A-Flow mixed pressure and flow","reason":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","wholeShotTimeGrindPolicy":"abstain"},{"id":"d_flow","label":"D-Flow pressure infusion then flow pour","reason":"Pressure fill/infusion precedes flow pouring with a pressure ceiling. Infusion exit and pouring flow are separate knobs; total time alone does not justify grind adjustment.","wholeShotTimeGrindPolicy":"abstain"},{"id":"manual","label":"Manual group-head control","reason":"The operator changes targets during brewing. A saved starting profile does not describe the actual control trajectory.","wholeShotTimeGrindPolicy":"abstain"},{"id":"non_espresso","label":"Tea or filter-style beverage","reason":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","wholeShotTimeGrindPolicy":"excluded"},{"id":"service","label":"Cleaning, calibration or steam-only setup","reason":"This is not an espresso extraction and must not enter espresso recommendation history.","wholeShotTimeGrindPolicy":"excluded"},{"id":"unknown","label":"Unreviewed or unidentifiable profile","reason":"Show measured traces and targets but do not infer family or a grind adjustment from a title.","wholeShotTimeGrindPolicy":"abstain"}],"interpretation":{"identity":"A matching title is insufficient. The saved brewed profile and recorded targets/frame IDs are authoritative; absent those, classification stays unknown.","limits":"An opposite limiter can dominate the nominal pump mode; load-time defaults and user edits may alter targets. Explicit source limits only are listed.","phases":"Source advanced frame values or descriptive basic GUI stages. Durations are limits, not observed transition timestamps. Disabled zero-duration frames are retained. Smooth targets are end points, not instantaneous flat setpoints.","policy":"conditional does not authorize an automatic numeric correction: it requires identical recipe context, achieved target, no dominant limiter, observed extraction window and repeatable local evidence.","preinfusion":"Volume-count-start is a source accounting boundary, not proof of wetting, first drop or the complete semantic infusion stage. Source count may disagree with step names.","roles":"Manually reviewed semantic roles for these exact sources; no physiological saturation assertion. Not inferred from name alone during runtime.","units":"Flow targets and volume exits are machine water mL/s and mL, not scale g/s and beverage grams. No density or retention conversion is assumed."},"licenseReview":{"mainRepository":"GPL-3.0 license file at pinned commit","reuse":"Original factual controller summaries, numeric facts, short names and source references only. Full source notes and profile implementations remain upstream.","submodules":"No explicit license file found in the four reviewed pinned A/D-Flow submodule trees. No code, manuals or images copied into this catalog.","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/LICENSE"},"profiles":[{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"pressure_declining","grindTimeAssumption":"Compare the same pressure trajectory and yield; rising flow as programmed pressure declines is not automatically channeling, and whole-shot duration is not a universal target.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/7g basket.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4.5,"type":"pressure_over"},"index":0,"maximumDurationSeconds":8,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":2.4,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":6,"name":"Rise / hold","oppositeLimit":{"target":6,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":7.5,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":2,"maximumDurationSeconds":10,"name":"Pressure ramp","oppositeLimit":{"target":6,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":4.5,"temperatureC":90,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"}],"source":{"blobSha":"907915a270edf34b5f04ce69818b80d038a208c8","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/7g basket.tcl","repository":"decentespresso/de1app","sha256":"5bdeb8ad92ad46d6c5f3e7d6f7ba9af53a55288c43539c2c5ff682a9ff490f11","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/7g%20basket.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":2,"title":"7g basket","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","Designer scopes this recipe to the 7 g basket; do not transfer its response to a different basket/dose."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"pressure_declining","grindTimeAssumption":"Compare the same pressure trajectory and yield; rising flow as programmed pressure declines is not automatically channeling, and whole-shot duration is not a universal target.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/80s_Espresso.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"preinfusion start","pump":"flow","role":"preinfusion","target":7.5,"temperatureC":82,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"exit":{"threshold":3.8,"type":"pressure_over"},"index":1,"maximumDurationSeconds":6,"name":"preinfusion","pump":"flow","role":"preinfusion","target":7.5,"temperatureC":82,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":2,"maximumDurationSeconds":4,"name":"rise and hold","pump":"pressure","role":"extraction","target":7.8,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":3,"maximumDurationSeconds":50,"name":"decline","pump":"pressure","role":"extraction","target":5,"temperatureC":72,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"}],"source":{"blobSha":"a6d782bec9e35c37c620f71c7233d3c35c526ca9","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/80s_Espresso.tcl","repository":"decentespresso/de1app","sha256":"aea8cede64595ce6302882e4d59cb949588f88efec078f9ebd0f16be9ea777e1","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/80s_Espresso.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"80's Espresso","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/A-Flow____default-dark.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":1,"maximumDurationSeconds":10,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":2},{"exit":{"threshold":2,"type":"flow_over"},"index":2,"maximumDurationSeconds":5,"name":"Pressure Up","pump":"pressure","role":"extraction","target":9,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.1,"type":"flow_under"},"index":3,"maximumDurationSeconds":0,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":4,"maximumDurationSeconds":0,"name":"Flow Start","pump":"flow","role":"extraction","target":2,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":5,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":9,"unit":"bar"},"pump":"flow","role":"extraction","target":0,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"ea80f03b35384abd83df2e4c1e551bed440d1093","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/A-Flow____default-dark.tcl","repository":"decentespresso/de1app","sha256":"d44661a6fccd48f60307a1f6230c54c1d9e795d832d0cf253c0e6c3b0b852a28","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/A-Flow____default-dark.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-dark","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/A-Flow____default-like-dflow.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":1,"maximumDurationSeconds":60,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":4},{"exit":{"threshold":2,"type":"flow_over"},"index":2,"maximumDurationSeconds":0,"name":"Pressure Up","pump":"pressure","role":"extraction","target":10,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.1,"type":"flow_under"},"index":3,"maximumDurationSeconds":0,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.9,"type":"flow_over"},"index":4,"maximumDurationSeconds":10,"name":"Flow Start","pump":"flow","role":"extraction","target":2,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":5,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":10,"unit":"bar"},"pump":"flow","role":"extraction","target":4,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"ba764c6af242008819f3f4a76f462de4a1382c61","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/A-Flow____default-like-dflow.tcl","repository":"decentespresso/de1app","sha256":"9d724d49b7f2ce00638425b1f56ed1daf5371f71110eb78d501ccb65e2858b33","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/A-Flow____default-like-dflow.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-like-dflow","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/A-Flow____default-medium.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":1,"maximumDurationSeconds":60,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":3.6},{"exit":{"threshold":2,"type":"flow_over"},"index":2,"maximumDurationSeconds":10,"name":"Pressure Up","pump":"pressure","role":"extraction","target":10,"temperatureC":95,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2,"type":"flow_under"},"index":3,"maximumDurationSeconds":0,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":4,"maximumDurationSeconds":0,"name":"Flow Start","pump":"flow","role":"extraction","target":2,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":5,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":10,"unit":"bar"},"pump":"flow","role":"extraction","target":4,"temperatureC":95,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"5b90b46c3bec018880a9468e79748531adad355d","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/A-Flow____default-medium.tcl","repository":"decentespresso/de1app","sha256":"fcc5e02392dff1f68c77e0c29261f01120bf045b99e377469e9a5bba91bed238","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/A-Flow____default-medium.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-medium","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/A-Flow____default-very-dark.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":1,"maximumDurationSeconds":6,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":2},{"exit":{"threshold":3.6,"type":"flow_over"},"index":2,"maximumDurationSeconds":3,"name":"Pressure Up","pump":"pressure","role":"extraction","target":10,"temperatureC":95,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.9,"type":"flow_under"},"index":3,"maximumDurationSeconds":3,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":4,"maximumDurationSeconds":0,"name":"Flow Start","pump":"flow","role":"extraction","target":1.8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":5,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":10,"unit":"bar"},"pump":"flow","role":"extraction","target":3.6,"temperatureC":95,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"28de4ef07062dffbd43982afa02528d71788a0fa","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/A-Flow____default-very-dark.tcl","repository":"decentespresso/de1app","sha256":"498f4aca7669562299225b674a8f5f9c7e92f50b6893f9dc450474d6de94efb4","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/A-Flow____default-very-dark.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-very-dark","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"lever_with_flow_tail","grindTimeAssumption":"Pressure-led extraction can switch to a flow-limited rescue tail; whole-shot time combines different controllers. Inspect the actual reached frames and limiter engagement.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Advanced spring lever.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":6,"type":"pressure_over"},"index":0,"maximumDurationSeconds":2,"name":"2s infuse","pump":"flow","role":"preinfusion","target":8,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"exit":{"threshold":6,"type":"pressure_over"},"index":1,"maximumDurationSeconds":10,"name":"infuse","pump":"flow","role":"preinfusion","target":8,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":2,"maximumDurationSeconds":3,"name":"rise and hold","pump":"pressure","role":"extraction","target":9,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"exit":{"threshold":6,"type":"pressure_under"},"index":3,"maximumDurationSeconds":30,"name":"decline","oppositeLimit":{"range":0.6,"target":1.5,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":6,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"},{"index":4,"maximumDurationSeconds":30,"name":"maintain flow","oppositeLimit":{"range":0.6,"target":6,"unit":"bar"},"pump":"flow","role":"extraction","target":1.5,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s"}],"source":{"blobSha":"9124b14f90c4e78253831753de555cb4867aa1df","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Advanced spring lever.tcl","repository":"decentespresso/de1app","sha256":"c99532ee8eb543ad0bda39ff67b7207538f7f68ee9f6eb6cd94985534aee476e","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Advanced%20spring%20lever.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":0,"title":"Advanced spring lever","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"pressure_declining","grindTimeAssumption":"Compare the same pressure trajectory and yield; rising flow as programmed pressure declines is not automatically channeling, and whole-shot duration is not a universal target.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/Best overall pressure profile.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":10,"name":"Rise / hold","oppositeLimit":{"target":3.5,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":8.4,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":2,"maximumDurationSeconds":30,"name":"Pressure ramp","oppositeLimit":{"target":3.5,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":6,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"}],"source":{"blobSha":"2848a5e2226e78bc06e860bb4af9e8f6c7129bf4","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Best overall pressure profile.tcl","repository":"decentespresso/de1app","sha256":"bd866df638fe7ef55d7607aef349ee442f13f499dfa8082ab3c6fcae76f73555","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Best%20overall%20pressure%20profile.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":0,"title":"Best overall pressure profile","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"bloom_flow","grindTimeAssumption":"Separate fill, low/no-flow bloom and extraction. Bloom duration or drip mass is profile-specific; extraction flow is commanded.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Blooming allonge.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"fast pre start","pump":"flow","role":"preinfusion","target":4.5,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":3.5,"type":"pressure_over"},"index":1,"maximumDurationSeconds":3,"name":"fast pre","pump":"flow","role":"preinfusion","target":4.5,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":3.5,"type":"pressure_over"},"index":2,"maximumDurationSeconds":15,"name":"ramp down pre","pump":"flow","role":"preinfusion","target":2,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":30,"name":"bloom","pump":"flow","role":"bloom","target":0,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":4,"maximumDurationSeconds":7,"name":"ramp","pump":"flow","role":"extraction","target":3.5,"temperatureC":92.5,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":60,"name":"hold at 3.5 ml/s","oppositeLimit":{"range":0.6,"target":8.6,"unit":"bar"},"pump":"flow","role":"extraction","target":3.5,"temperatureC":91,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"9be23f49152fe6b7e61eb64eb5d2e16424d02938","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Blooming allonge.tcl","repository":"decentespresso/de1app","sha256":"9e57454de7072bca687e64ba877ba216af0cf488c8878812977b55ee65151bea","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Blooming%20allonge.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":0,"title":"Blooming Allongé","warnings":["Allonge variant with long ratio intent; the bloom makes total duration incomparable with non-blooming allonge."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"bloom_flow","grindTimeAssumption":"Separate fill, low/no-flow bloom and extraction. Bloom duration or drip mass is profile-specific; extraction flow is commanded.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Blooming espresso.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"preinfusion start","pump":"flow","role":"preinfusion","target":4,"temperatureC":97.5,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":4,"type":"pressure_over"},"index":1,"maximumDurationSeconds":23,"name":"preinfusion","pump":"flow","role":"preinfusion","target":4,"temperatureC":97.5,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":2,"maximumDurationSeconds":30,"name":"pause","pump":"flow","role":"bloom","target":0,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":5,"name":"ramp","pump":"flow","role":"extraction","target":2.2,"temperatureC":92,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":500},{"index":4,"maximumDurationSeconds":20,"name":"flat flow","oppositeLimit":{"range":0.6,"target":8.6,"unit":"bar"},"pump":"flow","role":"extraction","target":2.2,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":1,"name":"reset temperature","pump":"flow","role":"reset","target":0,"temperatureC":98,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"4bec0c6c06446bf86748ed21a803d5813b90bdef","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Blooming espresso.tcl","repository":"decentespresso/de1app","sha256":"d1ee4a929702efed6c0006926363b98eb3a75b259b4aedd8969ff73e5afc04ba","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Blooming%20espresso.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Blooming Espresso","warnings":[]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"pressure_constant","grindTimeAssumption":"At unchanged dose, yield, basket and temperature, measured extraction time can help compare resistance only while pressure is achieved and no flow limiter controls the shot.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/Classic Italian espresso.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":8,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":35,"name":"Rise / hold","oppositeLimit":{"target":4.5,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":9,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar"}],"source":{"blobSha":"67934ba4f5ba674f27f7811fed0ac122d4d31395","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Classic Italian espresso.tcl","repository":"decentespresso/de1app","sha256":"de7ed4db23fa9ece3a3a3deaa0ccd7acdf3bd5f2d5e19b38238d5ea59160d624","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Classic%20Italian%20espresso.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":0,"title":"Classic Italian espresso","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"service","grindTimeAssumption":"This is not an espresso extraction and must not enter espresso recommendation history.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/Cleaning_forward_flush_x5.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"Pressure rise 1 start","pump":"pressure","role":"service","target":9.999999999999993,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":1,"maximumDurationSeconds":18,"name":"Pressure rise 1","pump":"pressure","role":"service","target":9.999999999999993,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":15,"name":"Pause 1","pump":"pressure","role":"service","target":0,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":3,"maximumDurationSeconds":15,"name":"Pressure rise 2","pump":"pressure","role":"service","target":9.999999999999993,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":15,"name":"Pause 2","pump":"pressure","role":"service","target":-3.885780586188048e-16,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":5,"maximumDurationSeconds":15,"name":"Pressure rise 3","pump":"pressure","role":"service","target":9.999999999999993,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":15,"name":"Pause 3","pump":"pressure","role":"service","target":-5.717648576819556e-15,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":7,"maximumDurationSeconds":15,"name":"Pressure rise 4","pump":"pressure","role":"service","target":9.999999999999993,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":8,"maximumDurationSeconds":15,"name":"Pause 4","pump":"pressure","role":"service","target":-5.717648576819556e-15,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":9,"maximumDurationSeconds":15,"name":"Pressure rise 5","pump":"pressure","role":"service","target":9.999999999999993,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500}],"source":{"blobSha":"154e6e1447808550795256b0c6c9c8971047b205","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Cleaning_forward_flush_x5.tcl","repository":"decentespresso/de1app","sha256":"8dc9dd886627499fa2ac748617dcb387515899e92beaa30ee620b02901d211d7","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Cleaning_forward_flush_x5.tcl"},"sourceBeverageType":"cleaning","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Cleaning/Forward Flush x5","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"lever_pressure","grindTimeAssumption":"Infusion, pressure rise and decline have distinct purposes. Evaluate extraction at matching pressure stages and keep infusion, ratio and temperature fixed.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/Cremina.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"preinfusion start","pump":"pressure","role":"preinfusion","target":1.1,"temperatureC":91.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":3,"type":"pressure_over"},"index":1,"maximumDurationSeconds":3,"name":"preinfusion","pump":"pressure","role":"preinfusion","target":1.1,"temperatureC":91.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":2,"maximumDurationSeconds":10,"name":"soak","pump":"pressure","role":"preinfusion","target":1.1,"temperatureC":91.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":3,"maximumDurationSeconds":10,"name":"ramp","pump":"pressure","role":"extraction","target":9,"temperatureC":91.5,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":4,"maximumDurationSeconds":50,"name":"ramp-down","pump":"pressure","role":"extraction","target":3,"temperatureC":92,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100}],"source":{"blobSha":"5d63817b28666d2ac39900efe6f0cdd0d989f2ff","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Cremina.tcl","repository":"decentespresso/de1app","sha256":"595248acc3abb601da99321e41d182eae0f301a562db4057fc870be713b3c818","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Cremina.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":0,"title":"Cremina lever machine","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"lever_pressure","grindTimeAssumption":"Infusion, pressure rise and decline have distinct purposes. Evaluate extraction at matching pressure stages and keep infusion, ratio and temperature fixed.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/Damian's LM Leva.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"fill start","pump":"pressure","role":"preinfusion","target":1.8,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1,"type":"pressure_over"},"index":1,"maximumDurationSeconds":20,"name":"fill","pump":"pressure","role":"preinfusion","target":1.8,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":4,"type":"pressure_over"},"index":2,"maximumDurationSeconds":10,"name":"preinfusion","pump":"pressure","role":"preinfusion","target":2.2,"temperatureC":88.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":8,"type":"pressure_over"},"index":3,"maximumDurationSeconds":5,"name":"rise","pump":"pressure","role":"extraction","target":8,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.5,"type":"flow_over"},"index":4,"maximumDurationSeconds":5,"name":"hold","pump":"pressure","role":"extraction","target":8,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":5,"maximumDurationSeconds":58,"name":"decline","pump":"pressure","role":"extraction","target":2.2,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100}],"source":{"blobSha":"2382e61115b8fc7766e69b366d06fe5f5b2fd38a","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Damian's LM Leva.tcl","repository":"decentespresso/de1app","sha256":"e2f76238178c047fe8890705a974e3855057c505bc39174bcb1cb5daa73a708f","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Damian's%20LM%20Leva.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Damian's LM Leva","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"lever_with_flow_tail","grindTimeAssumption":"Pressure-led extraction can switch to a flow-limited rescue tail; whole-shot time combines different controllers. Inspect the actual reached frames and limiter engagement.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Damian's LRv2.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"Fill start","pump":"pressure","role":"preinfusion","target":2,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.5,"type":"pressure_over"},"index":1,"maximumDurationSeconds":25,"name":"Fill","pump":"pressure","role":"preinfusion","target":2,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":2,"maximumDurationSeconds":12,"name":"Infuse","pump":"pressure","role":"preinfusion","target":3,"temperatureC":88.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":3,"maximumDurationSeconds":8,"name":"Pressure Up","pump":"pressure","role":"extraction","target":9,"temperatureC":88.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.8,"type":"flow_over"},"index":4,"maximumDurationSeconds":55,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":3,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.8,"type":"flow_over"},"index":5,"maximumDurationSeconds":127,"name":"Pressure Hold","pump":"pressure","role":"extraction","target":3,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":6,"maximumDurationSeconds":127,"name":"Flow Limit","pump":"flow","role":"extraction","target":2.5,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"d31bc8075812fc29781c4da52a8ccae1f7a7d72b","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Damian's LRv2.tcl","repository":"decentespresso/de1app","sha256":"d25ddafc4430a244bbe53a56e25cc20119d8f9c2f409e65385d6ed4cb1b8cbdf","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Damian's%20LRv2.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Damian's LRv2","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"lever_with_flow_tail","grindTimeAssumption":"Pressure-led extraction can switch to a flow-limited rescue tail; whole-shot time combines different controllers. Inspect the actual reached frames and limiter engagement.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Damian's LRv3.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"Fill start","pump":"pressure","role":"preinfusion","target":2,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.5,"type":"pressure_over"},"index":1,"maximumDurationSeconds":25,"name":"Fill","pump":"pressure","role":"preinfusion","target":2,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":2,"maximumDurationSeconds":12,"name":"Infuse","pump":"pressure","role":"preinfusion","target":3,"temperatureC":89.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":3,"maximumDurationSeconds":4,"name":"Pressure Up","pump":"pressure","role":"extraction","target":9,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.9,"type":"flow_over"},"index":4,"maximumDurationSeconds":30,"name":"9 Bar Hold","pump":"pressure","role":"extraction","target":9,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.8,"type":"flow_over"},"index":5,"maximumDurationSeconds":35,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":5.5,"temperatureC":89,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.8,"type":"flow_over"},"index":6,"maximumDurationSeconds":127,"name":"5 Bar Hold","pump":"pressure","role":"extraction","target":5.5,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":7,"maximumDurationSeconds":127,"name":"Flow Limit","pump":"flow","role":"extraction","target":2.2,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"3cc08dd2b2f96d0b093c3d649633a7ddd6b5dc73","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Damian's LRv3.tcl","repository":"decentespresso/de1app","sha256":"8f99a14e9460bcfd5cbe5e489763d5c6e70b620d365f3879be3f5c682b40c5de","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Damian's%20LRv3.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Damian's LRv3","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"d_flow","grindTimeAssumption":"Pressure fill/infusion precedes flow pouring with a pressure ceiling. Infusion exit and pouring flow are separate knobs; total time alone does not justify grind adjustment.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Damians_Q.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":25,"name":"Filling","pump":"pressure","role":"preinfusion","target":6,"temperatureC":84,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":60},{"index":1,"maximumDurationSeconds":1,"name":"Infusing","pump":"pressure","role":"preinfusion","target":6,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":2,"maximumDurationSeconds":127,"name":"Pouring","oppositeLimit":{"range":0.2,"target":10,"unit":"bar"},"pump":"flow","role":"extraction","target":1.8,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"8869b676fa24fd09bf76cda255918fe660bf0bf2","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Damians_Q.tcl","repository":"decentespresso/de1app","sha256":"1300d597fedf6eab4f71d27c7b51baf0e46f837153d2402d849c76a7b9a7938d","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Damians_Q.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Damian's Q","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"lever_pressure","grindTimeAssumption":"Infusion, pressure rise and decline have distinct purposes. Evaluate extraction at matching pressure stages and keep infusion, ratio and temperature fixed.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/EspressoForge_Dark.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":10,"name":"preinfusion","pump":"flow","role":"preinfusion","target":6,"temperatureC":84,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":1,"maximumDurationSeconds":8,"name":"rise and hold","pump":"pressure","role":"extraction","target":7.5,"temperatureC":81,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":2,"maximumDurationSeconds":30,"name":"decline","pump":"pressure","role":"extraction","target":3,"temperatureC":78,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":3,"maximumDurationSeconds":1,"name":"reset temperature","pump":"flow","role":"reset","target":0,"temperatureC":84,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"3066643ef4c3f57ae692a96052fc85d57496950c","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/EspressoForge_Dark.tcl","repository":"decentespresso/de1app","sha256":"45cddccfa5d971911de4079eb77a72000f826370cca1c7481d408bce9dfec1f2","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/EspressoForge_Dark.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":null,"title":"Espresso Forge Dark","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"lever_pressure","grindTimeAssumption":"Infusion, pressure rise and decline have distinct purposes. Evaluate extraction at matching pressure stages and keep infusion, ratio and temperature fixed.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/EspressoForge_Light.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":0.5,"type":"pressure_over"},"index":0,"maximumDurationSeconds":10,"name":"preinfusion","pump":"flow","role":"preinfusion","target":6,"temperatureC":96,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":1,"maximumDurationSeconds":25,"name":"long pre brew","pump":"pressure","role":"preinfusion","target":1,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":10,"type":"pressure_over"},"index":2,"maximumDurationSeconds":20,"name":"high pressure ramp","pump":"pressure","role":"extraction","target":10,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":3,"maximumDurationSeconds":50,"name":"decline","pump":"pressure","role":"extraction","target":6,"temperatureC":92.5,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":4,"maximumDurationSeconds":1,"name":"reset temperature","pump":"flow","role":"reset","target":0,"temperatureC":96,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"4820e0b645d63d852013a2d9aebaf3cef18e9ffe","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/EspressoForge_Light.tcl","repository":"decentespresso/de1app","sha256":"5d4a56a708991f1ee4794f9800e6090ee84f9c5f94df9ba3013931549249a59a","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/EspressoForge_Light.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":null,"title":"Espresso Forge Light","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"bloom_pressure","grindTimeAssumption":"A pressure-exit bloom intentionally changes length with resistance. Compare bloom and pressure extraction separately; total time is not a single grind-response signal.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Extractamundo_Dos.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"preinfusion start","pump":"pressure","role":"preinfusion","target":8,"temperatureC":83.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":4.5,"type":"pressure_over"},"index":1,"maximumDurationSeconds":20,"name":"preinfusion","pump":"pressure","role":"preinfusion","target":8,"temperatureC":83.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.2,"type":"pressure_under"},"index":2,"maximumDurationSeconds":40,"name":"dynamic bloom","pump":"flow","role":"bloom","target":0,"temperatureC":67.5,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":0,"type":"flow_under"},"index":3,"maximumDurationSeconds":60,"name":"6 bar","oppositeLimit":{"range":3,"target":1,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":6.0000000000000036,"temperatureC":74.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100}],"source":{"blobSha":"17d2ceec6e1e8e9a2b40c7634060dbd831f40b28","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Extractamundo_Dos.tcl","repository":"decentespresso/de1app","sha256":"6799a800be5d326897767d1bdf0e0757b158d68ac11ddd9530d96a335a14005f","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Extractamundo_Dos.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Extractamundo Dos!","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/Filter_20.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":6,"name":"preinfusion","pump":"flow","role":"non_espresso","target":5,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":465},{"index":1,"maximumDurationSeconds":120,"name":"pause","pump":"flow","role":"non_espresso","target":0,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":2,"maximumDurationSeconds":120,"name":"flat flow","oppositeLimit":{"range":0.6,"target":3,"unit":"bar"},"pump":"flow","role":"non_espresso","target":3,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500,"weightExitG":150},{"index":3,"maximumDurationSeconds":1,"name":"reset temperature","pump":"flow","role":"non_espresso","target":0,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"2e3f1217060f4846b193c23c43f1f503d1f341fe","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Filter_20.tcl","repository":"decentespresso/de1app","sha256":"121e91eb595ed1d915d27882cae659cb42542b8894195e04a7e32fb171d506d6","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Filter_20.tcl"},"sourceBeverageType":"filter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Filter 2.0","warnings":[]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/Filter_21.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":4,"name":"preinfusion","pump":"flow","role":"non_espresso","target":4,"temperatureC":98,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":8,"name":"preinfusion","pump":"flow","role":"non_espresso","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s"},{"exit":{"threshold":0.3,"type":"pressure_over"},"index":2,"maximumDurationSeconds":10,"name":"preinfusion","pump":"flow","role":"non_espresso","target":1,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":3,"maximumDurationSeconds":90,"name":"0.1 mL/s bloom","pump":"flow","role":"non_espresso","target":0.1,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":4,"maximumDurationSeconds":10,"name":"ramp","oppositeLimit":{"range":0.6,"target":0.8,"unit":"bar"},"pump":"flow","role":"non_espresso","target":3,"temperatureC":87,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s"},{"index":5,"maximumDurationSeconds":60,"name":"3 mL/s","oppositeLimit":{"range":0.6,"target":0.8,"unit":"bar"},"pump":"flow","role":"non_espresso","target":3,"temperatureC":84,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"}],"source":{"blobSha":"2c081b3a5a275084e5c60d0746ba0a21c8a91fca","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Filter_21.tcl","repository":"decentespresso/de1app","sha256":"4c947582d66a5ad6923a6a891a019c1f7de952d6ea005655e0dee3fe2a0b17bf","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Filter_21.tcl"},"sourceBeverageType":"pourover","sourceSettingsType":"settings_2c","sourceVolumeCountStart":0,"title":"Filter 2.1","warnings":[]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"flow_fixed","grindTimeAssumption":"The controller sets water flow; resistance primarily changes pressure until a pressure limiter engages. Elapsed time alone cannot identify a grind change.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Flow profile for milky drinks.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":5,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":30,"name":"Flow hold","oppositeLimit":{"target":8.6,"unit":"bar"},"pump":"flow","role":"extraction","target":1.2,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"}],"source":{"blobSha":"40579f97ddfedcac28eac657231bab0556457529","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Flow profile for milky drinks.tcl","repository":"decentespresso/de1app","sha256":"c78909847f579390e7a32fe9cf047c7db2953c75429d54c67b55d83c430e2a5e","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Flow%20profile%20for%20milky%20drinks.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2b","sourceVolumeCountStart":0,"title":"Flow profile for milky drinks","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"flow_fixed","grindTimeAssumption":"The controller sets water flow; resistance primarily changes pressure until a pressure limiter engages. Elapsed time alone cannot identify a grind change.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Flow profile for straight espresso.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":5,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":30,"name":"Flow hold","oppositeLimit":{"target":8.6,"unit":"bar"},"pump":"flow","role":"extraction","target":2,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"}],"source":{"blobSha":"ba58627bc5f0b5d1a78013dcdf799a6abd96391b","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Flow profile for straight espresso.tcl","repository":"decentespresso/de1app","sha256":"bb627dd0bdac1073c83d50d38b5fe7562aec1541692bb1e2be11f0a1013433a8","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Flow%20profile%20for%20straight%20espresso.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2b","sourceVolumeCountStart":0,"title":"Flow profile for straight espresso","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"pressure_declining","grindTimeAssumption":"Compare the same pressure trajectory and yield; rising flow as programmed pressure declines is not automatically channeling, and whole-shot duration is not a universal target.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/Gentle and sweet.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":16,"name":"Rise / hold","oppositeLimit":{"target":4,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":6,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":2,"maximumDurationSeconds":30,"name":"Pressure ramp","oppositeLimit":{"target":4,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":4,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"}],"source":{"blobSha":"1232f7ef428955d796143510b04c619ef8e848d9","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Gentle and sweet.tcl","repository":"decentespresso/de1app","sha256":"a35276ede543a1825e486d5a77128b481941e808954ef1df9f961f6efc9fa548","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Gentle%20and%20sweet.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":0,"title":"Gentle and sweet","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"flow_fixed","grindTimeAssumption":"The controller sets water flow; resistance primarily changes pressure until a pressure limiter engages. Elapsed time alone cannot identify a grind change.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Gentle flat 2.5 ml per second.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":10,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":2.5,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":45,"name":"Flow hold","pump":"flow","role":"extraction","target":2.5,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"}],"source":{"blobSha":"b33eb7e6674beaf0eb4d5a3b42b052ed7653716f","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Gentle flat 2.5 ml per second.tcl","repository":"decentespresso/de1app","sha256":"70d9e8dc084c6dca9cfe9b64887b806ed8930d731574a54adc51d67dc677f681","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Gentle%20flat%202.5%20ml%20per%20second.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2b","sourceVolumeCountStart":0,"title":"Gentle flat 2.5 ml per second","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"flow_fixed","grindTimeAssumption":"The controller sets water flow; resistance primarily changes pressure until a pressure limiter engages. Elapsed time alone cannot identify a grind change.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Gentle preinfusion flow profile.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":30,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":3.5,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":21,"name":"Flow hold","pump":"flow","role":"extraction","target":2.2,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"}],"source":{"blobSha":"efb2df542e322880acbff612370578911a2afaa5","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Gentle preinfusion flow profile.tcl","repository":"decentespresso/de1app","sha256":"e85cdf312057430a0cf8309403ab7632390535c1dcf727c88338a6cbeba8a9f5","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Gentle%20preinfusion%20flow%20profile.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2b","sourceVolumeCountStart":0,"title":"Gentle preinfusion flow profile","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"pressure_declining","grindTimeAssumption":"Compare the same pressure trajectory and yield; rising flow as programmed pressure declines is not automatically channeling, and whole-shot duration is not a universal target.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/Gentler but still traditional 8.4 bar.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":10,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":4,"temperatureC":89.5,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":31,"name":"Rise / hold","pump":"pressure","role":"extraction","target":8.4,"temperatureC":89.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":2,"maximumDurationSeconds":2,"name":"Pressure ramp","pump":"pressure","role":"extraction","target":6,"temperatureC":89.5,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"}],"source":{"blobSha":"6e64529d2d0361544f580f90d13204fb64858bb7","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Gentler but still traditional 8.4 bar.tcl","repository":"decentespresso/de1app","sha256":"c4ad0cc804c9b1a204fb81ccadc64219a2cefa875fa4b5a3d52f628d0e5438c8","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Gentler%20but%20still%20traditional%208.4%20bar.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":0,"title":"Gentler but still traditional 8.4 bar","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"flow_fixed","grindTimeAssumption":"The controller sets water flow; resistance primarily changes pressure until a pressure limiter engages. Elapsed time alone cannot identify a grind change.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Hybrid pour over espresso.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":1.5,"type":"pressure_over"},"index":0,"maximumDurationSeconds":25,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":2,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":20,"name":"Flow hold","pump":"flow","role":"extraction","target":2.2,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"}],"source":{"blobSha":"710c1215de3cbcc720476ce946e85f3f3f57b0a2","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Hybrid pour over espresso.tcl","repository":"decentespresso/de1app","sha256":"0fc415ca30986823fd19fcffb8c2599a46829f5fce8fdd1829d3212c07b33bf5","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Hybrid%20pour%20over%20espresso.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2b","sourceVolumeCountStart":null,"title":"Hybrid pour over espresso","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"adaptive_mixed","grindTimeAssumption":"Measured exits, pressurization and flow ramps couple timing to controller response. Compare phase-specific targets and traces, not a global time error.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/I_got_your_back.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"preinfusion start","pump":"flow","role":"preinfusion","target":4,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":4,"type":"pressure_over"},"index":1,"maximumDurationSeconds":11,"name":"preinfusion","pump":"flow","role":"preinfusion","target":4,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":10,"type":"pressure_over"},"index":2,"maximumDurationSeconds":30,"name":"Low Resistance","pump":"flow","role":"adaptive","target":2.2,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":2,"type":"pressure_under"},"index":3,"maximumDurationSeconds":60,"name":"Pause at HR","pump":"flow","role":"bloom","target":0,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":4,"maximumDurationSeconds":5,"name":"ramp","pump":"flow","role":"extraction","target":2.2,"temperatureC":90,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":0,"type":"pressure_under"},"index":5,"maximumDurationSeconds":30,"name":"flat flow","oppositeLimit":{"range":0.6,"target":8.6,"unit":"bar"},"pump":"flow","role":"extraction","target":2.2,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"1e2d810120459802b9947ba50d7f640b839294d5","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/I_got_your_back.tcl","repository":"decentespresso/de1app","sha256":"fb01913c7e59f8f2813bc9946bf4138cc78bc76683f870f5b368c1a24798672d","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/I_got_your_back.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"I got your back","warnings":[]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"flow_fixed","grindTimeAssumption":"The controller sets water flow; resistance primarily changes pressure until a pressure limiter engages. Elapsed time alone cannot identify a grind change.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Innovative long preinfusion.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":2,"type":"pressure_over"},"index":0,"maximumDurationSeconds":37,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":1.5,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":25,"name":"Flow hold","oppositeLimit":{"target":9.5,"unit":"bar"},"pump":"flow","role":"extraction","target":2.5,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"}],"source":{"blobSha":"b467cadd9cad37a08de0643069b429c04fb32e9d","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Innovative long preinfusion.tcl","repository":"decentespresso/de1app","sha256":"5460b8d7bdefa43199efa3a0a332809abef9768151e12c8bc40a80bce66a1ec2","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Innovative%20long%20preinfusion.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2b","sourceVolumeCountStart":0,"title":"Innovative long preinfusion","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"pressure_constant","grindTimeAssumption":"At unchanged dose, yield, basket and temperature, measured extraction time can help compare resistance only while pressure is achieved and no flow limiter controls the shot.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/Italian Australian espresso.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":8,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":4.5,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":35,"name":"Rise / hold","pump":"pressure","role":"extraction","target":8.7,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar"}],"source":{"blobSha":"f2dcae9aa913df275c1acebc15568eea68e5447c","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Italian Australian espresso.tcl","repository":"decentespresso/de1app","sha256":"9af1ea7f46e234f00060b4b866de0526a7bc52bb3bcd0cb4b1cb8759f7407a5d","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Italian%20Australian%20espresso.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":0,"title":"Italian Australian espresso","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"lever_with_flow_tail","grindTimeAssumption":"Pressure-led extraction can switch to a flow-limited rescue tail; whole-shot time combines different controllers. Inspect the actual reached frames and limiter engagement.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Londonium.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"Fill start","pump":"pressure","role":"preinfusion","target":2,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.5,"type":"pressure_over"},"index":1,"maximumDurationSeconds":25,"name":"Fill","pump":"pressure","role":"preinfusion","target":2,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":2,"maximumDurationSeconds":12,"name":"Infuse","pump":"pressure","role":"preinfusion","target":3,"temperatureC":88.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":3,"maximumDurationSeconds":8,"name":"Pressure Up","pump":"pressure","role":"extraction","target":9,"temperatureC":88.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.8,"type":"flow_over"},"index":4,"maximumDurationSeconds":55,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":3,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.8,"type":"flow_over"},"index":5,"maximumDurationSeconds":127,"name":"Pressure Hold","pump":"pressure","role":"extraction","target":3,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":6,"maximumDurationSeconds":127,"name":"Flow Limit","pump":"flow","role":"extraction","target":2.5,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"afc26afc8df8b64c6e5b14c2bdfbd6b265992b97","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Londonium.tcl","repository":"decentespresso/de1app","sha256":"bbc552aa908d0c963df25ebe2c0e9ce5877a6b6722d62efaf8c3c2fa704d2251","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Londonium.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Londonium","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"lever_pressure","grindTimeAssumption":"Infusion, pressure rise and decline have distinct purposes. Evaluate extraction at matching pressure stages and keep infusion, ratio and temperature fixed.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/Low pressure lever machine at 6 bar.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":4.5,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":8,"name":"Rise / hold","pump":"pressure","role":"extraction","target":6,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":2,"maximumDurationSeconds":27,"name":"Pressure ramp","pump":"pressure","role":"extraction","target":0,"temperatureC":94,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"}],"source":{"blobSha":"9f518019148006c0a074754d1728e7497f2ae56c","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Low pressure lever machine at 6 bar.tcl","repository":"decentespresso/de1app","sha256":"1cfc90c8a7e1360d9d06d8e95f7dc26c88906c58da249beba595e1cc0b435f28","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Low%20pressure%20lever%20machine%20at%206%20bar.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":null,"title":"Low pressure lever machine at 6 bar","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/Pour over.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":4,"name":"Prewet","pump":"flow","role":"non_espresso","target":6,"temperatureC":99,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":40,"name":"Pause","pump":"flow","role":"non_espresso","target":0,"temperatureC":97,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":2,"maximumDurationSeconds":14,"name":"Main water #1","pump":"flow","role":"non_espresso","target":6,"temperatureC":97,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":20,"name":"Pause","pump":"flow","role":"non_espresso","target":0,"temperatureC":95,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":4,"maximumDurationSeconds":25,"name":"Main water #2","pump":"flow","role":"non_espresso","target":5,"temperatureC":95,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":20,"name":"Drain","pump":"flow","role":"non_espresso","target":0,"temperatureC":95,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":6,"maximumDurationSeconds":1,"name":"Reset temperature","pump":"flow","role":"non_espresso","target":0,"temperatureC":99,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"9b0a9cdc0a430dccb1460f5a9f23be50fe8c7749","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Pour over.tcl","repository":"decentespresso/de1app","sha256":"f0dd00652c0872a4071581850cfb373fdddf8b99ffb38c6c3bdf409bfbc26ff3","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Pour%20over.tcl"},"sourceBeverageType":"pourover","sourceSettingsType":"settings_2c","sourceVolumeCountStart":null,"title":"Pour over basket/Decent pour over","warnings":[]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"flow_fixed","grindTimeAssumption":"The controller sets water flow; resistance primarily changes pressure until a pressure limiter engages. Elapsed time alone cannot identify a grind change.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Preinfuse then 45ml of water.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":25,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":20,"name":"Flow hold","pump":"flow","role":"extraction","target":2,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"}],"source":{"blobSha":"484bc649fe963af63f03399c78498cf18d2eb6a7","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Preinfuse then 45ml of water.tcl","repository":"decentespresso/de1app","sha256":"63ce7889f0898598807cd2fd561aa23d312495c6b3c71795ae9bedc90b8e8aba","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Preinfuse%20then%2045ml%20of%20water.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2b","sourceVolumeCountStart":0,"title":"Preinfuse then 45ml of water","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","The title says 45 mL, but active basic final volume is 36 mL. Title is not an authoritative recipe."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"service","grindTimeAssumption":"This is not an espresso extraction and must not enter espresso recommendation history.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/Steam_only.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"index":0,"maximumDurationSeconds":12,"name":"Rise / hold","pump":"pressure","role":"extraction","target":7.8,"temperatureC":0,"temperatureSensor":"coffee","transition":"fast","unit":"bar"}],"source":{"blobSha":"935c4315a1fa7629118cc48414cb36e58457219a","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Steam_only.tcl","repository":"decentespresso/de1app","sha256":"539a88a8a8cef878ce247a3875c3cc022a7ac2ef3e1e731f579b5f4cb412f979","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Steam_only.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":1,"title":"Steam only","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","Source beverage_type says espresso, but source notes explicitly identify a steam-only setup; excluded from brewing advice.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/Tea_portafilter__Blue_Willow_Black_Honey_Oolong.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":4,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":20,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":80},{"index":3,"maximumDurationSeconds":25,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":80},{"index":5,"maximumDurationSeconds":30,"name":"infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":80},{"index":7,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":8,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"1190daadc4bb090e1e3f6f404358fb4c71341382","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Tea_portafilter__Blue_Willow_Black_Honey_Oolong.tcl","repository":"decentespresso/de1app","sha256":"27f40e26dd2ed80eb141a554b9f0855039783a83a12b9ae9b116493c9850d652","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Tea_portafilter__Blue_Willow_Black_Honey_Oolong.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/Bug Bite Oolong","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/Tea_portafilter__Blue_Willow_Tsuyuhikari_Sencha.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":4,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":20,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":80},{"index":3,"maximumDurationSeconds":25,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":80},{"index":5,"maximumDurationSeconds":30,"name":"infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":80}],"source":{"blobSha":"ece13a9044207fe3c0508f54e1489ca9a915d8b7","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Tea_portafilter__Blue_Willow_Tsuyuhikari_Sencha.tcl","repository":"decentespresso/de1app","sha256":"77793c4fea118465d8736e17ec63a41cbfeb1c0ac8d711663be51afa44ec0f6a","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Tea_portafilter__Blue_Willow_Tsuyuhikari_Sencha.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/Sencha","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/Tea_portafilter__Blue_Willow_Tsuyuhikari_Sensha.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":4,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":20,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":80},{"index":3,"maximumDurationSeconds":25,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":80},{"index":5,"maximumDurationSeconds":30,"name":"infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":60,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":80}],"source":{"blobSha":"c9107aceaba3566253427634013055abda4ed422","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Tea_portafilter__Blue_Willow_Tsuyuhikari_Sensha.tcl","repository":"decentespresso/de1app","sha256":"16a4dc1ca2492bb219d3d66613506acdf1666bec64ee7c395abbb523c3444a09","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Tea_portafilter__Blue_Willow_Tsuyuhikari_Sensha.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/Blue Willow: Tsuyuhikari Sensha","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/Tea_portafilter__Blue_Willow_black_phoenix_1.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":4,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":20,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":8,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":85},{"index":3,"maximumDurationSeconds":20,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":8,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":84},{"index":5,"maximumDurationSeconds":20,"name":"infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":8,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":85}],"source":{"blobSha":"6271be6d46f8e41e72ff0ae7d248055d386d20a1","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Tea_portafilter__Blue_Willow_black_phoenix_1.tcl","repository":"decentespresso/de1app","sha256":"98e0f629405def050e163f95f3baef7a041843f33288dc3d888841f2d158e0d8","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Tea_portafilter__Blue_Willow_black_phoenix_1.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/Oolong 1st extraction","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/Tea_portafilter__Blue_Willow_black_phoenix_2.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":4,"temperatureC":93.5,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":60,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":93.5,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":8,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":93.5,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":85}],"source":{"blobSha":"c2c9d249471d507b030da0fff8faf7504fcd1552","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Tea_portafilter__Blue_Willow_black_phoenix_2.tcl","repository":"decentespresso/de1app","sha256":"2db4e80527268f67e245c60da5b9e7a010353ad45bd6aab6bedc3cc2f095c07b","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Tea_portafilter__Blue_Willow_black_phoenix_2.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/Oolong 2nd extraction","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/Tea_portafilter__Blue_Willow_lunar_winter.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":4,"temperatureC":82,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":20,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":82,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":8,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":82,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":85},{"index":3,"maximumDurationSeconds":15,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":82,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":8,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":82,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":84},{"index":5,"maximumDurationSeconds":15,"name":"infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":82,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":8,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":82,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":85}],"source":{"blobSha":"7fe63c530a0c98b9906165bf0b9a57972f707573","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Tea_portafilter__Blue_Willow_lunar_winter.tcl","repository":"decentespresso/de1app","sha256":"fd996bd9891dc65ab20fc054eeb690daf683db2ed4c0942fecd1b48f51d30ced","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Tea_portafilter__Blue_Willow_lunar_winter.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/Yunnan green","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"service","grindTimeAssumption":"This is not an espresso extraction and must not enter espresso recommendation history.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/Test_profile_editor_demo.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":25,"name":"Filling","pump":"pressure","role":"service","target":6,"temperatureC":84,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":60},{"index":1,"maximumDurationSeconds":1,"name":"Infusing","pump":"pressure","role":"service","target":6,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":2,"maximumDurationSeconds":127,"name":"Pouring","oppositeLimit":{"range":0.2,"target":10,"unit":"bar"},"pump":"flow","role":"service","target":1.8,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"d08a323b8ed75d8bd77ac48496a9142cd2532d25","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Test_profile_editor_demo.tcl","repository":"decentespresso/de1app","sha256":"e03eba0862eac4c6564c54e4ba8fb6d381a31e7588c350e94716360096a2c008","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Test_profile_editor_demo.tcl"},"sourceBeverageType":"calibrate","sourceSettingsType":"settings_2c","sourceVolumeCountStart":null,"title":"Test/profile_editor_demo","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"lever_pressure","grindTimeAssumption":"Infusion, pressure rise and decline have distinct purposes. Evaluate extraction at matching pressure stages and keep infusion, ratio and temperature fixed.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/Traditional lever machine.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":8,"name":"Rise / hold","pump":"pressure","role":"extraction","target":9,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":2,"maximumDurationSeconds":27,"name":"Pressure ramp","pump":"pressure","role":"extraction","target":0,"temperatureC":92,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"}],"source":{"blobSha":"7379c3e541ada844f00f1797f275602d22576b7e","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Traditional lever machine.tcl","repository":"decentespresso/de1app","sha256":"195ff3272687e23a4fda8f2b97a83d81bbd074a953e6ddb9eefbf1759c0fb143","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Traditional%20lever%20machine.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":0,"title":"Traditional lever machine","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"pressure_constant","grindTimeAssumption":"At unchanged dose, yield, basket and temperature, measured extraction time can help compare resistance only while pressure is achieved and no flow limiter controls the shot.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/Trendy 6 bar low pressure shot.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":35,"name":"Rise / hold","pump":"pressure","role":"extraction","target":6,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"bar"}],"source":{"blobSha":"1042d2c12a003858a10e2a3585453173f2df2e9f","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Trendy 6 bar low pressure shot.tcl","repository":"decentespresso/de1app","sha256":"74a0b10dea45ee55521b3188c02ed6acc5b5d147f3cc65823330a14ea4fbfeb0","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Trendy%206%20bar%20low%20pressure%20shot.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":0,"title":"Trendy 6 bar low pressure shot","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"bloom_pressure","grindTimeAssumption":"A pressure-exit bloom intentionally changes length with resistance. Compare bloom and pressure extraction separately; total time is not a single grind-response signal.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/TurboBloom.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"preinfusion start","pump":"flow","role":"preinfusion","target":8,"temperatureC":86,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":4,"type":"pressure_over"},"index":1,"maximumDurationSeconds":20,"name":"preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":86,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":2.2,"type":"pressure_under"},"index":2,"maximumDurationSeconds":40,"name":"dynamic bloom","pump":"flow","role":"bloom","target":0,"temperatureC":70,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":3,"maximumDurationSeconds":4,"name":"ramp","pump":"pressure","role":"extraction","target":6,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":0,"type":"flow_under"},"index":4,"maximumDurationSeconds":2,"name":"6 bar","oppositeLimit":{"range":1,"target":4.5,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":6,"temperatureC":77,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":5,"maximumDurationSeconds":40,"name":"decline","oppositeLimit":{"range":1,"target":4.5,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":3,"temperatureC":77,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100}],"source":{"blobSha":"03e1f968736572539eb6ac32335d79123a1c849a","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/TurboBloom.tcl","repository":"decentespresso/de1app","sha256":"e4a1bf7dd3d554a11369ba6f8bd4551b71a07e805cd41ea1580084575cb3dcea","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/TurboBloom.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"TurboBloom","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"turbo_pressure","grindTimeAssumption":"Short/high-flow brewing is intended by this profile. Compare the same phase and recipe, not a universal 25-30 second target; a flow cap may override pressure.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/TurboTurbo.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"Fill start","pump":"pressure","role":"preinfusion","target":5.999999999999996,"temperatureC":86,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"exit":{"threshold":2,"type":"pressure_over"},"index":1,"maximumDurationSeconds":2,"name":"Fill","pump":"pressure","role":"preinfusion","target":5.999999999999996,"temperatureC":86,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"exit":{"threshold":4,"type":"pressure_over"},"index":2,"maximumDurationSeconds":20,"name":"PI","pump":"flow","role":"preinfusion","target":5,"temperatureC":82,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":3,"maximumDurationSeconds":5,"name":"rise and hold","oppositeLimit":{"range":1,"target":6,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":6,"temperatureC":77,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":4,"maximumDurationSeconds":15,"name":"decline","oppositeLimit":{"range":1,"target":4.5,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":4,"temperatureC":77,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"},{"index":5,"maximumDurationSeconds":60,"name":"hold","oppositeLimit":{"range":1,"target":4.5,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":4,"temperatureC":77,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"}],"source":{"blobSha":"915e57fda1e66a206ca7ed570c0a5bb9a5da4c73","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/TurboTurbo.tcl","repository":"decentespresso/de1app","sha256":"fe5cfe925666e4174fe444cd999276415600f0d4125a0e477fc01c0d2af36bd6","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/TurboTurbo.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"TurboTurbo","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"lever_pressure","grindTimeAssumption":"Infusion, pressure rise and decline have distinct purposes. Evaluate extraction at matching pressure stages and keep infusion, ratio and temperature fixed.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/Two spring lever machine to 9 bar.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":8,"name":"Rise / hold","pump":"pressure","role":"extraction","target":9,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":2,"maximumDurationSeconds":26,"name":"Pressure ramp","pump":"pressure","role":"extraction","target":0,"temperatureC":94,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"}],"source":{"blobSha":"61a4f4e1f73168b3bec6973de68ef06bee3bdca5","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Two spring lever machine to 9 bar.tcl","repository":"decentespresso/de1app","sha256":"1671b40d1a704758fab1d7032e44a2c5f614f9692adf1328bff0cca67c32e4a9","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Two%20spring%20lever%20machine%20to%209%20bar.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":0,"title":"Two spring lever machine to 9 bar","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"lever_with_flow_tail","grindTimeAssumption":"Pressure-led extraction can switch to a flow-limited rescue tail; whole-shot time combines different controllers. Inspect the actual reached frames and limiter engagement.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/Weiss_advanced_spring_lever.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":6,"type":"pressure_over"},"index":0,"maximumDurationSeconds":10,"name":"infuse","pump":"flow","role":"preinfusion","target":8,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":3,"name":"rise and hold","pump":"pressure","role":"extraction","target":9,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"exit":{"threshold":6,"type":"pressure_under"},"index":2,"maximumDurationSeconds":30,"name":"decline","oppositeLimit":{"range":0.6,"target":1.5,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":6,"temperatureC":90,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"},{"index":3,"maximumDurationSeconds":30,"name":"flow limit","oppositeLimit":{"range":0.6,"target":6,"unit":"bar"},"pump":"flow","role":"extraction","target":1.5,"temperatureC":90,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s"}],"source":{"blobSha":"f9f2403ef72fbacb6b45d00a3eca57b093eeaaa0","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/Weiss_advanced_spring_lever.tcl","repository":"decentespresso/de1app","sha256":"b15e8b0a8166afab4384d037c0163b63f30fb54084adc9e272adeebefff5859c","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/Weiss_advanced_spring_lever.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":0,"title":"Weiss advanced spring lever","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"adaptive_flow_scan","grindTimeAssumption":"The profile scans successive flow settings and exits according to measured flow. Grind can change the selected operating point; compare reached frames and achieved targets.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/adaptive_allonge.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":15,"name":"preinfusion","pump":"flow","role":"preinfusion","target":4,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":4,"name":"rise and hold","pump":"pressure","role":"extraction","target":8.6,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"exit":{"threshold":5.9,"type":"flow_under"},"index":2,"maximumDurationSeconds":127,"name":"Scan 6.0 mL.s","pump":"flow","role":"adaptive","target":6,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":5.4,"type":"flow_under"},"index":3,"maximumDurationSeconds":127,"name":"Scan 5.5 mL.s","pump":"flow","role":"adaptive","target":5.5,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":5.1,"type":"flow_under"},"index":4,"maximumDurationSeconds":127,"name":"Scan 5.2 mL.s","pump":"flow","role":"adaptive","target":5.2,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":4.9,"type":"flow_under"},"index":5,"maximumDurationSeconds":127,"name":"Scan 5.0 mL.s","pump":"flow","role":"adaptive","target":5,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":4.8,"type":"flow_under"},"index":6,"maximumDurationSeconds":127,"name":"Scan 4.9 mL.s","pump":"flow","role":"adaptive","target":4.9,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":4.7,"type":"flow_under"},"index":7,"maximumDurationSeconds":127,"name":"Scan 4.8 mL.s","pump":"flow","role":"adaptive","target":4.8,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":4.6,"type":"flow_under"},"index":8,"maximumDurationSeconds":127,"name":"Scan 4.7 mL.s","pump":"flow","role":"adaptive","target":4.7,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":4.5,"type":"flow_under"},"index":9,"maximumDurationSeconds":127,"name":"Scan 4.6 mL.s","pump":"flow","role":"adaptive","target":4.6,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":4.4,"type":"flow_under"},"index":10,"maximumDurationSeconds":127,"name":"Scan 4.5 mL.s","pump":"flow","role":"adaptive","target":4.5,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":4.3,"type":"flow_under"},"index":11,"maximumDurationSeconds":127,"name":"Scan 4.4 mL.s","pump":"flow","role":"adaptive","target":4.4,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":4.2,"type":"flow_under"},"index":12,"maximumDurationSeconds":127,"name":"Scan 4.3 mL.s","pump":"flow","role":"adaptive","target":4.3,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":4.1,"type":"flow_under"},"index":13,"maximumDurationSeconds":127,"name":"Scan 4.2 mL.s","pump":"flow","role":"adaptive","target":4.2,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":4,"type":"flow_under"},"index":14,"maximumDurationSeconds":127,"name":"Scan 4.1 mL.s","pump":"flow","role":"adaptive","target":4.1,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":3.9,"type":"flow_under"},"index":15,"maximumDurationSeconds":127,"name":"Scan 4.0 mL.s","pump":"flow","role":"adaptive","target":4,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":3.7,"type":"flow_under"},"index":16,"maximumDurationSeconds":127,"name":"Scan 3.8 mL.s","pump":"flow","role":"adaptive","target":3.8,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":3.3,"type":"flow_under"},"index":17,"maximumDurationSeconds":127,"name":"Scan 3.4 mL.s","pump":"flow","role":"adaptive","target":3.4,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":2.9,"type":"flow_under"},"index":18,"maximumDurationSeconds":127,"name":"Scan 3.0 mL.s","pump":"flow","role":"adaptive","target":3,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":19,"maximumDurationSeconds":127,"name":"last resort","pump":"flow","role":"adaptive","target":1,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"68785624f766728a434a45ccc3edcf270069eb63","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/adaptive_allonge.tcl","repository":"decentespresso/de1app","sha256":"93db215935e05142cd796d1ae80846c5ff510d3af8ad8ff060c73518afcad3b4","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/adaptive_allonge.tcl"},"sourceBeverageType":null,"sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Gagné/Adaptive Allongé 94C v1.0","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"adaptive_flow_scan","grindTimeAssumption":"The profile scans successive flow settings and exits according to measured flow. Grind can change the selected operating point; compare reached frames and achieved targets.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/adaptive_espresso.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":15,"name":"preinfusion","pump":"flow","role":"preinfusion","target":3.5,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":1,"maximumDurationSeconds":4,"name":"rise and hold","pump":"pressure","role":"extraction","target":8.6,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":3.4,"type":"flow_under"},"index":2,"maximumDurationSeconds":127,"name":"Scan 3.5 mL.s","pump":"flow","role":"adaptive","target":3.5,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3.2,"type":"flow_under"},"index":3,"maximumDurationSeconds":127,"name":"Scan 3.3 mL.s","pump":"flow","role":"adaptive","target":3.3,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3,"type":"flow_under"},"index":4,"maximumDurationSeconds":127,"name":"Scan 3.1 mL.s","pump":"flow","role":"adaptive","target":3.1,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":2.8,"type":"flow_under"},"index":5,"maximumDurationSeconds":127,"name":"Scan 2.9 mL.s","pump":"flow","role":"adaptive","target":2.9,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":2.6,"type":"flow_under"},"index":6,"maximumDurationSeconds":127,"name":"Scan 2.7 mL.s","pump":"flow","role":"adaptive","target":2.7,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":2.5,"type":"flow_under"},"index":7,"maximumDurationSeconds":127,"name":"Scan 2.6 mL.s","pump":"flow","role":"adaptive","target":2.6,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":2.4,"type":"flow_under"},"index":8,"maximumDurationSeconds":127,"name":"Scan 2.5 mL.s","pump":"flow","role":"adaptive","target":2.5,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":2.3,"type":"flow_under"},"index":9,"maximumDurationSeconds":127,"name":"Scan 2.4 mL.s","pump":"flow","role":"adaptive","target":2.4,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":2.2,"type":"flow_under"},"index":10,"maximumDurationSeconds":127,"name":"Scan 2.3 mL.s","pump":"flow","role":"adaptive","target":2.3,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":2.1,"type":"flow_under"},"index":11,"maximumDurationSeconds":127,"name":"Scan 2.2 mL.s","pump":"flow","role":"adaptive","target":2.2,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":2,"type":"flow_under"},"index":12,"maximumDurationSeconds":127,"name":"Scan 2.1 mL.s","pump":"flow","role":"adaptive","target":2.1,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1.9,"type":"flow_under"},"index":13,"maximumDurationSeconds":127,"name":"Scan 2.0 mL.s","pump":"flow","role":"adaptive","target":2,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1.7,"type":"flow_under"},"index":14,"maximumDurationSeconds":127,"name":"Scan 1.8 mL.s","pump":"flow","role":"adaptive","target":1.8,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1.5,"type":"flow_under"},"index":15,"maximumDurationSeconds":127,"name":"Scan 1.6 mL.s","pump":"flow","role":"adaptive","target":1.6,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1.3,"type":"flow_under"},"index":16,"maximumDurationSeconds":127,"name":"Scan 1.4 mL.s","pump":"flow","role":"adaptive","target":1.4,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1.1,"type":"flow_under"},"index":17,"maximumDurationSeconds":127,"name":"Scan 1.2 mL.s","pump":"flow","role":"adaptive","target":1.2,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":0.9,"type":"flow_under"},"index":18,"maximumDurationSeconds":127,"name":"Scan 1.0 mL.s","pump":"flow","role":"adaptive","target":1,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":19,"maximumDurationSeconds":127,"name":"last resort","pump":"flow","role":"adaptive","target":0.5,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"77a6a5c2492836eec06000bbf24f60cbad24588d","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/adaptive_espresso.tcl","repository":"decentespresso/de1app","sha256":"a1781f7bfa699286c0c67b1cc1399453dffa09a66f17f506a08d74988b296d21","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/adaptive_espresso.tcl"},"sourceBeverageType":null,"sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Gagné/Adaptive Shot 92C v1.0","warnings":["Source notes describe a bloom/pressure scheme inconsistent with the actual flow-scan steps. Classification follows controller fields.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"adaptive_mixed","grindTimeAssumption":"Measured exits, pressurization and flow ramps couple timing to controller response. Compare phase-specific targets and traces, not a global time error.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/best_practice.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":5,"name":"Prefill","pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3,"type":"pressure_over"},"index":1,"maximumDurationSeconds":12,"name":"Fill","pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3,"type":"flow_under"},"index":2,"maximumDurationSeconds":12,"name":"Compressing","pump":"pressure","role":"preinfusion","target":3,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":3,"maximumDurationSeconds":6,"name":"Dripping","pump":"pressure","role":"preinfusion","target":0.1,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"exit":{"threshold":7.7,"type":"pressure_over"},"index":4,"maximumDurationSeconds":6,"name":"Pressurize","oppositeLimit":{"range":0.6,"target":3.5,"unit":"mL/s"},"pump":"pressure","role":"extraction","target":11,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":0,"type":"pressure_over"},"index":5,"maximumDurationSeconds":0,"name":"Extraction start","oppositeLimit":{"range":0.6,"target":8.6,"unit":"bar"},"pump":"flow","role":"extraction","target":1.5,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":6,"maximumDurationSeconds":60,"name":"Extraction","oppositeLimit":{"range":0.6,"target":8.6,"unit":"bar"},"pump":"flow","role":"extraction","target":3.5,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"8e57d89cadce7de12f41d7159a3fdea3a73de528","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/best_practice.tcl","repository":"decentespresso/de1app","sha256":"2193c62eee1f0dd2e512119b244ef58ded385e19b924248d0fb0d4ec60567b3d","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/best_practice.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":3,"title":"Adaptive v3","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"adaptive_mixed","grindTimeAssumption":"Measured exits, pressurization and flow ramps couple timing to controller response. Compare phase-specific targets and traces, not a global time error.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/best_practice_light.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":12,"name":"Preinfusion fill","pump":"pressure","role":"preinfusion","target":3,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1,"type":"flow_under"},"index":1,"maximumDurationSeconds":12,"name":"Preinfusion fill end","pump":"pressure","role":"preinfusion","target":3,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":2,"maximumDurationSeconds":13,"name":"Preinfusion dripping","pump":"pressure","role":"preinfusion","target":1.5,"temperatureC":90,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":12},{"exit":{"threshold":8,"type":"pressure_over"},"index":3,"maximumDurationSeconds":6,"name":"Pressurize","pump":"pressure","role":"extraction","target":10.5,"temperatureC":90,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":4,"maximumDurationSeconds":30,"name":"Extraction","oppositeLimit":{"range":0.6,"target":9.5,"unit":"bar"},"pump":"flow","role":"extraction","target":3.4,"temperatureC":90,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"d0b9ca2d7f58439c8b9728b7910008aa60d7d9f4","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/best_practice_light.tcl","repository":"decentespresso/de1app","sha256":"2555d4842607a47f989ad0c72d8484bc2b24db695c4dc4e2f70b8d3a27358fc0","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/best_practice_light.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Best practice (light roast)","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"service","grindTimeAssumption":"This is not an espresso extraction and must not enter espresso recommendation history.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/cleaning_forward_flush.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":7,"type":"pressure_over"},"index":0,"maximumDurationSeconds":15,"name":"Pressure rise 1","pump":"flow","role":"service","target":4,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":15,"name":"Pause 1","pump":"pressure","role":"service","target":0,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"exit":{"threshold":7,"type":"pressure_over"},"index":2,"maximumDurationSeconds":15,"name":"Pressure rise 2","pump":"flow","role":"service","target":6.5,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":15,"name":"Pause 2","pump":"pressure","role":"service","target":0,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"exit":{"threshold":7,"type":"pressure_over"},"index":4,"maximumDurationSeconds":15,"name":"Pressure rise 3","pump":"flow","role":"service","target":6.5,"temperatureC":85,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"a8e1fbd470688338c832d27c4dcebbe21cb27b02","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/cleaning_forward_flush.tcl","repository":"decentespresso/de1app","sha256":"1fff758f82f7140c877cf2041771802ef64650fc8b521b6caa839f33df463aea","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/cleaning_forward_flush.tcl"},"sourceBeverageType":"cleaning","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Cleaning/Forward flush","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/cold_brew.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":14,"name":"preinfusion","pump":"flow","role":"non_espresso","target":6,"temperatureC":20,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":30,"name":"bloom*","pump":"pressure","role":"non_espresso","target":0,"temperatureC":20,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":60,"name":"pulse","pump":"flow","role":"non_espresso","target":2.5,"temperatureC":20,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":30,"name":"pause","pump":"pressure","role":"non_espresso","target":0,"temperatureC":20,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":60,"name":"pulse","pump":"flow","role":"non_espresso","target":2,"temperatureC":20,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":30,"name":"pause","pump":"pressure","role":"non_espresso","target":0,"temperatureC":20,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":52,"name":"pulse","pump":"flow","role":"non_espresso","target":2,"temperatureC":20,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":7,"maximumDurationSeconds":2,"name":"pulse*","pump":"flow","role":"non_espresso","target":0.1,"temperatureC":20,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"37ee66f1de913ecac69e52bb4d2a3415867d1597","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/cold_brew.tcl","repository":"decentespresso/de1app","sha256":"2f0068d6d2c8a03dc42c9acef970457379b14c7c23eb622b2dea18f92a68878d","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/cold_brew.tcl"},"sourceBeverageType":"pourover","sourceSettingsType":"settings_2c","sourceVolumeCountStart":0,"title":"Pour over basket/Cold brew 22g in, 375ml out","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"pressure_declining","grindTimeAssumption":"Compare the same pressure trajectory and yield; rising flow as programmed pressure declines is not automatically channeling, and whole-shot duration is not a universal target.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/default.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":4,"name":"Rise / hold","pump":"pressure","role":"extraction","target":8.6,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":2,"maximumDurationSeconds":35,"name":"Pressure ramp","pump":"pressure","role":"extraction","target":6,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"}],"source":{"blobSha":"003885a43796eec53769119cec35c05f05b1e354","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/default.tcl","repository":"decentespresso/de1app","sha256":"aa5d82073b28ecdde529dcfa4e369e9d649186206669a8e7b19453f02106ddad","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/default.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":0,"title":"Default","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"pressure_constant","grindTimeAssumption":"At unchanged dose, yield, basket and temperature, measured extraction time can help compare resistance only while pressure is achieved and no flow limiter controls the shot.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/e61 classic at 9 bar.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"index":0,"maximumDurationSeconds":35,"name":"Rise / hold","pump":"pressure","role":"extraction","target":9,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"bar"}],"source":{"blobSha":"22e71dfa3c329aae693f37c9cf130f1c714fe65d","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/e61 classic at 9 bar.tcl","repository":"decentespresso/de1app","sha256":"78467052705cdbcf5bba59d9cd740aa02df5f627d810e634d5caab2244276b8a","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/e61%20classic%20at%209%20bar.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":0,"title":"E61 espresso machine","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"pressure_rising","grindTimeAssumption":"Compare against the programmed pressure ramp; an increase in pressure is intentional. Use phase-aligned measurements with the same recipe.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/e61 classic gently up to 10 bar.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":10,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":5,"name":"Rise / hold","pump":"pressure","role":"extraction","target":9,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":2,"maximumDurationSeconds":20,"name":"Pressure ramp","pump":"pressure","role":"extraction","target":10,"temperatureC":92,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"}],"source":{"blobSha":"55fa8d80319d359f65b7e6a9f2e5006458585cff","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/e61 classic gently up to 10 bar.tcl","repository":"decentespresso/de1app","sha256":"07d318b00c2a381e19e1378bc46d2d91d2e040a97fe46dd723bbd0b1eb79be9f","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/e61%20classic%20gently%20up%20to%2010%20bar.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":0,"title":"E61 classic gently up to 10 bar","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"pressure_constant","grindTimeAssumption":"At unchanged dose, yield, basket and temperature, measured extraction time can help compare resistance only while pressure is achieved and no flow limiter controls the shot.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/e61 rocketing up to 10 bar.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":10,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":30,"name":"Rise / hold","pump":"pressure","role":"extraction","target":10,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"bar"}],"source":{"blobSha":"7494c4e3b54f10e015ccbb192796711eff4ff79f","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/e61 rocketing up to 10 bar.tcl","repository":"decentespresso/de1app","sha256":"94de9b07c80089dbca21c6863c884873f686a6690177197add2bb8a038f21ffb","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/e61%20rocketing%20up%20to%2010%20bar.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":0,"title":"E61 rocketing up to 10 bar","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"pressure_constant","grindTimeAssumption":"At unchanged dose, yield, basket and temperature, measured extraction time can help compare resistance only while pressure is achieved and no flow limiter controls the shot.","grindTimePolicy":"conditional","id":"stock:de1plus/profiles/e61 with fast preinfusion to 9 bar.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"exit":{"threshold":4,"type":"pressure_over"},"index":0,"maximumDurationSeconds":6,"name":"Preinfusion","pump":"flow","role":"preinfusion","target":8,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":30,"name":"Rise / hold","pump":"pressure","role":"extraction","target":9,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"bar"}],"source":{"blobSha":"59042479c1a17e3f78b7f0a154f403a663273c9f","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/e61 with fast preinfusion to 9 bar.tcl","repository":"decentespresso/de1app","sha256":"28494392e56927caf01be11b4a02d9c0539491a244acdc6745ebda8129126663","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/e61%20with%20fast%20preinfusion%20to%209%20bar.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2a","sourceVolumeCountStart":0,"title":"E61 with fast preinfusion to 9 bar","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"bloom_pressure","grindTimeAssumption":"A pressure-exit bloom intentionally changes length with resistance. Compare bloom and pressure extraction separately; total time is not a single grind-response signal.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/easy_blooming_active_pressure_decline.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"preinfusion start","pump":"flow","role":"preinfusion","target":6.000000000000007,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":4,"type":"pressure_over"},"index":1,"maximumDurationSeconds":20,"name":"preinfusion","pump":"flow","role":"preinfusion","target":6.000000000000007,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":2,"type":"pressure_under"},"index":2,"maximumDurationSeconds":60,"name":"dynamic bloom","pump":"flow","role":"bloom","target":0,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":3,"maximumDurationSeconds":4,"name":"fast pressure","pump":"pressure","role":"extraction","target":6.9999999999999964,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.6,"type":"flow_over"},"index":4,"maximumDurationSeconds":4,"name":"pressure hold 1","pump":"pressure","role":"extraction","target":6.9999999999999964,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.4,"type":"flow_under"},"index":5,"maximumDurationSeconds":5,"name":"P fast decline 1","pump":"pressure","role":"extraction","target":5.699999999999997,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.4,"type":"flow_under"},"index":6,"maximumDurationSeconds":40,"name":"P fast decline 2","pump":"pressure","role":"extraction","target":5.899999999999997,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.9,"type":"flow_over"},"index":7,"maximumDurationSeconds":8,"name":"pressure hold 2","pump":"pressure","role":"extraction","target":6.9999999999999964,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.7,"type":"flow_under"},"index":8,"maximumDurationSeconds":8,"name":"P decline 1","pump":"pressure","role":"extraction","target":5.799999999999996,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.7,"type":"flow_under"},"index":9,"maximumDurationSeconds":40,"name":"P decline 2","pump":"pressure","role":"extraction","target":5.899999999999997,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.2,"type":"flow_over"},"index":10,"maximumDurationSeconds":30,"name":"pressure hold 3","pump":"pressure","role":"extraction","target":6.9999999999999964,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":11,"maximumDurationSeconds":40,"name":"P slow decline","pump":"pressure","role":"extraction","target":5.899999999999997,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100}],"source":{"blobSha":"f176d478a370a4cd63ccb361c65b44727c139f09","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/easy_blooming_active_pressure_decline.tcl","repository":"decentespresso/de1app","sha256":"7f5018c87e7b5d5d6a779ed8e62db37d71448905c9a83a530b236add74fc3daf","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/easy_blooming_active_pressure_decline.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Easy blooming - active pressure decline","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/filter3.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":15,"name":"Prewet","oppositeLimit":{"range":1,"target":5,"unit":"bar"},"pump":"flow","role":"non_espresso","target":5,"temperatureC":94,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":75},{"index":1,"maximumDurationSeconds":30,"name":"Bloom","pump":"flow","role":"non_espresso","target":0,"temperatureC":94,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":75},{"index":2,"maximumDurationSeconds":30,"name":"Wet 1a","pump":"flow","role":"non_espresso","target":1.1,"temperatureC":92,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":200},{"index":3,"maximumDurationSeconds":30,"name":"Wet 1b","pump":"flow","role":"non_espresso","target":1.1,"temperatureC":92,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":200},{"index":4,"maximumDurationSeconds":60,"name":"Wet 2","pump":"flow","role":"non_espresso","target":1.1,"temperatureC":90,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":200},{"index":5,"maximumDurationSeconds":100,"name":"Wet 3","pump":"flow","role":"non_espresso","target":1.1,"temperatureC":88,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":200},{"index":6,"maximumDurationSeconds":10,"name":"Drawdown","pump":"flow","role":"non_espresso","target":0,"temperatureC":88,"temperatureSensor":"water","transition":"fast","unit":"mL/s","volumeExitMl":200}],"source":{"blobSha":"3dbb4a3c5f505fc0fe0fccd315ca7c3b525b9923","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/filter3.tcl","repository":"decentespresso/de1app","sha256":"c79d673318f648a0b261a8f4a16268bd413b0a2e1e090f440634e084a92cc53d","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/filter3.tcl"},"sourceBeverageType":"filter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Filter3","warnings":[]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"service","grindTimeAssumption":"This is not an espresso extraction and must not enter espresso recommendation history.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/flow_calibration.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":20,"name":"1 bar","pump":"pressure","role":"service","target":1,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":1,"maximumDurationSeconds":15,"name":"2 bar","pump":"pressure","role":"service","target":2,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":2,"maximumDurationSeconds":15,"name":"3 bar","pump":"pressure","role":"service","target":3,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":3,"maximumDurationSeconds":15,"name":"4 bar","pump":"pressure","role":"service","target":4,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":4,"maximumDurationSeconds":15,"name":"5 bar","pump":"pressure","role":"service","target":5,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":5,"maximumDurationSeconds":15,"name":"6 bar","pump":"pressure","role":"service","target":6,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":6,"maximumDurationSeconds":15,"name":"7 bar","pump":"pressure","role":"service","target":7,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":7,"maximumDurationSeconds":15,"name":"8 bar","pump":"pressure","role":"service","target":8,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":8,"maximumDurationSeconds":15,"name":"9 bar","pump":"pressure","role":"service","target":9,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"bar"}],"source":{"blobSha":"4f8a2aab57b7e00cf4eab758e247d909902bc91c","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/flow_calibration.tcl","repository":"decentespresso/de1app","sha256":"06e37d5d53c1c8cc67138c1d6935760390d186f049907d16a6e1d04b5180ae14","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/flow_calibration.tcl"},"sourceBeverageType":"calibrate","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Test/Flow calibration","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/kalita_20.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":11,"name":"preinfusion","pump":"flow","role":"non_espresso","target":6,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":30,"name":"bloom*","pump":"pressure","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":20,"name":"pulse","pump":"flow","role":"non_espresso","target":6,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":30,"name":"pause","pump":"pressure","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":20,"name":"pulse","pump":"flow","role":"non_espresso","target":6,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":35,"name":"pause","pump":"pressure","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":19,"name":"pulse","pump":"flow","role":"non_espresso","target":6,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":7,"maximumDurationSeconds":1,"name":"[ spin at end]*","pump":"flow","role":"non_espresso","target":0.1,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"36559cb446a9cd73581a40628bd83625386142dd","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/kalita_20.tcl","repository":"decentespresso/de1app","sha256":"a24edd683daa1ea88b352708e3b875bb5a3bd2113b2f8e21a6e611afc9621920","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/kalita_20.tcl"},"sourceBeverageType":"pourover","sourceSettingsType":"settings_2c","sourceVolumeCountStart":0,"title":"Pour over basket/Kalita 20g in, 340ml out","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"manual","grindTimeAssumption":"The operator changes targets during brewing. A saved starting profile does not describe the actual control trajectory.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/manual_flow.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"index":0,"maximumDurationSeconds":60,"name":"Flow hold","oppositeLimit":{"target":9,"unit":"bar"},"pump":"flow","role":"extraction","target":0,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":60,"name":"Flow ramp","oppositeLimit":{"target":9,"unit":"bar"},"pump":"flow","role":"extraction","target":0,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s"}],"source":{"blobSha":"1aacd54281b6a5401204127521673cbd5d1dc911","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/manual_flow.tcl","repository":"decentespresso/de1app","sha256":"0214ca68661a7dac2b51906a8526b2279f05e520c650c73fcd39c610bee3461c","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/manual_flow.tcl"},"sourceBeverageType":"manual","sourceSettingsType":"settings_2b","sourceVolumeCountStart":0,"title":"GHC/manual flow control","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","Starting settings can be overridden by the group-head controller; actual control is operator-driven."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"manual","grindTimeAssumption":"The operator changes targets during brewing. A saved starting profile does not describe the actual control trajectory.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/manual_pressure.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"index":0,"maximumDurationSeconds":60,"name":"Rise / hold","pump":"pressure","role":"extraction","target":0,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar"},{"index":1,"maximumDurationSeconds":60,"name":"Pressure ramp","pump":"pressure","role":"extraction","target":0,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar"}],"source":{"blobSha":"e73e62340db5bc6db3dfaa3148f9b0a6f907ee7c","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/manual_pressure.tcl","repository":"decentespresso/de1app","sha256":"b040fed0d170adf4c00219a783d02cbe93f2e33eaed0bd6ac0e8c87eda62b2ce","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/manual_pressure.tcl"},"sourceBeverageType":"manual","sourceSettingsType":"settings_2a","sourceVolumeCountStart":null,"title":"GHC/manual pressure control","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis.","Starting settings can be overridden by the group-head controller; actual control is operator-driven.","No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"allonge_flow","grindTimeAssumption":"Long ratio and high programmed flow are recipe intent. Compare pressure response, actual beverage flow, ratio and taste; do not chase a conventional espresso duration.","grindTimePolicy":"abstain","id":"stock:de1plus/profiles/rao_allonge.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":2,"name":"hold at 4.5 ml/s","oppositeLimit":{"range":0.6,"target":8.6,"unit":"bar"},"pump":"flow","role":"extraction","target":4.5,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":60,"name":"hold at 4.5 ml/s","oppositeLimit":{"range":0.6,"target":8.6,"unit":"bar"},"pump":"flow","role":"extraction","target":4.5,"temperatureC":92,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"6ffcc59c9ec6ca1eb818298ec9d8de075acd894e","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/rao_allonge.tcl","repository":"decentespresso/de1app","sha256":"bc2af4ad5462fcade79307af7c0f65b9d0350e1f6e9d5d1691cd90c6fdd432c6","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/rao_allonge.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":0,"title":"Rao Allongé","warnings":[]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/tea_in_a_basket.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":4,"name":"preinfusion boost","pump":"flow","role":"non_espresso","target":4,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":1,"maximumDurationSeconds":5,"name":"flow","pump":"flow","role":"non_espresso","target":0.5,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":2,"maximumDurationSeconds":10,"name":"hold","pump":"flow","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":3,"maximumDurationSeconds":12,"name":"flow","pump":"flow","role":"non_espresso","target":3,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":4,"maximumDurationSeconds":12,"name":"hold","pump":"flow","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":5,"maximumDurationSeconds":12,"name":"flow","pump":"flow","role":"non_espresso","target":3,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":6,"maximumDurationSeconds":12,"name":"hold","pump":"flow","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":7,"maximumDurationSeconds":12,"name":"flow","pump":"flow","role":"non_espresso","target":3,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":8,"maximumDurationSeconds":12,"name":"hold","pump":"flow","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":9,"maximumDurationSeconds":12,"name":"flow","pump":"flow","role":"non_espresso","target":3,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":10,"maximumDurationSeconds":12,"name":"hold","pump":"flow","role":"non_espresso","target":0.1,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":11,"maximumDurationSeconds":12,"name":"flow","pump":"flow","role":"non_espresso","target":3,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":12,"maximumDurationSeconds":10,"name":"hold","pump":"flow","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":13,"maximumDurationSeconds":10,"name":"flow","pump":"flow","role":"non_espresso","target":3,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":14,"maximumDurationSeconds":10,"name":"flow","pump":"flow","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"},{"index":15,"maximumDurationSeconds":10,"name":"flow","pump":"flow","role":"non_espresso","target":3,"temperatureC":100,"temperatureSensor":"water","transition":"fast","unit":"mL/s"}],"source":{"blobSha":"cf303a64cd2e2b24cec274c10d5adcfc194fa65b","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/tea_in_a_basket.tcl","repository":"decentespresso/de1app","sha256":"11007c0474c37558eaefc4817ff2e1159a2effac43a561a67a1582eb6c9d11d6","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/tea_in_a_basket.tcl"},"sourceBeverageType":"tea","sourceSettingsType":"settings_2c","sourceVolumeCountStart":0,"title":"Tea/in a basket","warnings":[]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/tea_portafilter.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":2,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":11,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":30,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":11,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":7,"maximumDurationSeconds":13,"name":"Flush cooler","pump":"flow","role":"non_espresso","target":11,"temperatureC":40,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"3fe5b286bd27b33c2110316468046505c9509150","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/tea_portafilter.tcl","repository":"decentespresso/de1app","sha256":"88cb151720877027139aa55d70a5f83d54edca2d4322298b022dfd33b1962ce8","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/tea_portafilter.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/black tea","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/tea_portafilter_chinese_green.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":2,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":11,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":30,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":11,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":7,"maximumDurationSeconds":13,"name":"Flush cooler","pump":"flow","role":"non_espresso","target":11,"temperatureC":40,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"efb621ec08688b66b2d0a4a18cab2aeb0fa7c105","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/tea_portafilter_chinese_green.tcl","repository":"decentespresso/de1app","sha256":"1fc05546cc1489595564aff1dd3cac9412485a0294378b374e5f764efd62dc71","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/tea_portafilter_chinese_green.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/Chinese green","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/tea_portafilter_japanese_green.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":2,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":11,"temperatureC":74,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":30,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":74,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":74,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":74,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":74,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":74,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":11,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":74,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":7,"maximumDurationSeconds":13,"name":"Flush cooler","pump":"flow","role":"non_espresso","target":11,"temperatureC":40,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"d34debed5448d4f5da92d07ac7fe4a6c62958896","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/tea_portafilter_japanese_green.tcl","repository":"decentespresso/de1app","sha256":"29e95206dd9fe2b7baf3d850ff4a781974ded8927258b6a32712ad676476b608","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/tea_portafilter_japanese_green.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/Japanese green","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/tea_portafilter_no_pressure.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":1,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":8,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":5,"name":"Release pressure","pump":"pressure","role":"non_espresso","target":0,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":25,"name":"Infuse","pump":"flow","role":"non_espresso","target":0,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":15,"name":"Flush","pump":"flow","role":"non_espresso","target":7,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":4,"maximumDurationSeconds":5,"name":"Release pressure","pump":"pressure","role":"non_espresso","target":0,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":5,"maximumDurationSeconds":25,"name":"Infuse","pump":"flow","role":"non_espresso","target":0,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":6,"maximumDurationSeconds":15,"name":"Flush","pump":"flow","role":"non_espresso","target":7,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":7,"maximumDurationSeconds":5,"name":"Release pressure","pump":"pressure","role":"non_espresso","target":0,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":8,"maximumDurationSeconds":25,"name":"Infuse","pump":"flow","role":"non_espresso","target":0,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":9,"maximumDurationSeconds":11,"name":"Flush","pump":"flow","role":"non_espresso","target":7,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":10,"maximumDurationSeconds":15,"name":"Flush cooler","pump":"flow","role":"non_espresso","target":6,"temperatureC":40,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"0e7afabb03bddff1146775c577624d793ac3bfee","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/tea_portafilter_no_pressure.tcl","repository":"decentespresso/de1app","sha256":"438d95fe0d0609a38f38f4018415a26f5b083be5a48e0d7a2cc75fb3baf605e4","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/tea_portafilter_no_pressure.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/no pressure","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/tea_portafilter_oolong.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":2,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":11,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":30,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":11,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":89,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":7,"maximumDurationSeconds":13,"name":"Flush cooler","pump":"flow","role":"non_espresso","target":11,"temperatureC":40,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"848f83c82a650f393719cb2146de74e036beaffe","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/tea_portafilter_oolong.tcl","repository":"decentespresso/de1app","sha256":"928354f5d00f2abee3db14424cec74bfbb227ab4177106499e2cd8f3522ac313","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/tea_portafilter_oolong.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/oolong","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/tea_portafilter_oolong_dark.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":4,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":20,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":80},{"index":3,"maximumDurationSeconds":25,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":80},{"index":5,"maximumDurationSeconds":30,"name":"infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":80},{"index":7,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":8,"maximumDurationSeconds":30,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"16d9dc5347fc5f9c02809c5eabd9be2f626d86ee","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/tea_portafilter_oolong_dark.tcl","repository":"decentespresso/de1app","sha256":"0211fbb92b7332f4c62981f43bf960e324287c6b60df589b007434d10f9be197","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/tea_portafilter_oolong_dark.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/oolong dark","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/tea_portafilter_pressurized.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":2,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":10,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":30,"name":"Infuse","pump":"pressure","role":"non_espresso","target":2,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":10,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":2,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":10,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":2,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":22,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"8f7e16088d4d65359ee6116aaad84a52d6cff368","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/tea_portafilter_pressurized.tcl","repository":"decentespresso/de1app","sha256":"82542dc217d07196f6e5422ba17311e5cbb347d82751f368eab1e075d0e63390","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/tea_portafilter_pressurized.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/Pressurized tea","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/tea_portafilter_tisane.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":2,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":11,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":30,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":11,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":7,"maximumDurationSeconds":13,"name":"Flush cooler","pump":"flow","role":"non_espresso","target":11,"temperatureC":40,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"f00ef7846fbd5321f8ccfd1526c0436b413fff81","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/tea_portafilter_tisane.tcl","repository":"decentespresso/de1app","sha256":"ee3a68d6e2221765947375f146cf6cf92c9c4297d7892801e5ca05f996d689b2","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/tea_portafilter_tisane.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/tisane","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/tea_portafilter_white.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":2,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"Fill","pump":"flow","role":"non_espresso","target":11,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":30,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":12,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":40,"name":"Infuse","pump":"pressure","role":"non_espresso","target":0.1,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":11,"name":"Flush","pump":"flow","role":"non_espresso","target":11,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":7,"maximumDurationSeconds":13,"name":"Flush cooler","pump":"flow","role":"non_espresso","target":11,"temperatureC":40,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"47569d738df19a6bdd83c03312bd8d6cb6eff5da","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/tea_portafilter_white.tcl","repository":"decentespresso/de1app","sha256":"01e23c1ca768b64f091800cb38ba393db45adc457edeb1902c08ff0aae08c7be","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/tea_portafilter_white.tcl"},"sourceBeverageType":"tea_portafilter","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Tea portafilter/white tea","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"service","grindTimeAssumption":"This is not an espresso extraction and must not enter espresso recommendation history.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/test_for_a_small_low_pressure_leak.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":0.5,"type":"pressure_over"},"index":0,"maximumDurationSeconds":60,"name":"preinfusion to 0.5 bar","pump":"flow","role":"service","target":1,"temperatureC":0,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":127,"name":"rise to 0.5 bar and hold","pump":"pressure","role":"service","target":0.5,"temperatureC":0,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":127,"name":"rise to 0.5 bar and hold","pump":"pressure","role":"service","target":0.5,"temperatureC":0,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":3,"maximumDurationSeconds":127,"name":"rise to 0.5 bar and hold","pump":"pressure","role":"service","target":0.5,"temperatureC":0,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":127,"name":"rise to 0.5 bar and hold","pump":"pressure","role":"service","target":0.5,"temperatureC":0,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":5,"maximumDurationSeconds":127,"name":"rise to 0.5 bar and hold","pump":"pressure","role":"service","target":0.5,"temperatureC":0,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":127,"name":"rise to 0.5 bar and hold","pump":"pressure","role":"service","target":0.5,"temperatureC":0,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":7,"maximumDurationSeconds":127,"name":"rise to 0.5 bar and hold","pump":"pressure","role":"service","target":0.5,"temperatureC":0,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500}],"source":{"blobSha":"e559c14e2070e40764f6c7c9c3985f2857203371","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/test_for_a_small_low_pressure_leak.tcl","repository":"decentespresso/de1app","sha256":"e76578296cbee682e10c7f1a3f7cd7fc98e48623cd850a16ab1ea60ec069d054","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/test_for_a_small_low_pressure_leak.tcl"},"sourceBeverageType":"calibrate","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Test/low pressure leak","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"service","grindTimeAssumption":"This is not an espresso extraction and must not enter espresso recommendation history.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/test_leak.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":10,"name":"preinfusion","pump":"pressure","role":"service","target":10,"temperatureC":0,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":500},{"index":1,"maximumDurationSeconds":5,"name":"rise and hold","pump":"pressure","role":"service","target":10,"temperatureC":0,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":120,"name":"hold at no flow","pump":"flow","role":"service","target":0,"temperatureC":0,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"c99f599e0ee5070485d065a817b731926bb6d534","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/test_leak.tcl","repository":"decentespresso/de1app","sha256":"f91c60de47c0e8d97cd0ad64f37333a2796080ec0de226fca04669c5656a3d93","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/test_leak.tcl"},"sourceBeverageType":"calibrate","sourceSettingsType":"settings_2c","sourceVolumeCountStart":1,"title":"Test/for a small leak","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"service","grindTimeAssumption":"This is not an espresso extraction and must not enter espresso recommendation history.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/test_pressure_calibration.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":7,"type":"pressure_over"},"index":0,"maximumDurationSeconds":20,"name":"fast rise","pump":"pressure","role":"service","target":7,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":1,"maximumDurationSeconds":3,"name":"final slow rise","pump":"pressure","role":"service","target":9,"temperatureC":1,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":60,"name":"hold","pump":"pressure","role":"service","target":9,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500}],"source":{"blobSha":"4989251c439ae9f7800686043956d2cf0e807f45","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/test_pressure_calibration.tcl","repository":"decentespresso/de1app","sha256":"c090a05fd3d34763e73d06d50ee9dd4da34a38172798af639a47974dd7faa455","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/test_pressure_calibration.tcl"},"sourceBeverageType":"calibrate","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Test/pressure calibration","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"service","grindTimeAssumption":"This is not an espresso extraction and must not enter espresso recommendation history.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/test_pressure_release.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":10,"name":"Pressure up","pump":"pressure","role":"service","target":12,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":1,"maximumDurationSeconds":1,"name":"Pressure release","pump":"pressure","role":"service","target":0,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":5,"name":"Pressure up","pump":"pressure","role":"service","target":12,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":3,"maximumDurationSeconds":1,"name":"Pressure release","pump":"pressure","role":"service","target":0,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":5,"name":"Pressure up","pump":"pressure","role":"service","target":12,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":5,"maximumDurationSeconds":1,"name":"Pressure release","pump":"pressure","role":"service","target":0,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":5,"name":"Pressure up","pump":"pressure","role":"service","target":12,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":7,"maximumDurationSeconds":1,"name":"Pressure release","pump":"pressure","role":"service","target":0,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":8,"maximumDurationSeconds":5,"name":"Pressure up","pump":"pressure","role":"service","target":12,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":9,"maximumDurationSeconds":1,"name":"Pressure release","pump":"pressure","role":"service","target":0,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":10,"maximumDurationSeconds":5,"name":"Pressure up","pump":"pressure","role":"service","target":12,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":11,"maximumDurationSeconds":1,"name":"Pressure release","pump":"pressure","role":"service","target":0,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":12,"maximumDurationSeconds":5,"name":"Pressure up","pump":"pressure","role":"service","target":12,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":13,"maximumDurationSeconds":1,"name":"Pressure release","pump":"pressure","role":"service","target":0,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":14,"maximumDurationSeconds":5,"name":"Pressure up","pump":"pressure","role":"service","target":12,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":15,"maximumDurationSeconds":1,"name":"Pressure release","pump":"pressure","role":"service","target":0,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":16,"maximumDurationSeconds":5,"name":"Pressure up","pump":"pressure","role":"service","target":12,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":17,"maximumDurationSeconds":1,"name":"Pressure release","pump":"pressure","role":"service","target":0,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":18,"maximumDurationSeconds":5,"name":"Pressure up","pump":"pressure","role":"service","target":12,"temperatureC":1,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500}],"source":{"blobSha":"c7019b97ed9e61c04af9eb8b4e76979cb7f9fceb","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/test_pressure_release.tcl","repository":"decentespresso/de1app","sha256":"5b3ada2f0b91cd70be72322ee8c9ce91e09347d4bcd64c06d5558bd6f2399600","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/test_pressure_release.tcl"},"sourceBeverageType":"calibrate","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Test/leakage stress test","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"service","grindTimeAssumption":"This is not an espresso extraction and must not enter espresso recommendation history.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/test_temperature.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":20,"name":"90c","pump":"flow","role":"service","target":4,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":30,"name":"80c","pump":"flow","role":"service","target":4,"temperatureC":80,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":2,"maximumDurationSeconds":30,"name":"70c","pump":"flow","role":"service","target":4,"temperatureC":70,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"1ba2e39de230e9e30fc5e64245a1b65aee9266f2","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/test_temperature.tcl","repository":"decentespresso/de1app","sha256":"6568f9c2a163ae606f91d77a3ef5ddc0cfcee52984950a0f30817e5f3b713bfa","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/test_temperature.tcl"},"sourceBeverageType":"calibrate","sourceSettingsType":"settings_2c","sourceVolumeCountStart":0,"title":"Test/temperature accuracy","warnings":[]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"service","grindTimeAssumption":"This is not an espresso extraction and must not enter espresso recommendation history.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/test_temperature_calibration.tcl","phaseRepresentation":"basic_gui_stages","phases":[{"index":0,"maximumDurationSeconds":60,"name":"Flow hold","pump":"flow","role":"extraction","target":3,"temperatureC":90,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"}],"source":{"blobSha":"e868b313e47cb5dbd005f0fa9f19dfe9639eb814","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/test_temperature_calibration.tcl","repository":"decentespresso/de1app","sha256":"927e6b46c55e6090df360bc1d7957c720e73b9e2c270bab9600cab6fafd41e3e","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/test_temperature_calibration.tcl"},"sourceBeverageType":"calibrate","sourceSettingsType":"settings_2b","sourceVolumeCountStart":0,"title":"Test/temperature calibration","warnings":["Stored advanced_shot ignored: active basic settings are authoritative. Stages summarize GUI controls; upstream adds temperature-boost and pressure-rise frames. Use the brewed saved profile for exact frame analysis."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/v60-15g.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":8,"name":"preinfusion","pump":"flow","role":"non_espresso","target":8,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":30,"name":"bloom","pump":"pressure","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":12,"name":"pulse","pump":"flow","role":"non_espresso","target":8,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":30,"name":"pause","pump":"pressure","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":12,"name":"pulse","pump":"flow","role":"non_espresso","target":8,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":30,"name":"pause","pump":"pressure","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":11,"name":"pulse","pump":"flow","role":"non_espresso","target":8,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"c5b3371d8fe9735af81e9e8bdf52d1e5cea0d03d","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/v60-15g.tcl","repository":"decentespresso/de1app","sha256":"933747e75aabca96797e90f7ccb1fe7aa188d2de09069593653eadbbc8cf65fa","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/v60-15g.tcl"},"sourceBeverageType":"pourover","sourceSettingsType":"settings_2c","sourceVolumeCountStart":0,"title":"Pour over basket/V60 15g in, 250g out","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/v60-20g.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":10,"name":"preinfusion","pump":"flow","role":"non_espresso","target":8,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":30,"name":"bloom*","pump":"pressure","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":15,"name":"pulse","pump":"flow","role":"non_espresso","target":8,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":30,"name":"pause","pump":"pressure","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":15,"name":"pulse","pump":"flow","role":"non_espresso","target":8,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":35,"name":"pause","pump":"pressure","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":14,"name":"pulse","pump":"flow","role":"non_espresso","target":8,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":7,"maximumDurationSeconds":1,"name":"[ spin at end]*","pump":"flow","role":"non_espresso","target":0.1,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"972b68a66658e5292e90bdd1abd0c3434086d8d4","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/v60-20g.tcl","repository":"decentespresso/de1app","sha256":"ebb6d0d5895210efbb49020c36123d46681a311c0b9dd45bde2e4a77c7f7feb4","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/v60-20g.tcl"},"sourceBeverageType":"pourover","sourceSettingsType":"settings_2c","sourceVolumeCountStart":0,"title":"Pour over basket/V60 20g in, 340g out","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"non_espresso","grindTimeAssumption":"Espresso grind/time advice does not apply; use beverage-specific recipes and basket or brewer context.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/v60-22g.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":11,"name":"preinfusion","pump":"flow","role":"non_espresso","target":8,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":1,"maximumDurationSeconds":30,"name":"bloom*","pump":"pressure","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":2,"maximumDurationSeconds":17,"name":"pulse","pump":"flow","role":"non_espresso","target":8,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":30,"name":"pause","pump":"pressure","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":4,"maximumDurationSeconds":16,"name":"pulse","pump":"flow","role":"non_espresso","target":8,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":5,"maximumDurationSeconds":35,"name":"pause","pump":"pressure","role":"non_espresso","target":0,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":6,"maximumDurationSeconds":16,"name":"pulse","pump":"flow","role":"non_espresso","target":8,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":7,"maximumDurationSeconds":1,"name":"[ spin at end]*","pump":"flow","role":"non_espresso","target":0.1,"temperatureC":100,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500}],"source":{"blobSha":"789209516accf0e96765df581196b0c2a35a92d4","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/v60-22g.tcl","repository":"decentespresso/de1app","sha256":"bdefb31cf2e9d2cae9553f7b7123e1d8bf8bf7abe9811aff539ad1cfff17ff9d","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/v60-22g.tcl"},"sourceBeverageType":"pourover","sourceSettingsType":"settings_2c","sourceVolumeCountStart":0,"title":"Pour over basket/V60 22g in, 375g out","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"service","grindTimeAssumption":"This is not an espresso extraction and must not enter espresso recommendation history.","grindTimePolicy":"excluded","id":"stock:de1plus/profiles/weber_spring_clean.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":20,"name":"Initial prefill","pump":"flow","role":"service","target":11,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":1,"type":"pressure_over"},"index":1,"maximumDurationSeconds":60,"name":"Initial fill","pump":"flow","role":"service","target":11,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":9,"type":"pressure_over"},"index":2,"maximumDurationSeconds":127,"name":"Fill and stir","pump":"flow","role":"service","target":0.3,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":3,"maximumDurationSeconds":10,"name":"Hold","pump":"flow","role":"service","target":0,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":7,"type":"pressure_under"},"index":4,"maximumDurationSeconds":1,"name":"Short flush","pump":"pressure","role":"service","target":0,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"exit":{"threshold":9,"type":"pressure_over"},"index":5,"maximumDurationSeconds":20,"name":"Hold","pump":"flow","role":"service","target":0.1,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":7,"type":"pressure_under"},"index":6,"maximumDurationSeconds":1,"name":"Short flush","pump":"pressure","role":"service","target":0,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"index":7,"maximumDurationSeconds":10,"name":"Hold","pump":"flow","role":"service","target":0.1,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":8,"maximumDurationSeconds":10,"name":"Long flush","pump":"pressure","role":"service","target":0,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"exit":{"threshold":9,"type":"pressure_over"},"index":9,"maximumDurationSeconds":30,"name":"Fill to rinse","pump":"flow","role":"service","target":6,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":10,"maximumDurationSeconds":10,"name":"Flush to rinse","pump":"pressure","role":"service","target":0,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"exit":{"threshold":8,"type":"pressure_under"},"index":11,"maximumDurationSeconds":30,"name":"Fill to rinse","pump":"flow","role":"service","target":4,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"exit":{"threshold":0.1,"type":"pressure_under"},"index":12,"maximumDurationSeconds":20,"name":"Full flush","pump":"pressure","role":"service","target":0,"temperatureC":105,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500},{"exit":{"threshold":9,"type":"pressure_over"},"index":13,"maximumDurationSeconds":20,"name":"Fill to rinse","pump":"flow","role":"service","target":6,"temperatureC":20,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":500},{"index":14,"maximumDurationSeconds":30,"name":"Final flush","pump":"pressure","role":"service","target":0,"temperatureC":20,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":500}],"source":{"blobSha":"0ff7dbd0e0576924d9f95848a405327b2a51c9ae","commit":"5b09f6aa7c73e6734e3710953dce4074c5b93db7","path":"de1plus/profiles/weber_spring_clean.tcl","repository":"decentespresso/de1app","sha256":"177866162468905ad16323c190bdaa44fb069994f99d704a1959ee6b9120a5db","url":"https://github.com/decentespresso/de1app/blob/5b09f6aa7c73e6734e3710953dce4074c5b93db7/de1plus/profiles/weber_spring_clean.tcl"},"sourceBeverageType":"cleaning","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"Cleaning/Weber Spring Clean","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]}],"purpose":"Factual research inventory for interpreting profile-aware analysis. This is not an executable profile library, a runtime title classifier, or calibrated grind coefficients.","reviewedAt":"2026-10-11","schemaVersion":1,"supplementalProfiles":[{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"pinned-a-flow-1cf6e22e:profiles/A-Flow____default-dark.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":1,"name":"Pre Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3,"type":"pressure_over"},"index":1,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":2,"maximumDurationSeconds":10,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":2},{"exit":{"threshold":2.5,"type":"pressure_over"},"index":3,"maximumDurationSeconds":0,"name":"2nd Fill","oppositeLimit":{"range":0.6,"target":3,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1,"type":"flow_under"},"index":4,"maximumDurationSeconds":0,"name":"Pause","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2,"type":"flow_over"},"index":5,"maximumDurationSeconds":5,"name":"Pressure Up","pump":"pressure","role":"extraction","target":9,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.1,"type":"flow_under"},"index":6,"maximumDurationSeconds":0,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":7,"maximumDurationSeconds":0,"name":"Flow Start","pump":"flow","role":"extraction","target":2,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":8,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":9,"unit":"bar"},"pump":"flow","role":"extraction","target":0,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"292727066aca15027a613523d421f465aa763fa2","commit":"1cf6e22e2ab369b2e26968e537f1ab40c56637fb","path":"profiles/A-Flow____default-dark.tcl","repository":"decentespresso/A_Flow","sha256":"514772c5551c5df6dd6bbbd9493e4137ccdb267950ec789be247ce0cf02a149f","url":"https://github.com/decentespresso/A_Flow/blob/1cf6e22e2ab369b2e26968e537f1ab40c56637fb/profiles/A-Flow____default-dark.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-dark","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"pinned-a-flow-1cf6e22e:profiles/A-Flow____default-light.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":1,"name":"Pre Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3,"type":"pressure_over"},"index":1,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":2,"maximumDurationSeconds":60,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":6},{"exit":{"threshold":2.5,"type":"pressure_over"},"index":3,"maximumDurationSeconds":0,"name":"2nd Fill","oppositeLimit":{"range":0.6,"target":3,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1,"type":"flow_under"},"index":4,"maximumDurationSeconds":0,"name":"Pause","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":3,"type":"flow_over"},"index":5,"maximumDurationSeconds":10,"name":"Pressure Up","pump":"pressure","role":"extraction","target":9.5,"temperatureC":95,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":3.1,"type":"flow_under"},"index":6,"maximumDurationSeconds":0,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":7,"maximumDurationSeconds":0,"name":"Flow Start","pump":"flow","role":"extraction","target":3,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":8,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":9.5,"unit":"bar"},"pump":"flow","role":"extraction","target":6,"temperatureC":95,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"e8f82fc0ca29002cd2665b6026009e45275ab9d9","commit":"1cf6e22e2ab369b2e26968e537f1ab40c56637fb","path":"profiles/A-Flow____default-light.tcl","repository":"decentespresso/A_Flow","sha256":"7ca6311755bf98520b799b24b999b484a559271e9fe782d3cacb1fbc432c42b4","url":"https://github.com/decentespresso/A_Flow/blob/1cf6e22e2ab369b2e26968e537f1ab40c56637fb/profiles/A-Flow____default-light.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-light","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"pinned-a-flow-1cf6e22e:profiles/A-Flow____default-like-dflow.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":1,"name":"Pre Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3,"type":"pressure_over"},"index":1,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":2,"maximumDurationSeconds":60,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":4},{"exit":{"threshold":2.5,"type":"pressure_over"},"index":3,"maximumDurationSeconds":0,"name":"2nd Fill","oppositeLimit":{"range":0.6,"target":3,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1,"type":"flow_under"},"index":4,"maximumDurationSeconds":0,"name":"Pause","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2,"type":"flow_over"},"index":5,"maximumDurationSeconds":0,"name":"Pressure Up","pump":"pressure","role":"extraction","target":10,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.1,"type":"flow_under"},"index":6,"maximumDurationSeconds":0,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.9,"type":"flow_over"},"index":7,"maximumDurationSeconds":10,"name":"Flow Start","pump":"flow","role":"extraction","target":2,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":8,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":10,"unit":"bar"},"pump":"flow","role":"extraction","target":4,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"cf44d28d1b2377bc7e825a974f9e78b3f0551355","commit":"1cf6e22e2ab369b2e26968e537f1ab40c56637fb","path":"profiles/A-Flow____default-like-dflow.tcl","repository":"decentespresso/A_Flow","sha256":"5cb3e5f9bb615fa44d95a71398ddd21a7ae85793ef3ea174aa3e7fcb3c0d38c6","url":"https://github.com/decentespresso/A_Flow/blob/1cf6e22e2ab369b2e26968e537f1ab40c56637fb/profiles/A-Flow____default-like-dflow.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-like-dflow","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"pinned-a-flow-1cf6e22e:profiles/A-Flow____default-medium.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":1,"name":"Pre Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3,"type":"pressure_over"},"index":1,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":2,"maximumDurationSeconds":60,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":3.6},{"exit":{"threshold":2.5,"type":"pressure_over"},"index":3,"maximumDurationSeconds":0,"name":"2nd Fill","oppositeLimit":{"range":0.6,"target":3,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1,"type":"flow_under"},"index":4,"maximumDurationSeconds":0,"name":"Pause","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2,"type":"flow_over"},"index":5,"maximumDurationSeconds":10,"name":"Pressure Up","pump":"pressure","role":"extraction","target":10,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.1,"type":"flow_under"},"index":6,"maximumDurationSeconds":0,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":7,"maximumDurationSeconds":0,"name":"Flow Start","pump":"flow","role":"extraction","target":2,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":8,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":10,"unit":"bar"},"pump":"flow","role":"extraction","target":4,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"b2f116e3bc6dd412751755f7bdc47be383d9cf45","commit":"1cf6e22e2ab369b2e26968e537f1ab40c56637fb","path":"profiles/A-Flow____default-medium.tcl","repository":"decentespresso/A_Flow","sha256":"d79b3bf7b57690ec2e1739a498b581721969413e051430f15a2d37e85834a3e3","url":"https://github.com/decentespresso/A_Flow/blob/1cf6e22e2ab369b2e26968e537f1ab40c56637fb/profiles/A-Flow____default-medium.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-medium","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"pinned-a-flow-1cf6e22e:profiles/A-Flow____default-very-dark.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":1,"name":"Pre Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3,"type":"pressure_over"},"index":1,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":2,"maximumDurationSeconds":6,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":2},{"exit":{"threshold":2.5,"type":"pressure_over"},"index":3,"maximumDurationSeconds":0,"name":"2nd Fill","oppositeLimit":{"range":0.6,"target":3,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1,"type":"flow_under"},"index":4,"maximumDurationSeconds":0,"name":"Pause","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":3.6,"type":"flow_over"},"index":5,"maximumDurationSeconds":3,"name":"Pressure Up","pump":"pressure","role":"extraction","target":10,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.9,"type":"flow_under"},"index":6,"maximumDurationSeconds":3,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":7,"maximumDurationSeconds":0,"name":"Flow Start","pump":"flow","role":"extraction","target":1.8,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":8,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":10,"unit":"bar"},"pump":"flow","role":"extraction","target":3.6,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"fd395eefa237b73fea72e419ddf268096d8f3e7b","commit":"1cf6e22e2ab369b2e26968e537f1ab40c56637fb","path":"profiles/A-Flow____default-very-dark.tcl","repository":"decentespresso/A_Flow","sha256":"5d67c0d9affdb041139eeb31ed0c90492b6044997debb0dad9323d9845e3ebb5","url":"https://github.com/decentespresso/A_Flow/blob/1cf6e22e2ab369b2e26968e537f1ab40c56637fb/profiles/A-Flow____default-very-dark.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-very-dark","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"pinned-a-flow-c9a98489:profiles/A-Flow____default-dark.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":1,"name":"Pre Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3,"type":"pressure_over"},"index":1,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":2,"maximumDurationSeconds":10,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":2},{"exit":{"threshold":2.5,"type":"pressure_over"},"index":3,"maximumDurationSeconds":0,"name":"2nd Fill","oppositeLimit":{"range":0.6,"target":3,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1,"type":"flow_under"},"index":4,"maximumDurationSeconds":0,"name":"Pause","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2,"type":"flow_over"},"index":5,"maximumDurationSeconds":5,"name":"Pressure Up","pump":"pressure","role":"extraction","target":9,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.1,"type":"flow_under"},"index":6,"maximumDurationSeconds":0,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":7,"maximumDurationSeconds":0,"name":"Flow Start","pump":"flow","role":"extraction","target":2,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":8,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":9,"unit":"bar"},"pump":"flow","role":"extraction","target":0,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"a1629f243bf2acacd3d89621330a952b3532c3c5","commit":"c9a984899352b441fc0797474d9af5e950081c23","path":"profiles/A-Flow____default-dark.tcl","repository":"decentespresso/A_Flow","sha256":"95cbd2b315dfc774a1e2f5065aa550d510827df1b5a6dc09bbcbb5d450709bc5","url":"https://github.com/decentespresso/A_Flow/blob/c9a984899352b441fc0797474d9af5e950081c23/profiles/A-Flow____default-dark.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-dark","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"pinned-a-flow-c9a98489:profiles/A-Flow____default-light.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":1,"name":"Pre Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3,"type":"pressure_over"},"index":1,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":2,"maximumDurationSeconds":60,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":6},{"exit":{"threshold":2.5,"type":"pressure_over"},"index":3,"maximumDurationSeconds":0,"name":"2nd Fill","oppositeLimit":{"range":0.6,"target":3,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1,"type":"flow_under"},"index":4,"maximumDurationSeconds":0,"name":"Pause","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":3,"type":"flow_over"},"index":5,"maximumDurationSeconds":10,"name":"Pressure Up","pump":"pressure","role":"extraction","target":9.5,"temperatureC":95,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":3.1,"type":"flow_under"},"index":6,"maximumDurationSeconds":0,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":7,"maximumDurationSeconds":0,"name":"Flow Start","pump":"flow","role":"extraction","target":3,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":8,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":9.5,"unit":"bar"},"pump":"flow","role":"extraction","target":6,"temperatureC":95,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"1083453b2b519d976c47a457bcb4762030ad230b","commit":"c9a984899352b441fc0797474d9af5e950081c23","path":"profiles/A-Flow____default-light.tcl","repository":"decentespresso/A_Flow","sha256":"b98130c3e9ddf3b1f4927369c2e8a65893e2ea5d971bca6be5324b9d75bea26c","url":"https://github.com/decentespresso/A_Flow/blob/c9a984899352b441fc0797474d9af5e950081c23/profiles/A-Flow____default-light.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-light","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"pinned-a-flow-c9a98489:profiles/A-Flow____default-like-dflow.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":1,"name":"Pre Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3,"type":"pressure_over"},"index":1,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":2,"maximumDurationSeconds":60,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":4},{"exit":{"threshold":2.5,"type":"pressure_over"},"index":3,"maximumDurationSeconds":0,"name":"2nd Fill","oppositeLimit":{"range":0.6,"target":3,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1,"type":"flow_under"},"index":4,"maximumDurationSeconds":0,"name":"Pause","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2,"type":"flow_over"},"index":5,"maximumDurationSeconds":0,"name":"Pressure Up","pump":"pressure","role":"extraction","target":10,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.1,"type":"flow_under"},"index":6,"maximumDurationSeconds":0,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.9,"type":"flow_over"},"index":7,"maximumDurationSeconds":10,"name":"Flow Start","pump":"flow","role":"extraction","target":2,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":8,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":10,"unit":"bar"},"pump":"flow","role":"extraction","target":4,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"2ef1a34e69da99b8cf1b02f6f60e3adb6306f343","commit":"c9a984899352b441fc0797474d9af5e950081c23","path":"profiles/A-Flow____default-like-dflow.tcl","repository":"decentespresso/A_Flow","sha256":"e852a71788a9648dc60b8615347d69d3a6c1dbfae969b8fe4017d7cda4c4c957","url":"https://github.com/decentespresso/A_Flow/blob/c9a984899352b441fc0797474d9af5e950081c23/profiles/A-Flow____default-like-dflow.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-like-dflow","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"pinned-a-flow-c9a98489:profiles/A-Flow____default-medium.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":1,"name":"Pre Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3,"type":"pressure_over"},"index":1,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":2,"maximumDurationSeconds":60,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":3.6},{"exit":{"threshold":2.5,"type":"pressure_over"},"index":3,"maximumDurationSeconds":0,"name":"2nd Fill","oppositeLimit":{"range":0.6,"target":3,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1,"type":"flow_under"},"index":4,"maximumDurationSeconds":0,"name":"Pause","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2,"type":"flow_over"},"index":5,"maximumDurationSeconds":10,"name":"Pressure Up","pump":"pressure","role":"extraction","target":10,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":2.1,"type":"flow_under"},"index":6,"maximumDurationSeconds":0,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":7,"maximumDurationSeconds":0,"name":"Flow Start","pump":"flow","role":"extraction","target":2,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":8,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":10,"unit":"bar"},"pump":"flow","role":"extraction","target":4,"temperatureC":93,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"d83dbd614c4a9f5bc085881e95cac61f7d99f3aa","commit":"c9a984899352b441fc0797474d9af5e950081c23","path":"profiles/A-Flow____default-medium.tcl","repository":"decentespresso/A_Flow","sha256":"5a9cb2f3c5b6852fbd1b74c02d2e8c11a0b211d2748432e1a418668078b88a5e","url":"https://github.com/decentespresso/A_Flow/blob/c9a984899352b441fc0797474d9af5e950081c23/profiles/A-Flow____default-medium.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-medium","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"a_flow","grindTimeAssumption":"Fill and weight-ended infusion precede optional pressure rise/decline and a flow ramp. Inspect enabled steps and pressure cap; designer dial-in advice is not a validated universal model.","grindTimePolicy":"abstain","id":"pinned-a-flow-c9a98489:profiles/A-Flow____default-very-dark.tcl","phaseRepresentation":"source_advanced_frames","phases":[{"index":0,"maximumDurationSeconds":1,"name":"Pre Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":3,"type":"pressure_over"},"index":1,"maximumDurationSeconds":15,"name":"Fill","oppositeLimit":{"range":0.6,"target":8,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":2,"maximumDurationSeconds":6,"name":"Infuse","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":3,"temperatureC":93,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":2},{"exit":{"threshold":2.5,"type":"pressure_over"},"index":3,"maximumDurationSeconds":0,"name":"2nd Fill","oppositeLimit":{"range":0.6,"target":3,"unit":"bar"},"pump":"flow","role":"preinfusion","target":8,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"exit":{"threshold":1,"type":"flow_under"},"index":4,"maximumDurationSeconds":0,"name":"Pause","oppositeLimit":{"range":0.6,"target":1,"unit":"mL/s"},"pump":"pressure","role":"preinfusion","target":1,"temperatureC":95,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"exit":{"threshold":3.6,"type":"flow_over"},"index":5,"maximumDurationSeconds":3,"name":"Pressure Up","pump":"pressure","role":"extraction","target":10,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"exit":{"threshold":1.9,"type":"flow_under"},"index":6,"maximumDurationSeconds":3,"name":"Pressure Decline","pump":"pressure","role":"extraction","target":1,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"bar","volumeExitMl":100},{"index":7,"maximumDurationSeconds":0,"name":"Flow Start","pump":"flow","role":"extraction","target":1.8,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100},{"index":8,"maximumDurationSeconds":60,"name":"Flow Extraction","oppositeLimit":{"range":0.6,"target":10,"unit":"bar"},"pump":"flow","role":"extraction","target":3.6,"temperatureC":88,"temperatureSensor":"coffee","transition":"smooth","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"b6b7aaba73356e8a0f190fe6bc97405683833fcf","commit":"c9a984899352b441fc0797474d9af5e950081c23","path":"profiles/A-Flow____default-very-dark.tcl","repository":"decentespresso/A_Flow","sha256":"652dfacae39d4b52b9beb427bd3ac48a66554180cc003494a5fafb561f487909","url":"https://github.com/decentespresso/A_Flow/blob/c9a984899352b441fc0797474d9af5e950081c23/profiles/A-Flow____default-very-dark.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"A-Flow / default-very-dark","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"d_flow","grindTimeAssumption":"Pressure fill/infusion precedes flow pouring with a pressure ceiling. Infusion exit and pouring flow are separate knobs; total time alone does not justify grind adjustment.","grindTimePolicy":"abstain","id":"pinned-d-flow-ae8b202a:code.tcl#set_Dflow_default","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":1.5,"type":"pressure_over"},"index":0,"maximumDurationSeconds":25,"name":"Filling","pump":"pressure","role":"preinfusion","target":3,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":5},{"index":1,"maximumDurationSeconds":60,"name":"Infusing","pump":"pressure","role":"preinfusion","target":3,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":4},{"index":2,"maximumDurationSeconds":127,"name":"Pouring","oppositeLimit":{"range":0.2,"target":8.5,"unit":"bar"},"pump":"flow","role":"extraction","target":1.7,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"}],"source":{"blobSha":"1022ab7b9b60f63ba703175138b2a6579a953d9d","commit":"ae8b202a36a8d1bd1c63c5f8b3ea6e6fa3c08e53","generator":"set_Dflow_default","path":"code.tcl","repository":"decentespresso/D_Flow","sha256":"e98c2d59f545cac658d30a7ff816f7a834205ca33686a430e99cf46fc4861984","url":"https://github.com/decentespresso/D_Flow/blob/ae8b202a36a8d1bd1c63c5f8b3ea6e6fa3c08e53/code.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"D-Flow / default","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"d_flow","grindTimeAssumption":"Pressure fill/infusion precedes flow pouring with a pressure ceiling. Infusion exit and pouring flow are separate knobs; total time alone does not justify grind adjustment.","grindTimePolicy":"abstain","id":"pinned-d-flow-ae8b202a:code.tcl#write_La_Pavoni_profile","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":1.2,"type":"pressure_over"},"index":0,"maximumDurationSeconds":25,"name":"Filling","pump":"pressure","role":"preinfusion","target":1.2,"temperatureC":84,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":60},{"index":1,"maximumDurationSeconds":60,"name":"Infusing","pump":"pressure","role":"preinfusion","target":1.2,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":0.2},{"index":2,"maximumDurationSeconds":127,"name":"Pouring","oppositeLimit":{"range":0.2,"target":9,"unit":"bar"},"pump":"flow","role":"extraction","target":2.4,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"1022ab7b9b60f63ba703175138b2a6579a953d9d","commit":"ae8b202a36a8d1bd1c63c5f8b3ea6e6fa3c08e53","generator":"write_La_Pavoni_profile","path":"code.tcl","repository":"decentespresso/D_Flow","sha256":"e98c2d59f545cac658d30a7ff816f7a834205ca33686a430e99cf46fc4861984","url":"https://github.com/decentespresso/D_Flow/blob/ae8b202a36a8d1bd1c63c5f8b3ea6e6fa3c08e53/code.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"D-Flow / La Pavoni","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"d_flow","grindTimeAssumption":"Pressure fill/infusion precedes flow pouring with a pressure ceiling. Infusion exit and pouring flow are separate knobs; total time alone does not justify grind adjustment.","grindTimePolicy":"abstain","id":"pinned-d-flow-ae8b202a:code.tcl#write_Q_profile","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":25,"name":"Filling","pump":"pressure","role":"preinfusion","target":6,"temperatureC":84,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":60},{"index":1,"maximumDurationSeconds":1,"name":"Infusing","pump":"pressure","role":"preinfusion","target":6,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":2,"maximumDurationSeconds":127,"name":"Pouring","oppositeLimit":{"range":0.2,"target":10,"unit":"bar"},"pump":"flow","role":"extraction","target":1.8,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"1022ab7b9b60f63ba703175138b2a6579a953d9d","commit":"ae8b202a36a8d1bd1c63c5f8b3ea6e6fa3c08e53","generator":"write_Q_profile","path":"code.tcl","repository":"decentespresso/D_Flow","sha256":"e98c2d59f545cac658d30a7ff816f7a834205ca33686a430e99cf46fc4861984","url":"https://github.com/decentespresso/D_Flow/blob/ae8b202a36a8d1bd1c63c5f8b3ea6e6fa3c08e53/code.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"D-Flow / Q","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"d_flow","grindTimeAssumption":"Pressure fill/infusion precedes flow pouring with a pressure ceiling. Infusion exit and pouring flow are separate knobs; total time alone does not justify grind adjustment.","grindTimePolicy":"abstain","id":"pinned-d-flow-e9781ca4:plugin.tcl#set_Dflow_default","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":1.5,"type":"pressure_over"},"index":0,"maximumDurationSeconds":25,"name":"Filling","pump":"pressure","role":"preinfusion","target":3,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":5},{"index":1,"maximumDurationSeconds":60,"name":"Infusing","pump":"pressure","role":"preinfusion","target":3,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":4},{"index":2,"maximumDurationSeconds":127,"name":"Pouring","oppositeLimit":{"range":0.2,"target":8.5,"unit":"bar"},"pump":"flow","role":"extraction","target":1.7,"temperatureC":88,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s"}],"source":{"blobSha":"6abfb261225f28168ec830cc759b5f6483ed0d56","commit":"e9781ca49df7c46835d76bcc951d598e56e00c99","generator":"set_Dflow_default","path":"plugin.tcl","repository":"decentespresso/D_Flow_Espresso_Profile","sha256":"3b06d57ad1eea5d3a0c5b5f42686daad662d391f0220ff7d91554653cdcc69b4","url":"https://github.com/decentespresso/D_Flow_Espresso_Profile/blob/e9781ca49df7c46835d76bcc951d598e56e00c99/plugin.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"D-Flow / default","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"d_flow","grindTimeAssumption":"Pressure fill/infusion precedes flow pouring with a pressure ceiling. Infusion exit and pouring flow are separate knobs; total time alone does not justify grind adjustment.","grindTimePolicy":"abstain","id":"pinned-d-flow-e9781ca4:plugin.tcl#write_La_Pavoni_profile","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":1.2,"type":"pressure_over"},"index":0,"maximumDurationSeconds":25,"name":"Filling","pump":"pressure","role":"preinfusion","target":1.2,"temperatureC":84,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":60},{"index":1,"maximumDurationSeconds":60,"name":"Infusing","pump":"pressure","role":"preinfusion","target":1.2,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100,"weightExitG":0.2},{"index":2,"maximumDurationSeconds":127,"name":"Pouring","oppositeLimit":{"range":0.2,"target":9,"unit":"bar"},"pump":"flow","role":"extraction","target":2.4,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"6abfb261225f28168ec830cc759b5f6483ed0d56","commit":"e9781ca49df7c46835d76bcc951d598e56e00c99","generator":"write_La_Pavoni_profile","path":"plugin.tcl","repository":"decentespresso/D_Flow_Espresso_Profile","sha256":"3b06d57ad1eea5d3a0c5b5f42686daad662d391f0220ff7d91554653cdcc69b4","url":"https://github.com/decentespresso/D_Flow_Espresso_Profile/blob/e9781ca49df7c46835d76bcc951d598e56e00c99/plugin.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"D-Flow / La Pavoni","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]},{"classificationBasis":"Reviewed active controller fields and source intent; not a title-only runtime classifier.","family":"d_flow","grindTimeAssumption":"Pressure fill/infusion precedes flow pouring with a pressure ceiling. Infusion exit and pouring flow are separate knobs; total time alone does not justify grind adjustment.","grindTimePolicy":"abstain","id":"pinned-d-flow-e9781ca4:plugin.tcl#write_Q_profile","phaseRepresentation":"source_advanced_frames","phases":[{"exit":{"threshold":3,"type":"pressure_over"},"index":0,"maximumDurationSeconds":25,"name":"Filling","pump":"pressure","role":"preinfusion","target":6,"temperatureC":84,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":60},{"index":1,"maximumDurationSeconds":1,"name":"Infusing","pump":"pressure","role":"preinfusion","target":6,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"bar","volumeExitMl":100},{"index":2,"maximumDurationSeconds":127,"name":"Pouring","oppositeLimit":{"range":0.2,"target":10,"unit":"bar"},"pump":"flow","role":"extraction","target":1.8,"temperatureC":94,"temperatureSensor":"coffee","transition":"fast","unit":"mL/s","volumeExitMl":100}],"source":{"blobSha":"6abfb261225f28168ec830cc759b5f6483ed0d56","commit":"e9781ca49df7c46835d76bcc951d598e56e00c99","generator":"write_Q_profile","path":"plugin.tcl","repository":"decentespresso/D_Flow_Espresso_Profile","sha256":"3b06d57ad1eea5d3a0c5b5f42686daad662d391f0220ff7d91554653cdcc69b4","url":"https://github.com/decentespresso/D_Flow_Espresso_Profile/blob/e9781ca49df7c46835d76bcc951d598e56e00c99/plugin.tcl"},"sourceBeverageType":"espresso","sourceSettingsType":"settings_2c","sourceVolumeCountStart":2,"title":"D-Flow / Q","warnings":["No explicit source flow limit on at least one pressure stage. de1app may add a configurable default flow limit at load time; source files are not proof of effective machine targets."]}]},"grinderDials":{"models":[{"control":"screen","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","espressoAdjustment":{"basis":"reviewer_observed_increment","espressoSupported":true,"note":"Based on an adjustment observed in a firsthand review, not a guaranteed change in shot time. Conservative first trial, not a guarantee of 1 second per µm. Confirm firmware permits this increment. Calibration of zero and empirical brew response are separate.","numericFinerDelta":-1,"sources":[{"title":"Mahlkönig: E64 WS original instructions","url":"https://downloads.mahlkoenig.de/Service/Mahlkoenig_E64_WS_Espresso_Home_Original_instructions_EN.pdf"},{"title":"Kaffeemacher: E64 WS test","url":"https://www.kaffeemachers.shop/blogs/kaffeewissen/mahlkoenig-e64-ws"}],"stepNative":1},"id":"e64ws","image":{"attribution":"Copyright held by Mahlkönig; permission to redistribute was not verified.","caption":"E64 WS front product view; electronic adjustment/display is part of the unit","license":"unknown","licenseUrl":null,"owner":"Mahlkönig","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://www.mahlkoenig.com/products/e64-ws-espresso-home-grinder","url":"https://www.mahlkoenig.us/cdn/shop/files/E64-WS-Black-square_700x700.webp?v=1763414639","verifiedAt":"2026-10-11"},"markings":"Electronic disc-distance value; no universal range verified","model":"E64 WS","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/e64ws.svg","sources":[{"title":"E64 WS manufacturer or manual reference","url":"https://www.mahlkoenig.com/products/e64-ws-espresso-home-grinder"}],"unit":"µm","zero":"On-screen disk-distance calibration"},{"control":"manual adjustment with DDD readout","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","espressoAdjustment":{"basis":"unknown_require_owner_increment","espressoSupported":true,"note":"Starting guidance, not a calibrated grinder response. Manual slider/lever adjustment with DDD readout; not motorized E64WS/E80W GbS. Confirm whether input is mm, µm or dial scale; do not treat the catalog unit label as verified display precision. Choose one repeatably achievable owner-supplied small DDD change.","numericFinerDelta":null,"sources":[{"title":"Mahlkönig: E65S GbW quick start","url":"https://downloads.mahlkoenig.de/Service/Mahlkoenig_E65S_Gbw_Espresso_Grinder_Quick_start_manual_DE_EN.pdf"}],"stepNative":null},"id":"e65sgbw","image":{"attribution":"Copyright held by Mahlkönig; permission to redistribute was not verified.","caption":"E65S GbW product view","license":"unknown","licenseUrl":null,"owner":"Mahlkönig","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://www.mahlkoenig.com/products/e65s-gbw","url":"https://www.mahlkoenig.us/cdn/shop/files/E65S_GbW_-_Black_560x700.webp?v=1761340232","verifiedAt":"2026-10-11"},"markings":"Use verified DDD distance, not an unmeasured adjustment-lever position","model":"E65S GbW","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder.","The DDD screen reads distance; it does not establish motorized adjustment or a universal numeric step."],"schematicUrl":"../docs/grinder-dials/e65sgbw.svg","sources":[{"title":"E65S GbW manufacturer or manual reference","url":"https://www.mahlkoenig.com/products/e65s-gbw"}],"unit":"µm (DDD readout only)","zero":"Manufacturer DDD calibration"},{"control":"manual adjustment with DDD readout","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","espressoAdjustment":{"basis":"unknown_require_owner_increment","espressoSupported":true,"note":"Starting guidance, not a calibrated grinder response. Manual slider/lever adjustment with DDD readout; not motorized E64WS/E80W GbS. Confirm whether input is mm, µm or dial scale; do not treat the catalog unit label as verified display precision. Choose one repeatably achievable owner-supplied small DDD change.","numericFinerDelta":null,"sources":[{"title":"Mahlkönig: E80S GbW product and manual links","url":"https://www.mahlkoenig.com/products/e80s-gbw-grinder"}],"stepNative":null},"id":"e80sgbw","image":{"attribution":"Copyright held by Mahlkönig; permission to redistribute was not verified.","caption":"E80S GbW product view","license":"unknown","licenseUrl":null,"owner":"Mahlkönig","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://www.mahlkoenig.com/products/e80s-gbw-grinder","url":"https://www.mahlkoenig.us/cdn/shop/files/E80S_GbW_-_Black_560x700.webp?v=1761340079","verifiedAt":"2026-10-11"},"markings":"Use verified DDD distance, not an unmeasured adjustment-lever position","model":"E80S GbW","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder.","The DDD screen reads distance; it does not establish motorized adjustment or a universal numeric step."],"schematicUrl":"../docs/grinder-dials/e80sgbw.svg","sources":[{"title":"E80S GbW manufacturer or manual reference","url":"https://www.mahlkoenig.com/products/e80s-gbw-grinder"}],"unit":"µm (DDD readout only)","zero":"Manufacturer DDD calibration"},{"control":"collar","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","espressoAdjustment":{"basis":"cautious_product_heuristic","espressoSupported":true,"note":"Cautious starting trial chosen by this app; no model-specific numerical correction was verified. Half mark is proposed, not a numeric Gen1 recommendation found in these sources. Do not transfer Gen2 response. Confirm how one minor mark maps to the displayed numeric scale before computing a destination; relative half-mark trial remains usable.","numericFinerDelta":null,"sources":[{"title":"Clive Coffee: DF64 user manual","url":"https://support.clivecoffee.com/en/articles/16426035-df64-single-dose-user-manual"},{"title":"DF Grinders: DF54 and DF64 grind guide","url":"https://dfgrinders.com/pages/df54-grind-size-guide"}],"stepNative":0.5},"id":"df64gen1","image":{"attribution":"Copyright held by DF64 Coffee; permission to redistribute was not verified.","caption":"DF64 original-generation product photograph with numbered adjustment collar visible; not a calibration measurement","license":"unknown","licenseUrl":null,"owner":"DF64 Coffee","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://df64coffee.com/products/df64-single-dose-coffee-grinder","url":"https://df64coffee.com/cdn/shop/products/IMG_8737.png?v=1626712036&width=1445","verifiedAt":"2026-10-11"},"markings":"Common 0–90-ish printed reference scale; owner-confirmed scale, not operating bounds","model":"DF64 Gen 1","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/df64gen1.svg","sources":[{"title":"DF64 Gen 1 manufacturer or manual reference","url":"https://support.clivecoffee.com/en/articles/16426035-df64-single-dose-user-manual"}],"unit":"dial marks","zero":"Owner-confirmed zero; printed zero may be offset"},{"control":"collar","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","espressoAdjustment":{"basis":"reviewer_observed_increment","espressoSupported":true,"note":"Based on an adjustment observed in a firsthand review, not a guaranteed change in shot time. Reviewer observation is local, not seconds-per-mark calibration. Stock vs SSP and zero/indicator epoch must be recorded. Confirm how one minor mark maps to the displayed numeric scale before computing a destination; relative half-mark trial remains usable.","numericFinerDelta":null,"sources":[{"title":"Kaffeemacher: DF64 Gen2 firsthand test","url":"https://kaffeemacher.ch/blogs/kaffeewissen/g-iota-df64-gen2"},{"title":"Clive Coffee: DF64 user manual","url":"https://support.clivecoffee.com/en/articles/16426035-df64-single-dose-user-manual"}],"stepNative":0.5},"id":"df64gen2","image":{"attribution":"Copyright held by DF Grinders; permission to redistribute was not verified.","caption":"DF64 Gen 2 whole-grinder product photograph; the collar marking is a visual reference, not a calibration measurement","license":"unknown","licenseUrl":null,"owner":"DF Grinders","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://df64coffee.com/products/df64-gen-2-single-dose-coffee-grinder","url":"https://df64coffee.com/cdn/shop/files/64_GEN_2.png?v=1750929704&width=1946","verifiedAt":"2026-10-11"},"markings":"Common 0–90-ish printed reference scale; owner-confirmed scale, not operating bounds","model":"DF64 Gen 2","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/df64gen2.svg","sources":[{"title":"DF64 Gen 2 manufacturer or manual reference","url":"https://df64coffee.com/products/df64-gen-2-single-dose-coffee-grinder"}],"unit":"dial marks","zero":"Movable indicator and burr changes require a fresh zero epoch"},{"control":"collar","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","espressoAdjustment":{"basis":"cautious_product_heuristic","espressoSupported":true,"note":"Cautious starting trial chosen by this app; no model-specific numerical correction was verified. Half mark is proposed, not a measured DF54 correction. Vendor revision labels differ; record seller and revision. Stock espresso vs brew burrs matters. Confirm how one minor mark maps to the displayed numeric scale before computing a destination; relative half-mark trial remains usable.","numericFinerDelta":null,"sources":[{"title":"MiiCoffee: DF54 specifications and revisions","url":"https://miicoffee.shop/products/miicoffee-df54-single-dose-coffee-grinder"},{"title":"Kaffeemacher: DF54 firsthand test","url":"https://kaffeemacher.ch/blogs/kaffeewissen/df54-test"},{"title":"DF Grinders: DF54 and DF64 grind guide","url":"https://dfgrinders.com/pages/df54-grind-size-guide"}],"stepNative":0.5},"id":"df54","image":{"attribution":"Copyright held by DF Grinders; permission to redistribute was not verified.","caption":"DF54 whole-grinder product photograph; the collar marking is a visual reference, not a calibration measurement","license":"unknown","licenseUrl":null,"owner":"DF Grinders","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://df64coffee.com/products/df54","url":"https://df64coffee.com/cdn/shop/files/DF54.jpg?v=1738563824&width=1946","verifiedAt":"2026-10-11"},"markings":"Numbered stepless collar; confirm actual markings on your unit","model":"DF54","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/df54.svg","sources":[{"title":"DF54 manufacturer or manual reference","url":"https://df64coffee.com/products/df54"}],"unit":"dial marks","zero":"Owner-confirmed indicator/zero"},{"control":"collar","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","espressoAdjustment":{"basis":"practice_guidance_starting_step","espressoSupported":true,"note":"Starting guidance, not a calibrated grinder response. Kaffeemacher names one-to-two marks; start at its smaller end. Stepless, not physical clicks.","numericFinerDelta":-1,"sources":[{"title":"Niche: dialling in the Niche Zero","url":"https://www.nichecoffee.co.uk/blogs/exploring-coffee/how-to-dial-in-your-niche-zero"},{"title":"Kaffeemacher: espresso grind adjustment","url":"https://kaffeemacher.ch/blogs/kaffeewissen/mein-mahlgrad"}],"stepNative":1},"id":"nichezero","image":{"attribution":"Copyright held by Niche Coffee; permission to redistribute was not verified.","caption":"Niche Zero with dial visible in the manufacturer's dial-in guide","license":"unknown","licenseUrl":null,"owner":"Niche Coffee","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://www.nichecoffee.co.uk/blogs/exploring-coffee/how-to-dial-in-your-niche-zero","url":"https://cdn.shopify.com/s/files/1/0081/2076/2450/files/White_Niche_Zero_and_coffee_machine.jpg?v=1760088418","verifiedAt":"2026-10-11"},"markings":"Stepless numbered collar; manufacturer examples are recipes, not safe limits","model":"Niche Zero","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/nichezero.svg","sources":[{"title":"Niche Zero manufacturer or manual reference","url":"https://www.nichecoffee.co.uk/blogs/exploring-coffee/how-to-calibrate-your-grinder-for-optimum-performance"}],"unit":"dial marks","zero":"Follow Niche calibration after relevant disassembly"},{"control":"collar","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","espressoAdjustment":{"basis":"minimum_native_increment","espressoSupported":true,"note":"One physical click is the native adjustment increment; its effect on this coffee must be learned from your shots. Original Encore ESP only; exclude Encore and ESP Pro. Fine range 1–20; crossing into 21 changes step resolution.","numericFinerDelta":-1,"sources":[{"title":"Baratza: Encore ESP manual, January 2023","url":"https://assets.breville.com/ZCG495/manual-encoreesp-v1-0-en-010923.pdf"}],"stepNative":1},"id":"encoreesp","image":{"attribution":"Copyright held by Baratza/Breville; permission to redistribute was not verified.","caption":"Encore ESP product/carousel view; official page describes the numbered adjustment collar","license":"unknown","licenseUrl":null,"owner":"Baratza / Breville","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://www.baratza.com/en-us/product/encoretm-esp-zcg495","url":"https://assets.breville.com/cdn-cgi/image/width%3D333%2Cformat%3Dauto%2Cquality%3D75/ZCG495/ZCG495_Carousel1.png","verifiedAt":"2026-10-11"},"markings":"1–40; 1–20 espresso, 21–40 coarser/filter; steps have two resolution bands","model":"Baratza Encore ESP","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/encoreesp.svg","sources":[{"title":"Baratza Encore ESP manufacturer or manual reference","url":"https://www.baratza.com/en-dk/product/zcg495"}],"unit":"numbered settings","zero":"Shim/burr installation is calibration context"},{"control":"wheel","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","espressoAdjustment":{"basis":"cautious_product_heuristic","espressoSupported":true,"note":"Cautious starting trial chosen by this app; no model-specific numerical correction was verified. 0.1 is a proposed small visual movement, not manufacturer specification; owner must be able to reproduce it. No clicks. Record exact S model, burrs, RPM and zero adjustment.","numericFinerDelta":null,"sources":[{"title":"Timemore: Sculptor FAQ","url":"https://www.timemore.com/pages/sculptor-related-faq"},{"title":"Kaffeemacher: Sculptor 064S and 078S test","url":"https://kaffeemacher.ch/blogs/kaffeewissen/timemore-sculptor-78s-und-64s-im-test"}],"stepNative":0.1},"id":"sculptor064s","image":{"attribution":"Copyright held by Timemore; permission to redistribute was not verified.","caption":"Sculptor 064S product view; official product page variant image","license":"unknown","licenseUrl":null,"owner":"Timemore","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://www.timemore.com/products/timemore-electric-coffee-grinder-sculptor-series","url":"https://www.timemore.com/cdn/shop/files/064S.jpg?v=1713171847","verifiedAt":"2026-10-11"},"markings":"Stepless S model; do not substitute non-S burr/scale","model":"Timemore Sculptor 064S","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/sculptor064s.svg","sources":[{"title":"Timemore Sculptor 064S manufacturer or manual reference","url":"https://www.timemore.com/pages/sculptor-related-faq"}],"unit":"dial marks","zero":"Exact model, burr and RPM; reset after zero changes"},{"control":"wheel","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","espressoAdjustment":{"basis":"cautious_product_heuristic","espressoSupported":true,"note":"Cautious starting trial chosen by this app; no model-specific numerical correction was verified. 0.1 is a proposed small visual movement, not manufacturer specification; owner must be able to reproduce it. No clicks. Record exact S model, burrs, RPM and zero adjustment.","numericFinerDelta":null,"sources":[{"title":"Timemore: Sculptor FAQ","url":"https://www.timemore.com/pages/sculptor-related-faq"},{"title":"Kaffeemacher: Sculptor 064S and 078S test","url":"https://kaffeemacher.ch/blogs/kaffeewissen/timemore-sculptor-78s-und-64s-im-test"}],"stepNative":0.1},"id":"sculptor078s","image":{"attribution":"Copyright held by Timemore; permission to redistribute was not verified.","caption":"Sculptor 078S product view; official product page variant image","license":"unknown","licenseUrl":null,"owner":"Timemore","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://www.timemore.com/products/timemore-electric-coffee-grinder-sculptor-series","url":"https://www.timemore.com/cdn/shop/files/078S.jpg?v=1713171847","verifiedAt":"2026-10-11"},"markings":"Stepless S model; do not substitute non-S burr/scale","model":"Timemore Sculptor 078S","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/sculptor078s.svg","sources":[{"title":"Timemore Sculptor 078S manufacturer or manual reference","url":"https://www.timemore.com/pages/sculptor-related-faq"}],"unit":"dial marks","zero":"Exact model, burr and RPM; reset after zero changes"},{"control":"wheel","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","espressoAdjustment":{"basis":"cautious_product_heuristic","espressoSupported":true,"note":"Identify the change in your printed dial numbers for one minor tick before entering a numeric step. The documented axial movement per tick does not establish tick-to-number mapping or espresso response; current and pre-late-2024 variants differ.","numericFinerDelta":null,"sources":[{"title":"Option-O: LAGOM 01 competition resource","url":"https://www.option-o.com/wbrc-resource"},{"title":"Option-O: LAGOM 01 quick guide","url":"https://static1.squarespace.com/static/5b125642ec4eb782ce4f9947/t/65014e5f10d31854a1996f30/1694584416447/LAGOM%2B01%2Bquick%2Bguide.pdf"}],"stepNative":null},"id":"lagom01","image":{"attribution":"Copyright held by Option-O; permission to redistribute was not verified.","caption":"LAGOM 01 official product image","license":"unknown","licenseUrl":null,"owner":"Option-O","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://www.option-o.com/lagom-01","url":"https://images.squarespace-cdn.com/content/v1/5b125642ec4eb782ce4f9947/1693535581758-AKATHPG9RWQ6M071BF8O/lagom%2B01.jpg","verifiedAt":"2026-10-11"},"markings":"7.5 µm per micro tick for the documented configuration; not grounds diameter","model":"LAGOM 01","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/lagom01.svg","sources":[{"title":"LAGOM 01 manufacturer or manual reference","url":"https://www.option-o.com/guide-lagom-01"}],"unit":"micro-ticks","zero":"Configuration-specific zero, competition reference ±2 ticks"},{"control":"wheel","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","espressoAdjustment":{"basis":"manufacturer_reference_increment","espressoSupported":true,"note":"Chosen small starting trial of one printed 0.1 line. OPTION-O states 10 µm vertical movement per 0.1 line; this is carrier travel, not particle size or a guaranteed shot-time change. Check the dial and firmware/variant on your own grinder.","numericFinerDelta":null,"sources":[{"title":"OPTION-O LAGOM P64 technical specifications","url":"https://www.option-o.com/lagom-p64"}],"stepNative":0.1},"id":"lagomp64","image":{"attribution":"Copyright held by Option-O; permission to redistribute was not verified.","caption":"LAGOM P64 official product image","license":"unknown","licenseUrl":null,"owner":"Option-O","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://www.option-o.com/lagom-p64","url":"https://images.squarespace-cdn.com/content/v1/5b125642ec4eb782ce4f9947/8e408f57-ffa3-4196-bd61-4d2aab5671cf/LAGOM%2BP64.jpg","verifiedAt":"2026-10-11"},"markings":"Do not substitute LAGOM 01 pitch; local conversion required","model":"LAGOM P64","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/lagomp64.svg","sources":[{"title":"LAGOM P64 manufacturer or manual reference","url":"https://www.option-o.com/lagomp64userguide"}],"unit":"decimal dial numbers","zero":"Recalibrate after burr replacement; generation matters"},{"control":"ring","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","espressoAdjustment":{"basis":"minimum_native_increment","espressoSupported":true,"note":"Enter total clicks from your zero, including complete turns; do not enter only the number printed on the ring. One physical click is the native adjustment increment; its effect on this coffee must be learned from your shots. Store complete rotations plus clicks or normalized total clicks. Movement is not particle size or absolute conical burr gap. No guaranteed shot response.","numericFinerDelta":-1,"sources":[{"title":"1Zpresso: X-Pro manual","url":"https://1zpresso.coffee/manual-xpro-en/"}],"stepNative":1},"id":"xpro","image":{"attribution":"Copyright held by 1Zpresso; permission to redistribute was not verified.","caption":"X-Pro official adjustment instruction image","license":"unknown","licenseUrl":null,"owner":"1Zpresso","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://1zpresso.coffee/manual-xpro-en/","url":"https://i0.wp.com/1zpresso.coffee/wp-content/uploads/2022/08/3-1.jpg?fit=731%2C386&ssl=1","verifiedAt":"2026-10-11"},"markings":"60 clicks/rotation; 12.5 µm mechanical movement per click","model":"1Zpresso X-Pro","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/xpro.svg","sources":[{"title":"1Zpresso X-Pro manufacturer or manual reference","url":"https://1zpresso.coffee/manual-xpro-en/"}],"unit":"clicks from zero","zero":"Manual zero procedure; multi-turn count must be retained"},{"control":"ring","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","espressoAdjustment":{"basis":"minimum_native_increment","espressoSupported":true,"note":"Enter total clicks from your zero, including complete turns; do not enter only the number printed on the ring. One physical click is the native adjustment increment; its effect on this coffee must be learned from your shots. Store complete rotations plus clicks or normalized total clicks. Movement is not particle size or absolute conical burr gap. No guaranteed shot response.","numericFinerDelta":-1,"sources":[{"title":"1Zpresso: J-Max manual","url":"https://1zpresso.coffee/manual-jmax-en/"}],"stepNative":1},"id":"jmax","image":{"attribution":"Copyright held by 1Zpresso; permission to redistribute was not verified.","caption":"J-Max product image with external adjustment ring","license":"unknown","licenseUrl":null,"owner":"1Zpresso","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://1zpresso.coffee/j/","url":"https://i0.wp.com/1zpresso.coffee/wp-content/uploads/2021/07/J-Max-grinder-w-closeup.jpg?fit=1333%2C1000&ssl=1","verifiedAt":"2026-10-11"},"markings":"90 clicks/rotation; 8.8 µm mechanical movement per click","model":"1Zpresso J-Max","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder."],"schematicUrl":"../docs/grinder-dials/jmax.svg","sources":[{"title":"1Zpresso J-Max manufacturer or manual reference","url":"https://1zpresso.coffee/manual-jmax-en/"}],"unit":"clicks from zero","zero":"Manual zero procedure; multi-turn count must be retained"},{"control":"ring","direction":"Smaller displayed distance / count is finer; verify the applicable zero procedure.","espressoAdjustment":{"basis":"minimum_native_increment","espressoSupported":true,"note":"Enter total clicks from your zero, including complete turns; do not enter only the number printed on the ring. One physical click is the native adjustment increment; its effect on this coffee must be learned from your shots. Store complete rotations plus clicks or normalized total clicks. Movement is not particle size or absolute conical burr gap. No guaranteed shot response. Only K-Pro/K-Max/K-Plus; require subtype; K-Ultra needs its own entry.","numericFinerDelta":-1,"sources":[{"title":"1Zpresso: K series specifications","url":"https://1zpresso.coffee/k/"}],"stepNative":1},"id":"kseries","image":{"attribution":"Copyright held by 1Zpresso; permission to redistribute was not verified.","caption":"K-series external adjustment ring product image","license":"unknown","licenseUrl":null,"owner":"1Zpresso","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://1zpresso.coffee/k/","url":"https://i0.wp.com/1zpresso.coffee/wp-content/uploads/2021/06/KPRO-new.png?fit=1000%2C800&ssl=1","verifiedAt":"2026-10-11"},"markings":"90 clicks/rotation for reviewed K-Pro/K-Max/K-Plus; 22 µm/click; not K-Ultra","model":"1Zpresso K series","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder.","The reviewed 22 µm/click specification covers K-Pro/K-Max/K-Plus, not K-Ultra or every K-branded revision."],"schematicUrl":"../docs/grinder-dials/kseries.svg","sources":[{"title":"1Zpresso K series manufacturer or manual reference","url":"https://1zpresso.coffee/k/"}],"unit":"clicks from zero","zero":"Model-specific zero; retain complete turns and clicks"},{"control":"wheel","direction":"Confirm the numeric finer direction on your own calibrated unit; rotation and printed-number direction are separate.","espressoAdjustment":{"basis":"unsupported_for_espresso","espressoSupported":false,"note":"Starting guidance, not a calibrated grinder response. Keep available as equipment metadata, exclude espresso adjustment presets even with alternative burrs unless supported separately.","numericFinerDelta":null,"sources":[{"title":"Fellow: Ode Gen2 espresso suitability","url":"https://support.fellowproducts.com.au/en_us/is-ode-gen-2-suitable-for-grinding-espresso-HJt8Rm8qZe"}],"stepNative":null},"id":"odegen2","image":{"attribution":"Copyright held by Fellow; permission to redistribute was not verified.","caption":"Ode Gen 2 official product image with large grind dial","license":"unknown","licenseUrl":null,"owner":"Fellow","renderAllowed":false,"reuse":"Externally hosted copyright image; no redistribution licence verified.","source":"official-product-page","sourceUrl":"https://fellowproducts.com/collections/grind-brew/products/ode-brew-grinder-gen-2?variant=40978992463972","url":"https://fellowproducts.com/cdn/shop/files/Web_PDP_OdeBrewGrinderGen2_Black_1_b979089a-570a-4024-99e7-dc5fcac0c69c.png?v=1780523585&width=1200","verifiedAt":"2026-10-11"},"markings":"Printed 1–11 dial with intermediate clicks; brewed-coffee grinder, not espresso","model":"Fellow Ode Gen 2","notes":["Mechanical gap and particle size are different measurements.","A unit conversion does not validate recovered GBS formulas for this grinder.","Fellow Ode is a brewed-coffee grinder and is not a supported espresso grinder recommendation."],"schematicUrl":"../docs/grinder-dials/odegen2.svg","sources":[{"title":"Fellow Ode Gen 2 manufacturer or manual reference","url":"https://fellowproducts.com/pages/gear-guide-ode"}],"unit":"dial positions","zero":"Stock and SSP calibration procedures differ"}],"reviewedAt":"2026-10-12","schemaVersion":1},"reviewedAt":"2026-10-11","schemaVersion":1,"sources":[{"facts":{"brewRatio":"1:2","brewTimeSec":{"max":32,"min":28,"unit":"s"},"components":[{"name":"Altamira de Chirripó","origin":"Costa Rica","process":"white honey","roastLevel":"medium","variety":"Catuaí"},{"name":"El Meridiano","origin":"Colombia","process":"washed","roastLevel":"medium","variety":["Caturra","Colombia","Typica"]}],"doseG":19,"tastingNotes":["red apple","toffee","chocolate","hazelnut"],"temperatureC":{"max":94.5,"min":94,"unit":"C"}},"id":"squaremile-red-brick","kind":"roaster","notes":["The page says this is a starting point and machine-dependent; component percentages can change."],"publisher":"Square Mile Coffee Roasters","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"bean-specific starting recipe","brewMethod":"espresso","coffee":"Red Brick","equipment":"VA388 Black Eagle; VST 20g basket"},"title":"Red Brick espresso recipe","url":"https://shop.squaremilecoffee.com/products/red-brick"},{"facts":{"brewTimeSec":{"max":35,"min":25,"unit":"s"},"doseG":{"max":20,"min":19,"unit":"g"},"temperatureC":{"max":94,"min":93,"unit":"C"},"yieldG":{"max":45,"min":42,"unit":"g"}},"id":"tim-wendelboe-espresso","kind":"roaster","notes":["The page allows up to 50g for a more diluted cup and recommends drinking below 60C."],"publisher":"Tim Wendelboe","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic starting recipe","brewMethod":"espresso","equipment":"VST 20g basket"},"title":"How we make espresso","url":"https://timwendelboe.no/pages/how-we-make-espresso-espresso-tips"},{"facts":{"brewRatio":"1:2","brewTimeSec":28,"doseG":18,"yieldG":36},"id":"counter-culture-espresso","kind":"roaster","notes":["A general baseline; no temperature or grinder coordinate is prescribed."],"publisher":"Counter Culture Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic baseline","brewMethod":"espresso"},"title":"Guide to espresso","url":"https://counterculturecoffee.com/blogs/counter-culture-coffee/guide-to-espresso"},{"facts":{"brewRatio":{"max":2.5,"min":1.5,"unit":"ratio"},"brewTimeSec":{"max":35,"min":25,"unit":"s"},"doseG":18,"yieldG":36},"id":"counter-culture-quick-espresso","kind":"roaster","notes":["The page suggests finer below 25s and coarser above 35s as a starting adjustment; taste can override time."],"publisher":"Counter Culture Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic adjustment guide","brewMethod":"espresso"},"title":"Quick and easy espresso","url":"https://counterculturecoffee.com/pages/quick-easy-espresso"},{"facts":{"brewTimeSec":{"max":32,"min":28,"unit":"s"},"doseG":20,"grindDescription":"extra-fine","yieldG":40},"id":"blue-bottle-long-pull","kind":"roaster","notes":["No temperature is specified on the reviewed page."],"publisher":"Blue Bottle Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"method-specific starting recipe","brewMethod":"espresso","coffee":"single origin"},"title":"Single origin long-pull espresso","url":"https://bluebottlecoffee.com/us/eng/brew-guides/single-origin-espresso"},{"facts":{"brewTimeSec":{"max":210,"min":150,"unit":"s"},"doseG":{"max":27,"min":20,"unit":"g"},"temperatureC":{"max":96.1,"min":90.6,"unit":"C"},"waterG":350},"id":"blue-bottle-pourover","kind":"roaster","notes":["The page says darker roasts suit the cooler end and lighter roasts the hotter end; it gives no grinder coordinate."],"publisher":"Blue Bottle Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic method","brewMethod":"pour-over"},"title":"Pour-over guide","url":"https://bluebottlecoffee.com/us/eng/brew-guides/pour-over"},{"facts":{"brewTimeSec":{"max":360,"min":240,"unit":"s"},"doseG":59,"grindDescription":"medium-coarse","waterAmount":"6 cups (half pot)"},"id":"blue-bottle-moccamaster","kind":"roaster","notes":["The source describes a half-pot/6-cup dose. It also mentions 98g for a full pot with 10 cups; no gram-to-cup conversion is inferred."],"publisher":"Blue Bottle Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"equipment-specific batch recipe","brewMethod":"automatic filter","equipment":"Technivorm Moccamaster KBGV"},"title":"Technivorm Moccamaster guide","url":"https://bluebottlecoffee.com/us/eng/brew-guides/coffee-maker"},{"facts":{"brewTimeSec":{"max":22,"min":18,"unit":"s"},"doseG":18,"yieldG":50},"id":"lacabra-espresso","kind":"roaster","notes":["The page explicitly says its outline need not be followed exactly and discusses water chemistry."],"publisher":"La Cabra","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic starting recipe","brewMethod":"espresso"},"title":"Brew guides","url":"https://lacabra.com/pages/brewing"},{"facts":{"doseG":15,"pourScheduleSec":[0,45,90],"waterG":250},"id":"lacabra-v60","kind":"roaster","notes":["The source does not prescribe a total brew time for this V60 outline."],"publisher":"La Cabra","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic method","brewMethod":"V60"},"title":"Brew guides V60","url":"https://lacabra.com/pages/brewing"},{"facts":{"brewTimeSec":{"max":23,"min":12,"unit":"s"},"doseG":18.5,"temperatureC":93,"yieldG":{"max":45,"min":40,"unit":"g"}},"id":"prolog-espresso","kind":"roaster","notes":["The source says its bar often uses 12–14s and equipment/water/technique can make a slower shot better."],"publisher":"Prolog Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic starting recipe","brewMethod":"espresso"},"title":"Brew guides","url":"https://www.prologcoffee.com/pages/brew-guides"},{"facts":{"brewTimeSec":150,"doseG":15,"temperatureC":100,"yieldG":250},"id":"prolog-v60","kind":"roaster","notes":["The page calls this a starting point and says taste and coffee may require adjustment."],"publisher":"Prolog Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster generic starting recipe","brewMethod":"V60"},"title":"Brew guides V60","url":"https://www.prologcoffee.com/pages/brew-guides"},{"facts":{"brewTimeSec":24,"doseG":19,"farm":"Finca El Diviso","origin":"Colombia","producer":"Nestor Lasso","tastingNotes":["ripe raspberry","red cherry","boysenberry ice cream"],"variety":"Ombligon","yieldG":43},"id":"onyx-nestor-lasso","kind":"roaster","notes":["The page also publishes a separate 20g/280g Origami recipe; this entry is espresso only. Roast level is not inferred."],"publisher":"Onyx Coffee Lab","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"bean-specific recipe","brewMethod":"espresso","coffee":"Colombia Nestor Lasso Ombligon"},"title":"Nestor Lasso Ombligon extraction guide","url":"https://onyxcoffeelab.com/products/colombia-nestor-lasso-ombligon-26"},{"facts":{"brewTimeSec":25,"doseG":19,"origin":"Honduras","producer":"Benjamin Paz","variety":"SL28","yieldG":45},"id":"onyx-benjamin-paz","kind":"roaster","notes":["The page's espresso recipe is listed separately from the filter recipe. Processing, roast level and tasting notes are not inferred when not explicit in the reviewed extract."],"publisher":"Onyx Coffee Lab","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"bean-specific recipe","brewMethod":"espresso","coffee":"Honduras Benjamin Paz SL28"},"title":"Benjamin Paz SL28 extraction guide","url":"https://onyxcoffeelab.com/en-int/products/honduras-benjamin-paz-sl28-26"},{"facts":{"brewTimeSec":23,"doseG":19,"origin":"Colombia","variety":"Gesha","yieldG":50},"id":"onyx-el-jardin","kind":"roaster","notes":["The same page provides a separate 15g/240g filter recipe. Roast level, process and tasting notes are not inferred from the product title."],"publisher":"Onyx Coffee Lab","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"bean-specific recipe","brewMethod":"espresso","coffee":"Colombia El Jardin Gesha"},"title":"El Jardin Gesha extraction guide","url":"https://onyxcoffeelab.com/products/colombia-el-jardin-gesha"},{"facts":{"brewTimeSec":22,"doseG":18,"origin":"Costa Rica","process":"natural","tastingNotes":["grape","semi-sweet dark chocolate","fresh berries","vanilla","rich chocolate"],"variety":"Catuai","yieldG":42},"id":"onyx-las-lajas","kind":"roaster","notes":["The espresso recipe is accompanied by a distinct filter recipe; the product page describes the lot as naturally processed."],"publisher":"Onyx Coffee Lab","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"bean-specific recipe","brewMethod":"espresso","coffee":"Costa Rica Las Lajas Natural"},"title":"Las Lajas Natural extraction guide","url":"https://onyxcoffeelab.com/products/costa-rica-las-lajas-natural-25"},{"facts":{"workflow":"guided roast, dose, beverage-weight, brew-time and initial-grind-degree screens"},"id":"mahlkoenig-e64-manual","kind":"manufacturer","notes":["The reviewed PDF was not reachable during the independent audit; no numeric example values are treated as verified facts here. The workflow description is retained for context only and does not expose a calibration equation."],"publisher":"Mahlkönig","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific guided workflow","brewMethod":"espresso","grinderModel":"E64 WS"},"title":"E64 WS Espresso Home software manual","url":"https://downloads.mahlkoenig.de/Service/Mahlkoenig_E64_WS_Espresso_Home_Software_Manual.pdf"},{"facts":{"dialDirection":"clockwise=finer; counter-clockwise=coarser"},"id":"df64-clive","kind":"manufacturer","notes":["The page says the collar is sensitive and that the stock sticker may be inaccurate after SSP burr installation."],"publisher":"Clive Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model/generation-dependent mechanical guidance","grinderModel":"DF64"},"title":"DF64 Single Dose user manual","url":"https://support.clivecoffee.com/en/articles/16426035-df64-single-dose-user-manual"},{"facts":{"burrDiameterMm":40,"espressoSettingRange":{"max":20,"min":1},"filterSettingRange":{"max":40,"min":21},"rpm":550},"id":"baratza-encore-esp","kind":"manufacturer","notes":["Settings are dial coordinates, not micrometres or particle-size guarantees."],"publisher":"Baratza","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific mechanical specification","burrSKU":"M2 conical steel","grinderModel":"Encore ESP"},"title":"Encore ESP specifications","url":"https://www.baratza.com/en-dk/product/zcg495"},{"facts":{"064SUse":"pour-over and espresso","078SUse":"pour-over and espresso","078TurboUse":"pour-over focused","burrVariants":["064S flat","078S flat","078 turbo"],"rpmControl":"variable"},"id":"timemore-sculptor","kind":"manufacturer","notes":["The current product pages describe these three relevant variants; they do not support treating them as four equivalent interchangeable configurations and do not give a universal dial-to-particle-size conversion."],"publisher":"Timemore","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model and burr-variant specification","grinderModel":"Sculptor 064S/078S"},"title":"Sculptor series and burrs","url":"https://www.timemore.com/products/timemore-electric-coffee-grinder-sculptor-series"},{"facts":{"burrZero":"burr touch","postCleaningPurgeG":18},"id":"niche-zero-calibration","kind":"manufacturer","notes":["The source recommends recalibration after disassembly/cleaning; purge amount is a preparation step, not a dial conversion."],"publisher":"Niche Coffee","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific zero procedure","burrSKU":"63mm conical","grinderModel":"Niche Zero"},"title":"Niche Zero calibration","url":"https://www.nichecoffee.co.uk/blogs/exploring-coffee/how-to-calibrate-your-grinder-for-optimum-performance"},{"facts":{"burrTravelMicrometresPerClick":7.5,"rpmRange":{"max":1700,"min":200},"zeroToleranceMicroTicks":2},"id":"option-o-lagom-01","kind":"manufacturer","notes":["Burr-gap movement is not particle size or a cross-model conversion."],"publisher":"Option-O","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"configuration-specific mechanical specification","burrSKU":"Mizen 102OM flat in competition configuration","grinderModel":"LAGOM 01"},"title":"LAGOM 01 guide and competition specification","url":"https://www.option-o.com/wbrc"},{"facts":{"missesBeforeSuggestion":3},"id":"fiorenzato-adapt","kind":"manufacturer","notes":["The manufacturer describes a wired flow-meter connection and a suggestion after three extractions miss the recipe; coefficients are not published."],"publisher":"Fiorenzato","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"manufacturer product behavior claim","system":"ADAPT"},"title":"ADAPT connection system","url":"https://www.fiorenzato.com/en/adapt/"},{"facts":{"features":["Smart Profiler","Grind Analyzer","Coffee Diary"]},"id":"maro-model-1","kind":"manufacturer","notes":["The reviewed product page does not publish a Brew Companion feature, recommendation equations, grinder calibration units or an API. MARO HOME is catalogued separately only when a directly verified source supports a feature."],"publisher":"MARO Coffee Engineering","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"manufacturer product feature claim","system":"MARO Model 1"},"title":"MARO Model 1 product features","url":"https://maro.coffee/en/products/maro-model-1"},{"facts":{"finding":"below a critical grind size, extraction can decrease as grind becomes finer"},"id":"coffee-physics-uneven","kind":"research","notes":["Supports a non-monotonic caution; not a grinder calibration dataset. License/reuse terms must be checked at the repository before redistribution."],"publisher":"arXiv research preprint","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"physical model and experiment context","brewMethod":"espresso"},"title":"Uneven Extraction in Coffee Brewing","url":"https://arxiv.org/abs/2206.12373"},{"facts":{"finding":"flow influence is stronger at finer grind and higher temperature","license":"CC BY 4.0"},"id":"coffee-physics-flow-temperature","kind":"research","notes":["Particle size distribution and flow must remain context variables; source is not a dial-coordinate lookup."],"publisher":"Peer-reviewed open-access research","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"controlled experimental evidence","brewMethod":"espresso"},"title":"Influence of flow rate, particle size, and temperature on espresso extraction kinetics","url":"https://pmc.ncbi.nlm.nih.gov/articles/PMC10418593/"},{"facts":{"finding":"particle-size distribution affects bed compression, porosity and permeability"},"id":"coffee-physics-psd-compression","kind":"research","notes":["Abstract-level source review; full-text reuse rights were not established."],"publisher":"Journal of Food Engineering","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"peer-reviewed packed-bed model and experiment","brewMethod":"espresso"},"title":"Influence of particle size distribution on espresso extraction via packed bed compression","url":"https://www.sciencedirect.com/science/article/abs/pii/S0260877422003557"},{"facts":{"finding":"particle-size distribution changes espresso aromatic profile non-monotonically"},"id":"coffee-physics-psd-nonmonotonic","kind":"research","notes":["Use as a caution against assuming a single monotone grind-response curve; full-text reuse rights were not established."],"publisher":"Food Research International","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"peer-reviewed particle-distribution evidence","brewMethod":"espresso"},"title":"Espresso coffee design based on non-monotonic granulometric distribution of aromatic profile","url":"https://pubmed.ncbi.nlm.nih.gov/31285015/"},{"facts":{"finding":"particle size and filter basket design affect extraction chemistry"},"id":"coffee-physics-particle-size","kind":"research","notes":["The source does not provide a grinder dial conversion; full-text reuse rights were not established."],"publisher":"Food Chemistry","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"peer-reviewed particle-size and basket experiment","brewMethod":"espresso"},"title":"Optimization of espresso extraction through variation of particle sizes","url":"https://pubmed.ncbi.nlm.nih.gov/31982858/"},{"facts":{"burrTravelMicrometresPerClick":12.5,"clicksPerRotation":60},"id":"onezpresso-xpro","kind":"manufacturer","notes":["This is burr movement from the manufacturer manual, not particle size or an extraction response."],"publisher":"1Zpresso","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific mechanical travel","grinderModel":"X-Pro"},"title":"X-Pro user manual","url":"https://1zpresso.coffee/manual-xpro-en/"},{"facts":{"burrTravelMicrometresPerClick":8.8},"id":"onezpresso-jmax","kind":"manufacturer","notes":["The manual's click travel is mechanical burr spacing; it is not a particle-size claim."],"publisher":"1Zpresso","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific mechanical travel","grinderModel":"J-Max"},"title":"J-Max user manual","url":"https://1zpresso.coffee/wp-content/uploads/2021/08/J-Max-User-Manual-20210819.pdf"},{"facts":{"burrTravelMicrometresPerClick":22,"clicksPerRotation":90},"id":"onezpresso-k-series","kind":"manufacturer","notes":["The published click value is mechanical movement, not particle size."],"publisher":"1Zpresso","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific mechanical travel","grinderModel":"K series"},"title":"K series specifications","url":"https://1zpresso.coffee/k/"},{"facts":{"HUUse":"espresso-focused","MPUse":"pour-over first; also espresso, French press and AeroPress"},"id":"ssp-64-hu-mp-df","kind":"manufacturer","notes":["Vendor descriptions do not provide a DF64 dial offset, particle distribution or zero compatibility table."],"publisher":"DF Grinders","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"vendor brew-intent description","burrSKU":"SSP HU/MP","grinderModel":"64mm flat-burr grinders including DF64"},"title":"64mm SSP Red Speed burrs","url":"https://dfgrinders.ca/products/64mm-ssp-red-speed-burrs"},{"facts":{"relativeParticleSizeMicrometresVsStockOde":-200},"id":"ssp-64-mp-ode","kind":"manufacturer","notes":["The comparison is for referenced Ode drip settings and must not be applied to DF64 collar readings."],"publisher":"Fellow","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"Ode-specific comparison","burrSKU":"SSP Red Speed 64mm MP","grinderModel":"Fellow Ode Brew Grinder"},"title":"SSP 64mm MP brew burrs","url":"https://fellowproducts.com/products/ssp-red-speed-coated-64mm-flat-brew-burrs"},{"facts":{"recalibrateAfterBurrReplacement":true},"id":"option-o-p64-calibration","kind":"manufacturer","notes":["The guide distinguishes routine cleaning from zero calibration and says production-period calibration differs."],"publisher":"Option-O","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"generation and burr-swap calibration","grinderModel":"LAGOM P64"},"title":"LAGOM P64 zero and burr calibration guide","url":"https://www.option-o.com/lagomp64userguide"},{"facts":{"adjustWhileBurrsSpinning":true},"id":"df64-running-adjustment","kind":"manufacturer","notes":["The FAQ recommends incremental adjustment while running; purge/settling behavior is plugin policy, not a published numeric constant."],"publisher":"DF Grinders","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"model-specific operating guidance","grinderModel":"DF64"},"title":"DF64 adjustment FAQ","url":"https://df64grinders.com/faqs"},{"facts":{"burrDiameterMm":64,"burrReplacementAccess":"remove collar to access top burr"},"id":"df64-gen2-manual","kind":"manufacturer","notes":["The reviewed manual does not publish collar pitch or travel per mark."],"publisher":"Turin/DF64 manual mirror","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"generation-specific maintenance","grinderModel":"DF64 Gen 2"},"title":"DF64 Gen 2 instruction manual","url":"https://manuals.plus/asin/B0DPRWGP6L.pdf"},{"facts":{"measurement":"image-based particle-size distribution","platforms":["macOS","Unix","Windows"]},"id":"coffee-ad-astra-psd-tool","kind":"research","notes":["Use as a measurement aid; do not copy code or graphics into the plugin without checking repository license."],"publisher":"Coffee Ad Astra / Jonathan Gagné","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"measurement workflow, not calibration constants","tool":"image-based PSD analyzer"},"title":"Application to measure grind size distribution","url":"https://github.com/jgagneastro/coffeegrindsize"},{"facts":{"grinderCount":24,"sampleCount":300},"id":"coffee-ad-astra-300-psd","kind":"research","notes":["Empirical PSD observations are not a universal dial or extraction model; reuse is limited to linked factual summary."],"publisher":"Coffee Ad Astra","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"published empirical PSD observations","brewMethod":"espresso"},"title":"What I learned from analyzing 300 particle size distributions","url":"https://coffeeadastra.com/2023/09/21/what-i-learned-from-analyzing-300-particle-size-distributions-for-24-espresso-grinders/"},{"facts":{"guidance":["extract more: finer and/or longer","extract less: coarser and/or shorter","change ratio for strength"]},"id":"barista-hustle-coffee-compass","kind":"research","notes":["The publisher explicitly scopes it to filter percolation and immersion, not espresso."],"publisher":"Barista Hustle","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"taste-guidance workflow","brewMethod":"filter coffee"},"title":"Coffee Compass","url":"https://www.baristahustle.com/coffee-compass/"},{"facts":{"integrations":["Decent Scale","Acaia","Felicita","Hiroia Jimmy","Eureka Precisa","Skale2","Smart Espresso Profiler","Pressensor"],"license":"GPL-3.0","trackedFields":["grind size","grind amount","brew time","first drip"]},"id":"beanconqueror-open-source","kind":"research","notes":["Use as an integration/data-model reference; no recommendation coefficients are imported."],"publisher":"Beanconqueror","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"data model and integration precedent","tool":"open-source brew logbook"},"title":"Beanconqueror coffee logging and device integrations","url":"https://github.com/graphefruit/Beanconqueror"},{"facts":{"freshCoffeeGuidance":"lower temperature and shorter contact time","minimumRestDays":10,"wellRestedBeyondWeeks":6,"wellRestedGuidance":"higher temperature and longer contact can be tolerated"},"id":"lacabra-water-resting","kind":"roaster","notes":["The source discusses lightly roasted dense coffees, degassing and water chemistry; it does not specify a universal espresso setting."],"publisher":"La Cabra","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster guidance, not grinder calibration","brewMethod":"coffee brewing; contextual guidance"},"title":"Water and coffee: resting and water guidance","url":"https://us.lacabra.com/pages/water"},{"facts":{"exampleEspresso":{"brewTimeSec":23,"doseG":19,"yieldG":47},"filters":["coffee name","origin","process","roast level"]},"id":"onyx-brew-guides-index","kind":"roaster","notes":["The index demonstrates that Onyx scopes recipes to named coffees and roast/process metadata; the example is not a universal target."],"publisher":"Onyx Coffee Lab","reuse":"linked factual summary; no copied proprietary datasets","scope":{"applicability":"roaster's coffee-specific guide index","brewMethod":"filter and espresso"},"title":"Brew guides index with origin/process/roast filters","url":"https://onyxcoffeelab.com/pages/brew-guides"},{"facts":{"calibration":"manufacturer fine grinding disk distance calibration procedure","coarserDirection":"larger displayed disk distance","control":"electronic recipe grinding degree operated through display and rotary knob","displayUnit":"µm","finerDirection":"smaller displayed disk distance"},"id":"mahlkoenig-e64ws-native-distance","kind":"manufacturer","notes":["Original operating instructions page 13 defines the µm unit and direction; page 26 covers fine disk-distance calibration.","The internal research coordinate is expressed in 0.1 µm: 500 research dD equals 50 µm as a unit conversion. This does not validate firmware behavior, limits or grinder portability.","No universal user setting range or increment is inferred from the manual."],"publisher":"Mahlkönig","reuse":"linked short factual summary; manufacturer photographs and manual illustrations remain external","scope":{"applicability":"native displayed disk distance, not particle diameter or validation of recovered algorithms","grinderModel":"E64 WS"},"title":"E64 WS native grinding disk distance and zero calibration","url":"https://downloads.mahlkoenig.de/Service/Mahlkoenig_E64_WS_Espresso_Home_Original_instructions_EN.pdf"}]};
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
    coffeeCatalog: catalog.coffeeCatalog,
    decentProfiles: catalog.decentProfiles,
    matchReferences(query = {}) {
      if (!query || typeof query !== "object" || Array.isArray(query)) return [];
      return catalog.sources.filter((source) => matches(source, query));
    },
  };
}
/* GENERATED REFERENCE CATALOG END */

function createDialinUiTools(document) {
  const el = (tag, text, attrs = {}) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); Object.entries(attrs).forEach(([key, value]) => { if (key in node) node[key] = value; else node.setAttribute(key, value); }); return node; };
  const clear = node => { node.textContent = ''; };
  function renderTrace(holder, metrics) {
    clear(holder);
    const trace = metrics && metrics.trace, points = trace && Array.isArray(trace.points) ? trace.points.filter(point => Number.isFinite(point.tSec)) : [];
    if (!points.length) { holder.appendChild(el('p', 'No timestamped measurements are available. Import a full saved shot, including measurements.')); return; }
    const timing = metrics.timing || {}, clock = timing.recording || {};
    const origin = {recording_start: 'recording start', first_machine_sample: 'the first machine sample', first_scale_sample: 'the first scale sample'}[trace.timeOrigin] || 'the reported trace origin';
    holder.appendChild(el('p', 'Time axis: seconds from ' + origin + '. Recording duration: ' + (clock.durationSec ?? metrics.elapsedSec ?? 'unknown') + ' s. Pump duration: ' + (timing.pump?.durationSec ?? 'unknown') + ' s. Pouring duration: ' + (timing.pouring?.durationSec ?? 'unknown') + ' s. Recording can include preheat and settling.'));
    const series = [['machineFlow', 'Machine inlet flow', 'ml/s', '#159bd7'], ['pressure', 'Pressure', 'bar', '#d97706'], ['beverageFlowGPerSec', 'Beverage mass flow', 'g/s', '#15803d']];
    const temp = [['mixTemperatureC', 'Measured mix temperature', '°C', '#db2777'], ['groupTemperatureC', 'Measured group temperature', '°C', '#7c3aed']];
    const maxT = Math.max(1, ...points.map(point => point.tSec));
    const chartWidth = Math.max(300, Math.min(760, Number(holder.clientWidth) || (Number(document.documentElement?.clientWidth) || 792) - 32));
    function chart(list, parent) {
      const ns = 'http://www.w3.org/2000/svg', make = (name, attrs, text) => { const node = document.createElementNS(ns, name); Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, String(value))); if (text != null) node.textContent = String(text); return node; };
      const svg = make('svg', {viewBox: '0 0 ' + chartWidth + ' ' + (list.length * 190 + 30), role: 'img', 'aria-label': list.map(item => item[1]).join(', ') + ' over recording time'});
      list.forEach(([key, name, unit, color], row) => {
        const top = row * 190 + 30, bottom = top + 125, values = points.filter(point => Number.isFinite(point[key])).map(point => point[key]);
        const low = unit === '°C' && values.length ? Math.floor(Math.min(...values) - 1) : Math.min(0, ...values), high = Math.max(low + 1, ...values), x = t => 50 + t / maxT * (chartWidth - 80), y = value => bottom - (value - low) / (high - low) * 115;
        svg.appendChild(make('text', {x: 50, y: top - 12, fill: color, 'font-size': 13}, name + ' (' + unit + ')' + (values.length ? '' : ' — unavailable')));
        [0, .5, 1].forEach(fraction => { const value = low + (high - low) * fraction, yy = y(value); svg.appendChild(make('line', {x1: 50, x2: chartWidth - 30, y1: yy, y2: yy, stroke: '#999', opacity: .35})); svg.appendChild(make('text', {x: 1, y: yy + 4, fill: 'currentColor', 'font-size': 11}, value.toFixed(1))); });
        let segment = [];
        const flush = () => { if (segment.length > 1) svg.appendChild(make('polyline', {'data-series': key, points: segment.map(point => x(point.tSec) + ',' + y(point[key])).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5})); else if (segment.length) svg.appendChild(make('circle', {cx: x(segment[0].tSec), cy: y(segment[0][key]), r: 2.5, fill: color})); segment = []; };
        // Points from the other sensor do not break a series; explicit invalid
        // samples and gaps in that sensor do. No interpolation through resets.
        let previous = null;
        points.forEach(point => { if (!Object.hasOwn(point, key)) return; if (!Number.isFinite(point[key])) { flush(); previous = null; return; } if (previous != null && point.tSec - previous > 5) flush(); segment.push(point); previous = point.tSec; }); flush();
        (trace.phases || []).filter(phase => phase.role === 'preinfusion' && Number.isFinite(phase.startSec) && Number.isFinite(phase.endSec)).forEach(phase => svg.appendChild(make('rect', {x: x(phase.startSec), y: top, width: Math.max(1, x(phase.endSec) - x(phase.startSec)), height: 125, fill: '#8b5cf6', opacity: .1})));
        [0, .5, 1].forEach(fraction => svg.appendChild(make('text', {x: x(maxT * fraction), y: bottom + 20, fill: 'currentColor', 'font-size': 11, 'text-anchor': fraction === 1 ? 'end' : fraction === 0 ? 'start' : 'middle'}, (maxT * fraction).toFixed(1) + ' s')));
      }); parent.appendChild(svg);
    }
    chart(series, holder);
    holder.appendChild(el('p', 'Each panel has its own numeric units. Lines stop across gaps over 5 s and invalid samples. Machine inlet ml/s and beverage g/s are different measurements. Purple bands identify recorded preinfusion phases only.'));
    const phases = el('ul'); (trace.phases || []).forEach(phase => phases.appendChild(el('li', phase.name + ': ' + phase.startSec + '–' + phase.endSec + ' s; ' + (phase.role || 'unknown role') + '; source ' + phase.source))); holder.appendChild(phases);
    holder.appendChild(el('p', 'Control mode: ' + (trace.controlMode || 'unknown') + '. ' + (trace.recommendation?.reason || trace.recommendation?.explanation || 'Profile transitions and sensor behavior are alternative explanations for flow changes. A graph alone does not establish a puck-preparation fault.')));
    const temperatures = el('details'), summary = el('summary', 'Measured brew temperatures and target tracking'); temperatures.appendChild(summary); chart(temp, temperatures);
    temperatures.appendChild(el('p', 'These temperatures come from saved machine sensors. Recipe targets and cup tasting temperatures are separate. Sourness or bitterness alone does not justify a brewing-temperature change.')); holder.appendChild(temperatures);
    const warnings = [...(metrics.warnings || []), ...(trace.warnings || []), ...(metrics.scale?.warnings || [])]; if (warnings.length) holder.appendChild(el('p', 'Measurement limits: ' + [...new Set(warnings)].join(' | ')));
  }
  function profilePicker(holder, catalog, onSelect) {
    clear(holder); const profiles = [...(catalog.profiles || []), ...(catalog.supplementalProfiles || [])];
    const label = el('label', 'Profile reference (' + profiles.length + ')'), select = el('select'); select.appendChild(el('option', 'Choose a reference; saved shot steps remain authoritative', {value: ''})); profiles.forEach(profile => select.appendChild(el('option', profile.title + ' · ' + profile.family, {value: profile.id}))); label.appendChild(select); holder.appendChild(label); const details = el('div'); holder.appendChild(details);
    select.addEventListener('change', () => { clear(details); const profile = profiles.find(item => item.id === select.value); if (!profile) return; details.appendChild(el('h3', profile.title)); details.appendChild(el('p', 'Controller family: ' + profile.family + '. Timing adjustment: ' + profile.grindTimePolicy + '. ' + profile.grindTimeAssumption)); (profile.warnings || []).forEach(warning => details.appendChild(el('p', warning))); const list = el('ol'); (profile.phases || []).forEach(phase => list.appendChild(el('li', phase.name + ' · ' + phase.role + ' · ' + phase.pump + ' ' + phase.target + ' ' + phase.unit + ' · maximum ' + phase.maximumDurationSeconds + ' s' + (phase.exit ? ' · conditional exit ' + JSON.stringify(phase.exit) : '')))); details.appendChild(list); details.appendChild(el('p', 'A matching name is not a runtime profile match or a grinder conversion. Analyse the actual saved controller steps and observed phases before using elapsed time.')); if (profile.source?.url) details.appendChild(el('a', 'Pinned upstream source', {href: profile.source.url, target: '_blank', rel: 'noopener'})); onSelect?.(profile); });
    return { select, profiles };
  }
  function supplementalInputs(holder, prefix) {
    if (!holder) return {state: {}, cases: () => ({})};
    const groups = [
      ['effectiveDd', 'Effective setting after a grind', [['grindDdDum','Current research coordinate (dD)'],['grindDurationMs','Measured grind duration (ms)'],['effectiveBaseline','Previous effective baseline (µm)'],['residue','Previous retained coordinate (µm)']]],
      ['grindTime', 'Grind-time prediction', [['mode','Firmware mode',['1','2','3']],['recipeDdUm','Recipe coordinate (µm)'],['targetDdDum','Target coordinate (dD)'],['recipeTimeMs','Measured recipe grind time (ms)']]],
      ['inverseRegression', 'Two measured grind/time points', [['x1','Point 1 coordinate (µm)'],['y1','Point 1 elapsed time (s)'],['x2','Point 2 coordinate (µm)'],['y2','Point 2 elapsed time (s)'],['targetSec','Target time on the same clock (s)']]],
      ['proposedDd', 'E64 / E65 / E80 starting table', [['model','Grinder model',['e64','e65','e80']],['roast','Roast',['light','medium','dark']],['dose','Dose (g)']]],
      ['manual', 'Manual DF54 / DF64 guidance', [['profile','Physical grinder',['df54','df64_gen1','df64_gen2']],['targetTimeSec','Target time (s)'],['actualTimeSec','Measured time on the same clock (s)'],['currentDial','Current native dial'],['stepMarks','Owner-confirmed step (marks)'],['numericFinerDelta','Numeric finer direction',['','-1','1']],['flavor','Adjustment intent',['','balanced','too sour','too bitter','too astringent','weak','channeling']]]],
    ];
    const state = {};
    groups.forEach(([id, title, fields]) => { const details = el('details'), summary = el('summary', title); details.appendChild(summary); const enableLabel = el('label', 'Include this calculator'), enabled = el('input', null, {type: 'checkbox', id: prefix + '-' + id + '-enabled'}); enableLabel.appendChild(enabled); details.appendChild(enableLabel); const inputs = {}; const fieldset = el('fieldset'); fieldset.disabled = true;
      fields.forEach(([key, label, options]) => { const wrapper = el('label', label), input = options ? el('select') : el('input', null, {type: 'number', step: 'any'}); input.id = prefix + '-' + id + '-' + key; if (options) options.forEach(value => input.appendChild(el('option', value || 'Unknown / direction only', {value}))); inputs[key] = input; wrapper.appendChild(input); fieldset.appendChild(wrapper); });
      enabled.addEventListener('change', () => { fieldset.disabled = !enabled.checked; }); details.appendChild(fieldset); details.appendChild(el('p', id === 'proposedDd' ? 'Recovered table output unit is unknown. It is not a native dial or micrometre conversion.' : 'Leave this calculator disabled when measurements or calibration are unavailable. Its state is independent of every other row.')); holder.appendChild(details); state[id] = {enabled, inputs};
    });
    return { state, cases() { const cases = {}; Object.entries(state).forEach(([id, group]) => { if (!group.enabled.checked) return; const input = {}; Object.entries(group.inputs).forEach(([key, node]) => { input[key] = node.tagName === 'SELECT' ? node.value : node.value.trim() === '' ? null : Number(node.value); });
      if (id === 'inverseRegression') cases[id] = {points: [{x: input.x1, y: input.y1}, {x: input.x2, y: input.y2}], targetSec: input.targetSec};
      else if (id === 'effectiveDd') { const residue = input.residue; delete input.residue; cases[id] = {state: {residue}, input}; }
      else if (id === 'proposedDd') { input.weightMg = input.dose == null ? null : input.dose * 1000; delete input.dose; cases[id] = {input}; }
      else { if (id === 'grindTime') input.mode = Number(input.mode); if (id === 'manual') { if (!input.numericFinerDelta) delete input.numericFinerDelta; else input.numericFinerDelta = Number(input.numericFinerDelta); if (!input.flavor) delete input.flavor; } cases[id] = {input}; }
    }); return cases; } };
  }
  function renderComparisons(holder, body) {
    clear(holder); (body.results || []).forEach(row => { const article = el('article'), title = el('h3', row.algorithm + ' · ' + row.status); article.appendChild(title); if (row.status !== 'computed') article.appendChild(el('p', row.reason || 'Supply this calculator’s independent measurements below.')); else { const value = row.result; let description;
      if (typeof value === 'number') description = value + ' µm (inverse regression)';
      else if (value.returnedDdDum != null) description = 'Returned ' + value.returnedDdDum + ' dD; candidate ' + (value.candidateDdDum ?? 'none') + '; ' + (value.status || 'replay result');
      else if (value.adjustedTimeMs !== undefined) description = value.adjustedTimeMs == null ? 'This mode does not adjust grind time.' : value.adjustedTimeMs + ' ms predicted grind time';
      else if (value.proposedDd !== undefined) description = value.proposedDd + ' research table coordinate (unit unknown)';
      else if (value.result !== undefined) description = value.result + ' dD effective coordinate';
      else description = (value.direction || 'hold') + ' · ' + (value.reasons || []).join(' ');
      article.appendChild(el('p', description)); const details = el('details'), summary = el('summary', 'Inputs, state and calculation details'); details.appendChild(summary); details.appendChild(el('pre', JSON.stringify(row, null, 2))); article.appendChild(details); } holder.appendChild(article); });
  }
  return {renderTrace, profilePicker, supplementalInputs, renderComparisons};
}

/* GENERATED RESEARCH SHARING START */
/* SPDX-License-Identifier: GPL-3.0-or-later */
// This factory has no imports: embed the same function in the browser/plugin bundle.
function createResearchSharing() {
  "use strict";
  const VERSION = 1, POLICY = 1, MAX_LOCAL = 200, MAX_QUEUE = 100, MAX_BATCH = 25;
  const enums = {
    source: ["website", "plugin"], mode: ["measured", "manual", "practice", "replay"],
    kind: ["shot", "feedback", "advice", "setting_change", "flow_summary"],
    model: ["E64 WS", "E65S GbW", "E80S GbW", "DF54", "DF64 Gen 1", "DF64 Gen 2", "Niche Zero", "Baratza Encore ESP", "Timemore Sculptor 064S", "Timemore Sculptor 078S", "LAGOM 01", "LAGOM P64", "1Zpresso X-Pro", "1Zpresso J-Max", "1Zpresso K series", "Fellow Ode Gen 2", "EK43", "other", "unknown"],
    unit: ["micrometres", "dial-marks", "deci-micrometre", "clicks", "total-clicks", "numbered-settings", "micro-ticks", "printed-decimal", "dial-positions", "µm", "µm (DDD readout only)", "dial marks", "numbered settings", "dial micro-ticks", "clicks from zero", "dial positions", "unknown"],
    control: ["pressure", "mixed_preinfusion_flow", "flow", "mixed_dynamic_flow", "flow_preinfusion_only", "unknown"],
    clock: ["pump", "pouring", "recording", "unknown"],
    taste: ["balanced", "too_sour", "too_bitter", "too_astringent", "weak", "uneven_flow", "unknown"],
    overall: ["under-extracted", "over-extracted", "balanced", "uncertain"],
    direction: ["finer", "coarser", "none"],
    status: ["suggestion", "abstain", "retained", "hold", "collecting", "computed", "invalid", "unavailable"],
    algorithm: ["manual", "native-response", "rich", "GbS1", "GbS2", "GbS3", "GbS4", "DdEff", "effectiveDd", "grindTime", "inverseRegression", "proposedDd"],
  };
  const object = value => value != null && typeof value === "object" && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const canonicalUnit = value => ["decimal dial numbers", "printed numbers"].includes(value) ? "printed-decimal" : value;
  const choice = (out, key, value, choices) => { if (choices.includes(value)) out[key] = value; };
  const numeric = (out, key, value, min, max) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max)
      out[key] = Math.round(value * 1000) / 1000;
  };
  const flag = (out, key, value) => { if (typeof value === "boolean") out[key] = value; };
  const validId = value => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
  function randomId() {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
      return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    }
    // Record keys are not secrets or authentication tokens. No personal input is used.
    return Array.from({ length: 4 }, () => Math.floor(Math.random() * 4294967296).toString(16).padStart(8, "0")).join("");
  }
  function sanitizeRecord(input) {
    if (!object(input)) throw new Error("Research record must be an object");
    const record = { schemaVersion: VERSION };
    for (const key of ["source", "mode", "kind"]) {
      if (!enums[key].includes(input[key])) throw new Error("Invalid research " + key);
      record[key] = input[key];
    }
    if (validId(input.observationId) && Number.isSafeInteger(input.revision) && input.revision > 0) {
      record.observationId = input.observationId; record.revision = input.revision;
    }
    if (validId(input.researchSeries)) record.researchSeries = input.researchSeries;
    if (record.researchSeries && Number.isInteger(input.shotOrdinal) && input.shotOrdinal >= 1 && input.shotOrdinal <= 10000) record.shotOrdinal = input.shotOrdinal;
    function part(key, build) {
      if (!object(input[key])) return;
      const out = {}; build(out, input[key]);
      if (Object.keys(out).length) record[key] = out;
    }
    part("grinder", (out, value) => {
      choice(out, "model", value.model, enums.model);
      choice(out, "settingUnit", canonicalUnit(value.settingUnit), enums.unit);
      numeric(out, "setting", value.setting, 0, 100000);
      numeric(out, "step", value.step, 0, 10000);
      choice(out, "finerSign", value.finerSign, [-1, 1]);
      numeric(out, "rpm", value.rpm, 0, 10000);
      numeric(out, "burrDiameterMm", value.burrDiameterMm, 20, 150);
      choice(out, "burrGeometry", value.burrGeometry, ["flat", "conical", "other", "unknown"]);
      flag(out, "ownerConfirmed", value.ownerConfirmed);
      // A number without its coordinate system is not useful research evidence.
      if (!out.settingUnit || out.settingUnit === "unknown") { delete out.setting; delete out.step; }
    });
    part("recipe", (out, value) => {
      choice(out, "controlMode", value.controlMode, enums.control);
      choice(out, "targetClock", value.targetClock, enums.clock);
      choice(out, "profileFamily", value.profileFamily, ["traditional", "flow", "bloom", "turbo", "allonge", "adaptive", "unknown"]);
      choice(out, "preinfusionSource", value.preinfusionSource, ["recorded", "owner_entered", "programmed", "synthetic", "unknown"]);
      numeric(out, "targetTimeSec", value.targetTimeSec, 0.001, 600);
      numeric(out, "targetDoseG", value.targetDoseG, 0.001, 100);
      numeric(out, "targetYieldG", value.targetYieldG, 0.001, 300);
      numeric(out, "targetTemperatureC", value.targetTemperatureC, 0, 150);
      numeric(out, "targetPressureBar", value.targetPressureBar, 0, 15);
      numeric(out, "targetMachineFlowMlPerSec", value.targetMachineFlowMlPerSec, 0, 30);
    });
    part("measurements", (out, value) => {
      for (const key of ["pumpTimeSec", "pouringTimeSec", "recordingTimeSec", "preinfusionSec"])
        numeric(out, key, value[key], 0, 600);
      for (const key of ["pumpComplete", "pouringComplete", "manualStopConfirmed", "interrupted"])
        flag(out, key, value[key]);
      numeric(out, "doseG", value.doseG, 0.001, 100);
      numeric(out, "yieldG", value.yieldG, 0, 300);
      numeric(out, "meanPressureBar", value.meanPressureBar, 0, 15);
      numeric(out, "meanMachineFlowMlPerSec", value.meanMachineFlowMlPerSec, 0, 30);
      numeric(out, "meanBeverageFlowGPerSec", value.meanBeverageFlowGPerSec, 0, 30);
      numeric(out, "meanMixTemperatureC", value.meanMixTemperatureC, 0, 150);
      numeric(out, "meanGroupTemperatureC", value.meanGroupTemperatureC, 0, 150);
      numeric(out, "flowCoverageSec", value.flowCoverageSec, 0, 600);
      numeric(out, "excludedSampleCount", value.excludedSampleCount, 0, 20000);
    });
    part("coffee", (out, value) => {
      choice(out, "species", value.species, ["arabica", "robusta", "blend", "other", "unknown"]);
      choice(out, "roast", value.roast, ["light", "medium", "dark", "unknown"]);
      choice(out, "process", value.process, ["washed", "natural", "honey", "anaerobic", "other", "unknown"]);
      flag(out, "decaf", value.decaf);
      numeric(out, "daysAfterRoast", value.daysAfterRoast, 0, 365);
    });
    part("taste", (out, value) => {
      flag(out, "good", value.good);
      choice(out, "intent", value.intent, enums.taste);
      choice(out, "overall", value.overall, enums.overall);
      for (const key of ["acidity", "bitterness", "sweetness", "body", "astringency"])
        numeric(out, key, value[key], 0, 5);
      numeric(out, "tastingTemperatureC", value.tastingTemperatureC, 0, 150);
      numeric(out, "minutesAfterBrew", value.minutesAfterBrew, 0, 10080);
    });
    const advice = (out, value) => {
      choice(out, "algorithm", value.algorithm, enums.algorithm);
      choice(out, "coordinateStatus", value.coordinateStatus, ["native", "measured", "estimated_relative", "estimated_absolute", "unknown"]);
      choice(out, "direction", value.direction, enums.direction);
      choice(out, "status", value.status, enums.status);
      choice(out, "settingUnit", canonicalUnit(value.settingUnit), enums.unit);
      numeric(out, "proposedSetting", value.proposedSetting, 0, 100000);
      numeric(out, "evidenceCount", value.evidenceCount, 0, 250);
      if (!out.settingUnit || out.settingUnit === "unknown") delete out.proposedSetting;
    };
    part("advice", advice);
    if (Array.isArray(input.approaches)) {
      const approaches = input.approaches.slice(0, 11).filter(object).map(value => { const out = {}; advice(out, value); return out; }).filter(value => value.algorithm);
      if (approaches.length) record.approaches = approaches;
    }
    if (Array.isArray(input.phases)) {
      const phases = input.phases.slice(0, 12).filter(object).map(value => {
        const out = {};
        choice(out, "role", value.role, ["preinfusion", "extraction", "decline", "bloom", "outside_pump", "unknown"]);
        choice(out, "source", value.source, ["recorded_frame", "recorded_substate", "recorded_annotation", "owner_entered", "programmed_target", "synthetic", "unknown"]);
        choice(out, "control", value.control, ["pressure", "flow", "unknown"]);
        for (const key of ["startSec", "endSec", "durationSec", "coverageSec"]) numeric(out, key, value[key], 0, 600);
        for (const key of ["meanPressureBar", "targetPressureBar"]) numeric(out, key, value[key], 0, 15);
        for (const key of ["meanMachineFlowMlPerSec", "targetMachineFlowMlPerSec", "meanBeverageFlowGPerSec"]) numeric(out, key, value[key], 0, 30);
        numeric(out, "meanTemperatureC", value.meanTemperatureC, 0, 150);
        return out;
      }).filter(value => Object.keys(value).length);
      if (phases.length) record.phases = phases;
    }
    if (!Object.keys(record).some(key => ["grinder", "recipe", "measurements", "coffee", "taste", "advice", "approaches", "phases"].includes(key))) throw new Error("No research measurements or categories supplied");
    return record;
  }
  function canonical(value) {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (object(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
    return JSON.stringify(value);
  }
  function validateRecord(value) {
    const record = sanitizeRecord(value);
    if (canonical(value) !== canonical(record)) throw new Error("Unknown, invalid or excessive-precision research fields");
    return record;
  }
  function validateBatch(value) {
    if (!object(value) || Object.keys(value).some(key => !["schemaVersion", "policyVersion", "records"].includes(key)) ||
        value.schemaVersion !== VERSION || value.policyVersion !== POLICY || !Array.isArray(value.records) ||
        !value.records.length || value.records.length > MAX_BATCH) throw new Error("Invalid research batch");
    return { schemaVersion: VERSION, policyVersion: POLICY, records: value.records.map(record => { const clean = validateRecord(record); if (!validId(clean.observationId) || !clean.revision) throw new Error("Observation identity required for upload"); return clean; }) };
  }
  function endpoint(value) {
    // URL and AbortController are optional runtime adapters; the factory is QuickJS-safe.
    if (typeof value !== "string" || value.length > 2048 || !/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?(?:\/[a-z0-9._~!$&'()*+,;=:@%/-]*)?$/i.test(value))
      throw new Error("Research endpoint must be HTTPS without credentials, query or fragment");
    const authority = value.slice(8).split("/")[0], host = authority.split(":")[0];
    if (!host || host.startsWith(".") || host.endsWith(".") || host.includes("..") || /%|@/.test(authority))
      throw new Error("Invalid research endpoint host");
    const port = authority.split(":")[1];
    if (port != null && (+port < 1 || +port > 65535)) throw new Error("Invalid research endpoint port");
    return value;
  }
  function observationContent(record) { const out = { ...record }; delete out.observationId; delete out.revision; return out; }
  // Non-security fingerprint used only for bounded local duplicate suppression.
  function fingerprint(value) {
    const text = canonical(value); let a = 2166136261, b = 5381;
    for (let n = 0; n < text.length; n++) { a = Math.imul(a ^ text.charCodeAt(n), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(n); }
    return text.length + ":" + (a >>> 0).toString(16) + ":" + (b >>> 0).toString(16);
  }
  function createClient(adapters) {
    if (!adapters || typeof adapters.load !== "function" || typeof adapters.save !== "function")
      throw new Error("Acknowledged local load/save adapters required");
    const fresh = () => ({ schemaVersion: VERSION, policyVersion: POLICY, localEnabled: true, sharing: false, endpoint: null,
      nextRevision: 0, records: [], queue: [], fingerprints: [] });
    const localKey = key => {
      if (typeof key !== "string" || !key.length || key.length > 256) throw new Error("Invalid local research key");
      return key;
    };
    const entry = value => {
      if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 1)
        throw new Error("Invalid local research entry");
      return { key: localKey(value.key), revision: value.revision, record: validateRecord(value.record) };
    };
    let state = fresh(), generation = 0, permitted = false, chain = Promise.resolve(), inflight = null, abort = null, storageError = null;
    const decode = value => {
      if (value == null) return;
      if (!object(value) || value.schemaVersion !== VERSION || value.policyVersion !== POLICY ||
          typeof value.sharing !== "boolean" || typeof value.localEnabled !== "boolean" || !Number.isSafeInteger(value.nextRevision) || value.nextRevision < 0 ||
          !Array.isArray(value.records) || value.records.length > MAX_LOCAL ||
          !Array.isArray(value.queue) || value.queue.length > MAX_QUEUE || !Array.isArray(value.fingerprints) || value.fingerprints.length > MAX_LOCAL) throw new Error("Invalid or outdated research storage");
      const records = value.records.map(entry), queue = value.queue.map(entry);
      for (const list of [records, queue]) {
        if (new Set(list.map(item => item.key)).size !== list.length || list.some(item => item.revision > value.nextRevision))
          throw new Error("Invalid local research revisions");
      }
      const fingerprints = value.fingerprints.map(item => {
        if (!object(item) || typeof item.fingerprint !== "string" || !/^\d+:[a-f0-9]+:[a-f0-9]+$/.test(item.fingerprint)) throw new Error("Invalid local research fingerprint");
        if (!validId(item.observationId) || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error("Invalid observation ledger");
        return { key: localKey(item.key), fingerprint: item.fingerprint, observationId: item.observationId, revision: item.revision };
      });
      return { schemaVersion: VERSION, policyVersion: POLICY, localEnabled: value.localEnabled, sharing: value.sharing,
        endpoint: value.endpoint == null ? null : endpoint(value.endpoint), nextRevision: value.nextRevision, records, queue, fingerprints };
    };
    const install = (value, initial = false) => {
      const decoded = decode(value) || fresh();
      state = decoded;
      permitted = state.sharing && (!initial || generation === 0);
      if (!permitted) { state.sharing = false; state.queue = []; state.fingerprints = []; }
    };
    const ready = Promise.resolve().then(() => adapters.load()).then(value => install(value, true)).catch(() => { state = fresh(); permitted = false; storageError = "Research storage could not be read; sharing is disabled"; });
    const refresh = async () => {
      if (typeof adapters.reload !== "function") return;
      try { install(await adapters.reload()); storageError = null; }
      catch (_) { permitted = false; state.sharing = false; state.queue = []; generation++; abort?.(); storageError = "Research storage could not be read; sharing is disabled"; throw new Error(storageError); }
    };
    const serial = operation => {
      const result = chain.then(() => ready).then(async () => {
        const run = async () => { await refresh(); return operation(); };
        return typeof adapters.withLock === "function" ? adapters.withLock(run) : run();
      });
      chain = result.catch(() => {}); return result;
    };
    async function save(next) {
      try { await adapters.save(clone(next)); state = next; storageError = null; }
      catch (_) { permitted = false; state.sharing = false; state.queue = []; generation++; abort?.(); storageError = "Research storage could not be saved; sharing is disabled"; throw new Error(storageError); }
    }
    const status = () => ({ localEnabled: state.localEnabled, sharing: permitted && state.sharing && !storageError, endpoint: state.endpoint,
      localCount: state.records.length, queuedCount: permitted ? state.queue.length : 0, error: storageError, policyVersion: POLICY });
    async function setSharing(enabled, target) {
      if (typeof enabled !== "boolean") throw new Error("Explicit sharing choice required");
      const targetEndpoint = enabled && target != null && target !== "" ? endpoint(target) : null;
      // Revoke immediately, before waiting for disk or an earlier network request.
      const requestGeneration = ++generation;
      permitted = false; abort?.();
      return serial(async () => {
        const current = requestGeneration === generation;
        await save({ ...state, sharing: current && enabled, endpoint: current ? targetEndpoint : null, queue: [], fingerprints: [] });
        permitted = current && requestGeneration === generation && enabled;
        return status();
      });
    }
    function capture(input, key) {
      const record = sanitizeRecord(observationContent(input));
      if (key != null) localKey(key);
      return serial(async () => {
        if (storageError) throw new Error(storageError);
        if (!state.localEnabled && !permitted) return { record: clone(record), ...status() };
        const digest = fingerprint(record);
        const known = key == null ? [] : state.records.filter(item => item.key === key).concat(state.queue.filter(item => item.key === key));
        const ledger = key == null ? null : state.fingerprints.find(item => item.key === key);
        // The archive can intentionally stop changing while transport state and
        // its fingerprint ledger continue to advance (for example when local
        // collection is switched off). Always carry identity/revision forward
        // from the newest known observation, rather than preferring the archive.
        const prior = known.reduce((latest, item) => !latest || item.record.revision > latest.record.revision ||
          item.record.revision === latest.record.revision && item.revision > latest.revision ? item : latest, null);
        const latestRevision = Math.max(prior?.record.revision || 0, ledger?.revision || 0);
        const latestObservationId = ledger && ledger.revision >= (prior?.record.revision || 0) ? ledger.observationId : prior?.record.observationId;
        if (prior && prior.record.revision === latestRevision && canonical(observationContent(prior.record)) === canonical(record) ||
          ledger && ledger.revision === latestRevision && ledger.fingerprint === digest)
          return { record: clone(record), ...status() };
        const revision = state.nextRevision + 1;
        if (!Number.isSafeInteger(revision)) throw new Error("Local research revision limit reached; export and clear");
        const observationId = latestObservationId || (typeof adapters.randomId === "function" ? adapters.randomId() : randomId());
        if (!validId(observationId)) throw new Error("Random observation key must contain 32 lowercase hexadecimal characters");
        const observationRevision = latestRevision + 1;
        const item = { key: key == null ? "entry:" + revision : key, revision, record: { ...record, observationId, revision: observationRevision } };
        const replace = list => list.filter(prior => prior.key !== item.key).concat([item]);
        let queue = state.queue;
        if (permitted && state.sharing && (queue.length < MAX_QUEUE || queue.some(prior => prior.key === item.key))) queue = replace(queue);
        const fingerprints = permitted ? state.fingerprints.filter(prior => prior.key !== item.key).concat([{ key: item.key, fingerprint: digest, observationId, revision: observationRevision }]).slice(-MAX_LOCAL) : [];
        await save({ ...state, fingerprints, records: state.localEnabled ? replace(state.records).slice(-MAX_LOCAL) : state.records, queue, nextRevision: revision });
        return { record: clone(record), ...status() };
      });
    }
    async function flush() {
      if (inflight) return inflight;
      const operation = async () => {
        const batch = await serial(() => {
          if (!permitted || !state.sharing || storageError || !state.queue.length || !state.endpoint) return null;
          if (typeof adapters.send !== "function") throw new Error("Research transport unavailable");
          const entries = [];
          for (const item of state.queue.slice(0, MAX_BATCH)) {
            if (JSON.stringify(entries.concat([item]).map(entry => entry.record)).length > 60000) break;
            entries.push(item);
          }
          return { generation, endpoint: state.endpoint, entries: clone(entries) };
        });
        if (!batch) return { sent: 0, ...status() };
        if (batch.generation !== generation || !permitted) return { sent: 0, ...status() };
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        abort = () => controller?.abort();
        try {
          const response = await adapters.send(batch.endpoint, { method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
            headers: { "Content-Type": "application/json" }, signal: controller?.signal,
            body: JSON.stringify({ schemaVersion: VERSION, policyVersion: POLICY, records: batch.entries.map(item => item.record) }) });
          if (!response || !response.ok || response.redirected) throw new Error("Research upload was not acknowledged");
          const receipt = await response.json();
          if (!receipt || receipt.accepted !== batch.entries.length) throw new Error("Invalid research upload acknowledgment");
          return await serial(async () => {
            if (batch.generation !== generation || !permitted) return { sent: 0, ...status() };
            const acknowledged = new Set(batch.entries.map(item => item.revision));
            await save({ ...state, queue: state.queue.filter(item => !acknowledged.has(item.revision)) });
            return { sent: batch.entries.length, ...status() };
          });
        } finally { abort = null; }
      };
      inflight = operation();
      try { return await inflight; } finally { inflight = null; }
    }
    function setLocalCollection(enabled) {
      if (typeof enabled !== "boolean") throw new Error("Explicit local collection choice required");
      return serial(async () => { await save({ ...state, localEnabled: enabled, fingerprints: enabled || permitted ? state.fingerprints : [] }); return status(); });
    }
    function clear() {
      generation++; permitted = false; abort?.();
      return serial(async () => { await save({ ...fresh(), localEnabled: state.localEnabled }); return status(); });
    }
    return { ready: ready.then(status), status: () => serial(status), capture, append: input => capture(input), setSharing, setLocalCollection, flush, clear,
      exportLocal: () => serial(() => ({ schemaVersion: VERSION, policyVersion: POLICY, records: state.records.map(item => clone(item.record)) })) };
  }
  return { schemaVersion: VERSION, policyVersion: POLICY, limits: { local: MAX_LOCAL, queue: MAX_QUEUE, batch: MAX_BATCH },
    sanitizeRecord, validateRecord, validateBatch, validateEndpoint: endpoint, randomId, createClient };
}
/* GENERATED RESEARCH SHARING END */

/* GENERATED GRINDER MECHANICS START */
function createGrinderMechanicsCatalog() { return {"catalogSha256":"56abad4877cbcac655d7a87493e4b77653939a4f643b19724d197f8daba2345b","models":[{"absoluteGapFromPrintedZero":null,"burrGeometry":"flat","candidates":[],"contactZero":"Manufacturer disc-distance calibration; an indicated value is not independently measured physical gap.","id":"e64ws","leadUmPerRevolution":null,"mechanism":"Motorized disc-distance adjustment with encoder/AGS diagnostics.","model":"E64 WS","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Displayed distance coordinate is linear in micrometres; mechanical lead/gearing unpublished.","relativeMovement":{"coordinateUnit":"displayed micrometre","derivation":null,"quantity":"indicated disc distance","status":"manufacturer-stated","umPerUnit":1,"validatesParticleSize":false,"validatesShotResponse":false},"sourceIds":["e64manual","e64software"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"Readout semantics established; physical positioning accuracy, backlash and transmission unknown."}},{"absoluteGapFromPrintedZero":null,"burrGeometry":"flat","candidates":[{"conditions":["80 equal intervals rather than80marks","brochure endpoint range matches scale endpoints"],"math":"(600−180)/80","status":"conditional-endpoint-arithmetic","unit":"µm per indicative scale interval","usableAsDefault":false,"value":5.25}],"contactZero":"DDD calibration required; distinguish lever scale from distance readout.","id":"e65sgbw","leadUmPerRevolution":null,"mechanism":"Manual lever/ring; DDD reports relative disc separation.","model":"E65S GbW","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Fine thread suggests nominally linear angular travel; full-turn lead unknown.","relativeMovement":{"coordinateUnit":"DDD displayed micrometre","derivation":null,"quantity":"indicated disc distance","status":"manufacturer-stated","umPerUnit":1,"validatesParticleSize":false,"validatesShotResponse":false},"sourceIds":["e65brochure"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"No traceable tolerance/measurement-error budget supplied; do not invent a confidence interval."}},{"absoluteGapFromPrintedZero":null,"burrGeometry":"flat","candidates":[{"conditions":["E80S specification is NOT verified for E80S GbW","100equal intervals unverified"],"math":"E80S brochure:(450−150)/100","status":"different-model-only","unit":"µm per indicative scale interval","usableAsDefault":false,"value":3}],"contactZero":"Manufacturer DDD and zero calibration after service/burr replacement.","id":"e80sgbw","leadUmPerRevolution":null,"mechanism":"Manual adjustment lever/ring and DDD; do not substitute motorized E80W architecture.","model":"E80S GbW","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"DDD distance coordinate linear; lever travel law and pitch not verified.","relativeMovement":{"coordinateUnit":"DDD displayed micrometre","derivation":null,"quantity":"indicated disc distance","status":"manufacturer-stated","umPerUnit":1,"validatesParticleSize":false,"validatesShotResponse":false},"sourceIds":["e80manual","e80brochure"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"No traceable tolerance/measurement-error budget supplied; do not invent a confidence interval."}},{"absoluteGapFromPrintedZero":null,"burrGeometry":"flat","candidates":[{"conditions":["Owner must verify120equivalent evenly spaced notches per fullturn","120notches not independently qualified here"],"math":"10.4×120","status":"conditional-dial-count","unit":"µm per revolution","usableAsDefault":false,"value":1248}],"contactZero":"Movable sticker/pointer and replacement burr thickness change reference; first chirp is not full parallel contact.","exploratoryScenario":{"absoluteOffsetUm":null,"centralUmPerUnit":10.4,"coordinateUnit":"original dial notch","intervalMeaning":"Analyst-selected sensitivity envelope; not a statistical confidence interval or manufacturer tolerance. Values outside it remain possible.","promotesToCalibration":false,"rationale":"Centered on single-owner10.4µm report; deliberately broad rounded sensitivity envelope, not a measurement error estimate.","requiresExplicitAssumptionAcceptance":true,"sensitivityIntervalUmPerUnit":[8,13],"sourceIds":["dfmanual","dfcollar","hbmeasured"],"status":"explicit-modeling-assumption"},"id":"df64gen1","leadUmPerRevolution":null,"mechanism":"Threaded top collar acting on spring-supported upper burr carrier.","model":"DF64 Gen1","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Nominal constant lead implies linear unloaded axial travel; real carrier tilt/backlash and spring seating are not measured.","relativeMovement":{"coordinateUnit":"original dial notch","derivation":null,"quantity":"reported burr-spacing change","status":"firsthand-measured-approximate","umPerUnit":10.4,"validatesParticleSize":false,"validatesShotResponse":false},"sourceIds":["dfmanual","dfcollar","hbmeasured"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"One owner measurement, unknown instrument/revision/error; not a factory specification or universal Gen1 tolerance."}},{"absoluteGapFromPrintedZero":null,"burrGeometry":"flat","candidates":[{"conditions":["Assume Gen1 transmission and dial angular spacing unchanged; not verified"],"status":"cross-generation-assumption-only","unit":"µm per original dial notch","usableAsDefault":false,"value":10.4}],"contactZero":"User/burr/revision-specific zero; pointer position is a reference.","exploratoryScenario":{"absoluteOffsetUm":null,"centralUmPerUnit":10.4,"coordinateUnit":"original dial notch","intervalMeaning":"Analyst-selected sensitivity envelope; not a statistical confidence interval or manufacturer tolerance. Values outside it remain possible.","promotesToCalibration":false,"rationale":"Cross-generation assumption: Gen1-like carrier travel and angular dial spacing; no direct Gen2 physical measurement.","requiresExplicitAssumptionAcceptance":true,"sensitivityIntervalUmPerUnit":[8,13],"sourceIds":["dfmanual","dfcollar"],"status":"explicit-modeling-assumption"},"id":"df64gen2","leadUmPerRevolution":null,"mechanism":"Threaded top collar and spring-supported upper carrier.","model":"DF64 Gen2","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Ideal screw travel linear; generation-specific lead unverified.","relativeMovement":null,"sourceIds":["dfmanual","dfcollar"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"No traceable tolerance/measurement-error budget supplied; do not invent a confidence interval."},"unknownReason":"No model-qualified primary dimensioned thread drawing or firsthand pitch measurement located. DF64V8.3µm must not be transferred."},{"absoluteGapFromPrintedZero":null,"burrGeometry":"flat","candidates":[{"conditions":["Assumes transcript accurate","Assumes single-start thread/direct1:1collar travel","Original recording measurement has not been verified"],"equivalentMarksPerRevolution":120,"math":"1000×1/120=8.333…; half-mark≈4.17µm","status":"unverified-original-video-transcript","threadPitchMm":1,"unit":"µm per dial mark","usableAsDefault":false,"value":8.333333333333334}],"contactZero":"Burr installation/alignment and dial pointer reference affect contact zero.","exploratoryScenario":{"absoluteOffsetUm":null,"centralUmPerUnit":8.333333333333334,"coordinateUnit":"original dial mark","intervalMeaning":"Analyst-selected sensitivity envelope; not a statistical confidence interval or manufacturer tolerance. Values outside it remain possible.","promotesToCalibration":false,"rationale":"Centered on unverified transcript1mm/120marks claim; broadened to explore source/revision uncertainty, not a measured interval.","requiresExplicitAssumptionAcceptance":true,"sensitivityIntervalUmPerUnit":[6,11],"sourceIds":["df54product","dfcollar","df54video","df54original"],"status":"explicit-modeling-assumption"},"id":"df54","leadUmPerRevolution":null,"mechanism":"Threaded top collar, wave-spring-supported upper carrier.","model":"DF54","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Expected constant-lead axial travel; numeric pitch currently candidate only.","relativeMovement":null,"sourceIds":["df54product","dfcollar","df54video","df54original"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"No traceable tolerance/measurement-error budget supplied; do not invent a confidence interval."},"unknownReason":"No dimensioned manufacturer thread drawing located; smart transcript is a research lead rather than confirmed metrology."},{"absoluteGapFromPrintedZero":null,"burrGeometry":"conical","candidates":[],"contactZero":"Follow manufacturer calibration after disassembly; ring zero is not a particle-size origin.","id":"nichezero","leadUmPerRevolution":null,"mechanism":"Rotating adjustment ring changes burr relationship.","model":"Niche Zero","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Likely constant-lead axial motion, but pitch and local conical separation mapping unknown.","relativeMovement":null,"sourceIds":["nichecal","nichepatent"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"No traceable tolerance/measurement-error budget supplied; do not invent a confidence interval."},"unknownReason":"Reviewed patent/guide do not provide model-qualified numeric lead; Niche Duo and Gevi figures excluded."},{"absoluteGapFromPrintedZero":null,"burrGeometry":"conical","candidates":[],"contactZero":"Shim stack shifts zero/range; does not justify global response or particle-size calibration.","id":"encoreesp","leadUmPerRevolution":null,"mechanism":"Dual-range stepped adjustment.","model":"Encore ESP","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Piecewise increments: espresso and filter regions differ. No single global micrometre-per-click slope.","relativeMovement":{"boundary20To21Um":null,"quantity":"reported vertical burr movement","segments":[{"settings":[1,20],"umPerClick":20},{"settings":[21,40],"umPerClick":90}],"status":"manufacturer-representative-interview","validatesParticleSize":false,"validatesShotResponse":false},"sourceIds":["espmanual","espinterview"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"Named model and vertical domain in firsthand interview; representative unnamed and exact transition interval unspecified. No thread lead or positional tolerance published."}},{"absoluteGapFromPrintedZero":null,"burrGeometry":"flat","candidates":[{"conditions":["Side groove is NOT printed minor line","Verify dial revision and groove count before mapping"],"sourceId":"hbcorrected","status":"owner-report-without-method","unit":"µm per side groove","usableAsDefault":false,"value":3}],"contactZero":"Calibration pointer/pin and burr swap shift reference; chirp-to-lock is not an independent pitch measurement.","id":"sculptor064s","leadUmPerRevolution":null,"mechanism":"Stepless dial and threaded burr adjustment.","model":"Timemore Sculptor064S","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Nominally linear axial screw motion; production/prototype variants and dial groove meanings require verification.","relativeMovement":null,"sourceIds":["timemorefaq","timemoremanuals","hbcorrected"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"No traceable tolerance/measurement-error budget supplied; do not invent a confidence interval."},"unknownReason":"No independently qualified numeric pitch for this exact production model; early5µm-line claims corrected by later observer."},{"absoluteGapFromPrintedZero":null,"burrGeometry":"flat","candidates":[{"conditions":["Side groove is NOT printed minor line","Verify dial revision and groove count before mapping"],"sourceId":"hbcorrected","status":"owner-report-without-method","unit":"µm per side groove","usableAsDefault":false,"value":3}],"contactZero":"Calibration pointer/pin and burr swap shift reference; chirp-to-lock is not an independent pitch measurement.","exploratoryScenario":{"absoluteOffsetUm":null,"centralUmPerUnit":30,"coordinateUnit":"whole printed dial number","intervalMeaning":"Analyst-selected sensitivity envelope; not a statistical confidence interval or manufacturer tolerance. Values outside it remain possible.","promotesToCalibration":false,"rationale":"Centered on firsthand approximate30µm report; illustrative20percent sensitivity choice, not a measured tolerance.","requiresExplicitAssumptionAcceptance":true,"sensitivityIntervalUmPerUnit":[24,36],"sourceIds":["timemorefaq","timemoremanuals","hbcorrected","hbmeasured"],"status":"explicit-modeling-assumption"},"id":"sculptor078s","leadUmPerRevolution":{"sourceId":"hbmeasured","status":"firsthand-reported-thread-pitch-assuming-single-start","value":600},"mechanism":"Stepless dial and threaded burr adjustment.","model":"Timemore Sculptor078S","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Nominally linear axial screw motion; production/prototype variants and dial groove meanings require verification.","relativeMovement":{"coordinateUnit":"whole printed dial number","derivation":null,"quantity":"reported burr-spacing change","status":"firsthand-measured-approximate","umPerUnit":30,"validatesParticleSize":false,"validatesShotResponse":false},"sourceIds":["timemorefaq","timemoremanuals","hbcorrected","hbmeasured"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"Owner reports roughly0.6mm pitch and30µm/number; no instrument/error budget or manufacturing revision supplied."}},{"absoluteGapFromPrintedZero":null,"burrGeometry":"flat","candidates":[{"conditions":["Requires verified100minor intervals/fullturn; do not infer from visible dial arc alone"],"math":"7.5×100","status":"conditional-dial-count","unit":"µm per revolution","usableAsDefault":false,"value":750.0}],"contactZero":"Factory zero and burr-touch reference vary; service/burr replacement procedure depends on revision.","id":"lagom01","leadUmPerRevolution":null,"mechanism":"Stepless dial with published vertical travel per engraved line.","model":"LAGOM01","perWholePrintedNumberUm":75.0,"photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Manufacturer per-line vertical mapping is nominally linear.","relativeMovement":{"coordinateUnit":"0.1 printed dial number (one minor line)","derivation":null,"quantity":"vertical burr movement","status":"manufacturer-stated","umPerUnit":7.5,"validatesParticleSize":false,"validatesShotResponse":false},"sourceIds":["lagom01","lagom01faq"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"No traceable tolerance/measurement-error budget supplied; do not invent a confidence interval."}},{"absoluteGapFromPrintedZero":null,"burrGeometry":"flat","candidates":[{"conditions":["Requires verified100minor intervals/fullturn; do not infer from visible dial arc alone"],"math":"10×100","status":"conditional-dial-count","unit":"µm per revolution","usableAsDefault":false,"value":1000}],"contactZero":"Factory zero and burr-touch reference vary; service/burr replacement procedure depends on revision.","id":"lagomp64","leadUmPerRevolution":null,"mechanism":"Stepless dial with published vertical travel per engraved line.","model":"LAGOM P64","perWholePrintedNumberUm":100,"photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Manufacturer per-line vertical mapping is nominally linear.","relativeMovement":{"coordinateUnit":"0.1 printed dial number (one minor line)","derivation":null,"quantity":"vertical burr movement","status":"manufacturer-stated","umPerUnit":10,"validatesParticleSize":false,"validatesShotResponse":false},"sourceIds":["p64","p64guide"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"No traceable tolerance/measurement-error budget supplied; do not invent a confidence interval."}},{"absoluteGapFromPrintedZero":null,"burrGeometry":"conical","candidates":[],"clicksPerRevolution":60,"contactZero":"Use model-specific zero/calibration procedure; do not force burr lock.","id":"xpro","leadUmPerRevolution":{"math":"12.5×60","status":"derived-from-rounded-click-specification","value":750.0},"mechanism":"External stepped adjustment ring.","model":"1Zpresso X-Pro","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Nominal equal axial movement per click; conical normal gap and particle size do not equal axial movement.","relativeMovement":{"coordinateUnit":"click","derivation":null,"quantity":"manufacturer-described burr movement","status":"manufacturer-stated-nominal","umPerUnit":12.5,"validatesParticleSize":false,"validatesShotResponse":false},"sourceIds":["xpro"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"Published nominal movement, no metrology tolerance; thread-start count not supplied. Does not identify conical surface-normal clearance."}},{"absoluteGapFromPrintedZero":null,"burrGeometry":"conical","candidates":[],"clicksPerRevolution":90,"contactZero":"Use model-specific zero/calibration procedure; do not force burr lock.","id":"jmax","leadUmPerRevolution":{"math":"0.8mm×1000;90×8.8=792 reflects rounded perclick value","status":"manufacturer-stated","value":800},"mechanism":"External stepped adjustment ring.","model":"1Zpresso J-Max","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Nominal equal axial movement per click; conical normal gap and particle size do not equal axial movement.","relativeMovement":{"coordinateUnit":"click","derivation":null,"quantity":"manufacturer-described burr movement","status":"manufacturer-stated-nominal","umPerUnit":8.8,"validatesParticleSize":false,"validatesShotResponse":false},"sourceIds":["jmax","jmaxzh"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"Published nominal movement, no metrology tolerance; thread-start count not supplied. Does not identify conical surface-normal clearance."}},{"absoluteGapFromPrintedZero":null,"burrGeometry":"conical","candidates":[],"clicksPerRevolution":90,"contactZero":"Use model-specific zero/calibration procedure; do not force burr lock.","id":"kseries","leadUmPerRevolution":{"math":"22×90","status":"derived-from-rounded-click-specification","value":1980},"mechanism":"External stepped adjustment ring.","model":"1Zpresso K-Pro/K-Max/K-Plus","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Nominal equal axial movement per click; conical normal gap and particle size do not equal axial movement.","relativeMovement":{"coordinateUnit":"click","derivation":null,"quantity":"manufacturer-described burr movement","status":"manufacturer-stated-nominal","umPerUnit":22,"validatesParticleSize":false,"validatesShotResponse":false},"sourceIds":["kseries","kmanual"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"Published nominal movement, no metrology tolerance; thread-start count not supplied. Does not identify conical surface-normal clearance."}},{"absoluteGapFromPrintedZero":null,"burrGeometry":"flat","candidates":[],"contactZero":"Manufacturer backoff differs for stockGen2 andSSP burrs.","espressoSupported":false,"id":"odegen2","leadUmPerRevolution":null,"mechanism":"Stepped numbered adjustment knob;31positions across11numbers.","model":"Fellow Ode Gen2","photoPolicy":"Link source only; no licensed reusable drawing/photo verified.","progression":"Equal-looking numbers/clicks do not establish displacement or a full360-degree range.","relativeMovement":null,"sourceIds":["ode","odecal","odeespresso"],"threadPitchMm":null,"threadStarts":null,"uncertainty":{"numericInterval":null,"reason":"No traceable tolerance/measurement-error budget supplied; do not invent a confidence interval."},"unknownReason":"No primary numeric lead/displacement specification located; espresso unsupported by manufacturer."}],"purpose":"Research evidence, not calibrated grinder parameters or automatic production defaults","quantityRules":["lead=thread pitch×number of starts; movement per revolution is not automatically thread pitch","delta axial travel=lead×input revolutions×transmission ratio","No particle-size, brew-time-response or absolute-gap calibration follows from nominal mechanical movement","null means unverified; candidate estimates must stay separate from established relativeMovement","No numeric uncertainty interval was fabricated; stated approximate values are not statistical confidence intervals"],"reviewedAt":"2026-10-12","schemaVersion":1,"sources":{"df54original":{"kind":"original-video-link","reviewedAt":"2026-10-12","scope":"2024-03-20; full video not accessible for independent measurement verification","title":"Original DF54 review video, same author","url":"https://www.bilibili.com/video/BV1HH4y1p7vj/"},"df54product":{"kind":"vendor-product","reviewedAt":"2026-10-12","scope":"Upper carrier and wave spring; successive product revisions","title":"MiiCoffee DF54","url":"https://miicoffee.shop/products/miicoffee-df54-single-dose-coffee-grinder"},"df54video":{"kind":"unverified-video-transcript","reviewedAt":"2026-10-12","scope":"2024-03-21 smart text claims1mm pitch and120 equivalent marks/rev; original audio not verified","title":"DF54 mechanical review by 资深硬核自家咖啡","url":"https://www.douyin.com/video/7348713697268862258?source=Googlebot-sdc"},"dfcollar":{"kind":"vendor-parts","reviewedAt":"2026-10-12","scope":"Separate DF54/DF64 collars; no dimensioned thread specification","title":"DF replacement collar photographs","url":"https://dfgrinders.ca/products/collar"},"dfmanual":{"kind":"vendor-manual","reviewedAt":"2026-10-12","scope":"Threaded top collar, clockwise finer; SSP thickness changes zero","title":"DF64 user manual","url":"https://support.clivecoffee.com/en/articles/16426035-df64-single-dose-user-manual"},"e64manual":{"kind":"manufacturer-manual","reviewedAt":"2026-10-12","scope":"pp12–13 and34: displayed disc distance and calibration","title":"E64 WS original instructions","url":"https://downloads.mahlkoenig.de/Service/Mahlkoenig_E64_WS_Espresso_Home_Original_instructions_EN.pdf"},"e64software":{"kind":"manufacturer-manual","reviewedAt":"2026-10-12","scope":"AGS motor/encoder diagnostic and recipe disc distance; no transmission lead","title":"E64 WS software manual","url":"https://downloads.mahlkoenig.de/Service/Mahlkoenig_E64_WS_Espresso_Home_Software_Manual.pdf"},"e65brochure":{"kind":"manufacturer-brochure","reviewedAt":"2026-10-12","scope":"03/2020 pp6,8: DDD,180–600µm range,80-step indicating scale","title":"E65S GbW brochure, manufacturer document on dealer host","url":"https://www.primulator.lt/media/repository/Mahlkonig/E65S_Gbw/Mahlkoenig_E65S_GbW_Brochure.pdf"},"e80brochure":{"kind":"manufacturer-brochure","reviewedAt":"2026-10-12","scope":"E80S, NOT exact E80S GbW:150–450µm,100-step scale,0.001mm indication","title":"E80S brochure","url":"https://downloads.mahlkoenig.de/Products/Mahlkoenig_E80S_Espresso_Grinder_Product_Brochure.pdf"},"e80manual":{"kind":"manufacturer-manual","reviewedAt":"2026-10-12","scope":"Lever adjustment, lock, zero adjustment and DDD calibration","title":"E80/F80 GbW original instructions","url":"https://downloads.mahlkoenig.de/Service/Mahlkoenig_E80_F80_GbW_Espresso_Grinder_Original_instruction_manual_EN.pdf"},"espinterview":{"kind":"manufacturer-representative-interview","reviewedAt":"2026-10-12","scope":"Company representative reports20µm vertical per fine step,90µm per coarse step; unnamed representative","title":"WIRED firsthand Encore ESP review and company interview","url":"https://www.wired.com/review/baratza-encore-esp-coffee-grinder/"},"espmanual":{"kind":"manufacturer-manual","reviewedAt":"2026-10-12","scope":"40 positions, fine1–20/coarse21–40; shim calibration","title":"Encore ESP instruction manual","url":"https://assets.breville.com/ZCG495/manual-encoreesp-v1-0-en-010923.pdf"},"hbcorrected":{"kind":"firsthand-owner-report","reviewedAt":"2026-10-12","scope":"2024-01:production changes; side grooves3µm064/064S/078S,5µm078; method not supplied","title":"Jonk correction to early Sculptor pitch assumptions","url":"https://www.home-barista.com/grinders/proposed-alternative-to-marker-test-for-burr-alignment-t91921-10.html"},"hbmeasured":{"kind":"firsthand-owner-measurement","reviewedAt":"2026-10-12","scope":"2023-09-30:078S~0.6mm thread pitch/~30µm per whole number; DF64v1~10.4µm/notch; DF64V~8.3µm/notch","title":"theaaaa firsthand adjustment measurements, post12","url":"https://www.home-barista.com/grinders/user-experience-with-timemore-sculptor-grinders-078-078s-t89609-10.html"},"jmax":{"kind":"manufacturer-manual","reviewedAt":"2026-10-12","scope":"90clicks/rev,8.8µm nominal/click","title":"J-Max manual","url":"https://1zpresso.coffee/manual-jmax-en/"},"jmaxzh":{"kind":"manufacturer-manual","reviewedAt":"2026-10-12","scope":"Page1 explicitly0.8mm burr rise/fall per turn;90divisions; nominal0.0088mm/click","title":"J-Max Chinese manual","url":"https://1zpresso.coffee/wp-content/uploads/2021/12/J-Max-%E8%AF%B4%E6%98%8E%E4%B9%A620211105.pdf"},"kmanual":{"kind":"manufacturer-manual","reviewedAt":"2026-10-12","scope":"Calibratable scale and higher-number coarser direction","title":"K-Series manual","url":"https://1zpresso.coffee/jp/manual-k-en/"},"kseries":{"kind":"manufacturer-specification","reviewedAt":"2026-10-12","scope":"90clicks/rev,22µm/click; excludesK-Ultra","title":"K-Pro/K-Max/K-Plus comparison","url":"https://1zpresso.coffee/k/"},"lagom01":{"kind":"manufacturer-specification","reviewedAt":"2026-10-12","scope":"Each0.1 line7.5µm vertical movement","title":"LAGOM01 specifications","url":"https://www.option-o.com/lagom-01"},"lagom01faq":{"kind":"manufacturer-faq","reviewedAt":"2026-10-12","scope":"Minor tick~7.5µm; factory burr touch below indicated zero; safety lock and burr-gap/particle-size distinction","title":"LAGOM01 WBrC FAQ","url":"https://www.option-o.com/wbrc-resource"},"nichecal":{"kind":"manufacturer-guide","reviewedAt":"2026-10-12","scope":"Recalibration reference after disassembly; no thread pitch","title":"Niche Zero calibration","url":"https://www.nichecoffee.co.uk/blogs/exploring-coffee/how-to-calibrate-your-grinder-for-optimum-performance"},"nichepatent":{"kind":"patent","reviewedAt":"2026-10-12","scope":"Adjustment ring/support construction; no model-qualified numeric thread pitch found","title":"Niche grinding-device patent GB2562504A","url":"https://patents.google.com/patent/GB2562504A/en"},"ode":{"kind":"manufacturer-product","reviewedAt":"2026-10-12","scope":"31settings/11numbers; no published axial movement","title":"Ode Gen2 product","url":"https://fellowproducts.com/collections/grind-brew/products/ode-brew-grinder-gen-2?variant=40978992529508"},"odecal":{"kind":"manufacturer-guide","reviewedAt":"2026-10-12","scope":"Contact reference; Gen2 andSSP use different backoff","title":"Ode Gen2 burr installation and calibration","url":"https://help.fellowproducts.com/hc/en-us/articles/7767147426843-how-do-i-install-and-calibrate-my-ode-gen-2-brew-burrs-and-ssp-mp-burrs"},"odeespresso":{"kind":"manufacturer-support","reviewedAt":"2026-10-12","scope":"Not intended for espresso","title":"Ode Gen2 espresso suitability","url":"https://support.fellowproducts.com.au/en_us/is-ode-gen-2-suitable-for-grinding-espresso-HJt8Rm8qZe"},"p64":{"kind":"manufacturer-specification","reviewedAt":"2026-10-12","scope":"Each0.1 line10µm vertical movement","title":"LAGOM P64 specifications","url":"https://www.option-o.com/lagom-p64"},"p64guide":{"kind":"manufacturer-guide","reviewedAt":"2026-10-12","scope":"Zero procedure differs before/after August2022; replacement burr recalibration","title":"LAGOM P64 user guide","url":"https://www.option-o.com/lagomp64userguide"},"timemorefaq":{"kind":"manufacturer-faq","reviewedAt":"2026-10-12","scope":"064S/078S stepless; do not transfer non-S detent counts","title":"Sculptor FAQ","url":"https://www.timemore.com/pages/sculptor-related-faq"},"timemoremanuals":{"kind":"manufacturer-manual-index","reviewedAt":"2026-10-12","scope":"Manual access examined; no verified numeric thread lead found","title":"Timemore download center","url":"https://www.timemore.com/pages/download-center"},"xpro":{"kind":"manufacturer-manual","reviewedAt":"2026-10-12","scope":"60clicks/rev,12.5µm burr movement/click","title":"X-Pro manual","url":"https://1zpresso.coffee/manual-xpro-en/"}}}; }
"use strict";

// Self-contained: the same factory is embedded in the native plugin and website.
function createGrinderMechanics(catalog) {
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const modelKey = model => String(model || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const byModel = new Map(models.map(profile => [modelKey(profile.model), profile]));
  models.forEach(profile => { if (profile.id) byModel.set(modelKey(profile.id), profile); });
  const aliases = { baratzaencoreesp: "encoreesp", "1zpressokseries": "kseries" };
  const profileFor = model => byModel.get(aliases[modelKey(model)] || modelKey(model)) || null;
  const invalid = reason => ({ status: "invalid", reason });
  const supplied = (input, key) => input[key] !== undefined;
  const validBounds = (input, minKey, maxKey, value) =>
    (!supplied(input, minKey) || finite(input[minKey])) &&
    (!supplied(input, maxKey) || finite(input[maxKey])) &&
    !(finite(input[minKey]) && finite(input[maxKey]) && input[minKey] >= input[maxKey]) &&
    !(finite(input[minKey]) && value < input[minKey]) &&
    !(finite(input[maxKey]) && value > input[maxKey]);

  function estimate(input = {}) {
    if (!input || typeof input !== "object") return invalid("Supply an input object.");
    const profile = profileFor(input.model);
    if (!profile) return { status: "unavailable", reason: "No reviewed mechanical profile exists for this grinder." };
    if (!finite(input.nativeValue) || (supplied(input, "baselineNativeValue") && !finite(input.baselineNativeValue)))
      return invalid("Native value and any supplied baseline must be finite numbers.");
    if (!validBounds(input, "nativeMin", "nativeMax", input.nativeValue)) return invalid("Native value or operating bounds are invalid.");
    if (finite(input.baselineNativeValue) && !validBounds(input, "nativeMin", "nativeMax", input.baselineNativeValue))
      return invalid("The baseline lies outside the supplied operating bounds.");
    if (profile.rangeIsOperatingBound === true && !validBounds({ nativeMin: profile.nativeRange?.min, nativeMax: profile.nativeRange?.max }, "nativeMin", "nativeMax", input.nativeValue))
      return invalid("Native value is outside the verified operating range.");
    if (profile.status === "candidate_unverified") return { status: "unavailable", reason: "Unverified candidate movement is withheld." };
    const relative = profile.relativeMovement;
    let nativeUnit = profile.nativeUnit || relative?.coordinateUnit || "native units";
    const indicated = relative?.quantity === "indicated disc distance" || profile.mapping === "native_disk_distance";
    let rate = indicated ? 1 : finite(profile.axialMovementUmPerNative) ? profile.axialMovementUmPerNative : relative?.umPerUnit;
    let scenario = null;
    if (!finite(rate)) {
      scenario = profile.exploratoryScenario;
      if (!(input.acceptScenario === true && scenario?.requiresExplicitAssumptionAcceptance === true && finite(scenario.centralUmPerUnit)))
        return { status: "unavailable", model: profile.model, reason: "No defensible scalar movement is available in this coordinate; unknown transitions and candidate-only values are withheld." };
      rate = scenario.centralUmPerUnit;
      nativeUnit = scenario.coordinateUnit || nativeUnit;
    }
    if (input.nativeUnit === "printed_number") {
      if (finite(profile.perWholePrintedNumberUm)) rate = profile.perWholePrintedNumberUm;
      else if (!/whole printed dial number/.test(nativeUnit)) return invalid("This profile does not establish movement per whole printed number.");
      nativeUnit = "printed_number";
    } else if (supplied(input, "nativeUnit") && input.nativeUnit !== nativeUnit) {
      return invalid("The requested native unit does not match this mechanical reference.");
    }
    if (!(rate > 0)) return invalid("The referenced movement per native unit must be positive and finite.");
    const base = { status: scenario ? "provisional_scenario" : "mechanical_reference", model: profile.model,
      nativeValue: input.nativeValue, nativeUnit, nominalUmPerNative: rate,
      uncertainty: scenario ? scenario.sensitivityIntervalUmPerUnit || null : profile.uncertainty,
      axialMovementUm: null, warnings: ["Nominal axial movement or indicated distance is not particle size, a calibrated espresso response, or a validated research dD mapping."] };
    if (scenario) base.scenario = scenario;
    if (indicated) base.indicatedDistanceUm = input.nativeValue;
    if (!finite(input.baselineNativeValue)) return indicated ? base : { ...base, status: "needs_baseline", reason: "Relative movement requires baselineNativeValue." };
    const delta = input.nativeValue - input.baselineNativeValue;
    const movement = delta * rate;
    if (!finite(delta) || !finite(movement)) return invalid("Relative movement overflowed the finite numeric range.");
    return { ...base, baselineNativeValue: input.baselineNativeValue, axialMovementUm: movement };
  }

  function toPhysicalCoordinate(input = {}) {
    const reference = estimate(input);
    const withheld = reason => ({ ...reference, coordinate: null, reason });
    if (!input || !finite(input.baselineNativeValue) || !finite(input.zeroOffsetUm))
      return withheld("An explicit baseline and its physical coordinate (zeroOffsetUm) are required.");
    if (!["mechanical_reference", "provisional_scenario"].includes(reference.status) || !finite(reference.axialMovementUm))
      return withheld("A sourced relative movement and explicit baseline coordinate are required.");
    // zeroOffsetUm is the declared axial coordinate AT baselineNativeValue.
    // A displayed distance is never added a second time as a displacement.
    const coordinate = input.zeroOffsetUm + reference.axialMovementUm;
    if (!finite(coordinate)) return withheld("Physical coordinate overflowed the finite numeric range.");
    return { ...reference, coordinate, coordinateUnit: "micrometres, axial coordinate from declared baseline reference",
      status: reference.status === "provisional_scenario" ? "provisional_scenario_coordinate" : "provisional_physical_coordinate",
      warnings: [...reference.warnings, "The declared baseline offset is an assumption, not independently verified calibration. Conical axial position is not surface-normal burr clearance."] };
  }

  function toRelativeCoordinate(input = {}) {
    const withheld = (status, reason) => ({ status, relativeCoordinate: null, researchCoordinate: null, reason });
    if (!input || ![input.nativeValue, input.baselineNativeValue, input.umPerResearchUnit].every(finite) || input.umPerResearchUnit <= 0 ||
        (supplied(input, "baselineResearchCoordinate") && !finite(input.baselineResearchCoordinate)))
      return withheld("invalid", "Supply finite native coordinates, a positive research unit scale, and a finite optional research baseline.");
    if ((supplied(input, "nativeUnit") && (typeof input.nativeUnit !== "string" || !input.nativeUnit.trim())) ||
        !validBounds(input, "nativeMin", "nativeMax", input.nativeValue) ||
        !validBounds(input, "nativeMin", "nativeMax", input.baselineNativeValue))
      return withheld("invalid", "Native unit, coordinates or supplied operating bounds are invalid.");
    if (input.acceptScenario !== true) return withheld("withheld", "Mapping mechanical movement to research dD requires explicit scenario acceptance.");
    const profile = profileFor(input.model);
    if (profile?.burrGeometry === "conical" && input.acceptGeometryAssumption !== true)
      return withheld("withheld", "Conical axial movement requires explicit geometry-assumption acceptance before research dD mapping.");
    const reference = estimate(input);
    let slope = input.signedAxialUmPerNative;
    let slopeProvenance = "owner_accepted_assumption";
    if (!supplied(input, "signedAxialUmPerNative")) {
      const rate = reference.nominalUmPerNative;
      const indicated = finite(reference.indicatedDistanceUm);
      slope = finite(rate) && (indicated || [1, -1].includes(input.finerSign)) ? rate * (indicated ? 1 : -input.finerSign) : null;
      slopeProvenance = "reference_magnitude_and_native_direction";
    }
    if (!finite(slope) || slope === 0) return withheld("invalid", "A finite nonzero signedAxialUmPerNative is required; no unit slope is invented.");
    const delta = input.nativeValue - input.baselineNativeValue;
    const movement = delta * slope;
    const relativeCoordinate = movement / input.umPerResearchUnit;
    const researchCoordinate = supplied(input, "baselineResearchCoordinate") ? input.baselineResearchCoordinate + relativeCoordinate : null;
    if (!finite(delta) || !finite(movement) || !finite(relativeCoordinate) || (researchCoordinate !== null && !finite(researchCoordinate)))
      return withheld("invalid", "Relative or baseline research coordinate overflowed the finite numeric range.");
    return { status: "provisional_scenario", coordinateStatus: "estimated_relative", model: typeof input.model === "string" ? input.model : null,
      nativeValue: input.nativeValue, baselineNativeValue: input.baselineNativeValue, nativeUnit: input.nativeUnit || reference.nativeUnit || "owner units",
      signedAxialUmPerNative: slope, slopeProvenance, axialMovementUm: movement, relativeCoordinate, researchCoordinate,
      warnings: ["This explicitly accepted research adapter is exploratory. Its research baseline is not an absolute physical calibration or a validation of GbS response."] };
  }

  function proposeNative(input = {}) {
    const withheld = (status, reason) => ({ status, proposedNative: null, reason });
    if (!input || ![input.currentNativeValue, input.requestedResearchDelta, input.umPerResearchUnit, input.ownerStep].every(finite) ||
        input.umPerResearchUnit <= 0 || input.ownerStep <= 0)
      return withheld("invalid", "Native proposal requires finite coordinates, a positive research unit scale and a positive owner step.");
    const slope = supplied(input, "signedAxialUmPerNative") ? input.signedAxialUmPerNative :
      finite(input.umPerNative) && input.umPerNative > 0 && [1, -1].includes(input.finerSign) ? -input.finerSign * input.umPerNative : null;
    if (!finite(slope) || slope === 0) return withheld("invalid", "Supply a finite nonzero signed slope; native movement is never inferred from a default unit slope.");
    if (input.acceptScenario !== true) return withheld("withheld", "Native proposal requires explicit acceptance of the mechanical scenario.");
    if (profileFor(input.model)?.burrGeometry === "conical" && input.acceptGeometryAssumption !== true)
      return withheld("withheld", "Conical axial movement requires explicit geometry-assumption acceptance before research dD mapping.");
    if (!validBounds(input, "minNative", "maxNative", input.currentNativeValue)) return withheld("invalid", "Current native value or operating bounds are invalid.");
    const discrete = supplied(input, "physicalIncrement");
    const origin = supplied(input, "physicalOrigin") ? input.physicalOrigin : 0;
    if ((discrete && (!finite(input.physicalIncrement) || input.physicalIncrement <= 0 || !finite(origin))) || (!discrete && supplied(input, "physicalOrigin")))
      return withheld("invalid", "A physical increment must be positive and finite; its optional numeric lattice origin must be finite.");
    const rawDelta = input.requestedResearchDelta * input.umPerResearchUnit / slope;
    if (!finite(rawDelta)) return withheld("invalid", "Requested native movement overflowed the finite numeric range.");
    const sign = Math.sign(rawDelta);
    const room = sign > 0 && finite(input.maxNative) ? input.maxNative - input.currentNativeValue :
      sign < 0 && finite(input.minNative) ? input.currentNativeValue - input.minNative : Infinity;
    const cap = Math.min(Math.abs(rawDelta), input.ownerStep, room);
    let movement = cap;
    let proposed;
    if (discrete) {
      const increment = input.physicalIncrement;
      const index = (input.currentNativeValue - origin) / increment;
      const currentIndex = Math.round(index);
      const roundoff = number => Math.min(1e-7, 8 * Number.EPSILON * Math.max(1, Math.abs(number)));
      if (!Number.isSafeInteger(currentIndex) || Math.abs(index - currentIndex) > roundoff(index))
        return withheld("invalid", "Current native setting is not on the physical setting lattice.");
      const ratio = cap / increment;
      let steps = Math.floor(ratio + roundoff(ratio));
      if (!Number.isSafeInteger(steps) || !Number.isSafeInteger(currentIndex + sign * steps))
        return withheld("invalid", "The requested lattice movement exceeds reliable numeric precision.");
      proposed = origin + (currentIndex + sign * steps) * increment;
      const epsilon = Math.min(increment * 1e-7, 8 * Number.EPSILON * Math.max(1, Math.abs(proposed), Math.abs(input.currentNativeValue)));
      if (!finite(proposed)) return withheld("invalid", "Proposed native value overflowed the finite numeric range.");
      const normalizeBoundRoundoff = value => {
        if (finite(input.minNative) && value < input.minNative && input.minNative - value <= epsilon) return input.minNative;
        if (finite(input.maxNative) && value > input.maxNative && value - input.maxNative <= epsilon) return input.maxNative;
        return value;
      };
      proposed = normalizeBoundRoundoff(proposed);
      if (!validBounds(input, "minNative", "maxNative", proposed) || Math.abs(proposed - input.currentNativeValue) > cap + epsilon) {
        steps--;
        proposed = normalizeBoundRoundoff(origin + (currentIndex + sign * steps) * increment);
      }
      if (steps <= 0 || !finite(proposed) || !validBounds(input, "minNative", "maxNative", proposed) ||
          sign * (proposed - input.currentNativeValue) <= 0 || Math.abs(proposed - input.currentNativeValue) > cap + epsilon)
        return withheld("hold", "No full physical increment fits the requested movement, owner step and operating bounds.");
      movement = Math.abs(proposed - input.currentNativeValue);
    } else {
      proposed = input.currentNativeValue + sign * movement;
      if (!finite(proposed)) return withheld("invalid", "Proposed native value overflowed the finite numeric range.");
      if (!validBounds(input, "minNative", "maxNative", proposed)) return withheld("out_of_bounds", "Proposed native value leaves the declared operating bounds.");
      if (!movement || proposed === input.currentNativeValue) return withheld("hold", "No nonzero movement fits the requested change and operating bounds.");
    }
    return { status: "estimated_relative", proposedNative: proposed, nativeDelta: proposed - input.currentNativeValue,
      rawNativeDelta: rawDelta, stepLimited: Math.abs(rawDelta) > input.ownerStep, coordinateStatus: "estimated_relative",
      warnings: ["This is at most one owner-confirmed native step under an accepted mechanical scenario, not calibration. Brew and measure again."] };
  }

  return Object.freeze({ profileFor, estimate, toPhysicalCoordinate, toRelativeCoordinate, proposeNative });
}
/* GENERATED GRINDER MECHANICS END */

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
  const GRINDER_STORAGE_KEY = "grinderProfiles.v1";
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
  const OPTIONAL_CONTEXT_FIELDS = ["grinderRpm"];
  let feedback = Object.create(null);
  let settings = {};
  let storageReady = false;
  let storageUnavailable = false;
  let storageWaiters = [];
  let storageWriteWaiters = [];
  let storageWriteBroken = false;
  let grinderProfiles = Object.create(null);
  let selectedGrinderProfileId = null;
  let grinderStorageReady = false;
  let grinderStorageReadStarted = false;
  let grinderStorageUnavailable = false;
  let grinderStorageWaiters = [];
  let grinderWriteWaiters = [];
  let grinderWriteBroken = false;
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

  const RESEARCH_KEY = "researchSharing.v1";
  const RESEARCH_HOST_LIMITS = {
    redirectControl: false, requestCancellation: false,
    notice: "This Decaid host cannot enforce no redirects or cancel an upload already sent. Use only your trusted HTTPS collector; opt-out stops future uploads, but cannot recall received data. The collector receives your network address. No shot IDs, names, notes, raw traces or timestamps are included.",
  };
  let researchClient = null, researchWaiter = null, researchTimer = null;
  let researchSequence = 0, researchGeneration = 0, researchRetry = 30000;
  let researchError = null, researchBusy = false;
  // Private comparison keys stay in plugin storage, never the exported records.
  let researchSeries = { current: null, shots: [] };
  let researchSeriesReset = 0;
  const researchCaptures = new Map();
  function researchStorage(type, state) {
    return new Promise((resolve, reject) => {
      if (!active) return reject(new Error("plugin unloaded"));
      const token = `${sessionEpoch}:${++researchSequence}`;
      const timeout = setTimeout(() => {
        if (researchWaiter?.token === token) researchWaiter = null;
        reject(new Error("research storage acknowledgment timed out"));
      }, 5000);
      researchWaiter = { type, token,
        resolve(value) { clearTimeout(timeout); researchWaiter = null; resolve(value); },
        reject(error) { clearTimeout(timeout); researchWaiter = null; reject(error); } };
      try { host.storage({ type, key: RESEARCH_KEY,
        ...(type === "write" ? { data: { key: RESEARCH_KEY, token, state, series: JSON.parse(JSON.stringify(researchSeries)) } } : {}) }); }
      catch (_) { researchWaiter.reject(new Error("research storage unavailable")); }
    });
  }
  function startResearch() {
    if (researchClient) return researchClient;
    const factory = services.researchSharing || (typeof createResearchSharing === "function" ? createResearchSharing : null);
    if (!factory) throw new Error("research sharing module unavailable");
    const epoch = sessionEpoch, seriesReset = researchSeriesReset;
    researchClient = factory().createClient({
      load: async () => {
        if (!active || epoch !== sessionEpoch) throw new Error("plugin unloaded");
        const stored = await researchStorage("read");
        if (stored == null) return null;
        if (stored.key !== RESEARCH_KEY || !stored.state) throw new Error("invalid research storage");
        if (stored.series != null && seriesReset === researchSeriesReset) {
          const valid = item => item && typeof item.context === "string" && item.context.length <= 10000 && /^[a-f0-9]{32}$/.test(item.id);
          if (!Array.isArray(stored.series.shots) || stored.series.shots.length > 200 ||
              (stored.series.current != null && !valid(stored.series.current)) ||
              stored.series.shots.some(item => !valid(item) || typeof item.key !== "string" || !item.key || item.key.length > 256))
            throw new Error("invalid local research series");
          researchSeries = stored.series;
        }
        return stored.state;
      },
      save: state => {
        if (!active || epoch !== sessionEpoch) return Promise.reject(new Error("plugin unloaded"));
        return researchStorage("write", state);
      },
      send: (url, init) => {
        if (!active || epoch !== sessionEpoch) throw new Error("plugin unloaded");
        factory().validateEndpoint(url);
        return apiRequest(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: init.body });
      },
    });
    return researchClient;
  }
  function stopResearchTimer() {
    clearTimeout(researchTimer); researchTimer = null;
  }
  async function researchStatus() {
    const status = await startResearch().status();
    return { ...status, error: status.error || researchError, hostCapabilities: RESEARCH_HOST_LIMITS };
  }
  async function scheduleResearch(delay = researchRetry) {
    if (!active || researchTimer || researchBusy) return;
    const epoch = sessionEpoch, status = await startResearch().status();
    if (!active || epoch !== sessionEpoch || !status.sharing || !status.queuedCount || researchTimer || researchBusy) return;
    researchTimer = setTimeout(() => { researchTimer = null; void flushResearch(); }, delay);
  }
  async function flushResearch() {
    if (researchBusy || !active) return;
    researchBusy = true;
    const epoch = sessionEpoch, generation = researchGeneration;
    try {
      await startResearch().flush();
      if (epoch === sessionEpoch && generation === researchGeneration) { researchError = null; researchRetry = 30000; }
    } catch (_) {
      if (epoch === sessionEpoch && generation === researchGeneration) {
        researchError = "Research upload failed; queued records remain local. Retry or opt out to clear the queue.";
        researchRetry = Math.min(researchRetry * 2, 900000);
      }
    } finally { if (epoch === sessionEpoch) researchBusy = false; }
    if (active && epoch === sessionEpoch) await scheduleResearch();
  }
  function researchSeriesFor(shotId, context) {
    // Link only shots with recorded bean, grinder and recipe identities. A dial
    // change belongs in the same series; a different bean/recipe does not.
    if (!context.beanBatchId || !context.grinderId || !context.profile || !(context.dose > 0) || !(context.yield > 0)) return undefined;
    const comparison = JSON.stringify([context.beanBatchId, context.grinderId, context.grinderModel,
      context.burrIdentity, context.calibrationEpoch, context.settingUnit, context.grinderRpm,
      context.dose, context.yield, context.basket, context.profile, context.machineId, context.machineFlowCalibration]);
    if (comparison.length > 10000) return undefined;
    const prior = researchSeries.shots.find(item => item.key === shotId);
    if (prior?.context === comparison) return prior.id;
    if (researchSeries.current?.context !== comparison) {
      const factory = services.researchSharing || createResearchSharing;
      researchSeries.current = { context: comparison, id: factory().randomId() };
    }
    const item = { ...researchSeries.current, key: shotId };
    researchSeries.shots = researchSeries.shots.filter(entry => entry.key !== shotId).concat([item]).slice(-200);
    return item.id;
  }
  async function captureResearchShot(shotId) {
    if (!active || typeof shotId !== "string" || !shotId || shotId.length > 256) return;
    if (!researchCaptures.has(shotId) && researchCaptures.size >= 100) { researchError = "Research capture is busy; this event was not archived."; return; }
    const capture = {}; researchCaptures.set(shotId, capture);
    const generation = researchGeneration, epoch = sessionEpoch;
    try {
      const client = startResearch();
      const before = await client.status();
      if (before.error || (!before.localEnabled && !before.sharing)) return;
      await loadStorage();
      await feedbackQueue;
      const full = await fullShot(shotId), f = JSON.parse(JSON.stringify(feedback[shotId] || {}));
      const m = createBrewMetrics().analyze(full, f), c = historicalContext(full, f);
      if (!active || epoch !== sessionEpoch || generation !== researchGeneration || researchCaptures.get(shotId) !== capture) return;
      const unit = { marks: "dial-marks", "dial-mark": "dial-marks", "µm": "micrometres", "decimal dial numbers": "printed-decimal", "printed numbers": "printed-decimal" }[c.settingUnit] || c.settingUnit || "unknown";
      const numericSetting = c.grinderSetting != null && String(c.grinderSetting).trim() !== "" ? Number(c.grinderSetting) : undefined;
      await client.capture({ source: "plugin", mode: "measured", kind: "shot",
        researchSeries: researchSeriesFor(shotId, c),
        grinder: { model: c.grinderModel, settingUnit: unit, setting: numericSetting, rpm: c.grinderRpm },
        recipe: { controlMode: m.trace?.controlMode, targetDoseG: c.dose, targetYieldG: c.yield },
        measurements: { pumpTimeSec: m.timing?.pump?.durationSec, pouringTimeSec: m.timing?.pouring?.durationSec,
          recordingTimeSec: m.timing?.recording?.durationSec, preinfusionSec: m.timing?.preinfusion?.durationSec,
          pumpComplete: m.timing?.pump?.complete, pouringComplete: m.timing?.pouring?.complete,
          manualStopConfirmed: f.manualStopConfirmed, doseG: f.measuredBeanDose?.weightG ?? m.annotations?.actualDoseG,
          yieldG: m.scale?.finalMeasuredWeightG, meanPressureBar: m.machine?.pressure?.mean,
          meanMachineFlowMlPerSec: m.trace?.machineFlow?.mean, meanBeverageFlowGPerSec: m.trace?.beverageFlow?.mean,
          meanMixTemperatureC: m.machine?.mixTemperature?.mean, meanGroupTemperatureC: m.machine?.groupTemperature?.mean,
          flowCoverageSec: m.trace?.machineFlow?.coverageSec },
        coffee: { species: c.beanType?.toLowerCase(), roast: c.roastLevel?.toLowerCase() },
        taste: { good: f.good, intent: { balanced: "balanced", sour: "too_sour", bitter: "too_bitter", astringent: "too_astringent", weak: "weak", channeling: "uneven_flow" }[f.taste],
          overall: f.flavour?.overall, acidity: f.flavour?.acidity, bitterness: f.flavour?.bitterness,
          sweetness: f.flavour?.sweetness, body: f.flavour?.body, astringency: f.flavour?.astringency,
          tastingTemperatureC: f.flavour?.tastingTemperatureC, minutesAfterBrew: f.flavour?.sinceBrewMin },
      }, shotId);
      researchError = null;
      await scheduleResearch(1000);
    } catch (_) { if (active && epoch === sessionEpoch && generation === researchGeneration) researchError = "Research capture unavailable; brewing and saved feedback are unaffected."; }
    finally { if (researchCaptures.get(shotId) === capture) researchCaptures.delete(shotId); }
  }
  async function researchEndpoint(request) {
    const client = startResearch();
    if (request.method === "GET") return researchStatus();
    if (request.method === "DELETE") {
      researchGeneration++; stopResearchTimer();
      researchSeriesReset++; // A pending startup read must not restore deleted linkage.
      researchSeries = { current: null, shots: [] };
      await client.clear(); researchError = null;
      return researchStatus();
    }
    const input = bodyOf(request);
    if (input.operation === "local") {
      await client.setLocalCollection(input.enabled);
      return researchStatus();
    }
    if (input.operation === "retry") { stopResearchTimer(); await flushResearch(); return researchStatus(); }
    if (typeof input.sharing !== "boolean") throw new Error("Choose whether to share research data");
    if (input.sharing && (typeof input.endpoint !== "string" || !input.endpoint.trim())) throw new Error("Configure your HTTPS collector before enabling remote sharing");
    if (input.sharing && input.acknowledgeHostLimits !== true) throw new Error("Acknowledge the host upload limits before sharing");
    researchGeneration++; stopResearchTimer();
    await client.setSharing(input.sharing, input.endpoint ?? null);
    researchError = null;
    return researchStatus();
  }

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
      } else if (["brewTemperatureC", "tastingTemperatureC", "servingTemperatureC"].includes(key)) {
        if (!(numberOrNull(input[key]) !== null && input[key] >= 0 && input[key] <= 150))
          throw new Error("temperature feedback must be between 0 and 150 C");
        result[key] = input[key];
      } else if (key === "sinceBrewMin") {
        if (!(numberOrNull(input[key]) !== null && input[key] >= 0 && input[key] <= 10080))
          throw new Error("time since brew must be between 0 and 10080 minutes");
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
  const BREW_CLOCKS = ["pump", "pouring", "recording"];
  function timingFeedback(input) {
    const seconds = input.brewTimeSec;
    if (seconds != null && !(numberOrNull(seconds) > 0 && seconds <= 600))
      throw new Error("brew time must be positive and at most 600 seconds");
    if (input.brewTimeClock != null &&
        (!BREW_CLOCKS.includes(input.brewTimeClock) || seconds == null))
      throw new Error("brewTimeClock requires brewTimeSec and must be pump, pouring or recording");
    if (input.manualStopConfirmed != null && typeof input.manualStopConfirmed !== "boolean")
      throw new Error("manualStopConfirmed must be boolean");
    return {
      brewTimeSec: seconds ?? null,
      // Earlier operator-entered times used the conventional pump clock.
      brewTimeClock: seconds == null ? null : input.brewTimeClock ?? "pump",
      manualStopConfirmed: input.manualStopConfirmed === true,
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
      let confirmedContext, flavour, measuredBeanDose, timing;
      try {
        timing = timingFeedback(entry);
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
        ...timing,
        confirmedContext,
        measuredBeanDose,
      };
    }
    return result;
  }

  function grinderProfilesFromStorage(value) {
    if (value == null) return Object.create(null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.schemaVersion == null && value.profiles == null)
      return Object.create(null);
    const source = value.schemaVersion === 1 && value.profiles && typeof value.profiles === "object"
      ? value.profiles
      : value;
    if (Array.isArray(source)) return null;
    const result = Object.create(null);
    try {
      for (const id of Object.keys(source)) {
        const profile = validateGrinderProfile(source[id], id);
        result[profile.id] = profile;
      }
    } catch (_) {
      return null;
    }
    return result;
  }

  function validateGrinderProfile(input, expectedId) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("grinder profile must be an object");
    const allowed = new Set(["id", "label", "hostGrinderId", "model", "burrIdentity", "calibrationEpoch", "pitchSource", "ownerAnchors"]);
    const unknown = Object.keys(input).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`grinder profile has unsupported field: ${unknown}`);
    const id = textOrNull(input.id);
    if (!id || id.length > 128 || /^(?:__proto__|constructor|prototype)$/i.test(id) || id !== expectedId && expectedId != null)
      throw new Error("grinder profile id must be a stable owner-generated ID");
    const label = textOrNull(input.label);
    const hostGrinderId = textOrNull(input.hostGrinderId);
    const model = textOrNull(input.model);
    const burrIdentity = textOrNull(input.burrIdentity);
    const calibrationEpoch = textOrNull(input.calibrationEpoch);
    const pitchSource = textOrNull(input.pitchSource);
    if (!label || label.length > 128) throw new Error("grinder profile label is required");
    if (!hostGrinderId || hostGrinderId.length > 256) throw new Error("hostGrinderId must identify a real host grinder record");
    if (!model || !grinderDialTools.profileFor(model)) throw new Error("grinder profile model must be a known grinder");
    if (!burrIdentity || burrIdentity.length > 256) throw new Error("grinder profile burr identity is required");
    if (!calibrationEpoch || calibrationEpoch.length > 256) throw new Error("grinder profile calibration epoch is required");
    if (!pitchSource || pitchSource.length > 512) throw new Error("grinder profile pitch source is required");
    let ownerAnchors = null;
    if (input.ownerAnchors != null) {
      const anchorsInput = input.ownerAnchors;
      if (!anchorsInput || typeof anchorsInput !== "object" || Array.isArray(anchorsInput))
        throw new Error("grinder profile ownerAnchors must be an object");
      const calibration = { ...anchorsInput, grinderId: id, model, burrIdentity, calibrationEpoch };
      grinderDialTools.normalize({ model, value: calibration.dialA, burrIdentity, calibrationEpoch, grinderId: id, calibration });
      ownerAnchors = { ...anchorsInput, grinderId: id, model, burrIdentity, calibrationEpoch };
    }
    return { id, label, hostGrinderId, model: grinderDialTools.profileFor(model).model, burrIdentity, calibrationEpoch, pitchSource, ownerAnchors };
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
      machineId: textOrNull(workflow.machine?.serialNumber || workflow.machine?.id || context.machineId),
      machineFlowCalibration: textOrNull(workflow.machine?.flowCalibration || context.flowCalibration),
      grinderRpm: numberOrNull(
        useSettings
          ? value(context.grinderRpm, value(extras.grinderRpm, numberOrNull(settings.GrinderRPM)))
          : value(context.grinderRpm, extras.grinderRpm),
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
      if (!CONTEXT_FIELDS.includes(key) && !OPTIONAL_CONTEXT_FIELDS.includes(key))
        throw new Error("unsupported confirmed context field");
      if (key === "grinderRpm") {
        if (!(numberOrNull(context[key]) > 0 && context[key] <= 10000))
          throw new Error("invalid confirmed grinder RPM");
        result[key] = context[key];
      } else if (key === "dose" || key === "yield") {
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

  // Decaid exposes the current grinder display as a read-only observation.
  // The value is deliberately opaque: ddValueDum is not a micron unit and
  // must never be converted or copied into historical shot context.
  async function grinderObservation() {
    const infoResponse = await apiRequest(`${API_BASE}/api/v1/grinder/info`);
    if (!infoResponse.ok) throw new Error("grinder observation unavailable");
    const info = await infoResponse.json();
    const stateResponse = await apiRequest(`${API_BASE}/api/v1/grinder/state`);
    if (!stateResponse.ok) throw new Error("grinder observation unavailable");
    const state = await stateResponse.json();
    if (!info || typeof info !== "object" || !Array.isArray(info.observations) ||
        !info.observations.includes("setting")) {
      return {
        status: "unavailable",
        reason: "This grinder does not advertise a read-only setting observation",
        provenance: "Decaid read-only grinder observation; no historical shot state was changed",
      };
    }
    const observedSetting = state && typeof state === "object"
      ? (state.observedSetting ?? state.state?.observedSetting)
      : null;
    if (typeof observedSetting !== "string" || !observedSetting.trim() ||
        observedSetting.length > 128) {
      return {
        status: "unavailable",
        reason: "The grinder setting observation is missing or its sensor is not healthy",
        provenance: "Decaid read-only grinder observation; no historical shot state was changed",
      };
    }
    return {
      status: "available",
      setting: observedSetting,
      unit: "opaque",
      verified: false,
      source: "decaid-grinder-observation",
      provenance: "Live read-only grinder display observation. The value is opaque and is not a micron conversion, verified shot setting, or automatic control command.",
    };
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
      "grinderRpm",
      "machineId",
      "machineFlowCalibration",
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
  async function loadGrinderProfiles() {
    if (!active || grinderStorageUnavailable)
      throw new Error("grinder profile storage unavailable");
    if (grinderStorageReady) return;
    if (!grinderStorageReadStarted) {
      grinderStorageReadStarted = true;
      try { host.storage({ type: "read", key: GRINDER_STORAGE_KEY }); }
      catch (_) {
        grinderStorageUnavailable = true;
        throw new Error("grinder profile storage unavailable");
      }
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        grinderStorageUnavailable = true;
        grinderStorageWaiters = grinderStorageWaiters.filter((entry) => entry !== waiter);
        reject(new Error("grinder profile storage timed out"));
      }, 5000);
      const waiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      grinderStorageWaiters.push(waiter);
    });
    if (!active || grinderStorageUnavailable)
      throw new Error("grinder profile storage unavailable");
  }
  function persistGrinderProfiles() {
    return new Promise((resolve, reject) => {
      if (!active || grinderWriteBroken) {
        reject(new Error("grinder profile storage unavailable"));
        return;
      }
      const waiter = { resolve, reject };
      grinderWriteWaiters.push(waiter);
      const timeout = setTimeout(() => {
        grinderWriteBroken = true;
        grinderWriteWaiters = grinderWriteWaiters.filter((entry) => entry !== waiter);
        reject(new Error("grinder profile storage timed out"));
      }, 5000);
      waiter.resolve = () => { clearTimeout(timeout); resolve(); };
      waiter.reject = (error) => { clearTimeout(timeout); reject(error); };
      try {
        host.storage({ type: "write", key: GRINDER_STORAGE_KEY, data: { schemaVersion: 1, profiles: grinderProfiles, selectedProfileId: selectedGrinderProfileId } });
      } catch (_) {
        clearTimeout(timeout);
        grinderWriteWaiters = grinderWriteWaiters.filter((entry) => entry !== waiter);
        reject(new Error("grinder profile storage unavailable"));
      }
    });
  }
  async function grinderProfilesEndpoint(request) {
    await loadGrinderProfiles();
    if (request.method === "GET")
      return { schemaVersion: 1, profiles: Object.values(grinderProfiles), maxProfiles: 100 };
    const input = bodyOf(request);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("grinder profile request must be an object");
    const operation = input.operation || "upsert";
    const id = textOrNull(input.id || input.profile?.id);
    if (!id || id.length > 128) throw new Error("stable grinder profile id is required");
    if (operation === "delete") {
      if (!grinderProfiles[id]) throw new Error("grinder profile not found");
      const previous = grinderProfiles[id];
      const previousSelection = selectedGrinderProfileId;
      delete grinderProfiles[id];
      if (selectedGrinderProfileId === id) selectedGrinderProfileId = null;
      try { await persistGrinderProfiles(); } catch (error) { grinderProfiles[id] = previous; selectedGrinderProfileId = previousSelection; throw error; }
      return { deleted: true, id };
    }
    if (operation !== "upsert") throw new Error("unsupported grinder profile operation");
    if (!grinderProfiles[id] && Object.keys(grinderProfiles).length >= 100)
      throw new Error("grinder profile limit exceeded");
    const profile = validateGrinderProfile(input.profile || input, id);
    const previous = grinderProfiles[id];
    grinderProfiles[id] = profile;
    try { await persistGrinderProfiles(); } catch (error) { if (previous) grinderProfiles[id] = previous; else delete grinderProfiles[id]; throw error; }
    return { saved: true, profile };
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
    const localProfileId = textOrNull(settings.GrinderProfileId);
    const localProfile = localProfileId ? grinderProfiles[localProfileId] : null;
    if (localProfileId && !localProfile) calibrationError = "selected individual grinder profile is unavailable";
    if (localProfile && !context.grinderId) calibrationError = "host grinderId is required before applying an individual profile";
    if (localProfile && context.grinderId && localProfile.hostGrinderId !== context.grinderId)
      calibrationError = "individual profile is bound to a different host grinder record";
    if (localProfile && (localProfile.model !== profile.model || localProfile.burrIdentity !== context.burrIdentity || localProfile.calibrationEpoch !== context.calibrationEpoch))
      calibrationError = "individual grinder profile does not match the current model, burrs or calibration epoch";
    if (localProfile && !calibrationError && localProfile.ownerAnchors)
      calibration = localProfile.ownerAnchors;
    if (settings.DialCalibration) {
      try {
        if (!localProfile) calibration = typeof settings.DialCalibration === "string" ? JSON.parse(settings.DialCalibration) : settings.DialCalibration;
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
          grinderId: localProfile ? localProfile.id : context.grinderId,
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
      calibrationStatus: currentNative && nativeStatus === "available" && !calibrationError
        ? (researchCoordinate && !profile.algorithmScale ? "Owner-scoped mapping applied for display; not physical grinder certification" : "Native setting displayed in the reviewed profile unit")
        : currentNative && nativeStatus === "available" && calibrationError
        ? "Native setting displayed; owner profile withheld: " + calibrationError
        : researchCoordinate
        ? "physical dial mapping is not claimed"
        : profile.algorithmScale
          ? "native unit conversion from the reviewed grinder profile; verify firmware generation"
          : "owner calibration required before converting this dial to dD",
      notes: [profile.provenance, catalogModel && catalogModel.markings, ...(catalogModel && Array.isArray(catalogModel.notes) ? catalogModel.notes : [])].filter(Boolean).join(" "),
      photoUrl: profile.photoUrl || (catalogModel && catalogModel.image && catalogModel.image.renderAllowed === true && catalogModel.image.licenseUrl && catalogModel.image.url) || null,
      photoCaption: catalogModel && catalogModel.image ? catalogModel.image.caption : null,
      photoOwner: catalogModel && catalogModel.image ? catalogModel.image.owner : null,
      photoSourceUrl: catalogModel && catalogModel.image ? catalogModel.image.sourceUrl : null,
      photoRenderAllowed: Boolean(catalogModel && catalogModel.image && catalogModel.image.renderAllowed === true),
      photoLicense: catalogModel && catalogModel.image ? catalogModel.image.license : null,
      photoLicenseUrl: catalogModel && catalogModel.image ? catalogModel.image.licenseUrl : null,
      schematicUrl: catalogModel && catalogModel.schematicUrl ? catalogModel.schematicUrl : null,
      sourceUrl: profile.sourceUrl || (catalogModel && catalogModel.sources && catalogModel.sources[0] && catalogModel.sources[0].url) || null,
      coordinateOnly: researchCoordinate,
      nativeStatus,
      currentNative,
      proposedNative,
      calibrationError,
      calibrationScope: calibration ? { grinderId: calibration.grinderId || null, hostGrinderId: localProfile ? localProfile.hostGrinderId : (context.grinderId || null), localProfileId: localProfile ? localProfile.id : null, model: calibration.model || null, burrIdentity: calibration.burrIdentity || null, calibrationEpoch: calibration.calibrationEpoch || null } : null,
    };
  }
  async function suggestion() {
    const generation = cacheGeneration;
    await loadStorage();
    await loadGrinderProfiles();
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
        "Saved workflow settings are intended values, not observed hardware state. Dose/yield are recipe targets. Timing uses the explicitly selected target clock; recording time can include preheat and settling.",
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
    const rawTarget = settings.TargetTimeSec;
    const target = (typeof rawTarget === "number" ||
      (typeof rawTarget === "string" && rawTarget.trim() !== "")) ? Number(rawTarget) : NaN;
    const targetClock = settings.TargetTimeClock ?? "pump";
    if (!(Number.isFinite(target) && target > 0))
      return abstain("An explicit positive recipe time target is required", { missingData: ["TargetTimeSec"] });
    if (!BREW_CLOCKS.includes(targetClock))
      return abstain("TargetTimeClock must be pump, pouring or recording");
    const tolerance = configuredNumber("TimeToleranceSec", 1),
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
    base.timeTargetProvenance = "owner/user configured target time";
    base.targetTimeClock = targetClock;
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
          (key) => !["beanType", "roastLevel", "grinderRpm", "machineId", "machineFlowCalibration"].includes(key),
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
      }
      const metrics = createBrewMetrics().analyze(full, mark);
      let seconds, timingProvenance;
      if (mark.brewTimeSec != null) {
        if ((mark.brewTimeClock || "pump") !== targetClock) {
          reject("operator-confirmed brew time uses a different clock from the target");
          continue;
        }
        seconds = mark.brewTimeSec;
        timingProvenance = "operator-confirmed " + targetClock + " time";
      } else {
        const clock = metrics.timing?.[targetClock];
        const complete = targetClock === "recording"
          ? Number.isFinite(clock?.startTimestamp) && Number.isFinite(clock?.endTimestamp)
          : clock?.complete === true;
        if (!complete) {
          reject(targetClock + " time boundaries are incomplete; confirm a time measured on the same clock");
          continue;
        }
        seconds = clock.durationSec;
        timingProvenance = clock.source + ": " + targetClock + " clock";
      }
      if (!(seconds > 0 && seconds <= 600)) {
        reject("selected-clock brew time unavailable or invalid");
        continue;
      }
      const stopReason = String(metrics.stopReason || "").toLowerCase();
      if (/error|disconnected|stopping.?backstop/.test(stopReason)) {
        reject("shot ended with an interrupted machine stop; timing is not grind evidence");
        continue;
      }
      if (/api.?stop|app.?stop/.test(stopReason) && !mark.manualStopConfirmed) {
        reject("shot was manually stopped; confirm that its actual result completed the intended recipe before using timing");
        continue;
      }
      evidence.push({
        shotId: id,
        elapsedTimeSec: seconds,
        brewTimeClock: targetClock,
        manualStopConfirmed: mark.manualStopConfirmed === true,
        timingProvenance,
        taste: mark.taste,
        flavour: mark.flavour || null,
        tasteSignals: tasteSignals(mark),
        metrics,
        unavailableComparisonFields: comparison.unavailable,
        good: mark.good,
        confirmedHistoricalFields: Object.keys(mark.confirmedContext || {}),
      });
      if (evidence.length === 6) break;
    }
    if (!active || generation !== cacheGeneration)
      throw new Error("history changed during suggestion");
    base.sourceShotIds = evidence.map((item) => item.shotId);
    const dynamicFlowEvidence = evidence.find((item) =>
      !["pressure", "mixed_preinfusion_flow"].includes(item.metrics?.trace?.controlMode),
    );
    base.flowEvidence = evidence.map((item) => ({
      shotId: item.shotId,
      controlMode: item.metrics?.trace?.controlMode || "unknown",
      recommendation: item.metrics?.trace?.recommendation || null,
      preinfusion: item.metrics?.trace?.preinfusion || null,
      observations: item.metrics?.trace?.observations || null,
    }));
    if (dynamicFlowEvidence) {
      return abstain(
        "Flow-controlled, dynamic or unknown profile control cannot support this time-based grind rule; compare the flow graph, beverage trace and taste feedback.",
        { flowEvidence: base.flowEvidence },
      );
    }
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
      if (evidence.some((item) => item.unavailableComparisonFields.length))
        proposal.warnings.push(
          "Comparison fields unavailable in both records: " +
          [...new Set(evidence.flatMap((item) => item.unavailableComparisonFields))].join(", ") +
          "; equivalence of these conditions is not established",
        );
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
        "Comparison fields unavailable in both records: " +
        [...new Set(evidence.flatMap((item) => item.unavailableComparisonFields))].join(", ") +
        "; equivalence of these conditions is not established",
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
    else if (operation === "compare")
      result = algorithms.compareAll(data.input);
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
<style>[hidden]{display:none!important}fieldset{min-width:0}svg{width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}.native-grid{display:grid;gap:.6rem;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))}*,*:before,*:after{box-sizing:border-box}html{overflow-x:hidden}body{font:16px/1.5 system-ui;max-width:46rem;margin:2rem auto;padding:2rem 1rem;min-width:0;overflow-wrap:anywhere}button,input,select,textarea{font:inherit;padding:.5rem;max-width:100%;min-width:0}button,input,select{width:100%}button{width:auto}label{display:block;margin:.5rem 0;min-width:0}textarea{width:100%;min-height:9rem;overflow:auto}output{display:block;margin-top:1rem;white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}form,details,#grinderManager,section{min-width:0;max-width:100%}img{max-width:100%;height:auto}a{overflow-wrap:anywhere}.setup-steps{display:flex;flex-wrap:wrap;gap:.45rem;margin:1rem 0}.setup-steps a{border:1px solid #999;border-radius:99px;padding:.3rem .6rem;text-decoration:none}.catalog-item,.comparison-item{border:1px solid #aaa;border-radius:.6rem;padding:.65rem;margin:.5rem 0}.catalog-item button{margin-top:.4rem}@media(min-width:38rem){label{display:grid;grid-template-columns:minmax(10rem,1fr) minmax(0,2fr);gap:.6rem;align-items:center}}</style>
<h1>Assisted dial-in</h1>
<details id="researchSharing"><summary>Research data choices</summary>
<p>A local research archive is on by default; you can turn it off below. It keeps selected numeric brew measurements and fixed categories for future analysis. Remote sharing starts only after you enable it and confirm your own HTTPS collector. Exports exclude shot IDs, bean names, notes, device identities, raw traces and timestamps. Random research keys link corrections and shots from the same bean, grinder and recipe; private context comparisons stay on this device. Network requests still expose your address to the collector.</p>
<label><input id="researchLocal" type="checkbox"> Keep the local research archive</label>
<label>Your research collector HTTPS endpoint<input id="researchEndpoint" type="url" placeholder="https://your-collector.example/v1/events" autocomplete="off"></label>
<label><input id="researchHostLimits" type="checkbox"> I trust this collector and understand this host cannot prevent redirects or cancel an upload already sent.</label>
<button id="researchEnable" type="button">Enable automatic remote sharing</button>
<button id="researchDisable" type="button">Opt out and clear pending uploads</button>
<button id="researchRetry" type="button">Retry pending uploads</button>
<button id="researchExport" type="button">Show local research export</button>
<button id="researchDelete" type="button">Delete all local research data</button>
<p>After you enable sharing, new brew events and feedback changes upload automatically, with retries while the plugin is running. Older local records are not uploaded automatically. Opt-out keeps the local archive and stops future uploads. Previously received data cannot be recalled without collector support.</p>
<output id="researchStatus" aria-live="polite">Open this panel to load your saved choices and upload status.</output>
<pre id="researchExportData" hidden></pre></details>

<p>This assistant recommends recorded settings and manual guidance. It never changes a machine.</p>
<p><button id="modeToggle" type="button" aria-pressed="false">Show expert controls</button> <span id="modeHelp">Simple view keeps recommendations, bean context and brew analysis together.</span></p>
<nav class="setup-steps" aria-label="Dial-in steps"><button type="button" data-native-step="1" aria-current="step">1. Coffee &amp; equipment</button><button type="button" data-native-step="2">2. Recipe &amp; profile</button><button type="button" data-native-step="3">3. Brew trace &amp; taste</button><button type="button" data-native-step="4">4. Next setting</button></nav><p id="nativeWizardStatus" aria-live="polite">Step 1 of 4 · Coffee and equipment</p><p><button id="nativeWizardBack" type="button" disabled>Back</button> <button id="nativeWizardNext" type="button">Next</button></p>
<section id="coffeeStep" data-native-step="1">
<h2>Coffee and equipment</h2><p>Use the saved workflow and bean batch for shot matching. Owner confirmations stay attached to the selected historical shot.</p>
<button id="recommend" type="button">Find recorded recommendation</button><button id="suggestion" type="button">Suggest next step</button><button id="grinderObservation" type="button">Read live grinder display</button><button id="beans" type="button">Show current bean and roast catalog</button><button id="references" type="button">Recipe and grinder references</button><p id="grinderObservationStatus" role="status" aria-live="polite"></p>
<details class="expert-panel" hidden><summary>Individual grinder profiles and calibration</summary><div id="grinderManager" aria-live="polite"><button id="loadGrinders" type="button">Load host grinders</button><label>Current host grinder <select id="grinderProfileSelect"><option value="">Load host grinders first</option></select></label><label>Model <select id="grinderModel"></select></label><label>Profile label <input id="grinderLabel" maxlength="128" autocomplete="off"></label><label>Burr identity <input id="grinderBurrs" maxlength="256" autocomplete="off"></label><label>Calibration epoch <input id="grinderEpoch" maxlength="256" autocomplete="off"></label><label>Source / calibration note <input id="grinderPitchSource" maxlength="512" value="Owner-confirmed; no universal model conversion claimed" autocomplete="off"></label><label>Optional owner anchors (JSON) <textarea id="grinderAnchors" maxlength="4096" placeholder='{"dialMin":0,"dialMax":90,"dialA":0,"ddDumA":300,"dialB":90,"ddDumB":1200}'></textarea></label><button id="saveGrinder" type="button">Create or update host grinder profile</button><button id="selectGrinder" type="button">Use selected profile for suggestions</button><p id="grinderManagerStatus" role="status"></p></div></details>
<details><summary>Browse coffee references and import a bean</summary><p>Preview before importing. Unknown format needs explicit confirmation; capsules, bundles, green beans and ready-to-drink products cannot be imported as roasted whole beans.</p><button id="loadCoffeeCatalog" type="button">Load coffee catalogue</button><label>Search coffee catalogue<input id="nativeCoffeeSearch" type="search"></label><div id="coffeeCatalog" aria-live="polite"></div></details>
</section>
<section id="recipeStep" data-native-step="2"><h2>Recipe and profile</h2><p id="nativeRecipeContext">Analyse a saved shot in step 3 to read its dose, yield and actual profile. Reference selection below explains intent; it does not replace saved controller steps.</p><button id="loadProfiles" type="button">Load all profile references</button><div id="nativeProfiles"></div></section>
<section id="traceStep" data-native-step="3"><h2>Saved brew and taste</h2><label>Recent shot<select id="shotSelect"><option value="">Load shots to choose one</option></select></label><button id="loadShots" type="button">Load recent shots</button><a id="returnLink" hidden>Return to Streamline</a><form id="analysis"><label>Shot ID<input required name="shotId"></label><button type="submit">Analyse saved brew metrics</button></form><output id="result" aria-live="polite"></output><section id="traceGraph" hidden aria-live="polite"><h2>Saved shot flow graph</h2><p id="traceGraphNote"></p><div id="traceGraphBody"></div></section>
<details id="reviewedReferences" hidden><summary>Reviewed references used for this suggestion</summary><ul id="referenceList"></ul></details>
<details id="dialReference" class="expert-panel" hidden><summary>Physical grinder dial reference</summary><div id="dialReferenceBody"></div></details>
<h2>Feedback after a brew</h2>
<form id="feedback">
  <label>Shot ID <input required name="shotId"></label>
  <label>Notes <input name="notes"></label>
  <label>Flavour descriptors <input name="descriptors" placeholder="plum, chocolate, floral"></label>
  <label>Overall extraction assessment <select name="overall"><option value="">Unspecified</option><option value="balanced">Balanced</option><option value="under-extracted">Under-extracted</option><option value="over-extracted">Over-extracted</option><option value="uncertain">Uncertain</option></select></label>
  <details><summary>Optional taste intensity details</summary><p>Optional intensities: 0 absent, 5 very strong. Acidity alone does not prove under-extraction.</p>
  <label>Acidity <input name="acidity" type="number" min="0" max="5" step="1"></label>
  <label>Bitterness <input name="bitterness" type="number" min="0" max="5" step="1"></label>
  <label>Sweetness <input name="sweetness" type="number" min="0" max="5" step="1"></label>
  <label>Body <input name="body" type="number" min="0" max="5" step="1"></label>
  <label>Astringency <input name="astringency" type="number" min="0" max="5" step="1"></label>
  </details><label>Taste
    <select name="taste">
      <option value="">No taste signal</option>
      <option value="balanced">Balanced</option>
      <option value="sour">Too sour / acidic</option>
      <option value="bitter">Too bitter / dry</option>
      <option value="astringent">Too astringent / harsh</option>
      <option value="weak">Weak</option>
      <option value="channeling">Channeling</option>
    </select>
  </label>
  <label>Brew time (seconds, optional) <input name="brewTimeSec" type="number" min="0" step="0.1"></label><label>Timing clock<select name="brewTimeClock"><option value="pump">Pump time</option><option value="pouring">Pouring time</option><option value="recording">Recording elapsed (includes preheat/settling)</option></select></label><label><input name="manualStopConfirmed" type="checkbox"> This manually stopped shot completed the intended recipe and is suitable for comparison</label>
  <details><summary>Optional brew and tasting temperature</summary><label>Brew temperature (°C, optional) <input name="brewTemperatureC" type="number" min="0" max="150" step="0.1"></label>
  <label>Tasting temperature (°C, optional) <input name="tastingTemperatureC" type="number" min="0" max="150" step="0.1"></label>
  <label>Minutes since brew (optional) <input name="sinceBrewMin" type="number" min="0" max="10080" step="1"></label>
  </details><details class="expert-panel" hidden>
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
    <label>Captured at <input name="beanCapturedAt" type="datetime-local" step="any"></label>
    <label>Scale sample timestamp (optional) <input name="beanSampleTimestamp" type="datetime-local" step="any"></label>
  </details>
  <button name="good" value="true">Mark good</button>
  <button name="good" value="false">Mark as not a good result</button>
</form>
</section>
<section id="compareStep" data-native-step="4"><h2>Your next setting</h2><p>Use your grinder’s actual numbers. Keep the dose and beverage weight unchanged while testing one small adjustment.</p><div id="nativeNextStep" role="status">First analyse a saved shot in step 3 and record how it tasted. Then ask for the next setting.</div><button id="nativeAdviceSuggest" type="button">Find my next setting from saved feedback</button>
<details id="nativeAdviceManual"><summary>I can confirm my grinder’s dial and adjustment size</summary><p>This is a small manual experiment. Enter the numbers printed on your own grinder; do not enter research coordinates. Your saved shot must use a compatible pressure profile.</p>
<form id="nativeAdviceForm"><label>My grinder<select id="nativeAdviceModel"><option value="e64ws">E64 WS (micrometres)</option><option value="df54">DF54</option><option value="df64_gen1">DF64 Gen 1</option><option value="df64_gen2">DF64 Gen 2</option></select></label><label><span id="nativeAdviceCurrentLabel">Current setting (µm)</span><input id="nativeAdviceCurrent" type="number" step="any" required></label><label><span id="nativeAdviceStepLabel">One small adjustment (µm)</span><input id="nativeAdviceStep" type="number" min="0.001" step="any" required></label><label>On my grinder, finer means<select id="nativeAdviceDirection" required><option value="">Choose after checking your grinder</option><option value="-1">Smaller numbers</option><option value="1">Larger numbers</option></select></label><label>How did you time this shot?<select id="nativeAdviceClock"><option value="pump">From pump start</option><option value="pouring">Machine pouring phase (after preinfusion)</option><option value="recording">Whole recording (includes preparation)</option></select></label><label>Measured shot time (seconds)<input id="nativeAdviceActual" type="number" min="0.1" max="600" step="0.1" required></label><label>My target, timed the same way (seconds)<input id="nativeAdviceTarget" type="number" min="0.1" max="600" step="0.1" required></label><label>What would you like to improve?<select id="nativeAdviceTaste"><option value="">No clear taste signal</option><option value="balanced">It tastes balanced</option><option value="too sour">Too sour / acidic</option><option value="too bitter">Too bitter / dry</option><option value="too astringent">Too astringent / harsh</option><option value="weak">Weak; cause uncertain</option><option value="channeling">Possible channeling; check preparation</option></select></label><label><input id="nativeAdviceConfirm" type="checkbox" required> This setting was used for this saved shot. I checked the adjustment size and finer direction, the target is timed the same way, and the shot completed my intended recipe</label><button type="submit">Calculate one small dial adjustment</button></form><p id="nativeAdviceResult" role="status"></p></details>
<div class="expert-panel" hidden><h2>Compare all ten calculators</h2><p>Adaptive replay needs a confirmed timing clock and a saved research coordinate. Each supporting calculator has independent measurements; unavailable inputs stay visible. No result changes hardware.</p><div class="native-grid"><label>Measured time on selected clock (seconds)<input id="compare-actual" type="number" min="0.1" max="600" step="0.1" placeholder="Auto-filled only for a complete observed pump clock"></label><label>Target on the same clock (seconds)<input id="compare-target" type="number" min="1" max="600" step="0.1"></label><label>Measurement and target clock<select id="compare-clock"><option value="pump">Pump</option><option value="pouring">Pouring</option><option value="recording">Recording elapsed</option></select></label><label>Tolerance (seconds)<input id="compare-tolerance" type="number" min="0" max="60" step="0.1" value="1"></label></div><p>When the pump clock is unavailable, enter a measured time explicitly. Recording elapsed time includes preheating or settling and is not substituted.</p><div id="nativeSupplemental"></div><button id="compareAll" type="button">Compare all applicable algorithms</button><div id="comparisonRows" aria-live="polite"></div><details class="expert-panel"><summary>Advanced: replay research calculations</summary>
<h2>Advanced research replay</h2>
<p><a href="https://github.com/MaxRink/decaid-assisted-dialin-plugin/blob/main/docs/GBS_GUIDE.md" target="_blank" rel="noopener">Read the calculation guide</a></p>
<form id="research">
  <p>Software replay only. The calculator does not contact hardware or infer physical dial direction.</p>
  <label>Calculator request JSON<textarea name="state" aria-label="Research replay JSON">{"operation":"adjust","algorithm":"GbS2","firmwareBuild":"HEM-HSG-HMI-S01 V01.16-24","coordinateUnit":"deci-micrometre","scope":{"grinderId":"synthetic-grinder","beanBatchId":"synthetic-beans","burrIdentity":"synthetic-burrs","calibrationEpoch":"simulation-1","profile":"synthetic-profile"},"input":{"actualBrewTimeMs":30000,"targetBrewTimeMs":28000,"estimatedDdDum":500,"setpointDdDum":500,"toleranceMs":1000}}</textarea></label>
  <p>This sample uses synthetic inputs. To replay the next shot, copy the returned stateEnvelope into the request and update input. Keep scope unchanged only for the same setup. Other operations and units are documented in README.</p>
  <button type="submit">Run software replay</button>
</form>
</details></div></section>
<footer id="pluginHelp"><h2>Help and feedback</h2>
<p><a href="https://github.com/MaxRink/decaid-assisted-dialin-plugin/issues/new?template=bug-report.yml" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Report a bug</a> · <a href="https://github.com/MaxRink/decaid-assisted-dialin-plugin/issues/new?template=feature-request.yml" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Suggest a feature</a> · <a href="https://github.com/MaxRink/decaid-assisted-dialin-plugin/issues/new?template=new-grinder.yml" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Request a grinder</a> · <a href="https://github.com/MaxRink/decaid-assisted-dialin-plugin/issues/new?template=source-correction.yml" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Correct a research source</a> · <a href="https://github.com/MaxRink/decaid-assisted-dialin-plugin/issues/new?template=coffee-catalog-correction.yml" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Correct the coffee catalog</a> · <a href="https://github.com/MaxRink/decaid-assisted-dialin-plugin/issues/new?template=protocol-mock-device.yml" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Protocol or mock-device report</a></p>
<p>Connection or host problems: <a href="https://github.com/MaxRink/decaid-skale-plugin/issues" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Skale plugin</a> · <a href="https://github.com/MaxRink/decaid-e64ws-plugin/issues" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">E64 WS plugin</a> · <a href="https://github.com/decentespresso/decaid/issues" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Decaid host</a> · <a href="https://github.com/decentespresso/streamline-js/issues" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Streamline interface</a></p>
<p>For vulnerabilities, <a href="https://github.com/MaxRink/decaid-assisted-dialin-plugin/security/advisories/new" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">report privately</a>. These links open GitHub without attaching your shots, names or device details.</p></footer>
<script>
const uiTools=(${createDialinUiTools.toString()})(document);
const supplemental=uiTools.supplementalInputs(document.querySelector('#nativeSupplemental'),'native');
const out=document.querySelector('#result');
let latestAnalysis=null;
const updateCompareClock=()=>{const actual=document.querySelector('#compare-actual'),name=document.querySelector('#compare-clock')?.value||'pump',timing=latestAnalysis?.metrics?.timing?.[name];if(actual)actual.value=timing&&(name==='recording'||timing.complete)&&Number.isFinite(timing.durationSec)?String(timing.durationSec):'';};
document.querySelector('#compare-clock')?.addEventListener('change',updateCompareClock);
const knownGrinders=${JSON.stringify((dialCatalog.models || []).map((profile) => profile.model).filter(Boolean))};
const basePath=typeof location!=='undefined'&&location.pathname?location.pathname.endsWith('/ui')?location.pathname.slice(0,-3):location.pathname:'';
const requestState={generation:0};
const modeToggle=document.querySelector('#modeToggle');
if(modeToggle){modeToggle.onclick=()=>{const expert=modeToggle.getAttribute('aria-pressed')!=='true';modeToggle.setAttribute('aria-pressed',String(expert));modeToggle.textContent=expert?'Show simple controls':'Show expert controls';document.querySelectorAll('.expert-panel').forEach(panel=>{panel.hidden=!expert;});const help=document.querySelector('#modeHelp');if(help)help.textContent=expert?'Expert view exposes replay inputs and exact technical details.':'Simple view keeps recommendations, bean context and brew analysis together.';};}
const nativeWizardButtons=typeof document.querySelectorAll==='function'?[...document.querySelectorAll('[data-native-step]')].filter(node=>node.tagName==='BUTTON'):[];const nativeWizardPanels=typeof document.querySelectorAll==='function'?[...document.querySelectorAll('section[data-native-step]')]:[];let nativeWizardStep=1;const nativeWizardNames=['Coffee and equipment','Recipe and profile','Brew trace and taste','Next setting'];const showNativeWizardStep=step=>{nativeWizardStep=Math.max(1,Math.min(4,step));nativeWizardPanels.forEach(panel=>{panel.hidden=Number(panel.getAttribute('data-native-step'))!==nativeWizardStep;});nativeWizardButtons.forEach(button=>{const active=Number(button.getAttribute('data-native-step'))===nativeWizardStep;button.setAttribute('aria-current',active?'step':'false');});const status=document.querySelector('#nativeWizardStatus');if(status)status.textContent='Step '+nativeWizardStep+' of 4 · '+nativeWizardNames[nativeWizardStep-1];const back=document.querySelector('#nativeWizardBack'),next=document.querySelector('#nativeWizardNext');if(back)back.disabled=nativeWizardStep===1;if(next)next.textContent=nativeWizardStep===4?'Stay on results':'Next';};nativeWizardButtons.forEach(button=>button.onclick=()=>showNativeWizardStep(Number(button.getAttribute('data-native-step'))));document.querySelector('#nativeWizardBack')?.addEventListener('click',()=>showNativeWizardStep(nativeWizardStep-1));document.querySelector('#nativeWizardNext')?.addEventListener('click',()=>showNativeWizardStep(nativeWizardStep+1));showNativeWizardStep(1);
const endpoint=name=>basePath?basePath+'/'+name:name;
const coreBase='http://127.0.0.1:8080/api/v1';
const grinderState={items:[],profiles:new Map(),selected:null};
const grinderStatus=document.querySelector('#grinderManagerStatus');
const grinderObservationStatus=document.querySelector('#grinderObservationStatus');
const grinderMessage=(message,error)=>{if(grinderStatus){grinderStatus.textContent=String(message||'');grinderStatus.dataset.error=error?'true':'false';}};
const grinderJson=async(response)=>{let body={};try{body=await response.json();}catch(_){ }if(!response.ok)throw new Error(body.error||'Host grinder request failed.');return body;};
const knownModelOptions=()=>{const select=document.querySelector('#grinderModel');if(!select)return;select.textContent='';knownGrinders.forEach(model=>{const option=document.createElement('option');option.value=model;option.textContent=model;select.appendChild(option);});};
const currentGrinder=()=>grinderState.items.find(item=>String(item.id)===String(grinderState.selected))||null;
const fillGrinderForm=()=>{const item=currentGrinder(),profile=item&&grinderState.profiles.get(String(item.id));const model=document.querySelector('#grinderModel');if(model&&item)model.value=item.model||'';const fields=[['grinderLabel',profile?.label||item?.model||''],['grinderBurrs',profile?.burrIdentity||item?.burrs||''],['grinderEpoch',profile?.calibrationEpoch||''],['grinderPitchSource',profile?.pitchSource||'Owner-confirmed; no universal model conversion claimed'],['grinderAnchors',profile?.ownerAnchors?JSON.stringify(profile.ownerAnchors):'']];fields.forEach(([id,value])=>{const input=document.querySelector('#'+id);if(input)input.value=String(value);});};
const renderGrinders=()=>{const select=document.querySelector('#grinderProfileSelect');if(!select)return;select.textContent='';const create=document.createElement('option');create.value='__new__';create.textContent='Create a new host grinder';select.appendChild(create);grinderState.items.forEach(item=>{const option=document.createElement('option');option.value=String(item.id);option.textContent=String(item.model||'Unknown model')+' · '+String(item.id);select.appendChild(option);});const initial=grinderState.selected||grinderState.items[0]?.id||'__new__';select.value=String(initial);grinderState.selected=select.value==='__new__'?null:select.value;fillGrinderForm();};
const loadGrinders=async()=>{try{const [hostResponse,localResponse]=await Promise.all([fetch(coreBase+'/grinders?includeArchived=false'),fetch(endpoint('grinders'))]);const host=await grinderJson(hostResponse),local=await grinderJson(localResponse);const items=Array.isArray(host)?host:(Array.isArray(host.items)?host.items:Array.isArray(host.grinders)?host.grinders:[]);if(items.some(item=>!item||typeof item.id!=='string'||!item.id.trim()))throw new Error('Host returned a grinder without a stable ID.');grinderState.items=items.filter(item=>item&&!item.archived);const profiles=Array.isArray(local.profiles)?local.profiles:[];grinderState.profiles=new Map(profiles.filter(profile=>profile&&typeof profile.id==='string').map(profile=>[profile.id,profile]));renderGrinders();grinderMessage('Loaded '+grinderState.items.length+' host grinder(s).');}catch(error){grinderMessage(error.message||'Could not load host grinders.',true);}};
const saveGrinder=async()=>{try{const selected=currentGrinder(),model=document.querySelector('#grinderModel')?.value,label=document.querySelector('#grinderLabel')?.value.trim(),burrs=document.querySelector('#grinderBurrs')?.value.trim(),epoch=document.querySelector('#grinderEpoch')?.value.trim(),pitchSource=document.querySelector('#grinderPitchSource')?.value.trim(),anchorText=document.querySelector('#grinderAnchors')?.value.trim();let ownerAnchors=null;if(anchorText){try{ownerAnchors=JSON.parse(anchorText);}catch(_){throw new Error('Owner anchors must be valid JSON.');}}if(!model||!knownGrinders.includes(model))throw new Error('Choose a known grinder model.');if(!label||label.length>128||!burrs||burrs.length>256||!epoch||epoch.length>256||!pitchSource||pitchSource.length>512)throw new Error('Label, burr identity, calibration epoch and source are required.');const corePayload={model,burrs,settingType:selected?.settingType||'numeric'};const coreResponse=await fetch(selected?coreBase+'/grinders/'+encodeURIComponent(selected.id):coreBase+'/grinders',{method:selected?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(corePayload)});const saved=await grinderJson(coreResponse),item=saved&&saved.id?saved:(saved&&saved.grinder?saved.grinder:null);if(!item||typeof item.id!=='string'||!item.id.trim())throw new Error('Host did not return a stable grinder ID.');const profile={id:item.id,label,hostGrinderId:item.id,model,burrIdentity:burrs,calibrationEpoch:epoch,pitchSource,ownerAnchors};const localResponse=await fetch(endpoint('grinders'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'upsert',profile})});await grinderJson(localResponse);grinderState.selected=String(item.id);await loadGrinders();grinderState.selected=String(item.id);renderGrinders();grinderMessage('Saved host grinder '+item.id+'.');}catch(error){grinderMessage(error.message||'Could not save host grinder.',true);}};
const selectGrinder=async()=>{try{const selected=currentGrinder();if(!selected)throw new Error('Select a host grinder first.');const response=await fetch(endpoint('settings'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({GrinderProfileId:String(selected.id)})});await grinderJson(response);const readback=await grinderJson(await fetch(endpoint('settings')));if(String(readback.GrinderProfileId||'')!==String(selected.id))throw new Error('Host did not confirm the selected grinder profile.');grinderMessage('Using '+selected.model+' ('+selected.id+') for future suggestions.');}catch(error){grinderMessage(error.message||'Could not select grinder profile.',true);}};
knownModelOptions();
document.querySelector('#loadGrinders')?.addEventListener('click',loadGrinders);document.querySelector('#grinderProfileSelect')?.addEventListener('change',event=>{grinderState.selected=event.target.value;fillGrinderForm();});document.querySelector('#saveGrinder')?.addEventListener('click',saveGrinder);document.querySelector('#selectGrinder')?.addEventListener('click',selectGrinder);
document.querySelector('#grinderObservation')?.addEventListener('click',async event=>{const button=event.currentTarget||event.target;try{button.disabled=true;const body=await grinderJson(await fetch(endpoint('grinder-observation')));if(grinderObservationStatus)grinderObservationStatus.textContent=body.status==='available'?'Live grinder display: '+String(body.setting)+' ('+String(body.unit)+'). '+String(body.provenance):String(body.reason||'Live grinder observation unavailable.');}catch(error){if(grinderObservationStatus)grinderObservationStatus.textContent=error.message||'Live grinder observation unavailable. Try again.';}finally{button.disabled=false;}});
const catalogBox=document.querySelector('#coffeeCatalog'),catalogButton=document.querySelector('#loadCoffeeCatalog');
let nativeCoffeeProducts=[],nativeCoffeePage=1;
function renderCoffeeCatalog(){if(!catalogBox)return;catalogBox.textContent='';const query=(document.querySelector('#nativeCoffeeSearch')?.value||'').toLowerCase();const matches=nativeCoffeeProducts.filter(item=>[item.name,item.publisher,item.origin,item.process,item.format].join(' ').toLowerCase().includes(query));matches.slice(0,nativeCoffeePage*10).forEach(item=>{
  const card=document.createElement('article');card.className='catalog-item';const title=document.createElement('strong');title.textContent=item.name;const details=document.createElement('p');details.textContent=[item.publisher,item.origin,item.process,item.roastLevel,'Format: '+(item.format||'unknown'),'Decaf: '+(item.decaf==null?'unknown':item.decaf?'yes':'no')].filter(Boolean).join(' · ');card.append(title,details);
  const unsupported=['capsule','ready-to-drink','bundle','green-bean','ground'].includes(item.format);const button=document.createElement('button');button.type='button';button.textContent='Preview import';let pending=false,approved=false,confirmWhole=null,confirmDecaf=null;
  button.onclick=async()=>{if(pending)return;if(!approved){approved=true;const preview=document.createElement('p');preview.textContent=unsupported?'This format cannot be imported as a roasted whole-bean coffee.':item.beanEligible?'Review these sourced fields before creating a host bean. Unknown facts remain preserved in source metadata.':'Whole-bean format is not evidenced. Confirm the physical product before importing.';card.appendChild(preview);if(unsupported){button.disabled=true;button.textContent='Reference only';return;}if(!item.beanEligible){const label=document.createElement('label');label.textContent='I confirm this product is roasted whole beans';confirmWhole=document.createElement('input');confirmWhole.type='checkbox';label.appendChild(confirmWhole);card.appendChild(label);}if(item.decaf==null){const label=document.createElement('label');label.textContent='Confirm decaf status (the host requires yes or no)';confirmDecaf=document.createElement('select');[['','Choose from the package'],['yes','Decaf'],['no','Not decaf']].forEach(([value,text])=>{const option=document.createElement('option');option.value=value;option.textContent=text;confirmDecaf.appendChild(option);});label.appendChild(confirmDecaf);card.appendChild(label);}button.textContent='Confirm import into host beans';return;}if(unsupported||confirmWhole&&!confirmWhole.checked||confirmDecaf&&!['yes','no'].includes(confirmDecaf.value))return;pending=true;button.disabled=true;
    try{const sourceUrl=safeReferenceUrl(item.url),catalogId=item.id;if(!catalogId)throw new Error('Catalogue identity is missing.');const existingBody=await grinderJson(await fetch(coreBase+'/beans?includeArchived=true'));const existingItems=Array.isArray(existingBody)?existingBody:Array.isArray(existingBody.items)?existingBody.items:[];const existing=existingItems.find(bean=>bean?.extras?.catalogId===catalogId);const payload={name:item.name,roaster:item.publisher||item.roaster,species:item.species||null,decaf:confirmDecaf?confirmDecaf.value==='yes':item.decaf===true,processing:item.process||item.processing||null,country:item.country||null,notes:item.notes||null,extras:{catalogId,sourceUrl,sourceOrigin:item.origin||null,sourceDecaf:item.decaf??null,decafOwnerConfirmed:!!confirmDecaf,sourceFormat:item.format||'unknown',wholeBeanOwnerConfirmed:!!confirmWhole?.checked,sourceFacts:item.factSources||[],roastLevel:item.roastLevel||null}};const saved=existing||await grinderJson(await fetch(coreBase+'/beans',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));const id=saved?.id;if(!id)throw new Error('Host did not return a stable bean ID.');const readback=await grinderJson(await fetch(coreBase+'/beans/'+encodeURIComponent(id)));if(readback.id!==id||readback.extras?.catalogId!==catalogId)throw new Error('Host readback did not confirm the imported catalogue identity.');const result=document.createElement('p');result.textContent=(existing?'Already imported; ':'Imported; ')+'host readback confirmed '+readback.name+' ('+id+'). Confirm batch, roast date and unknown decaf status in the host catalogue.';card.appendChild(result);
    }catch(error){const result=document.createElement('p');result.textContent=error.message||'Coffee import failed.';card.appendChild(result);}finally{pending=false;button.disabled=false;}
  };card.appendChild(button);catalogBox.appendChild(card);
});if(matches.length>nativeCoffeePage*10){const more=document.createElement('button');more.textContent='Show 10 more coffees';more.type='button';more.onclick=()=>{nativeCoffeePage++;renderCoffeeCatalog();};catalogBox.appendChild(more);}if(!matches.length)catalogBox.textContent='No matching coffees.';}
catalogButton?.addEventListener('click',async()=>{try{catalogButton.disabled=true;const body=await grinderJson(await fetch(endpoint('coffee-catalog')));nativeCoffeeProducts=Array.isArray(body.products)?body.products:[];nativeCoffeePage=1;renderCoffeeCatalog();}catch(error){if(catalogBox)catalogBox.textContent=error.message;}finally{catalogButton.disabled=false;}});
document.querySelector('#nativeCoffeeSearch')?.addEventListener('input',()=>{nativeCoffeePage=1;renderCoffeeCatalog();});
const comparisonRows=document.querySelector('#comparisonRows'),compareButton=document.querySelector('#compareAll');
const renderComparison=body=>{if(comparisonRows)uiTools.renderComparisons(comparisonRows,body);};
compareButton?.addEventListener('click',async()=>{const generation=requestState.generation;try{compareButton.disabled=true;const context=latestAnalysis?.context||{},raw=context.grinderSetting,actualRaw=document.querySelector('#compare-actual')?.value,targetRaw=document.querySelector('#compare-target')?.value;const actualSec=Number(actualRaw),targetSec=Number(targetRaw),setting=Number(raw),tolerance=Number(document.querySelector('#compare-tolerance')?.value||1);const cases=supplemental.cases();if(latestAnalysis&&raw!=null&&String(raw).trim()!==''&&Number.isInteger(setting)&&context.settingUnit==='deci-micrometre'&&actualRaw&&targetRaw&&actualSec>0&&actualSec<=600&&targetSec>0&&targetSec<=600&&Number.isFinite(tolerance)&&tolerance>=0){const input={actualBrewTimeMs:Math.round(actualSec*1000),targetBrewTimeMs:Math.round(targetSec*1000),toleranceMs:Math.round(tolerance*1000),estimatedDdDum:setting,setpointDdDum:setting};['GbS1','GbS2','GbS3','GbS4','DdEff'].forEach(name=>{cases[name]={input:{...input}};});}const response=await grinderJson(await fetch(endpoint('research'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'compare',firmwareBuild:'HEM-HSG-HMI-S01 V01.16-24',coordinateUnit:'deci-micrometre',input:{cases}})}));response.results.forEach(row=>{if(!cases[row.algorithm]&&['GbS1','GbS2','GbS3','GbS4','DdEff'].includes(row.algorithm))row.reason='Requires an analysed shot with a saved deci-micrometre setting and a measured pump/brew time plus a target on the same clock. Native marks are never guessed.';});if(generation===requestState.generation)renderComparison(response);}catch(error){if(comparisonRows)comparisonRows.textContent=error.message||'Comparison unavailable.';}finally{compareButton.disabled=false;}});
document.querySelector('#loadProfiles')?.addEventListener('click',async()=>{const holder=document.querySelector('#nativeProfiles');try{uiTools.profilePicker(holder,await grinderJson(await fetch(endpoint('profiles'))));}catch(error){holder.textContent=error.message;}});
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
const renderDialReference=body=>{if(!dialDetails||!dialBody)return;dialBody.textContent='';const reference=body&&body.dialReference;if(!reference||typeof reference!=='object'){dialDetails.hidden=true;return;}const unit=dialValue(reference,'displayUnit','unit')||body.settingUnit||null;const model=dialValue(reference,'model','name')||body.grinderModel;const coordinateOnly=reference.coordinateOnly===true;const nativeAvailable=reference.nativeStatus==='available'&&reference.currentNative;const currentNative=nativeAvailable?reference.currentNative:null;const proposedNative=reference.nativeStatus==='available'&&reference.proposedNative?reference.proposedNative:null;const range=reference.range&&typeof reference.range==='object'?reference.range:null;const lines=[model&&(nativeAvailable?'Grinder: '+model:'Grinder profile: '+model),nativeAvailable&&'Current physical dial: '+formatDialValue(currentNative.value,currentNative.unit),nativeAvailable&&proposedNative&&'Suggested physical dial: '+formatDialValue(proposedNative.value,proposedNative.unit),!nativeAvailable&&body.currentSetting!==undefined&&(coordinateOnly?'Current research coordinate: ':'Recorded setting: ')+formatDialValue(body.currentSetting,unit),!nativeAvailable&&body.proposedSetting!==undefined&&body.proposedSetting!==null&&(coordinateOnly?'Suggested research coordinate: ':'Suggested recorded setting: ')+formatDialValue(body.proposedSetting,unit),range&&nativeAvailable&&('Reference markings: '+formatDialValue(range.min,unit)+' to '+formatDialValue(range.max,unit)),dialValue(reference,'zeroMeaning','zeroPoint')&&'Zero point: '+dialValue(reference,'zeroMeaning','zeroPoint'),dialValue(reference,'direction','finerDirection')&&'Direction: '+dialValue(reference,'direction','finerDirection'),dialValue(reference,'calibrationStatus','calibration')&&'Calibration: '+dialValue(reference,'calibrationStatus','calibration'),reference.calibrationError&&'Native conversion withheld: '+reference.calibrationError,dialValue(reference,'notes','conversionNote')&&'How to read it: '+dialValue(reference,'notes','conversionNote')].filter(Boolean);const text=document.createElement('p');text.textContent=lines.join(' — ');dialBody.appendChild(text);const photoLicense=String(reference.photoLicense||'').trim().toLowerCase().replace(/\s+/g,' ');const photoLicenseUrl=safeReferenceUrl(reference.photoLicenseUrl);const photoAllowed=reference.photoRenderAllowed===true&&['cc0','public domain','cc by','cc by-sa','cc by 4.0','cc by-sa 4.0'].includes(photoLicense)&&photoLicenseUrl;const imageUrl=photoAllowed&&safeReferenceUrl(dialValue(reference,'photoUrl','imageUrl'));if(imageUrl){const image=document.createElement('img');image.src=imageUrl;image.alt=reference.photoCaption||(model||'Grinder')+' dial reference photo';image.loading='lazy';if(image.style)image.style.maxWidth='100%';image.onerror=()=>{image.remove();};dialBody.appendChild(image);if(reference.photoOwner){const credit=document.createElement('p');credit.textContent=[reference.photoCaption,'Photo credit: '+reference.photoOwner,'Licence: '+reference.photoLicense].filter(Boolean).join(' — ');dialBody.appendChild(credit);}if(photoLicenseUrl){const license=document.createElement('a');license.href=photoLicenseUrl;license.target='_blank';license.rel='noopener';license.textContent='View image licence';dialBody.appendChild(license);}}const sourceUrl=safeReferenceUrl(dialValue(reference,'photoSourceUrl','sourceUrl'));if(sourceUrl){const link=document.createElement('a');link.href=sourceUrl;link.target='_blank';link.rel='noopener';link.textContent='Open dial reference source';dialBody.appendChild(link);}dialDetails.hidden=!!modeToggle&&modeToggle.getAttribute('aria-pressed')!=='true';};
const renderReferenceDetails=references=>{if(!referenceDetails||!referenceList)return;referenceList.textContent='';const matches=references&&Array.isArray(references.matches)?references.matches:[];if(!matches.length){referenceDetails.hidden=true;return;}matches.forEach(source=>{const item=document.createElement('li');const link=document.createElement('a');const safeUrl=safeReferenceUrl(source.url);if(safeUrl){link.href=safeUrl;link.target='_blank';link.rel='noopener';}link.textContent=source.title||source.publisher||'Reviewed reference';item.appendChild(link);const details=document.createElement('p');const scope=source.scope&&typeof source.scope==='object'?humanFacts(source.scope):String(source.scope||'Contextual reference');const facts=humanFacts(source.facts);const notes=Array.isArray(source.notes)?source.notes.join(' '):String(source.notes||'');details.textContent=[source.publisher,scope&&'Scope: '+scope,facts&&'Facts: '+facts,notes&&'Notes: '+notes].filter(Boolean).join(' — ');item.appendChild(details);referenceList.appendChild(item);});referenceDetails.hidden=false;};

const advice=document.querySelector('#nativeNextStep'),adviceResult=document.querySelector('#nativeAdviceResult');
const beginnerMessage=body=>{if(body?.status==='recommendation'){const raw=body.grinderSetting,setting=raw!=null&&String(raw).trim()!==''?Number(raw):NaN,unit=body.comparison?.settingUnit,model=String(body.comparison?.grinderModel||'').toLowerCase().replace(/[^a-z0-9]/g,'');let native=null,label=null;if(Number.isFinite(setting)){if(model==='e64ws'&&unit==='deci-micrometre'){native=setting/10;label='µm';}else if(['micrometres','micrometre','µm'].includes(unit)){native=setting;label='µm';}else if(['dial-mark','dial-marks','marks','owner marks','owner-calibrated marks'].includes(unit)){native=setting;label='marks';}}return native!=null?'A comparable good shot used '+native+' '+label+'. Verify that number on your grinder before repeating the same dose and beverage weight. This is a saved setting, not a live hardware reading.':'A comparable good shot is saved, but its setting cannot yet be shown in verified grinder units. Confirm your physical dial and ask for the next setting.';}const reference=body?.dialReference,current=reference?.nativeStatus==='available'&&reference.currentNative,proposed=reference?.nativeStatus==='available'&&reference.proposedNative;const reason=body?.reason||'Save how the shot tasted, then request another assessment.';if(current&&proposed&&Number.isFinite(current.value)&&Number.isFinite(proposed.value)){const amount=Math.abs(proposed.value-current.value),unit=proposed.unit||current.unit||'marks';return amount===0?'Keep '+current.value+' '+unit+'. Brew again at the same dose and beverage weight. '+reason:'Try '+proposed.value+' '+unit+' next (currently '+current.value+'; '+String(Number(amount.toFixed(3)))+' '+unit+' '+(body.direction||'change')+'). '+(proposed.achievable===false?'This lies between physical steps: choose and confirm a neighboring achievable mark. ':'')+'Keep dose and beverage weight unchanged, then taste and record the next shot. '+reason;}return 'Keep the current dial setting for now. '+reason+' '+(current?'Your recorded dial is '+current.value+' '+current.unit+'. ':'')+'An exact next dial number needs a verified conversion or your own confirmed dial and small adjustment size below.';};
const renderBeginnerAdvice=body=>{if(advice)advice.textContent=beginnerMessage(body);};
const updateAdviceClock=()=>{const input=document.querySelector('#nativeAdviceActual'),name=document.querySelector('#nativeAdviceClock')?.value||'pump',timing=latestAnalysis?.metrics?.timing?.[name];if(input)input.value=timing&&(name==='recording'||timing.complete)&&Number.isFinite(timing.durationSec)?String(timing.durationSec):'';};
document.querySelector('#nativeAdviceClock')?.addEventListener('change',updateAdviceClock);
document.querySelector('#nativeAdviceSuggest')?.addEventListener('click',async()=>{if(advice)advice.textContent='Reviewing your saved feedback...';try{const body=await show('suggestion',undefined,'Reviewing your saved feedback...');if(body.error&&advice)advice.textContent='Could not load the next setting. '+body.error+' Try again.';}catch(error){if(advice)advice.textContent='Could not load the next setting. Try again.';}showNativeWizardStep(4);});
const adviceForm=document.querySelector('#nativeAdviceForm');let adviceGeneration=0;
document.querySelector('#nativeAdviceModel')?.addEventListener('change',()=>{const micron=document.querySelector('#nativeAdviceModel').value==='e64ws';document.querySelector('#nativeAdviceCurrentLabel').textContent=micron?'Current setting (µm)':'Current dial number';document.querySelector('#nativeAdviceStepLabel').textContent=micron?'One small adjustment (µm)':'One small adjustment on my dial (marks)';['Current','Step','Direction'].forEach(name=>document.querySelector('#nativeAdvice'+name).value='');document.querySelector('#nativeAdviceConfirm').checked=false;adviceGeneration++;if(adviceResult)adviceResult.textContent='Confirm this grinder’s current number, adjustment size and finer direction before calculating.';});
adviceForm?.addEventListener('input',()=>{adviceGeneration++;if(adviceResult)adviceResult.textContent='Inputs changed. Calculate the next adjustment again.';});
adviceForm?.addEventListener('submit',async event=>{event.preventDefault();const generation=++adviceGeneration,analysis=latestAnalysis;const button=adviceForm.querySelector('button');try{if(!analysis)throw new Error('Analyse your saved shot in step 3 first.');if(/error|disconnected|stopping.?backstop/i.test(String(analysis.metrics?.stopReason||'')))throw new Error('This shot ended with an interrupted machine stop. Keep the dial unchanged and record a completed shot before using time as grind evidence.');if(!['pressure','mixed_preinfusion_flow'].includes(analysis.metrics?.trace?.controlMode))throw new Error('This flow-controlled or unknown profile cannot support a time-based dial adjustment. Compare the actual flow trace and taste first; keep the dial unchanged.');const read=id=>document.querySelector('#nativeAdvice'+id);if(!read('Confirm').checked)throw new Error('Confirm your physical dial, adjustment size and completed recipe first.');const models={e64ws:'E64 WS',df54:'DF54',df64_gen1:'DF64 Gen 1',df64_gen2:'DF64 Gen 2'},normalize=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');if(normalize(analysis.context?.grinderModel)!==normalize(models[read('Model').value]))throw new Error('The selected grinder must match this saved shot. Analyse a shot from your '+models[read('Model').value]+' before proposing a dial number.');if(['Current','Step','Actual','Target','Direction'].some(name=>!read(name).value.trim()))throw new Error('Enter each measured value and confirm the physical finer direction; an empty dial is not zero.');const current=Number(read('Current').value),step=Number(read('Step').value),actual=Number(read('Actual').value),target=Number(read('Target').value),sign=Number(read('Direction').value);if(![current,step,actual,target].every(Number.isFinite)||step<=0||actual<=0||actual>600||target<=0||target>600||![-1,1].includes(sign))throw new Error('Enter a current dial number, a positive small step, measured and target times, and the verified finer direction.');const unit=read('Model').value==='e64ws'?'µm':'marks',taste=read('Taste').value;const savedRaw=analysis.context?.grinderSetting,savedUnit=String(analysis.context?.settingUnit||'').toLowerCase(),savedValue=savedRaw!=null&&String(savedRaw).trim()!==''?Number(savedRaw):NaN;let savedNative=null;if(Number.isFinite(savedValue)){if(read('Model').value==='e64ws'&&savedUnit==='deci-micrometre')savedNative=savedValue/10;else if(read('Model').value==='e64ws'&&['micrometres','micrometre','micrometers','micrometer','µm','um'].includes(savedUnit))savedNative=savedValue;else if(read('Model').value!=='e64ws'&&['dial-mark','dial-marks','marks','owner marks','owner-calibrated marks'].includes(savedUnit))savedNative=savedValue;}if(savedNative!=null&&Math.abs(savedNative-current)>1e-7)throw new Error('This shot was recorded at '+savedNative+' '+unit+'. Enter the setting used for that shot, or analyse a shot at your current setting.');if(!taste){adviceResult.textContent='Keep '+current+' '+unit+' for now. Taste the shot and choose what needs improving before requesting an exact adjustment.';return;}if(['weak','channeling'].includes(taste)){adviceResult.textContent='Keep '+current+' '+unit+' for now. Check dose, distribution and the actual flow trace; this taste observation does not identify a reliable dial change.';return;}button.disabled=true;const response=await grinderJson(await fetch(endpoint('research'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'manual',input:{profile:read('Model').value,currentDial:current,...(read('Model').value==='e64ws'?{settingUnit:'micrometres',stepNative:step}:{stepMarks:step}),numericFinerDelta:sign,targetTimeSec:target,actualTimeSec:actual,flavor:taste}})}));if(generation!==adviceGeneration||analysis!==latestAnalysis)return;const result=response.result;if(Number.isFinite(result.proposedDial))adviceResult.textContent='Try '+result.proposedDial+' '+unit+' next (currently '+current+'; '+step+' '+(unit==='marks'?'mark'+(step===1?'':'s'):unit)+' '+result.direction+'). Keep dose and beverage weight unchanged. Brew, taste and record the next shot before another adjustment. This is an owner-confirmed experiment, not a measured grind-response prediction.';else adviceResult.textContent='Keep '+current+' '+unit+' for now. '+(result.reasons||[]).join(' ');}catch(error){if(generation===adviceGeneration&&adviceResult)adviceResult.textContent=error.message;}finally{if(button)button.disabled=false;}});

const renderTraceGraph=body=>{const holder=document.querySelector('#traceGraph'),content=document.querySelector('#traceGraphBody');if(!holder||!content)return;holder.hidden=!body?.metrics?.trace?.points?.length;if(!holder.hidden)uiTools.renderTrace(content,body.metrics);};
const render=({endpoint:name,body})=>{
  if(name==='recommendation'&&modeToggle&&modeToggle.getAttribute('aria-pressed')!=='true')return body.status==='recommendation'?beginnerMessage(body):'No matching good shot yet. '+(body.reason||'Save feedback after a completed shot.');
  if(name==='recommendation')return body.status==='recommendation'?'Recorded recommendation\\nSetting: '+body.grinderSetting+'\\nSource shot: '+body.sourceShotId+'\\n\\n'+(body.notes||'No note saved.'):'No safe recommendation\\n'+(body.reason||'Comparable history is unavailable.');
  if(name==='suggestion'&&modeToggle&&modeToggle.getAttribute('aria-pressed')!=='true')return beginnerMessage(body);
  if(name==='suggestion'){const evidenceCount=body.evidenceCount??(body.sourceShotIds||[]).length;if(body.status!=='suggestion'&&body.status!=='provisional'&&body.status!=='established')return 'No safe adjustment\\n'+(body.reason||'The evidence is incomplete or conflicting.');const provisional=body.status==='provisional'||(body.status==='suggestion'&&evidenceCount<3);const heading=provisional?'Early manual next step':'Manual adjustment suggestion';const caution=provisional?'One or two comparable shots are only an early signal. Confirm the next brew and keep collecting evidence.':'Repeated comparable shots support this direction; confirm it manually before changing the grinder.';const reference=body.dialReference&&typeof body.dialReference==='object'?body.dialReference:null;const unit=(reference&&(reference.displayUnit||reference.unit))||body.settingUnit||'';const cn=reference&&reference.nativeStatus==='available'&&reference.currentNative;const pn=reference&&reference.nativeStatus==='available'&&reference.proposedNative;const research=reference&&reference.coordinateOnly;const current=cn?formatDialValue(cn.value,cn.unit):body.currentSetting==null?'unavailable':formatDialValue(body.currentSetting,unit);const proposed=pn?formatDialValue(pn.value,pn.unit)+(pn.achievable===false?' (between physical steps; choose a neighboring step)':''):body.proposedSetting==null?'confirm manually':formatDialValue(body.proposedSetting,unit);const currentLabel=cn?'Current physical dial':research?'Current research coordinate':'Recorded setting';const proposedLabel=pn?'Proposed physical dial':research?'Proposed research coordinate':'Proposed recorded setting';return heading+'\\nDirection: '+(body.direction||'confirm manually')+'\\n'+currentLabel+': '+current+'\\n'+proposedLabel+': '+proposed+'\\nEvidence shots: '+evidenceCount+'\\n\\n'+caution+'\\n'+(body.reason||'');}
  if(name==='references'){const sources=body.sources||[];return 'Reviewed recipe and grinder references\\n'+sources.map(source=>(source.title||source.publisher||'Reference')+'\\n'+(safeReferenceUrl(source.url)||'')+'\\n'+(source.scope?'Scope: '+(typeof source.scope==='object'?humanFacts(source.scope):source.scope):'')+'\\n'+(source.facts?'Facts: '+humanFacts(source.facts):'')+'\\n'+(Array.isArray(source.notes)?'Notes: '+source.notes.join(' '):'')).join('\\n\\n')+'\\n\\n'+(body.provenance||'');}
  if(name==='bean-context'){const bean=body.bean||{},batch=body.batch||{};if(body.status!=='available')return 'Bean context unavailable\\n'+(body.missingData||[]).join(', ');const nameLine=[bean.name,bean.roaster].filter(Boolean).join(' — ')||'Unknown bean';const species=bean.species?'\\nSpecies: '+bean.species:'';return 'Current bean catalog\\n'+nameLine+species+(bean.variety?'\\nVariety: '+(Array.isArray(bean.variety)?bean.variety.join(', '):bean.variety):'')+'\\nProcessing: '+(bean.processing||'unknown')+'\\nOrigin: '+[bean.country,bean.region].filter(Boolean).join(', ')+'\\nRoast: '+(batch.roastLevel||'unknown')+(batch.roastDate?' ('+batch.roastDate+')':'')+'\\n\\n'+(body.provenance||'');}
  if(name==='analysis'){const metrics=body.metrics||{},machine=metrics.machine||{},scale=metrics.scale||{};const mae=part=>Number.isFinite(part?.timeWeightedMae)?part.timeWeightedMae.toFixed(2):'unavailable';const feedback=body.feedback?(body.feedback.good?'good':'not marked good')+(body.feedback.flavour&&body.feedback.flavour.overall?', '+body.feedback.flavour.overall:''):'none';const measured=body.measuredBeanDose||metrics.measuredBeanDose;const measuredText=measured?'\\nBeans weighed for this shot: '+measured.weightG+' g ('+measured.deviceId+', '+measured.connectionRole+')':'\\nBeans weighed for this shot: none recorded';const warnings=(metrics.warnings||[]).concat(scale.warnings||[]);const warningText=warnings.length?'\\nWarnings: '+warnings.join(' | '):'';return 'Saved brew analysis: '+body.shotId+'\\nRecording elapsed (includes preheat/settling): '+(metrics.elapsedSec??'unavailable')+' s\\nAverage pressure difference from target: '+mae(machine.pressure)+' bar\\nAverage flow difference from target: '+mae(machine.flow)+' ml/s\\nAverage mix temperature difference from target: '+mae(machine.mixTemperature)+' °C\\nAverage group temperature difference from target: '+mae(machine.groupTemperature)+' °C\\nScale yield: '+(scale.finalMeasuredWeightG??'unavailable')+' g\\nScale flow: '+(scale.brewFlowGPerSec??'unavailable')+' g/s'+measuredText+'\\nMeasured bean ratio: '+((metrics.annotations&&metrics.annotations.actualYieldToMeasuredBeanDoseRatio)??'unavailable')+warningText+'\\n\\nThese are descriptive differences from recorded targets; they do not diagnose extraction.\\nFeedback: '+feedback+'\\n'+(body.provenance||'');}
  if(name==='feedback')return body.saved?'Feedback saved for shot '+body.shotId+'.':(body.reason||body.error||'Feedback was not saved.');
  return body.provenance?body.provenance+'\\n\\n'+JSON.stringify(body,null,2):JSON.stringify(body,null,2);
};
const feedbackFieldNames=['notes','taste','brewTimeSec','brewTimeClock','beanType','roastLevel','burrIdentity','calibrationEpoch','basket','settingUnit','beanBatchId','grinderId','grinderModel','dose','yield','overall','descriptors','acidity','bitterness','sweetness','body','astringency','brewTemperatureC','tastingTemperatureC','sinceBrewMin','beanScaleId','beanScaleRole','beanWeight','beanCapturedAt','beanSampleTimestamp'];
const clearFeedbackFields=()=>{const form=document.querySelector('#feedback');if(!form)return;feedbackFieldNames.forEach(name=>{const field=form.elements?.namedItem?.(name)||form.querySelector?.('[name="'+name+'"]');if(field)field.value='';});const good=form.elements?.namedItem?.('manualStopConfirmed')||form.querySelector?.('[name="manualStopConfirmed"]');if(good)good.checked=false;const confirmed=form.elements?.namedItem?.('confirmBeanMeasurement')||form.querySelector?.('[name="confirmBeanMeasurement"]');if(confirmed)confirmed.checked=false;if(typeof beanTimeHints!=='undefined'){delete beanTimeHints.beanCapturedAt;delete beanTimeHints.beanSampleTimestamp;}};
const hydrateFeedback=body=>{const form=document.querySelector('#feedback');if(!form)return;clearFeedbackFields();const saved=body?.feedback;selectedFeedbackBaseline=saved?JSON.parse(JSON.stringify(saved)):null;if(body?.shotId)selectedShotId=String(body.shotId);const put=(name,value)=>{const field=form.elements?.namedItem?.(name)||form.querySelector?.('[name=\"'+name+'\"]');if(field&&value!==undefined&&value!==null)field.value=String(value);};put('shotId',body?.shotId||selectedShotId);if(!saved)return;put('notes',saved.notes||'');put('taste',saved.taste||'');put('brewTimeSec',saved.brewTimeSec);put('brewTimeClock',saved.brewTimeClock||'pump');put('brewTemperatureC',saved.flavour?.brewTemperatureC);put('tastingTemperatureC',saved.flavour?.tastingTemperatureC);put('sinceBrewMin',saved.flavour?.sinceBrewMin);put('overall',saved.flavour?.overall||'');put('descriptors',Array.isArray(saved.flavour?.descriptors)?saved.flavour.descriptors.join(', '):'');['acidity','bitterness','sweetness','body','astringency'].forEach(key=>put(key,saved.flavour?.[key]));Object.entries(saved.confirmedContext||{}).forEach(([key,value])=>put(key,value));const stop=form.elements?.namedItem?.('manualStopConfirmed')||form.querySelector?.('[name=\"manualStopConfirmed\"]');if(stop)stop.checked=saved.manualStopConfirmed===true;const measured=saved.measuredBeanDose;if(measured){put('beanScaleId',measured.deviceId);put('beanScaleRole',measured.connectionRole||'auxiliary');put('beanWeight',measured.weightG);const captured=form.elements?.namedItem?.('beanCapturedAt')||form.querySelector?.('[name=\"beanCapturedAt\"]');const sample=form.elements?.namedItem?.('beanSampleTimestamp')||form.querySelector?.('[name=\"beanSampleTimestamp\"]');if(typeof prefillBeanTime==='function'){if(captured)prefillBeanTime('beanCapturedAt',captured,measured.capturedAt);if(sample&&measured.sampleTimestamp)prefillBeanTime('beanSampleTimestamp',sample,measured.sampleTimestamp);}else{put('beanCapturedAt',measured.capturedAt);put('beanSampleTimestamp',measured.sampleTimestamp);}const confirm=form.elements?.namedItem?.('confirmBeanMeasurement')||form.querySelector?.('[name=\"confirmBeanMeasurement\"]');if(confirm)confirm.checked=measured.userConfirmed===true;}};
const show=async(name,init,label)=>{const generation=++requestState.generation;out.textContent=label||'Loading...';try{const r=await fetch(endpoint(name),init);const body=await r.json();if(!r.ok){if(generation===requestState.generation)out.textContent=name==='feedback'?'Feedback was not saved. '+(body.error||'The request failed.')+' Reload the plugin if storage is unavailable, then retry.':body.error||'The request could not be completed.';return body;}if(generation===requestState.generation){out.textContent=render({endpoint:name,body});renderReferenceDetails(body.reviewedReferences);renderDialReference(body);if(name==='feedback'){adviceGeneration++;if(advice)advice.textContent='Feedback saved. Ask for the next setting using this updated taste assessment.';if(adviceResult)adviceResult.textContent='';}if(['suggestion','recommendation'].includes(name))renderBeginnerAdvice(body);if(name==='analysis'){latestAnalysis=body;hydrateFeedback(body);renderTraceGraph(body);updateCompareClock();updateAdviceClock();const recipe=document.querySelector('#nativeRecipeContext');if(recipe)recipe.textContent='Saved dose '+(body.context?.dose??'unknown')+' g; target yield '+(body.context?.yield??'unknown')+' g. Actual control mode: '+(body.metrics?.trace?.controlMode||'unknown')+'. Profile references below do not alter this saved evidence.';}if(['recommendation','suggestion','analysis'].includes(name))showNativeWizardStep(3);}return body;}catch(e){e.generation=generation;fail('Could not load this information. Try again.',generation);throw e;}};
let selectedShotId=null,selectedFeedbackBaseline=null,feedbackHydrationGeneration=0;const setShotId=(id,load=true)=>{const input=document.querySelector('#analysis input[name="shotId"]');const feedback=document.querySelector('#feedback input[name="shotId"]');if(selectedShotId&&id&&selectedShotId!==id){clearFeedbackFields();selectedFeedbackBaseline=null;}selectedShotId=id||selectedShotId;if(input&&id)input.value=id;if(feedback&&id)feedback.value=id;if(load&&id){const token=++feedbackHydrationGeneration;const buttons=typeof document.querySelectorAll==='function'?document.querySelectorAll('#feedback button'):[];buttons.forEach(button=>button.disabled=true);show('analysis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shotId:id})},'Loading saved feedback...').catch(e=>{if(token===feedbackHydrationGeneration)failRequest(e,'Could not load saved feedback. Try again.');}).finally(()=>{if(token===feedbackHydrationGeneration)buttons.forEach(button=>button.disabled=false);});}};
const refreshShots=async()=>{const generation=++requestState.generation;out.textContent='Loading recent shots...';try{const r=await fetch(endpoint('shots'));const body=await r.json();if(!r.ok)throw new Error('request failed');if(generation!==requestState.generation)return;const select=document.querySelector('#shotSelect');if(select&&typeof document.createElement==='function'){select.textContent='';(body.items||[]).forEach(shot=>{const option=document.createElement('option');option.value=String(shot.id);option.textContent=String(shot.id)+' — '+(shot.timestamp||'undated');select.appendChild(option);});if(body.items?.length)setShotId(String(body.items[0].id));}out.textContent='Loaded '+(body.items||[]).length+' recent shots. Choose one for analysis or feedback.';}catch(e){fail('Could not load recent shots. Try again.',generation);}};
document.querySelector('#recommend').onclick=async()=>{try{await show('recommendation',undefined,'Loading recommendation...')}catch(e){failRequest(e,'Could not load recommendation. Try again.')}};
document.querySelector('#suggestion').onclick=async()=>{try{await show('suggestion',undefined,'Calculating suggestion...')}catch(e){failRequest(e,'Could not calculate suggestion. Try again.')}};
document.querySelector('#beans').onclick=async()=>{try{await show('bean-context',undefined,'Loading bean context...')}catch(e){failRequest(e,'Could not load current bean context. Try again.')}};
const referencesButton=document.querySelector('#references');if(referencesButton)referencesButton.onclick=async()=>{try{await show('references',undefined,'Loading reviewed references...')}catch(e){failRequest(e,'Could not load references. Try again.')}};
const loadShotsButton=document.querySelector('#loadShots');
if(loadShotsButton)loadShotsButton.onclick=refreshShots;
const shotSelect=document.querySelector('#shotSelect');
if(shotSelect)shotSelect.onchange=e=>setShotId(e.target.value);
const feedbackShotInput=document.querySelector('#feedback input[name="shotId"]');
if(feedbackShotInput)feedbackShotInput.addEventListener('change',e=>setShotId(e.target.value));
document.querySelector('#analysis').onsubmit=async e=>{e.preventDefault();try{const shotId=new FormData(e.target).get('shotId');setShotId(shotId,false);await show('analysis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shotId})},'Analysing saved brew...')}catch(e){failRequest(e,'Could not analyse the brew. Try again.')}};
document.querySelector('#research').onsubmit=async e=>{e.preventDefault();let data;try{data=JSON.parse(new FormData(e.target).get('state'))}catch(e){fail('Research replay JSON is invalid.');return}try{await show('research',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)},'Replaying software state...')}catch(e){failRequest(e,'Could not run research replay. Try again.')}};
// Keep an untouched launch instant separate from its local calendar display:
// a daylight-saving fold can display two different instants as the same wall time.
const beanTimeHints={};
const prefillBeanTime=(key,input,value)=>{
  const date=new Date(value);
  if(/[T].*(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)&&Number.isFinite(date.getTime())){
    const pad=(number,width=2)=>String(number).padStart(width,'0');
    input.value=pad(date.getFullYear(),4)+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+'T'+pad(date.getHours())+':'+pad(date.getMinutes())+':'+pad(date.getSeconds())+'.'+pad(date.getMilliseconds(),3);
    if(input.value)beanTimeHints[key]={local:input.value,instant:value};
  }else input.value=value;
};
const beanTimeForFeedback=(key,value,date)=>beanTimeHints[key]?.local===value?beanTimeHints[key].instant:date.toISOString();
['beanCapturedAt','beanSampleTimestamp'].forEach(key=>{
  const input=document.querySelector('#feedback input[name="'+key+'"]');
  const edited=()=>{delete beanTimeHints[key];};
  input?.addEventListener('input',edited);input?.addEventListener('change',edited);
});
let feedbackBusy=false;const feedbackForm=document.querySelector('#feedback');const feedbackButtons=typeof document.querySelectorAll==='function'?document.querySelectorAll('#feedback button'):[];const resetFeedbackBusy=()=>{feedbackBusy=false;feedbackButtons.forEach(button=>button.disabled=false);};feedbackForm.onsubmit=async e=>{e.preventDefault();if(feedbackBusy)return;feedbackBusy=true;feedbackButtons.forEach(button=>button.disabled=true);try{const f=new FormData(e.target);const context={};['burrIdentity','calibrationEpoch','basket','settingUnit','beanBatchId','grinderId','grinderModel','beanType','roastLevel'].forEach(k=>{const v=f.get(k);if(v)context[k]=v});['dose','yield'].forEach(k=>{const v=f.get(k);if(v!=='')context[k]=Number(v)});const raw=f.get('brewTimeSec');const flavour={};const descriptors=f.get('descriptors');if(descriptors.trim())flavour.descriptors=descriptors.split(',').map(v=>v.trim()).filter(Boolean);const overall=f.get('overall');if(overall)flavour.overall=overall;['acidity','bitterness','sweetness','body','astringency','brewTemperatureC','tastingTemperatureC','sinceBrewMin'].forEach(k=>{const v=f.get(k);if(v!=='')flavour[k]=Number(v)});const measurementConfirmed=f.get('confirmBeanMeasurement')==='on'||f.get('confirmBeanMeasurement')==='true';let measuredBeanDose=null;if(measurementConfirmed){const weight=Number(f.get('beanWeight'));const capturedAt=f.get('beanCapturedAt');const scaleId=f.get('beanScaleId');const capturedDate=capturedAt?new Date(capturedAt):null;const sampleValue=f.get('beanSampleTimestamp');const sampleDate=sampleValue?new Date(sampleValue):null;if(!scaleId||!Number.isFinite(weight)||weight<=0||!capturedDate||Number.isNaN(capturedDate.getTime())||(sampleDate&&!Number.isFinite(sampleDate.getTime()))){throw new Error('Confirm a positive bean weight, scale ID and valid capture time.');}measuredBeanDose={deviceId:scaleId,connectionRole:'auxiliary',purpose:'beans',weightG:weight,units:'g',capturedAt:beanTimeForFeedback('beanCapturedAt',capturedAt,capturedDate),sampleTimestamp:sampleDate?beanTimeForFeedback('beanSampleTimestamp',sampleValue,sampleDate):null,userConfirmed:true};}const baseline=selectedFeedbackBaseline||{}, baselineFlavour=baseline.flavour&&typeof baseline.flavour==='object'?baseline.flavour:{}, editableFlavour=new Set(['acidity','bitterness','sweetness','body','astringency','brewTemperatureC','tastingTemperatureC','sinceBrewMin','overall','descriptors']), preservedFlavour=Object.fromEntries(Object.entries(baselineFlavour).filter(([key])=>!editableFlavour.has(key))), baselineContext=baseline.confirmedContext&&typeof baseline.confirmedContext==='object'?baseline.confirmedContext:{}, editableContext=new Set(['burrIdentity','calibrationEpoch','basket','settingUnit','beanBatchId','grinderId','grinderModel','beanType','roastLevel','dose','yield']), preservedContext=Object.fromEntries(Object.entries(baselineContext).filter(([key])=>!editableContext.has(key))), payload={...baseline,shotId:f.get('shotId'),good:(e.submitter?.value||'true')==='true',notes:f.get('notes'),taste:f.get('taste')||null,flavour:Object.keys({...preservedFlavour,...flavour}).length?{...preservedFlavour,...flavour}:null,brewTimeSec:raw===''?null:Number(raw),...(raw!==''?{brewTimeClock:f.get('brewTimeClock')||'pump'}:{}),manualStopConfirmed:f.get('manualStopConfirmed')==='on',confirmedContext:{...preservedContext,...context}};if(raw==='')delete payload.brewTimeClock;delete payload.measuredBeanDose;if(measuredBeanDose)payload.measuredBeanDose=measuredBeanDose;await show('feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)},'Saving feedback...');}catch(e){if(e.message&&e.message.startsWith('Confirm a positive'))fail(e.message);else failRequest(e,'Could not save feedback. Try again.');}finally{resetFeedbackBusy();}};
try{const query=new URLSearchParams(typeof location!=='undefined'&&location.search?location.search:'');const shotId=query.get('shotId');const action=query.get('action');if(shotId)setShotId(shotId,action!=='analyze');if(action==='analyze'&&shotId)show('analysis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shotId:shotId})},'Analysing saved brew...').catch(e=>failRequest(e,'Could not analyse the brew. Try again.'));if(action==='feedback'){const feedbackShot=document.querySelector('#feedback input[name=\"shotId\"]');if(feedbackShot&&feedbackShot.focus)feedbackShot.focus();}const measurementFields={beanScaleId:query.get('beanScaleId'),beanScaleRole:query.get('beanScaleRole')||'auxiliary',beanWeight:query.get('beanWeight'),beanCapturedAt:query.get('beanCapturedAt'),beanSampleTimestamp:query.get('beanSampleTimestamp')};Object.keys(measurementFields).forEach(key=>{const input=document.querySelector('#feedback input[name=\"'+key+'\"]');if(input&&measurementFields[key]){if(key==='beanCapturedAt'||key==='beanSampleTimestamp')prefillBeanTime(key,input,measurementFields[key]);else input.value=measurementFields[key];}});const returnValue=query.get('returnTo')||query.get('return');const returnLink=document.querySelector('#returnLink');if(returnLink&&returnValue){const here=typeof location!=='undefined'?new URL(location.href):new URL('http://127.0.0.1/');const target=new URL(returnValue,here.href);if((target.protocol===here.protocol&&(target.protocol==='http:'||target.protocol==='https:'))&&!target.username&&!target.password&&target.hostname===here.hostname&&target.pathname.startsWith('/')){returnLink.href=target.href;returnLink.hidden=false;}}}catch(e){}
// Final UI guards: the simple view starts collapsed, and a failed/new analysis
// cannot leave a previous shot's graph or comparison eligible for reuse.
if(typeof document.querySelectorAll==='function')document.querySelectorAll('.expert-panel').forEach(panel=>{panel.hidden=true;});
const clearAnalysisState=()=>{requestState.generation++;adviceGeneration++;latestAnalysis=null;const confirm=document.querySelector('#nativeAdviceConfirm');if(confirm)confirm.checked=false;updateAdviceClock();updateCompareClock();if(advice)advice.textContent='Analyse the selected shot and save its taste before asking for the next setting.';if(adviceResult)adviceResult.textContent='';const holder=document.querySelector('#traceGraph');if(holder)holder.hidden=true;const rows=document.querySelector('#comparisonRows');if(rows)rows.textContent='';};
document.querySelector('#analysis')?.addEventListener('submit',clearAnalysisState,true);document.querySelector('#shotSelect')?.addEventListener('change',clearAnalysisState,true);

try{if(localStorage.getItem('decaid-ui-mode')==='expert'&&modeToggle)modeToggle.click();modeToggle?.addEventListener('click',()=>{try{localStorage.setItem('decaid-ui-mode',modeToggle.getAttribute('aria-pressed')==='true'?'expert':'simple');}catch(_){}});}catch(_){/* private browsing can disable storage */}
const researchPanel=document.querySelector('#researchSharing');
if(researchPanel){
  const researchStatus=document.querySelector('#researchStatus');
  const researchRequest=async(method='GET',body)=>{
    const response=await fetch(endpoint('sharing'),{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Research settings unavailable');
    document.querySelector('#researchLocal').checked=result.localEnabled===true;
    document.querySelector('#researchEndpoint').value=result.endpoint||'';
    researchStatus.textContent=(result.sharing?'Remote sharing enabled. ':'Remote sharing off. ')+result.localCount+' local records; '+result.queuedCount+' pending uploads.'+(result.error?' '+result.error:'');return result;
  };
  const researchAction=async(method,body)=>{try{await researchRequest(method,body);}catch(error){researchStatus.textContent=error.message;}};
  researchPanel.addEventListener('toggle',()=>{if(researchPanel.open)void researchAction('GET');});
  document.querySelector('#researchLocal').addEventListener('change',event=>researchAction('POST',{operation:'local',enabled:event.target.checked}));
  document.querySelector('#researchEnable').addEventListener('click',()=>researchAction('POST',{sharing:true,endpoint:document.querySelector('#researchEndpoint').value.trim(),acknowledgeHostLimits:document.querySelector('#researchHostLimits').checked}));
  document.querySelector('#researchDisable').addEventListener('click',()=>researchAction('POST',{sharing:false}));
  document.querySelector('#researchRetry').addEventListener('click',()=>researchAction('POST',{operation:'retry'}));
  document.querySelector('#researchDelete').addEventListener('click',()=>researchAction('DELETE'));
  document.querySelector('#researchExport').addEventListener('click',async()=>{try{const response=await fetch(endpoint('sharing-export'));if(!response.ok)throw new Error('Research export unavailable');const output=document.querySelector('#researchExportData');output.textContent=JSON.stringify(await response.json(),null,2);output.hidden=false;}catch(error){researchStatus.textContent=error.message;}});
}

</script>`;

  return {
    id: ID,
    version: "0.6.0",
    onLoad(nextSettings) {
      sessionEpoch += 1;
      cacheGeneration += 1;
      active = true;
      settings = nextSettings || {};
      if (textOrNull(settings.GrinderProfileId)) selectedGrinderProfileId = textOrNull(settings.GrinderProfileId);
      grinderStorageUnavailable = false;
      grinderWriteBroken = false;
      grinderStorageReadStarted = false;
      startStorage();
      if (services.researchSharing || typeof createResearchSharing === "function") {
        researchClient = null; researchError = null; researchRetry = 30000; researchBusy = false;
        researchSeries = { current: null, shots: [] };
        void startResearch().ready.then(() => scheduleResearch()).catch(() => {});
      }
    },
    onUnload() {
      researchGeneration++;
      researchCaptures.clear();
      stopResearchTimer();
      researchWaiter?.reject(new Error("plugin unloaded"));
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
      grinderStorageUnavailable = true;
      grinderStorageWaiters
        .splice(0)
        .forEach((waiter) => waiter.reject(new Error("plugin unloaded")));
      grinderWriteWaiters
        .splice(0)
        .forEach((waiter) => waiter.reject(new Error("plugin unloaded")));
    },
    onEvent(event) {
      if (!active) return;
      if (event.name === "storageRead" && event.payload?.key === RESEARCH_KEY) {
        if (researchWaiter?.type === "read") researchWaiter.resolve(event.payload.value);
        return;
      }
      if (event.name === "storageWrite" && event.payload?.key === RESEARCH_KEY) {
        if (researchWaiter?.type === "write" && researchWaiter.token === event.payload.token) researchWaiter.resolve();
        return;
      }
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
      if (event.name === "storageRead" && event.payload?.key === GRINDER_STORAGE_KEY) {
        if (grinderStorageUnavailable || grinderStorageReady) return;
        const restored = grinderProfilesFromStorage(event.payload.value);
        if (!restored) {
          grinderStorageUnavailable = true;
          grinderStorageWaiters.splice(0).forEach((waiter) => waiter.reject(new Error("grinder profile storage unavailable")));
        } else {
          grinderProfiles = restored;
          const persistedSelection = textOrNull(event.payload.value?.selectedProfileId);
          selectedGrinderProfileId = persistedSelection && grinderProfiles[persistedSelection] ? persistedSelection : null;
          if (!textOrNull(settings.GrinderProfileId) && selectedGrinderProfileId)
            settings = { ...settings, GrinderProfileId: selectedGrinderProfileId };
          grinderStorageReady = true;
          grinderStorageWaiters.splice(0).forEach((waiter) => waiter.resolve());
        }
      }
      if (event.name === "storageWrite" && (event.payload?.key === GRINDER_STORAGE_KEY || (event.payload?.key == null && grinderWriteWaiters.length)) && !grinderWriteBroken) {
        const waiter = grinderWriteWaiters.shift();
        if (waiter) waiter.resolve();
      } else if (event.name === "storageWrite" && !storageWriteBroken) {
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
        if (event.name !== "workflowUpdated") void captureResearchShot(event.payload?.id || event.payload?.shot?.id);
      }
    },
    handleHttpRequest: async (request) => {
      const endpoint = request.endpoint || "";
      const requestSession = sessionEpoch;
      try {
        if (!active) throw new Error("plugin unloaded");
        if (endpoint === "ui" && request.method === "GET")
          return html(200, page);
        if (endpoint === "sharing" && ["GET", "POST", "DELETE"].includes(request.method)) {
          try { return json(200, await researchEndpoint(request)); }
          catch (error) { return json(400, { error: error.message, hostCapabilities: RESEARCH_HOST_LIMITS }); }
        }
        if (endpoint === "sharing-export" && request.method === "GET")
          return json(200, { ...(await startResearch().exportLocal()), hostCapabilities: RESEARCH_HOST_LIMITS });
        if (endpoint === "settings" && request.method === "GET") {
          await loadGrinderProfiles();
          return json(200, settings);
        }
        if (endpoint === "settings" && request.method === "POST") {
          const input = bodyOf(request);
          if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["GrinderProfileId"].includes(key)))
            return json(400, { error: "only grinder profile selection fields may be updated" });
          const profileId = textOrNull(input.GrinderProfileId);
          if (!profileId || profileId.length > 128) return json(400, { error: "GrinderProfileId is required" });
          await loadGrinderProfiles();
          if (!grinderProfiles[profileId]) return json(409, { error: "selected grinder profile is unavailable" });
          const previousSelection = selectedGrinderProfileId;
          const previousSetting = settings.GrinderProfileId;
          selectedGrinderProfileId = profileId;
          settings = { ...settings, GrinderProfileId: profileId };
          try { await persistGrinderProfiles(); }
          catch (error) {
            selectedGrinderProfileId = previousSelection;
            settings = { ...settings };
            if (previousSetting) settings.GrinderProfileId = previousSetting;
            else delete settings.GrinderProfileId;
            throw error;
          }
          return json(200, settings);
        }
        if (endpoint === "grinders" && (request.method === "GET" || request.method === "POST" || request.method === "DELETE")) {
          try { return json(200, await grinderProfilesEndpoint(request)); }
          catch (error) { return json(400, { error: error.message, code: "invalid_grinder_profile" }); }
        }
        if (endpoint === "shots" && request.method === "GET")
          return json(200, { ...(await fetchShots()), maxPages: MAX_PAGES });
        if (endpoint === "recommendation" && request.method === "GET")
          return json(200, await recommendation());
        if (endpoint === "suggestion" && request.method === "GET")
          return json(200, await suggestion());
        if (endpoint === "bean-context" && request.method === "GET")
          return json(200, await beanContext());
        if (endpoint === "grinder-observation" && request.method === "GET")
          return json(200, await grinderObservation());
        if (endpoint === "analysis" && request.method === "POST") {
          const input = bodyOf(request),
            id = textOrNull(input?.shotId);
          if (!id || id.length > 256)
            return json(400, { error: "shotId is required" });
          return json(200, await analysis(id));
        }
        if (endpoint === "coffee-catalog" && request.method === "GET")
          return json(200, createReferenceCatalog().coffeeCatalog || { schemaVersion: 1, sources: [], products: [] });
        if (endpoint === "profiles" && request.method === "GET")
          return json(200, createReferenceCatalog().decentProfiles || { schemaVersion: 1, profiles: [] });
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
          let timing;
          try {
            timing = timingFeedback(input);
          } catch (error) {
            return json(400, { error: error.message });
          }
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
                ...timing,
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
          void captureResearchShot(shotId);
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
