#!/usr/bin/env bash
# App-zone certificate suites (work/app-zone-certificates). Run each through the shared queue, e.g.
#   python3 work/claude-test-queue.py --mib 256 --log <abs log> -- bash <tree>/test/run-app-zone.sh unit
# Suites: build (relay/network-runtime.bundle.mjs from source) | go (real user, offline) | unit | replica | regress | process | all
# ("all" = unit, replica, regress, process inside the namespace; run build and go separately)
# Every suite except build runs inside an unshared network namespace (loopback only: no Enclave API, CERTS_API, public
# CA, RPC or DNS is reachable); Go runs offline (GOPROXY=off, -mod=readonly). Exit 0 only if every selected suite passed.
set -euo pipefail
cd "$(dirname "$0")/.."
SUITE="${1:-}"
case "$SUITE" in build|unit|replica|regress|go|process|all|negative) ;; *) echo "usage: run-app-zone.sh build|unit|replica|regress|go|process|all|negative" >&2; exit 2;; esac
if [ "$SUITE" = build ]; then exec node relay/build-network.mjs; fi
# Go unit tests run as the REAL user: several existing front tests check file permissions/ownership (chmod 0444, another
# uid), which a user-namespace root (unshare -r) ignores. They need no network; downloads are disabled (GOPROXY=off).
if [ "$SUITE" = go ]; then
  cd isolation/m2 && export GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local
  go vet ./bootstrap ./front && go test -count=1 ./bootstrap ./front; c=$?; echo "[run] suite=go exit=$c"; exit $c
fi
# negative: every new suite with INJECT_FAILURE=1; succeeds ONLY if each injected run exits nonzero
if [ "$SUITE" = negative ]; then
  rc=0
  c=0; (cd isolation/m2 && INJECT_FAILURE=1 GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local go test -count=1 -run 'TestAppZone' ./front) || c=$?
  echo "[negative] go appzone exit=$c"; [ $c -ne 0 ] || rc=1
  for f in test/app-zone-challenge.test.mjs test/app-zone-replica.test.mjs; do
    c=0; unshare -rn bash -c "ip link set lo up; INJECT_FAILURE=1 node --test --test-concurrency=1 $f" || c=$?
    echo "[negative] $f exit=$c"; [ $c -ne 0 ] || rc=1
  done
  echo "[negative] exit=$rc (0 = every injected run failed)"; exit $rc
fi
export SUITE APPZONE_EVIDENCE="${APPZONE_EVIDENCE:-}" APPZONE_REPLICA_ENTRY="${APPZONE_REPLICA_ENTRY:-}"
exec unshare -rn bash -c '
  set -uo pipefail
  ip link set lo up
  node -e "fetch(\"https://1.1.1.1\").then(()=>process.exit(1),()=>process.exit(0))" || { echo "network NOT isolated" >&2; exit 3; }
  echo "[run] network isolated"; rc=0
  run() { echo "=== $*"; "$@"; c=$?; echo "[suite] $* exit=$c"; [ $c -eq 0 ] || rc=1; }
  export GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local
  case "$SUITE" in
    unit|all) run node --test --test-concurrency=1 --test-reporter=spec test/app-zone-challenge.test.mjs test/app-zone-sdk.test.mjs;;&
    replica|all) run node --test --test-concurrency=1 --test-reporter=spec test/app-zone-replica.test.mjs;;&
    regress|all) run node --test --test-concurrency=1 --test-reporter=spec test/dns-relay.test.mjs test/dns-relay-attested.test.mjs test/dns-relay-u7.test.mjs \
                   test/dns-relay-shrink.test.mjs test/bootstrap-names.test.mjs test/site-independent-names.test.mjs test/certs.test.mjs;;&
    process|all) run bash -c "cd isolation/m2 && APPZONE_FLEET=1 APPZONE_EVIDENCE=$APPZONE_EVIDENCE go test -count=1 -run TestAppZoneAgainstSeparateReplicaProcesses -v ./front";;
  esac
  echo "[run] suite=$SUITE exit=$rc"; exit $rc'
