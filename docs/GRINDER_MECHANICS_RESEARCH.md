# Grinder mechanics: evidence for all 16 catalog models

Reviewed 12 October 2026. This report separates manufacturer specifications, firsthand measurements, conditional calculations and unresolved quantities. `mechanics.json` contains the model-by-model evidence and source ledger; `implementation-contract.md` defines how these facts can enter an exploratory model without becoming fabricated calibration.

The strongest useful result is that a mechanical prior is possible for several models even without a measured shot-response curve. That prior describes **relative burr movement**. It does not establish the owner's absolute burr gap, particle-size distribution, or seconds of extraction per dial increment.

## Results

| Catalog model | Best supported physical coordinate | Revolution / pitch result | Status and scope |
|---|---|---|---|
| E64 WS | 1 displayed µm = 1 µm in indicated disc-distance coordinate | Motor/encoder transmission lead unknown | Manufacturer display semantics; positioning accuracy is not specified here |
| E65S GbW | DDD distance readout; manual lever separately | Brochure180–600µm across80-step indicating scale gives conditional5.25µm/interval | Endpoint calculation only; not a verified thread pitch or actual detent |
| E80S GbW | DDD distance readout; manual lever separately | Exact-model lead unknown | E80S brochure150–450µm/100steps would give3µm/interval, but transfer toGbW unverified |
| DF64 Gen1 | Approximately10.4µm per original dial notch | If120equal notches/rev, approximately1.248mm/rev | Firsthand owner measurement; full-turn count conditional |
| DF64 Gen2 | No qualified numeric movement found | Unknown | Gen1 and DF64V values cannot be silently transferred |
| DF54 | Candidate8.33µm/mark | Candidate1mm pitch,120equivalent marks/rev | Chinese review's smart transcript; original measurement not verified |
| Niche Zero | Relative native setting; physical slope unresolved | Unknown | Patent/guide identify adjustment construction, not a numeric pitch |
| Encore ESP | Reported20µm vertical/click in fine region;90µm in coarse region | One global lead/slope inappropriate | Manufacturer-representative interview; exact20→21 interval unresolved |
| Sculptor064S | Candidate3µm per **side groove** | Unknown | Owner correction without metrology method; not a printed-line value |
| Sculptor078S | Approximately30µm per whole printed number | Owner-measured approximately0.6mm pitch | Firsthand measurement; revision/error unspecified |
| LAGOM01 | 7.5µm vertical per0.1line;75µm/whole number |750µm/rev only if100minor intervals confirmed | Manufacturer specification; revolution count remains conditional |
| LAGOM P64 |10µm vertical per0.1line;100µm/whole number |1mm/rev only if100minor intervals confirmed | Manufacturer specification; revolution count remains conditional |
| X-Pro |12.5µm nominal burr movement/click;60clicks/rev | Derived750µm/rev | Manufacturer nominal specification; not measured surface-normal gap |
| J-Max |8.8µm nominal/click;90clicks/rev | Manufacturer0.8mm/rev | Per-click8.8 is rounded;90×8.8 is792, not an alternative exact lead |
| K-Pro/K-Max/K-Plus |22µm nominal/click;90clicks/rev | Derived1980µm/rev | Do not round this into a claimed2mm thread specification; excludesK-Ultra |
| Ode Gen2 |31native positions/11numbers; physical slope unresolved | Unknown | Manufacturer does not support espresso; click count does not imply360° |

## DF64 and DF54: what the extra research established

