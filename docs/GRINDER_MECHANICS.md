# Rough grinder mechanics: what the numbers mean

## ELI5

Your dial moves the burrs. If we know roughly how far one mark moves them, we can
translate a research model's small change back into marks you can actually use.
For example, an assumed 10.4 micrometres per mark makes a quarter-mark movement
about 2.6 micrometres of carrier travel. That does **not** mean the grounds are
2.6 micrometres smaller or that your next coffee will take a fixed number of
seconds longer.

The optional website setup shows the source, asks you to accept the estimate,
and uses your confirmed direction, small step and permitted trial window.
You can declare a rough burr-touching zero or keep the experiment relative.
Estimated outputs remain separate from measured calibration. If you like the
coffee, or your recorded shots show a plateau or inconsistent response, that
hold advice takes priority.

Manufacturer specifications, firsthand measurements and deliberately assumed
sensitivity scenarios are labelled separately. A scenario range is a way to see
how assumptions change the result, not a statistical confidence interval.

# Provisional grinder mechanics: implementation contract

The shipped mechanics helper and optional simulator adapter follow this contract.
See the [model-by-model research](GRINDER_MECHANICS_RESEARCH.md) and
[16-model evidence catalog](../data/grinder-mechanics.json).

Mechanical information can usefully estimate **relative burr-carrier movement**.
It does not, by itself, establish an absolute operating gap, particle size, or a
portable relationship between grind setting and espresso time. Keep those four
quantities separate in the API and UI.

## 1. What can be calculated

For a verified screw-driven adjustment with constant transmission:

```text
lead_mm_per_screw_rev = thread_pitch_mm × thread_starts
delta_axial_um = 1000 × lead_mm_per_screw_rev
                 × screw_revs_per_dial_rev × delta_dial_units / units_per_dial_rev
```

