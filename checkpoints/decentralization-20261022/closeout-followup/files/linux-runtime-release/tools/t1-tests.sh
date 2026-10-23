#!/usr/bin/env bash
# t1 (queue 768: the real-lease-client group starts anvil + a relay child, D measured 692 MiB): Linux tests of the COMPOSED
# release source fec43a6a (tree 13e18b08) with its SHIPPED host-admission bundle 40e8ba71. The test tree is a throwaway
# local clone of src/ (src itself stays clean); node_modules are symlinks to the D candidate's installed trees (root,
# network, relay: their package.json / package-lock.json blobs are identical at 2bbea898 and 493ee9ee, checked below).
# Groups run sequentially, each node --test bounded by its own timeouts, inside a PID namespace that kills its children.
#   G0 bundle API (tools/bundle-api.mjs) for the composed bundle + the live/checkpoint/Windows bundles as comparisons
#   G1 bundle currency: scripts/build-host-admission.mjs rebuilds BOTH policy bundles byte-identically
#   G2 D + root focused suites (adopt guard, wallet hold, policy, pool, egress)
#   G3 D's regression set (jobd6: 18 suites of the paths the hold rounds changed)
#   G4 the image-side suites of the 493ee9ee lineage this release ships (attestation paths, admission runtime/retry,
#      lease-gas conduit, owner nomination, overlay tool unittest)
#   G5 D's real lease client: createLeaseClient + the relay service on anvil (pre-relay onSigned hook)
#   G6 CONTROL: the live bundle e83515fc swapped into the throwaway tree under the composed supervisor (expected to FAIL
#      the hold suite: no decision()); the tree's bundle is restored and re-hashed afterwards
# Each group's exit status is recorded; the job exits 0 only if G0/G1 hold, every group ran, and G6 failed as expected.
# Failing cases are reported as they are (no group's failure is called a pass): see RESULT-LINUX-PACKAGE.md.
set -uo pipefail
. "$(dirname "$0")/env.sh"
set -e
S=$B/src; X=$B/tmp/tree; D=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-wallet-unknown/candidate
C=fec43a6a08da2ac287fb3a5c42de89f096f4f678
LIVE=/home/steven/enclave-prod/metal-deabf8f90/windows/node/host-admission.bundle.mjs
WIN=/home/steven/Documents/Codex/2026-10-18/wo/work/g4-node-ai-final-20261021/control/new/host-admission.bundle.mjs
export PATH="$PATH:/home/steven/.foundry/bin"
need() { local what=$1; shift; if "$@"; then echo "[ok] $what"; else echo "[FAIL] $what"; exit 9; fi; }
[ ! -e "$X" ] || { echo "$X exists"; exit 2; }
need "src HEAD $C" [ "$(git -C "$S" rev-parse HEAD)" = "$C" ]
need "src clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
git clone -q --local --no-hardlinks "$S" "$X"
need "tree HEAD $C" [ "$(git -C "$X" rev-parse HEAD)" = "$C" ]
for p in package.json package-lock.json network/package.json network/package-lock.json relay/package.json relay/package-lock.json; do
  need "$p identical to the D candidate's" cmp -s "$X/$p" "$D/$p"
done
for d in . network relay; do ln -s "$D/$d/node_modules" "$X/$d/node_modules"; done
sha256sum "$X/supervisor.js" "$X/egress.js" "$X/windows/node/host-admission.bundle.mjs" "$X/metal/guest/host-policy.bundle.mjs" "$LIVE" "$WIN"
run() {   # run NAME TIMEOUT_MS JOB_SEC CMD...  -> rc in $B/receipts/t1-NAME.rc
  local name=$1 tms=$2 sec=$3; shift 3; echo; echo "=== $name"; set +e
  ( cd "$X" && timeout -k 10 "$sec" unshare --pid --fork --kill-child --mount-proc sh -c 'exec "$@"' sh "$@" ); local rc=$?
  set -e; echo "[t1] $name exit=$rc"; echo "$rc" > "$B/receipts/t1-$name.rc"
}
nt() { local name=$1 tms=$2 sec=$3; shift 3; run "$name" "$tms" "$sec" node --test --test-timeout="$tms" --test-concurrency=1 --test-reporter=spec "$@"; }
run G0-bundle-api 0 120 node "$B/tools/bundle-api.mjs" "$X/supervisor.js" composed="$X/windows/node/host-admission.bundle.mjs" live-e83515fc="$LIVE" \
  checkpoint-3438cdf2="$D/windows/node/host-admission.bundle.mjs" windows-6bef372d="$WIN"
