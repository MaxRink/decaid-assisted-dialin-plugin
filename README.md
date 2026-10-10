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
basket and canonical profile execution content from the current workflow API.
Profile title alone never proves a match; missing execution steps cause abstention.
Changing presentation metadata does not change execution identity. Missing optional
fields on both sides are disclosed as comparison warnings. Current setup settings
only supply fields missing from the current workflow; they do not rewrite saved shots. A bounded scan is reported
as truncated and cannot claim a complete search.

Open the `ui` endpoint through the Decaid plugin API. HTTP endpoints return
JSON except `ui`, which returns an accessible HTML page. Feedback is stored in
the plugin's namespaced storage and survives plugin reloads. Writes are
acknowledged before feedback is used; timeouts and malformed storage fail
closed until reload, and the UI surfaces retryable errors. No machine,
workflow, profile or grinder command is sent.

## Install and use

Install a ZIP artifact from a green GitHub Actions run, or enter this repository URL
in Decaid's plugin installer. Enable the plugin, review its current-setup settings,
and open `http://127.0.0.1:8080/api/v1/plugins/assisted-dialin.reaplugin/ui`.
Use the `shots` JSON endpoint alongside the host history view to find shot IDs;
the HTML form records a good mark and optional note for a shot ID. Enter submits
"Mark good"; the second button removes a mark. The recommendation button displays
a source shot, recorded setting, comparison warnings or an explicit abstention.
No plugin launcher tile is provided yet; upstream Streamline #99 tracks navigation.

This initial plugin uses the host API at loopback port 8080. Custom API ports,
physical hardware and a native/browser UI smoke are not validated by this suite.
Missing historic bean/grinder/calibration information cannot be reconstructed by
entering today's settings. RPM or observed configuration is not added to shots.

## Errors and freshness

Invalid feedback returns 400; unknown endpoint/method returns 404. History,
workflow, parsing, storage and interrupted requests return a safe 503 without raw
upstream errors. Network failures in the UI show a retry message. Storage errors
include reload recovery guidance; no successful save is shown before the host
acknowledges it. A storage timeout blocks further writes until plugin reload to
prevent a late unkeyed acknowledgement from confirming the wrong write. Corrupt
stored feedback fails closed and is not overwritten; it may need explicit repair
or removal after preserving the stored data, rather than repeated reloads.

Shot history is cached for at most five seconds. Known shot/workflow changes and
unload fence active requests; a cancelled request should be retried. Periodic
request-time refresh covers missing history edit/import events until Decaid #964
is delivered. Each scan considers at most five pages of 50 shots and reports
truncation. Comparability is a filter, not a confidence score or measured result.

## Development

```sh
npm ci
npm test
npm run package
```

CI runs Node 22/24/26 behavioral and controlled HTML script tests, syntax and ZIP
layout checks, the actual host manifest/package parser, and a real QuickJS
PluginManager fixture with loopback API, feedback writes, reload persistence,
successful recommendation, abstention and error checks. These are hardware-free
fixtures; controlled DOM tests do not constitute a browser rendering test.

The host contract is pinned to Decaid commit `af4e99524ad7731dbdb7db4540cd272bc91da038` in CI.

## Attribution

The plugin follows the public Decaid plugin API and is distributed under GPL-3.0-or-later.
