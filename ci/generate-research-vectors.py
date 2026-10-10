"""Generate independent golden vectors from the recovered Python model.

Run with PYTHONPATH pointing to research revision
efcf12fb5366d628468ce02117f5905c32474b41. This is a developer oracle,
not runtime plugin code. An optional first argument selects the output JSON.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from tools.df_gbs_applet import recommend_manual
from tools.gbs_model import (
    GbsV2State,
    GbsV3State,
    GbsV4State,
    SamplePoint,
    V1MedianAverage,
    dd_eff_measurement_sequence,
    firmware_linear_regression_predict,
    gbs_v2_adjust,
    gbs_v3_adjust,
    gbs_v4_adjust,
    v1_adjust,
    proposed_dd_from_selection,
)


def _manual(case: dict) -> dict:
    result = recommend_manual(**case["input"])
    return {
        "direction": result.direction,
        "physicalTurn": result.physical_turn,
        "confidence": result.confidence,
        "proposedDial": result.proposed_dial,
        "requiresConfirmation": result.requires_confirmation,
    }


def _gbs1(calls: list[dict]) -> list[dict]:
    history = V1MedianAverage()
    previous_output = None
    previous_state = 1.0
    last_result = None
    result = []
    for call in calls:
        central = history.append(call["actualBrewTimeMs"] * 0.001)
        adjustment = v1_adjust(
            central=central,
            observation=call["targetBrewTimeMs"] * 0.001,
            previous_state=previous_state,
            previous_output_tenths=previous_output,
        )
        previous_output = adjustment.output_tenths
        previous_state = adjustment.state
        if last_result is None:
            last_result = call["estimatedDdDum"]
        committed = abs(call["actualBrewTimeMs"] - call["targetBrewTimeMs"]) >= abs(call["toleranceMs"])
        if committed:
            last_result = adjustment.output_tenths
        result.append({
            "centralSec": adjustment.central,
            "correction": adjustment.correction,
            "state": adjustment.state,
            "candidateDum": adjustment.output_tenths,
            "returnedDum": last_result,
            "committed": committed,
            "withinErrorWindow": adjustment.within_error_window,
        })
    return result


def _gbs(algo: str, calls: list[dict]) -> list[dict]:
    if algo == "GbS1":
        return _gbs1(calls)
    state = {"GbS2": GbsV2State, "GbS3": GbsV3State, "GbS4": GbsV4State}[algo]()
    fn = {"GbS2": gbs_v2_adjust, "GbS3": gbs_v3_adjust, "GbS4": gbs_v4_adjust}[algo]
    result = []
    for call in calls:
        value = fn(
            state,
            actual_ms=call["actualBrewTimeMs"],
            target_ms=call["targetBrewTimeMs"],
            estimated_dd_dum=call["estimatedDdDum"],
            setpoint_dd_dum=call["setpointDdDum"],
            tolerance_ms=call["toleranceMs"],
        )
        result.append({
            "phase": value.phase,
            "candidateDum": value.candidate_dum,
            "returnedDum": value.returned_dum,
            "committed": value.committed,
            "locked": value.locked,
        })
    return result


def _call(actual: int, *, tolerance: int = 1000, estimated: int = 1000, setpoint: int = 1000) -> dict:
    return {
        "actualBrewTimeMs": actual,
        "targetBrewTimeMs": 28000,
        "estimatedDdDum": estimated,
        "setpointDdDum": setpoint,
        "toleranceMs": tolerance,
    }


def floor_away(value: float) -> int:
    """C/C++ round/lround at finite signed halfway values."""
    return math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5)


def effective_vector(name: str, previous_residue: float, baseline: float) -> tuple[dict]:
    """Generate the explicit-baseline model used by the plugin replay API."""
    duration_s = 1.85
    k = math.log(2.0) / 1.85
    a = 1.0 - math.exp(-k * duration_s)
    b = 1.0 - a / (k * duration_s)
    residue = previous_residue + (80.0 - previous_residue) * a
    effective = baseline + (80.0 - baseline) * b
    return ({
        "name": name,
        "state": {"residue": previous_residue},
        "input": {"grindDdDum": 800, "grindDurationMs": 1850, "effectiveBaseline": baseline},
        "expected": {"resultDum": floor_away(effective * 10.0), "residueUm": residue},
    },)


def main() -> None:
    manual = [
        {
            "name": "time-and-sensory-conflict",
            "input": {
                "profile": "df64_gen2", "target_time_s": 30, "actual_time_s": 24,
                "flavor": "bitter", "current_dial": 15, "step_marks": 1,
                "numeric_finer_delta": -1,
            },
        },
        {
            "name": "df64-gen1-calibrated-finer",
            "input": {
                "profile": "df64_gen1", "target_time_s": 30, "actual_time_s": 24,
                "flavor": "sour", "current_dial": 15, "step_marks": 1,
                "numeric_finer_delta": -1,
            },
        },
        {
            "name": "within-time-deadband-no-signal",
            "input": {"profile": "df54", "target_time_s": 30, "actual_time_s": 30.5},
        },
    ]
    calls = {
        "GbS1": [_call(value) for value in (35000, 32000, 28000, 28500)],
        "GbS2": [_call(value) for value in (35000, 30000, 29000, 28000)],
        "GbS3": [_call(value) for value in (40000, 34000, 30000, 28500, 28000)],
        "GbS4": [_call(value) for value in (40000, 34000, 30000, 28500, 28000)],
    }
    algorithms = [
        {"name": name, "calls": values, "expected": _gbs(name, values)}
        for name, values in calls.items()
    ]
    boundaries = [
        {
            "name": "inverse-regression-one-point-fallback",
            "points": [{"x": 100.0, "y": 30.0}], "targetY": 28.0,
            "expected": firmware_linear_regression_predict([SamplePoint(100.0, 30.0)], 28.0),
        },
        {
            "name": "inverse-regression-flat-variance-fallback",
            "points": [{"x": 100.0, "y": 30.0}, {"x": 100.0, "y": 31.0}], "targetY": 28.0,
            "expected": firmware_linear_regression_predict([SamplePoint(100.0, 30.0), SamplePoint(100.0, 31.0)], 28.0),
        },
        {
            "name": "inverse-regression-slope-clamp",
            "points": [{"x": 100.0, "y": 30.0}, {"x": 110.0, "y": 30.1}], "targetY": 28.0,
            "expected": firmware_linear_regression_predict([SamplePoint(100.0, 30.0), SamplePoint(110.0, 30.1)], 28.0),
        },
    ]
    fixture = {
        "provenance": {
            "researchRepo": "MaxRink/mahlkoenig-e64ws-local-research",
            "firmwareBuild": "HEM-HSG-HMI-S01 V01.16-24",
            "status": "static instruction-cross-checked recovery; no live grinder validation",
        },
        "manual": [{**case, "expected": _manual(case)} for case in manual],
        "algorithms": algorithms,
        "inverseRegression": boundaries,
        "dialInRows": [
            {"modelEnum": model, "roastDegreeIndex": roast, "weightMg": weight,
             "expectedDum": proposed_dd_from_selection(weight, model_enum=model, roast_degree_index=roast)}
            for model, roast, weight in ((1, 0, 0), (1, 1, 18000), (1, 2, 18000),
                                         (2, 0, 18000), (2, 1, 18000), (2, 2, 18000),
                                         (3, 0, 18000), (3, 1, 18000), (3, 2, 18000))
        ],
        "signedRounding": [
            {"value": value, "expected": floor_away(value * 10.0)}
            for value in (1.25, -1.25, 1.24, -1.24)
        ],
        "effectiveDd": [
            {"name": "unset-baseline-returns-input", "state": None,
             "input": {"grindDdDum": 800, "grindDurationMs": 1850},
             "expected": {"resultDum": 800, "residueUm": 80}},
            *effective_vector("explicit-baseline-equal-residue", 50, 50),
            *effective_vector("explicit-baseline-lower", 50, 40),
            *effective_vector("explicit-baseline-higher", 50, 60),
            {"name": "zero-duration-keeps-residue", "state": {"residue": 50},
             "input": {"grindDdDum": 800, "grindDurationMs": 0, "effectiveBaseline": 40},
             "expected": {"resultDum": 400, "residueUm": 50}},
        ],
        "phaseBoundaries": [
            {"name": "v3-near-inclusive", "algorithm": "GbS3",
             "state": {"history": [{"x": 50, "y": 20}, {"x": 51, "y": 21}, {"x": 52, "y": 22}], "holdCyclesRemaining": 0},
             "input": _call(30000), "expected": {"phase": "near", "locked": False, "committed": True, "historyLength": 4}},
            {"name": "v3-mid-inclusive-far", "algorithm": "GbS3", "state": {"history": [], "holdCyclesRemaining": 0},
             "input": _call(33000), "expected": {"phase": "mid", "locked": False, "committed": True, "historyLength": 1}},
            {"name": "v3-far-exclusive", "algorithm": "GbS3", "state": {"history": [], "holdCyclesRemaining": 0},
             "input": _call(33001), "expected": {"phase": "far", "locked": False, "committed": True, "historyLength": 0}},
            {"name": "v3-dd-exact-500", "algorithm": "GbS3", "state": {"history": [], "holdCyclesRemaining": 0, "lastTargetDum": 1000, "lastAdjustmentDum": 1100},
             "input": _call(30000, estimated=1500), "expected": {"phase": "mid", "locked": False, "committed": True, "historyLength": 1}},
            {"name": "v3-dd-over-500", "algorithm": "GbS3", "state": {"history": [], "holdCyclesRemaining": 0, "lastTargetDum": 1000, "lastAdjustmentDum": 1100},
             "input": _call(30000, estimated=1501), "expected": {"phase": "cancel", "locked": True, "committed": False, "historyLength": 0}},
            {"name": "v4-near-strict", "algorithm": "GbS4", "state": {"history": [{"x": 50, "y": 20}, {"x": 51, "y": 21}, {"x": 52, "y": 22}], "holdCyclesRemaining": 0, "lastTargetDum": 1000, "lastAdjustmentDum": 1100},
             "input": _call(30999), "expected": {"phase": "near", "locked": True, "committed": False, "historyLength": 3}},
            {"name": "v4-near-equal-3", "algorithm": "GbS4", "state": {"history": [{"x": 50, "y": 20}, {"x": 51, "y": 21}, {"x": 52, "y": 22}], "holdCyclesRemaining": 0, "lastTargetDum": 1000, "lastAdjustmentDum": 1100},
             "input": _call(31000), "expected": {"phase": "mid", "locked": False, "committed": True, "historyLength": 4}},
            {"name": "v4-mid-inclusive-5", "algorithm": "GbS4", "state": {"history": [], "holdCyclesRemaining": 0},
             "input": _call(33000), "expected": {"phase": "mid", "locked": False, "committed": True, "historyLength": 1}},
            {"name": "v4-far-over-5", "algorithm": "GbS4", "state": {"history": [], "holdCyclesRemaining": 0},
             "input": _call(33001), "expected": {"phase": "far", "locked": False, "committed": True, "historyLength": 0}},
        ],
        "ddEff": {"initialDdDum": 1000, "calls": 18, "expected": list(dd_eff_measurement_sequence(1000, 18))},
    }
    fixture["provenance"]["researchRevision"] = "efcf12fb5366d628468ce02117f5905c32474b41"
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent.parent / "test" / "research-golden.json"
    output.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
