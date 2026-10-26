#!/bin/bash
set -euo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
R=$P/logs/root-canonical-final-inputs-20261026T044638Z
F=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-runtime-final-integration
O=$P/logs/root-consumer-genesis-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$O/tmp"
ip link set lo up
cd "$R/repo"
echo '99138899e98faa27cdd28c21423d3ae55c36c36b50eb1334c102a1ab937ee319  test/fixtures/reth-dev-8453-genesis-2935.json' | sha256sum -c
python3 -I test/fixtures/derive-reth-genesis-2935.py test/fixtures/reth-dev-8453-genesis.json "$O/derived-genesis.json"
cmp "$O/derived-genesis.json" test/fixtures/reth-dev-8453-genesis-2935.json
(cd "$R/runtime-bin" && sha256sum -c "$R/RUNTIME-BIN.sha256")
sha256sum test/chain-consumer-closure.e2e.test.mjs test/fixtures/reth-dev-8453-genesis-2935.json > "$O/inputs.sha256"
export PATH=/home/steven/.foundry/bin:/usr/bin:/bin RIG_CHAIN_NODE=reth RIG_RETH_BIN=$F/bin/reth-v2.8.0 RIG_RETH_GENESIS=$R/repo/test/fixtures/reth-dev-8453-genesis-2935.json RIG_RETH_BLOCK_TIME=2s HELIOS_BASE_BIN=$R/runtime-bin/helios-eeffcc9 WITNESS_CHECK_BIN=$R/runtime-bin/witness-check RUNTIME_BIN_DIR=$R/runtime-bin TEST_TMP=$O/tmp TMPDIR=$O/tmp
rc=0
timeout -k 10 1800 node --test --test-reporter=tap --test-concurrency=1 --test-timeout=900000 test/chain-consumer-closure.e2e.test.mjs > "$O/test.tap" 2>&1 || rc=$?
echo "$rc" > "$O/test.rc"
python3 - "$O" <<'PY'
import pathlib,re,json,sys
p=pathlib.Path(sys.argv[1]);s=(p/'test.tap').read_text();c={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$',s,re.M)}
rc=int((p/'test.rc').read_text());ok=rc==0 and c=={'tests':7,'pass':7,'fail':0,'cancelled':0,'skipped':0,'todo':0};r={'ok':ok,'rc':rc,'counts':c};(p/'result.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r));print(p);sys.exit(0 if ok else 1)
PY
