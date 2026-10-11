# GBS algorithm guide

## Start here: what this is trying to do

The assistant is trying to help you repeat a good espresso. You give it a
target brew time, the result of a shot, and a recorded grind setting. It keeps
some recent history and suggests a small next step when the evidence agrees.
It is a calculator and notebook: it does not turn the grinder dial for you.

Here is a typical example. You want 25 seconds and your last comparable shot
took 20 seconds. The assistant may say that the grind should move finer, then
wait for you to confirm and record what you actually did. If the next shot is
still far away, it learns from the new pair of setting and time. If the shot is
close enough, some algorithms keep the existing recommendation instead of
chasing noise.

In this guide, **DD** simply means the machine's grind coordinate. The replay
uses `Dum` as an internal reference unit (`100 Dum = 10 µm`), but that number is
not automatically a dial mark and does not tell us which way a particular
grinder turns for finer coffee.

There is no verified fact saying “this grinder model uses GBS1” or “that model
uses GBS4.” The research found algorithm names in firmware and a separate
E64/E65/E80 starting table; it did not prove a model-to-algorithm assignment.

## The short version of each calculation

| Calculation | In everyday words | What it remembers or does |
| --- | --- | --- |
| GBS1 | Smooths a few recent times and makes a small bounded correction. | Keeps four time notes; holds near the target. |
| GBS2 | Draws a trend from recent settings and times, then estimates the setting for the target. | Keeps up to six setting/time pairs; uses a cautious fallback with little data. |
| GBS3 | Sorts a shot into near, middle or far from target and treats each case differently. | Keeps a short history; can pause or clear it when a shot is far away. |
| GBS4 | Like GBS3, but locks a mature recommendation when very close to target. | Keeps history and a hold countdown; exact 3-second and 5-second edges matter. |
| DdEff | Runs a repeatable measuring routine. | Visits three DD positions six times each; it does not learn from taste. |
| effectiveDd | Estimates how a grind change settles during a timed grind. | Keeps a residue and needs the caller's baseline after the first call. |
| grindTime | Resizes a recipe timer for a different grind coordinate. | Does not inspect taste or move the grinder. |
| Initial-DD wizard | Gives a starting value from a nine-cell model/roast table. | Does not learn from shots and has no known universal dial unit. |
| inverseRegression | Works backward from time to a likely grind coordinate. | Uses at most six points and a safe fallback for weak data. |
| Manual DF54/DF64 | Combines time and what you tasted into a guarded suggestion. | Requires owner calibration; conflicting evidence means no numeric move. |
| Rich suggestion | Finds recent comparable shots before suggesting anything. | Checks context, freshness, time and taste evidence; can abstain. |

The next sections explain each row in a little more detail, followed by the
technical reference for units, boundaries and evidence.

## Plain-language walkthroughs

These explanations describe the replayed calculation, not a promise that the
same name is configured on a particular grinder.

### GBS1: ignore the odd shot

Imagine keeping four brew-time sticky notes. GBS1 sorts them and uses the
middle two, so one unusually fast or slow shot has less influence.

After each brew, it replaces the oldest note, checks how far the middle result
is from your target, and calculates a limited change. If the result is close
enough, it keeps the previous suggestion. It also avoids changing the displayed
number for every tiny fluctuation. It does not know how the coffee tasted.

### GBS2: learn a trend from your recent shots

Imagine writing down “setting A gave this time; setting B gave that time.”
GBS2 keeps up to six such pairs and draws a trend through them. Then it asks:
“Which setting would get us to the target time?”

After each brew, it adds the new pair and removes old pairs when the notebook
is full. Its next suggestion comes mostly from that trend. With too little
useful variation, it uses a built-in fallback instead. If the latest shot is
already within your chosen time tolerance, it keeps its previous suggestion.
A useful trend still depends on comparable shots; it does not understand taste.

### GBS3: treat a small miss differently from a big miss

GBS3 puts the result in one of three lanes: close to target, moderately away,
or far away. It smooths its running estimate and uses the recent setting/time
notebook when the selected lane allows it.

