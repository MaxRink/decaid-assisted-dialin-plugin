# Dependency audit

What this repository pins today, what the registry says is current, and how each
pin got there. The point of this file is that a **closed Dependabot pull request
is not an applied upgrade**: without a record of *why* something was closed, the
same PR arrives again next week and is closed again. So the 25 closed PR numbers
are listed here, not just in the pull request that added this file — a PR body
disappears on merge, this does not.

Versions were read from the registries on 2026-11-26: `registry.npmjs.org`,
`proxy.golang.org`, `hub.docker.com` and the GitHub releases API. Nothing in the
"latest" column is from memory.

## How to re-check

```sh
# npm
npm view @opentelemetry/sdk-node version
# Go (also proves the version resolves)
curl -s https://proxy.golang.org/github.com/caddyserver/caddy/v2/@latest
# Docker tags: 200 means the tag exists
curl -s -o /dev/null -w '%{http_code}\n' \
  https://hub.docker.com/v2/repositories/library/golang/tags/1.27.4-alpine
```

## Current pins

| Where | Dependency | Pinned | Latest stable | Status |
| --- | --- | --- | --- | --- |
| `package.json` | `@opentelemetry/sdk-node` | 0.301.2 | 0.301.2 | up to date |
| `package.json` | `@opentelemetry/exporter-trace-otlp-http` | 0.301.2 | 0.301.2 | up to date |
| `package.json` | `@opentelemetry/api` | 1.10.0 | 1.10.0 | up to date |
| `package.json` | `@playwright/test` (dev) | 1.65.1 | 1.65.1 | up to date |
| `package-lock.json` | `@opentelemetry/core` (transitive) | 3.1.1 | 3.1.1 | up to date |
| `package-lock.json` | `@opentelemetry/exporter-prometheus` (transitive) | 0.301.2 | 0.301.2 | up to date |
| `collector/Dockerfile` | `node` base | 26.13.1-alpine3.24 (digest pinned) | 26.13.1-alpine3.24 | up to date |
| `collector/caddy/Dockerfile` | `golang` builder | 1.27.4-alpine | 1.27.4-alpine | up to date |
| `collector/caddy/Dockerfile` | `caddy` runtime | 2.11.9-alpine | 2.11.9-alpine | up to date |
| `collector/caddy/go.mod` | `github.com/caddyserver/caddy/v2` | v2.11.9 | v2.11.9 | up to date |
| `collector/caddy/go.mod` | `github.com/go-chi/chi/v5` (indirect) | v5.5.0 | v5.5.0 | up to date |
| `collector/caddy/go.mod` | `github.com/go-jose/go-jose/v4` (indirect) | v4.1.9 | v4.1.9 | up to date |
| `collector/caddy/go.mod` | `go.opentelemetry.io/otel/sdk` (indirect) | v1.47.0 | v1.47.0 | up to date |
| `collector/caddy/go.mod` | `go.opentelemetry.io/otel/trace` (indirect) | v1.47.0 | v1.47.0 | up to date |
| `collector/caddy/go.mod` | `go.opentelemetry.io/otel/sdk/log` (indirect) | v1.47.0 | v1.47.0 | up to date |
| `collector/compose.monitoring.yaml` | `prom/prometheus` | v3.16.0 | v3.16.0 | up to date |
| `collector/compose.monitoring.yaml` | `grafana/grafana` | 13.3.2 | 13.3.2 | up to date |

## The 25 closed-unmerged Dependabot PRs

Exactly **one** of these was still outstanding: #51. The other **24** were
already superseded or abandoned by the time this audit ran, which is why closing
them was correct and re-opening them would be busywork.

