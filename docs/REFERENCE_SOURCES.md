# Reference catalog and recipe evidence

The machine-readable catalog is [`data/reference-catalog.json`](../data/reference-catalog.json).
It contains 43 reviewed sources as of 2026-10-11. Each record states the
publisher, source type, exact scope, numeric facts where the source publishes
them, and a reuse boundary. A recipe is evidence for that named coffee,
roaster, brewer or grinder configuration; it is not a universal target.

## How to read the data

The catalog keeps four things separate:

- **Brew recipe:** dose, beverage yield, time and temperature prescribed by a
  roaster or manufacturer.
- **Mechanical coordinate:** a dial number, click travel or burr-gap movement.
  A mechanical micrometre value is not particle size and is not a promise about
  extraction time.
- **Coffee scope:** a bean-specific recipe, a roaster's generic starting point,
  or a manufacturer/model configuration.
- **Physical evidence:** research findings about particle-size distribution,
  flow and extraction. These explain why a simple monotone dial curve can fail;
  they do not provide a DF64 calibration table.

The catalog intentionally stores `min`/`max` ranges where the source gives a
range and scalar values where it gives one value. It does not manufacture a
ratio, temperature, yield or grind coordinate when the source omits it.

## What the references support

The roaster sources provide useful starting recipes: Square Mile Red Brick
publishes 19g, 1:2, 28–32s and 94–94.5°C for a VST 20g basket; Tim Wendelboe
publishes 19–20g, 42–45g, 25–35s and 93–94°C; Counter Culture publishes 18g to
36g at 28s and a broader 25–35s adjustment window; Blue Bottle publishes a
20g-to-40g, 28–32s long pull. Prolog and La Cabra deliberately show that
different reputable roasters can prescribe materially different espresso
times and yields. Those records are starting points for a matched coffee and
recipe, not automatic numeric suggestions.

Onyx entries are intentionally bean-specific. Its published espresso examples
range from 18–19g doses, 42–50g yields and 22–25s times across the reviewed named coffees.
The catalog keeps each coffee separate so the simulator cannot treat those
numbers as one generic Onyx recipe.

Manufacturer records establish configuration boundaries: DF64 direction and
SSP sticker caveat, Baratza Encore ESP's 550 RPM and setting ranges, Timemore's
current 064S/078S/078 Turbo burr variants and variable RPM, Niche's burr-touch
calibration, Option-O's configuration-specific 7.5µm LAGOM 01 tick movement,
E64 WS's guided workflow, Fiorenzato's three-miss suggestion trigger and
MARO's verified feature-level claims. The E64 record intentionally contains no
numeric example recipe: the reviewed PDF was not independently reachable, and
its screen examples are not calibration specifications. Moccamaster water is
stored as “6 cups (half pot)” rather than an invented gram conversion.
None supplies a universal model-to-GBS mapping or a DF64 burr-SKU extraction
curve.

The peer-reviewed references support caution. Open-access work reports that
flow effects are stronger at finer grind and higher temperature, that particle
size distribution changes packed-bed permeability, and that extraction or
aroma can become non-monotonic at very fine sizes. The CC BY 4.0 article is
linked rather than copied; the other papers remain linked factual summaries
because reuse rights were not established in this review.

The catalog also includes the verified mechanical references from the grinder
review: 1Zpresso's model-specific X-Pro (12.5 µm/click), J-Max (8.8 µm/click)
and K-series (22 µm/click) values; these are burr movement in each manual, not
particle size. SSP HU/MP descriptions remain brew-intent labels, and Fellow's
200 µm MP comparison is explicitly scoped to the Ode rather than DF64. Option-O
P64 recalibration, DF64 running-adjustment and Gen 2 burr-access guidance are
stored as maintenance facts without inventing a pitch or zero offset.

Coffee Ad Astra's open measurement-tool and 300-PSD references, Barista
Hustle's filter-only Coffee Compass, and Beanconqueror's GPL-3.0 logging/device
integrations are included as software and measurement precedents. Their code,
graphics and recommendation logic are not copied into this plugin.

Two additional roaster references make freshness and water explicit context:
La Cabra recommends at least 10 days of rest, treats coffees beyond six weeks
as well rested, and changes temperature/contact-time strategy with age; its
water guidance explains the role of hardness and buffering. Onyx's brew-guide
index exposes origin, process and roast-level filters, reinforcing that its
published recipes are coffee-specific rather than universal settings.

## Use in a simulator or assistant

Use recipe records to seed a user-visible starting context, never to overwrite
the user's measured shot. Keep `coffee`, `brewMethod`, `equipment`, burr SKU,
generation and calibration epoch in the comparison key. Fit a local response
in the user's own dial coordinate only after collecting matched shots. A
numeric recommendation needs owner-confirmed finer direction, zero reference,
step calibration and current burr identity.

The simulator should vary dose, yield, time, temperature, bean identity, burr
identity, RPM and profile independently. It should be able to produce a
non-monotone response or a changed response after a burr swap. It must not
turn 7.5µm per LAGOM tick, 12.5µm per X-Pro click or any other published travel
into a DF64 setting.

## Coverage and gaps

This is a bounded review of accessible official manufacturer pages, roaster
guides and indexed research pages on 2026-10-11. It is not a claim to cover all
web material. Missing or uncertain fields include DF64 collar thread pitch,
generation-independent axial travel, stock/DLC tooth geometry, SSP zero
compatibility, burr-SKU particle distributions, and licensed raw extraction
datasets. Community observations may help generate future test cases, but they
are not included as default calibration constants.

No source grants this plugin permission to redistribute proprietary databases,
recommendation coefficients, or copied manual text. The catalog stores links
and short factual summaries only.
