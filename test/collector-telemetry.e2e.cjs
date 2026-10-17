/* SPDX-License-Identifier: GPL-3.0-or-later */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { routeLabel, shutdownTelemetry } = require("../collector/telemetry.js");

function withTimeout(promise, milliseconds, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

test("telemetry records only bounded route labels", () => {
  assert.equal(routeLabel({ url: "/healthz" }), "/healthz");
  assert.equal(routeLabel({ url: "/v1/events?token=secret" }), "/v1/events");
  assert.equal(routeLabel({ url: "/private/user@example.test?secret=1" }), "unknown");
  assert.equal(routeLabel({ url: "/v1/events/" }), "unknown");
});

test("telemetry shutdown is safe when tracing is disabled", async () => {
  await assert.doesNotReject(shutdownTelemetry());
});

test("enabled telemetry exports bounded routes and exits cleanly on SIGTERM", async () => {
  const received = [];
  let exportObserved;
  const exportReady = new Promise(resolve => { exportObserved = resolve; });
  const receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => { received.push(Buffer.concat(chunks).toString("utf8")); exportObserved(); res.writeHead(200); res.end(); });
  });
  await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const collectorPort = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dialin-telemetry-test-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "collector", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, OTEL_ENABLED: "true", OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${receiver.address().port}/v1/traces`, OTEL_BSP_SCHEDULE_DELAY: "100", OTEL_METRICS_EXPORTER: "prometheus", OTEL_EXPORTER_PROMETHEUS_PORT: "19464", OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=private-marker", RESEARCH_DATA_DIR: directory, RESEARCH_ALLOWED_ORIGINS: "https://lab.example.org", RESEARCH_BIND_HOST: "127.0.0.1", PORT: String(collectorPort) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  child.stdout.on("data", data => output.push(data.toString()));
  const error = [];
  child.stderr.on("data", data => error.push(data.toString()));
  try {
    await withTimeout(new Promise((resolve, reject) => {
      child.stdout.on("data", data => { if (data.toString().includes("listening")) resolve(); });
      child.once("error", reject);
      child.once("close", (code, signal) => reject(new Error(`collector exited before start (${code}/${signal}): ${error.join("")}`)));
    }), 30000, `collector did not start: ${error.join("")}`);
    const port = output.join("").match(/port (\d+)/)?.[1];
    assert.ok(port, output.join(""));
    await fetch(`http://127.0.0.1:${port}/private/user@example.test?token=secret`);
    await fetch(`http://127.0.0.1:${port}/v1/events`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://lab.example.org", "X-Trace-Marker": "header-secret" }, body: JSON.stringify({ bodySecret: "body-secret" }) });
    await withTimeout(exportReady, 10000, "OTLP export did not arrive");
    assert.ok(received.length > 0, "OTLP receiver got no spans");
    assert.ok(received.every(body => !body.includes("user@example.test") && !body.includes("secret") && !body.includes("private-marker")));
    assert.ok(received.some(body => body.includes("unknown")));
    await assert.rejects(fetch("http://127.0.0.1:19464/metrics"));
    child.kill("SIGTERM");
    const result = await withTimeout(
      new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal }))),
      25000, "collector did not shut down within 25 seconds");
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, error.join(""));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await fs.rm(directory, { recursive: true, force: true });
    await new Promise(resolve => receiver.close(resolve));
  }
});
