#!/bin/sh
# Run every LOCAL test of the per-app deployment path at one commit, saving each suite's output and exit code, so
# an evidence file can be cut from files instead of a terminal. No guest is launched.
#
#   usage: run-integration-tests.sh <guestd hardware run dir> [workdir]
set -e
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
G=${1:?usage: run-integration-tests.sh <guestd hardware run dir> [workdir]}
W=${2:-$HOME/enclave-bench/integration-tests-$(date +%H%M%S)}
mkdir -p "$W"; W=$(cd "$W" && pwd)
(cd "$repo" && git rev-parse HEAD > "$W/commit" && git status --porcelain > "$W/dirty")
suite() {   # suite <name> <dir> <command...>
  name=$1; dir=$2; shift 2
  rc=0; (cd "$dir" && "$@") > "$W/$name.out" 2>&1 || rc=$?
  echo "$rc" > "$W/$name.rc"
  echo "$name rc=$rc"
}
suite contract "$repo/isolation/contract" go test -count=1 -v ./...
suite guestd "$here/guestd" go test -race -count=1 -v ./...
suite claim-gate "$repo" node --test test/isolation-claim-gate.test.mjs
suite domain-release "$here" ./test-domain-release.sh "$G" "$W/domain-release"
suite image-repro "$here" ./test-image-repro.sh "$G/A.bundle" "$W/image-repro"
suite control "$here" ./test-guestd-control.sh "$W/control"
# every repository test that drives supervisor.js: the flag-off behaviour must be unchanged
suite supervisor "$repo" sh -c 'node --test --test-timeout=120000 $(grep -l supervisor.js test/*.test.mjs)'

echo "results in $W"
