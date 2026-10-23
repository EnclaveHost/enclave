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
mutant "sender skips the balance + reserve gate" driver/sender.mjs 'if (o.balance < pr.totalAtBlockWei + BigInt(budget.reserveWei)) refuse("balance", `balance' 'if (false) refuse("balance", `balance' test/sender.test.mjs
mutant "sender omits the operator fee" driver/sender.mjs 'const l2 = gas * maxFee, total = l2 + l1 + opFee;' 'const l2 = gas * maxFee, total = l2 + l1;' test/sender.test.mjs
mutant "sender broadcasts before the intent is durable" driver/sender.mjs '    writeIntent(rec, { create: true });                                                      // durable BEFORE any broadcast' '    setTimeout(() => writeIntent(rec, { create: true }), 0);' test/sender.test.mjs
mutant "sender sizes the L1 fee with nonce 0" driver/sender.mjs 'unsignedTx({ nonce, gas, maxFeePerGas: maxFee' 'unsignedTx({ nonce: 0, gas, maxFeePerGas: maxFee' test/sender.test.mjs
mutant "sender sizes the L1 fee unsigned only" driver/sender.mjs 'argument: Math.max(unsigned, signedMax - ORACLE_SIGNATURE_ALLOWANCE)' 'argument: unsigned - 2' test/sender.test.mjs
mutant "sender treats an undetermined operator fee as zero" driver/sender.mjs 'if (isthmus !== true) refuse("operator_fee"' 'if (false) refuse("operator_fee"' test/sender.test.mjs
mutant "budget forgets the cleanup reserve" driver/budget.mjs 'const owed = steps.filter((s) => s.spend?.cleanup' 'const owed = steps.filter((s) => false' test/sender.test.mjs
mutant "plan ignores the aggregate budget" driver/plan.mjs 'if (!budget.fits) for' 'if (false) for' test/plan.test.mjs
mutant "S0.root accepts a known-lacking control image" driver/cli.mjs '!KNOWN_LACKING_CONTROL_MANIFESTS.includes(rr.controlManifestSha256)' 'true' test/cli.test.mjs
mutant "CLI pins: book ledger not compared" driver/clipins.mjs 'for (const k of ["deployments", "registry"]) if (lc(facts.book?.[k]) !== pins[k])' 'for (const k of []) if (lc(facts.book?.[k]) !== pins[k])' test/clipins.test.mjs
mutant "CLI pins: retired ledger accepted" driver/clipins.mjs 'if (Object.values(pins).includes(RETIRED_LEDGER))' 'if (false)' test/clipins.test.mjs
mutant "CLI targets not checked" driver/clipins.mjs 'const bad = txs.filter((t) => !allowed.includes(lc(t.to)));' 'const bad = [];' test/clipins.test.mjs
mutant "relay getMeta leaks values" driver/relay.mjs 'const out = { status: r.status, error: r.body?.error ?? null, rev: r.body?.rev ?? null, names };' 'const out = { status: r.status, error: r.body?.error ?? null, rev: r.body?.rev ?? null, names, env };' test/net.test.mjs
echo "== MUTANTS rc=$rc"; exit $rc
