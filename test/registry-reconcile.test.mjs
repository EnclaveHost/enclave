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
  // the only heartbeat sends are the owner-nomination SELF-TEST's nonce-concurrency load (OWNER_NOMINATION_SELFTEST, a
  // one-shot process that exits), never a routine writer: see heartbeatOutsideSelftest below and, for the behaviour on a
  // real chain, test/offchain-heartbeat-writers.test.mjs
  assert.deepEqual(heartbeatOutsideSelftest(sup), [], "the supervisor sends no heartbeat outside its explicit self-test");
  assert.doesNotMatch(fs.readFileSync(path.join(REPO, "windows/node/chain.mjs"), "utf8"), /"heartbeat"/, "the Windows chain module has no heartbeat call");
  assert.match(fs.readFileSync(path.join(REPO, "Dockerfile"), "utf8"), /^COPY .*network\/registry-reconcile\.mjs .*\.\/network\/$/m);
  const { files, problems } = closure();
  assert.deepEqual(problems, []);
  assert.ok(files.includes("network/registry-reconcile.mjs"), "the Windows deploy closure carries the rule");
});

// ---- heartbeat placement in supervisor.js ----------------------------------------------------------------------------
// A PLACEMENT invariant, not a behaviour test (the behaviour - zero registry writes from a running supervisor over several
// periods, with the pre-change heartbeating supervisor as the counter's negative control - is
// test/offchain-heartbeat-writers.test.mjs). supervisor.js keeps ONE deliberate heartbeat writer: the
// OWNER_NOMINATION_SELFTEST block (test/owner-nomination.test.mjs), which loads the operator's transaction queue with
// heartbeats to test nonce concurrency and then exits. The invariant: every heartbeat send is inside that block, the
// block always ends in process.exit, and the routine owner-nomination starter never runs under the self-test.
function block(src, start) {             // [start, end) of the {...} opening at or after `start`, skipping strings/comments
  let i = src.indexOf("{", start), depth = 0, q = null, tpl = [];
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; else if (q === "`" && c === "$" && n === "{") { tpl.push(depth); depth++; q = null; i++; } continue; }
    if (c === "/" && n === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && n === "*") { i = src.indexOf("*/", i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (tpl.length && depth === tpl[tpl.length - 1]) { tpl.pop(); q = "`"; continue; } if (depth === 0) return [start, i + 1]; }
  }
  throw new Error("unbalanced block");
}
function heartbeatOutsideSelftest(src) {
  const at = src.indexOf("if (process.env.OWNER_NOMINATION_SELFTEST) {");
  const [b0, b1] = at < 0 ? [-1, -1] : block(src, at);
  const sends = [...src.matchAll(/sendOperatorTx\([^;]*?"heartbeat"/g)].map((m) => m.index);
  return sends.filter((i) => !(i > b0 && i < b1)).map((i) => src.slice(src.lastIndexOf("\n", i) + 1, src.indexOf("\n", i)).trim().slice(0, 160));
}

test("heartbeat placement: the supervisor's only heartbeat sends are its explicit owner-nomination self-test, which exits", () => {
  const sup = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8");
  const at = sup.indexOf("if (process.env.OWNER_NOMINATION_SELFTEST) {");
  assert.ok(at > 0, "the self-test block exists");
  const [b0, b1] = block(sup, at), body = sup.slice(b0, b1);
  assert.ok((body.match(/sendOperatorTx\([^;]*?"heartbeat"/g) || []).length >= 1, "the self-test still loads the queue with heartbeats (nonce concurrency)");
  assert.match(body.slice(-80), /process\.exit\(0\);\s*\}$/, "the self-test block always ends the process");
  assert.match(sup, /if \(OWNER_NOMINATION\?\.config && !process\.env\.OWNER_NOMINATION_SELFTEST\) \{/, "routine nomination never runs under the self-test");
  assert.deepEqual(heartbeatOutsideSelftest(sup), []);
  // the old period name survives only as an alias of the reconcile cadence (a status/config check, no heartbeat send)
  const uses = sup.split("\n").filter((l) => l.includes("REGISTRY_HEARTBEAT_SEC") && !/^\s*\/\//.test(l));
  assert.deepEqual(uses.map((l) => /^const RECONCILE_SEC\s*=\s*parseInt\(process\.env\.REGISTRY_RECONCILE_SEC \|\| process\.env\.REGISTRY_HEARTBEAT_SEC /.test(l)), [true],
    "REGISTRY_HEARTBEAT_SEC only names the reconcile cadence");
});

test("heartbeat placement, negative controls: an injected routine timer and the REAL pre-change supervisor are both caught", async () => {
  const sup = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8");
  // a routine heartbeat timer added after the self-test block
  const mark = "// ---- app-funded lease gas";
  assert.ok(sup.includes(mark));
  const injected = sup.replace(mark, 'setInterval(() => sendOperatorTx(REGISTRY_ADDRESS, HEARTBEAT_ABI, "heartbeat", [_enclaveId]), 60_000);\n' + mark);
  assert.equal(heartbeatOutsideSelftest(injected).length, 1);
  // the supervisor before the off-chain liveness change (9a307f3ea's parent in this history): its timer heartbeat is caught
  const { execFileSync } = await import("node:child_process");
  let base = null;
  try { base = execFileSync("git", ["show", "9a307f3ea^:supervisor.js"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }); } catch {}
  if (base === null) return;   // a source archive without history: the injected control above still stands
  assert.match(base, /REGISTRY_HEARTBEAT_SEC/, "the pre-change supervisor had a routine heartbeat period");
  assert.ok(heartbeatOutsideSelftest(base).length >= 1, "its routine heartbeat send is outside any self-test");
});
