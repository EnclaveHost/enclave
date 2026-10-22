#!/usr/bin/env bash
# Mutation checks: each mutant removes ONE guarantee; the named test must FAIL on it. Jobs go through the shared queue.
here="$(cd "$(dirname "$0")" && pwd)"; S="$here/logs/mutants-summary.txt"; only="${1:-.}"
ln -sfn ../enclave "$here/enclave"; trap 'rm -f "$here/enclave"; rm -rf "$here/mutant"' EXIT   # the mutant tree is one level deeper
run() { # name file old new mib testfile pattern
  [[ "$1" =~ $only ]] || return 0
  rm -rf "$here/mutant"; mkdir "$here/mutant"
  (cd "$here" && cp -a *.mjs *.js stage.html base test "$here/mutant/")
  python3 - "$here/mutant/$2" "$3" "$4" <<'PY'
import sys; p, a, b = sys.argv[1:4]; s = open(p).read(); assert s.count(a) == 1, ("anchor", a[:60]); open(p, "w").write(s.replace(a, b))
PY
  (cd "$here/mutant" && "$here/q.sh" "$5" "mutant-$1" node --test --test-concurrency=1 --test-name-pattern="$7" "$6" >/dev/null 2>&1); rc=$?
  local fails; fails=$(grep -c "^not ok" "$here/logs/mutant-$1.log")
  echo "MUTANT $1: exit=$rc failing-tests=$fails $([ $rc -eq 98 ] && echo NOT-STARTED || { [ $rc -ne 0 ] && [ "$fails" -gt 0 ] && echo KILLED || echo SURVIVED; })" | tee -a "$S"
}
run no-reserve-verification stages.mjs "const verified = await verifyReserve({ request: reserveRequest, hash: reserveHash, clients });   // root's own verifier" \
  "const verified = { address: reserveRequest.predictedAddress, transactionHash: reserveHash, runtimeHash: reserveRequest.expectedRuntimeHash, creationBlock: '0', owner: trust.admin, ledger: trust.ledger, registry: trust.registry, oracle: trust.oracle, executor: ZERO };" \
  768 test/anvil.test.mjs "^(step 1|a reserve that was never deployed)"
run no-pending-check stages.mjs 'for (const x of s) assert.equal(x.pending, x.nonce,' 'for (const x of []) assert.equal(x.pending, x.nonce,' 768 test/anvil.test.mjs "^(step 1|receipt depth)"
run no-authority-check stages.mjs 'eq(bookOwner, admin, "the address book' 'void (bookOwner, admin, "the address book' 768 test/anvil.test.mjs "^(step 1|receipt depth)"
run no-duplicate-scan stages.mjs 'if (codes.some((x) => x && lc(x) === lc(want)))' 'if (false)' 768 test/anvil.test.mjs "^(step 1|never a second executor)"
run no-accept-hook stage-app.mjs 'const accept = async (hash) => { if (others().includes(lc(hash)))' 'const accept = async (hash) => { if (false)' 768 test/anvil.test.mjs "^(step 1|stage servers)"
run no-stage-order stage-app.mjs 'if (journals.bind.read().status !== "ready") throw' 'if (false) throw' 768 test/anvil.test.mjs "^(step 1|stage servers)"
run no-exact-runtime stages.mjs 'assert.equal(lc(code), lc(request.expectedRuntime), "the deployed runtime is not the expected runtime");' '' 512 test/unit.test.mjs "wrong immutable runtime"
run no-canonical-check stages.mjs 'eq((await c.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash, "the receipt is not canonical");' '' 512 test/unit.test.mjs "reorged receipt"
run no-bound-event-check stages.mjs 'assert.equal(events.length, 1, "expected exactly one ExecutorBound event");' '' 512 test/unit.test.mjs "the binding landing"
rm -rf "$here/mutant"