After each brew, it chooses a lane, updates its estimate, and checks whether
an adjustment should be returned. The startup countdown can temporarily keep
it in the close lane. A far-away result clears the learned notebook. If the
recorded grind coordinate suddenly changes a lot, it returns the previous
adjustment instead of continuing as though nothing changed. Roast and taste
are not inputs to this calculation.

### GBS4: stop chasing a result that is already close

GBS4 uses similar lanes and a short notebook, but has a stronger “leave it
alone” rule. Once it has learned from at least three recorded points, a shot
less than three seconds from target locks the previous adjustment.

That matters when successive shots wobble slightly around a good result:
GBS4 can keep the setting rather than chase every wobble. Exactly three
seconds misses this special lock. Larger misses go through the normal lane
rules, and very large misses can clear the notebook. A sudden large coordinate
change also stops the normal update. It does not judge flavour.

### DdEff: check three positions repeatedly

This is a measuring routine, not a taste adviser. Think of a technician
checking the same ruler at three positions.

It returns the starting coordinate six times, a lower coordinate six times,
and a higher coordinate six times, then repeats. Each pass advances the
counter. Whether your last espresso was delicious makes no difference.
The routine returns numbers for research replay; it does not move your grinder.

### Effective grind coordinate: account for settling after a change

Changing a setting does not necessarily mean everything immediately behaves
as if it had always been at that setting. This helper makes a duration-based
estimate of that transition.

The first pass starts its memory. Later passes update that memory and use a
starting value supplied by the caller to calculate an effective coordinate.
The research has not established which value the real firmware supplies as
that starting value, so the replay requires it explicitly. This is an estimate,
not a measurement of particle size, retention or extraction.

### Grind-time adjustment: resize a timer

This helper asks: “If the planned grind coordinate changes, how should this
recipe's grinding timer change according to the recovered formula?”

Each call calculates a timer value from the recipe and proposed coordinate.
It only operates in the supported recipe mode. It does not learn from earlier
shots, taste the coffee, or start the grinder.

### Starting wizard: choose a starting point

Think of a small recipe card: choose E64, E65 or E80, choose light, medium or
dark roast, and enter the dose. The wizard returns a starting coordinate from
that model/roast table.

It gives a starting point, not a learned answer. There is no previous-shot
memory. The original output unit is unresolved, so the number must not be
copied onto a DF64 dial or treated as a verified physical setting.

### Backward trend calculation: ask for the setting, not the time

This is the small helper behind some of the trend calculations. Instead of
asking “what time might this setting produce?”, it asks “what setting might
produce my target time?”

Each call uses up to six setting/time pairs. When those pairs cannot establish
a useful trend, it uses the documented fallback. It knows nothing about taste,
roast or the direction of a physical grinder dial.

### Manual DF54/DF64 guidance: compare time with what you tasted

This separate helper compares the brew time with your target and reads the
taste description you entered. When both point the same way, it can suggest
finer or coarser. When they disagree, it asks you to check rather than choosing
a numeric move.

A numeric suggestion needs your own step size and confirmation of which way
the numbers move on your grinder. Burr changes can invalidate that calibration.
The taste rules are a simple heuristic, not proof of extraction: acidity alone
can be a feature of the coffee. This is separate from the Mahlkönig firmware
algorithms and does not establish that those algorithms run on a DF grinder.

### Rich suggestions: compare like with like first

For an established suggestion, this assistant looks for at least three recent,
comparable shots. It checks the bean batch, grinder, burrs, calibration, recipe
and setting, then considers brew time and your recorded taste feedback. With a
new bean, one or two comparable shots can produce a clearly labelled
`provisional` first-shot direction, but it does not claim a learned slope and
requires the current bean catalog context.

Each new request checks that evidence again. Old, missing or contradictory
information can make it say “there is not enough evidence yet.” It uses at most
six recent shots. With your own numeric calibration it can suggest a setting;
otherwise it can explain a direction. Saved feedback stays separate from the
original shot, and the assistant never sends an adjustment to a grinder.

