#!/usr/bin/env bash
# ONE shared-queue admission (multiprocess lane): the local-relay migration candidate on tree/ (a copy of work/enclave with
# the ACTIVATED Windows closure files of stage/source overlaid, the candidate's new sources, and the activated bundle as a
# test-only *.old.mjs). Regenerates and verifies every generated artifact, derives the plan, rehearses it, runs the tests.
# Usage: run.sh LOG
set -u
W=$(cd "$(dirname "$0")" && pwd -P); export W
LOG=$(realpath -m -- "${1:?log}"); case "$LOG" in "$W"/logs/*) ;; *) echo "log must be under $W/logs"; exit 2;; esac
exec > "$LOG" 2>&1
cd "$W/tree"
fail=0
run() { echo "=== STEP $*"; "$@"; local e=$?; echo "=== EXIT $e: $*"; [ $e -ne 0 ] && fail=1; return 0; }
echo "tree = copy of work/enclave HEAD $(cat "$W/notes/main-head.txt") taken $(cat "$W/notes/main-copied-at.txt"); node $(node --version); $(anvil --version 2>/dev/null | head -1)"
# 0. overlay: the activated closure (all 80 files; 4 differ from main) and the candidate sources
(cd "$W/stage/source" && find . -type f | sed 's|^\./||' | sort) | while read -r f; do mkdir -p "$(dirname "$f")"; cp -- "$W/stage/source/$f" "$f"; done
(cd "$W/src" && find . -type f ! -name 'windows-node-lease-gas-runtime.bundle.old.mjs' | sed 's|^\./||' | sort) | while read -r f; do mkdir -p "$(dirname "$f")"; cp -- "$W/src/$f" "$f"; done
cp -- "$W/src/windows-node-lease-gas-runtime.bundle.old.mjs" windows/node/lease-gas-runtime.bundle.old.mjs
echo "overlay: $(cd "$W/stage/source" && find . -type f | wc -l) closure files, $(cd "$W/src" && find . -type f | wc -l) candidate files"
# 1. the Windows bundle, regenerated from the tree's sources, must be the staged one byte for byte; every input is the tree's
cp windows/node/lease-gas-runtime.bundle.mjs "$W/logs/staged-bundle.mjs"
run node scripts/build-windows-lease-runtime.mjs
run cmp windows/node/lease-gas-runtime.bundle.mjs "$W/stage/source/windows/node/lease-gas-runtime.bundle.mjs"
run cmp windows/node/lease-gas-runtime.bundle.mjs.manifest.json ../../enclave/windows/node/lease-gas-runtime.bundle.mjs.manifest.json
run node -e '
const fs=require("fs"),crypto=require("crypto");
const m=JSON.parse(fs.readFileSync("windows/node/lease-gas-runtime.bundle.mjs.manifest.json","utf8"));
const sha=(f)=>crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const bad=[];let n=0;
for(const [rel,h] of Object.entries(m.inputs)){n++;const f=rel.startsWith("node_modules/")?["windows/node/"+rel,rel].find(p=>fs.existsSync(p)):rel;if(!f||sha(f)!==h)bad.push(rel);}
if(sha("windows/node/lease-gas-runtime.bundle.mjs")!==m.sha256)bad.push("bundle sha");
console.log(JSON.stringify({bundle:m.sha256,bytes:m.bytes,inputs:n,mismatched:bad}));process.exit(bad.length?1:0);'
# 2. the deploy closure from the tree's own builder: the same 80 paths as the activated release, no problems
run node --input-type=module -e '
import { closure } from "./windows/node/deploy-files.mjs";
import fs from "node:fs";
const r = closure({ root: process.cwd() });
const want = JSON.parse(fs.readFileSync(process.env.W + "/notes/baseline-installed-closure.json", "utf8")).files.map((f) => f.path).sort();
const got = r.files.map((f) => (typeof f === "string" ? f : f.path)).sort();
fs.writeFileSync(process.env.W + "/logs/closure.json", JSON.stringify(r, null, 1) + "\n");
const same = JSON.stringify(got) === JSON.stringify(want);
console.log(JSON.stringify({ files: got.length, problems: r.problems, sameAsActivated: same }));
process.exit(r.problems.length || !same ? 1 : 0);'
# 3. the relay release and the migration gate: each built twice, byte-identical (reproducible), into the stage
rm -rf "$W/logs/build-relay-a" "$W/logs/build-relay-b" "$W/logs/build-gate-a" "$W/logs/build-gate-b"
run node scripts/build-lease-relay-release.mjs "$W/logs/build-relay-a"
run node scripts/build-lease-relay-release.mjs "$W/logs/build-relay-b" --expect-sha256 "$(node -p 'require(process.argv[1]).artifact.sha256' "$W/logs/build-relay-a/manifest.json")"
run diff -r "$W/logs/build-relay-a" "$W/logs/build-relay-b"
run node scripts/build-lease-relay-migration-check.mjs "$W/logs/build-gate-a"
run node scripts/build-lease-relay-migration-check.mjs "$W/logs/build-gate-b" --expect-sha256 "$(node -p 'require(process.argv[1]).artifact.sha256' "$W/logs/build-gate-a/lease-relay-migration-check.manifest.json")"
run diff -r "$W/logs/build-gate-a" "$W/logs/build-gate-b"
# 4. the plan, from the baseline installed hashes and the staged source, with main's own tool; then the rehearsal
run node windows/installer/activate-control-source.mjs plan --closure "$W/notes/baseline-installed-closure.json" --source "$W/stage/source" --id local-relay-20261021 --out "$W/logs/control-plan.json"
run cp "$W/logs/control-plan.json" "$W/stage/control-plan.json"
run bash -c 'cd "$W" && node rehearse.mjs'
# 5. the tests, sequential
TESTS="test/windows-local-relay-migration.test.mjs test/lease-host-relay.test.mjs test/windows-current-runtime.test.mjs test/windows-lease-closure.test.mjs test/lease-relay-release.test.mjs test/windows-host-app-funded.test.mjs"
[ "${2:-}" = "migration-only" ] && TESTS="test/windows-local-relay-migration.test.mjs"   # the other suites passed unchanged in an earlier run (its log)
run node --test --test-concurrency=1 --test-timeout=600000 $TESTS
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
