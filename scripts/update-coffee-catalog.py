#!/usr/bin/env python3
"""Validate and normalize public roaster catalog snapshots.

The updater accepts an offline Shopify products.json export. It deliberately
keeps only facts explicitly present in structured fields or tags; it does not
copy descriptions, images, prices, or availability into the plugin.
"""
from __future__ import annotations
import argparse, json, re
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "data" / "coffee-catalog.json"
ALLOWED = {"espresso", "filter", "decaf", "omni", "unknown"}
FORMATS = {"whole-bean", "ground", "capsule", "ready-to-drink", "bundle", "green-bean", "unknown"}

def fail(message: str) -> None:
    raise SystemExit(message)

def safe_url(value):
    parsed = urlparse(value or "")
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        fail(f"unsafe source URL: {value!r}")
    return value

def _tag_value(tags, prefixes):
    for tag in tags or []:
        text = str(tag).strip()
        for prefix in prefixes:
            if text.lower().startswith(prefix):
                value = text[len(prefix):].strip(" :/")
                if value:
                    return value
    return None

def normalize_shopify(payload, publisher, catalog_url, retrieved_at):
    """Turn a Shopify products.json response into a source + factual products."""
    items = payload.get("products") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        fail("Shopify payload must contain a products list")
    safe_url(catalog_url)
    products = []
    for item in items:
        if not isinstance(item, dict) or not item.get("title") or not item.get("handle"):
            continue
        tags = item.get("tags") if isinstance(item.get("tags"), list) else []
        product_type = str(item.get("product_type") or "").strip().lower()
        if product_type not in {"kaffee", "coffee", "café", "cafe"}:
            continue
        title = str(item["title"]).strip()
        slug = re.sub(r"[^a-z0-9]+", "-", str(item["handle"]).lower()).strip("-")
        lowered_tags = {str(tag).strip().lower() for tag in tags}
        if "rohkaffee" in lowered_tags or "grünkaffee" in lowered_tags: fmt = "green-bean"
        elif "geschenkset" in lowered_tags or "set" in lowered_tags or "abo" in title.lower(): fmt = "bundle"
        elif "kapsel" in lowered_tags or "capsule" in lowered_tags: fmt = "capsule"
        elif "gemahlen" in lowered_tags or "ground" in lowered_tags: fmt = "ground"
        else: fmt = "unknown"
        category = (_tag_value(tags, ("category:", "brew:", "brew method:")) or "unknown").lower()
        if category == "unknown":
            lowered = {str(tag).strip().lower() for tag in tags}
            if "espresso" in lowered: category = "espresso"
            elif "filterkaffee" in lowered or "filter" in lowered: category = "filter"
        if category not in ALLOWED:
            category = "unknown"
        origin = _tag_value(tags, ("origin:", "country:", "country of origin:"))
        if not origin:
            match = re.search(r"\baus\s+([A-ZÄÖÜ][\wÄÖÜäöüß-]+)", title)
            origin = match.group(1) if match else None
        process = _tag_value(tags, ("process:", "processing:"))
        if not process:
            process_terms = {"washed": "washed", "natural": "natural", "anaerobic": "anaerobic", "honey": "honey"}
            process = next((value for key, value in process_terms.items() if key in {str(tag).strip().lower() for tag in tags}), None)
        roast = _tag_value(tags, ("roast:", "roast level:"))
        kind = _tag_value(tags, ("type:", "coffee type:"))
        decaf = True if any(str(tag).strip().lower() in {"decaf", "decaffeinated", "koffeinfrei"} for tag in tags) else None
        products.append({
            "id": re.sub(r"[^a-z0-9]+", "-", publisher.lower() + "-" + slug).strip("-"),
            "publisher": publisher, "name": title,
            # The export does not guarantee a canonical product URL; retain the
            # reviewed collection URL rather than inventing a product route.
            "url": "https://" + urlparse(catalog_url).netloc + "/products/" + slug,
            "category": category, "origin": origin, "process": process,
            "roastLevel": roast, "type": kind, "decaf": decaf,
            "format": fmt, "beanEligible": fmt == "whole-bean",
            "tastingDescriptors": [], "recommendedBrew": None,
            "availability": "unknown", "sourceId": re.sub(r"[^a-z0-9]+", "-", publisher.lower()).strip("-") + "-catalog"
        })
    return {
        "source": {"id": re.sub(r"[^a-z0-9]+", "-", publisher.lower()).strip("-") + "-catalog", "publisher": publisher, "catalogUrl": catalog_url, "retrievedAt": retrieved_at,
                   "coverage": {"status": "snapshot", "pagination": "caller must provide all pages", "omittedReason": None}},
        "products": products,
    }