### Figures and replay examples

The planned visual companion will collect the same boundaries and state
transitions in [`docs/algorithm-plots/README.md`](algorithm-plots/README.md),
including `gbs1-history.svg`, `gbs2-inverse-regression.svg`,
`gbs3-phases.svg`, `gbs4-lock-boundary.svg`, `ddeff-sequence.svg`, and
`effective-dd.svg`. Those figures are explanatory aids; the pinned research
documents and committed golden vectors remain the evidence source.

## Technical reference

This guide explains what the research replay implements and what it does not
establish. The evidence is the static analysis of `HEM-HSG-HMI-S01 V01.16-24`
at research revision `efcf12fb5366d628468ce02117f5905c32474b41`. It is software
replay evidence only; there has been no live-grinder or firmware-portability
validation.

## Selecting an algorithm

The firmware selector uses the exact, case-sensitive stored algorithm name.
`GbS1`, `GbS2`, `GbS3`, and `GbS4` select V1 through V4. `DdEff` selects the
calibration measurement sequence. Empty, unknown, or differently cased names
fall back to V1 in the recovered path. `StandardGbs` and `ManualGbs` are
separate service modes, not algorithm names.

The selector does not encode a grinder model. The research does not prove that
E64, E65, or E80 products use a particular GBS version, and this plugin must
not invent such a mapping. The nine `proposedDd` wizard rows are a separately
verified model/roast table: E64, E65, and E80 by light, medium, and dark roast.
Their original user-facing output unit remains unknown. They do not prove that
the corresponding grinder runs GBS1, GBS2, GBS3, or GBS4.

## Algorithm differences

| Name | Recovered behavior | State and boundaries |
| --- | --- | --- |
| `GbS1` / V1 | Four age-tagged samples, a central average, nonlinear correction, and hysteretic 0.2 µm quantization. | Holds when time error is within 0.5 s; correction is clamped to ±5 µm and state to at least 1 µm. |
| `GbS2` / V2 | Up to six `(setpoint, observed time)` points, inverse regression, and a 10/90 current/prediction blend. | Regression uses inverse orientation, fallback slope −2.0, and clamps fitted slopes above −0.5. |
| `GbS3` / V3 | One learned history, filtered DD×brew prediction, regression, configurable near threshold and medium interval. | Default near threshold is 2 s; exact boundary behavior and far-history reset depend on the configured interval. A DD change greater than 500 is a guard path. |
| `GbS4` / V4 | One learned history, regression/blending, normalization, countdown and mature-near lock-in. | Near is strictly `<3 s`; mid is `<=5 s`; far is `>5 s`. A DD change greater than 500 is a guard path. |
| `DdEff` | A measurement/calibration coroutine. | Six calls at the initial DD, six at initial−200 Dum, six at initial+200 Dum, then repeat. It is not brew-time feedback. |

V3 and V4 both use a 0.4 current / 0.6 prediction blend in the recovered
normal paths, but their phase filters, hold behavior, history handling, and
near boundaries differ. V1's nonlinear correction is not an inverse
regression. V2's regression predicts the grind coordinate for a target time;
it is not ordinary `time = f(grind)` OLS.

The separate `effectiveDd` and `grindTime` operations are auxiliary recovered
calculations. `effectiveDd` updates a residue from grind DD and duration and
interpolates an explicitly supplied baseline toward the target DD. The
research leaves the native caller's choice of that second baseline unresolved,
so the plugin requires it after initialization. `grindTime` is an optional
recipe-time adjustment for its supported mode, not a taste algorithm.

## Manual DF54 and DF64 guidance

