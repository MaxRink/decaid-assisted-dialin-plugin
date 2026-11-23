#!/bin/sh
# Run ci/sim_host_runtime_test.dart inside a Decaid checkout's real QuickJS host.
# The test files are copied into the checkout only for the run and always removed.
#
#   DECAID_ROOT        Decaid checkout (default: $E64_SIM_ROOT/decaid)
#   E64_SIM_ROOT       private research repository with tools/e64ws_simulator.py
#                      (default: ../mahlkoenig-e64ws-local-research)
#   E64_PLUGIN_ROOT    E64 Decaid plugin checkout (default: ../decaid-e64ws-plugin)
#   E64_SIM_OPTIONAL=1 skip instead of failing when the simulator is missing
#   FLUTTER            flutter executable (default: flutter on PATH)
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
E64_SIM_ROOT=$(cd "${E64_SIM_ROOT:-$root/../mahlkoenig-e64ws-local-research}" 2>/dev/null && pwd || echo "${E64_SIM_ROOT:-$root/../mahlkoenig-e64ws-local-research}")
E64_PLUGIN_ROOT=${E64_PLUGIN_ROOT:-$root/../decaid-e64ws-plugin}
DECAID_ROOT=${DECAID_ROOT:-$E64_SIM_ROOT/decaid}
flutter=${FLUTTER:-flutter}
if [ ! -f "$DECAID_ROOT/pubspec.yaml" ]; then
  if [ "${E64_SIM_OPTIONAL:-}" = 1 ]; then echo "SKIPPED: no Decaid checkout at $DECAID_ROOT (E64_SIM_OPTIONAL=1)"; exit 0; fi
  echo "Decaid checkout not found at $DECAID_ROOT (set DECAID_ROOT)" >&2; exit 1
fi
target="$DECAID_ROOT/test/plugins"
test_copy="$target/dialin_e64_sim_test.dart"
helper_copy="$target/dialin_e64_sim_helper.dart"
for file in "$test_copy" "$helper_copy"; do
  if [ -e "$file" ]; then echo "$file already exists; refusing to overwrite it" >&2; exit 1; fi
done
# The simulator launcher (E64Sim) is shared with the E64 plugin's own host test.
if [ ! -f "$E64_PLUGIN_ROOT/ci/host_sim_test.dart" ]; then
  if [ "${E64_SIM_OPTIONAL:-}" = 1 ]; then echo "SKIPPED: no E64 plugin checkout at $E64_PLUGIN_ROOT (E64_SIM_OPTIONAL=1)"; exit 0; fi
  echo "E64 plugin ci/host_sim_test.dart not found in $E64_PLUGIN_ROOT (set E64_PLUGIN_ROOT)" >&2; exit 1
fi
cleanup() { rm -f "$test_copy" "$helper_copy"; }
trap cleanup EXIT
trap 'exit 1' INT TERM
cp "$root/ci/sim_host_runtime_test.dart" "$test_copy"
cp "$E64_PLUGIN_ROOT/ci/host_sim_test.dart" "$helper_copy"
cd "$DECAID_ROOT"
DIALIN_PLUGIN_ROOT="$root" E64_SIM_ROOT="$E64_SIM_ROOT" E64_PLUGIN_ROOT="$E64_PLUGIN_ROOT" \
  "$flutter" test test/plugins/dialin_e64_sim_test.dart
