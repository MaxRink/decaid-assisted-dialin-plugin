#!/usr/bin/env python3
"""Embed the common mechanics helper and evidence in the shipped plugin."""
from pathlib import Path
import argparse, json, math
ROOT = Path(__file__).resolve().parents[1]
START = "/* GENERATED GRINDER MECHANICS START */"
END = "/* GENERATED GRINDER MECHANICS END */"

def validate(value):
    if isinstance(value, str) and "</script" in value.lower():
        raise SystemExit("Unsafe HTML terminator in mechanics data")
    if isinstance(value, float) and not math.isfinite(value):
        raise SystemExit("Non-finite mechanics data")
    if isinstance(value, dict):
        for key, child in value.items():
            validate(key); validate(child)
    elif isinstance(value, list):
        for child in value: validate(child)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    catalog = json.loads((ROOT / "data/grinder-mechanics.json").read_text())
    validate(catalog)
    models = catalog.get("models", [])
    if catalog.get("schemaVersion") != 1 or len(models) != 16 or len({m["id"] for m in models}) != 16:
        raise SystemExit("Expected the 16 distinct reviewed grinder profiles")
    factory = (ROOT / "src/grinder-mechanics.js").read_text().split('if (typeof module !== "undefined")', 1)[0].rstrip()
    payload = json.dumps(catalog, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    region = START + "\nfunction createGrinderMechanicsCatalog() { return " + payload + "; }\n" + factory + "\n" + END + "\n"
    plugin = ROOT / "plugin.js"
    original = plugin.read_text()
    if START in original:
        before, rest = original.split(START, 1)
        _, after = rest.split(END, 1)
        updated = before + region + "\n" + after.lstrip("\n")
    else:
        marker = "function createPlugin("
        before, after = original.split(marker, 1)
        updated = before + region + "\n" + marker + after
    if args.check:
        if updated != original:
            raise SystemExit("Mechanics bundle is stale; run scripts/embed-grinder-mechanics.py")
    else: plugin.write_text(updated)

if __name__ == "__main__": main()