The manual `df54`, `df64_gen1`, and `df64_gen2` profiles are community
time/taste heuristics, separate from native E64 firmware research. The supplied
time target supports a bounded experiment, not a universal espresso time.
Exact assessments `too sour`, `too acidic` or `under-extracted` support a finer
test; `too bitter`, `too astringent` or `over-extracted` support a coarser test.
Those assessments do not measure extraction. Bare taste words and free prose,
including “pleasant acidity” and “not bitter,” are ignored as directional evidence.
Conflicting signals abstain, and `balanced` retains the setting. Confidence is
`heuristic` or `none`; `legacyScore` is an old community rule score, not a
probability or validated confidence estimate. Numeric
direction requires owner-confirmed per-unit calibration, including the finer
sign, step marks, zero, burr identity, and optional bounds. The profiles do
not claim a universal dial range or physical direction.

Changing settings, resetting a calibration, or starting a new history changes
only plugin replay state and saved context. It does not actuate a grinder,
rewrite historical shots, or silently transfer state across grinder, burr,
bean-batch, calibration-epoch, profile, algorithm, firmware-build, coordinate
unit, or state-envelope version.

## What each calculation takes into account

| Calculation | Direct inputs | Remembered information | Inputs it does not interpret |
| --- | --- | --- | --- |
| GBS1 | Actual and target brew time, tolerance, initial DD | Four age-tagged times, continuous correction, quantized DD, last returned DD | Bean type, roast, flavour, pressure and flow |
| GBS2 | Actual and target brew time, setpoint DD, initial DD, tolerance | Up to six DD/time points and last returned DD | Bean type, roast, flavour, pressure and flow |
| GBS3/GBS4 | Actual and target brew time, estimated and setpoint DD, tolerance; configured phase/filter/hold parameters | Up to six DD/time points, filtered DD×time, countdown, previous target and adjustment | Bean type, roast, flavour, pressure and flow |
| Initial-DD wizard | Grinder model, roast category and dose | None | Brew measurements, taste and burr-specific calibration |
| DdEff | Initial DD and successive calls | Position in the six/six/six measurement sequence | Shot outcome and taste |
| Effective DD | Grind DD, duration, explicit previous-effective baseline | Residue and initialization state | Bean type, taste and measured extraction |
| Grind-time adjustment | Recipe time and the operation's supported mode/context | None | Taste and measured particle size |
| Manual DF guidance | Time target, actual time, explicit taste and owner-confirmed setting calibration | None in the pure calculator | Automatic physical interpretation of pressure/flow |

Bean identity, burr identity, calibration epoch and profile additionally scope
research replay state; these prevent incompatible histories from being reused.
They do not become coefficients inside the recovered equations. The separate
rich-suggestion endpoint compares matched shots and explicit taste feedback;
its brew-metric analysis describes measured pressure, flow, temperature and
scale signals without claiming that those signals diagnose extraction.

## Units, evidence and safe use

Native research inputs use integer milliseconds and `Dum` (deci-micrometres);
`100 Dum` is `10.0 µm`. The replay API requires the explicit coordinate unit
`deci-micrometre`. Wizard output units are unknown and must not be presented
as universal dial marks. Numeric sign is not physical finer/coarser direction.

The implementation follows the documented finite-input formulas and has
independent software golden vectors. It does not claim actuator safety,
physical calibration, deployed-firmware compatibility, or a model-to-algorithm
mapping. See the primary research documents:

- [`GBS_ALGORITHMS.md`](https://github.com/MaxRink/mahlkoenig-e64ws-local-research/blob/efcf12fb5366d628468ce02117f5905c32474b41/docs/GBS_ALGORITHMS.md)
- [`GBS_TRACK_C_EXACT_REVERSAL.md`](https://github.com/MaxRink/mahlkoenig-e64ws-local-research/blob/efcf12fb5366d628468ce02117f5905c32474b41/docs/GBS_TRACK_C_EXACT_REVERSAL.md)
- [`DF64_DF54_GBS_APPLET.md`](https://github.com/MaxRink/mahlkoenig-e64ws-local-research/blob/efcf12fb5366d628468ce02117f5905c32474b41/docs/DF64_DF54_GBS_APPLET.md)


## Use the number your grinder shows

See [Read the number on your grinder](GRINDER_DIALS.md) for native micron displays, numbered collars, clicks, calibration and illustrated control references. A unit conversion does not certify a recovered algorithm for that grinder.