| PR | Dependency | Asked for | Disposition |
| --- | --- | --- | --- |
| #9 | `golang` image | 1.26.9-alpine → 1.27.0-alpine | superseded — main was on 1.27.3 (`064d119`) |
| #12 | `node` image | 24-alpine → 26-alpine | superseded — merged #52 reached 26.13.1-alpine3.24 |
| #23 | `@opentelemetry/exporter-prometheus` + `sdk-node` | 0.208.0 → 0.223.0 | superseded — now a transitive at 0.301.2 |
| #24 | `@opentelemetry/propagator-jaeger` + `sdk-node` | 2.2.0 → 2.12.0 / 0.223.0 | **abandoned** — `propagator-jaeger` is not in the dependency tree at all |
| #25 | `@opentelemetry/core`, `exporter-trace-otlp-http`, `sdk-node` | 2.2.0 → 2.12.0 / 0.223.0 | superseded — core 3.1.1, exporter 0.301.2 |
| #26 | `@opentelemetry/sdk-node` | 0.208.0 → 0.217.0 | superseded — 0.301.2 via #57 |
| #28 | `grafana/grafana` | 13.2.3 → 13.2.4 | superseded — main was on 13.3.1 via merged #53 |
| #31 | `@opentelemetry/api` | 1.9.0 → 1.9.1 | superseded — 1.10.0 via #57 |
| #34 | `@opentelemetry/exporter-trace-otlp-http` | 0.223.0 → 0.300.0 | superseded — 0.301.2 via #57 |
| #35 | `golang` image | 1.27.2-alpine → 1.27.3-alpine | superseded — main was already on 1.27.3 (`064d119`) |
| #36 | `prom/prometheus` | v3.15.0 → v3.15.1 | superseded — merged #46 reached v3.16.0 |
| #37 | `@opentelemetry/api` | 1.9.0 → 1.10.0 | superseded — 1.10.0 via #57 |
| #38 | `@opentelemetry/sdk-node` | 0.223.0 → 0.300.0 | superseded — 0.301.2 via #57 |
| #39 | `github.com/go-chi/chi/v5` | 5.3.2 → 5.4.0 | superseded — main was already on v5.4.0 (`064d119`) |
| #40 | `github.com/go-jose/go-jose/v4` | 4.1.5 → 4.1.6 | superseded — main was on 4.1.9 (`064d119`) |
| #41 | `grafana/grafana` | 13.2.3 → 13.3.0 | superseded — main was on 13.3.1 via merged #53 |
| #42 | `caddy` runtime image | 2.11.7-alpine → 2.11.8-alpine | superseded — main was on 2.11.9-alpine (`064d119`) |
| #43 | `@opentelemetry/exporter-trace-otlp-http` | 0.223.0 → 0.301.0 | superseded — 0.301.2 via #57 |
| #44 | `@opentelemetry/sdk-node` | 0.223.0 → 0.301.0 | superseded — 0.301.2 via #57 |
| #45 | `github.com/caddyserver/caddy/v2` | 2.11.7 → 2.11.9 | superseded — v2.11.9 arrived in `064d119` (merged as #56) |
| #49 | `go.opentelemetry.io/otel/trace` | 1.46.0 → 1.47.0 | superseded — merged Dependabot #48 |
| #50 | `go.opentelemetry.io/otel/sdk` | 1.46.0 → 1.47.0 | superseded — merged Dependabot #48 |
| #51 | `golang` image | 1.27.2-alpine → **1.27.4-alpine** | **outstanding — applied by this audit** |
| #54 | `@opentelemetry/exporter-trace-otlp-http` | 0.223.0 → 0.301.2 | superseded — 0.301.2 is in the tree |
| #55 | `@opentelemetry/sdk-node` | 0.223.0 → 0.301.2 | superseded — 0.301.2 is in the tree |

