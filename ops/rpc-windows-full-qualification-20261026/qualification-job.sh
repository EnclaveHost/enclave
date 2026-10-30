#!/bin/bash
# consumer-final-readiness-stage: ONE full windows-verifier.e2e (all 6) at EXACT candidate HEAD 64156dcd, offline.
# Inputs: root's verified 10cdf913b repo copy (node_modules + forge out + closures checked by root's 0452 job), every tracked
# file then replaced by `git archive 64156dcd9` and compared byte-for-byte (tar -d); root's pinned runtime-bin; the 2935 genesis.
# Run: bash jobs/q-exit-status.sh claude-consumer-head-windows-e2e 1024 unshare -Urn bash consumer-final-readiness-stage/jobs/head-windows-verifier-e2e.sh
set -euo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
T=$P/rpc-final-candidate-20261026/tree
R=$P/logs/root-canonical-final-inputs-20261026T044638Z
F=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-runtime-final-integration
HEAD=64156dcd91ff1e769e74f9c26a846be19254c716
O=$P/consumer-final-readiness-stage/runs/head-windows-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$O/tmp"
ip link set lo up
if ip -4 route | grep -q .; then echo "[fail] IPv4 route present: not offline"; exit 2; fi
[ "$(git -C "$T" rev-parse HEAD)" = "$HEAD" ] || { echo "[fail] candidate HEAD moved"; exit 2; }
cp -a --reflink=auto "$R/repo" "$O/repo"
git -C "$T" archive "$HEAD" | tar -x -C "$O/repo"
git -C "$T" archive "$HEAD" | tar -d -C "$O/repo" > "$O/tar-compare.txt" 2>&1 || { cat "$O/tar-compare.txt"; echo "[fail] copy != $HEAD"; exit 2; }
echo "[ok] every tracked file == $HEAD"
git -C "$T" diff --name-only 10cdf913b9b8bb168156e42da2a9a2a26c2526ad "$HEAD" > "$O/changed-since-10cdf.txt"
cd "$O/repo"
echo '99138899e98faa27cdd28c21423d3ae55c36c36b50eb1334c102a1ab937ee319  test/fixtures/reth-dev-8453-genesis-2935.json' | sha256sum -c
python3 -I test/fixtures/derive-reth-genesis-2935.py test/fixtures/reth-dev-8453-genesis.json "$O/derived-genesis.json"
cmp "$O/derived-genesis.json" test/fixtures/reth-dev-8453-genesis-2935.json
(cd "$R/runtime-bin" && sha256sum -c "$R/RUNTIME-BIN.sha256")
grep -q '^8cdd1f35e00558a4' <(sha256sum "$F/bin/reth-v2.8.0") || { echo "[fail] reth pin"; exit 2; }
sha256sum test/windows-verifier.e2e.test.mjs test/helpers/windows-chain-driver.mjs test/chain-consumer-closure.e2e.test.mjs supervisor.js test/fixtures/reth-dev-8453-genesis-2935.json > "$O/inputs.sha256"
export PATH=/home/steven/.foundry/bin:/usr/bin:/bin RIG_CHAIN_NODE=reth RIG_RETH_BIN=$F/bin/reth-v2.8.0 RIG_RETH_GENESIS=$O/repo/test/fixtures/reth-dev-8453-genesis-2935.json RIG_RETH_BLOCK_TIME=2s HELIOS_BASE_BIN=$R/runtime-bin/helios-eeffcc9 WITNESS_CHECK_BIN=$R/runtime-bin/witness-check RUNTIME_BIN_DIR=$R/runtime-bin TEST_TMP=$O/tmp TMPDIR=$O/tmp
rc=0
timeout -k 10 1800 node --test --test-reporter=tap --test-concurrency=1 --test-timeout=900000 test/windows-verifier.e2e.test.mjs > "$O/test.tap" 2>&1 || rc=$?
echo "$rc" > "$O/test.rc"
rm -rf "$O/repo"   # 195 MB copy; the tar compare + inputs.sha256 are the evidence
python3 - "$O" <<'PY'
import pathlib,re,json,sys
p=pathlib.Path(sys.argv[1]);s=(p/'test.tap').read_text();c={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$',s,re.M)}
rc=int((p/'test.rc').read_text());ok=rc==0 and c=={'tests':6,'pass':6,'fail':0,'cancelled':0,'skipped':0,'todo':0}
r={'ok':ok,'rc':rc,'counts':c,'head':'64156dcd91ff1e769e74f9c26a846be19254c716','scope':'full windows-verifier.e2e, no name filter; skips are not passes'}
(p/'result.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r));print(p);sys.exit(0 if ok else 1)
PY
