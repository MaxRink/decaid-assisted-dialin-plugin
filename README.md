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
acknowledged before feedback is used; write timeouts and an unreadable feedback
store fail closed until reload, and the UI surfaces retryable errors. A single
damaged stored entry is skipped and logged rather than disabling all feedback;
it is dropped on the next save. Feedback is keyed by a host-style shot ID
(letters, digits and `._:@+~-`, up to 256 characters, starting with a letter or
digit). At most 500 shots keep feedback; saving feedback for a new shot beyond
that drops the least recently updated entry (recommendations only scan the 250
most recent shots). No machine, workflow, profile or grinder command is sent.

State-changing requests (POST, PUT, PATCH, DELETE) whose browser `Origin` names
a different host than the one serving the plugin are refused with 403; ports are
ignored, so a skin on the same device still works, and clients that send no
`Origin` are unaffected. Enabling remote research sharing, choosing its
collector and deleting research data additionally require the plugin page
itself (see [research sharing](docs/RESEARCH_SHARING.md)).


## Install and use

Enter this repository URL in Decaid's plugin installer to install the latest
[GitHub release](https://github.com/MaxRink/decaid-assisted-dialin-plugin/releases).
For development, a ZIP artifact from a green Actions run is also available. Enable the plugin, run the setup assistant
(`http://127.0.0.1:8080/api/v1/plugins/assisted-dialin.reaplugin/setup`, or **Set up** on the plugin page),
and open `http://127.0.0.1:8080/api/v1/plugins/assisted-dialin.reaplugin/ui`.

The plugin declares the `notifications` permission. Decaid hosts that reject
unknown permissions (those from before Decaid's notification center) cannot load
it; use 0.7.x there.

### Setup assistant

Five steps: the grinder (picked from Decaid's grinders), how its dial reads
(unit, finer direction, step, range and optional two-point calibration), the
time target, research sharing (off unless turned on) and a review. Save writes
the grinder choice and dial-in data through `grinders`, sharing through
`sharing`, and the targets last through Decaid's own
`POST /api/v1/plugins/assisted-dialin.reaplugin/settings` (a settings save
reloads the plugin). With Decaid's extension protection on, that last write is
refused and the page says to finish the targets in Decaid. `ui?view=setup` opens
the same page, and `GET setup?status=1` reports `{needsSetup, missing}`. The
manifest also declares it as a top-level `setup` surface, which current hosts
ignore. Internal settings are marked `hidden` (and two `advanced`) so generated
settings forms show only the targets and the notice switch.

Both pages use the shared plugin page kit (MaxRink/streamline-js
`docs/plugin-ui`, vendored into `plugin.js` with its `vendor.mjs`; CI checks the
copy against the pinned kit commit) and follow `theme=light|dark`, `lang` and
`embed=1` from their URL. Decaid's settings route shadows any plugin endpoint
named `settings`, so the plugin no longer has one.

### Recommendations in the background

After a shot is stored, and again after its feedback is saved, the plugin
computes the next-step suggestion without the page being open (debounced; at
most five shots queued). The result is kept with the shot (500 shots) and read
with `GET recommendations?shotId=<id>`, `?shotIds=<id,...>` (up to 50) or
without a query (the 20 latest); analysis also returns it. For a shot from the
last 15 minutes it is posted as one Decaid notice, for example "Next shot: grind
5 µm finer (500 → 495); last shot 23 s vs target 28 s." The notice is replaced
for each new shot and only updated when its text changes; `RecommendationNotices`
turns it off. The notice asks for an `openPluginSurface` action and is sent
without an action when the host rejects that (stock hosts only open https pages,
and the plugin page is http). Shots older than an hour (imports) get no advice.
The latest recommendation is also copied into the active workflow's
`context.extras["assisted-dialin.reaplugin"].recommendation` (only on change, at
most every 30 seconds, and not while `GET /api/v1/machine/state` reports a shot,
steam, hot water or flush), so the next shot's snapshot carries the advice it was
brewed with. Stored shots are never written.
Use **Load recent shots** to choose a saved brew. The HTML form records a good
mark, taste feedback and optional notes. Enter submits
"Mark good"; the second button removes a mark. The recommendation button displays
a source shot, recorded setting, comparison warnings or an explicit abstention.
The accompanying Streamline integration adds history actions for analysis and
feedback, current coffee-batch selection through Decaid's beans API, and explicit
auxiliary bean-scale capture. Until that Streamline change is merged, open the
plugin through the existing Extensions settings or its `ui` URL.

Streamline can pass a selected `shotId`, `action=analyze|feedback`, and a
same-hostname, same-protocol `returnTo` URL. Legacy `return` is also accepted;
`returnTo` takes precedence. Following Decaid's plugin-page convention, a
skin-local path such as `/skin/history` resolves on the skin server, whose port
the page reads from `GET /api/v1/webui/server/status`; no link is shown when the
skin server is not serving. Credential-bearing and other-host links are hidden.
It fetches and analyses the saved shot; current catalog data never silently fills
historical context.

The optional bean-scale launch parameters only prefill the feedback form:

| Parameter | Meaning |
| --- | --- |
| `beanScaleId` | Opaque scale device ID |
| `beanScaleRole` | `auxiliary`; defaults to this role |
| `beanWeight` | Positive bean mass in grams |
| `beanCapturedAt` | ISO timestamp with a timezone for the user's capture |
| `beanSampleTimestamp` | Optional ISO timestamp with a timezone for the device sample |

These URL hints are untrusted, client-reported context. They do not confirm freshness,
prove which shot was weighed, or replace dose targets. The plugin requires its own
“Confirm these beans were weighed for this shot” acknowledgement before saving a
`measuredBeanDose` observation. Streamline checks the sample's role, connection and
age again at capture; capture time and sample time describe different events.

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
entering today's settings. RPM or observed configuration is not added to saved shots.
The plugin also exposes `GET /api/v1/plugins/assisted-dialin.reaplugin/grinder-observation`.
When the host advertises the read-only grinder setting observation (Decaid's
`GET /api/v1/grinder/info` and `/state`), this returns the current display value
with provenance, its host timestamp, grinder state, an observed RPM when the
driver declares one, and the grinder plugin's host-built diagnostics links
(shown on the plugin page). The value stays an opaque string. For an E64-family
grinder two driver forms are also read: from E64 plugin 0.4.4 a bare integer is
the grinder's own display value in micrometres (for example `83` for dD 827; the
dD behind it is known only to ±5, reported as `currentSettingPrecisionDd` /
`grinderSettingPrecisionDd`), and older E64 plugins' `<n> ddValueDum` is the
exact dD research coordinate (deci-micrometres). The page shows the number the
grinder shows. It is never a control command.
Unsupported, stale or failed observations are surfaced as unavailable.

The live dD is used in exactly two places, both labelled:

- **Current setting.** Precedence is the current workflow's recorded setting,
  then the live observation, then the manual `CurrentSetting` plugin setting.
  The live value is used only for an E64-family grinder model (E64 WS, E65S
  GbW). A display reading stays in micrometres when the setup has no unit or
  uses micrometres, and becomes display × 10 for a dD unit; a legacy dD reading
  stays dD or becomes dD ÷ 10 for micrometres. Suggestions report
  `currentSettingSource` and the observation they used, and warn when the
  calibrated `StepSize` is finer than the display resolution (1 µm = 10 dD).
- **Shots recorded while it was live.** When Decaid reports a newly stored shot
  (`shotStored`), the plugin stores the dD observed at that moment, at most 500
  shots, in plugin storage (`grinderObservations.v1`): the display value, or the
  exact dD for records made with older E64 plugins (both remain readable). This needs an observation at most 2 minutes old,
  a shot at most 15 minutes old (imports of older shots are ignored) and an
  E64-family grinder. Decaid does not keep observations with shots, so this
  record fills a missing historical setting only, labelled
  `grinderSettingSource: "recorded-live-observation"`; the shot's own value and
  operator confirmations always win.

### Grinder recipe, applying suggestions and the grinder's own GBS

When the connected grinder comes from a grinder plugin (the host runtime ID
`plugin:<plugin>:<driver>:<instance>`), the plugin also reads, with GET only:

- **Grind events** (`GET /api/v1/plugins/<plugin>/grind-events?deviceId=…`). A
  newly stored shot is linked to the completed grind that finished at most 5
  minutes before it started (or up to 1 minute after), one shot per grind; failed
  grinds are ignored. The grinder recipe, target, actual ground weight and grind
  time are kept with the shot in `grinderObservations.v1`. Analysis and the shot
  list show "Recipe: <type/mode> <amount>, ground <weight> g", and when a shot has
  no weighed beans and no dose annotation, analysis uses the ground weight as
  dose evidence labelled `grinder-reported ground weight`. The E64 0.5 event
  shape is read (live target/result weight, motor time and displayed setting,
  plus the `recipe` and `log` blocks the E64 plugin adds from the grinder's own
  grind log, whose weight and duration are preferred); camelCase and snake_case
  variants are also accepted. Events without a grind UUID (hosts that cannot yet
  download the grind log) are keyed by their completion time, and a grind the
  log marks unsuccessful is never linked.
- **Who adjusts the dial**: the grinder plugin's `AdjustmentOwner` setting
  (`off`, `grinder` or `decaid`) from Decaid's plugin settings route, or its
  diagnostics `read=control`. Unknown means read-only.

`GET grinder-control` reports the owner and whether the grinder declares a
`grindSetting` control in Decaid's grinder info (numeric with bounds, or opaque).

- **Owner `decaid`**: a numeric suggestion offers **Apply to grinder** on the
  page. A second, explicit confirmation is required; the plugin then recomputes
  the suggestion, refuses if it changed, converts it to the grinder's whole
  display value and sends it through Decaid's standard
  `PUT /api/v1/grinder/setting` route. It never applies anything automatically,
  never calls the grinder plugin to change anything and never starts a grind.
  `POST apply-setting` is accepted only from the plugin page. The suggested and
  applied values, and whether the grinder accepted them, are recorded with the
  suggestion's latest evidence shot.
- **Owner `grinder`**: nothing is offered for applying. Each newly stored shot
  (and each feedback save for it) records the assisted suggestion as it stood
  then; `GET gbs-comparison` and the page's "Grinder GBS vs assisted dial-in"
  view list it next to the dial the grinder's own GBS chose for the next shot.
- **Owner `off` or unknown**: read-only; no apply and no comparison records.

### Grinders in Decaid

Decaid's grinder inventory (`GET /api/v1/grinders`) decides which grinders
exist; manage them in Decaid. The current grinder is the workflow's
`grinderId`, else the one chosen on the plugin page, else the only
non-archived grinder. Suggestions use that record's model and burrs, its
`settingSmallStep` as the step until a step is calibrated, and for
`settingType: "preset"` grinders propose the neighbouring entry of
`settingValues` (`proposedPreset`) instead of a number.

Per-grinder dial-in data (unit, finer direction, step, min/max, calibration
epoch and two-point dial anchors) is kept in the grinder record's
`extras["assisted-dialin.reaplugin"]`, so it travels with Decaid's export and
backup. Decaid's grinder PUT replaces `extras` as a whole and has no
precondition, so every save re-reads the record, merges only this key (other
plugins' keys, such as the E64 plugin's inventory data, stay) and reads it back,
retrying if another writer replaced it in between. `GET grinders` lists the
grinders with their dial-in data and the current one; `POST grinders` saves
`{grinderId, dialIn}` or selects with `{operation: "select", grinderId}`.

Grinder profiles from 0.7 (`grinderProfiles.v1`) move into Decaid once, at most
20 per request: into the record a profile was bound to, else a non-archived
record of the same model (one the E64 plugin created counts), else a new
record. Only this plugin's extras key is written, never user-edited fields, and
a record that already has dial-in data is left alone. Progress is stored per
profile and the moved profile is found again by its `migratedFrom` marker, so
an interrupted or repeated run creates no duplicates.

When dial-in data is saved for the workflow's grinder, the plugin also writes a
small copy (grinder id, calibration epoch, unit, finer direction, step) into
the active workflow's `context.extras["assisted-dialin.reaplugin"]`, so Decaid's
shot snapshot carries it. That write happens only from the page, only when the
values changed, at most every 30 seconds, and never in response to workflow
events. Stored shots are never written.

Reading a stored shot, the plugin prefers its workflow snapshot: the E64
plugin's `context.extras["mahlkoenig-e64.reaplugin"]` (`displayedSetting`,
`ddValueDum`, `lastGrind.{resultWeightGr, motorRunTimeMs, targetWeightGr,
completedAt}`) fills a missing setting (`grinderSettingSource:
"workflow-snapshot"`) and the grind; the plugin's own linked records fill older
shots only. Shot records and the GBS comparison group by `grinderId`, falling
back to the model.

### Visualizer

When Decaid's Visualizer plugin uploaded a shot, analysis returns
`visualizer: {id, url}` from the shot's `annotations.extras.visualizerId` and
the page shows "View this shot on Visualizer". The `VisualizerBaseUrl` setting
points the link at a self-hosted instance (https only; default
`https://visualizer.coffee`). No Visualizer credentials are read or shared.

Recommendations and suggestions ask Decaid for history filtered by the current
bean batch and grinder record (`GET /api/v1/shots?beanBatchId=&grinderId=`), so
the bounded 250-shot scan covers comparable shots only.

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
`MinSetting` and `MaxSetting` are applied only when they differ: equal values,
including the 0/0 default, disable bounds and the proposal carries a warning to
check your grinder's range. A minimum above the maximum abstains, and a step
that would leave configured bounds abstains. Established and provisional
suggestions follow the same rule.
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

`npm run test:sim:host` and `npm run test:sim:e2e` use the E64 WS simulator from
the private research repository (`E64_SIM_ROOT`, default
`../mahlkoenig-e64ws-local-research`) and the E64 plugin (`E64_PLUGIN_ROOT`,
default `../decaid-e64ws-plugin`); the host test also needs a Decaid checkout
(`DECAID_ROOT`, default `$E64_SIM_ROOT/decaid`) whose host supports certificate
pinning (`tlsPinSha256`). The host test runs the simulator, the unmodified E64
plugin and this plugin in Decaid's real QuickJS host with the real grinder
controller and `/api/v1/grinder` handler. The E64 plugin connects over WSS with a
pinned, freshly generated self-signed certificate and mints its token through the
simulator's REST login. A second scenario replays the sanitized 2026-11-19 grind
capture from the research repository (Idle → Grind → GbwPostGrind → Idle) and
checks the live grinding state and the dial recorded with a shot stored after it.
The browser test shows a simulator-sourced dial on the served page. Both fail when the simulator is
missing unless `E64_SIM_OPTIONAL=1`. Nothing from the private repository is
copied here. CI runs them in the `e64-simulator` job with a read-only deploy key
and reports clearly when that key is unavailable.

The CI host contract tracks upstream Decaid `main` (verified against `df177b75` on 2026-10-31).

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
The collector is self-hosted. The maintained homelab deployment uses
`https://dialin-collector.private-testumgebung.de/v1/events`; remote sharing
still remains off until the operator explicitly enables it in the client.
The endpoint accepts only the minimized numeric/category schema described
above and does not expose a record-read API.
See [data fields, controls and deployment](docs/RESEARCH_SHARING.md). Optional
[private Prometheus metrics and Grafana dashboards](docs/RESEARCH_METRICS.md) show
retained brew measurements, taste and algorithm comparisons. Corrections and
expiry update the snapshot; missing data remains missing.

Dependabot checks GitHub Actions, npm, graph-tool Python dependencies and the
collector's Docker/Compose images weekly. Updates go through the complete CI.

## Help and contribute

Use the [issue chooser](https://github.com/MaxRink/decaid-assisted-dialin-plugin/issues/new/choose) for bugs, feature requests, source or coffee corrections, and protocol/mock test cases. To request a model, open the [new grinder form](https://github.com/MaxRink/decaid-assisted-dialin-plugin/issues/new?template=new-grinder.yml); unknown measurements are welcome. The addon and [website](https://maxrink.github.io/decaid-assisted-dialin-plugin/simulator/) include the same Help links.

[Contributing and reporting routes](CONTRIBUTING.md) explain which device or upstream project owns a problem. For vulnerabilities, follow the [security policy](SECURITY.md) and use a private report.
