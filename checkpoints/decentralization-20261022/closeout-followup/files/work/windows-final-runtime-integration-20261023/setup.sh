#!/usr/bin/env bash
# New isolated continuation from the IMMUTABLE windows-final-baseline (source 30339303 + evidence 1f19ad15; that tree is
# read only). Objects fetched read-only: TLS 1957ff23 (nucbox-tls-recovery candidate), M 9f19b7c6 (windows-memory-accounting
# repo), A 554a251c (rpc-priority repo), main 68b82926 (checkpoint main-repo). Writes only here.
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023
W=/home/steven/Documents/Codex/2026-10-18/wo/work
O=$W/resume-after-checkpoint-20261022/windows-final-baseline-compose/candidate
cd "$H"; [ ! -e candidate ]
git clone -q --local --no-hardlinks --no-checkout "$O" candidate
cd candidate; git remote remove origin
git checkout -q -b final/windows-runtime 1f19ad15aaa6200e1882d148f2b43b7c25fc7058
[ "$(git rev-parse HEAD~1)" = 30339303bedcb5cb9a6d8fe2e495f381f05d7c74 ]
f() { git fetch -q "$1" "$2"; git update-ref "$3" FETCH_HEAD; echo "$3 $(git rev-parse $3) tree $(git rev-parse $3^{tree})"; }
f "$W/nucbox-tls-recovery-20261023/candidate" 1957ff23425f6ee2e0abe2604bdc9735987eff47 refs/in/tls
f "$W/windows-memory-accounting-20261023/repo" 9f19b7c66c156dc3f1052ece121de89e4c741912 refs/in/mem
f "$W/resume-after-checkpoint-20261022/rpc-priority/repo" 554a251cbe14aa7ba8af4c160d9a8b9793e4071a refs/in/a
f "$W/source-checkpoint-20261022/main-repo" 68b82926968c99503d38ae78dbcb04694cc2c56c refs/in/main
echo "eeab54d2292a49341125f249a1124ff7bc2a042aa6bec90800c5af681491cb92  $W/windows-memory-accounting-20261023/windows-memory-accounting.patch" | sha256sum -c -
git config core.hooksPath .githooks
for d in node_modules network/node_modules relay/node_modules e2e/node_modules sdk/sessions/node_modules; do [ -d "$O/$d" ] && cp -a "$O/$d" "$d"; done
mkdir -p contracts/foundry; cp -a "$O/contracts/foundry/out" contracts/foundry/out
cp -a "$O/relay/network-runtime.bundle.mjs" relay/network-runtime.bundle.mjs 2>/dev/null || echo "no network-runtime bundle to copy"
git status --porcelain --untracked-files=no | wc -l
echo SETUP_OK
