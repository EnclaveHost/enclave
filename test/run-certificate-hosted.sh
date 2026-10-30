#!/usr/bin/env bash
# Certificate hosted placement suites (work/certificate-hosted-placement: main + the Shield certificate patch + the Enclave
# host challenge service). One suite per queue job:
#   python3 work/claude-test-queue.py --mib <cap> --log <abs guard log> -- bash <tree>/test/run-certificate-hosted.sh <suite> > <abs out> 2>&1
# Suites (caps): build 512 | host 768 | appzone 768 | sdk 512 | regress 768 | negative 1024
# (Go and the Shield process/replica suites use test/run-shield-certificates.sh go|process|replica at 1024/1024/768.)
# Every node suite runs inside an unshared network namespace (loopback only). ALL fixtures are SYNTHETIC (TPM, VBS
# report, chain, CA): nothing here is Windows hardware or a public CA. Exit 0 only if every step passed.
set -euo pipefail
cd "$(dirname "$0")/.."
SUITE="${1:-}"
case "$SUITE" in build|host|appzone|sdk|regress|negative) ;; *) echo "usage: run-certificate-hosted.sh build|host|appzone|sdk|regress|negative" >&2; exit 2;; esac
if [ "$SUITE" = build ]; then
  node relay/build-network.mjs
  node --input-type=module -e 'import("./relay/network-runtime.bundle.mjs").then((m) => { for (const k of ["createAppZoneShield", "createAppZoneAuthority", "createShieldChallengeAuth"]) if (typeof m[k] !== "function") { console.error("bundle lacks " + k); process.exit(1); } console.log("[build] bundle exports the app-zone, Shield app-zone and owner-name authorities"); })'
  echo "[run] suite=build exit=0"; exit 0
fi
if [ "$SUITE" = negative ]; then
  rc=0
  for f in test/challenge-replica-host.test.mjs test/app-zone-shield.test.mjs; do
    c=0; unshare -rn bash -c "ip link set lo up; INJECT_FAILURE=1 node --test --test-concurrency=1 $f" || c=$?
    echo "[negative] $f exit=$c"; [ $c -ne 0 ] || rc=1
  done
  c=0; (cd isolation/m2 && INJECT_FAILURE=1 GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local go test -count=1 -run 'TestAppZoneInjectedFailure' ./front) || c=$?
  echo "[negative] go appzone exit=$c"; [ $c -ne 0 ] || rc=1
  echo "[negative] exit=$rc (0 = every injected run failed)"; exit $rc
fi
export SUITE
exec unshare -rn bash -c '
  set -uo pipefail
  ip link set lo up
  node -e "fetch(\"https://1.1.1.1\").then(()=>process.exit(1),()=>process.exit(0))" || { echo "network NOT isolated" >&2; exit 3; }
  echo "[run] network isolated"; rc=0
  run() { echo "=== $*"; "$@"; c=$?; echo "[suite] $* exit=$c"; [ $c -eq 0 ] || rc=1; }
  case "$SUITE" in
    host) run node --test --test-concurrency=1 --test-reporter=spec test/challenge-replica-host.test.mjs;;
    appzone) run node --test --test-concurrency=1 --test-reporter=spec test/app-zone-shield.test.mjs test/app-zone-challenge.test.mjs test/app-zone-replica.test.mjs;;
    sdk) run node --test --test-concurrency=1 --test-reporter=spec test/app-zone-sdk.test.mjs test/history-owner-tools.test.mjs test/history-checkpoint-transport.test.mjs;;
    regress) run node --test --test-concurrency=1 --test-reporter=spec test/shield-dns-challenge.test.mjs test/dns-relay-attested.test.mjs test/dns-relay.test.mjs \
               test/dns-read-only.test.mjs test/shield-host-session.test.mjs test/shield-custody.test.mjs test/windows-shield-startup.test.mjs \
               test/windows-shield-custody-transport.test.mjs test/windows-node-hv-attach.test.mjs test/relay-network-bundle.test.mjs \
               test/host-egress.test.mjs test/enclave-network-host-canary.test.mjs test/provider-canary-independent.test.mjs \
               test/windows-node-private-paths.test.mjs test/windows-node-session.test.mjs test/windows-node-hvcert.test.mjs;;
  esac
  echo "[run] suite=$SUITE exit=$rc"; exit $rc'
