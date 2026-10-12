# Mechanical grinder priors

This package exposes a small, pure helper for explaining approximate grinder adjustment mechanics. It is deliberately separate from the shipped dial conversion and recommendation runtime.

```js
const { createGrinderMechanics } = require("../src/grinder-mechanics");
const catalog = require("../data/grinder-mechanics.json");
const mechanics = createGrinderMechanics(catalog);
```

The API has three safe operations:

- `profileFor(model)` returns the reviewed catalog entry or `null`.
- `estimate({ model, nativeValue, baselineNativeValue })` reports a sourced absolute disk distance or a relative mechanical movement. Relative pitch estimates require an explicit baseline; a dial mark is never treated as an absolute burr gap.
- `toPhysicalCoordinate({ model, nativeValue, baselineNativeValue, zeroOffsetUm })` can produce a provisional physical coordinate only when both the relative movement and physical zero are explicit. The result is marked `provisional_physical_coordinate` and must not be saved as owner calibration.
- `toRelativeCoordinate({ model, nativeValue, baselineNativeValue, finerSign, umPerResearchUnit, baselineResearchCoordinate? })` returns a signed relative research movement. An absolute research coordinate is returned only when a baseline coordinate is supplied; no offset is inferred.
- `proposeNative({ currentNativeValue, requestedResearchDelta, umPerResearchUnit, finerSign, ownerStep, minNative?, maxNative?, physicalIncrement?, acceptScenario: true })` rounds and bounds an explicitly accepted scenario against the owner’s achievable step. It never writes calibration.

The values describe axial disk movement or a normalized control position. They do not describe particle-size distribution, shot time, extraction, burr geometry beyond the stated reference, or a physical zero offset. Owner calibration and observed brew traces remain authoritative for recommendations.

Each catalog entry records its uncertainty, basis, and source. Missing pitch, range, or zero information produces `unavailable` rather than an invented number. Printed collar ranges are descriptive and are never enforced as operating limits unless a catalog entry explicitly marks them as verified bounds.
