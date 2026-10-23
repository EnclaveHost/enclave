#!/usr/bin/env bash
# rebuild the host-service packages from this tree; every existing role's package must equal F's 14d1e495 build (the
# five non-RPC roles) and the public-rpc package is reported against S's 36919aaf build; then the given suites with the
# pinned binaries (B's rpc-runtime-final-integration/bin, PINS.sha256 checked here and again by the E2Es)
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$HERE/../resume-after-checkpoint-20261022/rpc-runtime-final-integration/bin"
(cd "$BIN" && sha256sum -c --quiet PINS.sha256) || { echo "pinned binaries do not match PINS.sha256"; exit 5; }
echo "pins ok: $(sha256sum "$BIN/PINS.sha256" | cut -c1-64) PINS.sha256"
bash "$HERE/jobs/build-packages.sh" || exit 3
S="$HERE/../public-rpc-host-role/repo/network/host-services/packages"   # S's 36919aaf build (untracked build output)
F="$HERE/../resume-after-checkpoint-20261022/host-service-rpc-closure/candidate/network/host-services/packages"; M="$HERE/repo/network/host-services/packages"
for f in $(ls "$M"); do
  if [ -f "$F/$f" ]; then cmp -s "$F/$f" "$M/$f" && echo "same-as-F $f" || { echo "DIFFERS-FROM-F $f"; exit 4; }
  else old=$(sha256sum < "$S/$f" | cut -c1-64); new=$(sha256sum < "$M/$f" | cut -c1-64)
    [ "$old" = "$new" ] && echo "same-as-36919 $f $new" || echo "changed-vs-36919 $f $old -> $new"; fi
done
export RETH_BIN="$BIN/reth-v2.8.0" HELIOS_BASE_BIN="$BIN/helios-eeffcc9" WITNESS_CHECK_BIN="$BIN/witness-check" CONSUMERS="$HERE/consumers"
exec bash "$HERE/jobs/job.sh" "$@"
