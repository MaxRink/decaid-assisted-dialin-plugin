/* SPDX-License-Identifier: GPL-3.0-or-later */
"use strict";
// Reversible gauges over the current retained records, never event counters.
// Inputs are validated by the shared schema before reaching this module.
function createResearchMetrics(maxSeries = 20000) {
  let series = 0, available = true;
  const families = new Map();
  let touched = [];
  function add(name, help, labels, amount) {
    if (!available) return;
    if (!families.has(name)) families.set(name, { help, samples: new Map() });
    const samples = families.get(name).samples;
    const key = Object.keys(labels).sort().map(key => key + '=' + JSON.stringify(String(labels[key]))).join(',');
    if (!samples.has(key)) {
      if (series >= maxSeries) { available = false; families.clear(); series = 0; return; }
      series++;
    }
    touched.push([name, key]);
    const value = (samples.get(key) || 0) + amount;
    if (Math.abs(value) < 1e-8 && !name.endsWith("_sum") && !name.endsWith("_bucket")) { samples.delete(key); series--; } else samples.set(key, Math.abs(value) < 1e-8 ? 0 : value);
  }
  function observe(record, sign) {
    touched = [];
    if (!available) return;
    const mode = record.mode, kind = record.kind, model = record.grinder?.model || 'unknown';
    add('decaid_research_observations', 'Current retained observations by source, evidence mode and kind.', { source: record.source, mode, kind: record.kind }, sign);
    function category(field, value) {
      if (value != null) add('decaid_research_categories', 'Current observations with each closed category; categories do not imply causality.', { mode, kind, model, field, value }, sign);
    }
    for (const field of ['species', 'roast', 'process', 'decaf']) category('coffee_' + field, record.coffee?.[field]);
    category('control_mode', record.recipe?.controlMode);
    category('target_clock', record.recipe?.targetClock);
    category('taste_intent', record.taste?.intent);
    category('taste_overall', record.taste?.overall);
    category('taste_good', record.taste?.good);
    for (const field of ['interrupted', 'manualStopConfirmed', 'pumpComplete', 'pouringComplete']) category(field, record.measurements?.[field]);
    function value(quantity, number) {
      if (typeof number !== 'number' || !Number.isFinite(number)) return;
      add('decaid_research_measurement_sum', 'Sum of a named measurement in currently retained observations; quantity names include units.', { mode, kind, model, quantity }, sign * number);
      add('decaid_research_measurement_count', 'Current observations with a supplied measurement; missing values are excluded.', { mode, kind, model, quantity }, sign);
      const bounds = quantity.endsWith('_time_seconds') ? [10, 20, 25, 30, 35, 45, 60, 120, 600]
        : quantity === 'dose_grams' ? [10, 14, 16, 18, 20, 22, 25, 40, 100]
        : quantity === 'yield_grams' ? [15, 25, 35, 45, 60, 90, 150, 300]
        : quantity.endsWith('_temperature_celsius') ? [20, 40, 60, 80, 85, 90, 95, 100, 150] : null;
      if (bounds) for (const upper of [...bounds, Infinity]) {
        // Gauge buckets describe retained observations, not lifetime events.
        add('decaid_research_distribution_bucket', 'Cumulative gauge buckets of current measurements; never apply rate to these buckets.',
          { mode, kind, model, quantity, le: upper === Infinity ? '+Inf' : upper }, number <= upper ? sign : 0);
      }
    }
    const measured = {
      pumpTimeSec: 'pump_time_seconds', pouringTimeSec: 'pouring_time_seconds', recordingTimeSec: 'recording_time_seconds',
      preinfusionSec: 'preinfusion_seconds', doseG: 'dose_grams', yieldG: 'yield_grams', meanPressureBar: 'pressure_bar',
      meanMachineFlowMlPerSec: 'machine_flow_ml_per_second', meanBeverageFlowGPerSec: 'beverage_flow_grams_per_second',
      meanMixTemperatureC: 'mix_temperature_celsius', meanGroupTemperatureC: 'group_temperature_celsius',
      flowCoverageSec: 'flow_coverage_seconds', excludedSampleCount: 'excluded_samples'
    };
    for (const [field, quantity] of Object.entries(measured)) value(quantity, record.measurements?.[field]);
    value('tasting_temperature_celsius', record.taste?.tastingTemperatureC);
    value('tasting_delay_minutes', record.taste?.minutesAfterBrew);
    for (const field of ['acidity', 'bitterness', 'sweetness', 'body', 'astringency']) value('taste_' + field + '_rating', record.taste?.[field]);
    for (const field of ['setting', 'step', 'rpm']) {
      const number = record.grinder?.[field]; if (typeof number !== 'number') continue;
      const labels = { mode, kind, model, quantity: field, unit: field === 'rpm' ? 'rpm' : record.grinder.settingUnit };
      add('decaid_research_grinder_sum', 'Sum of current grinder values; keep models and coordinate units separate.', labels, sign * number);
      add('decaid_research_grinder_count', 'Current observations with a grinder value; not unique grinders or users.', labels, sign);
    }
    // One result per algorithm per observation. Structured comparison wins over
    // primary advice; the last duplicate algorithm in a supplied array wins.
    const approaches = new Map();
    if (record.advice?.algorithm) approaches.set(record.advice.algorithm, record.advice);
    for (const approach of record.approaches || []) approaches.set(approach.algorithm, approach);
    for (const [algorithm, approach] of approaches) {
      add('decaid_research_approaches', 'Current per-observation algorithm results; computed is not a recommendation.',
        { mode, kind, model, algorithm, status: approach.status || 'unavailable', coordinate_status: approach.coordinateStatus || 'unknown' }, sign);
      if (typeof approach.proposedSetting === 'number' && typeof record.grinder?.setting === 'number' &&
          approach.settingUnit === record.grinder.settingUnit && approach.settingUnit !== 'unknown' &&
          ['native', 'measured', 'estimated_relative', 'estimated_absolute'].includes(approach.coordinateStatus)) {
        const labels = { mode, kind, model, algorithm, unit: approach.settingUnit, coordinate_status: approach.coordinateStatus };
        add('decaid_research_recommendation_delta_sum', 'Sum of proposed minus current setting in the same explicit coordinate; estimates remain separately labeled.', labels, sign * (approach.proposedSetting - record.grinder.setting));
        add('decaid_research_recommendation_delta_count', 'Current algorithm results with comparable explicit current and proposed coordinates; not measured outcomes.', labels, sign);
      }
      if (approach.direction) add('decaid_research_directions', 'Current algorithm directions; these are proposals, not measured causal outcomes.', { mode, kind, model, algorithm, direction: approach.direction }, sign);
    }
    for (const phase of record.phases || []) {
      add('decaid_research_phases', 'Current phase summaries by recorded or inferred provenance; not unique shots.',
        { mode, kind, role: phase.role || 'unknown', source: phase.source || 'unknown' }, sign);
    }
    // Zero is a real value only while its corresponding population exists.
    // Prune touched groups so corrections cannot retain historical label sets.
    for (const [name, key] of available ? touched : []) {
      const countName = name.endsWith('_sum') ? name.slice(0, -4) + '_count' : name.endsWith('_bucket') ? 'decaid_research_measurement_count' : null;
      if (!countName) continue;
      const countKey = name.endsWith('_bucket') ? key.replace(/(?:^|,)le="[^"]*"/, '').replace(/^,/, '') : key;
      if (!(families.get(countName)?.samples.get(countKey) > 0) && families.get(name).samples.delete(key)) series--;
    }
    touched = [];
  }
  function render({ count, bytes, maxRecords, maxStorageBytes }) {
    const lines = [];
    function family(name, help, samples) {
      lines.push('# HELP ' + name + ' ' + help, '# TYPE ' + name + ' gauge');
      for (const [labels, value] of samples) lines.push(name + (labels ? '{' + labels + '}' : '') + ' ' + Number(value.toFixed(6)));
    }
    family('decaid_research_metrics_available', 'One when the complete research aggregate fits the fixed series budget; zero means research series are withheld until a successful rebuild.', [['', available ? 1 : 0]]);
    family('decaid_research_metric_series_limit', 'Maximum aggregate series retained in memory; storage gauges are separate.', [['', maxSeries]]);
    family('decaid_research_retained_records', 'Current private records, including records with missing optional metrics.', [['', count]]);
    family('decaid_research_storage_bytes', 'Current collector record bytes; excludes unrelated files and monitoring storage.', [['', bytes]]);
    family('decaid_research_record_limit', 'Configured maximum new observation count.', [['', maxRecords]]);
    family('decaid_research_storage_limit_bytes', 'Configured maximum collector record bytes.', [['', maxStorageBytes]]);
    for (const [name, data] of [...families].sort((a, b) => a[0].localeCompare(b[0]))) family(name, data.help, [...data.samples].sort((a, b) => a[0].localeCompare(b[0])));
    return lines.join('\n') + '\n';
  }
  return { observe, render };
}
module.exports = { createResearchMetrics };
