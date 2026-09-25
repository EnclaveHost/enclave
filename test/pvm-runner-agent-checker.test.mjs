// The runner lifecycle agent's device checker (shielded/anchor/avf/runtime/conformance/check-runner-agent.mjs) held to
// COVERAGE: on a copy of the committed run (results/pvm-cpu-proof-agent-lifecycle-2), each mutation removes, reorders or forges one record,
// and the checker must FAIL at the check that covers it; the unmutated copy must PASS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const RUN = path.join(ROOT, "shielded/anchor/avf/results/pvm-cpu-proof-agent-lifecycle-2");
const CHECK = path.join(ROOT, "shielded/anchor/avf/runtime/conformance/check-runner-agent.mjs");
const haveRun = fs.existsSync(path.join(RUN, "steps.jsonl"));
const lines = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const write = (dir, f, rows) => fs.writeFileSync(path.join(dir, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const ev = (dir, n, ext) => path.join(dir, "evidence", `evidence-${String(n).padStart(3, "0")}.${ext}`);
const edit = (dir, f, pick, g) => { const r = lines(dir, f); g(r.find(pick), r); write(dir, f, r); };
function check(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-check-"));
  try {
    fs.cpSync(RUN, dir, { recursive: true });
    if (mutate) mutate(dir);
    const r = spawnSync(process.execPath, [CHECK, dir], { encoding: "utf8", timeout: 120000, cwd: ROOT });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const CASES = [
  ["an approach step removed", (d) => write(d, "steps.jsonl", lines(d, "steps.jsonl").filter((s) => s.step !== "approach-1")), /FAIL steps:/],
  ["the renew step recorded as a heartbeat", (d) => edit(d, "steps.jsonl", (s) => s.step === "renew", (s) => { s.lifecycle.op = "heartbeat"; }), /FAIL renew: inside the margin/],
  ["an exchange deleted from the hub's record", (d) => { const x = lines(d, "proxy.jsonl").find((y) => y.request.startsWith("CHECKPOINT")); for (const e of ["json", "request", "meta.json"]) fs.rmSync(ev(d, x.n, e), { force: true }); }, /FAIL carrier:/],
  ["a statement's proof key forged (both copies)", (d) => { const px = lines(d, "proxy.jsonl"), x = px.find((y) => y.request.startsWith("PROOFKEY"));
     const doc = JSON.parse(x.answer.split("\n")[0]); doc.proofKey = "0x" + "12".repeat(20); x.answer = JSON.stringify(doc) + "\n"; write(d, "proxy.jsonl", px); fs.writeFileSync(ev(d, x.n, "json"), x.answer); }, /FAIL statements:/],
  ["a journaled transaction's bytes replaced by another's", (d) => { const j = lines(d, "journal.jsonl"), t = j.filter((e) => e.ev === "tx"); t[0].raw = t[1].raw; write(d, "journal.jsonl", j); }, /FAIL transactions:/],
  ["the registry recorded setting another key", (d) => edit(d, "chain-events.jsonl", (e) => e.event === "ProofKeySet", (e) => { e.args.proofKey = "0x" + "34".repeat(20); }), /FAIL registry: every ProofKeySet/],
  ["a third Renewed on chain", (d) => { const r = lines(d, "chain-events.jsonl"); r.push({ ...r.find((e) => e.event === "Renewed"), tx: "0x" + "ab".repeat(32) }); write(d, "chain-events.jsonl", r); }, /FAIL exactly two Renewed/],
  ["the release mined before the last proof", (d) => { const r = lines(d, "chain-events.jsonl"), rel = r.find((e) => e.event === "Released"); rel.block = "1"; write(d, "chain-events.jsonl", r); }, /FAIL one Released, mined after/],
  ["a landing's receipt not canonical", (d) => { const h = lines(d, "journal.jsonl").find((e) => e.ev === "done" && e.kind === "landed").hash; edit(d, "receipts.jsonl", (r) => r.hash === h, (r) => { r.receipt.canonical = false; }); }, /FAIL every landing:/],
  ["the undelivered renew is not the one recovered", (d) => edit(d, "chain.jsonl", (e) => e.label === "swallowed-send", (e) => { e.hash = "0x" + "cd".repeat(32); }), /FAIL renew: the transaction never delivered/],
  ["the tenant charged more than one renew", (d) => edit(d, "steps.jsonl", (s) => s.step === "renew-recovered", (s) => { s.balAfter = String(BigInt(s.balAfter) - 1n); }), /FAIL renew: the tenant's balance/],
  ["the recovery asked the VM for a proof", (d) => { const px = lines(d, "proxy.jsonl"), x = px.find((y) => y.request.startsWith("CHECKPOINT")); x.step = "renew-recovered"; write(d, "proxy.jsonl", px); }, /FAIL renew: the recovery asked the VM for no proof/],
  ["the published measurement not the attested build", (d) => edit(d, "chain-events.jsonl", (e) => e.event === "Updated", (e) => { e.args.measurement = "0x" + "56".repeat(32); }), /FAIL registry: the published measurement/],
  ["the earnings withdrawn to another address", (d) => edit(d, "chain-events.jsonl", (e) => e.event === "EarningsWithdrawn", (e) => { e.args.to = "0x" + "78".repeat(20); }), /FAIL payout: one withdrawal/],
  ["the run's own key scan missing", (d) => { const p = path.join(d, "run.log"); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/.*the operator key appears nowhere in the results.*\n/, "")); }, /FAIL the run scanned its own results/],
];
test("the runner lifecycle checker: the committed run PASSES unmutated", { skip: !haveRun && "no committed run" }, () => {
  const r = check(null);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS the runner lifecycle agent on the device/);
});
for (const [what, mutate, re] of CASES) {
  test(`the runner lifecycle checker FAILS on: ${what}`, { skip: !haveRun && "no committed run" }, () => {
    const r = check(mutate);
    assert.equal(r.code, 1, `${what}: the checker passed\n${r.out}`);
    assert.match(r.out, re, `${what}: failed, but not at the check that covers it\n${r.out.split("\n").filter((l) => l.startsWith("FAIL")).join("\n")}`);
  });
}
