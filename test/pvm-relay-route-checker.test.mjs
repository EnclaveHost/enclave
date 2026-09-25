// The real-relay device checker (shielded/anchor/avf/runtime/conformance/check-relay-route.mjs) held to COVERAGE: on a copy
// of the committed run (results/pvm-cpu-relay-route), each mutation removes, reorders or forges one record, and the checker
// must FAIL at the check that covers it; the unmutated copy must PASS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

const ROOT = new URL("..", import.meta.url).pathname;
const RUN = path.join(ROOT, "shielded/anchor/avf/results/pvm-cpu-relay-route");
const CHECK = path.join(ROOT, "shielded/anchor/avf/runtime/conformance/check-relay-route.mjs");
const haveRun = fs.existsSync(path.join(RUN, "steps.jsonl"));
const lines = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const write = (dir, f, rows) => fs.writeFileSync(path.join(dir, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const edit = (dir, f, pick, g) => { const r = lines(dir, f); g(r.find(pick), r); write(dir, f, r); };
const text = (dir, f, from, to) => { const p = path.join(dir, f), s = fs.readFileSync(p, "utf8"); assert.ok(from.test(s), `${f}: ${from} not found`); fs.writeFileSync(p, s.replace(from, to)); };
const answer = (x, g) => { const [head, ...rest] = String(x.answer).split("\n"); const doc = JSON.parse(head); g(doc); x.answer = [JSON.stringify(doc), ...rest].join("\n"); };
function check(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-check-"));
  try {
    fs.cpSync(RUN, dir, { recursive: true });
    if (mutate) mutate(dir);
    const r = spawnSync(process.execPath, [CHECK, dir], { encoding: "utf8", timeout: 120000, cwd: ROOT });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const otherSpki = () => generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("hex");
const CASES = [
  ["a step removed", (d) => write(d, "steps.jsonl", lines(d, "steps.jsonl").filter((s) => s.step !== "B-gone")), /FAIL steps:/],
  ["a relay started with a secret-bearing name", (d) => edit(d, "relay-env.jsonl", () => true, (e) => { e.names.push("OPERATOR_PRIVATE_KEY"); }), /FAIL relay: \d+ processes/],
  ["the old-build relay admitting the lab build", (d) => { const code = JSON.parse(fs.readFileSync(path.join(d, "run.json"), "utf8")).code, r = lines(d, "relay-env.jsonl");
     for (const e of r) e.values.METAL_AVF_CODE_HASHES = e.values.PVM_CPU_CODE_HASHES = code; write(d, "relay-env.jsonl", r); }, /FAIL relay: the lab build admitted/],
  ["a boot under another instance", (d) => text(d, "vm/b3.log", /INSTANCE id=[0-9a-f]{64}/, `INSTANCE id=${"ab".repeat(32)}`), /FAIL every boot logged/],
  ["the unregistered attach co-signed", (d) => text(d, "vm/a.log", /(RELAY presented chain)/, "RELAY attach co-signed by the owner (instance proof accepted)\n$1"), /FAIL A: attached UNREGISTERED/],
  ["the registered name taken without a co-signature", (d) => text(d, "vm/b1.log", /RELAY attest REJECTED: .*/, "RELAY attest ACCEPTED measurement=00"), /FAIL B1:/],
  ["the wrong operator refused for another reason", (d) => text(d, "vm/b2.log", /RELAY attest REJECTED: .*/, "RELAY attest REJECTED: timeout"), /FAIL B2:/],
  ["the old-build relay refused for another reason", (d) => text(d, "vm/c.log", /RELAY attest REJECTED: .*/, "RELAY attest REJECTED: timeout"), /FAIL C:/],
  ["an owner co-signature replaced by the wrong operator's", (d) => { const r = lines(d, "attach.jsonl"), w = r.find((x) => x.signer === "wrong-operator"), o = r.find((x) => x.step === "B3-owner-cosigner");
     o.verdict.operatorSig = w.verdict.operatorSig; write(d, "attach.jsonl", r); }, /FAIL attach: every owner co-signature/],
  ["an owner co-signature for another instance", (d) => edit(d, "attach.jsonl", (x) => x.step === "C-right-relay", (x) => { x.request.instanceKey = otherSpki(); }), /FAIL attach: every owner co-signature/],
  ["a nonce co-signed twice", (d) => { const r = lines(d, "attach.jsonl"), o = r.filter((x) => x.signer === "owner"); o[1].request.nonce = o[0].request.nonce; write(d, "attach.jsonl", r); }, /FAIL attach: no nonce was co-signed twice/],
  ["the wrong operator's signature is the owner's", (d) => { const r = lines(d, "attach.jsonl"), w = r.find((x) => x.signer === "wrong-operator"), o = r.find((x) => x.step === "B3-owner-cosigner");
     w.verdict.operatorSig = o.verdict.operatorSig; write(d, "attach.jsonl", r); }, /FAIL attach: the wrong operator's one signature/],
  ["a co-signature missing from the owner's journal", (d) => write(d, "cosign-journal.jsonl", lines(d, "cosign-journal.jsonl").slice(1)), /FAIL the owner's co-signer journal/],
  ["a statement's proof key forged", (d) => edit(d, "exchanges.jsonl", (x) => x.step === "A-prove" && x.request.startsWith("PROOFKEY "), (x) => answer(x, (doc) => { doc.proofKey = "0x" + "12".repeat(20); })), /FAIL statements:/],
  ["the rate refusal journaled as an accepted key", (d) => edit(d, "journal.jsonl", (e) => e.ev === "attest" && e.ok === false, (e) => { e.ok = true; e.proofKey = "0x" + "12".repeat(20); delete e.reason; }), /FAIL the agent accepted exactly/],
  ["a leased exchange through the bootstrap route", (d) => { const r = lines(d, "exchanges.jsonl"), x = r.find((y) => y.step === "B-prove"); x.url = x.url.replace(/^\/x\/0x[0-9a-f]{64}/, `/t/${JSON.parse(fs.readFileSync(path.join(d, "run.json"), "utf8")).endpoint.split("/t/")[1]}`); write(d, "exchanges.jsonl", r); }, /FAIL carrier:/],
  ["the first statement asked after the lease", (d) => { const r = lines(d, "exchanges.jsonl"); write(d, "exchanges.jsonl", r.filter((x) => x.step !== "A-bootstrap")); }, /FAIL the first statement came through the BOOTSTRAP route/],
  ["a checkpoint's signature swapped", (d) => { const r = lines(d, "exchanges.jsonl"), cps = r.filter((x) => x.request.startsWith("CHECKPOINT ")), s0 = JSON.parse(String(cps[0].answer).split("\n")[0]).sig;
     answer(cps[1], (doc) => { doc.sig = s0; }); write(d, "exchanges.jsonl", r); }, /FAIL checkpoints:/],
  ["the bound client served another instance after the reconnect", (d) => text(d, "client/b-bound.jsonl", /"instance":"[0-9a-f]{64}"/g, `"instance":"${"cd".repeat(32)}"`), /FAIL client: served through \/x/],
  ["the wrong-instance request sealed and sent", (d) => text(d, "client/a-wrong-instance.jsonl", /"sent":false/, '"sent":true'), /FAIL client a-wrong-instance/],
  ["a second Claimed on chain", (d) => { const r = lines(d, "chain-events.jsonl"); r.push({ ...r.find((e) => e.event === "Claimed"), tx: "0x" + "ab".repeat(32) }); write(d, "chain-events.jsonl", r); }, /FAIL registered once with the attested key; claimed once/],
  ["a Checkpointed that is no journaled landing", (d) => edit(d, "chain-events.jsonl", (e) => e.event === "Checkpointed", (e) => { e.tx = "0x" + "ef".repeat(32); }), /FAIL every Checkpointed is a journaled landing/],
  ["the undelivered checkpoint is not the one recovered", (d) => edit(d, "chain.jsonl", (e) => e.label === "swallowed-send", (e) => { e.hash = "0x" + "cd".repeat(32); }), /FAIL exactly once:/],
  ["the release mined before the last proof", (d) => edit(d, "chain-events.jsonl", (e) => e.event === "Released", (e) => { e.block = "1"; }), /FAIL released once, after the last proof/],
  ["the run's own key scan missing", (d) => text(d, "run.log", /.*the operator keys appear nowhere in the results.*\n/, ""), /FAIL the run scanned its own results/],
];
test("the real-relay checker: the committed run PASSES unmutated", { skip: !haveRun && "no committed run" }, () => {
  const r = check(null);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS the pVM runner through the real relay/);
});
for (const [what, mutate, re] of CASES) {
  test(`the real-relay checker FAILS on: ${what}`, { skip: !haveRun && "no committed run" }, () => {
    const r = check(mutate);
    assert.equal(r.code, 1, `${what}: the checker passed\n${r.out}`);
    assert.match(r.out, re, `${what}: failed, but not at the check that covers it\n${r.out.split("\n").filter((l) => l.startsWith("FAIL")).join("\n")}`);
  });
}
