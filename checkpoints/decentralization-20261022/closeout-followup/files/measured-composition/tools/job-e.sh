#!/usr/bin/env bash
# job-e: ONE queued job at 1536 MiB: ONLY the custody Chrome test again. job-d failed it with "chrome did not start": its TMPDIR
# (measured-composition/tmp/d, 108 bytes) puts Chrome's singleton socket past the 107-byte unix socket limit. Here TMPDIR is
# a short directory this job creates under /tmp and removes. Same stub-first PATH and proofs as job-d.
set -uo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/measured-composition; T=$M/tree-c; O=$M/out/d
S=$(mktemp -d /tmp/mcd-XXXXXX); export TMPDIR=$S PATH="$M/sshstub/bin:$PATH"; rc=0
trap 'rm -rf "$S"' EXIT; trap 'rm -rf "$S"; exit 143' TERM INT
echo "[e] TMPDIR=$S ($(echo -n "$S" | wc -c) bytes)"
[ "$(GIT_DIR=$T/.git GIT_OPTIONAL_LOCKS=0 git rev-parse HEAD^{tree})" = 3031c20c7d0083f05b36160c851e5872a72725c3 ] || { echo "tree-c is not 3031c20c"; exit 2; }
s=$(GIT_DIR=$T/.git GIT_WORK_TREE=$T GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all | grep -v node_modules/); [ -z "$s" ] || { echo "tree-c dirty: $s"; exit 2; }
for c in ssh scp sftp; do w=$(command -v $c); echo "[e] $c -> $w"; [ "$w" = "$M/sshstub/bin/$c" ] || { echo "stub not selected for $c"; exit 2; }; done
node -e 'const r=require("child_process").spawnSync("ssh",["-V","proof-node-e"]);console.log("[e] node-spawned ssh status",r.status)'
b=$(wc -l < "$M/sshstub/invocations.log"); prec=$(pgrep -f chrome-linux64/chrome | sort | tr '\n' ' ')
cd "$T"
node --test --test-concurrency=1 "--test-name-pattern=Chrome encrypts to the committee" test/custody-browser.test.mjs > "$O/t-custody-chrome.log" 2>&1; r=$?
echo "[e] t-custody-chrome: rc=$r $(grep -E '^# (tests|pass|fail|skipped|cancelled) ' "$O/t-custody-chrome.log" | tr '\n' ' ')"; [ $r -eq 0 ] || { rc=1; grep -E "^not ok|error:|SKIP" "$O/t-custody-chrome.log" | head; }
grep -q "# SKIP" "$O/t-custody-chrome.log" && { echo "[e] SKIPPED"; rc=1; }
n=$(( $(wc -l < "$M/sshstub/invocations.log") - b )); echo "[e] stub invocations during the test: $n"; [ $n -eq 0 ] || rc=1
postc=$(pgrep -f chrome-linux64/chrome | sort | tr '\n' ' '); echo "[e] new chrome left: [$(comm -13 <(echo $prec | tr ' ' '\n' | sort) <(echo $postc | tr ' ' '\n' | sort) | tr '\n' ' ')]"
s=$(GIT_DIR=$T/.git GIT_WORK_TREE=$T GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all | grep -v node_modules/); [ -z "$s" ] && echo "[e] tree-c clean after" || { echo "[e] DIRTY $s"; rc=1; }
echo "JOB-E rc=$rc"; exit $rc
