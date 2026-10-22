#!/usr/bin/env bash
# (immutable; v1) A. the ten tests run-post-adoption-v1 SKIPPED for missing inputs, now with them, on tree/ (frozen 51516b778
#    + this repair): move-release-durable/restart (main's contracts/foundry/out linked read-only; the contract sources are
#    identical) and the resume-shield evidence tests (production's own supervisor; the frozen unrepaired candidate) -
#    none may skip; B. the composition on main-tree/ (a scratch copy of CURRENT main's working tree + this repair, the
#    createLeaseClient signature hand-merged with main's relay discovery): both new regressions and the same 24 suites.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
W=/home/steven/Documents/Codex/2026-10-18/wo/work
out=$(mktemp); trap 'rm -f "$out"' EXIT
tally() { grep -E "^# (pass|fail|skipped) " "$out" | tr '\n' ' '; echo; }
need() { grep -qx "# fail 0" "$out" && grep -qx "# skipped 0" "$out" && grep -qx "# pass $1" "$out"; }
echo "=== A. previously skipped, tree/"
cd "$here/tree"
PROD_SUPERVISOR="$here/tree/.prod-2857356cd/supervisor.js" FROZEN_CANDIDATE_SUPERVISOR="$W/linux-lease-root-release/tree/supervisor.js" \
  node --test --test-concurrency=1 test/move-release-durable.test.mjs test/move-release-restart.test.mjs test/isolation-resume-shield-model.test.mjs > "$out" 2>&1 \
  || { cat "$out"; echo "run-skips-and-main-v1: FAIL (A)"; exit 1; }
tally; grep -qx "# fail 0" "$out" && grep -qx "# skipped 0" "$out" || { cat "$out"; echo "run-skips-and-main-v1: FAIL (A: skipped or failed)"; exit 1; }
echo "=== B. main composition, main-tree/"
cd "$here/main-tree"
for f in supervisor.js client/lease-executor-client.mjs; do node --check "$f"; done
node --test --test-concurrency=1 test/isolation-post-adoption-lease.test.mjs > "$out" 2>&1 || { cat "$out"; echo "run-skips-and-main-v1: FAIL (B cutover)"; exit 1; }
tally; need 4 || { cat "$out"; echo "run-skips-and-main-v1: FAIL (B cutover counts)"; exit 1; }
node --test --test-concurrency=1 test/lease-authorization-nonce.test.mjs > "$out" 2>&1 || { cat "$out"; echo "run-skips-and-main-v1: FAIL (B nonce)"; exit 1; }
tally; need 2 || { cat "$out"; echo "run-skips-and-main-v1: FAIL (B nonce counts)"; exit 1; }
PROD_SUPERVISOR="$here/main-tree/.prod-2857356cd/supervisor.js" FROZEN_CANDIDATE_SUPERVISOR="$W/linux-lease-root-release/tree/supervisor.js" \
node --test --test-concurrency=1 test/instance-reconcile.test.mjs test/instance-sweep.test.mjs test/tenant-lease.test.mjs test/claim-sweep.test.mjs \
  test/direct-only-supervisor.test.mjs test/isolation-resume-shield-model.test.mjs test/isolation-claim-gate.test.mjs test/isolation-guest-pool.test.mjs \
  test/lease-authority.test.mjs test/lease-client-durability.test.mjs test/lease-consumed-own-receipt.test.mjs test/lease-executor-e2e.test.mjs \
  test/lease-relay-release.test.mjs test/lease-relay-resilience.test.mjs test/lease-relay-service.test.mjs test/lease-resolve-domain.test.mjs \
  test/lease-gas-runtime.test.mjs test/metal-lease-gas-conduit.test.mjs test/relay-security.test.mjs test/windows-current-runtime.test.mjs \
  test/windows-host-app-funded.test.mjs test/windows-release-journal.test.mjs test/move-release-durable.test.mjs test/move-release-restart.test.mjs > "$out" 2>&1 \
  || { grep -E "^not ok |^# " "$out"; tail -150 "$out"; echo "run-skips-and-main-v1: FAIL (B suites)"; exit 1; }
tally; grep -qx '# fail 0' "$out" || { tail -150 "$out"; echo "run-skips-and-main-v1: FAIL (B suites counts)"; exit 1; }
grep -E "# SKIP" "$out" | cut -c1-200 || true
echo "run-skips-and-main-v1: PASS"
