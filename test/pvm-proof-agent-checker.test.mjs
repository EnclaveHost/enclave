// The posting agent's device checker (shielded/anchor/avf/runtime/conformance/check-proof-agent.mjs) held to COVERAGE: on a copy
// of the committed run (results/pvm-cpu-proof-agent), each mutation removes, swaps or forges one record, and the checker must
// FAIL at the check that covers it; the unmutated copy must PASS. Forgeries edited consistently in both the agent's copy
// (proxy.jsonl) and the hub's copy (evidence/) must still fail -- at the re-verification, not merely at the link.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const RUN = path.join(ROOT, "shielded/anchor/avf/results/pvm-cpu-proof-agent");
const CHECK = path.join(ROOT, "shielded/anchor/avf/runtime/conformance/check-proof-agent.mjs");
const haveRun = fs.existsSync(path.join(RUN, "proxy.jsonl"));
const lines = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const write = (dir, f, rows) => fs.writeFileSync(path.join(dir, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const ev = (dir, n, ext) => path.join(dir, "evidence", `evidence-${String(n).padStart(3, "0")}.${ext}`);
const flip = (hex, at) => hex.slice(0, at) + (hex[at] === "0" ? "1" : "0") + hex.slice(at + 1);
// edit one exchange's answer in BOTH the agent's record and the hub's, consistently
function forge(dir, pick, f) {
  const px = lines(dir, "proxy.jsonl"), x = px.find(pick);
  const doc = f(JSON.parse(x.answer.split("\n")[0]));
  x.answer = JSON.stringify(doc) + "\n"; write(dir, "proxy.jsonl", px);
  fs.writeFileSync(ev(dir, x.n, "json"), x.answer);
}
const editJl = (dir, f, pick, g) => { const r = lines(dir, f); g(r.find(pick), r); write(dir, f, r); };
function check(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-check-"));
  try {
    fs.cpSync(RUN, dir, { recursive: true });
    if (mutate) mutate(dir);
    const r = spawnSync(process.execPath, [CHECK, dir], { encoding: "utf8", timeout: 120000, cwd: ROOT });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const landedOf = (d, step) => lines(d, "steps.jsonl").find((s) => s.step === step).outcome;
const CASES = [
  ["a step removed from the run's record", (d) => write(d, "steps.jsonl", lines(d, "steps.jsonl").filter((s) => s.step !== "reorg")), /FAIL steps: exactly the plan's/],
  ["a step's outcome changed", (d) => editJl(d, "steps.jsonl", (s) => s.step === "replay", (s) => { s.outcome.kind = "landed"; }), /FAIL steps: exactly the plan's/],
  ["an exchange deleted from the hub's record", (d) => { const px = lines(d, "proxy.jsonl"), x = px.find((y) => y.request.startsWith("CHECKPOINT"));
     for (const e of ["json", "request", "meta.json"]) fs.rmSync(ev(d, x.n, e), { force: true }); }, /FAIL carrier: the agent's \d+ exchanges and the hub's/],
  ["an exchange's answer differs between the agent's and the hub's records", (d) => editJl(d, "proxy.jsonl", (x) => x.request.startsWith("CHECKPOINT") && !x.mode,
     (x) => { x.answer = x.answer.replace(/"sig":"0x([0-9a-f])/, (m, c) => `"sig":"0x${c === "0" ? "1" : "0"}`); }), /FAIL carrier: each exchange carried exactly/],
  ["the replay not recorded as swapped", (d) => editJl(d, "proxy.jsonl", (x) => !!x.mode, (x) => { delete x.mode; delete x.handed; }), /FAIL replay: exactly one answer was swapped/],
  ["a statement's proof key forged (both copies)", (d) => forge(d, (x) => x.request.startsWith("PROOFKEY"), (a) => ({ ...a, proofKey: "0x" + "12".repeat(20) })), /FAIL statement \d+ \(start-a\): re-verifies/],
  ["an accepted checkpoint's signature forged (both copies)", (d) => {
     const j = lines(d, "journal.jsonl"), s = j.find((e) => e.ev === "signed");
     forge(d, (x) => x.request === `CHECKPOINT ${s.checkpoint.upto} ${s.checkpoint.anchorBlock} ${s.checkpoint.anchorHash.slice(2)}`, (a) => ({ ...a, sig: flip(a.sig, 12) })); },
   /FAIL journal: every checkpoint the agent accepted/],
  ["a journaled transaction's bytes replaced by another's", (d) => { const j = lines(d, "journal.jsonl"), t = j.filter((e) => e.ev === "tx"); t[0].raw = t[1].raw; write(d, "journal.jsonl", j); },
   /FAIL transactions: each journaled hash is keccak256 of its bytes/],
  ["a landing's receipt recorded as reverted", (d) => { const h = landedOf(d, "a1").hash; editJl(d, "receipts.jsonl", (r) => r.hash === h, (r) => { r.receipt.status = "reverted"; }); },
   /FAIL landings: \d+ \(the plan's/],
  ["a Checkpointed event on a transaction the journal never landed", (d) => { const lh = new Set(lines(d, "journal.jsonl").filter((e) => e.ev === "done" && e.kind === "landed").map((e) => e.hash));
     editJl(d, "receipts.jsonl", (r) => !lh.has(r.hash) && r.receipt === null, (r, all) => { const src = all.find((x) => lh.has(x.hash)); r.receipt = { ...src.receipt }; r.checkpointed = src.checkpointed; }); },
   /FAIL landings: no Checkpointed event on chain that the journal does not record/],
  ["the reorganization's chain record removed", (d) => write(d, "chain.jsonl", lines(d, "chain.jsonl").filter((r) => r.label !== "reorganized")), /FAIL reorg:/],
  ["the recovery not in the journal", (d) => write(d, "journal.jsonl", lines(d, "journal.jsonl").filter((e) => e.ev !== "recover")), /FAIL crash\/recover:/],
  ["an undelivered stuck transaction recorded as mined", (d) => { const sk = landedOf(d, "stuck"), fr = landedOf(d, "fresh"), j = lines(d, "journal.jsonl");
     const frDigest = j.find((e) => e.ev === "done" && e.hash === fr.hash).digest, t = j.find((e) => e.ev === "tx" && e.nonce === sk.nonce && e.digest !== frDigest);
     editJl(d, "receipts.jsonl", (r) => r.hash === t.hash, (r) => { r.receipt = { status: "reverted", block: 1, blockHash: "0x" + "00".repeat(32), canonical: true, from: "", to: "", gasUsed: "0" }; }); },
   /FAIL stuck\/fresh:/],
  ["the restart's logged proof key changed", (d) => { const p = path.join(d, "vm", "b.log"); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/PROOF key=0x[0-9a-f]{40}/, "PROOF key=0x" + "56".repeat(20))); },
   /FAIL both boots took the pins and logged the SAME instance and proof key/],
  ["the run's own key scan missing", (d) => { const p = path.join(d, "run.log"); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/.*the operator key appears nowhere in the results.*\n/, "")); },
   /FAIL the run scanned its own results for the operator key/],
];

test("the posting agent's device checker: the committed run PASSES unmutated", { skip: !haveRun && "no committed run" }, () => {
  const r = check(null);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS the posting agent on the device/);
});
for (const [what, mutate, re] of CASES) {
  test(`the posting agent's device checker FAILS on: ${what}`, { skip: !haveRun && "no committed run" }, () => {
    const r = check(mutate);
    assert.equal(r.code, 1, `${what}: the checker passed\n${r.out}`);
    assert.match(r.out, re, `${what}: failed, but not at the check that covers it\n${r.out.split("\n").filter((l) => l.startsWith("FAIL")).join("\n")}`);
  });
}
