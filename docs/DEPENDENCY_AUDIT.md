# Dependency audit

What this repository pins today, what the registry says is current, and what is
deliberately held. The point of this file is that a closed Dependabot pull
request is not an applied upgrade: without a record of *why* something was
closed, the same PR arrives again next week and is closed again.

Versions here were read from the registries on 2026-11-26:
`registry.npmjs.org`, `proxy.golang.org`, `hub.docker.com` and the GitHub
releases API. Nothing in the "latest" column is from memory.

## How to re-check

```sh
# npm
npm view @opentelemetry/sdk-node version
# Go (also proves the version resolves)
curl -s https://proxy.golang.org/github.com/caddyserver/caddy/v2/@latest
# Docker tags (200 means the tag exists)
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

## Deliberately held

Everything Dependabot proposed is now at or beyond its proposed version, so
there is no per-dependency `ignore` in `.github/dependabot.yml`. Two rules do
hold work back, and both are about *shape*, not version:

1. **Go module bumps are grouped and reviewed as one change.**
   `collector/caddy` is a Caddy *custom build*: `go.mod` locks the module graph
   and the README records that `go.mod`/`go.sum` plus `GOTOOLCHAIN=local` and
   `-mod=readonly` exist so a build cannot silently change the graph. The
   registry-current versions of modules Caddy does not itself require
   (`golang.org/x/net` 0.63.0, `golang.org/x/crypto` 0.59.0,
   `google.golang.org/grpc` 1.85.0, `github.com/prometheus/client_golang`
   1.25.0) are **not** adopted here. They are transitive to Caddy v2.11.9, and
   moving them changes the binary that the HTTP/2 SETTINGS fix in
   GO-2026-6611 was verified against. They move when Caddy moves, or in a
   dedicated change that re-runs `ci/caddy-smoke.sh` and the Trivy scan.

2. **The collector base image stays on the digest that was verified.**
   `collector/Dockerfile` pins `node:26.13.1-alpine3.24` by digest because that
   digest is the exact base of the deployed image (layer `diff_id`s match). A
   tag bump without a digest is a different image, so Dependabot's tag-only
   suggestion is only accepted together with the resolved digest.

## The OpenTelemetry JS jump (0.223.0 → 0.301.2)

The 0.223 → 0.301 range crosses major versions of the OpenTelemetry JS SDK
(`@opentelemetry/core` 2.x → 3.x, `context-async-hooks` 2.x → 3.x) and raises
the `@opentelemetry/api` peer range to `<1.11.0`. It was landed as one change
that moved `api`, `sdk-node` and `exporter-trace-otlp-http` together, because
`exporter-*` and `sdk-node` must agree on `core`.

The behaviour that matters for this repository is `collector/telemetry.js`,
which is covered by `test/collector-telemetry.e2e.cjs` (`npm run test:telemetry`)
and asserts that only bounded route labels are recorded, that shutdown is safe
when tracing is disabled, and that an enabled exporter writes and exits cleanly
on SIGTERM. Those three assertions are the regression gate for any future
OpenTelemetry bump.

## Changes made by this audit

| Dependency | From | To | Why it is safe |
| --- | --- | --- | --- |
| `golang` builder image | 1.27.3-alpine | 1.27.4-alpine | Go patch release; the built binary reports `go1.27.4`; `ci/caddy-smoke.sh` passes |
| `grafana/grafana` | 13.3.1 | 13.3.2 | patch release; `ci/monitoring-smoke.sh` passes with all 25 panel queries populated |
| `github.com/go-chi/chi/v5` | v5.4.0 | v5.5.0 | same major; `go build -mod=readonly` and `go mod tidy` are clean; `ci/caddy-smoke.sh` exercises proxy routing |

Superseded, not applied here: `@opentelemetry/sdk-node` 0.301.x,
`exporter-trace-otlp-http` 0.301.x and `@opentelemetry/api` 1.10.0 arrived in
the merged "bump the OpenTelemetry JS packages together" change; `caddy/v2`
v2.11.9, `go-jose/v4` v4.1.9, `otel/sdk` v1.47.0, `otel/trace` v1.47.0,
`prom/prometheus` v3.16.0 and `grafana/grafana` 13.3.1 all arrived through
merged Dependabot PRs at or above the versions the closed PRs asked for.
