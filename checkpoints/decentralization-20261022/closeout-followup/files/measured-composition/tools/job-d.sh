#!/usr/bin/env bash
# job-d: ONE queued job at the root-authorized 1536 MiB cap. ONLY the two suites earlier guard-stopped at 512:
#   1. test/custody-browser.test.mjs "Chrome encrypts..." (job-c: 921 MiB)   2. test/mcp-hosted-control.test.mjs tests 4-7 (job-c3: 615+ MiB)
# on the unchanged final tree-c (tree 3031c20c). ssh/scp/sftp stubs FIRST in PATH (proved selected, also from node children);
# TMPDIR inside measured-composition; the Foundry output linked READ-ONLY (gitignored path) only for step 2 and removed by trap;
# the link target is fingerprinted before/after. New anvil/chrome processes of this job are listed (not killed broadly).
set -uo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/measured-composition; T=$M/tree-c; O=$M/out/d
FOUT=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/contracts/foundry/out; LINK=$T/contracts/foundry/out
mkdir -p "$O" "$M/tmp/d"; export TMPDIR=$M/tmp/d PATH="$M/sshstub/bin:$PATH"; rc=0
cleanup() { [ -L "$LINK" ] && rm "$LINK" && echo "[d] link removed (trap)"; }
trap cleanup EXIT; trap 'cleanup; exit 143' TERM INT
date -u +%FT%TZ | tee "$O/started.utc"
# identity + clean
[ "$(GIT_DIR=$T/.git GIT_OPTIONAL_LOCKS=0 git rev-parse HEAD^{tree})" = 3031c20c7d0083f05b36160c851e5872a72725c3 ] || { echo "tree-c is not 3031c20c"; exit 2; }
s=$(GIT_DIR=$T/.git GIT_WORK_TREE=$T GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all | grep -v node_modules/); [ -z "$s" ] || { echo "tree-c dirty: $s"; exit 2; }
[ ! -e "$LINK" ] && [ ! -L "$LINK" ] || { echo "a Foundry out is already present in tree-c"; exit 2; }
echo "[d] tree-c 2c36d388 / 3031c20c clean"
# ssh stub selection proof (shell lookup, a real invocation, and a node child's PATH lookup)
for c in ssh scp sftp; do w=$(command -v $c); echo "[d] $c -> $w"; [ "$w" = "$M/sshstub/bin/$c" ] || { echo "stub not selected for $c"; exit 2; }; done
ssh -V proof-shell 2>/dev/null; echo "[d] ssh exit $? (stub = 255)"
node -e 'const r=require("child_process").spawnSync("ssh",["-V","proof-node"]);console.log("[d] node-spawned ssh status",r.status,String(r.stderr).trim())'
: > "$M/sshstub/invocations.before"; cp "$M/sshstub/invocations.log" "$M/sshstub/invocations.before"; echo "[d] stub log lines before tests: $(wc -l < "$M/sshstub/invocations.log")"
pre=$(pgrep -x anvil | sort | tr '\n' ' '); prec=$(pgrep -f chrome-linux64/chrome | sort | tr '\n' ' ')
cd "$T"
# 1. custody Chrome test only (test 1 passed in job-c and job-c2)
node --test --test-concurrency=1 "--test-name-pattern=Chrome encrypts to the committee" test/custody-browser.test.mjs > "$O/t-custody-chrome.log" 2>&1; r=$?
echo "[d] t-custody-chrome: rc=$r $(grep -E '^# (tests|pass|fail|skipped|cancelled) ' "$O/t-custody-chrome.log" | tr '\n' ' ')"; [ $r -eq 0 ] || { rc=1; grep -E "^not ok|Error|SKIP" "$O/t-custody-chrome.log" | head -12; }
# 2. MCP end to end, tests 4-7 only, with the Foundry output linked read-only
find -L "$FOUT" -type f -printf '%P %s %T@\n' 2>/dev/null | sort | sha256sum | cut -c1-64 > "$O/foundry-out.before"
ln -s "$FOUT" "$LINK"
node --test --test-concurrency=1 "--test-name-pattern=a client connects only to the verified guest|through the attested front|the private client flow|the remote write path seals only" test/mcp-hosted-control.test.mjs > "$O/t-mcp-e2e.log" 2>&1; r=$?
cleanup
find -L "$FOUT" -type f -printf '%P %s %T@\n' 2>/dev/null | sort | sha256sum | cut -c1-64 > "$O/foundry-out.after"
cmp -s "$O/foundry-out.before" "$O/foundry-out.after" && echo "[d] Foundry out unchanged ($(cat "$O/foundry-out.after"))" || { echo "[d] FOUNDRY OUT CHANGED"; rc=1; }
echo "[d] t-mcp-e2e: rc=$r $(grep -E '^# (tests|pass|fail|skipped|cancelled) ' "$O/t-mcp-e2e.log" | tr '\n' ' ')"; [ $r -eq 0 ] || { rc=1; grep -E "^not ok|Error|# SKIP" "$O/t-mcp-e2e.log" | head -12; }
grep -E "# SKIP" "$O/t-mcp-e2e.log" "$O/t-custody-chrome.log" && { echo "[d] a target test was SKIPPED"; rc=1; }
# afterwards: stub never invoked by tests, no new anvil/chrome left, capture clean
n=$(( $(wc -l < "$M/sshstub/invocations.log") - $(wc -l < "$M/sshstub/invocations.before") )); echo "[d] ssh/scp/sftp stub invocations during tests: $n"; [ $n -eq 0 ] || rc=1
post=$(pgrep -x anvil | sort | tr '\n' ' '); postc=$(pgrep -f chrome-linux64/chrome | sort | tr '\n' ' ')
left=$(comm -13 <(echo $pre | tr ' ' '\n' | sort) <(echo $post | tr ' ' '\n' | sort) | tr '\n' ' '); leftc=$(comm -13 <(echo $prec | tr ' ' '\n' | sort) <(echo $postc | tr ' ' '\n' | sort) | tr '\n' ' ')
echo "[d] new anvil left: [${left}] new chrome left: [${leftc}]"
s=$(GIT_DIR=$T/.git GIT_WORK_TREE=$T GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all | grep -v node_modules/); [ -z "$s" ] && echo "[d] tree-c clean after" || { echo "[d] tree-c DIRTY: $s"; rc=1; }
date -u +%FT%TZ > "$O/finished.utc"; echo "JOB-D rc=$rc"; exit $rc
