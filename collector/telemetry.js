/* SPDX-License-Identifier: GPL-3.0-or-later */
"use strict";

// Optional standard OpenTelemetry SDK bootstrap. No request payload, headers,
// query string, client address, observation ID or user-controlled URL path is
// added. Telemetry is deliberately opt-in and resource auto-detection is off
// so process arguments and environment values cannot become resource labels.
const { trace, SpanStatusCode } = require("@opentelemetry/api");

const enabled = /^(1|true|yes)$/i.test(process.env.OTEL_ENABLED || "");
let sdk;
if (enabled) {
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    ((process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://alloy:4318") + "/v1/traces");
  // The SDK also reads signal selection from the process environment during
  // start(). Override ambient values so a deployment cannot open a metrics or
  // logs listener merely because its environment contains OTEL_* settings.
  process.env.OTEL_METRICS_EXPORTER = "none";
  process.env.OTEL_LOGS_EXPORTER = "none";
  sdk = new NodeSDK({
    // Keep exporter retries from extending process shutdown beyond the
    // collector's bounded drain window. Spans are best-effort diagnostics.
    traceExporter: new OTLPTraceExporter({ url: endpoint, timeoutMillis: 4000 }),
    serviceName: process.env.OTEL_SERVICE_NAME || "decaid-dialin-collector",
    autoDetectResources: false,
    // This service intentionally exports traces only. Explicit empty signal
    // lists prevent ambient OTEL_* settings from opening listeners/processors.
    metricReaders: [],
    logRecordProcessors: [],
  });
  sdk.start();
}

function routeLabel(req) {
  const path = String(req?.url || "").split("?", 1)[0];
  return path === "/healthz" || path === "/v1/events" ? path : "unknown";
}

function shutdownTelemetry() {
  if (!sdk) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const timer = setTimeout(finish, 5000);
    timer.unref?.();
    sdk.shutdown().catch(() => {}).finally(() => { clearTimeout(timer); finish(); });
  });
}

function startHttpSpan(req, res) {
  if (!enabled) return null;
  const span = trace.getTracer("decaid-dialin-collector").startSpan("HTTP " + req.method, {
    attributes: { "http.request.method": req.method, "http.route": routeLabel(req) },
  });
  res.once("finish", () => {
    span.setAttribute("http.response.status_code", res.statusCode);
    if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  });
  return span;
}

module.exports = { routeLabel, startHttpSpan, shutdownTelemetry };
