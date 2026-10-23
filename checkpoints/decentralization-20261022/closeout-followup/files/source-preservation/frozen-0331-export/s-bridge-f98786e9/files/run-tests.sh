#!/bin/bash
# The harness's offline tests, inside a private network namespace (no route anywhere; loopback also carries 203.0.113.5,
# standing in for a Sia host address). Run through the shared queue, e.g.
#   python3 -u work/claude-test-queue.py --mib 256 --log LOG -- ./run-tests.sh [harness|bridge]
set -u
cd "$(dirname "$0")" || exit 2
sha256sum whole_restore.py runner.py test/test_harness.py test/test_bridge.py test/fake-sia-s3 test/stubs/*
suites=${1:-harness bridge}
exec timeout -k 10 "${JOB_SEC:-420}" unshare --user --map-root-user --net sh -c '
  ip link set lo up && ip address add 203.0.113.5/32 dev lo || exit 2
  rc=0
  for s in $0; do echo "=== test_$s.py"; python3 -I test/test_$s.py $TESTS || rc=1; done
  exit $rc' "$suites"
