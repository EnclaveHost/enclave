#!/usr/bin/env bash
# Fixture proxy tests for every host, then the remote.py activation fixture, in an unshared network namespace (loopback
# only: no Enclave API, minipc, DNS or Internet). Run under test/guarded.sh:
#   test/guarded.sh 512 logs/fixture.log -- bash test/run-fixture.sh [host ...]
set -euo pipefail
cd "$(dirname "$0")/.."
HOSTS=${*:-us-west eu-central ap-southeast ca-east}
exec unshare -rn bash -c '
  set -uo pipefail
  ip link set lo up
  if node -e "fetch(\"https://1.1.1.1\").then(()=>process.exit(1),()=>process.exit(0))"; then echo "[fixture] network isolated: external fetch refused"; else echo "network NOT isolated" >&2; exit 3; fi
  rc=0
  for h in '"$HOSTS"'; do
    echo "=== HOST=$h"
    HOST=$h node --test --test-concurrency=1 --test-reporter=spec test/directory-https.test.mjs || rc=1
  done
  if [ -z "${SKIP_ACTIVATION:-}" ]; then
    echo "=== activation (remote.py) fixture"
    node --test --test-concurrency=1 --test-reporter=spec test/activation.test.mjs || rc=1
  fi
  echo "[fixture] exit=$rc"
  exit $rc'
