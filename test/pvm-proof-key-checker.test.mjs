// The proof-key device checker (shielded/anchor/avf/runtime/conformance/check-proof-key.mjs) held to COVERAGE: on a copy of the
// committed run (results/pvm-cpu-proof-key), each mutation removes, duplicates, swaps or forges one record, and the checker
// must FAIL at the check that covers it; the unmutated copy must PASS. Forgeries that keep the carrier's copy and the call
// record consistent (both edited) must still fail -- at the re-verification, not merely at the link.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const RUN = path.join(ROOT, "shielded/anchor/avf/results/pvm-cpu-proof-key");
const CHECK = path.join(ROOT, "shielded/anchor/avf/runtime/conformance/check-proof-key.mjs");
const haveRun = fs.existsSync(path.join(RUN, "calls.jsonl"));
const lines = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const write = (dir, f, rows) => fs.writeFileSync(path.join(dir, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const ev = (dir, n, ext) => path.join(dir, "evidence", `evidence-${String(n).padStart(3, "0")}.${ext}`);
// edit a call's answer in BOTH places (the call record and the carrier's recorded envelope), consistently
function forge(dir, label, f) {
  const calls = lines(dir, "calls.jsonl"), c = calls.find((x) => x.label === label);
  c.answer = f(structuredClone(c.answer)); write(dir, "calls.jsonl", calls);
  fs.writeFileSync(ev(dir, c.n, "json"), JSON.stringify(c.answer) + "\n");
}
const editRow = (dir, label, f) => { const r = lines(dir, "chain.jsonl"); f(r.find((x) => x.label === label), r); write(dir, "chain.jsonl", r); };

function check(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-check-"));
  try {
    fs.cpSync(RUN, dir, { recursive: true });
    if (mutate) mutate(dir);
    const r = spawnSync(process.execPath, [CHECK, dir], { encoding: "utf8", timeout: 120000, cwd: ROOT });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const CASES = [
  ["a checkpoint's recorded exchange deleted", (d) => { for (const x of ["json", "request", "meta.json"]) fs.rmSync(ev(d, 5, x), { force: true }); },
   /FAIL coverage: the carrier recorded exactly 8 exchanges|FAIL checkpoint-a2: exchange 005/],
  ["a call removed from the plan's record", (d) => write(d, "calls.jsonl", lines(d, "calls.jsonl").filter((c) => c.label !== "checkpoint-a2")), /FAIL coverage: checkpoint-a2 is recorded once/],
  ["a call recorded twice", (d) => { const c = lines(d, "calls.jsonl"); write(d, "calls.jsonl", [...c, c[1]]); }, /FAIL coverage: checkpoint-a1 is recorded once|FAIL coverage: exactly the plan's/],
  ["two checkpoints' answers swapped in the call record", (d) => { const c = lines(d, "calls.jsonl"), a = c.find((x) => x.label === "checkpoint-a1"), b = c.find((x) => x.label === "checkpoint-a2");
     [a.answer, b.answer] = [b.answer, a.answer]; write(d, "calls.jsonl", c); }, /FAIL checkpoint-a1: exchange 002 carried exactly/],
  ["the statement's proof key forged (both copies)", (d) => forge(d, "statement-a", (a) => ({ ...a, proofKey: "0x" + "12".repeat(20) })), /FAIL statement-a: re-verifies/],
  ["a checkpoint's signature forged (both copies)", (d) => forge(d, "checkpoint-a1", (a) => ({ ...a, sig: a.sig.slice(0, 10) + (a.sig[10] === "0" ? "1" : "0") + a.sig.slice(11) })),
   /FAIL checkpoint-a1: signed by the attested proof key/],
  ["a checkpoint's chain outcome removed", (d) => write(d, "chain.jsonl", lines(d, "chain.jsonl").filter((r) => r.label !== "checkpoint-a2")), /FAIL checkpoint-a2: signed by the attested proof key/],
  ["a checkpoint recorded as refused by the chain", (d) => editRow(d, "checkpoint-b1", (r) => { r.ok = false; }), /FAIL checkpoint-b1: signed by the attested proof key/],
  ["the registry recorded with another proof key", (d) => editRow(d, "register", (r) => { r.proofKey = "0x" + "34".repeat(20); }), /FAIL the operator registered exactly the attested proof key/],
  ["the replay recorded as accepted", (d) => editRow(d, "replay-a1", (r) => { r.ok = true; r.reason = null; }), /FAIL the same checkpoint posted again/],
  ["the restart's logged proof key changed", (d) => { const p = path.join(d, "vm", "b.log"); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/PROOF key=0x[0-9a-f]{40}/, "PROOF key=0x" + "56".repeat(20))); },
   /FAIL statement-b: re-verifies|FAIL restart: boot B logged and attested the SAME proof key/],
  ["the VM's rate refusal replaced by a signature (both copies)", (d) => forge(d, "refuse-rate-a", () => ({ format: "enclave-pvm-checkpoint/v1" })), /FAIL refuse-rate-a: the VM refused/],
  ["the call record missing", (d) => fs.rmSync(path.join(d, "calls.jsonl")), /FAIL coverage: statement-a is recorded once/],
];

test("control: the committed proof-key run, unmutated, PASSES", { skip: !haveRun && "no run" }, () => {
  const r = check(null);
  assert.equal(r.code, 0, r.out.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
  assert.match(r.out, /PASS the lease proof key on the device/);
});
for (const [name, mutate, want] of CASES) {
  test(`coverage: ${name} -> FAIL at the check that covers it`, { skip: !haveRun && "no run" }, () => {
    const r = check(mutate);
    assert.equal(r.code, 1, `the checker PASSED a run with ${name}`);
    assert.match(r.out, want, r.out.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
  });
}