A [firsthand Home-Barista measurement, post12](https://www.home-barista.com/grinders/user-experience-with-timemore-sculptor-grinders-078-078s-t89609-10.html) reports approximately10.4µm per DF64v1 notch. Its8.3µm comparison is **DF64V**, not DF64 Gen2. The same observer reports approximately0.6mm for the078S adjustment thread and30µm per whole dial number. The method, instrument and uncertainty are absent; these are useful low-confidence relative-motion priors, not factory tolerances.

For DF54, an original Chinese review by 资深硬核自家咖啡 has a [Douyin smart transcript](https://www.douyin.com/video/7348713697268862258?source=Googlebot-sdc) describing1mm pitch and a0–90scale covering270°, hence120equivalent divisions around360°. Under single-start, direct-drive assumptions,1000/120=8.33µm per mark and4.17µm per half-mark. The [matching original Bilibili video](https://www.bilibili.com/video/BV1HH4y1p7vj/) was identified, but its original audio/measurement could not be independently checked. The JSON deliberately keeps this out of the established movement field. The transcript's claim of4.15µm for a half mark is rounding; calculated4.17µm is more consistent with its premises.

[Replacement collar photos](https://dfgrinders.ca/products/collar) establish separate DF54/DF64 parts but contain no dimensioned pitch. The [DF64 vendor manual](https://support.clivecoffee.com/en/articles/16426035-df64-single-dose-user-manual) confirms the rotating collar and warns that different burr thickness changes zero. The [DF54 vendor page](https://miicoffee.shop/products/miicoffee-df54-single-dose-coffee-grinder) describes the wave-spring upper-carrier construction. These support an ideal screw-motion model; they do not prove identical leads across generations.

No model-qualified manufacturer dimensioned thread drawing, adjustment CAD or verified thread measurement for DF64 Gen2 emerged from the English, German and Chinese searches. A Gen1-like10.4µm/mark scenario can be presented as an explicit cross-generation assumption, but must remain outside automatic defaults. The DF64-AIR design patent is a different model and an ornamental design; it does not establish the requested lead. Connector specifications carrying the part nameDF64 are unrelated.

## Manufacturer-supported movement

OPTION-O directly publishes [P64 movement](https://www.option-o.com/lagom-p64) of10µm per0.1line and [LAGOM01 movement](https://www.option-o.com/lagom-01) of7.5µm per0.1line. Multiplying each by10 gives movement per whole printed number. A full-turn value still requires confirming the full-turn number of intervals, rather than counting a visible arc. The [01 FAQ](https://www.option-o.com/wbrc-resource) also distinguishes gap from particle size and describes a burr-touch reference slightly below indicated zero. The P64 published negative-to-positive travel range is a mechanism travel statement, not a safe burr-gap range. [P64 zero procedures](https://www.option-o.com/lagomp64userguide) vary with production date.

[X-Pro](https://1zpresso.coffee/manual-xpro-en/), [J-Max](https://1zpresso.coffee/manual-jmax-en/) and [K-Pro/K-Max/K-Plus](https://1zpresso.coffee/k/) provide native clicks and nominal burr movement. The [J-Max Chinese manual](https://1zpresso.coffee/wp-content/uploads/2021/12/J-Max-%E8%AF%B4%E6%98%8E%E4%B9%A620211105.pdf), page1, additionally gives0.8mm rise/fall per revolution. These conical grinders' axial movement must not be represented as equivalent particle diameter or surface-normal clearance. Thread-start count remains unverified; derived movement/revolution is therefore labeled lead/travel, not thread pitch.

The [E64 WS instructions](https://downloads.mahlkoenig.de/Service/Mahlkoenig_E64_WS_Espresso_Home_Original_instructions_EN.pdf) establish displayed disc-distance semantics and calibration. The [software manual](https://downloads.mahlkoenig.de/Service/Mahlkoenig_E64_WS_Espresso_Home_Software_Manual.pdf) exposes adjustment diagnostics but does not publish gearing or screw lead. Neither screen resolution nor encoder indication establishes positional accuracy.

The manufacturer [E65S GbW brochure](https://www.primulator.lt/media/repository/Mahlkonig/E65S_Gbw/Mahlkoenig_E65S_GbW_Brochure.pdf), pages6/8, gives the distance range and80-step indicating scale. Dividing total travel by80 is only conditional: the text does not settle80marks versus80intervals, endpoint correspondence or uniformity. The [E80S brochure](https://downloads.mahlkoenig.de/Products/Mahlkoenig_E80S_Espresso_Grinder_Product_Brochure.pdf) is not an exact E80S GbW specification. The [E80/F80 GbW instructions](https://downloads.mahlkoenig.de/Service/Mahlkoenig_E80_F80_GbW_Espresso_Grinder_Original_instruction_manual_EN.pdf) identify manual lever adjustment and calibration but do not resolve a numerical lead. Modern motorized E80W/Sync architecture must not be projected onto either manualSmodel.

## Piecewise motion and unresolved models

The [Encore ESP manual](https://assets.breville.com/ZCG495/manual-encoreesp-v1-0-en-010923.pdf) establishes two adjustment regions. In a [firsthand WIRED interview](https://www.wired.com/review/baratza-encore-esp-coffee-grinder/), a company representative supplies20µm and90µm vertical movements. This is stronger than an unattributed conversion chart, but remains an interview report, with no published metrology tolerance and an ambiguous region-boundary step. Use separate regions; do not extrapolate a single slope across the dial. Shims shift the available range.

For Sculptor064S, [a later owner correction](https://www.home-barista.com/grinders/proposed-alternative-to-marker-test-for-burr-alignment-t91921-10.html) says prototype-era pitch assumptions changed, and distinguishes side grooves from printed lines. Its3µm/groove claim lacks a supplied measurement method. Earlier5µm/minor-line and chirp-to-lock calculations are not independent confirmation because they already assume a conversion. The [manufacturer FAQ](https://www.timemore.com/pages/sculptor-related-faq) confirms steplessSmodels, not numerical travel.

For Niche Zero, the [manufacturer calibration guide](https://www.nichecoffee.co.uk/blogs/exploring-coffee/how-to-calibrate-your-grinder-for-optimum-performance) and [grinder patent](https://patents.google.com/patent/GB2562504A/en) were examined; no model-qualified numeric pitch was found. Niche Duo1.5mm claims concern a different flat-burr machine. A review comparing Gevi dial granularity with Niche does not establish Niche's pitch.

For Ode Gen2, [the product's31positions](https://fellowproducts.com/collections/grind-brew/products/ode-brew-grinder-gen-2?variant=40978992529508) and [burr-specific calibration/backoff](https://help.fellowproducts.com/hc/en-us/articles/7767147426843-how-do-i-install-and-calibrate-my-ode-gen-2-brew-burrs-and-ssp-mp-burrs) do not establish axial travel per click. [Manufacturer espresso suitability guidance](https://support.fellowproducts.com.au/en_us/is-ode-gen-2-suitable-for-grinding-espresso-HJt8Rm8qZe) also prevents presenting an espresso adjustment default for the stock grinder.

## How to close the mechanical unknowns

For a numeric prior, prefer a dimensioned adjustment-thread drawing with starts/lead, or a repeatable carrier-displacement measurement against a fixed housing datum over known angular travel. Repeat in both directions to expose backlash; record model, revision, burrs, preload/assembly state and instrument resolution. A dial photograph can establish equal angular divisions if the full circumference or a rectified scale is visible. An unscaled oblique thread photograph cannot credibly distinguish nearby pitches.

At minimum record whether a number describes axial travel, local normal separation, displayed distance or particle size. A first chirp is the earliest local contact of imperfectly parallel/true surfaces; full lock is a different reference. Do not force lock to manufacture an absolute zero. Follow the manufacturer's service procedure.

No source provided a traceable uncertainty budget for these owner measurements. The ledger uses qualitative confidence and explicit unknown intervals rather than fabricated±percent bounds. Any exploratory model may vary an assumed slope/offset visibly, but such a scenario envelope is a modeling choice, not a measured confidence interval.

No photographs or drawings were copied into the project: the sources are linked, and no reusable image licence was established. Manuals and patents were used to inspect mechanisms; no dimensioned production drawing was found that closes all16models.

## Optional exploratory scenarios

The user explicitly allows rough estimates. To make an exploratory calculation concrete, the JSON also supplies **analyst-chosen sensitivity envelopes**, kept separate from evidence fields:

| Model | Central relative slope | Exploratory slope interval | Assumption |
|---|---|---|---|
| DF64 Gen 1 |10.4 µm/original notch |8–13 µm/notch | One-owner report is representative |
| DF64 Gen 2 |10.4 µm/original notch |8–13 µm/notch | Gen 1 transmission and dial spacing transfer |
| DF54 |8.33 µm/original mark |6–11 µm/mark | Video transcript's pitch/divisions are correct |
| Sculptor 078S |30 µm/whole printed number |24–36 µm/number | Owner's approximate measurement is representative |

These intentionally broad, rounded ranges are **not sourced tolerances**, measured uncertainty bounds, or guarantees that the true value lies inside them. The endpoints are modeling choices for sensitivity exploration. The UI should show the assumption, native unit and editable range and record acceptance; this does not require stopping all other setup work. An unknown absolute offset remains unknown. Absolute-gap-dependent GBS scenarios require a separately visible offset assumption and must not generate fabricated calibration anchors.
