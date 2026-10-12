#!/usr/bin/env python3
"""Embed the shared anonymous-research factory in the shipped plugin."""
from pathlib import Path
import argparse
ROOT = Path(__file__).resolve().parents[1]
START = "/* GENERATED RESEARCH SHARING START */"
END = "/* GENERATED RESEARCH SHARING END */"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    factory = (ROOT / "research-sharing.js").read_text().split('if (typeof module !== "undefined"', 1)[0].rstrip()
    if "function createResearchSharing()" not in factory:
        raise SystemExit("Missing shared research factory")
    plugin = ROOT / "plugin.js"
    original = plugin.read_text()
    region = START + "\n" + factory + "\n" + END + "\n"
    if START in original:
        before, remainder = original.split(START, 1)
        _, after = remainder.split(END, 1)
        updated = before + region + after.lstrip("\n")
    else:
        marker = "function createPlugin("
        before, after = original.split(marker, 1)
        updated = before + region + "\n" + marker + after
    if args.check:
        if updated != original:
            raise SystemExit("Shared research factory is stale; run scripts/embed-research-sharing.py")
    else:
        plugin.write_text(updated)

if __name__ == "__main__":
    main()
