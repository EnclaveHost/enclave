#!/usr/bin/env bash
# t1 (queue 1024: anvil + the rig + forge subset builds, as C's carriers batch B / forge-subset jobs): tests of the carrier
# closure HEAD in a throwaway local clone (repo/ stays clean). node_modules: symlinks to the D candidate's installed trees
# (package.json/package-lock.json identical, checked). Groups run sequentially, each bounded; per-group exit codes recorded.
#   F  forge subset (the repo's foundry.toml, offline, -j 1): only the contracts the rig and the hosted-policy test load
#   G1 test/relay-policy-carriers.test.mjs (new: schema, env boundary, real launcher, supervisor gate on a real chain)
#   G2 affected existing suites: lease-gas conduit, owner nomination, measured control (GIT_DIR = main 7752a423, as designed),
#      host admission runtime, the hosted-policy cold-start chain test (carriers/ban/unban of the host-services stack)
#   G3 launcher suites (metal-launcher-certs, metal-launcher-isolation)
#   G4 adopt/race: tenant-provision-race (fixed harness), adopt-pending-stop, wallet hold/policy, pool-reconcile
#   C1 CONTROL: fec43a6a's tenant-provision-race.test.mjs against the same supervisor (expected: its adopt case fails)
set -uo pipefail
. "$(dirname "$0")/env.sh"
set -e
R=$B/repo; X=$B/tmp/tree; D=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-wallet-unknown/candidate
H=$(git -C "$R" rev-parse HEAD); OLD=fec43a6a08da2ac287fb3a5c42de89f096f4f678
export PATH="$PATH:/home/steven/.foundry/bin"
need() { local what=$1; shift; if "$@"; then echo "[ok] $what"; else echo "[FAIL] $what"; exit 9; fi; }
[ ! -e "$X" ] || { echo "$X exists"; exit 2; }
need "repo clean" [ -z "$(git -C "$R" status --porcelain --untracked-files=all)" ]
git clone -q --local --no-hardlinks "$R" "$X"
need "tree HEAD $H" [ "$(git -C "$X" rev-parse HEAD)" = "$H" ]
for p in package.json package-lock.json network/package.json network/package-lock.json relay/package.json relay/package-lock.json; do
  need "$p identical to the D candidate's" cmp -s "$X/$p" "$D/$p"
done
for d in . network relay; do ln -s "$D/$d/node_modules" "$X/$d/node_modules"; done
M=$B/tmp/main7752.git; git init -q --bare "$M"; echo "$X/.git/objects" > "$M/objects/info/alternates"
git --git-dir="$M" update-ref refs/heads/main 7752a4239b3bec2cf452491cd1b95164a8c2bdb8; git --git-dir="$M" symbolic-ref HEAD refs/heads/main
run() {   # run NAME SEC CMD...  -> rc in receipts/t1-NAME.rc
  local name=$1 sec=$2; shift 2; echo; echo "=== $name"; set +e
  ( cd "$X" && timeout -k 10 "$sec" unshare --pid --fork --kill-child --mount-proc sh -c 'exec "$@"' sh "$@" ); local rc=$?
  set -e; echo "[t1] $name exit=$rc"; echo "$rc" > "$B/receipts/t1-$name.rc"
}
nt() { local name=$1 tms=$2 sec=$3; shift 3; run "$name" "$sec" node --test --test-timeout="$tms" --test-concurrency=1 --test-reporter=spec "$@"; }
run F-forge-subset 1500 sh -c 'set -e; for s in "contracts/EnclaveRegistry.sol contracts/PaymentRouter.sol contracts/PinnedSessionVaultFactory.sol" contracts/EnclaveDeployments.sol "contracts/EnclaveAppCatalog.sol contracts/foundry/test/mocks/SessionMocks.sol contracts/foundry/test/EnclaveDeployments.multicallValue.t.sol" "contracts/EnclaveAddressBook.sol contracts/EnclaveHostOwnership.sol"; do echo "[forge] $s"; forge build --offline -j 1 $s; done; ls contracts/foundry/out | tr "\n" " "; echo'
nt G1-relay-carriers 300000 900 test/relay-policy-carriers.test.mjs
GIT_DIR="$M" nt G2a-measured-control 240000 600 test/metal-measured-control.test.mjs
nt G2b-affected 300000 1200 test/metal-lease-gas-conduit.test.mjs test/owner-nomination-config.test.mjs test/host-admission-runtime.test.mjs \
  test/hosted-policy-cold-start.test.mjs
nt G3-launchers 240000 900 test/metal-launcher-certs.test.mjs test/metal-launcher-isolation.test.mjs
nt G4-adopt-race 120000 600 test/tenant-provision-race.test.mjs test/adopt-pending-stop.test.mjs test/supervisor-wallet-unknown-hold.test.mjs \
  test/supervisor-wallet-policy.test.mjs test/pool-reconcile.test.mjs
git -C "$X" show "$OLD:test/tenant-provision-race.test.mjs" > "$X/test/tenant-provision-race-fec43a6a.test.mjs"
nt C1-control-old-harness 120000 300 test/tenant-provision-race-fec43a6a.test.mjs
rm -f "$X/test/tenant-provision-race-fec43a6a.test.mjs"
need "repo still clean" [ -z "$(git -C "$R" status --porcelain --untracked-files=all)" ]
echo; echo "=== summary"; for f in "$B"/receipts/t1-*.rc; do echo "$(basename "$f" .rc) $(cat "$f")"; done
n=$(grep -vc " -V stub-proof$" "$B/stub/invocations.log" || true);   # env.sh's own proof calls excluded
 need "no ssh/scp/sftp invocation ($n)" [ "$n" -eq 0 ]
echo T1-DONE
