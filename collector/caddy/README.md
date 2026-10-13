# Caddy deployment build

This uses Caddy's [standard custom-build entrypoint](https://caddyserver.com/docs/build), with all standard modules and embedded timezone data. The official runtime image supplies the runtime files; only its Caddy binary is replaced.

Caddy 2.11.7 is built with Go 1.27.2 and `golang.org/x/net` 0.60.0. These pins address the HTTP/2 SETTINGS CPU denial of service in [GO-2026-6611](https://pkg.go.dev/vuln/GO-2026-6611); the Go patch also contains the fixes for [GO-2026-6609](https://pkg.go.dev/vuln/GO-2026-6609) and [GO-2026-6607](https://pkg.go.dev/vuln/GO-2026-6607). The reviewed official `caddy:2-alpine` image still contained Go 1.26.8 and x/net 0.59.0 on 2026-10-12. No denial-of-service exploit was run against a public service.

`go.mod` and `go.sum` lock the module graph. `GOTOOLCHAIN=local` and `-mod=readonly` prevent silent toolchain or module changes during a build. Dependabot checks both the Dockerfile and Go manifests weekly. When updating dependencies, run `go mod tidy` with the pinned toolchain, build and scan the resulting image, and run `sh ci/caddy-smoke.sh`. Return to an official image only after verifying its binary includes the fixes.

The CI smoke test validates the supplied Caddyfile and exercises it on an isolated internal Docker network using a localhost certificate from Caddy's internal CA. It checks proxy routing, sensitive-header removal and rejection of `/metrics`, with the same read-only filesystem, restricted capabilities and writable data/config volumes as Compose. It does not claim a production certificate or public TLS deployment was tested.

The entrypoint follows the Apache-2.0-licensed Caddy entrypoint (Copyright 2015 Matthew Holt and The Caddy Authors). See the [upstream source and license notice](https://github.com/caddyserver/caddy/blob/v2.11.7/cmd/caddy/main.go).

CI additionally scans the final built collector and Caddy images for HIGH/CRITICAL OS and library findings, including unfixed entries, and retains JSON reports. Trivy Action is pinned to a reviewed release commit; update its explicit Trivy CLI version when maintaining the scanner. The private monitoring images are assessed separately.
