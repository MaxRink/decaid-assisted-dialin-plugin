# Decaid Assisted dial-in plugin

This community plugin provides a small local dial-in assistant. It reads up to
250 local shots, lets the user mark or unmark a shot as good, and recommends
the most recent comparable marked shot's recorded grinder setting. Open
`/api/v1/plugins/assisted-dialin.reaplugin/ui` in the Decaid Web API.

It never changes a machine, workflow, profile, or grinder. A recorded setting
is an intended workflow value, not a verified physical grinder reading. Missing
historical comparison data causes an abstention; current setup values may be
entered in plugin settings but never backfill a historical shot. Comparison
includes bean batch, grinder identity/model, burrs, calibration, dose, yield,
basket and serialized profile content when present. A bounded scan is reported
as truncated and cannot claim a complete search.

Open the `ui` endpoint through the Decaid plugin API. HTTP endpoints return
JSON except `ui`, which returns an accessible HTML page. Feedback is stored in
the plugin's namespaced storage and survives plugin reloads. Writes are
acknowledged before feedback is used; timeouts and malformed storage fail
closed until reload, and the UI surfaces retryable errors. No machine,
workflow, profile or grinder command is sent.

## Development

```sh
npm ci
npm test
npm run package
```

The host contract is pinned to Decaid commit `af4e99524ad7731dbdb7db4540cd272bc91da038` in CI.

## Attribution

The plugin follows the public Decaid plugin API and is distributed under GPL-3.0-or-later.
