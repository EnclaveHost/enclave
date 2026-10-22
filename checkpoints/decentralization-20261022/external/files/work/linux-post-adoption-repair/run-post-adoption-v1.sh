#!/usr/bin/env bash
# Post-adoption repair (immutable; v1), on tree/ = the frozen corrected release (51516b778) + this repair:
#  1. the cutover regression on the REPAIRED supervisor: every timeline passes, none skipped;
#  2. the SAME regression on the unrepaired supervisor (supervisor.baseline-seam.js = frozen + only the test seam and the
#     sweep-stage extraction): the three transient timelines must FAIL and the explicit-refusal one pass;
#  3. the authorization-nonce regression (anvil, real relay) on the REPAIRED client: passes, none skipped;
#  4. the same on the frozen client (client/lease-executor-client.baseline.mjs): must fail, with the relay's
#     StaleAuthorization refusal reproduced;
#  5. the existing suites over the changed code (reconcile/vouch/sweep/resume, lease client, relay, Windows host).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/tree"
for f in supervisor.js supervisor.baseline-seam.js client/lease-executor-client.mjs; do node --check "$f"; done
out=$(mktemp); trap 'rm -f "$out"' EXIT
tally() { grep -E "^# (pass|fail|skipped) " "$out" | tr '\n' ' '; echo; }
echo "=== 1 cutover regression, repaired"
node --test --test-concurrency=1 test/isolation-post-adoption-lease.test.mjs > "$out" 2>&1 || { cat "$out"; echo "run-post-adoption-v1: FAIL (1)"; exit 1; }
tally; grep -qx '# pass 4' "$out" && grep -qx '# fail 0' "$out" && grep -qx '# skipped 0' "$out" || { cat "$out"; echo "run-post-adoption-v1: FAIL (1 counts)"; exit 1; }
echo "=== 2 cutover regression, unrepaired (must fail the transient timelines)"
rc=0; SUPERVISOR_UNDER_TEST=supervisor.baseline-seam.js node --test --test-concurrency=1 test/isolation-post-adoption-lease.test.mjs > "$out" 2>&1 || rc=$?
tally; grep -E "^(not )?ok " "$out"
[ "$rc" -ne 0 ] && grep -qx '# pass 1' "$out" && grep -qx '# fail 3' "$out" \
  && grep -qE '^ok .* an explicit platform refusal' "$out" \
  && [ "$(grep -cE '^not ok .* (an unreadable policy at boot|a cold boot whose ledger read fails)' "$out")" = 3 ] \
  || { cat "$out"; echo "run-post-adoption-v1: FAIL (2: the unrepaired supervisor did not fail exactly as expected)"; exit 1; }
grep -E "the paid guest was neither deleted nor let lapse|the resume adopted the guest" "$out" | head -3 | cut -c1-400
echo "=== 3 authorization nonce, repaired"
node --test --test-concurrency=1 test/lease-authorization-nonce.test.mjs > "$out" 2>&1 || { cat "$out"; echo "run-post-adoption-v1: FAIL (3)"; exit 1; }
tally; grep -qx '# pass 2' "$out" && grep -qx '# fail 0' "$out" && grep -qx '# skipped 0' "$out" || { cat "$out"; echo "run-post-adoption-v1: FAIL (3 counts)"; exit 1; }
echo "=== 4 authorization nonce, frozen client (must fail with the relay's StaleAuthorization)"
rc=0; LEASE_CLIENT_UNDER_TEST=../client/lease-executor-client.baseline.mjs node --test --test-concurrency=1 test/lease-authorization-nonce.test.mjs > "$out" 2>&1 || rc=$?
tally; grep -E "^(not )?ok " "$out"
[ "$rc" -ne 0 ] && grep -qx '# fail 2' "$out" && grep -qx '# skipped 0' "$out" && grep -q "StaleAuthorization the authorization's nonce" "$out" \
  || { cat "$out"; echo "run-post-adoption-v1: FAIL (4: the frozen client did not reproduce StaleAuthorization)"; exit 1; }
grep -o "StaleAuthorization the authorization's nonce [0-9]* is not the account's [0-9]*" "$out" | head -1
echo "=== 5 existing suites over the changed code"
node --test --test-concurrency=1 test/instance-reconcile.test.mjs test/instance-sweep.test.mjs test/tenant-lease.test.mjs test/claim-sweep.test.mjs \
  test/direct-only-supervisor.test.mjs test/isolation-resume-shield-model.test.mjs test/isolation-claim-gate.test.mjs test/isolation-guest-pool.test.mjs \
  test/lease-authority.test.mjs test/lease-client-durability.test.mjs test/lease-consumed-own-receipt.test.mjs test/lease-executor-e2e.test.mjs \
  test/lease-relay-release.test.mjs test/lease-relay-resilience.test.mjs test/lease-relay-service.test.mjs test/lease-resolve-domain.test.mjs \
  test/lease-gas-runtime.test.mjs test/metal-lease-gas-conduit.test.mjs test/relay-security.test.mjs test/windows-current-runtime.test.mjs \
  test/windows-host-app-funded.test.mjs test/windows-release-journal.test.mjs test/move-release-durable.test.mjs test/move-release-restart.test.mjs > "$out" 2>&1 \
  || { grep -E "^not ok |^# " "$out"; tail -150 "$out"; echo "run-post-adoption-v1: FAIL (5)"; exit 1; }
tally; grep -qx '# fail 0' "$out" || { tail -150 "$out"; echo "run-post-adoption-v1: FAIL (5 counts)"; exit 1; }
grep -E "^# skipped [1-9]" "$out" && grep -E "^ok .*# SKIP" "$out" | cut -c1-200 || true
echo "run-post-adoption-v1: PASS"
