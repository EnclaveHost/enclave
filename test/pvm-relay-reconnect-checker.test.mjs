// The reconnect-in-place device checker (shielded/anchor/avf/runtime/conformance/check-relay-reconnect.mjs) held to COVERAGE:
// on a copy of the committed run (results/pvm-cpu-relay-reconnect), each mutation removes, reorders or forges one record, and
// the checker must FAIL at the check that covers it; the unmutated copy must PASS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

const ROOT = new URL("..", import.meta.url).pathname;
const RUN = path.join(ROOT, "shielded/anchor/avf/results/pvm-cpu-relay-reconnect");
const CHECK = path.join(ROOT, "shielded/anchor/avf/runtime/conformance/check-relay-reconnect.mjs");
const haveRun = fs.existsSync(path.join(RUN, "steps.jsonl"));
const lines = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const write = (dir, f, rows) => fs.writeFileSync(path.join(dir, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const edit = (dir, f, pick, g) => { const r = lines(dir, f); g(r.find(pick), r); write(dir, f, r); };
const text = (dir, f, from, to) => { const p = path.join(dir, f), s = fs.readFileSync(p, "utf8"); assert.ok(from.test(s), `${f}: ${from} not found`); fs.writeFileSync(p, s.replace(from, to)); };
const answer = (x, g) => { const [head, ...rest] = String(x.answer).split("\n"); const doc = JSON.parse(head); g(doc); x.answer = [JSON.stringify(doc), ...rest].join("\n"); };
const relayLogOf = (d, re) => { const envs = lines(d, "relay-env.jsonl"); const e = envs.find((x) => re.test(fs.readFileSync(path.join(d, `relay-${x.n}.log`), "utf8"))); return e ? `relay-${e.n}.log` : null; };
function check(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-check-"));
  try {
    fs.cpSync(RUN, dir, { recursive: true });
    if (mutate) mutate(dir);
    const r = spawnSync(process.execPath, [CHECK, dir], { encoding: "utf8", timeout: 180000, cwd: ROOT });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const otherSpkiB64 = () => generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
const CASES = [
  ["a step removed", (d) => write(d, "steps.jsonl", lines(d, "steps.jsonl").filter((s) => s.step !== "R2-watchdog")), /FAIL steps:/],
  ["a relay started with a secret-bearing name", (d) => edit(d, "relay-env.jsonl", () => true, (e) => { e.names.push("OPERATOR_PRIVATE_KEY"); }), /FAIL relay: \d+ processes/],
  ["a second VM boot in the capture", (d) => text(d, "vm/a.log", /(VSOCK ANCHOR start in pVM[^\n]*\n)/, "$1$1"), /FAIL ONE boot/],
  ["a second transport key in the capture", (d) => text(d, "vm/a.log", /(VSOCK SPKI [0-9a-f]{88}\n)/, `$1VSOCK SPKI 302a300506032b6570032100${"ab".repeat(32)}\n`), /FAIL ONE boot/],
  ["an in-place acceptance with no loss before it (two live tunnels)", (d) => text(d, "vm/a.log", /RELAY keeper: the tunnel is gone[^\n]*\n/, ""), /FAIL one reconnector/],
  ["an in-place acceptance missing", (d) => text(d, "vm/a.log", /RELAY re-attach \d+: ACCEPTED in place[^\n]*\n/, ""), /FAIL the running VM answered every REATTACH/],
  ["an owner co-signature over ANOTHER transport key", (d) => edit(d, "attach.jsonl", (x) => x.signer === "owner" && x.verdict && x.verdict.ok && x.step !== "A-attach", (x) => { x.request.rad.transportKey = otherSpkiB64(); }), /FAIL attach: every owner co-signature/],
  ["a nonce co-signed twice", (d) => { const r = lines(d, "attach.jsonl"), o = r.filter((x) => x.signer === "owner" && x.verdict && x.verdict.ok); o[2].request.nonce = o[1].request.nonce; write(d, "attach.jsonl", r); }, /FAIL attach: no nonce was co-signed twice/],
  ["the stale answer is the wrong operator's signature, not an earlier owner's", (d) => { const r = lines(d, "attach.jsonl"), w = r.find((x) => x.signer === "wrong-operator"); edit(d, "attach.jsonl", (x) => x.signer === "proxy-stale", (x) => { x.verdict.operatorSig = w.verdict.operatorSig; }); }, /FAIL R3's co-signer answers/],
  ["two tunnels at once in a relay", (d) => { const f = relayLogOf(d, /attached via/); text(d, f, /\(1 enclave\)/, "(2 enclaves)"); }, /FAIL relay: every attach of the name left exactly ONE tunnel/],
  ["R3's refusals out of order", (d) => { const f = relayLogOf(d, /must carry operatorSig/); const p = path.join(d, f), s = fs.readFileSync(p, "utf8").split("\n");
     const i = s.findIndex((l) => /must carry operatorSig/.test(l)), j = s.findIndex((l, k) => k > i && /attest REJECTED: .*registered on chain to/.test(l)); [s[i], s[j]] = [s[j], s[i]]; fs.writeFileSync(p, s.join("\n")); }, /FAIL R3: the hub refused, in order/],
  ["the old-build relay attached", (d) => { const f = relayLogOf(d, /allowlisted codeHash/); fs.appendFileSync(path.join(d, f), "[tunnel] pixel10-pvm-cpu attached via attestation(avf) (1 enclave)\n"); }, /FAIL R5: the relay that admits only another build/],
  ["the replayed frame accepted", (d) => edit(d, "replay.jsonl", () => true, (x) => { x.result = { t: "attest-result", ok: true }; }), /FAIL R3: an ACCEPTED attest frame/],
  ["a statement's proof key forged", (d) => edit(d, "exchanges.jsonl", (x) => x.request.startsWith("PROOFKEY ") && /"proofKey"/.test(x.answer), (x) => answer(x, (doc) => { doc.proofKey = "0x" + "12".repeat(20); })), /FAIL statements:/],
  ["a leased exchange through the bootstrap route", (d) => edit(d, "exchanges.jsonl", (x) => x.step.startsWith("R1-"), (x) => { x.url = "/t/pixel10-pvm-cpu/pvm/evidence"; }), /FAIL carrier:/],
  ["a checkpoint's signature swapped", (d) => { const r = lines(d, "exchanges.jsonl"), cps = r.filter((x) => x.request.startsWith("CHECKPOINT ") && /"sig"/.test(x.answer)), s0 = JSON.parse(String(cps[0].answer).split("\n")[0]).sig;
     answer(cps[1], (doc) => { doc.sig = s0; }); write(d, "exchanges.jsonl", r); }, /FAIL checkpoints:/],
  ["a re-attached client served another instance", (d) => text(d, "client/r1-bound-2.jsonl", /"instance":"[0-9a-f]{64}"/g, `"instance":"${"cd".repeat(32)}"`), /FAIL client: served through \/x/],
  ["two rows for the name at one sample", (d) => edit(d, "rows.jsonl", (x) => x.rows.length === 1, (x) => { x.rows.push(x.rows[0]); }), /FAIL rows: never two rows/],
  ["the in-place row carries the tier", (d) => edit(d, "rows.jsonl", (x) => x.step === "R5-no-tier", (x) => { x.rows[0].tier = "pvm-cpu"; }), /FAIL rows: the tier at boot/],
  ["a second Claimed on chain", (d) => { const r = lines(d, "chain-events.jsonl"); r.push({ ...r.find((e) => e.event === "Claimed"), tx: "0x" + "ab".repeat(32) }); write(d, "chain-events.jsonl", r); }, /FAIL registered once with the attested key; claimed once/],
  ["the undelivered checkpoint is not the one recovered", (d) => edit(d, "chain.jsonl", (e) => e.label === "swallowed-send", (e) => { e.hash = "0x" + "cd".repeat(32); }), /FAIL exactly once across a drop/],
  ["a checkpoint signed while the relay was down", (d) => { const S = lines(d, "steps.jsonl"), at = S.find((s) => s.step === "R4-cut").utc; const j = lines(d, "journal.jsonl"), sg = j.find((e) => e.ev === "signed");
     j.push({ ...sg, at: new Date(Date.parse(at) - 1000).toISOString() }); write(d, "journal.jsonl", j); }, /FAIL R4: no checkpoint was signed/],
  ["the release mined before the last proof", (d) => edit(d, "chain-events.jsonl", (e) => e.event === "Released", (e) => { e.block = "1"; }), /FAIL released once, after the last proof/],
  ["an attestation chain under another provisioned key", (d) => edit(d, "exchanges.jsonl", (x) => x.request.startsWith("PROOFKEY ") && /"proofKey"/.test(x.answer), (x) => answer(x, (doc) => { if (doc.evidence && doc.evidence.chain) doc.evidence.chain[1] = doc.evidence.chain[0]; })), /FAIL every attestation chain in the run/],
  ["the run's own key scan missing", (d) => text(d, "run.log", /.*the operator keys appear nowhere in the results.*\n/, ""), /FAIL the run scanned its own results/],
];
test("the reconnect checker: the committed run PASSES unmutated", { skip: !haveRun && "no committed run" }, () => {
  const r = check(null);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS reconnect in place through the real relay/);
});
for (const [what, mutate, re] of CASES) {
  test(`the reconnect checker FAILS on: ${what}`, { skip: !haveRun && "no committed run" }, () => {
    const r = check(mutate);
    assert.equal(r.code, 1, `${what}: the checker passed\n${r.out}`);
    assert.match(r.out, re, `${what}: failed, but not at the check that covers it\n${r.out.split("\n").filter((l) => l.startsWith("FAIL")).join("\n")}`);
  });
}
