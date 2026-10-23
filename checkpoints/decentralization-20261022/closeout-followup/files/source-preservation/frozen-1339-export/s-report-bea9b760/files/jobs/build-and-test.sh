#!/usr/bin/env bash
# rebuild the host-service packages from this tree, compare every existing role's package with F's 14d1e495 build, then the tests
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
bash "$HERE/jobs/build-packages.sh" || exit 3
F="$HERE/../resume-after-checkpoint-20261022/host-service-rpc-closure/candidate/network/host-services/packages"; M="$HERE/repo/network/host-services/packages"
for f in $(ls "$M"); do if [ -f "$F/$f" ]; then cmp -s "$F/$f" "$M/$f" && echo "same-as-F $f" || { echo "DIFFERS-FROM-F $f"; exit 4; }; else echo "new $f $(sha256sum < "$M/$f" | cut -c1-64)"; fi; done
exec bash "$HERE/jobs/job.sh" "$@"
