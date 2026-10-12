# What is ready, and what still needs validation

The software can be tested without coffee hardware. That does not establish a
physical grinder’s calibration or prove that a recommendation improves a drink.

| Work | Current evidence | What completes it |
|---|---|---|
| Plugin packaging and installation | Minimal ZIP, manifest parser and real pinned host runtime in CI | A matching GitHub release with one tested ZIP |
| Beginner and expert UI | Chromium, Firefox, WebKit and mobile synthetic journeys | Retain the browser matrix on every release |
| Observed grinder setting/RPM in saved shots | Intended workflow data and explicit owner confirmations only | Upstream [read-only observations #973](https://github.com/decentespresso/decaid/issues/973) and [capture/provenance #974](https://github.com/decentespresso/decaid/issues/974) contracts, then round-trip/race tests against them |
| Streamline navigation and history actions | Native extension URL is available | Upstream [PR #100](https://github.com/decentespresso/streamline-js/pull/100) review and merge |
| Old shots with incomplete context | Explicit per-shot confirmation or abstention | Owner confirmation of the actual historical facts; never copy today’s setup backwards |
| Grinder-specific response | Owner-confirmed native units and bounded suggestions | Individual grinder/burr/zero calibration and controlled physical shots |
| Manufacturer photographs | Links to original sources; original packaged schematics | Exact reusable licence for each image, attribution and model verification |

## A hardware-free release check

Run the required CI matrix: Node 22/24/26, package regression tests, deterministic
algorithm replay and graphs, all browser journeys, and the pinned Decaid package
parser plus QuickJS/API/storage tests. Missing taste, native clocks, calibration,
bean context or matched settings must produce a visible abstention. Changing a
current setting cannot change the meaning of a saved shot. The simulation uses
the shipped algorithms; fictional practice observations are labelled and cannot
be presented as calibration measurements.

E64’s separate CI uses a grinder mock and the actual Linux app/host. Skale’s
separate CI uses fake GATT and the host/settings browser. These cover protocol,
instance/session lifecycle, errors and credential redaction without real devices.
They do not prove a particular device firmware or Bluetooth environment works.

## A physical validation session

1. Identify the individual grinder, burr set and replacement/calibration epoch.
   Record its actual native units, usable limits and the owner-confirmed finer
   direction. DF54/DF64 marks and E64 micrometres are different coordinates;
   micrometres of adjustment do not establish coffee particle size.
2. Record the bean and batch, roast date/level when known, recipe/profile,
   basket, dose, measured output, brew temperature and tasting conditions.
   Keep these comparable across the shots used to estimate grind response.
3. Measure repeated shots at safe small owner-selected changes. Retain the
   saved traces, explicit timing clock, feedback and actual setting used. Record
   puck preparation or other changes as possible confounders. Do not diagnose
   channeling from a flow feature alone.
4. Hold out later shots when checking the recommendation. Report the setting
   suggested, observed time/flow/yield and the user’s sensory result, including
   failures and abstentions. A useful software replay is not a physical trial.
5. Store evidence with a grinder/burr/epoch identity and source. Do not transfer
   that calibration to another grinder, replace unknown observations with
   targets, or assign a recovered firmware algorithm to a model without evidence.

There is no universal minimum sample count or transferable dial response claimed
here. Until a physical trial exists, the UI describes a conditional experiment
and uses owner-confirmed bounds; it does not advertise validated efficacy.

## When the upstream observation contract is accepted

Add its adapter in one reviewed change. Test absent/old records, intended versus
observed values, units and provenance, unavailable/stale device state, explicit
manual confirmation, same-ID reconnect, changed selected grinder, delayed
callbacks, calibration changes and export/import round trips. The dose-to-shot
capture association must follow the accepted contract; querying whichever live
grinder happens to be connected at shot-save time is not sufficient.