run G1-bundle-currency 0 300 sh -c 'node scripts/build-host-admission.mjs && node --check windows/node/host-admission.bundle.mjs && node --check metal/guest/host-policy.bundle.mjs && git diff --exit-code --stat -- windows/node/host-admission.bundle.mjs metal/guest/host-policy.bundle.mjs && echo "both policy bundles rebuild byte-identically"'
git -C "$X" checkout -q -- windows/node/host-admission.bundle.mjs metal/guest/host-policy.bundle.mjs   # later groups use the COMMITTED bytes
need "tree clean after G1" [ -z "$(git -C "$X" status --porcelain --untracked-files=no)" ]
nt G2-focused 120000 540 test/adopt-pending-stop.test.mjs test/supervisor-wallet-unknown-hold.test.mjs test/supervisor-wallet-policy.test.mjs \
  test/pool-reconcile.test.mjs test/egress.test.mjs
nt G3-regression 240000 900 test/approval-gate.test.mjs test/claim-sweep.test.mjs test/config-edit.test.mjs test/custody-supervisor.test.mjs \
  test/domain-carryover.test.mjs test/instance-reconcile.test.mjs test/instance-sweep.test.mjs test/isolation-guest-pool.test.mjs \
  test/isolation-post-adoption-lease.test.mjs test/isolation-release-ticket.test.mjs test/ledger-move.test.mjs test/rate-cap.test.mjs \
  test/tenant-lease.test.mjs test/tenant-provision-race.test.mjs test/transfer.test.mjs test/version-switch.test.mjs test/waf.test.mjs \
  test/yank-teardown.test.mjs
nt G4-image-side 240000 600 test/attestation-route.test.mjs test/host-admission-runtime.test.mjs test/host-admission-retry.test.mjs \
  test/metal-lease-gas-conduit.test.mjs test/owner-nomination-config.test.mjs
run G4-overlay-unittest 0 300 python3 -u -m unittest -v test/metal-control-overlay.test.py
rm -rf "$X/metal/__pycache__" "$X/test/__pycache__"
nt G5-real-lease-client 240000 560 test/supervisor-wallet-real-lease-client.test.mjs
echo; echo "=== G6 CONTROL: the live bundle e83515fc under the composed supervisor"
keep=$(sha256sum < "$X/windows/node/host-admission.bundle.mjs" | cut -c1-64)
cp --remove-destination "$LIVE" "$X/windows/node/host-admission.bundle.mjs"
nt G6-control-live-bundle 120000 300 test/supervisor-wallet-unknown-hold.test.mjs
git -C "$X" checkout -q -- windows/node/host-admission.bundle.mjs
need "tree bundle restored ($keep)" [ "$(sha256sum < "$X/windows/node/host-admission.bundle.mjs" | cut -c1-64)" = "$keep" ]
need "src still clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
echo; echo "=== summary"; for f in "$B"/receipts/t1-*.rc; do echo "$(basename "$f" .rc) $(cat "$f")"; done
n=$(( $(wc -l < "$B/stub/invocations.log") - STUB_BASE )); need "no ssh/scp/sftp invocation ($n)" [ "$n" -eq 0 ]
ok=1
[ "$(cat "$B/receipts/t1-G0-bundle-api.rc")" = 0 ] || ok=0
[ "$(cat "$B/receipts/t1-G1-bundle-currency.rc")" = 0 ] || ok=0
[ "$(cat "$B/receipts/t1-G6-control-live-bundle.rc")" != 0 ] || { echo "[FAIL] the live-bundle control did not fail"; ok=0; }
[ $ok = 1 ] && echo "T1-DONE (group results above; judged in RESULT-LINUX-PACKAGE.md)" || { echo "T1-FAIL"; exit 8; }
