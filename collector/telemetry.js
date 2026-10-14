/* SPDX-License-Identifier: GPL-3.0-or-later */
"use strict";

// Optional standard OpenTelemetry SDK bootstrap. No request payload, headers,
// query string, client address, observation ID or event attributes are added.
const { trace, SpanStatusCode } = require("@opentelemetry/api");

const enabled = /^(1|true|yes)$/i.test(process.env.OTEL_ENABLED || "");
let sdk;
if (enabled) {
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    ((process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://alloy:4318") + "/v1/traces");
  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    serviceName: process.env.OTEL_SERVICE_NAME || "decaid-dialin-collector",
  });
  sdk.start();
  const shutdown = () => sdk.shutdown().catch(() => {});
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
}

function startHttpSpan(req, res) {
  if (!enabled) return null;
  const span = trace.getTracer("decaid-dialin-collector").startSpan("HTTP " + req.method, {
    attributes: { "http.request.method": req.method, "url.path": String(req.url || "").split("?", 1)[0] },
  });
  res.once("finish", () => {
    span.setAttribute("http.response.status_code", res.statusCode);
    if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  });
  return span;
}

module.exports = { startHttpSpan };
