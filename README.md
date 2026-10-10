# Decaid Assisted dial-in plugin

This community plugin provides a small local dial-in assistant. It reads the
bounded local shot history, lets the user mark a shot as good, and recommends
the most recent comparable marked shot's recorded grinder setting.

It never changes a machine, workflow, profile, or grinder. A recorded setting
is an intended workflow value, not a verified physical grinder reading. Missing
comparison data causes an abstention with an explanation. Grinder, burr,
calibration, bean, basket, dose, yield and profile identity can be entered in
plugin settings when the host shot does not contain them.

Open the `ui` endpoint through the Decaid plugin API. HTTP endpoints return
JSON except `ui`, which returns an accessible HTML page. Feedback is stored in
the plugin's namespaced storage and survives plugin reloads.

## Development

```sh
npm ci
npm test
npm run package
```

The host contract is pinned to Decaid commit `af4e99524ad7731dbdb7db4540cd272bc91da038` in CI.

## Attribution

The plugin follows the public Decaid plugin API and is distributed under GPL-3.0-or-later.
