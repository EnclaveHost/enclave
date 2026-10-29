# Concrete extraction and next bounded build proposal

The authorized source-only extraction is now in candidate/deploy/EnclaveDeployments.sol.
Exact diff against the last measured 25,302-byte candidate is preserved in
accounting-extraction-draft/extraction.diff. No compile or tests have run.

One additional ordering detail was caught during review: the old funding path
loads feeRouter and payout AFTER transferring the publisher cut. Passing their
values into the library earlier would change behavior if an authorized recipient
reentered an administrator setter. The draft instead calls the ledger's own
read-only feeRouter()/payout() getters at the original points. These are fixed
self calls to exact ledger bytecode, not new external admission authorities;
the payout getter is read only when router is zero. This preserves the ordering
of observable state reads and transfers. It adds calls/gas, to measure honestly.

New concrete source modules:
- candidate/scripts/build-lifecycle-linked-artifacts.mjs: pinned offline compiler,
  ledger/library/controller/identity/prover source closure; fresh exclusive output;
  raw compiler input/output retained even on size failure; source-only templates,
  storage layouts, link slots, immutable slots, Solidity library self-address.
- candidate/network/lifecycle-linked-artifacts.mjs: exact nonoverlapping compiler
  link slots, immutable/self binding, deployed code hash on ledger AND library,
  same snapshot block, bound ledger/controller/prover/registry/identity pair;
  authenticated snapshot evidence required by read-only wrapper. No sends.
- candidate/test-js/lifecycle-linked-artifacts.test.mjs:15 authored mock tests,
  including missing/wrong library bytecode, changed address, template hash misuse,
  overlap/bounds, missing links, wrong pair, registry code, unauthenticated reads.
- candidate/test/AccountingConservation.t.sol:4 additional pre-extraction financial
  regressions (fee/runner/platform conservation, rounding, rollback, delegate refund).

This profile module is a REQUIRED integration dependency, not yet wired into the
production adapter or old schema2 migration preflight. Both remain unqualified for
this new code until the coordinator integrates the reviewed code-pin path. Code
verification does not settle independent-profile ownership/economic consent.
No runtime record is a production pin until actually linked/deployed and checked.

Next proposed run: library_size_validation.py --size-only, main512 / inner450,
oneCPU / noSwap / floor27648, whole child timeout300s. One compile only, no tests,
no retry/cap increase, no network. Fresh exclusive library-size-feedback with
fresh compiler output, source hashes unchanged check. Capture template sizes and
link references; no unresolved template can be called linked success. This job
uses the existing viem dependency through a read-only node_modules symlink, no
package install. Compiler/API settings unchanged. No size override.
