# Research sharing and self-hosted collector

Research records contain bounded measurements and categories for later analysis. Collection does not make a recommendation scientifically validated. Measured shots, manually entered shots, fictional practice, and calculator replay carry separate `mode` values; an analyst must keep them separate.

The destination is unset by default. This repository supplies a collector and deployment configuration, but does not operate a public collection service.

## Your choices

| Control | Default | Effect |
| --- | --- | --- |
| Local research archive | On | Keeps up to 200 minimized observations in this browser or plugin's local storage. Export works without a server. |
| Share research | Off | Explicit consent enables a queue of future observations for the chosen HTTPS endpoint. Existing local observations are not backfilled. |
| Website: Send queued records | Manual action | Sends at most 25 queued observations per action; no background sending. |
| Plugin: automatic remote sharing | Off | After consent, sends future observations and retries queued failures while the plugin is running. Existing observations are not backfilled. |
| Stop sharing | — | Revokes sending and deletes the outgoing queue and its fingerprint ledger. The local archive remains available. |
| Stop local collection | — | Stops adding to the archive; existing archived records remain until deleted. |
| Delete all local research | — | Deletes archive, queue, and transport ledger; disables sharing. It does not erase the app's original saved shots or copies already received elsewhere. |

The outgoing queue holds at most 100 observations. Once full, new observations can still enter the local archive, but are not added to that queue; queued corrections can still replace their earlier values. Upload failure preserves the queue. A transport request that does not settle is abandoned at a 30 second deadline: the in-flight promise settles, `status().uploadError` says the upload timed out, and the next flush retries the same queued records. The deadline covers the transport only. Storage work is not wrapped, because a wedged disk is a storage failure and calling it a transport timeout would be a lie: storage adapters must acknowledge or reject, and the shipped plugin adapter already times out after five seconds. The website requires an explicit retry; the opted-in plugin retries automatically while running. Read or write failure is visible, is reported in `status().error`, and disables runtime sending; a transport failure is reported separately in `status().uploadError` and never disables sharing. A failed storage write cannot guarantee the changed preference will survive a restart; resolve the storage error before relying on persistence.

When local collection is off but sharing is on, a bounded local-only ledger of up to 200 keys, revisions and non-security content fingerprints suppresses duplicate uploads after reload. Neither those local keys nor fingerprints leave the device. With both controls off, new captures persist neither records nor a fingerprint ledger. Turning sharing off deletes its ledger. Older archived records are removed only by Delete all or normal bounded-archive eviction.

In the plugin, enabling remote sharing (which sets the collector address) and deleting local research data are accepted only from the plugin's own page: the request must carry a browser `Origin` naming the host that serves the plugin. A LAN client without that header, such as `curl`, gets 403 `plugin_page_required`; opting out stays possible from any client.

Opting out fences stale acknowledgments immediately. A request already received by the server cannot be recalled. Browsers can abort a request where supported; the current Decaid host bridge cannot enforce abort or redirect controls and requires the plugin's separate acknowledgment of those limits before remote sharing. This is data minimization, not a promise of network anonymity: the collector, reverse proxy, hosting provider, and network still observe connection metadata such as an IP address.

## What a record can contain

The shared allowlist is implemented in [`research-sharing.js`](../research-sharing.js). Both client capture and the collector use that implementation. Numeric values must be finite, within field-specific bounds, and rounded to at most three decimals. Strings are closed categories, except randomly generated research keys. Invalid optional values are omitted during client minimization; unknown fields or values in a submitted batch cause collector rejection.

