#!/usr/bin/env bash
# Credit-vault independence suites (work/credit-vault-independence). Run each through the shared queue, e.g.
#   python3 work/claude-test-queue.py --mib 768 --log <abs log> -- bash <tree>/test/run-credit-vault.sh node
# Suites: unit (pure core + vendor bundle + every host-service package, the credit-vault-submitter role's included) | node (anvil end to end, CLI, relay, parallel-reserve client,
#         submitter host-service role) | runner (the role launched by the shared host-service runner) | concurrency (the relay
#         under concurrent requests, with the real sender and external signer) | lease (the lease-gas owner CLI with the credit-vault reconciliation) | browser (Chromium, /credit/) |
#         regress (existing vault/recover/site suites this change touches) | negative (every new suite with INJECT_FAILURE=1)
# Every suite runs inside an unshared network namespace: loopback only, so no Enclave API, billing, RPC or DNS is
# reachable; the suite also proves that from inside. Exit 0 only if every selected suite passed.
set -euo pipefail
cd "$(dirname "$0")/.."
SUITE="${1:-}"
case "$SUITE" in unit|node|reserve|runner|concurrency|service-index|hosted-placement|hosted-policy|lease|browser|regress|negative) ;; *) echo "usage: run-credit-vault.sh unit|node|reserve|runner|concurrency|service-index|hosted-placement|hosted-policy|lease|browser|regress|negative" >&2; exit 2;; esac
export SUITE PATH="$HOME/.foundry/bin:$PATH" SITE_CREDIT_EVIDENCE="${SITE_CREDIT_EVIDENCE:-}"
exec unshare -rn bash -c '
  set -uo pipefail
  ip link set lo up
  node -e "fetch(\"https://1.1.1.1\").then(()=>process.exit(1),()=>process.exit(0))" || { echo "network NOT isolated" >&2; exit 3; }
  node -e "fetch(\"https://api.enclave.host/v1/billing/vault\").then(()=>process.exit(1),()=>process.exit(0))" || { echo "billing API reachable" >&2; exit 3; }
  echo "[run] network isolated; api.enclave.host/billing unreachable"; rc=0
  run() { echo "=== $*"; "$@"; c=$?; echo "[suite] $* exit=$c"; [ $c -eq 0 ] || rc=1; }
  case "$SUITE" in
    unit) run node --test --test-concurrency=1 --test-reporter=spec test/credit-vault-core.test.mjs
          run node scripts/build-credit-vault-vendor.mjs --check
          run node scripts/build-host-service-packages.mjs --check;;
    node) run node --test --test-concurrency=1 --test-reporter=spec test/credit-vault-independent.test.mjs test/credit-vault-reserve.test.mjs;;
    reserve) run node --test --test-concurrency=1 --test-reporter=spec test/credit-vault-reserve.test.mjs;;
    runner) run node --test --test-concurrency=1 --test-reporter=spec test/credit-vault-submitter-runner.test.mjs;;
    concurrency) run node --test --test-concurrency=1 --test-reporter=spec test/credit-vault-relay-concurrency.test.mjs;;
    hosted-placement) run node --test --test-concurrency=1 --test-reporter=spec test/hosted-service-placement.test.mjs;;
    hosted-policy) run node --test --test-concurrency=1 --test-reporter=spec test/hosted-policy-cold-start.test.mjs;;
    service-index) run node --test --test-concurrency=1 --test-reporter=spec test/service-index.test.mjs;;
    lease) run node --test --test-concurrency=1 --test-reporter=spec test/lease-gas-owner-cli.test.mjs;;
    browser) run node --test --test-concurrency=1 --test-reporter=spec test/credit-vault-browser.test.mjs;;
    regress) run node --test --test-concurrency=1 --test-reporter=spec test/vault-digest.test.mjs test/site-independent-bundle.test.mjs;;
    negative)
      for f in test/credit-vault-core.test.mjs test/credit-vault-independent.test.mjs test/credit-vault-reserve.test.mjs test/credit-vault-submitter-runner.test.mjs test/credit-vault-relay-concurrency.test.mjs test/credit-vault-browser.test.mjs; do
        c=0; INJECT_FAILURE=1 node --test --test-concurrency=1 "$f" >/dev/null 2>&1 || c=$?
        echo "[negative] $f exit=$c"; [ $c -ne 0 ] || rc=1
      done;;
  esac
  echo "[run] suite=$SUITE exit=$rc"; exit $rc'
