#!/bin/bash
# ONE queued job (<=512 MiB): syntax, unit tests, secret scans. Wall-clock bounded inside; no network, chain, keys, VMs.
set -u
cd "$(dirname "$0")/.."
rc=0
step() { local name=$1; shift; echo "== $name"; "$@"; local c=$?; [ $c = 0 ] || { echo "!! FAIL $name ($c)"; rc=1; }; }
for f in driver/*.mjs test/*.mjs; do step "node --check $f" timeout -k 5 30 node --check "$f"; done
step "bash -n" bash -n test/run-tests.sh test/mutants.sh
step "pinned update selector + example plan budget" timeout -k 5 30 node --input-type=module -e '
import { loadClient } from "./driver/prepare.mjs"; import { buildPlan } from "./driver/plan.mjs"; import fs from "node:fs";
const c = await loadClient("/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/repo-r2");
const u = c.owner.UPDATE_V2_ABI.find((f) => f.name === "update");
console.log("update selector", c.viem.toFunctionSelector(u), "update(bytes32,(" + u.inputs[1].components.map((x) => x.type).join(",") + "))");
const p = JSON.parse(fs.readFileSync("pins.example.json", "utf8"));
console.log("example budget", JSON.stringify(buildPlan(p).budget));'
step "unit tests" timeout -k 5 300 node --test --test-force-exit --test-concurrency=1 --test-timeout=60000 test/*.test.mjs
step "mutation controls" timeout -k 5 300 bash test/mutants.sh
if [ "${SCANS:-1}" = 1 ]; then
  step "gitleaks (working tree)" timeout -k 5 120 gitleaks dir . --no-banner --redact --exit-code 1 --report-format json --report-path logs/gitleaks-$$.json
  step "crypto-key scan (staged)" timeout -k 5 120 python3 ../custody-v2-durability-20261023/repo/.githooks/scan-crypto-keys.py --staged
fi
echo "== RESULT rc=$rc"
exit $rc
