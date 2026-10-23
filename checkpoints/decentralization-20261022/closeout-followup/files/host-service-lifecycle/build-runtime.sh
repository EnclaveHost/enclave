#!/usr/bin/env bash
# Build the GITIGNORED relay/network-runtime.bundle.mjs from this candidate's sources (offline namespace), then run the two
# suites that consume it. Reports which changed sources the bundle carries.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-lifecycle
cd "$HERE/candidate"; export TMPDIR="$HERE/tmp/t" PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"
timeout -k 10 300 unshare -rn --pid --fork --kill-child --mount-proc node relay/build-network.mjs
sha256sum relay/network-runtime.bundle.mjs
for m in 'hostServiceLifecycle' 'cancelledStartup' 'SETTLE_MS' 'host service grant at'; do printf '%s in runtime bundle: %s\n' "$m" "$(grep -c "$m" relay/network-runtime.bundle.mjs || true)"; done
exec "$HERE/job.sh" "$@"
