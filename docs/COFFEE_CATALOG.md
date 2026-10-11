# Coffee catalog provenance

The plugin carries a small, reviewable snapshot of factual coffee metadata. It
is used as an optional starting point for a bean selection; it never silently
creates or changes a Decaid bean batch, and it is not a stock, price, image, or
freshness feed.

The current snapshot includes the coffee products in the public Kaffeemacher
Shopify product export and the 57 `/en/k/` coffee routes in Coffee Circle's
official sitemap. Coffee Circle product names and canonical URLs were checked
against their public Product JSON-LD. Bundles, capsules and ready-to-drink
products are retained with an explicit format marker; non-coffee merchandise
is excluded. The updater accepts a complete offline `products.json` export
when a permitted source export becomes available. Callers must provide every
page and record the resulting coverage; the script does not claim that a
single page is complete.

Only explicit structured facts and tags are imported: product name, publisher,
source URL, category, origin, processing, roast, type and decaf flag. Missing
facts remain `null`; absent decaf evidence is never treated as `false`.
Every product has a `format` and `beanEligible` field. Only explicit whole-bean
products are eligible for bean matching or training. Ground coffee, green
coffee, capsules, bundles and ready-to-drink products remain visible for
reference but must produce an import warning and cannot enter bean history.
Descriptions, tasting copy, prices, images, reviews and stock are intentionally
excluded. The source URL and `factSources` field are retained for user review.

```sh
python3 scripts/update-coffee-catalog.py --check
python3 scripts/update-coffee-catalog.py --shopify-json /path/to/products.json \
  --publisher 'Kaffeemacher' --catalog-url 'https://kaffeemacher.ch/collections/all/products.json?limit=250'
```

An imported catalog must be reviewed for permission and completeness before it
is committed. The current file was reviewed 2026-10-11.
