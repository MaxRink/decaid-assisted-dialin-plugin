# Recovered algorithm trajectories

# How to read these plots

Blue means the suggestion that the algorithm kept or returned. Orange means a
new calculation that it considered. A `hold` label means the previous
suggestion was retained, `cancel` means an update was rejected after a major
input change, and `lock` means the stable suggestion was retained. The timing
figure shows the brew time supplied to the algorithm against its target. The
plots are examples generated from synthetic inputs, not a prediction of a
physical grinder.

`scripts/plot-algorithms.py` executes the actual `createResearchAlgorithms()`
factory from `plugin.js` through Node, records every returned pass and state,
then renders the recorded values with Matplotlib. It does not copy the
formulas into the plotting code. Matplotlib is a development-only dependency;
the plugin itself has no Python runtime dependency.

Run from the plugin repository:

```sh
MPLCONFIGDIR=/tmp/decaid-mpl-cache python3 scripts/plot-algorithms.py
# Recompute without changing committed artifacts:
MPLCONFIGDIR=/tmp/decaid-mpl-cache python3 scripts/plot-algorithms.py --check
```

The command writes:

- `trajectories.json`: inputs, outputs, phases, commit/lock flags, and next state;
- `trajectories.csv`: pass-oriented ledger for review or spreadsheet import;
- `pass-ledger.md`: readable per-pass table including phase, candidate/returned
  values, history, hold, filter, and effective-DD baseline;
- `trajectories.svg` and `.png`: six panels for GbS1, GbS2, GbS3, GbS4, DdEff,
  and effective DD;
- `supporting-calculators.svg` and `.png`: manual DF54/DF64 profiles,
  grind-time modes, and inverse-regression sweep;
- `timing-inputs.svg` and `.png`: actual versus target brew time used on each
  GBS pass.
- `wizard-sweep.svg` and `.png`: all nine model/roast combinations across
  three doses; the physical coordinate unit remains unverified.

Individual `algorithm-*.svg` and `.png` files provide a larger readable view
of each native algorithm.

The GBS scenarios cover warm-up, regression history, V3/V4 hold and phase
behavior, and a large DD change. DdEff is shown as a separate 18-call
measurement sequence (`6 × initial`, `6 × initial-200`, `6 × initial+200`), so
it is not mixed into brew-response plots. Effective DD, grind-time adjustment,
and the manual DF64 heuristic are recorded in the JSON `extras` object.

The input matrix is explicit:

| trace | inputs used | inputs intentionally excluded |
| --- | --- | --- |
| GbS1 | actual/target brew time, estimated and setpoint DD, tolerance, rolling history | bean identity, roast, taste, pressure and flow |
| GbS2 | the same timing/DD inputs plus up to six learned points | bean identity, roast, taste, pressure and flow |
| GbS3/GbS4 | the same inputs plus phase factors, filter, hold countdown and learned state | bean identity, roast, taste, pressure and flow |
| DdEff | initial DD and call number | brew timing and sensory inputs; this is a measurement sequence |
| effectiveDd | grind DD, grind duration, residue and explicit caller baseline | recipe taste and machine pressure/flow |
| grindTime | recipe DD, target DD, recipe time and mode | sensory feedback and grinder actuation |
| manual | elapsed/target time, taste, profile, calibrated dial step/sign/bounds | automatic device writes |

The plotted GBS panels show both candidate (orange) and returned (blue) values.
The complete actual inputs, phases, and state are in `pass-ledger.md` and
`trajectories.json`; the figures label only the decision points so the graphs
remain readable.

Axes use the algorithm's DD coordinate/model units. The wizard's coordinate
unit is explicitly unknown. The firmware build and evidence limits remain
those of the factory: static normal finite-input replay, no physical grinder
direction, no hardware validation, and no claim that a plotted recommendation
is safe to actuate automatically.
