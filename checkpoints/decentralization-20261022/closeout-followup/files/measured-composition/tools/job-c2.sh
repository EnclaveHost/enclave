#!/usr/bin/env bash
# job-c2: ONE queued job (512 MiB), bash only. The rest of job-c after the guard stopped the Chrome custody test (921 MiB):
# custody fresh-build equality only (the Chrome test needs a larger cap: root's decision), the old/new MCP probe, the input
# manifest, the MCP suite's static tests, then the full MCP suite LAST (largest), and the clean-capture check.
set -uo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/measured-composition; T=$M/tree-c; O=$M/out/c; rc=0
suite() { local n=$1; shift; node --test --test-concurrency=1 "$@" > "$O/$n.log" 2>&1; local r=$?; echo "[c] $n: rc=$r"
  grep -E "^# (tests|pass|fail|skipped|cancelled) " "$O/$n.log" | tr '\n' ' '; echo; [ $r -eq 0 ] || { rc=1; grep -E "^not ok|Error" "$O/$n.log" | head -12; }; }
cd "$T"
suite t-custody-vendor-fresh-build "--test-name-pattern=is exactly a fresh build of custody/browser.mjs" test/custody-browser.test.mjs
for t in b c; do D=$(mktemp -d "$M/probe-$t-XXXX"); mkdir -p "$D/opt/metal"; cp "$M/tree-$t/metal/guest/mcp-server.bundle.mjs" "$D/opt/metal/"
  printf 'process.on("exit", () => process.stderr.write("ARGV1=" + process.argv[1] + "\\n"));\n' > "$D/probe.mjs"
  node --import "file://$D/probe.mjs" "$D/opt/metal/mcp-server.bundle.mjs" --config "$D/absent.json" --remote --listen 127.0.0.1:0 > "$O/probe-$t.log" 2>&1; e=$?
  echo "[probe tree-$t] exit=$e $(sed "s#$D#<root>#g" "$O/probe-$t.log" | tr '\n' ' ')"; rm -rf "$D"; done
python3 -u "$M/tools/input-manifest-c.py" "$T" "$O/INPUT-MANIFEST.json" > "$O/input-manifest.log" 2>&1 || { rc=1; tail -5 "$O/input-manifest.log"; }; head -c 1500 "$O/input-manifest.log"; echo
suite t-mcp-hosted-control-static "--test-name-pattern=optional, strict and canonical|planDirectBoot derives the adapter|gsup starts the adapter only" test/mcp-hosted-control.test.mjs
s=$(GIT_DIR="$T/.git" GIT_WORK_TREE="$T" GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all | grep -v "node_modules/" | grep -v " relay/network-runtime.bundle.mjs" | head -5)
[ -z "$s" ] && echo "[c] clean-before-e2e: OK" || { echo "[c] clean-before-e2e: FAIL $s"; rc=1; }
echo "[c] STATIC-PHASE rc=$rc"
suite t-mcp-hosted-control-full test/mcp-hosted-control.test.mjs
echo "JOB-C2 rc=$rc"; exit $rc