| Section | Allowed research information |
| --- | --- |
| Provenance | Website/plugin; measured/manual/practice/replay; shot/feedback/advice/setting change/flow summary. |
| Grinder | Catalog model category, labeled setting coordinate and step, owner-confirmed finer direction, RPM, burr size/geometry. All 16 reviewed catalog models are accepted, plus EK43/other/unknown. |
| Recipe | Control mode, target clock, categorical profile family and preinfusion provenance; target time/dose/yield/temperature/pressure/machine flow. |
| Measurements | Pump/pouring/recording durations and completeness; preinfusion time; dose/yield; mean pressure, machine flow in ml/s, beverage flow in g/s, temperatures, coverage and excluded-sample count; interrupted/manual-stop flags. |
| Coffee | Species, roast and process categories, decaf flag, days after roast. No coffee or roaster name. |
| Taste | Explicit preference/overall assessment, optional good flag, descriptive intensity ratings, tasting temperature and elapsed minutes after brew. A good flag is not inferred to mean balanced. |
| Advice | Algorithm, direction, suggestion/hold/collecting/computed/retained/abstain/invalid/unavailable status, proposed setting with its native coordinate, evidence count, and native/measured/estimated-relative/estimated-absolute/unknown coordinate provenance. |
| Approaches | Up to 11 independently categorized calculator/native-response results using the same fields as advice. No explanations or raw calculator inputs. |
| Phases | Up to 12 categorical phase summaries: role/source/controller; relative start/end/duration/coverage; mean/target pressure and flow; mean temperature. |

There are no free-text notes, bean/roaster/profile names, host shot IDs, device or user IDs, serial numbers, credentials, URLs, raw timestamps, or raw trace arrays. Setting numbers without a recognized unit are removed. Summary collection does not grant permission to treat pump flow as beverage flow, infer extraction from acidity, or bypass the application's controller/clock/completeness gates.

Each captured observation gets a random 128-bit hexadecimal `observationId` and positive integer `revision`. These are data-record keys, not person/device identifiers. A local shot key maps to that random key only on the device; correcting feedback preserves the random observation key and increases its revision. The collector retains the highest revision, so a lost acknowledgment and retry do not append another observation. Deduplication is bounded by local ledger/archive retention and server retention; it is not an unbounded exactly-once guarantee.

