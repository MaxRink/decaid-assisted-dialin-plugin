# Flow and preinfusion analysis

This plugin treats a brew trace as a time series, not as a handful of end
points. The graph is evidence about what the machine and scale recorded. It is
not a direct measurement of extraction uniformity, channeling, or flavour.

## What is measured

Decent's machine telemetry normally gives pressure, machine flow, temperature,
profile frame and timestamps. A connected scale gives beverage mass and its
own timestamps. Machine flow is water entering the group or measured by the
machine's hydraulic sensor; scale flow is beverage mass change at the cup.
They must never be silently substituted for one another. The analysis keeps
both clocks and reports alignment gaps, missing samples, resets and duplicate
timestamps.

For every available trace the plugin can describe:

- total elapsed time and the time covered by each signal;
- cumulative machine-flow volume and cumulative scale mass;
- pressure, machine-flow and scale-flow curves, with target curves where the
  saved profile has them;
- the time derivative or slope of each curve, using the recorded sampling
  interval and a warning when the interval is too sparse;
- pressure/flow area and pressure-flow pairs over time, rather than only
  minimum, maximum and mean;
- the first scale-weight increase, mass at phase boundaries, terminal flow and
  the gap between machine-flow and beverage-flow clocks;
- profile-frame changes and the profile's own transition conditions.

An integral of machine flow is a water-volume estimate. It is not beverage
yield. A difference in scale mass is beverage mass gained. Its time derivative is
beverage mass flow; integrating that rate gives mass gained over covered
intervals. Integrating cumulative scale weight would give gram-seconds, not
yield. Extraction yield needs beverage TDS and a valid dry-coffee dose.

## Phase model

The trace viewer labels phases from the saved profile first. When the profile
does not provide usable transitions, it can show provisional labels based on
observable events, but it labels them as inferred:

1. **Fill / wetting**: water is being introduced while the puck is not yet
   hydraulically saturated. Pressure can be low or unstable; flow into the
   group is not the same thing as flow into the cup.
2. **Preinfusion / saturation**: the puck is receiving water before the main
   extraction target. This may be flow controlled, pressure controlled, or a
   zero-flow hold. There is no single scientifically mandated pressure, flow,
   or duration for this phase.
3. **Ramp**: the profile changes toward its extraction target. We report the
   observed pressure and flow slopes and any overshoot; we do not infer a
   channel from a steep slope alone.
4. **Extraction**: the main profile target is active. For a flow-controlled
   profile, pressure is an outcome of puck resistance; for a pressure-
   controlled profile, flow is an outcome. The two modes are not interchangeable.
5. **Decline / finish**: the target, pressure, or flow falls, or the profile
   reaches its stop condition. A falling pressure or flow can reflect puck
   degradation, a deliberate profile, a dose/yield stop, or a machine action.

Observed phase boundaries require recorded transitions or timestamped phase
events. A saved profile defines intended stages and exit conditions; its maximum
durations are not observed boundaries, especially for weight- or pressure-triggered
profiles. Threshold-based boundaries are explicitly marked as
heuristics and remain hidden in Simple mode unless the user opens the details.

## Preinfusion: what we can say safely

Preinfusion wets and mechanically conditions the dry bed before the main
extraction. The Decent material describes flow-controlled filling and pressure
controlled stages as distinct choices, and D-Flow specifically uses a fast
fill followed by a pressurised hold. This is a description of those profiles,
not proof that one recipe is universally optimal.

The strongest general conclusion supported by the literature is that pressure,
flow, temperature, grind, dose, bed structure and time interact. Flow changes
can change pressure and dissolved-component mass, and non-uniform flow can
produce irreproducible extraction. The available studies do not establish a
universal preinfusion time, flow rate, pressure, or “channeling threshold” for
all beans, baskets, grinders and machines.

The plugin therefore uses preinfusion data to compare like-for-like shots:
same machine, profile family, basket, dose context, grinder instance, bean
batch and calibration epoch. It may say “this shot wetted for longer,” “the
pressure ramp overshot the saved target,” or “the scale saw first mass later.”
It does not say “the puck channelled” from a curve alone.

