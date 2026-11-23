#!/bin/sh
# Local equivalent of the CI host-contract job: validate this plugin's manifest
# with Decaid's own parser and run ci/host_runtime_test.dart in its real QuickJS
# host. Files are copied into the Decaid checkout only for the run (into a
# private subdirectory, so the checkout's own test helpers are untouched) and
# are always removed.
#
#   DECAID_ROOT  Decaid checkout (default: ../mahlkoenig-e64ws-local-research/decaid)
#   FLUTTER      flutter executable (default: flutter on PATH)
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
DECAID_ROOT=${DECAID_ROOT:-$root/../mahlkoenig-e64ws-local-research/decaid}
flutter=${FLUTTER:-flutter}
[ -f "$DECAID_ROOT/pubspec.yaml" ] || { echo "Decaid checkout not found at $DECAID_ROOT (set DECAID_ROOT)" >&2; exit 1; }
dir="$DECAID_ROOT/test/plugins/dialin_contract_$$"
tool="$DECAID_ROOT/tool/validate_dialin_contract_$$.dart"
cleanup() {
  rm -f "$dir/dialin_runtime_test.dart" "$dir/plugin_test_helpers.dart" "$tool"
  [ -d "$dir" ] && rmdir "$dir" || true
}
trap cleanup EXIT
trap 'exit 1' INT TERM
mkdir "$dir"
cp "$root/ci/host_runtime_test.dart" "$dir/dialin_runtime_test.dart"
cp "$root/ci/plugin_test_helpers.dart" "$dir/plugin_test_helpers.dart"
cp "$root/ci/validate-host-contract.dart" "$tool"
cd "$DECAID_ROOT"
dart run "$tool" "$root"
DIALIN_PLUGIN_ROOT="$root" "$flutter" test --no-pub "$dir/dialin_runtime_test.dart"
