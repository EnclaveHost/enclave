#!/usr/bin/env bash
# J5: test/windows-verifier.e2e.test.mjs on the COMMITTED head (A's e32dd607b test rig at its final 554a251c) through the canonical reth --dev chain and A's patched Helios
# (both A's existing binaries, hash-checked), in a scratch worktree overlaid with A's e32dd607b TEST rig only:
# test/helpers/cli-independent-rig.mjs (reth opt-in), network/witness-gateway.mjs, network/op-head-relay.mjs,
# test/fixtures/op-commitment.mjs. The overlay is never committed. Offline: job.sh's private loopback-only namespace.
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023
A=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority
BIN=$A/helios-target-base/debug/helios RETH=$A/vendor-inspect/reth-v2.8.0/bin/reth GEN=$A/fixture-tools/reth-dev-8453-genesis.json
echo "cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0  $BIN" | sha256sum -c -
echo "8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250  $RETH" | sha256sum -c -
sha256sum "$GEN"
cd "$H/candidate"; HEAD=$(git rev-parse HEAD); [ -z "$(git status --porcelain --untracked-files=no)" ]
O="$H/e2e-overlay"; git worktree remove --force "$O" 2>/dev/null || true; rm -rf "$O"
git worktree add -q --detach "$O" "$HEAD"
for d in . relay network sdk/sessions e2e; do [ -d "$d/node_modules" ] && ln -s "$H/candidate/$d/node_modules" "$O/$d/node_modules"; done
rm -rf "$O/contracts/foundry/out"; ln -s "$H/candidate/contracts/foundry/out" "$O/contracts/foundry/out"
E=554a251cbe14aa7ba8af4c160d9a8b9793e4071a
for f in test/helpers/cli-independent-rig.mjs network/witness-gateway.mjs network/op-head-relay.mjs test/fixtures/op-commitment.mjs; do
  mkdir -p "$O/$(dirname $f)"; git show "$E:$f" > "$O/$f"; echo "overlay $f $(git rev-parse $E:$f)"; done
git -C "$O" status --short
cd "$H"; RIG_CHAIN_NODE=reth RIG_RETH_BIN="$RETH" RIG_RETH_GENESIS="$GEN" RIG_RETH_BLOCK_TIME=2s HELIOS_BASE_BIN="$BIN" TEST_TMP="$H/tmp/t" \
  ./run-suite.py j4-e2e --tree "$O" --job-sec 1800 --test-ms 1500000 -- test/windows-verifier.e2e.test.mjs && rc=0 || rc=$?
git -C "$H/candidate" worktree remove --force "$O"; echo "[j5] rc=$rc"; exit $rc
