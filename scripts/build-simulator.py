#!/usr/bin/env python3
"""Stage the static simulator with the exact shipped plugin and reference data."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".site"

def main():
    for name in ("index.html", "app.js", "style.css", "engine.js"):
        if not (ROOT / "simulator" / name).is_file():
            raise SystemExit(f"Missing simulator asset: {name}")
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    shutil.copytree(ROOT / "simulator", OUT / "simulator", dirs_exist_ok=True)
    shutil.copytree(ROOT / "data", OUT / "data", dirs_exist_ok=True)
    shutil.copytree(ROOT / "docs", OUT / "docs", dirs_exist_ok=True)
    for name in ("plugin.js", "LICENSE", "NOTICE"):
        shutil.copyfile(ROOT / name, OUT / name)
    (OUT / ".nojekyll").touch()
    (OUT / "index.html").write_text(
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta http-equiv="refresh" content="0;url=simulator/">'
        '<title>Assisted dial-in simulator</title>'
        '<a href="simulator/">Open the assisted dial-in simulator</a></html>\n'
    )
    assert (OUT / "plugin.js").read_bytes() == (ROOT / "plugin.js").read_bytes()
    print(f"Staged simulator at {OUT}")

if __name__ == "__main__":
    main()