def normalize_jsonld(payload, publisher, catalog_url, retrieved_at):
    """Normalize an offline list of Product/ProductGroup JSON-LD records."""
    records = payload if isinstance(payload, list) else payload.get("products") if isinstance(payload, dict) else None
    if not isinstance(records, list): fail("JSON-LD fixture must be a list of product records")
    safe_url(catalog_url); products = []
    for item in records:
        if not isinstance(item, dict) or item.get("@type") not in {"Product", "ProductGroup"} or not item.get("name") or not item.get("url"): continue
        url = safe_url(item["url"]); slug = re.sub(r"[^a-z0-9]+", "-", url.rstrip("/").rsplit("/", 1)[-1].lower()).strip("-")
        lowered = (str(item["name"]) + " " + url).lower()
        if any(k in lowered for k in ("set", "capsule", "kapsel", "drip bag", "cold brew", "cascara", "advent calendar", "adventskalender", "multipack", "probierset", "entdecker", "geschenkabo")): fmt = "bundle" if not ("capsule" in lowered or "kapsel" in lowered) else "capsule"
        else: fmt = "unknown"
        products.append({"id": re.sub(r"[^a-z0-9]+", "-", publisher.lower() + "-" + slug).strip("-"), "publisher": publisher, "name": str(item["name"]).strip(), "url": url, "category": "espresso" if "espresso" in lowered else "unknown", "origin": None, "process": None, "roastLevel": None, "type": fmt, "decaf": True if "decaf" in lowered else None, "format": fmt, "beanEligible": fmt == "whole-bean", "tastingDescriptors": [], "recommendedBrew": None, "availability": "unknown", "factSources": ["Product JSON-LD name and canonical URL"], "sourceId": re.sub(r"[^a-z0-9]+", "-", publisher.lower()).strip("-") + "-catalog"})
    return {"source": {"id": re.sub(r"[^a-z0-9]+", "-", publisher.lower()).strip("-") + "-catalog", "publisher": publisher, "catalogUrl": catalog_url, "retrievedAt": retrieved_at, "coverage": {"status": "snapshot", "pagination": "caller must provide all pages", "omittedReason": None}}, "products": products}

def validate(catalog):
    if catalog.get("schemaVersion") != 1 or not isinstance(catalog.get("sources"), list) or not isinstance(catalog.get("products"), list):
        fail("invalid catalog envelope")
    source_ids = set()
    for source in catalog["sources"]:
        if source.get("id") in source_ids: fail("duplicate source id")
        source_ids.add(source.get("id")); safe_url(source.get("catalogUrl"))
        if source.get("coverage", {}).get("status") not in {"snapshot", "partial", "complete", "unavailable", "superseded"}:
            fail("invalid source coverage status")
    ids = set()
    for product in catalog["products"]:
        if product.get("id") in ids: fail("duplicate product id")
        ids.add(product.get("id"))
        for field in ("id", "publisher", "name", "url", "category", "sourceId"):
            if not isinstance(product.get(field), str) or not product[field]: fail(f"missing product {field}")
        safe_url(product["url"])
        if product["category"] not in ALLOWED: fail("invalid product category")
        if product.get("format") not in FORMATS: fail("invalid product format")
        if not isinstance(product.get("beanEligible"), bool): fail("beanEligible must be boolean")
        if product["sourceId"] not in source_ids: fail("product source is missing")
        if not isinstance(product.get("tastingDescriptors"), list): fail("descriptors must be a list")
        for value in ("origin", "process", "roastLevel", "type"):
            if product.get(value) is not None and not isinstance(product[value], str): fail(f"{value} must be string or null")
    return True

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--shopify-json", type=Path)
    parser.add_argument("--publisher")
    parser.add_argument("--catalog-url")
    parser.add_argument("--output", type=Path, default=CATALOG)
    parser.add_argument("--jsonld", type=Path)
    args = parser.parse_args()
    catalog = json.loads(args.output.read_text() if args.output.exists() else CATALOG.read_text())
    if args.shopify_json and args.jsonld: fail("choose one import format")
    if args.shopify_json or args.jsonld:
        if not args.publisher or not args.catalog_url: fail("--publisher and --catalog-url are required")
        imported = normalize_shopify(json.loads(args.shopify_json.read_text()), args.publisher, args.catalog_url, str(date.today())) if args.shopify_json else normalize_jsonld(json.loads(args.jsonld.read_text()), args.publisher, args.catalog_url, str(date.today()))
        catalog["sources"] = [s for s in catalog["sources"] if s["id"] != imported["source"]["id"]] + [imported["source"]]
        imported_ids = {p["id"] for p in imported["products"]}
        catalog["products"] = [p for p in catalog["products"] if p["sourceId"] != imported["source"]["id"] and p["id"] not in imported_ids] + imported["products"]
    validate(catalog)
    rendered = json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if rendered != args.output.read_text(): fail("coffee catalog is not deterministically formatted")
    else:
        args.output.write_text(rendered)

if __name__ == "__main__":
    main()
