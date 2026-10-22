#!/usr/bin/env bash
# Mutation controls (queue 256): each mutant copies batch-plan.mjs + the test into mut-<name>/ (one change); its tests MUST fail.
set -uo pipefail
cd "$(dirname "$0")"; rc=0; mkdir -p tmp; export TMPDIR="$PWD/tmp"
run() { local name="$1" from="$2" to="$3" M="mut-$1"
  rm -rf "$M"; mkdir -p "$M/test"; cp batch-plan.mjs manifest.json "$M/"; cp test/batch-plan.test.mjs "$M/test/"
  python3 - "$M/batch-plan.mjs" "$from" "$to" <<'PY'
import sys; p,a,b=sys.argv[1:]; s=open(p).read(); assert s.count(a)==1,(a); open(p,'w').write(s.replace(a,b))
PY
  if BATCH_PLAN_DIR="$PWD/$M" ENCLAVE_WORK="$(cd .. && pwd)" node --test --test-concurrency=1 "$M/test/batch-plan.test.mjs" > "logs/mutant-$name.out" 2>&1; then echo "MUTANT $name SURVIVED"; rc=1; else echo "mutant $name killed"; fi
  rm -rf "$M"; }
run receipt-trusted '      const p = await receiptProblem(chain, prior.rec, facts);' '      const p = null;'
run no-duplicate-guard '    if (prior.state === "foreign") return blocked(' '    if (false) return blocked('
# control: the UNMUTATED copy must pass in the same harness, or a kill proves nothing
M=mut-control; rm -rf "$M"; mkdir -p "$M/test"; cp batch-plan.mjs manifest.json "$M/"; cp test/batch-plan.test.mjs "$M/test/"
if BATCH_PLAN_DIR="$PWD/$M" ENCLAVE_WORK="$(cd .. && pwd)" node --test --test-concurrency=1 "$M/test/batch-plan.test.mjs" > logs/mutant-control.out 2>&1; then echo "control passes"; else echo "CONTROL FAILED"; rc=1; fi
rm -rf "$M"
rmdir tmp 2>/dev/null || true; echo "mutants rc=$rc"; exit $rc
