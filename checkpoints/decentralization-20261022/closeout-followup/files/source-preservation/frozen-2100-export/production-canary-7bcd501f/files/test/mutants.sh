#!/bin/bash
# Mutation controls (run inside ONE queued job): each mutant disables one guard in a temp copy; the suite must FAIL.
set -u
here=$(cd "$(dirname "$0")/.." && pwd); rc=0
mutant() { local name=$1 file=$2 from=$3 to=$4 tests=$5
  local t; t=$(mktemp -d); cp -r "$here/driver" "$here/test" "$here/pins.example.json" "$t/"
  python3 - "$t/$file" "$from" "$to" <<'PY' || { echo "!! $name: pattern not found"; rc=1; return; }
import sys; p, a, b = sys.argv[1:]; s = open(p).read()
if s.count(a) != 1: sys.exit(1)
open(p, "w").write(s.replace(a, b))
PY
  if (cd "$t" && timeout -k 5 120 node --test --test-force-exit --test-concurrency=1 $tests >/dev/null 2>&1); then echo "!! MUTANT SURVIVED: $name"; rc=1; else echo "killed: $name"; fi
  rm -rf "$t"; }
mutant "tx accepts another deployment id" driver/tx.mjs 'if (!m.ids.map(lc).includes(id))' 'if (false)' test/core.test.mjs
mutant "release accepts SYNTHETIC roots" driver/assert.mjs 'if (oks.some((m) => m[6]))' 'if (false)' test/assert.test.mjs
mutant "plan forgets which policy is protected" driver/plan.mjs 'export const PROTECTED_POLICY_4E62 = "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e";' 'export const PROTECTED_POLICY_4E62 = "0x' "$(printf '%064d' 0)"'";' test/plan.test.mjs
mutant "rollback reported as pass" driver/assert.mjs 'return { outcome: "expected-fail"' 'return { outcome: "pass"' test/assert.test.mjs
mutant "tx skips the balance gate" driver/tx.mjs 'if (balance < costCap)' 'if (false)' test/core.test.mjs
mutant "relay getMeta leaks values" driver/relay.mjs 'const out = { status: r.status, error: r.body?.error ?? null, rev: r.body?.rev ?? null, names };' 'const out = { status: r.status, error: r.body?.error ?? null, rev: r.body?.rev ?? null, names, env };' test/net.test.mjs
echo "== MUTANTS rc=$rc"; exit $rc
