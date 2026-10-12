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

Enter this repository URL in Decaid's plugin installer to install the latest
[GitHub release](https://github.com/MaxRink/decaid-assisted-dialin-plugin/releases).
For development, a ZIP artifact from a green Actions run is also available. Enable the plugin, review its current-setup settings,
and open `http://127.0.0.1:8080/api/v1/plugins/assisted-dialin.reaplugin/ui`.
Use **Load recent shots** to choose a saved brew. The HTML form records a good
mark, taste feedback and optional notes. Enter submits
"Mark good"; the second button removes a mark. The recommendation button displays
a source shot, recorded setting, comparison warnings or an explicit abstention.
The accompanying Streamline integration adds history actions for analysis and
feedback, current coffee-batch selection through Decaid's beans API, and explicit
auxiliary bean-scale capture. Until that Streamline change is merged, open the
plugin through the existing Extensions settings or its `ui` URL.

Streamline can pass a selected `shotId`, `action=analyze|feedback`, and a
same-host, same-protocol `return` URL. The UI also accepts `returnTo` for the
generic launcher proposal in Streamline #99. It fetches and analyses the saved
shot; current catalog data never silently fills historical context.

An optional `measuredBeanDose` feedback record contains an explicitly confirmed
auxiliary scale observation: device ID, role, purpose, grams and timestamps.
This is client-reported evidence, not a host-attested measurement. The UI asks
you to confirm that the weighing belongs to the selected shot. It preserves
recipe dose separately and displays measured beverage-to-bean ratio only when
both measured masses are available. It does not rewrite the original shot.

This plugin uses the host API at loopback port 8080. Custom API ports and
physical hardware remain unvalidated. Browser checks use synthetic local records;
the real QuickJS fixtures verify the host/API/storage boundary.
Missing historic bean/grinder/calibration information cannot be reconstructed by
entering today's settings. RPM or observed configuration is not added to shots.

## Rich suggestions

`GET /api/v1/plugins/assisted-dialin.reaplugin/suggestion` evaluates a small,
bounded evidence set. An established suggestion uses at least three recent,
comparable shots; for a new bean, one or two fully comparable shots can yield a
clearly labelled provisional first-shot direction. The provisional path never
claims a learned slope and requires current bean catalog context. The endpoint
uses up to six recent shots with saved feedback no older than
`EvidenceMaxAgeDays` (14 by default), and abstains when the context, setting
unit, calibration epoch or time/taste evidence is missing or contradictory. An
explicit positive `TargetTimeSec` is required; there is no default espresso time.
`TargetTimeClock` selects `pump` (preinfusion plus pouring, the default clock),
`pouring` (main pouring only), or `recording` (the whole saved recording,
which can include preheat and settling). Native pump/pouring durations require
observed start/end state transitions and complete telemetry coverage.
An operator `brewTimeSec` takes precedence only when its `brewTimeClock`
matches the target. Legacy explicit operator times with no clock label use
`pump`; new feedback should supply the clock. Missing native boundaries require
an operator-confirmed matching time, rather than borrowing recording duration.
Shots ended by an error or disconnection are excluded. Every manual stop
requires `manualStopConfirmed: true`, affirming that the actual result completed
the intended recipe and is suitable for comparison; no universal gram tolerance
is assumed. Each source and confirmation is disclosed. Suggestions also expose matched reviewed
reference facts and URLs as contextual provenance only; those references never
alter the direction or numeric proposal. Suggestions report the matched
evidence, direction, confidence, reasons and whether a numeric proposal was
withheld. Descriptive acidity, bitterness and astringency intensities do not imply
an unwanted taste or an extraction diagnosis. Direction requires an explicit
actionable taste choice or the operator’s overall assessment.

Numeric proposals require `CurrentSetting`, `SettingUnit`, a positive
`StepSize`, and an owner-confirmed `NumericFinerDelta` of `-1` or `+1`.
`MinSetting` and `MaxSetting` are applied only when they differ and are valid.
Provisional numeric suggestions additionally require explicit ordered bounds;
without them, the first-shot result can offer a direction but withholds a number.
The result remains an operator-confirmation prompt and never becomes a device
command. `confirmedContext` is an explicit per-shot historical confirmation. It only fills fields missing from that saved shot, after fetching and checking the full record; any conflict is rejected. Current plugin settings never fill historical fields.

The manual DF54/DF64 rules are separate from the E64 firmware model.
They use the owner's explicit time target and exact assessments: `too sour`,
`too acidic` or `under-extracted` support a finer experiment; `too bitter`,
`too astringent` or `over-extracted` support a coarser experiment. These are
subjective assessments, not extraction measurements. Bare taste words and free
prose such as “pleasant acidity” or “not bitter” supply no direction. Conflicting
signals abstain; `balanced` retains the setting even outside the time target.
Confidence is labelled `heuristic` or `none`. `legacyScore` preserves the old
community rule score for comparison; it is not a probability or measured confidence.
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

- `elapsedSec` is recording duration and can include preheat and settling. `timing.pump`, `timing.pouring` and `timing.preinfusion` separately report durations only when native state boundaries and coverage are complete. Machine and scale timestamps remain separate.
- Pressure, machine flow, mix/group temperatures show minimum, maximum, mean and time-weighted absolute error against recorded targets, with coverage. Profile-frame segments include the same tracking summaries.
- Scale analysis reports ending measured weight when available, last positive weight separately, mass gain, reported weight flow, timestamp-derived average mass flow, first weight increase and sampling gap. Ratio against the recipe dose and deviation from recipe yield are labelled comparisons to targets.
- Recipe dose/yield/ratio remain separate from saved annotations (actual-dose/yield fields, TDS, extraction yield and enjoyment). Annotation origin may be a recipe fallback, derived value or operator input; it is not silently promoted to a verified measurement.
- Recorded volume stays in millilitres. Machine flow/volume are never converted into beverage grams. Invalid, duplicate/non-monotonic, missing or partial samples are disclosed; scans are bounded to 20,000 measurements.

Tracking errors are descriptive evidence. The plugin does not claim pressure/flow curves alone prove channeling, extraction chemistry or an optimal grind. Missing metrics remain unavailable and do not become fabricated readings.

Observed profile-frame transitions take precedence over scheduled phase maxima.
Schedule-only labels remain inferred, especially for weight-triggered D-Flow
infusion. Flow-controlled, hybrid and unknown controller modes cannot use the
generic time-to-grind rule. Measured brewing temperature, its saved target and
optional tasting-temperature context remain separate; acidity or bitterness
does not establish a temperature correction or measured extraction yield.

## Research replay

### Try the interactive simulator

For a longer-term archive, see the [self-hosting study](docs/SELF_HOSTED_SHOT_ARCHIVE.md).

Open the [Dial-in lab](https://maxrink.github.io/decaid-assisted-dialin-plugin/simulator/)
for a four-step beginner guide: choose coffee and grinder, set a recipe, enter
your measured shot and taste, and try one small next step. Simple mode uses
owner-confirmed dial marks for DF54/DF64 or native micrometres for E64 WS, with
clock and recipe checks. Its shot history lasts for the current browser session.
Missing or conflicting evidence keeps the current setting and explains what
to check. The clearly labelled practice example uses fictional shots.

Both views show all ten calculations automatically, with the result, a
plain-language reason and any missing measurements. Timing-only research models
use independent histories of the settings actually brewed; they do not override
your taste-based next step. Their native DF54/DF64 outputs need your own two-point
calibration. Taste is optional for timing comparisons. DdEff uses recorded
coordinates without requiring a timing clock or pressure profile; it is a test
sequence, and the starting table has unknown units;
neither is a command for your next coffee. Editing feedback replaces the same
shot until you continue to a new one. Expert mode retains recorded coffee as
selected evidence and lets you explicitly switch to its experiment or imported
trace. Imported timing comparisons require a verified pressure-led extraction,
a complete matching pump clock and a suitable stop reason. Native mapping
requires exact saved grinder and instance IDs, model, burr identity and calibration
epoch; otherwise the research coordinate stays separate from your current dial.

Expert mode lets you plan shots, compare the shipped algorithms, inspect their
memory, and save or import an experiment. It loads this repository's actual `plugin.js`; the
research equations and assisted suggestion policy are not separately reimplemented.
The brew model is deliberately synthetic. A simulated bean name or grinder
label does not establish a real grind setting or a measured extraction curve.

The [reviewed reference catalog](docs/REFERENCE_SOURCES.md) records source links,
review dates, recipes, bean descriptors, burr specifications, calibration
instructions, and research findings. The simulator lets you inspect those facts
and explicitly adopt an espresso recipe as a starting point. Filter recipes
remain available for reference and do not become espresso targets. Published
roaster tasting notes describe the coffee; your post-brew extraction assessment
remains separate. Missing data stays unknown.

Run `python3 scripts/build-simulator.py` to stage the static site in `.site`.
Serve that directory with a local HTTP server to preview it. GitHub Pages deploys
only after the full CI run succeeds for the current main commit.

For a plain-language comparison of GBS1–GBS4, DdEff, effective-DD and
grind-time helpers, the E64/E65/E80 wizard boundary, and the separate manual
DF54/DF64 heuristics, see the [GBS algorithm guide](docs/GBS_GUIDE.md).

Start with the guide's everyday explanations, then view the
[algorithm graphs and pass-by-pass examples](docs/algorithm-plots/README.md).
The [decision-flow gallery](docs/decision-trees/) explains every main decision path
with offline diagrams, plain-language summaries and expandable exact conditions.
The [full decision reference](docs/DECISION_TREES.md) and
[machine-readable branch map](docs/research/decision-tree-map.json) pin the reviewed source.
The examples run the actual plugin calculations with clearly labeled synthetic
inputs. The [grinder and burr research](docs/GRINDER_RESEARCH.md) separates
published calibration facts from missing measurements and compares MARO and
other assisted dial-in systems. These guides and graphs are included in the ZIP.

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
npx playwright install chromium firefox webkit
npm run test:e2e
npm run package
```

CI also regenerates graph data from the actual implementation, compares every
committed pass with the replay, renders Matplotlib figures, and uploads them.
CI runs Node 22/24/26 behavioral and controlled HTML script tests, syntax and ZIP
layout checks, the actual host manifest/package parser, and a real QuickJS
PluginManager fixture with loopback API, feedback writes, reload persistence,
successful recommendation, abstention and error checks. These are hardware-free
fixtures; controlled DOM tests do not constitute a browser rendering test.
Playwright additionally exercises the shipped website and native plugin page in
Chromium, Firefox, WebKit and a mobile viewport, including repeated shots,
native dial advice, import/export, persistence and error handling. Its local
server runs the actual plugin handlers with synthetic host records and storage;
these browser checks complement the pinned QuickJS host tests. CI retains
browser reports and failure traces. Neither fixture proves physical grinder
performance.

The host contract is pinned to Decaid commit `af4e99524ad7731dbdb7db4540cd272bc91da038` in CI.

## Attribution

The plugin follows the public Decaid plugin API and is distributed under GPL-3.0-or-later.
Research formulas and evidence are attributed to
[MaxRink/mahlkoenig-e64ws-local-research](https://github.com/MaxRink/mahlkoenig-e64ws-local-research)
and are marked as static, build-specific research rather than vendor source.

The effective-DD calculation interpolates the caller-selected baseline toward `grindDdDum * 0.1` using the recovered factor `b`. The residue updates independently using `a`. The research does not establish which caller field supplies that second baseline: this calculator requires it explicitly and does not claim automatic firmware state coupling. Baseline/residue inputs use micrometres; result uses deci-micrometres.

Golden vectors can be regenerated independently with `PYTHONPATH=/path/to/mahlkoenig-e64ws-local-research python3 ci/generate-research-vectors.py`. Check out research revision `efcf12fb5366d628468ce02117f5905c32474b41` first. CI uses the committed vectors and does not fetch an evolving oracle.

### Grinder display units and calibration

The [grinder dial guide](docs/GRINDER_DIALS.md) separates native micron displays, printed collar marks and multi-turn click counts from the research algorithms’ internal dD coordinate. The lab displays native values only after a documented unit conversion or explicitly scoped owner calibration. Matching control references include original offline illustrations and linked manufacturer photographs. The [photo rights audit](docs/GRINDER_PHOTOS.md) records all 16 models; photos only appear in the app when a reusable licence and attribution have been verified. Changing grinder, burr identity or calibration epoch invalidates a local dial mapping.

## Releasing

Keep `manifest.json`, `package.json` and the lockfile package version in sync.
After reviewing a green main revision, push its matching `vX.Y.Z` tag. The release
workflow verifies the tag, reruns the complete CI (including Playwright and the
pinned host parser/runtime), and publishes exactly one ZIP. No release is
published if any required job fails.

`npm run package` builds a deterministic flat archive containing `manifest.json`,
`plugin.js`, README and licence notices. Runtime reference data and the native UI
are embedded in `plugin.js`; research documents, plots, simulator files and CI
fixtures stay on GitHub/Pages. Package names follow the manifest version rather
than a hardcoded version. Bump the version for every subsequent release so
Decaid can offer an update.

[Validation readiness and physical trial checklist](docs/VALIDATION_READINESS.md)
tracks upstream dependencies and the evidence needed before physical claims.


The website also learns a separate local response in your grinder's native dial
units, without requiring a micron calibration. Its guided setup offers sourced,
editable small-step presets and asks for the missing operating details. First
and second settings are labelled unlearned trials; three consistent nearby
settings can support a bounded numerical suggestion. Plateaus, noisy repeats,
changed conditions and conflicting taste ask for a repeat. See the
[grinder setup guide](docs/GRINDER_SETUP.md) for preset evidence, ELI5 explanations,
the complete decision flow and the native-response contract.

## Rough mechanical estimates

The simulator can optionally use a sourced or explicitly assumed mechanical
movement estimate to explore research suggestions in native dial units after
one shot. It labels assumptions, asks for the reference and finer direction,
shows sensitivity scenarios, and caps every candidate to the owner's confirmed
step and allowed window. Estimated coordinates never become owner calibration.
Measured native trends and hold advice take priority. See the
[mechanics evidence and limitations](docs/GRINDER_MECHANICS.md).

## Research archive and sharing

The website and plugin keep a separate, bounded local research archive by
default; you can disable it, export it or delete it. Remote sharing is off by
default and requires an explicit choice and a configured HTTPS collector. The
website sends only when you press Send; the opted-in plugin automatically sends
future observations and retries while running. Random observation keys allow corrections and retry deduplication;
personal text, host shot IDs and permanent visitor identifiers are excluded.
The collector is self-hosted; no live collector is operated by this repository.
See [data fields, controls and deployment](docs/RESEARCH_SHARING.md).

Dependabot checks GitHub Actions, npm, graph-tool Python dependencies and the
collector's Docker/Compose images weekly. Updates go through the complete CI.
