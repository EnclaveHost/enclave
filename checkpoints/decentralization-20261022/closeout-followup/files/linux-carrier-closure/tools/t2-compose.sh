#!/usr/bin/env bash
# t2 (queue 1024): the two fixed pre-existing tests (control on fec43a6a, then the carrier head), the A/B/ROOT composition's
# union proof, its bundle currency + the Linux image's bundle rebuild (tools/b2-bundles.sh), then the affected suites on the
# COMPOSED tree with those rebuilt bundles. Throwaway clones only; repo/ stays clean. Per-group exit codes recorded.
set -uo pipefail
. "$(dirname "$0")/env.sh"
set -e
R=$B/repo; C=$B/tmp/compose; D=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-wallet-unknown/candidate
OLD=fec43a6a08da2ac287fb3a5c42de89f096f4f678; HEADC=$(git -C "$R" rev-parse HEAD)
export PATH="$PATH:/home/steven/.foundry/bin"
need() { local what=$1; shift; if "$@"; then echo "[ok] $what"; else echo "[FAIL] $what"; exit 9; fi; }
need "repo clean" [ -z "$(git -C "$R" status --porcelain --untracked-files=all)" ]
need "compose tree clean" [ -z "$(git -C "$C" status --porcelain --untracked-files=no)" ]
mk() {   # mk DIR COMMIT: a throwaway clone at COMMIT with node_modules, the forge subset and a bare main-7752a423 GIT_DIR
  local X=$1 c=$2
  [ ! -e "$X" ] || { echo "$X exists"; exit 2; }
  git clone -q --local --no-hardlinks "$R" "$X"; git -C "$X" -c advice.detachedHead=false checkout -q "$c"
  for d in . network relay; do ln -s "$D/$d/node_modules" "$X/$d/node_modules"; done
  ( cd "$X" && for s in "contracts/EnclaveRegistry.sol contracts/PaymentRouter.sol contracts/PinnedSessionVaultFactory.sol" contracts/EnclaveDeployments.sol \
      "contracts/EnclaveAppCatalog.sol contracts/foundry/test/mocks/SessionMocks.sol contracts/foundry/test/EnclaveDeployments.multicallValue.t.sol" \
      "contracts/EnclaveAddressBook.sol contracts/EnclaveHostOwnership.sol"; do forge build --offline -j 1 $s >/dev/null; done )
}
M=$B/tmp/main7752-t2.git; rm -rf "$M"; git init -q --bare "$M"; echo "$R/.git/objects" > "$M/objects/info/alternates"
git --git-dir="$M" update-ref refs/heads/main 7752a4239b3bec2cf452491cd1b95164a8c2bdb8; git --git-dir="$M" symbolic-ref HEAD refs/heads/main
run() { local name=$1 dir=$2 sec=$3; shift 3; echo; echo "=== $name ($(git -C "$dir" rev-parse --short=9 HEAD))"; set +e
  ( cd "$dir" && timeout -k 10 "$sec" unshare --pid --fork --kill-child --mount-proc sh -c 'exec "$@"' sh "$@" ); local rc=$?
  set -e; echo "[t2] $name exit=$rc"; echo "$rc" > "$B/receipts/t2-$name.rc"; }
nt() { local name=$1 dir=$2 tms=$3 sec=$4; shift 4; run "$name" "$dir" "$sec" node --test --test-timeout="$tms" --test-concurrency=1 --test-reporter=spec "$@"; }

echo "== 1 the two pre-existing failures: CONTROL on fec43a6a, then the fix on the carrier head"
mk "$B/tmp/old" "$OLD"; mk "$B/tmp/new" "$HEADC"
GIT_DIR="$M" nt K1-control-fec-measured-control "$B/tmp/old" 240000 600 test/metal-measured-control.test.mjs
nt K2-control-fec-hosted-cold-start "$B/tmp/old" 300000 900 test/hosted-policy-cold-start.test.mjs
GIT_DIR="$M" nt K3-fixed-measured-control "$B/tmp/new" 240000 600 test/metal-measured-control.test.mjs
nt K4-fixed-hosted-cold-start "$B/tmp/new" 300000 900 test/hosted-policy-cold-start.test.mjs
rm -rf "$B/tmp/old" "$B/tmp/new"

echo; echo "== 2 the composition: exact union"
set +e; python3 -u "$B/tools/union-check.py" "$C" HEAD "$B/receipts/union-check.json"; echo "$?" > "$B/receipts/t2-U-union.rc"; set -e
echo "[t2] U-union exit=$(cat "$B/receipts/t2-U-union.rc")"

echo; echo "== 3 bundle currency + rebuild of the Linux image's bundles (in the compose tree, left uncommitted)"
set +e; bash "$B/tools/b2-bundles.sh"; echo "$?" > "$B/receipts/t2-B-bundles.rc"; set -e
echo "[t2] B-bundles exit=$(cat "$B/receipts/t2-B-bundles.rc")"
( cd "$C" && for s in "contracts/EnclaveRegistry.sol contracts/PaymentRouter.sol contracts/PinnedSessionVaultFactory.sol" contracts/EnclaveDeployments.sol \
    "contracts/EnclaveAppCatalog.sol contracts/foundry/test/mocks/SessionMocks.sol contracts/foundry/test/EnclaveDeployments.multicallValue.t.sol" \
    "contracts/EnclaveAddressBook.sol contracts/EnclaveHostOwnership.sol"; do forge build --offline -j 1 $s >/dev/null; done )

echo; echo "== 4 the composed tree's affected suites (rebuilt bundles in place)"
nt S1-carriers-gate "$C" 300000 900 test/relay-policy-carriers.test.mjs test/hosted-policy-cold-start.test.mjs test/host-admission-runtime.test.mjs
nt S2-A-B-root "$C" 240000 900 test/lease-reader-verifier.test.mjs test/lease-reader-verifier-deadline.test.mjs test/verified-chain.test.mjs \
  test/verified-chain-lifecycle.test.mjs test/caller-verifier-wiring.test.mjs test/witness-gateway.test.mjs test/op-head-relay.test.mjs
nt S3-guest-launcher "$C" 240000 900 test/metal-lease-gas-conduit.test.mjs test/owner-nomination-config.test.mjs test/metal-launcher-certs.test.mjs \
  test/metal-launcher-isolation.test.mjs
GIT_DIR="$M" nt S4-measured-control "$C" 240000 600 test/metal-measured-control.test.mjs
nt S5-supervisor "$C" 240000 900 test/tenant-provision-race.test.mjs test/adopt-pending-stop.test.mjs test/supervisor-wallet-unknown-hold.test.mjs \
  test/supervisor-wallet-policy.test.mjs test/pool-reconcile.test.mjs test/supervisor-wallet-real-lease-client.test.mjs
need "repo still clean" [ -z "$(git -C "$R" status --porcelain --untracked-files=all)" ]
echo; echo "=== summary"; for f in "$B"/receipts/t2-*.rc; do echo "$(basename "$f" .rc) $(cat "$f")"; done
n=$(grep -vc " -V stub-proof$" "$B/stub/invocations.log" || true);   # env.sh's own proof calls excluded
 need "no ssh/scp/sftp invocation ($n)" [ "$n" -eq 0 ]
echo T2-DONE
