#!/usr/bin/env bash
# job-c: ONE queued job (512 MiB). tree-c = tree-b + the closeout layer. (1) tools/run-tree-c.py: rebuild in dependency order,
# --check, pins (everything but mcp-server/custody must equal tree-b), capture, affected light suites; (2) bash-only (no
# Python resident): the Dockerfile closure suite, the custody browser suite (Chrome), the old-bundle control probe, the
# MCP end-to-end suite LAST (largest), the capture must still be clean; (3) the input manifest over the read-only base.
set -uo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/measured-composition; T=$M/tree-c; O=$M/out/c; rc=0
date -u +%FT%TZ > "$M/rawlogs/job-c.started.utc"
python3 -u "$M/tools/run-tree-c.py" "$T" c || rc=1
cd "$T"
suite() { local n=$1; shift; node --test --test-concurrency=1 "$@" > "$O/$n.log" 2>&1; local r=$?; echo "[c] $n: rc=$r"
  grep -E "^# (tests|pass|fail|skipped|cancelled) " "$O/$n.log" | tr '\n' ' '; echo; [ $r -eq 0 ] || { rc=1; grep -E "^not ok|image omits|Error" "$O/$n.log" | head -12; }; }
suite t-supervisor-image-closure test/supervisor-image-closure.test.mjs
node "$M/tools/dockerfile-closure.mjs" "$T" | tee "$O/dockerfile-closure.json"
suite t-custody-browser test/custody-browser.test.mjs
# CONTROL: tree-b's MCP bundle (entry mcp/server.mjs, no guard) laid out the same way: argv[1] stays the bundle path, so the
# bundled host-identity / independent-capacity main-checks would match it when a capacity or quorum tool loads them
for t in b c; do D=$(mktemp -d "$M/probe-$t-XXXX"); mkdir -p "$D/opt/metal"; cp "$M/tree-$t/metal/guest/mcp-server.bundle.mjs" "$D/opt/metal/"
  printf 'process.on("exit", () => process.stderr.write("ARGV1=" + process.argv[1] + "\\n"));\n' > "$D/probe.mjs"
  node --import "file://$D/probe.mjs" "$D/opt/metal/mcp-server.bundle.mjs" --config "$D/absent.json" --remote --listen 127.0.0.1:0 > "$O/probe-$t.log" 2>&1; echo "[probe tree-$t] exit=$? $(grep -o 'ARGV1=.*' "$O/probe-$t.log" | sed "s#$D#<root>#")"; rm -rf "$D"; done
suite t-mcp-hosted-control test/mcp-hosted-control.test.mjs
s=$(GIT_DIR="$T/.git" GIT_WORK_TREE="$T" GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all | grep -v "node_modules/" | grep -v " relay/network-runtime.bundle.mjs" | head -5)
[ -z "$s" ] && echo "[c] clean-after-bash-suites: OK" || { echo "[c] clean-after-bash-suites: FAIL $s"; rc=1; }
python3 -u "$M/tools/input-manifest-c.py" "$T" "$O/INPUT-MANIFEST.json" || rc=1
date -u +%FT%TZ > "$M/rawlogs/job-c.finished.utc"
echo "JOB-C rc=$rc"; exit $rc
