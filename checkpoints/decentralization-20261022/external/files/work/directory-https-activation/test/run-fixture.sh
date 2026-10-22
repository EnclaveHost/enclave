#!/usr/bin/env bash
# Fixture suites in an unshared network namespace (loopback only: no Enclave API, minipc, DNS or Internet).
# Run under test/guarded.sh, e.g.  test/guarded.sh 512 logs/fixture.log -- bash test/run-fixture.sh --all
#   --all                 proxy fixture for all four hosts, then the remote.py activation fixture
#   --hosts h1,h2         proxy fixture for these hosts only (each must be one of the four)
#   --activation-only     only the remote.py activation fixture
#   --negative-control    both suites with INJECT_FAILURE=1; this step SUCCEEDS only if each suite exits nonzero
# Exit status: 0 only if every selected suite passed (or, for --negative-control, every injected run failed).
set -euo pipefail
cd "$(dirname "$0")/.."
VALID="us-west eu-central ap-southeast ca-east"; HOSTS=""; ACT=0; NEG=0
case "${1:-}" in
  --all) HOSTS="$VALID"; ACT=1;;
  --hosts) for h in ${2//,/ }; do [[ " $VALID " == *" $h "* ]] || { echo "unknown host: $h" >&2; exit 2; }; HOSTS="$HOSTS $h"; done
           [ -n "$HOSTS" ] || { echo "--hosts needs at least one host" >&2; exit 2; };;
  --activation-only) ACT=1;;
  --negative-control) NEG=1;;
  *) echo "usage: run-fixture.sh --all | --hosts h1,h2 | --activation-only | --negative-control" >&2; exit 2;;
esac
export HOSTS ACT NEG
exec unshare -rn bash -c '
  set -uo pipefail
  ip link set lo up
  if node -e "fetch(\"https://1.1.1.1\").then(()=>process.exit(1),()=>process.exit(0))"; then echo "[fixture] network isolated: external fetch refused"; else echo "network NOT isolated" >&2; exit 3; fi
  rc=0; ran=0
  if [ "$NEG" = 1 ]; then
    for f in "HOST=us-west test/directory-https.test.mjs" "x=1 test/activation.test.mjs"; do
      set -- $f
      env INJECT_FAILURE=1 "$1" node --test --test-concurrency=1 --test-reporter=spec "$2"; code=$?
      echo "[negative-control] $2 exit=$code"; ran=$((ran+1))
      [ "$code" -ne 0 ] || { echo "[negative-control] FAILED: injected assertion did not fail the run" >&2; rc=1; }
    done
  fi
  for h in $HOSTS; do
    echo "=== HOST=$h"; ran=$((ran+1))
    HOST=$h node --test --test-concurrency=1 --test-reporter=spec test/directory-https.test.mjs || rc=1
  done
  if [ "$ACT" = 1 ]; then
    echo "=== activation (remote.py) fixture"; ran=$((ran+1))
    node --test --test-concurrency=1 --test-reporter=spec test/activation.test.mjs || rc=1
  fi
  [ "$ran" -gt 0 ] || { echo "nothing selected" >&2; rc=2; }
  echo "[fixture] suites=$ran exit=$rc"
  exit $rc'
