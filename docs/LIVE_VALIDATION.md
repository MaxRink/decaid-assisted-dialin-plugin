# Live E64 database note — 2026-11-18

Status: **context only. The assisted-dial-in recommendation has not been
validated against physical shots or a calibrated grinder.**

A read-only database export from a reachable E64 WS was inspected to check the
metadata assumptions this plugin's comparison and abstention rules depend on.

## Observed

- `grind_log`: 8 rows, IDs 40–47, 3 successful.
- 7 of 8 rows had an empty `grind_date_time`; only the newest row had a
  timestamp (`2026-11-18T11:03:53Z`).
- Every row had `recipe_gbs_enabled = 0` and `grind_duration_noload = 0`.
- Raw `grind_ddd` values were 854–998.
- A read-only `RequestDriverState` later returned `ddValueDum = 854`, matching
  the newest `grind_log` row.
- `event_log`: 3 rows (`FactoryReset`, `LogIn`, `PasswordChange`); all three
  timestamps were empty.
- `settings`: 27 rows, `Version = 31`; `System.SetupWizard.State = Completed`.

## What it supports

- The plugin's refusal to treat missing or non-monotonic timestamps as valid
  comparison evidence is not a theoretical edge case: a real E64 export can
  contain mostly empty timestamps.
- The plugin should not infer GBS history from absent `recipe_gbs_enabled`
  metadata.
- Raw DD values are an integer coordinate (854–998 here), not a calibrated
  micrometre or 0–100 display value. A recommendation must keep the unit and
  calibration explicit.

## What it does not prove

- No recommendation was compared with a physical shot.
- No grinder setting was changed.
- No E64 shot was marked good/bad in the plugin.
- The sample is one used device, not a population default.

The full read-only report, including the sanitized database evidence, is in
`mahlkoenig-e64ws-local-research/docs/LIVE_VALIDATION_2026-11-18.md`.
