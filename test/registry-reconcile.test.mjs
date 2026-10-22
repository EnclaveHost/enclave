// ONE registration rule for both host platforms (network/registry-reconcile.mjs; docs/network/host-liveness.md):
//   - the decision table: initial registration in any phase; a deregistered row re-registered only by a deliberate act
//     (boot, explicit), never by a routine timer; corrections only on an active row this operator holds; another
//     operator's row never written;
//   - the Linux supervisor and the Windows node load the SAME module (no copy to drift), the measured image ships it and
//     the Windows deploy closure includes it.
// The behaviour on a real chain is test/offchain-heartbeat-writers.test.mjs (both platforms).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registrationAction, mayReconcile, PHASES } from "../network/registry-reconcile.mjs";
import { closure } from "../windows/node/deploy-files.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OP = "0x" + "aa".repeat(20), OTHER = "0x" + "bb".repeat(20), KEY = "0x" + "cc".repeat(20), Z = "0x" + "00".repeat(20);
const row = (o = {}) => ({ operator: OP, active: true, cpuPricePerSec6: 1000n, proofKey: KEY, ...o });

test("the decision table: a timer never undoes a deregistration; deliberate acts may; corrections only on an active own row", () => {
  const want = { operator: OP, proofKey: KEY };
  for (const phase of PHASES) {
    assert.equal(registrationAction(null, want, phase).register, true, `${phase}: the initial registration`);
    assert.equal(registrationAction(row({ operator: Z, active: false }), want, phase).register, true, `${phase}: an unregistered id reads as the zero operator`);
    assert.equal(registrationAction(row({ operator: OTHER }), want, phase).register, false, `${phase}: another operator's row is never written`);
    assert.equal(registrationAction(row(), want, phase).register, false, `${phase}: a current row needs nothing`);
    assert.equal(registrationAction(row({ cpuPricePerSec6: 0n }), want, phase).register, true, `${phase}: an unpriced own row is completed`);
    assert.equal(registrationAction(row({ proofKey: Z }), want, phase).register, true, `${phase}: a stale proof key is corrected`);
  }
  assert.deepEqual(registrationAction(row({ active: false }), want, "timer"),
    { register: false, reason: "deregistered on chain by the operator key: a routine pass does not re-activate it" });
  assert.equal(registrationAction(row({ active: false }), want, "boot").register, true, "a box starting again re-registers (as the Linux boot does)");
  assert.equal(registrationAction(row({ active: false }), want, "explicit").register, true, "a registry migration or an owner's re-enable");
  assert.throws(() => registrationAction(row(), want, "heartbeat"), /unknown registration phase/);
  assert.equal(mayReconcile(row(), OP), true);
  assert.equal(mayReconcile(row({ active: false }), OP), false, "a deregistered row is not re-priced or re-keyed");
  assert.equal(mayReconcile(row({ operator: OTHER }), OP), false);
  assert.equal(mayReconcile(row({ operator: Z }), OP), false);
  assert.equal(mayReconcile(null, OP), false);
  assert.equal(mayReconcile({ cpuPricePerSec6: 12n }, OP), true, "a partial in-memory row is not mistaken for an inactive one");
});

test("both platforms load the same rule; the supervisor image and the Windows deploy closure ship it", () => {
  const sup = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8"), win = fs.readFileSync(path.join(REPO, "windows/node/host.mjs"), "utf8");
  assert.match(sup, /from "\.\/network\/registry-reconcile\.mjs"/);
  assert.match(win, /from "\.\.\/\.\.\/network\/registry-reconcile\.mjs"/);
  assert.doesNotMatch(sup, /sendOperatorTx\([^)]*"heartbeat"/, "the supervisor sends no heartbeat");
  assert.doesNotMatch(fs.readFileSync(path.join(REPO, "windows/node/chain.mjs"), "utf8"), /"heartbeat"/, "the Windows chain module has no heartbeat call");
  assert.match(fs.readFileSync(path.join(REPO, "Dockerfile"), "utf8"), /^COPY .*network\/registry-reconcile\.mjs .*\.\/network\/$/m);
  const { files, problems } = closure();
  assert.deepEqual(problems, []);
  assert.ok(files.includes("network/registry-reconcile.mjs"), "the Windows deploy closure carries the rule");
});