Apply the verified movement sign separately. Lead is travel per revolution;
pitch is the spacing of adjacent thread crests. They coincide only for a
single-start screw. A visible pitch measurement does not establish thread-start
count. [Thomson's manufacturer explanation](https://www.thomsonlinear.com/en/training/ball_screws/lead_vs_pitch)

The formula also requires proof that the observed adjuster drives the relevant
carrier. Gears, differential screws, cams and electronic encoders can change
that relationship. Full rotations must remain part of the coordinate; never
wrap a multi-turn grinder to its current printed number.

Use the best direct specification available. For example:

- The X-Pro manufacturer specifies 12.5 µm burr movement per click and 60 clicks
  per rotation. That supports nominal movement without reverse-engineering a
  thread. It does not specify ground-particle diameter. [X-Pro manual](https://1zpresso.coffee/manual-xpro-en/)
- The P64 manufacturer specifies 10 µm vertical movement for each 0.1 dial line.
  Preserve both the movement and dial-unit definitions: 0.1 printed unit is not
  one whole printed unit. Published total vertical travel is not automatically
  an owner-safe operating range or absolute burr gap. [P64 specifications](https://www.option-o.com/lagom-p64)

Do not round a derived nominal travel per revolution into a supposedly verified
thread pitch. Rounded per-click specifications, unknown thread starts and the
transmission can all prevent that inference.

## 2. Linear travel does not imply a universal gap or grind-size curve

An ideal, directly driven, constant-lead screw produces linear axial travel with
rotation. Use a linear model when that mechanism is established. Do not invent
a polynomial just because espresso time responds nonlinearly.

A documented cam or variable-ratio mechanism may require a piecewise or
nonlinear **mechanical** mapping. Such a mapping needs displacement observations
or a documented mechanism across its operating range. A photo of a numbered
dial alone cannot identify it. Reversal backlash is a direction-dependent
effect; averaging it into a smooth curve hides rather than resolves it.

For ideal parallel flat reference surfaces, axial movement equals their change
in separation. Real cutting faces can have alignment errors, runout, teeth,
load-dependent deflection and different contact points. Report axial carrier
travel unless the actual gap measurand is established.

For an **ideal matching conical pair**, if the cone surface makes angle `alpha`
with its axis, elementary geometry gives:

```text
change in radial separation at fixed height = delta_axial × tan(alpha)
change in normal surface separation         = delta_axial × sin(alpha)
```

These are geometric idealizations, not a measured coffee-burr model. Real burrs
have cutting features and potentially several local angles. An unknown cone
angle cannot be supplied by a universal flat-to-conical factor. Even with a
known angle, neither expression predicts the diameter distribution of fragments.

Espresso research measures particle-size distributions and fines separately;
different fines fractions can change permeability and flow even at a similar
median size. This is why a mechanical micron must not be displayed as a ground
particle micron. [Smrke et al., 2024](https://www.nature.com/articles/s41598-024-55831-x)

## 3. What photographs can and cannot establish

Record each photographic inference separately from measured or published facts.

| Evidence | Defensible use | Missing information |
| --- | --- | --- |
| Clear complete dial view | Count divisions, identify numbering, read an indicated setting | Hidden full rotations, travel, zero and pitch |
| Calibrated view of an exposed thread | Estimate pitch over several visible periods | Start count and carrier transmission unless separately observed |
| Before/after displacement images with a fixed reference and known scale | Estimate relative carrier movement with an uncertainty interval | Absolute gap and operating-load deformation |
| Product image or aftermarket render | Identify a likely mechanism or a candidate part | Reliable dimensional calibration and proof of this owner's generation |

For a dimensional estimate, record the reference length and its plane, camera
geometry, visible features, pixel measurements, estimated resolution and the
method used to correct perspective. A known burr diameter elsewhere in the
image is not automatically a scale for a thread in a different plane. A planar
perspective correction is insufficient for an arbitrary curved collar or hidden
geometry. The photograph itself must not be treated as a precise instrument.

Unscaled images may justify a hypothesis to investigate; their output must not
silently become a physical measurement. Candidate CAD or replica dimensions
remain candidate evidence until the actual part/generation and fit are checked.

## 4. Data contract

Store mechanics separately from `ownerAnchors` and from the empirical
`recommendNativeResponse` history. A mechanics record should carry:

```text
identity:
  model, generation, individualGrinderId?, burrIdentity, calibrationEpoch
coordinate:
  nativeUnit, fullTurnConvention, referenceSetting, referenceMeaning
mechanism:
  kind: direct_screw | geared_screw | differential | cam | electronic | unknown
  mapping: linear | piecewise | measured_points | unknown
  measurand: axial_carrier_travel | defined_face_gap | native_ddd_readout
  pitch?, threadStarts?, lead?, screwRevsPerDialRev?, unitsPerDialRev?
  directMovementPerNativeUnit?, movementSign?, validNativeRange?
reference:
  absoluteOffsetUm: value | null
  zeroMethod, zeroSetting?, zeroRepeatability?, approachDirection?
uncertainty:
  kind: source_tolerance | measured_interval | engineering_scenario | unspecified
  parameterIntervals, correlationsOrSharedAssumptions, unresolvedTerms
evidence:
  sourceUrl, publisherOrObserver, exactClaim, reviewedAt, method, measurements
status:
  manufacturer_nominal | owner_measured_relative | owner_measured_absolute
  | image_estimate | explicit_assumption | unknown
```

`referenceSetting` can be any identified native position; it is not automatically
zero gap. Missing absolute offset remains `null`. Unknown sign, number of starts
or transmission stays unknown, or becomes an explicitly enumerated assumption
in a separate exploratory scenario. Never fabricate two physical anchors by
choosing arbitrary dD values at two dial readings.

Source-reported movement may have no published tolerance. Preserve that absence:
do not attach a default ±5%, standard deviation, or “95% confidence”. Judgement
can support an engineering range when its basis is recorded, but such a range
is not automatically a statistical coverage interval. [NIST Type B uncertainty](https://pml.nist.gov/cuu/Uncertainty/typeb.html),
[uncertainty definitions](https://physics.nist.gov/cuu/Uncertainty/basic.html)

## 5. Exploratory GBS without fake calibration

Allow a clearly labelled **mechanical-estimate experiment** alongside the
ordinary native-shot learner. It must not masquerade as a recovered algorithm
being validated for a DF54/DF64.

1. Keep the ten existing calculations and their software-parity vectors intact.
   Add an adapter with `coordinateStatus: estimated` or `assumed`, source IDs,
   mapping revision, parameter scenarios, and `physicalCalibration: false`.
2. Produce relative movement whenever lead/transmission/divisions/sign are
   supported. Produce an absolute modeled coordinate only when its reference is
   measured, nominally defined, or explicitly assumed. Label those cases
   differently. Pitch alone must not silently supply the offset.
3. Replay each mapping scenario independently from the recorded native settings
   and actual shot times. Never substitute one scenario's recommended setting
   for the setting that was actually brewed. Reset every algorithm's state when
   the mapping, reference, burrs, grinder or recipe scope changes.
4. Preserve the established recipe, clock, controller and interrupted-shot
   gates. A better displacement estimate does not make time-based advice valid
   for arbitrary flow-controlled profiles.
5. Show model outputs in native units with the mapping assumptions and a range
   of **sampled scenario results**. Such a range is not a confidence interval or
   a guaranteed bound: firmware quantization, clamps and state transitions can
   create interior behavior not captured by endpoint sampling.
6. Leave `proposedSetting` in the normal brewing workflow to the native empirical
   learner or the explicitly confirmed small-step rule. An exploratory GBS
   result must not fill a physical setting, calibration anchor or grinder
   command automatically. Direction disagreement, unknown sign, invalid
   mapping domains and out-of-range results are shown as unresolved.

Relevant dependencies in the shipped code:

| Calculation | Why a rough scale alone is insufficient |
| --- | --- |
| GbS1 | Correction, quantization, hysteresis and a lower clamp have fixed research-unit magnitudes. Relative corrections can be explored, but the scale and floor assumptions matter. |
| GbS2 / inverseRegression | The fallback slope and minimum negative slope have research-unit dimensions. An arbitrary conversion changes when those priors dominate; origin and quantization also need consistent handling. |
| GbS3 / GbS4 | Hyperbolic terms depend on the absolute coordinate; an arbitrary positive offset changes predictions. Cancellation and lock behavior also have fixed coordinate/time thresholds. |
| DdEff | Its fixed ±200 dD test sequence converts to different dial moves under different assumed scales. It is a measurement plan, not validated next-shot advice. |
| effectiveDd | Requires real grind duration and retained baseline/state; its fitted dynamics do not become transferable merely because travel was estimated. |
| grindTime | The modeled velocity includes a constant term and an absolute-coordinate coefficient, plus explicit mode/recipe-time inputs. Pitch does not supply those missing inputs or validate throughput. |
| Initial-DD table | The recovered table's output unit remains unresolved; a mechanical estimate cannot retroactively identify it. |

For an unknown absolute offset, an offset-sensitivity scenario is honest if the
assumption is visible. A silent arbitrary “zero” is not. If no defensible range
exists, display the dependency and let the user explore explicitly chosen
scenarios; do not label a midpoint as the grinder's actual gap.

## 6. Promotion to measured calibration

Promote individual facts, not the entire model at once:

- A manufacturer travel-per-click specification can establish a nominal scale,
  while zero remains unknown.
- Direct displacement observations at separated settings can establish a local
  relative scale. Reserve an additional setting to check the interpolation;
  repeat approaches from both directions to expose backlash or hysteresis.
- A separately established reference can add an absolute coordinate, preserving
  the reference definition. Burr contact, a printed zero, carrier height and a
  loaded cutting gap are different references.
- Record uncertainty, valid range, instrument/method, load/temperature state,
  grinder generation, burr identity and calibration epoch. A burr swap,
  reference adjustment or mechanical change invalidates the affected mapping.
- Promotion should compare held-out displacement residuals with the declared
  measurement uncertainty and intended movement resolution. Do not invent one
  universal percentage threshold for all grinders.

Repeated espresso shots can refine the native **seconds per mark** response.
They cannot identify thread pitch, absolute offset or particle-size distribution
without independent mechanical or particle measurements. Good timing agreement
therefore never promotes an assumed mechanical mapping into physical anchors.

## 7. Acceptance tests for a later implementation

- Pitch versus lead: identical pitch with different start counts gives the
  corresponding different travel, rather than silently assuming one start.
- Units and full turns: printed 0.1, one minor tick, one click and one full turn
  remain distinct; a second revolution is not wrapped back to the first.
- Unknown zero: relative displacement is available while absolute gap stays
  unavailable, unless an explicit assumption envelope accompanies it.
- Native coordinate shifts do not change the physical delta of a relative
  mapping; reversing its sign reverses that delta consistently.
- Conical projection is unavailable without defined geometry; nominal click
  movement never appears as particle diameter.
- Invalid photo scale, mismatched generation, unknown thread starts and missing
  transmission cannot produce a verified conversion.
- Piecewise/cam mappings respect segment boundaries and their measured range.
  Reversal-dependent observations do not disappear in a single average line.
- Each GBS assumption scenario has independent state and replays actual shots.
  Offset-sensitive algorithms visibly change when only the assumed offset changes.
- Estimated mappings never enter `ownerAnchors`, native empirical history or
  primary next-setting actions through export/import or reload.
- Existing GBS golden parity stays unchanged. Mechanical uncertainty and
  espresso-response uncertainty remain distinct in results and presentation.


## Shipped API

`createGrinderMechanics(createGrinderMechanicsCatalog())` is embedded in the
plugin and used by the website. Node tooling imports the same factory from
`src/grinder-mechanics.js` and the JSON catalog.

- `profileFor(model)` returns a reviewed model, including its evidence limits.
- `estimate({model, nativeValue, baselineNativeValue, nativeUnit, acceptScenario})`
  returns nominal relative axial movement. DDD readouts additionally expose
  `indicatedDistanceUm`; they are never added twice as a displacement.
- `toPhysicalCoordinate({...input, zeroOffsetUm})` treats `zeroOffsetUm` as the
  declared physical coordinate **at the native baseline**, not an inferred zero.
- `toRelativeCoordinate({...input, finerSign, umPerResearchUnit,
  signedAxialUmPerNative, baselineResearchCoordinate, acceptScenario:true})`
  maps an explicitly accepted movement assumption into experimental research
  units. An absolute research coordinate requires an explicit baseline.
- `proposeNative({model, currentNativeValue, requestedResearchDelta,
  umPerResearchUnit, signedAxialUmPerNative, ownerStep, minNative, maxNative,
  physicalIncrement, physicalOrigin, acceptScenario:true})` divides by the signed
  movement per native unit, caps movement to the owner step/window, and rounds
  toward the current setting on any physical lattice. Missing slope, overflow,
  an invalid setting or an unachievable movement cannot become a dial proposal.

Optional fields should be omitted when unknown. Conical profiles additionally
require `acceptGeometryAssumption:true` before converting axial travel to dD.
P64/LAGOM printed-number input uses `nativeUnit:"printed_number"`; a tenth-line
and a whole printed number have different movement magnitudes.
