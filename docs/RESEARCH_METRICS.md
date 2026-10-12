# Private research metrics and Grafana dashboard

The optional collector exporter describes the **current retained research dataset**. It includes shot-clock distributions, dose/yield and temperature distributions, separate machine/beverage flow summaries, grinder coordinates, taste categories, and all reported algorithm results. It exports no record/series IDs, ordinal, revision, raw values as labels, names, timestamps, IP addresses or device identifiers.

The [example dashboard](../collector/monitoring/grafana/dashboards/research-overview.json) defaults to `kind=shot` and manual/measured evidence. Algorithm/taste panels also follow the grinder filter; the retained-record overview is explicitly labeled as all grinders. Its evidence-mode selector can explicitly include fictional practice or replay. Different grinder models and native units remain separate in measurement/delta legends. Taste describes the current observation; a next-shot proposal is not its measured outcome, and the dashboard makes no causal algorithm-success claim.

## Semantics and resource limits

Every exported sample is a **gauge**, including `_sum`, `_count` and `_bucket`. They are snapshots of retained observations, not monotonically increasing event counters. Do not apply `rate()` or `increase()`. A correction subtracts its previous contribution and adds the latest revision; equal/older retries do not add anything. A restart streams existing validated records to reconstruct the same aggregate. Retention rebuilds it after deleting expired records, so counts can decrease.

Missing values are excluded rather than converted to zero. Actual zero sums remain present while their count is positive. Histogram thresholds include zero-count buckets and `+Inf`; quantiles are interpolated bucket estimates. These thresholds are display/analysis bins, not espresso quality targets.

| Metric family | Meaning and important labels |
| --- | --- |
| `decaid_research_metrics_available` | 1 for a complete aggregate; 0 when the fixed series budget was exceeded. |
| `decaid_research_retained_records` | All current private observation files, not unique users/grinders. |
| `decaid_research_storage_bytes`, `*_storage_limit_bytes`, `*_record_limit` | Current storage and configured limits. |
| `decaid_research_observations` | Counts by source, evidence mode and observation kind. |
| `decaid_research_measurement_sum`, `*_measurement_count` | Means use sum/count; labels keep kind, mode, model and physical quantity separate. |
| `decaid_research_distribution_bucket` | Cumulative retained-data buckets for pump/pouring/recording time, dose, yield and observed temperatures. |
| `decaid_research_grinder_sum`, `*_grinder_count` | Current setting, step and RPM summaries; model/unit labels must remain separate. |
| `decaid_research_categories` | Closed coffee, controller/clock, taste and completeness categories. Unknown/missing is not false. |
| `decaid_research_approaches` | Per-observation algorithm result/status/coordinate-provenance counts. One entry per algorithm; structured comparisons take precedence over primary advice. |
| `decaid_research_directions` | Proposed finer/coarser/none counts by algorithm; not accepted physical changes. |
| `decaid_research_recommendation_delta_sum`, `*_recommendation_delta_count` | Proposed minus current setting only with equal explicit units and known native/measured/estimated provenance. Positive does not universally mean coarser. |
| `decaid_research_phases` | Phase-summary counts by role and provenance; not unique shot counts. |

Example pump-time mean, for measured shot records only:

```promql
sum by (model) (decaid_research_measurement_sum{kind="shot",mode="measured",quantity="pump_time_seconds"})
/
sum by (model) (decaid_research_measurement_count{kind="shot",mode="measured",quantity="pump_time_seconds"})
```

Example retained-population median:

```promql
histogram_quantile(0.5,
  sum by (model, le) (decaid_research_distribution_bucket{
    kind="shot",mode="measured",quantity="pump_time_seconds"
  })
)
```

These use the [Prometheus text exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/) and ordinary PromQL. Time-series charts show how the retained population changes at scrape time; they are not individual-shot timelines.

Labels come only from the shared schema's finite enums or fixed metric definitions. A second, hard **20,000 active-series** budget bounds the allowed Cartesian combinations. Corrections discard orphaned sums/buckets rather than retaining historic labels. On overflow the aggregate map is discarded, ingestion and private records continue normally, and only availability/storage/count/limit gauges remain. HTTP 200 and Prometheus `up=1` then mean the endpoint works, **not** that research data is available: alert on `decaid_research_metrics_available != 1`. The dashboard shows a prominent red unavailable banner and withholds plots rather than presenting partial data as zero.

A scheduled hourly retention rebuild or a restart can restore availability after corrections, retention or administrator cleanup reduce the active groups. There is no automatic upward budget adjustment or public rebuild route. An individual correction does not trigger a full disk scan to recover an over-budget exporter. This fixed resource contract is deliberate; operators needing a larger multidimensional dataset should use controlled offline analysis of the private records.