An optional `researchSeries` is a separately random 128-bit key for a short, comparable shot sequence. Generate it with `schema.randomId()` when starting a new sequence and rotate it when that sequence/context is reset. Never derive either key from a bean label, host shot ID, user, installation, or device. An optional integer `shotOrdinal` from 1 to 10000 records the position within that series; it is retained only alongside a valid series key. Records carry no persistent visitor identifier (see [Collector enrolment](#collector-enrolment) for the separate upload token). Random keys use platform cryptographic randomness when available, with independent `Math.random` words as the QuickJS fallback; they are not authentication secrets. Records with the same series can deliberately be related within that research sequence.

## Shared factory integration

The factory has no imports and can be embedded directly in the plugin bundle. Node consumers use `require('../research-sharing.js').createResearchSharing`; the browser can load the same source as a script. Keep the generated plugin copy synchronized rather than maintaining another sanitizer.

```js
const schema = createResearchSharing();
const client = schema.createClient({
  load: async () => readResearchState(),
  save: async state => writeAndAcknowledgeResearchState(state),
  send: (url, options) => fetch(url, options)
});
await client.ready;
await client.capture(minimizedInput, localOnlyShotKey);
await client.setLocalCollection(false); // does not erase existing archive
await client.setSharing(true, 'https://research.example.org/v1/events');
// Capture future observations; only an explicit user action calls flush:
await client.flush();
const exported = await client.exportLocal();
await client.setSharing(false); // clears queue, leaves archive
await client.clear(); // deletes all local research and revokes sharing
```

`status()` reports `error` for storage problems and `uploadError` for the last transport attempt. Messages the module produces are scrubbed of the values it holds: the configured destination, its authority and host, and every collector token stored for it, each replaced with `<redacted>` wherever it appears (whole, as a bare host, or glued to other text). The same text is used for the rejection the caller receives. This is provenance, not detection: text a transport invents that merely resembles a secret, or a secret this client does not hold, is not recognised. Also available: `status()`, `append(record)`, `sanitizeRecord(record)`, strict `validateRecord`/`validateBatch`, `validateEndpoint`, `randomId`, and documented limits. `capture(record, key)` replaces a matching local/queued observation; unchanged content is a no-op, including after a successful upload/reload. The local key may be any nonempty string of at most 256 characters and is never included in an export/upload. Caller-supplied observation identities are ignored by capture.

Adapters are optional except `load` and `save`: `reload` and `withLock` coordinate tabs, `send` performs the HTTPS request, `randomId` supplies observation identities, and `timer`/`cancelTimer`/`uploadDeadlineMs` supply the deadline scheduler. `timer(callback, ms)` returns a handle and `cancelTimer(handle)` clears it; without them the factory falls back to `setTimeout`/`clearTimeout`, and in a runtime that has neither (the documented QuickJS shape) no deadline is armed and a stalled transport is never abandoned, exactly as before this deadline existed. The deadline is therefore conditional on a timer being available. Where the runtime also provides `AbortController`, an expired request is aborted through it; the shipped plugin passes no `timer` or `cancelTimer` and relies on the host's global `setTimeout`, drops `init.signal` in its own transport adapter, and advertises `requestCancellation: false`, so there the deadline settles the client state but does not cancel the host request in flight. The module and the website do abort. Storage adapters must acknowledge durable success or reject. Consent policy/schema mismatches and corrupt persisted state fail closed. `setSharing` clears the queue and transport ledger on each call; integration controls should invoke it only for a real consent/endpoint change. A changed endpoint requires a new explicit choice. It never starts sending by itself. A valid destination uses HTTPS, no credentials, query, or fragment; there is no built-in destination.

A response that arrives after the deadline is ignored for queue purposes: the abandoned attempt does not acknowledge records that nobody is waiting for, so the queue stays for the retry and `uploadError` keeps reporting the timeout until an attempt actually succeeds. Re-sending those records is harmless because the collector keeps the newest revision for an observation and skips an older or equal one, so a retry replaces rather than duplicates. The deadline itself cannot make a wedged storage adapter observable: `status()` refreshes under the same storage lock, so an adapter that never acknowledges or rejects blocks `status()` too, exactly as it did before the deadline existed. The shipped plugin bounds that in practice, because its storage adapter rejects after five seconds. The website simulator coordinates its browser tabs with an exclusive Web Lock and reloads the persisted state immediately before every storage operation. A storage event only refreshes the visible controls; it is not the safety boundary. This prevents a stale tab from sending or restoring a queue after another tab opted out or deleted it, while preserving captures made by concurrent tabs. Browsers without Web Locks fail closed for research archiving and sharing; the controls are disabled and existing stored records remain untouched until a supported browser is used.

Browser fetch options request omitted credentials, rejected redirects, no referrer, and no cache. The current Decaid native fetch bridge forwards only method, URL, headers and body; it does not enforce browser-only options or expose redirect history. The native integration must disclose that limitation and require its acknowledgment. Neither the factory nor this collector provides authentication, an account, cookies, or fingerprinting.

## Deploy on your own server

Use a server and DNS hostname you control. The included Compose deployment runs the collector privately behind Caddy TLS and stores received records in a private named volume. It exposes ports 80 and 443; it does not expose the Node collector port or a data browsing endpoint. Configure the hostname's DNS to reach that server and allow certificate validation traffic. Caddy's prerequisites and certificate behavior are described in its [automatic HTTPS documentation](https://caddyserver.com/docs/automatic-https).

From the repository root on that server:

```sh
cp collector/.env.example collector/.env
# Edit collector/.env: your DNS hostname and exact allowed website origin(s).
docker compose --env-file collector/.env -f collector/compose.yaml config
docker compose --env-file collector/.env -f collector/compose.yaml up --build -d
```

Use `https://YOUR_HOSTNAME/v1/events` as the user-selected sharing endpoint. `https://YOUR_HOSTNAME/healthz` returns a small health response. A GitHub Pages origin is the site origin, for example `https://your-user.github.io`, without its repository path. The `.env` file is ignored by Git. The collector uses the official [Node image](https://github.com/nodejs/docker-node/blob/main/README.md) with unused npm tooling removed. The [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) is built from locked source dependencies with patched Go and HTTP/2 libraries; see the [build and update instructions](../collector/caddy/README.md). Both services have read-only root filesystems and restricted capabilities; their named data volumes remain writable. Pin reviewed base-image digests for a controlled deployment and keep dependencies updated.

Caddy has no access-log directive and both services disable Docker log retention in this example. The proxy strips Cookie, Authorization and X-Real-IP, and replaces any client-supplied X-Forwarded-For with the single address it observed, for the collector's in-memory rate limit. The Node collector does not log requests or persist request headers/IP addresses. Verify any additional CDN, load balancer, firewall and hosting logs separately; this configuration cannot erase another operator's logs. If you enable operational logs while troubleshooting, review their contents and retention before allowing research submissions.

For an existing TLS reverse proxy, Node can run directly without dependencies:

```sh
RESEARCH_DATA_DIR=/srv/decaid-research/private \
RESEARCH_ALLOWED_ORIGINS=https://your-user.github.io \
node collector/server.js
```

Run as a dedicated unprivileged account with write access only to the private directory. Bind defaults to `127.0.0.1:8787`; forward only `/v1/events` and `/healthz` over HTTPS. Use a process supervisor and the same metadata/logging policy. Never put the private data directory under a web document root. Run exactly one collector writer for a directory; multi-process/shared-filesystem concurrency is not supported.

| Environment variable | Default / constraints |
| --- | --- |
| `RESEARCH_DATA_DIR` | Required private directory; created/chmod 0700; stored records 0600. |
| `RESEARCH_ALLOWED_ORIGINS` | Comma-separated exact HTTPS browser origins; no wildcard. Compose requires a value. |
| `RESEARCH_RETENTION_DAYS` | 30; integer 1–90. |
| `RESEARCH_MAX_RECORDS` | 100000; integer 1–1000000. New observation keys stop at this cap; revisions/retries remain eligible. |
| `RESEARCH_MAX_STORAGE_BYTES` | 268435456 (256 MiB); integer at least 1024. |
| `RESEARCH_REQUESTS_PER_MINUTE` | 60; integer 1–10000 per client address (see `RESEARCH_TRUSTED_PROXIES`). |
| `RESEARCH_TRUSTED_PROXIES` | Unset: rate limits use the socket address. Comma-separated proxy IP addresses whose `X-Forwarded-For` (last entry) names the client. The bundled compose file pins Caddy to `172.30.87.2` and sets this. |
| `RESEARCH_MAX_CONNECTIONS` | 128; integer 1–10000 simultaneous public ingestion sockets. |
| `RESEARCH_BIND_HOST` | `127.0.0.1`; alternatively `::1` or `0.0.0.0` (container only in the supplied deployment). |
| `PORT` | 8787; integer 1–65535. |
| `RESEARCH_DOMAIN` | Compose/Caddy hostname; required for the bundled TLS deployment. |

A browser Origin, if supplied, must match the allowlist. Native plugin requests without Origin are deliberately accepted. CORS is not authentication: arbitrary non-browser clients can enrol and submit allowed numeric/category records. Do not treat submissions as verified experiments or trusted training labels. There is no public catalog or raw-record read API. Put an additional operator-controlled ingress restriction in front if the research deployment needs a closed participant group; do not add personal tokens to research records.

Requests require uncompressed JSON, have a 64 KiB body limit, an 8 KiB header limit, and a maximum of 25 records. The public listener has a bounded simultaneous connection cap (`RESEARCH_MAX_CONNECTIONS`) in addition to connection/header/request timeouts and bounded in-memory abuse counters. Counters use the socket address, or the last `X-Forwarded-For` entry only when the socket peer is listed in `RESEARCH_TRUSTED_PROXIES`; anyone else's forwarded header is ignored. Addresses live only in the bounded, one-minute in-memory counter table and are never written to disk or logs. When the table is full the oldest window is dropped, so new clients are not refused because of it.

### Collector enrolment

Before its first upload, a client sends `{"schemaVersion":1,"policyVersion":1,"enrol":true}` to the same endpoint and receives a random 256-bit `token`. Enrolment stores nothing. Every upload then carries the token in an `X-Research-Token` header; an upload without one gets 401 `enrolment_required`. The collector stores, with each observation, a SHA-256 digest of its observation key and that token, never the token itself, so the stored digests do not link one installation's observations. A later upload of the same observation key with a different token is refused with 403 `observation_owned`, so nobody else can overwrite or "correct" your records. Observations stored before enrolment existed have no owner; the first enrolled upload of that key claims it. The client keeps the token per collector in its local research storage (plugin storage in Decaid, browser storage on the website), sends it to no other collector, never puts it in records or exports, and deletes it with **Delete all local research data**. The collector sees the token on each request, so uploads from one installation are linkable while they arrive; it is an upload credential, not research data. Tokens are issued to anyone who asks: they prevent overwriting, they do not restrict who may contribute.

The byte or observation-count cap returns HTTP 507 and keeps unsent client data queued. Other storage errors return 503. Each accepted observation is written with a temporary file, file sync, atomic rename and parent-directory sync before acknowledgment. A directory-sync failure returns 503; retry must pass that sync even when the record already exists. These filesystem barriers require a filesystem that supports directory fsync; storage hardware and backups remain operator responsibilities. On startup and hourly retention, a stored file that is unreadable or fails validation is skipped and named (never quoted) on stderr instead of stopping the collector; it still counts toward the storage budget and is removed by retention. Batch failure can occur after some records were stored; retry is safe because the same keys/revisions replace or acknowledge those observations. A received older/equal revision does not overwrite a newer correction. Successful acknowledgment counts every accepted observation, including retries. The server never echoes submitted free text in an error.

## Retention, analysis and deletion

Retention is based on each observation file's last update. Expired collector-owned records are removed at startup, before ingestion when due, and by an hourly timer while the process runs. Cleanup streams directory entries with a fixed buffer and still prunes a legacy directory above the configured count cap. Above-cap live data permits revisions/retries but blocks new keys until retention or administrator deletion frees capacity; it does not permanently prevent startup or pruning. After downtime, cleanup occurs on the next start. A correction refreshes that observation's retention. There is no per-user lookup because there is no user identifier; the collector has no remote deletion API. Opt-out deletes local queued data, not already received records. Administrators can delete a specific known random observation file, or the whole private dataset, through their server's filesystem administration. Coordinate maintenance while the collector is stopped.

Only the server administrator can access the private `research_data` volume. Analyze copies in an access-controlled workspace, preserving mode, units, controller/clock provenance, missingness and revision semantics. Do not publish individual records or sequence keys as a public catalog. An aggregate export is a separate reviewed research operation; no automatic analysis or publication job is included.

To stop the deployment without deleting data:

```sh
docker compose --env-file collector/.env -f collector/compose.yaml down
```

To delete received research, stop the collector and remove only its explicitly identified `research_data` volume through your container administration tooling. Inspect its project/name before deletion. Do not remove Caddy's certificate volumes or unrelated volumes as a shortcut. Backups/snapshots require their own retention/deletion policy; removing live files does not remove backup copies.

## Verification and scope

Run `node --test test/research-sharing.test.js test/research-sharing-deadline.test.js test/research-collector.test.js`. Tests cover minimization, all catalog model coordinates, consent/storage failures, bounded queues, corrections/races, upload deadlines and message redaction, retry/restart idempotence, exact origins, request/storage limits, private permissions, retention, and real local HTTP ingestion. The existing `npm test` includes these files automatically.

This implementation has been exercised with local HTTP integration tests. The deployment configuration is provided for your server; this change does not provision DNS, issue production certificates, start a public collector, or verify an external host. Browser/native integration tests belong to their respective app/runtime suites.

## Private aggregate monitoring

The maintained homelab collector endpoint is
`https://dialin-collector.private-testumgebung.de/v1/events`. It is an
explicit opt-in destination; the client does not enable sharing or upload data
merely because this URL is documented. Keep the endpoint private to the
minimized research schema and do not use it as a general application API.

See [research metrics and Grafana deployment](RESEARCH_METRICS.md) for the optional private Prometheus listener, revision-aware retained-data distributions, bounded label budget and populated dashboard examples. No metrics route is exposed by the public collector/Caddy endpoint.
