#!/bin/bash
set -euo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
T=$P/rpc-final-candidate-20261026/tree
E=$P/rpc-final-candidate-20261026/environment-recheck-20261026T043424Z
O=$P/rpc-final-candidate-20261026/mcp-routes-$(date -u +%Y%m%dT%H%M%SZ)
ip link set lo up
mkdir -p "$O"
sha256sum "$T/test/mcp-hosted-control.test.mjs" > "$O/source.sha256"
r=0
(cd "$T" && PATH=/home/steven/.foundry/bin:/usr/bin:/bin HOME="$E/home" TMPDIR="$E/tmp" TEST_TMP="$E/tmp" FOUNDRY_OFFLINE=true timeout -k 10 600 node --test --test-reporter=tap --test-timeout=480000 test/mcp-hosted-control.test.mjs) > "$O/test.tap" 2>&1 || r=$?
echo "$r" > "$O/test.rc"
python3 - "$O" <<'PY'
import pathlib,re,json,sys
p=pathlib.Path(sys.argv[1]);s=(p/'test.tap').read_text(); c={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|skipped|todo|cancelled) (\d+)$',s,re.M)}
rc=int((p/'test.rc').read_text());ok=rc==0 and c=={'tests':7,'pass':7,'fail':0,'skipped':0,'todo':0,'cancelled':0}
x={'ok':ok,'rc':rc,'counts':c};(p/'verdict.json').write_text(json.dumps(x,indent=2)+'\n');print(json.dumps(x));print('outputs:',p);sys.exit(0 if ok else 1)
PY
