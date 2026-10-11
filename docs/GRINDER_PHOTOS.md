# Grinder image rights audit

Reviewed 2026-10-11 for the 16 model profiles in `data/grinder-dials.json`.

## Decision

The linked product photographs are useful model references, but the manufacturer and retailer pages do not grant a redistribution licence. They stay as external source links and are marked `renderAllowed: false`; the shipped UI must use the repository schematic unless a separately licensed image is added. A CDN URL, a public product page, or a search result is not evidence of permission.

The exact-model Wikimedia Commons searches did not produce a matching E64 WS, E65S GbW, E80S GbW, DF64 Gen 1/2, DF54, Niche Zero, Encore ESP, Sculptor 064S/078S, LAGOM 01/P64, 1Zpresso X-Pro/J-Max/K-series, or Fellow Ode Gen 2 photograph with a clear reusable licence. A Flickr DF64 result was found, but the licence and exact variant could not be verified from the source page, so it is not embedded. No image was downloaded.

The current records intentionally preserve the official source URL, owner, caption, and rights decision. `license: "unknown"` is a refusal to infer permission, not a statement that the image is unprotected. `licenseUrl: null` means there is no verified grant to cite. Future community photos can be accepted when the uploader supplies a stable source page, exact model/variant evidence, a licence compatible with the project, and attribution text.

## Per-model result

| ID | Exact model/variant | Current source | Rights decision |
| --- | --- | --- | --- |
| `e64ws` | Mahlkönig E64 WS | [manufacturer](https://www.mahlkoenig.com/products/e64-ws-espresso-home-grinder) | External only; schematic fallback |
| `e65sgbw` | Mahlkönig E65S GbW | [manufacturer](https://www.mahlkoenig.com/products/e65s-gbw) | External only; schematic fallback |
| `e80sgbw` | Mahlkönig E80S GbW | [manufacturer](https://www.mahlkoenig.com/products/e80s-gbw-grinder) | External only; schematic fallback |
| `df64gen1` | DF64 original/Gen 1 | [DF64 Coffee](https://df64coffee.com/products/df64-single-dose-coffee-grinder) | External only; schematic fallback |
| `df64gen2` | DF64 Gen 2 | [DF64 Coffee whole-grinder product page](https://df64coffee.com/products/df64-gen-2-single-dose-coffee-grinder) | External only; schematic fallback |
| `df54` | DF54 | [DF64 Coffee whole-grinder product page](https://df64coffee.com/products/df54) | External only; schematic fallback |
| `nichezero` | Niche Zero | [Niche Coffee](https://www.nichecoffee.co.uk/blogs/exploring-coffee/how-to-dial-in-your-niche-zero) | External only; schematic fallback |
| `encoreesp` | Baratza Encore ESP | [Baratza](https://www.baratza.com/en-us/product/encoretm-esp-zcg495) | External only; schematic fallback |
| `sculptor064s` | Timemore Sculptor 064S | [Timemore](https://www.timemore.com/products/timemore-electric-coffee-grinder-sculptor-series) | External only; schematic fallback |
| `sculptor078s` | Timemore Sculptor 078S | [Timemore](https://www.timemore.com/products/timemore-electric-coffee-grinder-sculptor-series) | External only; schematic fallback |
| `lagom01` | Option-O LAGOM 01 | [Option-O](https://www.option-o.com/lagom-01) | External only; schematic fallback |
| `lagomp64` | Option-O LAGOM P64 | [Option-O](https://www.option-o.com/lagom-p64) | External only; schematic fallback |
| `xpro` | 1Zpresso X-Pro | [1Zpresso](https://1zpresso.coffee/manual-xpro-en/) | External only; schematic fallback |
| `jmax` | 1Zpresso J-Max | [1Zpresso](https://1zpresso.coffee/j/) | External only; schematic fallback |
| `kseries` | 1Zpresso K series (reviewed K-Pro/K-Max/K-Plus) | [1Zpresso](https://1zpresso.coffee/k/) | External only; schematic fallback |
| `odegen2` | Fellow Ode Gen 2 | [Fellow](https://fellowproducts.com/collections/grind-brew/products/ode-brew-grinder-gen-2) | External only; schematic fallback |

## Acceptance checklist for a future photo

1. The source page identifies the exact grinder and revision visible in the image.
2. The page states CC BY, CC BY-SA, CC0/public domain, or gives a direct permission grant that allows redistribution in this project.
3. The original file URL and source page are stable, and the original file checksum is recorded.
4. Attribution and any share-alike or non-commercial restriction are recorded beside the asset.
5. The image is stored separately from source code so its licence does not silently become the plugin's code licence.

Owner photo uploads are not implemented. A future contribution must meet the checks above before it can be shipped.
