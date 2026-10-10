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
basket, setting unit and canonical profile execution content from the current
workflow API.
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

This plugin uses the host API at loopback port 8080. Custom API ports,
physical hardware and a native/browser UI smoke are not validated by this suite.
Missing historic bean/grinder/calibration information cannot be reconstructed by
entering today's settings. RPM or observed configuration is not added to shots.

## Rich suggestions

`GET /api/v1/plugins/assisted-dialin.reaplugin/suggestion` evaluates a small,
bounded evidence set. It requires a complete current comparison context, uses
up to six recent shots with saved feedback no older than `EvidenceMaxAgeDays` (14 by
default), and abstains when the context, setting unit, calibration epoch or
time/taste evidence is missing or contradictory. An explicitly supplied operator `brewTimeSec` takes precedence; otherwise the plugin fetches the full shot and derives elapsed time from saved machine timestamps. Each source is disclosed. Suggestions report the matched evidence, direction,
confidence, reasons and whether a numeric proposal was withheld.

Numeric proposals require `CurrentSetting`, `SettingUnit`, a positive
`StepSize`, and an owner-confirmed `NumericFinerDelta` of `-1` or `+1`.
`MinSetting` and `MaxSetting` are applied only when they differ and are valid.
The result remains an operator-confirmation prompt and never becomes a device
command. `confirmedContext` is an explicit per-shot historical confirmation. It only fills fields missing from that saved shot, after fetching and checking the full record; any conflict is rejected. Current plugin settings never fill historical fields.

The manual DF54/DF64 rules are separate from the E64 firmware model:
below-target time or under-extracted taste suggests finer, above-target time or
over-extracted taste suggests coarser, and conflicting signals abstain.
Physical direction and numeric sign remain per-unit calibration data.

## Beans, roast and post-brew flavour

`GET bean-context` reads the current workflow's bean batch and linked bean from Decaid's existing catalog APIs. It displays species/type, variety, processing, origin, decaf status, roast level and roast date when available, with a fetch timestamp. Catalog entries are editable: this display never establishes the metadata of an older shot.

Current `BeanType` and `RoastLevel` settings, or saved `workflow.context.extras.beanType` / `roastLevel`, participate in comparisons. A known mismatch or a value missing on one side excludes the shot. If both sides lack these optional fields, the plugin discloses the omission and uses the matched batch identity; it makes no roast-specific adjustment. Historical bean/roast context can be explicitly confirmed per shot, with conflicts rejected. Changing bean batch still isolates cohorts even when species and roast match.

The feedback form records optional flavour descriptors, acidity, bitterness, sweetness, body and astringency on a 0–5 scale, plus an overall extraction assessment. These values are plugin-local operator feedback; they survive reload and do not alter the saved shot. Descriptors describe flavour and are not automatically converted into extraction diagnoses. Acidity alone does not imply under-extraction. Explicit under/over-extraction and strong bitterness/astringency contribute explained taste signals; balanced, uncertain or conflicting evidence does not justify an automatic numeric change.

Example feedback body:

```json
{"shotId":"your-shot-id","good":false,"flavour":{"descriptors":["plum","chocolate"],"acidity":4,"bitterness":0,"sweetness":3,"body":2,"astringency":1,"overall":"under-extracted"},"confirmedContext":{"beanType":"arabica","roastLevel":"light"}}
```

## Brew metrics

`POST analysis` with `{"shotId":"your-shot-id"}` fetches the saved full shot. The UI has a dedicated analysis form; rich suggestions also include per-source analysis.

- Elapsed shot time starts at the shot timestamp, including preinfusion. Machine and scale timestamps remain separate.
- Pressure, machine flow, mix/group temperatures show minimum, maximum, mean and time-weighted absolute error against recorded targets, with coverage. Profile-frame segments include the same tracking summaries.
- Scale analysis reports ending measured weight when available, last positive weight separately, mass gain, reported weight flow, timestamp-derived average mass flow, first weight increase and sampling gap. Ratio against the recipe dose and deviation from recipe yield are labelled comparisons to targets.
- Recipe dose/yield/ratio remain separate from saved annotations (actual-dose/yield fields, TDS, extraction yield and enjoyment). Annotation origin may be a recipe fallback, derived value or operator input; it is not silently promoted to a verified measurement.
- Recorded volume stays in millilitres. Machine flow/volume are never converted into beverage grams. Invalid, duplicate/non-monotonic, missing or partial samples are disclosed; scans are bounded to 20,000 measurements.

