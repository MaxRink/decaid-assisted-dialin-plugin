#!/usr/bin/env python3
"""Validate and embed the reviewed offline reference catalog into plugin.js."""
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "reference-catalog.json"
PLUGIN = ROOT / "plugin.js"
DIAL_DATA = ROOT / "data" / "grinder-dials.json"
START = "/* GENERATED REFERENCE CATALOG START */"
END = "/* GENERATED REFERENCE CATALOG END */"
ALLOWED_SOURCE_KEYS = {"id", "title", "url", "publisher", "kind", "scope", "facts", "notes", "reuse"}
KINDS = {"manufacturer", "roaster", "research"}
IMAGE_LICENSES = {"cc0", "public domain", "cc by", "cc by-sa", "cc by 4.0", "cc by-sa 4.0"}


def fail(message: str) -> None:
    raise SystemExit(f"reference catalog: {message}")


def validate_json(value, path="root"):
    if isinstance(value, float) and not math.isfinite(value):
        fail(f"{path} contains a non-finite number")
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str) or not key or "</script" in key.lower():
                fail(f"{path} has an unsafe key")
            validate_json(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            validate_json(child, f"{path}[{index}]")
    elif isinstance(value, str) and "</script" in value.lower():
        fail(f"{path} contains an unsafe HTML terminator")


def validate_catalog(catalog):
    validate_json(catalog)
    if catalog.get("schemaVersion") != 1:
        fail("schemaVersion must be 1")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", catalog.get("reviewedAt", "")):
        fail("reviewedAt must be YYYY-MM-DD")
    sources = catalog.get("sources")
    if not isinstance(sources, list) or not 1 <= len(sources) <= 128:
        fail("sources must contain 1..128 entries")
    seen = set()
    for index, source in enumerate(sources):
        path = f"sources[{index}]"
        if not isinstance(source, dict) or set(source) != ALLOWED_SOURCE_KEYS:
            fail(f"{path} must contain exactly {sorted(ALLOWED_SOURCE_KEYS)}")
        if not isinstance(source["id"], str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,127}", source["id"]):
            fail(f"{path}.id is invalid")
        if source["id"] in seen:
            fail(f"duplicate source id {source['id']}")
        seen.add(source["id"])
        parsed = urlparse(source["url"])
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
            fail(f"{path}.url must be an HTTPS URL without credentials")
        if source["kind"] not in KINDS:
            fail(f"{path}.kind is invalid")
        for key in ("title", "publisher", "reuse"):
            if not isinstance(source[key], str) or not source[key].strip() or len(source[key]) > 1000:
                fail(f"{path}.{key} must be a bounded string")
        if not isinstance(source["scope"], dict) or not isinstance(source["facts"], dict):
            fail(f"{path}.scope and facts must be objects")
        if not isinstance(source["notes"], list) or len(source["notes"]) > 32 or any(not isinstance(note, str) or len(note) > 1000 for note in source["notes"]):
            fail(f"{path}.notes must be a bounded string list")
        for fact_path, fact in walk(source["facts"], f"{path}.facts"):
            if isinstance(fact, dict) and "units" in fact and (not isinstance(fact["units"], str) or len(fact["units"]) > 32):
                fail(f"{fact_path}.units must be a bounded string")
            if isinstance(fact, dict) and "min" in fact and "max" in fact and isinstance(fact["min"], (int, float)) and isinstance(fact["max"], (int, float)) and fact["min"] > fact["max"]:
                fail(f"{fact_path} has min greater than max")


def walk(value, path):
    yield path, value
    if isinstance(value, dict):
        for key, child in value.items():
            yield from walk(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, f"{path}[{index}]")


def generated(catalog):
    payload = json.dumps(catalog, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f'''{START}
function createReferenceCatalog() {{
  "use strict";
  const catalog = {payload};
  const normalize = (value) => typeof value === "string"
    ? value.trim().toLocaleLowerCase().replace(/[\\s_-]+/g, " ")
    : null;
  const matches = (source, query) => {{
    const scope = source.scope || {{}};
    if (source.kind === "roaster" && normalize(scope.brewMethod) !== "espresso") return false;
    const model = normalize(query.grinderModel);
    const burr = normalize(query.burrIdentity);
    const bean = query.bean && typeof query.bean === "object" ? query.bean : null;
    const roaster = normalize(bean && bean.roaster);
    const beanName = normalize(bean && bean.name);
    if (!model && !burr && !roaster && !beanName) return false;
    if (burr && !model) return false;
    const exact = (actual, wanted) => wanted == null || (typeof actual === "string" && normalize(actual) === normalize(wanted));
    if (model && !exact(scope.grinderModel, query.grinderModel)) return false;
    if (model && !burr && scope.burrSKU) return false;
    if (burr && !exact(scope.burrSKU, query.burrIdentity)) return false;
    if (bean && beanName && !roaster) return false;
    if (roaster && !exact(source.publisher, bean.roaster)) return false;
    if (beanName && scope.coffee && !exact(scope.coffee, bean.name)) return false;
    return true;
  }};
  return {{
    schemaVersion: catalog.schemaVersion,
    reviewedAt: catalog.reviewedAt,
    sources: catalog.sources,
    grinderDials: catalog.grinderDials,
    coffeeCatalog: catalog.coffeeCatalog,
    decentProfiles: catalog.decentProfiles,
    matchReferences(query = {{}}) {{
      if (!query || typeof query !== "object" || Array.isArray(query)) return [];
      return catalog.sources.filter((source) => matches(source, query));
    }},
  }};
}}
{END}
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    catalog = json.loads(DATA.read_text())
    validate_catalog(catalog)
    dials = json.loads(DIAL_DATA.read_text())
    validate_json(dials, "grinderDials")
    if dials.get("schemaVersion") != 1 or not isinstance(dials.get("models"), list):
        fail("grinderDials schema is invalid")
    ids = set()
    for model in dials["models"]:
        if model.get("id") in ids or not re.fullmatch(r"[a-z0-9]+", model.get("id", "")):
            fail("grinderDials model id must be unique and safe")
        ids.add(model["id"])
        for key in ("model", "unit", "control", "markings", "zero"):
            if not isinstance(model.get(key), str) or not 1 <= len(model[key]) <= 1000:
                fail(f"grinderDials {key} is invalid")
        adjustment = model.get("espressoAdjustment")
        if adjustment is not None:
            if not isinstance(adjustment, dict) or set(adjustment) != {"stepNative", "basis", "note", "sources", "numericFinerDelta", "espressoSupported"}:
                fail("grinderDials espresso adjustment has an invalid schema")
            step = adjustment["stepNative"]
            if step is not None and (isinstance(step, bool) or not isinstance(step, (int, float)) or not math.isfinite(step) or step <= 0):
                fail("grinderDials espresso step must be positive or unknown")
            if adjustment["numericFinerDelta"] not in (None, -1, 1) or isinstance(adjustment["numericFinerDelta"], bool):
                fail("grinderDials espresso direction must be explicit or unknown")
            if not isinstance(adjustment["espressoSupported"], bool):
                fail("grinderDials espresso support must be explicit")
            if any(not isinstance(adjustment[key], str) or not adjustment[key].strip() or len(adjustment[key]) > 4000 for key in ("basis", "note")):
                fail("grinderDials espresso preset needs bounded provenance")
            if not isinstance(adjustment["sources"], list) or not 1 <= len(adjustment["sources"]) <= 16:
                fail("grinderDials espresso preset needs sources")
            for source in adjustment["sources"]:
                if not isinstance(source, dict) or set(source) != {"title", "url"} or not isinstance(source["title"], str) or not source["title"].strip() or not isinstance(source["url"], str):
                    fail("grinderDials espresso source is invalid")
                parsed = urlparse(source["url"])
                if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
                    fail("grinderDials espresso source must use HTTPS without credentials")
        if model.get("schematicUrl") != "../docs/grinder-dials/" + model["id"] + ".svg":
            fail("grinderDials schematic path is invalid")
        if not (ROOT / "docs" / "grinder-dials" / (model["id"] + ".svg")).is_file():
            fail("grinderDials schematic is missing")
        links = model.get("sources", [])
        image = model.get("image")
        if image:
            if not isinstance(image, dict):
                fail("grinderDials image must be an object")
            if image.get("renderAllowed") is not True:
                if image.get("renderAllowed") not in (False, None):
                    fail("grinderDials image renderAllowed must be boolean")
            license_name = image.get("license")
            license_url = image.get("licenseUrl")
            if image.get("renderAllowed") is True:
                if license_name not in IMAGE_LICENSES or not isinstance(license_url, str):
                    fail("renderable grinderDials image needs a recognized reusable license")
                license_parsed = urlparse(license_url)
                if license_parsed.scheme != "https" or not license_parsed.netloc or license_parsed.username or license_parsed.password:
                    fail("renderable grinderDials image licenseUrl must be HTTPS without credentials")
            elif license_url is not None:
                license_parsed = urlparse(str(license_url))
                if license_parsed.scheme != "https" or not license_parsed.netloc or license_parsed.username or license_parsed.password:
                    fail("grinderDials licenseUrl must be HTTPS without credentials")
            links = links + [{"url": image.get("url")}, {"url": image.get("sourceUrl")}]
        for link in links:
            parsed = urlparse(link.get("url", ""))
            if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
                fail("grinderDials link must be HTTPS without credentials")
    catalog["grinderDials"] = dials
    for name, key, list_key in (("coffee-catalog.json", "coffeeCatalog", "products"), ("decent-profiles.json", "decentProfiles", "profiles")):
        path = ROOT / "data" / name
        if not path.exists():
            continue
        if path.stat().st_size > 4 * 1024 * 1024:
            fail(f"{name} is too large")
        extra = json.loads(path.read_text())
        validate_json(extra, key)
        if extra.get("schemaVersion") != 1 or not isinstance(extra.get(list_key), list) or len(extra[list_key]) > 2000:
            fail(f"{name} schema or item count is invalid")
        extra_ids = set()
        for item in extra[list_key]:
            item_id = item.get("id") if isinstance(item, dict) else None
            if not isinstance(item_id, str) or not item_id or len(item_id) > 256 or item_id in extra_ids:
                fail(f"{name} item IDs must be bounded and unique")
            extra_ids.add(item_id)
            source_url = item.get("url") if key == "coffeeCatalog" else item.get("source", {}).get("url")
            parsed = urlparse(source_url or "")
            if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
                fail(f"{name} source URL must be HTTPS without credentials")
        catalog[key] = extra
    source = PLUGIN.read_text()
    block = generated(catalog)
    if START in source or END in source:
        if source.count(START) != 1 or source.count(END) != 1:
            fail("generated markers must occur exactly once")
        before = source[:source.index(START)]
        after = source[source.index(END) + len(END):]
        existing = source[source.index(START):source.index(END) + len(END)]
        result = before + block.rstrip("\n") + after
    else:
        marker = re.search(r"function createPlugin\(host(?:, services = \{\})?\) \{", source)
        if not marker:
            fail("plugin createPlugin marker not found")
        result = source[: marker.start()] + block + "\n" + source[marker.start() :]
    if args.check:
        if result != source:
            fail("plugin.js does not match generated reference catalog; run this script")
    else:
        PLUGIN.write_text(result)


if __name__ == "__main__":
    main()
