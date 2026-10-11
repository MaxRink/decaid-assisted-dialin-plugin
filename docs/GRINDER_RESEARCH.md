# Grinder and assisted dial-in research

This is a source review for calibration fields and product integrations. It
does not establish a universal micrometre-per-mark conversion, a burr-specific
extraction curve, or a mapping from a grinder model to GBS1–GBS4. A dial mark
is a user-interface coordinate; burr gap, particle-size distribution and cup
response are separate measurements.

## Evidence summary

| Grinder/system | Published fact | Calibration consequence | Evidence |
| --- | --- | --- | --- |
| DF64 family | The DF64 collar is sensitive; the manual describes clockwise as finer and counter-clockwise as coarser. It warns that an SSP upgrade makes the stock adjustment sticker inaccurate. | Store model/generation, burr identity, owner-confirmed direction and zero. Never convert the printed number to micrometres. | [Clive DF64 manual](https://support.clivecoffee.com/en/articles/16426035-df64-single-dose-user-manual) |
| DF64 family | The vendor FAQ recommends changing the setting incrementally while the flat burrs are spinning. | Record whether the adjustment was made loaded or unloaded. A purge/settling shot after a large move is this plugin's proposed policy, not a vendor-published calibration constant. | [DF Grinders FAQ](https://df64grinders.com/faqs) |
| DF64 Gen 2 | The 64 mm flat burrs are removable for cleaning or replacement by removing the collar. | Burr replacement is a calibration event; the source does not publish a thread pitch or axial travel per mark. | [Gen 2 manual](https://manuals.plus/asin/B0DPRWGP6L.pdf) |
| LAGOM 01 | Option-O publishes 7.5 µm of burr-gap movement per micro tick and, for its competition configuration, zero calibrated to burr contact within ±2 micro ticks. | This is a manufacturer-specific mechanical reference, not a transferable particle-size or DF64 conversion. Record the exact burr/configuration and zero revision. | [LAGOM 01 guide](https://www.option-o.com/guide-lagom-01), [WBrC specification](https://www.option-o.com/wbrc) |
| LAGOM P64 | Option-O says zero calibration is needed after burr replacement and that shipped units are factory calibrated by production period. | Burr identity and production generation belong in the calibration key; preserve old shot history but start a new calibration epoch. | [P64 guide](https://www.option-o.com/lagomp64userguide) |
| Mahlkönig E64 WS | Its software manual describes an assisted dial-in flow that chooses roast colour, dose/output targets and brew time, then derives an initial grinding degree from previous settings. | This documents a guided workflow, not the recovered GBS implementation or a public physical calibration curve. | [E64 WS software manual](https://downloads.mahlkoenig.de/Service/Mahlkoenig_E64_WS_Espresso_Home_Software_Manual.pdf) |
| Niche Zero | Niche publishes 63 mm conical burrs, an infinitely adjustable dial, and a calibration procedure that sets zero at burr touch. Its guidance says to recalibrate after disassembly/cleaning and to purge roughly 18 g after cleaning. | Store the zero reference and calibration date; do not transfer a Niche setting to a flat-burr grinder. | [Niche Zero](https://www.nichecoffee.co.uk/products/niche-zero), [calibration guide](https://www.nichecoffee.co.uk/blogs/exploring-coffee/how-to-calibrate-your-grinder-for-optimum-performance) |
| Baratza Encore ESP | Baratza publishes 40 mm M2 conical steel burrs, 550 RPM no-load speed, and a numbered split where 1–20 is espresso-oriented and 21–40 filter/coarser brewing. | Treat the number as a model-specific stepped coordinate; RPM and burr geometry are context fields, not a universal extraction equation. | [Baratza Encore ESP specifications](https://www.baratza.com/en-dk/product/zcg495) |
| Timemore Sculptor 064S/078S | Timemore describes 064S/078S flat burrs as pour-over and espresso capable, turbo variants as pour-over focused, and multi-purpose configurations as stepless; the series supports variable RPM. | Burr variant and RPM must be part of the calibration key. The vendor does not publish a DF64-equivalent micron-per-mark conversion in the reviewed pages. | [Sculptor burrs](https://www.timemore.com/products/timemore-sculptor-series-burrs), [Sculptor FAQ](https://www.timemore.com/pages/sculptor-related-faq), [Sculptor series](https://www.timemore.com/products/timemore-electric-coffee-grinder-sculptor-series) |
| 1Zpresso X-Pro / J-Max / K series | 1Zpresso publishes model-specific click travel: X-Pro 12.5 µm, J-Max 8.8 µm, and K series 22 µm per click. Manuals also define model-specific zero procedures and warn against over-tightening. | Click travel is mechanical burr movement for that hand grinder, not particle size and not portable to DF64. Model and burr unit must be stored separately. | [X-Pro manual](https://1zpresso.coffee/manual-xpro-en/), [J-Max manual](https://1zpresso.coffee/wp-content/uploads/2021/08/J-Max-User-Manual-20210819.pdf), [K series](https://1zpresso.coffee/k/) |

The DF64 manufacturer documentation reviewed here (Clive's DF64 manual, the DF
vendor FAQ, the Gen 2 manual and the DF manuals index) did not specify collar
thread pitch, axial travel per mark, or generation-independent marking
geometry. This is a bounded search result, not proof that no such document
exists elsewhere. Those remain per-unit measurements. Even where a maker publishes burr
gap movement, alignment, burr geometry, coffee density, retention, seasoning,
RPM, dose and machine recipe can change the shot response.

## DF64 burr choices and what they do not tell us

The reviewed 64 mm burr listings describe intended use, not a calibration
equation:

- The [DF Grinders 64 mm SSP listing](https://dfgrinders.ca/products/64mm-ssp-red-speed-burrs)
  labels HU as espresso-focused and MP as pour-over-first but also usable for
  espresso, French press and AeroPress. This is a vendor description of brew
  intent; it does not quantify fines, particle-size distribution, extraction
  time or a dial offset.
- Fellow's [SSP 64 mm MP brew burr listing](https://fellowproducts.com/products/ssp-red-speed-coated-64mm-flat-brew-burrs)
  says the burrs are for finer pour-over and grind about 200 µm finer than
  Ode's stock brew burrs in the referenced drip settings. That comparison is
  for the Ode workflow and cannot be applied to a DF64 collar reading.
- The reviewed vendor pages describe HU/MP geometry and coatings by product
  family, but did not publish a DF64 stock/DLC tooth profile, collar-zero
  compatibility table, or a validated HU-versus-MP extraction-response model.
  Treat `stock`, `DLC`, `SSP-HU`, `SSP-MP`, and cast/lab-sweet variants as
  separate burr identities until local shots establish equivalence.

The practical result is to retain the burr SKU, coating and installation date,
then recalibrate zero and collect new matched evidence. A burr label can inform
the starting recipe or a human explanation; it must not silently transform an
old dial coordinate or GBS state.

## Burr swaps, zero and usable calibration

The useful portable record is a calibration epoch, not a global dial number:

```text
grinder_id, model, generation, burr_identity, burr_geometry
zero_reference, zero_method, finer_sign, step_marks, usable_bounds
rpm, dose, recipe/profile, calibration_timestamp, evidence_shots
```

Reset the epoch after burr replacement, carrier or collar disassembly,
alignment work, a changed zero reference, or a grinder revision. Keep the prior
shots linked to their old epoch. A replacement burr can shift zero and can also
change the particle distribution at the same gap; therefore a numeric offset
alone is insufficient. The assistant should learn a local response from
matched shots and should abstain when the burr identity or calibration epoch is
unknown.

For DF64 specifically, the documented clockwise/counter-clockwise convention
is a starting point only. The sticker can become wrong after an SSP upgrade,
and the Gen 2 manual confirms that the burr assembly is user-accessible. The
plugin therefore requests owner-confirmed `numericFinerDelta` and does not
derive it from the model name. The recommendation should describe a relative
move (“one calibrated step finer”) before offering a numeric coordinate.

## Assisted systems and useful design patterns

The following systems are useful comparison points, but their internal models
are not public enough to reuse as algorithms:

- **Mahlkönig E64 WS:** the official manual presents a guided roast/dose/time
  setup and an initial grinding-degree suggestion. It does not publish a
  grinder-independent dial calibration or establish that E64 WS, E65 or E80
  uses a particular research GBS version.
- **Fiorenzato ADAPT:** the manufacturer says its wired grinder/flow-meter
  system learns a recipe and displays a grind adjustment suggestion after three
  extractions miss the recipe. This supports a design of delayed, evidence
  based suggestions; it does not expose the coefficients or permit replay.
  See the [ADAPT description](https://www.fiorenzato.com/en/adapt/).
- **MARO Model 1:** MARO advertises a Smart Profiler that monitors flow and
  pressure, a Grind Analyzer that recommends a grind size, and a Coffee Diary for saved
  recipes and shots. These are product claims, not a public API or reproducible
  dial algorithm. See [MARO Model 1](https://maro.coffee/en/products/maro-model-1)
  and [MARO HOME](https://maro.coffee/en/pages/maro-home).
- **GrindDial, Pressio and BrewTuner:** their public product pages describe
  unit calibration, grinder/bean/history inputs and adaptive recommendations.
  They are useful product precedents for per-unit calibration and provenance,
  but their sensitivity curves and training data are proprietary or
  undocumented. See [GrindDial](https://grinddial.com/),
  [Pressio](https://www.pressio.live/), and
  [BrewTuner methodology](https://brewtuner.io/tools/methodology).

These systems support product requirements such as recording the source shots,
showing why a recommendation was made, delaying a suggestion until enough
matched evidence exists, and providing a reset action. They do not supply
licensed coefficients for this plugin and must not be treated as validation of
the research replay.

## Inputs the plugin can use safely

For a calibrated owner, a future richer suggestion can use:

1. a stable grinder and burr identity;
2. a calibration epoch and owner-confirmed finer direction;
3. an observed zero reference and local step size, expressed in dial units;
4. dose, yield, brew time, recipe/profile and machine context;
5. taste assessment with explicit uncertainty and conflict handling; and
6. recent matched shots after the same burr and calibration epoch.

The algorithm should fit a local response in the user's dial coordinate and
report residuals and evidence age. It should not infer a micrometre conversion,
carry a calibration across burrs, or translate a numeric sign into a motor
command. A dedicated reset button should start a new epoch and explain why old
shots are no longer eligible for numeric calibration.

## Open evidence gaps

- The bounded DF64 manufacturer-document search above did not find collar thread
  pitch, axial travel per mark, or generation-independent marking geometry.
- No primary burr-vendor source reviewed here publishes a general mapping from
  burr geometry and gap to espresso extraction time.
- The public E64 WS, Fiorenzato ADAPT and MARO materials describe workflows and
  outcomes but do not publish replayable recommendation equations.
- Empirical community reports can help design test cases, but their grinder
  generation, zero method, burr alignment, coffee and measurement protocol are
  often incomplete. They are lower evidence than manufacturer manuals and are
  not suitable as default calibration constants.

This document summarizes public pages and links to them; it does not copy
proprietary manuals, application code, databases or recommendation models. The
reviewed product pages and manuals did not grant an open-data or code license
for their specifications or recommendation logic, so the plugin uses links and
short factual summaries only. No vendor coefficients or datasets are bundled.

## Research, measurement tools and open integrations

| Primary source | Usable evidence | Reuse boundary |
| --- | --- | --- |
| [Cameron et al., Systematically Improving Espresso](https://researchportal.port.ac.uk/en/publications/systematically-improving-espresso-insights-from-mathematical-mode/) | Dose, grind and extraction experiments show that finer grinding does not always increase extraction: inhomogeneous flow can reduce it. A homogeneous-flow model has a limited operating region. | The accepted manuscript is CC BY-NC-ND. Cite the findings; this review does not import figures, equations or experimental datasets into the plugin. |
| [Schmieder et al., espresso extraction kinetics](https://pmc.ncbi.nlm.nih.gov/articles/PMC10418593/) | Controlled flow, grind and temperature experiments measured TDS and caffeine/trigonelline/5-CQA across ten brew fractions. Flow and temperature are relevant context, rather than unique indicators of grind. | Article CC BY 4.0; data are available from the authors on request, rather than a verified downloadable training dataset. |
| [Gagné, coffeegrindsize](https://github.com/jgagneastro/coffeegrindsize) | Calibrated photographs can yield particle-size distributions. Image scale, separation, contrast and overlap affect the results; particle size cannot uniquely determine a dial setting. | MIT-licensed tool. Preserve its license and attribution if reused. User photographs and generated measurements need their own provenance. No labeled grinder-to-shot dataset is supplied by the reviewed repository. |
| [Barista Hustle Espresso Compass](https://www.baristahustle.com/the-espresso-compass/) | Strength, extraction and beverage yield are coupled. Uneven flow can make further fine adjustments counterproductive. | Cite the explanation; the copyrighted compass graphic and text are not bundled. |
| [Beanconqueror](https://github.com/graphefruit/Beanconqueror) | Its logging vocabulary covers beans, grinder settings, dose, time, first drip, taste and supported flow/pressure integrations. Useful for explicit import/export mappings, not for guessing missing device measurements. | GPL-3.0 source. Any reused code must retain attribution and satisfy that license; no code is imported in this review. |

These sources reinforce a distinction between observations and diagnoses.
Elapsed time, scale weight and machine flow/pressure are measurements; extraction
yield requires an actual measurement such as TDS, and acidity alone does not
establish under-extraction. Conflicting evidence should lead to an explanation
and abstention, rather than a larger grind adjustment.

No openly downloadable dataset with grinder coordinate, burr identity,
particle-size distribution, flow, pressure, temperature, TDS and taste labels
was found in this reviewed source set. Such a dataset must not be implied by
the synthetic algorithm plots. A useful next experiment is controlled local
sampling that holds dose, yield, profile and coffee constant, records burr and
zero calibration, and stores both measured signals and explicit operator taste.

## What the papers can and cannot tell us

The useful physical picture is simple: a dial or display tells us where a
particular grinder is set; it does not directly tell us the particle-size
distribution or how a shot will taste. The safe chain is:

`this grinder instance and burr set -> its measured burr coordinate -> its measured PSD -> its observed shot`.

The papers below establish parts of that chain, but none supplies a universal
curve for the 16 plugin profiles. They also used different grinders, coffees,
measurement instruments and brew methods, so their numbers must not be copied
as DF64, DF54, Niche, Ode, Sculptor or 1Zpresso defaults.

* [Uman et al., Scientific Reports 6, 24483 (2016)](https://www.nature.com/articles/srep24483)
  used a Mahlkönig EK43 with Turkish burrs, laser diffraction, a fixed 2.7
  dial setting and four coffees. Under those conditions, origin and processing
  method did not change PSD; colder beans produced a narrower distribution and
  smaller mean size. This is evidence about temperature and the tested EK43,
  not evidence that origin changes PSD everywhere.
* [Cameron et al., Matter 2, 631–648 (2020)](https://doi.org/10.1016/j.matt.2019.12.019)
  used a Mahlkönig EK43 with coffee burrs and espresso equipment. Its model
  and measurements separate the coarse/boulder response to burr separation
  from fines created during fracture, and show extraction can fall at both
  very coarse and very fine settings. It supports keeping shot response
  flexible; it supplies no home-grinder dial pitch.
* [Smrke, Eiermann & Yeretzian, Scientific Reports 14, 5612 (2024)](https://doi.org/10.1038/s41598-024-55831-x)
  used a Bentwood Vertical 63, whose scale is calibrated in burr-spacing µm,
  plus an EK43 comparison. Using one Costa Rican coffee, settings 160–250,
  sieved fines and a 20 g / 40 g espresso on a Victoria Arduino Black Eagle,
  it found that more fines reduced permeability and lengthened extraction.
  This is the closest reviewed evidence for a measured burr-distance coordinate
  and espresso response, but it still does not transfer to another grinder or
  burr set.

These experiments are why the plugin stores the displayed coordinate, physical
unit, burr identity, zero method and calibration epoch separately. A DF64 Gen
1, DF64 Gen 2 or DF54 owner can add an individual grinder profile, enter their
own zero and measured points, and replace the factory prior with local evidence.
The plugin must not invent a thread pitch or convert the printed DF64/DF54
number into micrometres. Even a real burr-spacing value is a mechanical
coordinate, not a grounds-particle diameter.

The compact, claim-scoped source ledger is shipped at
[`docs/research/grinder-evidence.json`](research/grinder-evidence.json).