Tracking errors are descriptive evidence. The plugin does not claim pressure/flow curves alone prove channeling, extraction chemistry or an optimal grind. Missing metrics remain unavailable and do not become fabricated readings.

## Research replay

`POST /api/v1/plugins/assisted-dialin.reaplugin/research` is an offline replay
boundary for the algorithms recovered in
[MaxRink/mahlkoenig-e64ws-local-research](https://github.com/MaxRink/mahlkoenig-e64ws-local-research).
The request includes `operation`, `firmwareBuild`,
`coordinateUnit: "deci-micrometre"`, `input`, and an optional version-1
`stateEnvelope` scoped by grinder, bean batch, burr identity, calibration epoch
and profile. Supported operations cover inverse regression, `proposedDd`,
`ddEff`, `effectiveDd` (with an explicit baseline after initialization),
`grindTime`, manual DF guidance and GBS1–GBS4 state transitions. Returned adjustment
state is scoped and versioned so it cannot be silently
reused for another grinder or calibration epoch.

The advanced UI accepts the same JSON as the HTTP endpoint. Its synthetic example shows `adjust`: choose `GbS1`, `GbS2`, `GbS3` or `GbS4`, supply integer milliseconds and deci-micrometre inputs, and identify the replay scope. Copy the returned `stateEnvelope` into the next request to retain history. Scope/algorithm/firmware/unit/version changes reject old state rather than reuse it. This is plugin replay state, not native grinder storage.

Other operation inputs:

| Operation | Fields in `input` | Result meaning |
| --- | --- | --- |
| `inverseRegression` | `points: [{x, y}]`, `targetSec` | `x` is micrometres; `y` is seconds; predicted micrometres |
| `proposedDd` | `model: e64/e65/e80`, `roast: light/medium/dark`, `weightMg` | All nine wizard rows; output coordinate unit unknown |
| `ddEff` | `initialDdDum`, `calls` (0–64) | Six initial, six initial−200, six initial+200, repeating; measurement sequence |
| `effectiveDd` | `state: null` or prior `nextState`, `grindDdDum`, `grindDurationMs`, then `effectiveBaseline` | Recovered interpolation with explicit baseline; see model boundary below |
| `grindTime` | `mode`, `recipeDdUm`, `targetDdDum`, `recipeTimeMs` | Optional recipe-time adjustment only for mode 3 |
| `manual` | `profile: df54/df64_gen1/df64_gen2`, `targetTimeSec`, `actualTimeSec`, optional `flavor`, `currentDial`, `stepMarks`, `numericFinerDelta` | Separate community taste/time heuristic; does not require firmware acknowledgement |

Native research operations require the pinned `firmwareBuild` and `coordinateUnit` acknowledgement; fields with `Um` are micrometres and fields with `Dum` are deci-micrometres. No operation translates these coordinates into an uncalibrated physical dial.

The implementation independently follows the documented normal finite-input formulas and policy. It does not redistribute research source or prose. The analyzed firmware is
`HEM-HSG-HMI-S01 V01.16-24`, SHA-256
`269c3135d1e43a247d053b9bf720f39d1ebf853123a3ea6365d9a7ea4766eccc`.
These algorithms have software replay coverage only: no physical grinder,
firmware-version portability, actuator safety, dial direction or calibration
claim is made. The replay API uses an explicit deci-micrometre coordinate, but
the original wizard's user-facing output unit remains unknown; it must not be
presented as a universal dial mark.

Research errors are surfaced as structured 400 (`invalid_research_input`) responses
for malformed or unsupported requests. Host API, storage and interrupted
request failures remain safe 503 responses. No raw upstream error, credential
or untrusted request content is echoed.

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
Research formulas and evidence are attributed to
[MaxRink/mahlkoenig-e64ws-local-research](https://github.com/MaxRink/mahlkoenig-e64ws-local-research)
and are marked as static, build-specific research rather than vendor source.

The effective-DD calculation interpolates the caller-selected baseline toward `grindDdDum * 0.1` using the recovered factor `b`. The residue updates independently using `a`. The research does not establish which caller field supplies that second baseline: this calculator requires it explicitly and does not claim automatic firmware state coupling. Baseline/residue inputs use micrometres; result uses deci-micrometres.

Golden vectors can be regenerated independently with `PYTHONPATH=/path/to/mahlkoenig-e64ws-local-research python3 ci/generate-research-vectors.py`. Check out research revision `efcf12fb5366d628468ce02117f5905c32474b41` first. CI uses the committed vectors and does not fetch an evolving oracle.
