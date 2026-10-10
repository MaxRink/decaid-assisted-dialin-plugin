#!/usr/bin/env python3
"""Generate deterministic plots and ledgers from the integrated plugin factory.

The trajectories are produced by createResearchAlgorithms() in plugin.js.  The
Python part only renders the returned JSON, so the formulas are not duplicated
here.  The renderer uses SVG from the standard library; matplotlib is detected
when available but is not required for this dependency-free plugin artifact.
"""
from __future__ import annotations

import argparse
import csv
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "algorithm-plots"

NODE = r'''
const fs = require("fs");
const vm = require("vm");
const source = fs.readFileSync(process.argv[1], "utf8");
const context = {Math, JSON, Number, Object, Set, Date, console};
vm.createContext(context);
vm.runInContext(source + "\nthis.factory = createResearchAlgorithms;", context);
const a = context.factory();
function input(actual, target, estimated, setpoint, tolerance=1000) {
  return {actualBrewTimeMs: actual, targetBrewTimeMs: target, estimatedDdDum: estimated, setpointDdDum: setpoint, toleranceMs: tolerance};
}
function run(name, calls, options) {
  let state = a.createState(name, options), rows = [];
  for (let i=0; i<calls.length; i++) {
    const step = a.adjust(name, state, calls[i]);
    rows.push({scenario:name, pass:i+1, input:calls[i], result:step.result, state:step.nextState});
    state = step.nextState;
  }
  return rows;
}
const gbs1 = run("GbS1", [35,32,28,30,26,34,28,31,28,28,28].map(x=>input(x*1000,28000,1000,1000)), {continuousUm:100, previousQuantizedUm:100, lastResultDum:1000});
const gbs2 = run("GbS2", [[1000,35],[980,32],[960,30],[940,29],[920,27],[900,26],[880,31]].map(x=>input(x[1]*1000,28000,1000,x[0])));
const gbs3 = run("GbS3", [40,34,30,28,27,26,35,28].map((x,i)=>input(x*1000,28000,i===6?1700:1000,1000)), {holdCyclesRemaining:0});
const gbs4 = run("GbS4", [40,34,30,28,27,26,28,31].map(x=>input(x*1000,28000,1000,1000)), {holdCyclesRemaining:0});
const ddeff = a.ddEff(1000,18).map((value,i)=>({scenario:"DdEff",pass:i+1,input:{initialDdDum:1000,call:i+1,calls:18},result:{returnedDdDum:value},state:{calls:i+1}}));
let effState=null, effective=[];
for (let i=0;i<5;i++) { const dd=500+i*40, baseline=i?effective[i-1].result.result/10:undefined; const step=a.effectiveDd(effState,{grindDdDum:dd,grindDurationMs:1000,previousEffective:baseline}); effective.push({scenario:"effectiveDd",pass:i+1,input:{grindDdDum:dd,grindDurationMs:1000,previousEffective:baseline},result:step,nextState:step.nextState,state:step.nextState}); effState=step.nextState; }
const manualProfiles = ["df54","df64_gen1","df64_gen2"].map(profile => ({profile, normal:a.manual({profile,targetTimeSec:30,actualTimeSec:25,flavor:"sour",currentDial:30,stepMarks:1,numericFinerDelta:1}), conflict:a.manual({profile,targetTimeSec:30,actualTimeSec:25,flavor:"bitter",currentDial:30,stepMarks:1,numericFinerDelta:1})}));
const grindTimeSweep = [2,3].flatMap(mode => [300,500,700].map(targetDdDum => ({mode,targetDdDum,result:a.grindTime({mode,recipeDdUm:50,targetDdDum,recipeTimeMs:1000})})));
const wizardRows = [1,2,3].flatMap(modelEnum => [0,1,2].flatMap(roastDegreeIndex => [12000,18000,24000].map(weightMg => ({modelEnum,roastDegreeIndex,weightMg,proposedDdDum:a.proposedDd({modelEnum,roastDegreeIndex,weightMg}).proposedDd}))));
const inverseSweep = [24,26,28,30,32].map(targetSec => ({targetSec,predictionUm:a.inverseRegression([{x:50,y:30},{x:45,y:32},{x:40,y:34},{x:35,y:36}],targetSec)}));
const extras = {
  grindTime: a.grindTime({mode:3,recipeDdUm:50,targetDdDum:500,recipeTimeMs:1000}),
  manual: a.manual({profile:"df64_gen1",targetTimeSec:30,actualTimeSec:25,flavor:"sour",currentDial:30,stepMarks:1,numericFinerDelta:1,finerDirection:"clockwise"}),
  manualProfiles, grindTimeSweep, wizardRows, inverseSweep,
};
const all = [].concat(gbs1,gbs2,gbs3,gbs4,ddeff,effective);
if (!["GbS1","GbS2","GbS3","GbS4","DdEff","effectiveDd"].every(name=>all.filter(row=>row.scenario===name).length>= (name==="DdEff"?18:5))) throw new Error("trajectory coverage assertion failed");
if (!all.some(row=>row.scenario==="GbS3"&&row.result.phase==="cancel") || !all.some(row=>row.scenario==="GbS4"&&row.result.locked)) throw new Error("phase coverage assertion failed");
if (!all.some(row=>row.scenario==="GbS2"&&row.state.history&&row.state.history.length===6)) throw new Error("six-point history assertion failed");
for (const row of all) for (const value of Object.values(row.result||{})) if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite trajectory output");
process.stdout.write(JSON.stringify({firmwareBuild:a.firmwareBuild, rows:all, extras}));
'''