## Temperature and sensory feedback

Keep two temperatures separate:

- **Brewing temperature** is the machine or group temperature recorded during
  extraction, or the saved target when no measured series exists. It is a
  brewing input or machine reading.
- **Tasting temperature** is the beverage temperature when the user evaluates
  flavour. It must be measured or entered by the user; it cannot be recovered
  from group temperature, final beverage weight, or shot time.

Brewing temperature can affect extraction chemistry. A controlled espresso
study tested fixed 90 °C and 88→93 °C / 93→88 °C gradients and found changes in
chemical compounds and sensory attributes, but it covered particular coffees
and a particular machine. That is evidence for a context effect, not a
universal temperature correction.

Serving temperature can independently change aroma release and perceived
flavour. For example, a Bourbon Caturra study found different associations at
31–44 °C versus 50–62 °C, and a separate multi-coffee study found interactions
between coffee sample and consumption temperature. These results do not justify
a fixed rule such as “sour means raise brew temperature” or “bitter means lower
brew temperature.” Sourness, bitterness, roast, dose, extraction, strength,
aroma release and the taster’s temperature are confounded unless recorded
separately.

In Simple mode, temperature can be suggested only as a controlled next test
when the user has recorded a sensory complaint and the comparison shot has
matching dose, profile, grind cohort and tasting conditions. The explanation
must say whether the suggestion changes brewing temperature or merely asks the
user to taste at a comparable temperature. In Expert mode, show measured target
temperature, group/mix temperature coverage, any temperature trajectory, and
optional tasting temperature with its source (`measured`, `user-entered`, or
`unknown`). Never display tenths of a degree as if they were validated sensory
precision.

## Simple mode

Simple mode shows the graph, phase names, dose/yield/time, first detected
beverage mass, and three plain-language observations:

- whether the shot followed its saved pressure/flow intent;
- whether wetting/ramp/extraction/finish timing differed from the user's
  comparison shots;
- whether the measured beverage result and taste feedback point toward a
  coarser, finer, shorter, longer, or unchanged next test.

Every observation has a “why” sentence. For example: “The ramp exceeded the
profile target, so the comparison is less reliable” explains a trace fact;
“try a slightly coarser setting” is a bounded experiment suggestion, not a
claim about the puck's internal structure.

## Expert mode

Expert mode adds the raw samples, signal coverage, time bases, phase-boundary
provenance, cumulative curves, derivatives, pressure-flow trajectory, target
error by phase, and warnings. It distinguishes:

- **recorded**: directly present in machine or scale samples;
- **derived**: calculated from those samples, such as integral, slope, or
  time-weighted error;
- **inferred**: a phase label or comparison based on an explicit rule;
- **unknown**: a claim that cannot be established from the available signals.

Channeling, extraction yield and sensory quality remain unknown unless the user
adds independent evidence such as a puck examination, beverage TDS and taste
feedback. Even then, those observations are associated evidence, not a proof
that a particular curve caused the result.

## D-Flow handling

D-Flow is treated as a profile family with its own intent. The analysis reads
its saved phases and transition conditions rather than reducing it to the
final pressure, final flow, or total shot time. In particular, a fast fill,
pressurised hold, ramp and adaptive/declining finish are displayed as separate
events when the recorded profile exposes them. A D-Flow shot is not compared
to a flat 9-bar shot as though they had the same control variable.

The recommendation engine uses trace comparisons only when the relevant phase
and signal coverage are present. If a machine provides only endpoint values,
the result is downgraded to base metrics and says that the flow graph was
unavailable.

## Evidence and limits

The reviewed primary and first-party sources are listed in
`docs/research/flow-evidence.json`. The practical policy is deliberately
conservative: use published profile mechanics and measured trace relationships
as context; do not turn a vendor recipe, one-machine experiment, or a model
into a universal law.