Of the nine that touched the Caddy build (`/collector/caddy`: #9, #35, #39, #40,
#42, #45, #49, #50, #51), only #51 was live.

## How the pins actually arrived

This matters more than the PR list, because several current versions did **not**
come from a merged Dependabot PR and a reader who assumes they did will re-open
work that is already done.

| Pin | Arrived in | Author / route |
| --- | --- | --- |
| `@opentelemetry` JS set (0.301.2 / api 1.10.0) | merge commit `32c19f1` | PR **#57**, human-authored "bump the OpenTelemetry JS packages together" |
| `caddyserver/caddy/v2` v2.11.9 | `064d119` | PR **#56**, **human-authored** — titled as a docs change; the Go graph and the Caddy image rode along |
| `go-jose/go-jose/v4` v4.1.9 | `064d119` | PR **#56**, human-authored (same commit) |
| `caddy` runtime `2.11.9-alpine`, `golang:1.27.3-alpine` | `064d119` | PR **#56**, human-authored (same commit) |
| `go-chi/chi/v5` v5.4.0 | `064d119` | PR **#56**, human-authored (same commit) |
| `otel/sdk`, `otel/trace`, `otel/sdk/log` v1.47.0 | `2d9cad4` | the **only** merged Dependabot PR that touched the Go graph: **#48** |
| `prom/prometheus` v3.16.0 | `bc7f8bc` | merged Dependabot **#46** |
| `grafana/grafana` 13.3.1 | `94c2cda` | merged Dependabot **#53** |
| `node` 26.13.1-alpine3.24 | `c75a88a` | merged Dependabot **#52** |

So the earlier claim that "`caddy/v2` v2.11.9, `go-jose/v4` v4.1.9, `otel/sdk`
and `otel/trace` v1.47.0, `prom/prometheus` v3.16.0 and `grafana` 13.3.1 all
arrived through merged Dependabot PRs" was false for the first four. Naming
**#56 / `064d119`** is the correction: `064d119` is a human-authored commit whose
subject is about documentation, and it is where the Caddy and Go pins actually
came from.

## What this audit changed, and whether it was closed-PR debt

| Change | From | To | Closed-PR debt? |
| --- | --- | --- | --- |
| `golang` builder image | 1.27.3-alpine | 1.27.4-alpine | **yes — this is #51's target, the only live one** |
| `github.com/go-chi/chi/v5` | v5.4.0 | v5.5.0 | **no** — registry drift; #39 asked for 5.4.0, which main already had |
| `grafana/grafana` | 13.3.1 | 13.3.2 | **no** — registry drift; #28 asked for 13.2.4 and #41 for 13.3.0, both below 13.3.1 |

The two drift bumps are still worth taking — v5.5.0 and 13.3.2 are the current
releases — but they are **not** closed-PR debt, and describing them as "behind"
would attribute work to #39, #28 and #41 that those PRs did not do. Grafana in
particular: main was already at 13.3.1, one patch above #41's request and four
above #28's, so both were genuinely satisfied when they were closed.

## The OpenTelemetry JS jump (0.223.0 → 0.301.2)

The 0.223 → 0.301 range crosses major versions of the OpenTelemetry JS SDK
(`@opentelemetry/core` 2.x → 3.x, `context-async-hooks` 2.x → 3.x) and raises
the `@opentelemetry/api` peer range to `<1.11.0`. It was landed in PR #57 as one
change that moved `api`, `sdk-node` and `exporter-trace-otlp-http` together,
because `exporter-*` and `sdk-node` must agree on `core`.

The behaviour that matters for this repository is `collector/telemetry.js`,
covered by `test/collector-telemetry.e2e.cjs` (`npm run test:telemetry`), which
asserts that only bounded route labels are recorded, that shutdown is safe when
tracing is disabled, and that an enabled exporter writes and exits cleanly on
SIGTERM. Those three assertions are the regression gate for any future
OpenTelemetry bump.

## Deliberately held

Everything Dependabot proposed is at or beyond its proposed version, so there is
no per-dependency `ignore` in `.github/dependabot.yml`. This repository has no
PostgreSQL service and no postgres ignore. Two rules hold work back, and both are
about *shape*, not version:

1. **Go module bumps are grouped and reviewed as one change.**
   `collector/caddy` is a Caddy *custom build*: `go.mod` locks the module graph
   and the README records that `go.mod`/`go.sum` plus `GOTOOLCHAIN=local` and
   `-mod=readonly` exist so a build cannot silently change the graph. The
   registry-current versions of modules Caddy does not itself require
   (`golang.org/x/net` 0.63.0, `golang.org/x/crypto` 0.59.0,
   `google.golang.org/grpc` 1.85.0, `github.com/prometheus/client_golang`
   1.25.0) are **not** adopted here. They are transitive to Caddy v2.11.9, and
   moving them changes the binary that the HTTP/2 SETTINGS fix in GO-2026-6611
   was verified against. They move when Caddy moves, or in a dedicated change
   that re-runs `ci/caddy-smoke.sh` and the Trivy scan.

2. **The collector base image stays on the digest that was verified.**
   `collector/Dockerfile` pins `node:26.13.1-alpine3.24` by digest because that
   digest is the exact base of the deployed image (layer `diff_id`s match). A
   tag-only bump without a digest is a different image, so a tag-only suggestion
   is only accepted together with the resolved digest.

## Tests

| Suite | Result | Notes |
| --- | --- | --- |
| `npm test` | 431 pass, 0 fail, 0 skipped | |
| `npm run test:telemetry` | 3 pass, 0 fail | the OpenTelemetry regression gate |
| `npx playwright test` | **420 passed, 0 failed, 8 skipped** of **428** | see below |
| `ci/caddy-smoke.sh` | PASS | binary reports `go1.27.4` and `chi/v5 v5.5.0` |
| `ci/monitoring-smoke.sh` | PASS | grafana 13.3.2, 25 panel queries populated |

The Playwright suite is 428 tests as counted by `npx playwright test --list`. The
420/8 split is not a defect: the 8 skipped are `e2e/e64-sim.spec.js`, two tests
across each of the four projects (chromium, firefox, webkit, mobile), skipped
because `E64_SIM_OPTIONAL=1` is set and no `E64_SIM_ROOT` is available. CI runs
that same split in the `browsers` job, and the live simulator assertions are
covered by the dedicated **`e64-simulator`** job ("E64 WS simulator end-to-end
(Decaid host and browser)"), which checks out the private research repository with
a read-only deploy key. Quoting "420 passed, 0 failed" without the 8 skips
overstates coverage against a 428-test suite.

### The two smoke scripts are the only gates for these changes

The golang builder and `chi` are compiled into the Caddy binary and grafana is a
container, so `npm test` and the browser suites cannot observe them. Both smoke
scripts were run after the change; the Caddy run prints the built binary's `go`
and `dep` lines, which is where `go1.27.4` and `v5.5.0` above come from.