def get_data() -> dict:
    result = subprocess.run(["node", "-e", NODE, str(ROOT / "plugin.js")], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def _save_figure(fig, path: Path) -> None:
    fig.savefig(path, format="svg", bbox_inches="tight", metadata={"Date": None})
    fig.savefig(path.with_suffix(".png"), format="png", dpi=160, bbox_inches="tight", metadata={"Software": "decaid algorithm replay"})


def _plot_algorithm(ax, rows: list[dict], name: str) -> None:
    descriptions = {
        "GbS1": "smooths four recent brew times",
        "GbS2": "uses a short history of brew times",
        "GbS3": "filters updates and can hold or cancel",
        "GbS4": "filters updates and can lock a stable suggestion",
        "DdEff": "shows the documented measurement sequence",
        "effectiveDd": "combines grind time with residue and baseline",
    }
    returned, candidates, passes = [], [], []
    for row in rows:
        value = row["result"]
        if isinstance(value, dict):
            candidates.append(value.get("candidateDdDum"))
            returned.append(value.get("returnedDdDum", value.get("result", float("nan"))))
        else:
            candidates.append(None)
            returned.append(value)
        passes.append(row["pass"])
    ax.plot(passes, returned, color="#1464a0", marker="o", label="suggestion kept / returned")
    if any(value is not None for value in candidates):
        candidate_values = [value if value is not None else returned[i] for i, value in enumerate(candidates)]
        ax.plot(passes, candidate_values, color="#e85d04", linestyle="--", marker="x", label="new calculation")
    for row, x, y in zip(rows, passes, returned):
        result = row.get("result", {})
        phase = result.get("phase", "") if isinstance(result, dict) else ""
        locked = bool(result.get("locked")) if isinstance(result, dict) else False
        held = isinstance(result, dict) and result.get("committed") is False and result.get("candidateDdDum") != result.get("returnedDdDum")
        label = "cancel" if phase == "cancel" else ("lock" if locked else ("hold" if held else ""))
        if label:
            ax.annotate(label, (x, y), xytext=(4, 6), textcoords="offset points", fontsize=9,
                        bbox={"boxstyle": "round,pad=.2", "fc": "#fff2cc", "ec": "#888", "alpha": .9})
    ax.set_title(f"{name} — {descriptions[name]}", pad=12)
    ax.set_xlabel("brew / calculation pass")
    ax.set_ylabel("algorithm setting (dD)")
    ax.set_xticks(passes)
    ax.grid(True, alpha=0.25)
    ax.legend(loc="best", fontsize=8)


def render_svg(data: dict, path: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    names = ["GbS1", "GbS2", "GbS3", "GbS4", "DdEff", "effectiveDd"]
    fig, axes = plt.subplots(3, 2, figsize=(16, 12), constrained_layout=True)
    for ax, name in zip(axes.flat, names):
        _plot_algorithm(ax, [row for row in data["rows"] if row["scenario"] == name], name)
    fig.suptitle("Recovered algorithm behavior — synthetic replay from the plugin factory\n dD is the recovered 0.1 µm coordinate; physical direction is unverified", fontsize=15)
    _save_figure(fig, path)
    plt.close(fig)
    for name in names:
        single, ax = plt.subplots(figsize=(10, 5.5), constrained_layout=True)
        _plot_algorithm(ax, [row for row in data["rows"] if row["scenario"] == name], name)
        single.suptitle("Synthetic replay; dD = recovered 0.1 µm coordinate; direction unverified", fontsize=11)
        _save_figure(single, path.parent / f"algorithm-{name}.svg")
        plt.close(single)


def render_tools_svg(data: dict, path: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    extras = data["extras"]
    fig, axes = plt.subplots(1, 3, figsize=(16, 5), constrained_layout=True)
    modes = [2, 3]
    for mode in modes:
        values = [item for item in extras["grindTimeSweep"] if item["mode"] == mode]
        axes[0].plot([item["targetDdDum"] for item in values], [item["result"].get("adjustedTimeMs") for item in values], marker="o", label=f"mode {mode}")
    axes[0].set_title("grindTime target sweep")
    axes[0].set_xlabel("target DD (unknown coordinate unit)")
    axes[0].set_ylabel("adjusted time (ms)")
    axes[0].grid(True, alpha=.25)
    axes[0].legend()
    inverse = extras["inverseSweep"]
    axes[1].plot([item["targetSec"] for item in inverse], [item["predictionUm"] for item in inverse], color="#1464a0", marker="o")
    axes[1].set_title("inverse regression target sweep")
    axes[1].set_xlabel("target brew time (s)")
    axes[1].set_ylabel("predicted coordinate (model unit)")
    axes[1].grid(True, alpha=.25)
    profiles = extras["manualProfiles"]
    x = list(range(len(profiles)))
    width = .35
    axes[2].bar([i - width / 2 for i in x], [row["normal"]["confidence"] for row in profiles], width, label="time + taste agreement", color="#1464a0")
    axes[2].bar([i + width / 2 for i in x], [profile["conflict"]["confidence"] for profile in profiles], width, label="contradictory taste", color="#e85d04")
    axes[2].set_title("manual guidance confidence by profile")
    axes[2].set_xlabel("profile")
    axes[2].set_ylabel("confidence (0–1)")
    axes[2].set_xticks(x, [row["profile"] for row in profiles])
    axes[2].set_ylim(0, 1.05)
    axes[2].grid(True, axis="y", alpha=.25)
    axes[2].legend(fontsize=8)
    fig.suptitle("Supporting calculators: synthetic inputs, no hardware claim")
    _save_figure(fig, path)
    plt.close(fig)


def render_timing(data: dict, path: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(12, 5), constrained_layout=True)
    colors = {"GbS1": "#1b9e77", "GbS2": "#d95f02", "GbS3": "#7570b3", "GbS4": "#e7298a"}
    for name, color in colors.items():
        rows = [row for row in data["rows"] if row["scenario"] == name]
        passes = [row["pass"] for row in rows]
        actual = [row["input"]["actualBrewTimeMs"] / 1000 for row in rows]
        target = [row["input"]["targetBrewTimeMs"] / 1000 for row in rows]
        ax.plot(passes, actual, color=color, marker="o", label=f"{name} actual")
        ax.plot(passes, target, color=color, linestyle=":", label=f"{name} target")
    ax.set_title("Brew timing used by each native GBS update")
    ax.set_xlabel("brew/pass")
    ax.set_ylabel("time (s)")
    ax.grid(True, alpha=.25)
    ax.legend(ncol=2, fontsize=8)
    _save_figure(fig, path)
    plt.close(fig)


def render_wizard(data: dict, path: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(10, 5.5), constrained_layout=True)
    rows = data["extras"]["wizardRows"]
    for model in sorted({row["modelEnum"] for row in rows}):
        for roast in sorted({row["roastDegreeIndex"] for row in rows if row["modelEnum"] == model}):
            group = [row for row in rows if row["modelEnum"] == model and row["roastDegreeIndex"] == roast]
            ax.plot([row["weightMg"] / 1000 for row in group], [row["proposedDdDum"] for row in group], marker="o", label=f"model {model}, roast {roast}")
    ax.set_title("Wizard suggestions across dose, model, and roast rows")
    ax.set_xlabel("dose (g; input converted from mg)")
    ax.set_ylabel("proposed grind coordinate (model unit; physical unit unverified)")
    ax.grid(True, alpha=.25)
    ax.legend(fontsize=8, ncol=3)
    _save_figure(fig, path)
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay actual research algorithms and render plots")
    parser.add_argument("--check", action="store_true", help="recompute and compare the committed JSON/CSV without rewriting artifacts")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    data = get_data()
    recorded = OUT / "trajectories.json"
    if args.check:
        if not recorded.exists():
            raise SystemExit("missing trajectories.json; run without --check first")
        if json.loads(recorded.read_text(encoding="utf-8")) != data:
            raise SystemExit("trajectory replay differs from committed trajectories.json")
        csv_path = OUT / "trajectories.csv"
        if not csv_path.exists():
            raise SystemExit("missing trajectories.csv; run without --check first")
        with csv_path.open(newline="", encoding="utf-8") as handle:
            csv_rows = list(csv.DictReader(handle))
        if len(csv_rows) != len(data["rows"]):
            raise SystemExit("trajectory CSV row count differs from replay")
        if [(row["scenario"], int(row["pass"])) for row in csv_rows] != [(row["scenario"], row["pass"]) for row in data["rows"]]:
            raise SystemExit("trajectory CSV pass ordering differs from replay")
        print("trajectory replay matches committed JSON")
        print("trajectory CSV pass ledger matches replay")
        return
    (OUT / "trajectories.json").write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    with (OUT / "trajectories.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["scenario", "pass", "actualBrewTimeMs", "targetBrewTimeMs", "estimatedDdDum", "setpointDdDum", "toleranceMs", "phase", "candidateDdDum", "returnedDdDum", "committed", "locked", "historyCount", "holdCyclesRemaining", "filterRetention", "previousEffective"])
        writer.writeheader()
        for row in data["rows"]:
            inp, result = row.get("input", {}), row.get("result", {})
            if isinstance(result, dict) and isinstance(result.get("result"), (int, float)) and "phase" not in result: result = {"result": result["result"]}
            state = row.get("state", {})
            writer.writerow({"scenario":row["scenario"], "pass":row["pass"], "actualBrewTimeMs":inp.get("actualBrewTimeMs", ""), "targetBrewTimeMs":inp.get("targetBrewTimeMs", ""), "estimatedDdDum":inp.get("estimatedDdDum", ""), "setpointDdDum":inp.get("setpointDdDum", ""), "toleranceMs":inp.get("toleranceMs", ""), "phase":result.get("phase", "") if isinstance(result, dict) else "", "candidateDdDum":result.get("candidateDdDum", result.get("result", "")) if isinstance(result, dict) else result, "returnedDdDum":result.get("returnedDdDum", result.get("result", "")) if isinstance(result, dict) else result, "committed":result.get("committed", "") if isinstance(result, dict) else "", "locked":result.get("locked", "") if isinstance(result, dict) else "", "historyCount":len(state.get("history", [])) if isinstance(state, dict) and isinstance(state.get("history"), list) else "", "holdCyclesRemaining":state.get("holdCyclesRemaining", "") if isinstance(state, dict) else "", "filterRetention":state.get("filterRetention", "") if isinstance(state, dict) else "", "previousEffective":inp.get("previousEffective", "")})
    ledger = OUT / "pass-ledger.md"
    fields = ["scenario", "pass", "actualBrewTimeMs", "targetBrewTimeMs", "phase", "candidateDdDum", "returnedDdDum", "committed", "locked", "historyCount", "holdCyclesRemaining", "filterRetention", "previousEffective"]
    with ledger.open("w", encoding="utf-8") as handle:
        handle.write("# Per-pass algorithm ledger\n\n")
        handle.write("Values come from the actual `createResearchAlgorithms()` factory and the synthetic inputs in `plot-algorithms.py`; coordinate units remain model units where the firmware contract is not verified.\n\n")
        handle.write("| " + " | ".join(fields) + " |\n|" + "|".join(["---"] * len(fields)) + "|\n")
        for row in data["rows"]:
            result = row.get("result", {})
            if isinstance(result, dict) and "result" in result and "phase" not in result:
                result = {"returnedDdDum": result["result"]}
            state = row.get("state", {})
            values = [row["scenario"], row["pass"], row.get("input", {}).get("actualBrewTimeMs", ""), row.get("input", {}).get("targetBrewTimeMs", ""), result.get("phase", "") if isinstance(result, dict) else "", result.get("candidateDdDum", result.get("result", "")) if isinstance(result, dict) else result, result.get("returnedDdDum", result.get("result", "")) if isinstance(result, dict) else result, result.get("committed", "") if isinstance(result, dict) else "", result.get("locked", "") if isinstance(result, dict) else "", len(state.get("history", [])) if isinstance(state, dict) and isinstance(state.get("history"), list) else "", state.get("holdCyclesRemaining", "") if isinstance(state, dict) else "", state.get("filterRetention", "") if isinstance(state, dict) else "", row.get("input", {}).get("previousEffective", "")]
            handle.write("| " + " | ".join(str(value) for value in values) + " |\n")
    render_svg(data, OUT / "trajectories.svg")
    render_tools_svg(data, OUT / "supporting-calculators.svg")
    render_timing(data, OUT / "timing-inputs.svg")
    render_wizard(data, OUT / "wizard-sweep.svg")
    print(f"wrote {OUT / 'trajectories.json'}")
    print(f"wrote {OUT / 'trajectories.csv'}")
    print(f"wrote {OUT / 'trajectories.svg'}")
    print(f"wrote {OUT / 'timing-inputs.svg'}")


if __name__ == "__main__":
    main()
