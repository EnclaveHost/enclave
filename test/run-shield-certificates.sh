#!/usr/bin/env bash
# Enclave Shield independent app-zone certificate suites (work/shield-certificates). Run each through the shared queue:
#   python3 work/claude-test-queue.py --mib <cap> --log <abs guard log> -- bash <tree>/test/run-shield-certificates.sh <suite> > <abs out> 2>&1
# Suites (caps): build 512 (relay/network-runtime.bundle.mjs from source) | unit 512 | replica 768 | regress 768 | go 1024 |
#   process 1024 | negative 1024
# Every node/process suite runs inside an unshared network namespace (loopback only: no relay, Enclave API, CERTS_API,
# public CA, RPC or DNS is reachable). Go runs offline (GOPROXY=off, -mod=readonly) as the real user (file-permission tests).
# ALL fixtures are SYNTHETIC (TPM, VBS report, AMD reports, chain, CA): nothing here is Windows hardware or a public CA.
# Exit 0 only if every step of the selected suite passed.
set -euo pipefail
cd "$(dirname "$0")/.."
SUITE="${1:-}"
case "$SUITE" in build|unit|replica|regress|go|process|negative) ;; *) echo "usage: run-shield-certificates.sh build|unit|replica|regress|go|process|negative" >&2; exit 2;; esac
if [ "$SUITE" = build ]; then
  node relay/build-network.mjs
  node --input-type=module -e 'import("./relay/network-runtime.bundle.mjs").then((m) => { if (typeof m.createAppZoneShield !== "function") { console.error("bundle lacks createAppZoneShield"); process.exit(1); } console.log("[build] bundle exports createAppZoneShield"); })'
  echo "[run] suite=build exit=0"; exit 0
fi
if [ "$SUITE" = go ]; then
  cd isolation/m2
  export GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local
  rc=0
  go vet ./bootstrap ./front || rc=1
  go vet -tags 'bootstrapdirect shielddirect' ./front || rc=1
  go test -count=1 ./bootstrap ./front || rc=1
  go test -count=1 -tags 'bootstrapdirect shielddirect' ./front || rc=1
  echo "[run] suite=go exit=$rc"; exit $rc
fi
if [ "$SUITE" = negative ]; then
  rc=0
  c=0; (cd isolation/m2 && INJECT_FAILURE=1 GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local go test -count=1 -run 'TestAppZoneInjectedFailure' ./front) || c=$?
  echo "[negative] go appzone exit=$c"; [ $c -ne 0 ] || rc=1
  for f in test/app-zone-shield.test.mjs test/app-zone-shield-replica.test.mjs; do
    c=0; unshare -rn bash -c "ip link set lo up; INJECT_FAILURE=1 node --test --test-concurrency=1 $f" || c=$?
    echo "[negative] $f exit=$c"; [ $c -ne 0 ] || rc=1
  done
  echo "[negative] exit=$rc (0 = every injected run failed)"; exit $rc
fi
export SUITE APPZONE_EVIDENCE="${APPZONE_EVIDENCE:-}"
exec unshare -rn bash -c '
  set -uo pipefail
  ip link set lo up
  node -e "fetch(\"https://1.1.1.1\").then(()=>process.exit(1),()=>process.exit(0))" || { echo "network NOT isolated" >&2; exit 3; }
  echo "[run] network isolated"; rc=0
  run() { echo "=== $*"; "$@"; c=$?; echo "[suite] $* exit=$c"; [ $c -eq 0 ] || rc=1; }
  export GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local
  case "$SUITE" in
    unit) run node --test --test-concurrency=1 --test-reporter=spec test/app-zone-shield.test.mjs;;
    replica) run node --test --test-concurrency=1 --test-reporter=spec test/app-zone-shield-replica.test.mjs;;
    regress) run node --test --test-concurrency=1 --test-reporter=spec test/app-zone-challenge.test.mjs test/app-zone-replica.test.mjs \
               test/shield-dns-challenge.test.mjs test/dns-relay-attested.test.mjs test/dns-relay.test.mjs test/dns-read-only.test.mjs \
               test/shield-host-session.test.mjs test/shield-custody.test.mjs test/windows-shield-startup.test.mjs \
               test/windows-shield-custody-transport.test.mjs test/windows-node-hv-attach.test.mjs test/relay-network-bundle.test.mjs;;
    process) run bash -c "cd isolation/m2 && APPZONE_SHIELD_FLEET=1 APPZONE_EVIDENCE=$APPZONE_EVIDENCE go test -count=1 -run TestAppZoneShieldAgainstSeparateReplicaProcesses -v ./front"
             run bash -c "cd isolation/m2 && APPZONE_FLEET=1 go test -count=1 -run TestAppZoneAgainstSeparateReplicaProcesses -v ./front";;
  esac
  echo "[run] suite=$SUITE exit=$rc"; exit $rc'
