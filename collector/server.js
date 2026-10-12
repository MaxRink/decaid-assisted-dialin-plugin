/* SPDX-License-Identifier: GPL-3.0-or-later */
"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createResearchSharing } = require("../research-sharing.js");
const schema = createResearchSharing();
const { createResearchMetrics } = require("./metrics.js");
const FILE = /^research-([a-f0-9]{32})\.json$/;

async function createCollector(options = {}) {
  if (!options.directory) throw new Error("Private collector directory required");
  const directory = path.resolve(options.directory);
  const origins = new Set(options.allowedOrigins || []);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password)
      throw new Error("Allowed browser origins must be exact HTTPS origins");
  }
  const retentionDays = options.retentionDays ?? 30;
  const maxStorageBytes = options.maxStorageBytes ?? 256 * 1024 * 1024;
  const perMinute = options.perMinute ?? 60;
  const maxRecords = options.maxRecords ?? 100000;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 90 ||
      !Number.isInteger(maxStorageBytes) || maxStorageBytes < 1024 ||
      !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 1000000 ||
      !Number.isInteger(perMinute) || perMinute < 1 || perMinute > 10000) throw new Error("Invalid collector limits");
  const metricsEnabled = options.metricsEnabled === true;
  let metrics = createResearchMetrics(), metricsText = null;
  const now = options.now || Date.now;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Collector directory must be a real private directory");
  await fs.chmod(directory, 0o700);
  let storedBytes = 0, storedCount = 0, lastCleanup = 0, writing = Promise.resolve();
  const buckets = new Map();
  async function syncDirectory() {
    const handle = await fs.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function cleanup() {
    let bytes = 0, count = 0, changed = false;
    const rebuilt = createResearchMetrics();
    // Stream directory entries: a legacy over-cap directory must still be
    // prunable, without allocating an unbounded array or blocking the event loop.
    const entries = await fs.opendir(directory, { bufferSize: 32 });
    for await (const entry of entries) {
      const name = entry.name;
      // A stopped process may have left an unacknowledged temporary write.
      if (/^\.pending-[a-f0-9-]+$/.test(name)) { await fs.unlink(path.join(directory, name)); changed = true; continue; }
      const match = FILE.exec(name); if (!match) continue;
      const file = path.join(directory, name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unexpected collector data file");
      if (stat.mtimeMs < now() - retentionDays * 86400000) { await fs.unlink(file); changed = true; }
      else {
        bytes += stat.size; count++;
        if (metricsEnabled) {
          if (stat.size > 65536) throw new Error("Oversized stored record");
          const stored = schema.validateBatch(JSON.parse(await fs.readFile(file, "utf8")));
          if (stored.records.length !== 1 || stored.records[0].observationId !== match[1]) throw new Error("Invalid stored observation");
          rebuilt.observe(stored.records[0], 1);
        }
      }
    }
    storedBytes = bytes; storedCount = count;
    if (metricsEnabled) { metrics = rebuilt; metricsText = null; }
    if (changed) await syncDirectory();
    lastCleanup = now();
  }
  await cleanup();
  function limited(address) {
    const time = now();
    for (const [key, value] of buckets) if (time - value.start >= 60000) buckets.delete(key);
    if (!buckets.has(address)) {
      if (buckets.size >= 10000) return true;
      buckets.set(address, { start: time, count: 0 });
    }
    return ++buckets.get(address).count > perMinute;
  }
  function answer(res, status, value, origin) {
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Vary": "Origin" };
    if (origin && origins.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
    res.writeHead(status, headers); res.end(JSON.stringify(value));
  }
  const server = http.createServer({ maxHeaderSize: 8192, connectionsCheckingInterval: 1000 }, async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return answer(res, 403, { error: "Origin not allowed" });
    // Addresses are used only in a bounded, expiring in-memory abuse counter.
    if (limited(req.socket.remoteAddress || "unknown")) return answer(res, 429, { error: "Rate limit" }, origin);
    if (req.method === "GET" && req.url === "/healthz") return answer(res, 200, { status: "ok" }, origin);
    if (req.url !== "/v1/events") return answer(res, 404, { error: "Not found" }, origin);
    if (req.method === "OPTIONS") {
      if (!origin || req.headers["access-control-request-method"] !== "POST" ||
          String(req.headers["access-control-request-headers"] || "").split(",").some(value => value.trim() && value.trim().toLowerCase() !== "content-type"))
        return answer(res, 403, { error: "Preflight not allowed" }, origin);
      res.writeHead(204, { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin", "Cache-Control": "no-store" });
      return res.end();
    }
    if (req.method !== "POST") return answer(res, 405, { error: "Method not allowed" }, origin);
    if (req.headers.authorization || req.headers.cookie) return answer(res, 400, { error: "Send research without credentials" }, origin);
    if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json" || req.headers["content-encoding"])
      return answer(res, 415, { error: "Uncompressed JSON required" }, origin);
    if (Number(req.headers["content-length"]) > 65536) { answer(res, 413, { error: "Request too large" }, origin); req.resume(); return; }
    let size = 0, chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) { answer(res, 413, { error: "Request too large" }, origin); req.resume(); return; }
        chunks.push(chunk);
      }
      let batch;
      try { batch = schema.validateBatch(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (_) { return answer(res, 400, { error: "Invalid minimized research batch" }, origin); }
      const write = writing.then(async () => {
        if (now() - lastCleanup > 3600000) await cleanup();
        // Each random observation key owns one replaceable record. Retries and
        // stale corrections acknowledge without appending another observation.
        for (const record of batch.records) {
          const file = path.join(directory, "research-" + record.observationId + ".json");
          let previous = null, oldSize = 0;
          try {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe record file");
            previous = schema.validateBatch(JSON.parse(await fs.readFile(file, "utf8"))).records[0];
            oldSize = stat.size;
          } catch (error) { if (error.code !== "ENOENT") throw error; }
          if (previous && previous.revision >= record.revision) continue;
          const serialized = JSON.stringify({ schemaVersion: batch.schemaVersion, policyVersion: batch.policyVersion, records: [record] }) + "\n";
          const length = Buffer.byteLength(serialized);
          if ((!previous && storedCount >= maxRecords) || storedBytes - oldSize + length > maxStorageBytes) { const error = new Error("Storage limit"); error.capacity = true; throw error; }
          const temporary = path.join(directory, ".pending-" + randomUUID());
          try {
            const handle = await fs.open(temporary, "wx", 0o600);
            try { await handle.writeFile(serialized); await handle.sync(); }
            finally { await handle.close(); }
            await fs.rename(temporary, file);
            storedBytes += length - oldSize;
            if (!previous) storedCount++;
            if (metricsEnabled) { metricsText = null; if (previous) metrics.observe(previous, -1); metrics.observe(record, 1); }
          } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
        }
        // Includes a retried record whose earlier rename succeeded but whose
        // directory sync failed: never acknowledge it until this barrier passes.
        await syncDirectory();
      });
      writing = write.catch(() => {});
      try { await write; }
      catch (error) { return answer(res, error.capacity ? 507 : 503, { error: "Research storage unavailable" }, origin); }
      answer(res, 201, { accepted: batch.records.length }, origin);
    } catch (_) { if (!res.headersSent) answer(res, 400, { error: "Incomplete request" }, origin); }
  });
  if (metricsEnabled) {
    // Separate listener: no metrics route is attached to public ingestion.
    const metricsServer = http.createServer({ maxHeaderSize: 8192, connectionsCheckingInterval: 1000 }, async (req, res) => {
      const headers = { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      if (req.headers.origin) { res.writeHead(403, headers); return res.end("Browser access is disabled\n"); }
      if (req.method !== "GET" || req.url !== "/metrics") { res.writeHead(404, headers); return res.end("Not found\n"); }
      try {
        // Serialize with retention/writes, but never reread the directory on a scrape.
        const read = writing.then(() => {
          if (metricsText === null) metricsText = metrics.render({ count: storedCount, bytes: storedBytes, maxRecords, maxStorageBytes });
          return metricsText;
        });
        writing = read.then(() => {}, () => {});
        const body = await read;
        res.writeHead(200, headers); res.end(body);
      } catch (_) { res.writeHead(503, headers); res.end("Metrics unavailable\n"); }
    });
    metricsServer.requestTimeout = 10000; metricsServer.headersTimeout = 5000;
    metricsServer.keepAliveTimeout = 1000; metricsServer.maxHeadersCount = 32;
    metricsServer.maxConnections = 16;
    server.metricsServer = metricsServer;
    server.on("close", () => { metricsServer.closeAllConnections(); metricsServer.close(); });
  }
  const retentionTimer = setInterval(() => {
    const prune = writing.then(cleanup); writing = prune.catch(() => {});
  }, 3600000);
  retentionTimer.unref();
  server.on("close", () => clearInterval(retentionTimer));
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 32;
  return server;
}

if (require.main === module) {
  const directory = process.env.RESEARCH_DATA_DIR;
  const allowedOrigins = (process.env.RESEARCH_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
  createCollector({ directory, allowedOrigins, retentionDays: Number(process.env.RESEARCH_RETENTION_DAYS || 30),
    maxStorageBytes: Number(process.env.RESEARCH_MAX_STORAGE_BYTES || 268435456),
    maxRecords: Number(process.env.RESEARCH_MAX_RECORDS || 100000),
    perMinute: Number(process.env.RESEARCH_REQUESTS_PER_MINUTE || 60),
    metricsEnabled: !!process.env.RESEARCH_METRICS_PORT }).then(server => {
    const port = Number(process.env.PORT || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
    const bind = process.env.RESEARCH_BIND_HOST || "127.0.0.1";
    if (!["127.0.0.1", "0.0.0.0", "::1"].includes(bind)) throw new Error("Invalid RESEARCH_BIND_HOST");
    if (server.metricsServer) {
      const metricsPort = Number(process.env.RESEARCH_METRICS_PORT);
      const metricsBind = process.env.RESEARCH_METRICS_BIND_HOST || "127.0.0.1";
      if (!Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65535 || metricsPort === port ||
          !["127.0.0.1", "::1", "0.0.0.0"].includes(metricsBind)) throw new Error("Invalid private metrics listener configuration");
      server.metricsServer.listen(metricsPort, metricsBind);
    }
    server.listen(port, bind, () => process.stdout.write("Research collector listening on configured port " + port + "\n"));
  }).catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
}
module.exports = { createCollector };