Enabling metrics adds one bounded-memory streaming read of retained records at startup and each hourly cleanup. Successful writes apply reversible updates; repeated scrapes use cached exposition until the dataset changes. Scrapes do not reread files. The separate listener allows at most 16 connections and has the same header/request limits as ingestion. Files exceeding 64 KiB, malformed stored records or mismatched record identities fail validation rather than entering metrics. Keep one writer for the private directory.

## Enable a private listener

Metrics are off unless `RESEARCH_METRICS_PORT` is explicitly set. Direct Node example:

```sh
RESEARCH_DATA_DIR=/srv/decaid-research/private \
RESEARCH_METRICS_PORT=8788 \
node collector/server.js
```

`RESEARCH_METRICS_BIND_HOST` defaults to `127.0.0.1`; `::1` is also allowed. `0.0.0.0` is an explicit opt-in intended for a private container network. The metrics port must differ from ingestion. `GET /metrics` exists only on this separate listener; the public ingestion listener returns 404, and the supplied Caddy configuration has no metrics route. Browser Origin requests are rejected and no CORS headers are provided. There is no metrics authentication: use loopback/private networking and an authenticated administrative path, never expose this port publicly.

Aggregates can still reveal small cohorts. Keep Prometheus and Grafana private even though labels contain no personal identifiers. Do not publish these dashboards as a public research catalog.

## Optional Prometheus and Grafana deployment

The monitoring overlay provides the [Prometheus scrape configuration](../collector/monitoring/prometheus.yml), [Grafana datasource/dashboard provisioning](../collector/monitoring/grafana/provisioning), private volumes and networks. It publishes **no monitoring ports**. Set a strong, unique `RESEARCH_GRAFANA_PASSWORD` in your ignored `collector/.env`; no default administrator password is supplied.

```sh
docker compose --env-file collector/.env \
  -f collector/compose.yaml -f collector/compose.monitoring.yaml config

docker compose --env-file collector/.env \
  -f collector/compose.yaml -f collector/compose.monitoring.yaml up --build -d
```

To explicitly allow Grafana administration on the server's loopback address, add the separate local overlay:

```sh
docker compose --env-file collector/.env \
  -f collector/compose.yaml -f collector/compose.monitoring.yaml \
  -f collector/compose.monitoring-local.yaml up --build -d
```

Connect to `http://127.0.0.1:3000`, or use SSH local forwarding from your own computer to that loopback port. Sign in as `admin` with your configured password. Grafana disables anonymous access, signup and analytics. Prometheus is accessible only inside its private networks; Grafana queries it through the provisioned datasource. The collector's Caddy/TLS route remains unchanged. Official references: [Prometheus scrape configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/) and [Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/).

Image pins were checked against official releases on 2026-10-12: [Prometheus 3.13.4](https://github.com/prometheus/prometheus/releases/tag/v3.13.4), a security patch in the [3.13 LTS series](https://github.com/prometheus/prometheus/releases/tag/v3.13.0), and [Grafana 12.4.12](https://github.com/grafana/grafana/releases/tag/v12.4.12), the maintained 12.x security patch. Review newer security patches and pin approved digests for your deployment; these example tags are not a perpetual update policy.

Prometheus retains **30 days / 512 MB** of scraped aggregate history in its own volume. Collector retention, corrections, local opt-out or deleting collector files do **not** rewrite previously scraped history. Plan separate monitoring/backup retention and deletion. Grafana has its own settings volume. Stopping the stack preserves these volumes; remove only explicitly identified monitoring volumes when intentionally deleting monitoring history. Do not delete unrelated data or Caddy certificate volumes.

## Validation

`node --test test/research-metrics.test.js` exercises real private HTTP scrapes, text parsing, privacy, source/kind/mode separation, true zero values, corrections/retries, restart reconstruction, retention, orphaned-label removal, cache behavior and the series budget.

`sh ci/monitoring-smoke.sh` builds an isolated collector, runs real `promtool`, starts the pinned Prometheus and Grafana images, inserts only fictional practice observations, verifies an actual scrape and provisioned dashboard/datasource, and executes every dashboard panel query with populated results, including all 11 algorithm approaches. It removes its own containers/network/image and ephemeral data afterwards. The CI collector job runs this check. Set `MONITOR_SCREENSHOT_DIR` to a task-owned output directory when Playwright browsers are installed to additionally capture populated desktop/phone views and check phone overflow. No test contacts or modifies a live collector.
