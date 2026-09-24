#!/usr/bin/env node
// check-proof-key.mjs <dir> -- the device check of the lease proof key (cpu/proof-key-run.mjs; PROOF-KEY.md; LAB). Coverage
// comes from the run's OWN records, never from what happens to be on disk (the lesson of the instance-binding audit):
//   - the PLAN below: every call the run makes, in order, with its request kind -- each must appear in calls.jsonl exactly
//     once, in that order, and each must be the carrier's recorded exchange with the same number: the same request bytes and
//     the same answer (evidence-NNN.request / .json); no recorded exchange outside the plan;
//   - every statement RE-VERIFIED by the canonical verifyPvmProofKey (relay/pvm-app-attest.mjs) over its own request's nonce,
//     Google's roots, the build's pins, the run's deployment and THAT boot's logged instance; its proof key the one the VM
//     logged; the registered key the attested one;
//   - every checkpoint RE-VERIFIED offline (relay/pvm-checkpoint.mjs) against the statement of its boot, and its recorded
//     chain outcome present and ACCEPTED, with provenUntil strictly increasing from the claim; the replay REFUSED by the chain;
//   - the VM's own refusals, each in the VM's words (rate, malformed, monotonic);
//   - the restart: the same proof key logged and attested at a new boot (another transport key).
// The chain outcomes are the run's records (the local chain is gone after it); their signatures are re-checked here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const { verifyPvmProofKey } = await import(path.join(REPO, "relay/pvm-app-attest.mjs"));
const { verifyPvmCheckpoint } = await import(path.join(REPO, "relay/pvm-checkpoint.mjs"));
const d = path.resolve(process.argv[2] || ".");
const fails = [];
const expect = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const rd = (f) => { try { return fs.readFileSync(path.join(d, f), "utf8"); } catch { return null; } };
const jl = (f) => (rd(f) || "").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l.slice(0, 60) }; } });
const PLAN = [["statement-a", "a", "PROOFKEY"], ["checkpoint-a1", "a", "CHECKPOINT"], ["refuse-rate-a", "a", "CHECKPOINT"], ["refuse-malformed-a", "a", "CHECKPOINT"],
              ["checkpoint-a2", "a", "CHECKPOINT"], ["refuse-monotonic-a", "a", "CHECKPOINT"], ["statement-b", "b", "PROOFKEY"], ["checkpoint-b1", "b", "CHECKPOINT"]];
let run = null; try { run = JSON.parse(rd("run.json")); } catch {}
expect(!!run && /^0x[0-9a-f]{64}$/.test(run.pins?.deployment || ""), "run.json names the lease the VM was pinned to");
const vm = (p) => { const c = rd(`vm/${p}.log`) || ""; return { instance: (/INSTANCE id=([0-9a-f]{64})/.exec(c) || [])[1], proofKey: (/PROOF key=(0x[0-9a-f]{40})/.exec(c) || [])[1], pins: /PROOFPINS accepted/.test(c) }; };
const VM = { a: vm("a"), b: vm("b") };
console.log(`-- the VM's logged facts: A ${JSON.stringify(VM.a)}  B ${JSON.stringify(VM.b)}`);
expect(VM.a.pins && VM.a.proofKey && VM.a.instance, "A: the VM took its pins and logged its instance and proof key");

// ---- coverage: the plan, calls.jsonl and the carrier's exchanges, each exactly once, linked ----
const calls = jl("calls.jsonl"), byLabel = {};
for (const c of calls) (byLabel[c.label] = byLabel[c.label] || []).push(c);
for (const [label, , kind] of PLAN) expect((byLabel[label] || []).length === 1 && String(byLabel[label][0].request || "").startsWith(kind + " "),
                                          `coverage: ${label} is recorded once, as a ${kind} request`);
expect(calls.length === PLAN.length && calls.every((c, i) => c.label === PLAN[i][0] && c.n === i + 1), `coverage: exactly the plan's ${PLAN.length} calls, in its order, numbered 1..${PLAN.length}`);
const evDir = path.join(d, "evidence"), recorded = fs.existsSync(evDir) ? fs.readdirSync(evDir).filter((f) => /^evidence-\d{3}\.json$/.test(f)).length : 0;
expect(recorded === PLAN.length, `coverage: the carrier recorded exactly ${PLAN.length} exchanges (${recorded})`);
for (const c of calls) {
  const n = String(c.n).padStart(3, "0"), req = rd(`evidence/evidence-${n}.request`), ans = rd(`evidence/evidence-${n}.json`);
  let parsed = null; try { parsed = JSON.parse((ans || "").split("\n")[0]); } catch {}
  expect(req === c.request + "\n" && JSON.stringify(parsed) === JSON.stringify(c.answer), `${c.label}: exchange ${n} carried exactly this request and this answer`);
}
const call = (l) => (byLabel[l] || [{}])[0];
const nonceOf = (l) => (/^PROOFKEY ([0-9a-f]{64})$/.exec(call(l).request || "") || [])[1];
// ---- the statements: re-verified, the logged key, the registered key ----
const ROOTS = run?.googleRootPins || [], CODE = run?.code, AUTH = run?.authority, RID = run?.runtimeId;
const verifyStatement = (label, phase) => {
  const nonce = nonceOf(label);
  const v = nonce ? verifyPvmProofKey(call(label).answer, { nonce, appId: run?.app, allowedRuntimeIds: [RID], allowedCodeHashes: [CODE], allowedAuthorityHashes: [AUTH],
                                                           rootPins: ROOTS, instanceIds: [VM[phase].instance], deployment: run?.pins?.deployment }) : { ok: false, reasons: ["no nonce"] };
  const pinsOk = v.ok && ["chainId", "proofOfTime", "registry", "deployment", "enclaveId", "operator"].every((k) => v.claims[k] === run.pins[k]);
  expect(v.ok && pinsOk && v.claims.proofKey === VM[phase].proofKey,
         `${label}: re-verifies over its own nonce (Google's roots, the build, deployment, boot ${phase.toUpperCase()}'s instance), names the run's pins, and attests the proof key the VM logged${v.ok ? "" : ` -- ${v.reasons.at(-1)}`}`);
  return v;
};
const SA = verifyStatement("statement-a", "a"), SB = verifyStatement("statement-b", "b");
const chainRows = jl("chain.jsonl"), row = (l) => chainRows.find((r) => r.label === l) || {};
expect(row("register").proofKey === SA.claims?.proofKey && row("register").enclaveId === run?.pins?.enclaveId, "the operator registered exactly the attested proof key for the runner");
expect(!!row("claim").provenUntil, "the operator claimed the lease (provenUntil starts at the claim)");
// ---- the checkpoints: re-verified offline against their boot's statement; the chain accepted them, in order ----
let prev = row("claim").provenUntil || 0;
for (const [label, st] of [["checkpoint-a1", SA], ["checkpoint-a2", SA], ["checkpoint-b1", SB]]) {
  const c = st.ok ? await verifyPvmCheckpoint(call(label).answer, { pins: st.claims, proofKey: st.claims.proofKey }) : { ok: false, reasons: ["no verified statement"] };
  const r = row(label);
  expect(c.ok && r.ok === true && r.digest === c.checkpoint.digest && r.provenUntil > prev,
         `${label}: signed by the attested proof key for these pins, ACCEPTED by the chain, provenUntil ${prev} -> ${r.provenUntil}${c.ok ? "" : ` -- ${c.reasons[0]}`}`);
  if (r.provenUntil > prev) prev = r.provenUntil;
}
expect(row("replay-a1").ok === false && /nothing to prove/.test(row("replay-a1").reason || ""), "the same checkpoint posted again: REFUSED by the chain (nothing to prove)");
// ---- the VM's own refusals, in its words ----
for (const [label, re] of [["refuse-rate-a", /at most one checkpoint every 60 s/], ["refuse-malformed-a", /request is CHECKPOINT/], ["refuse-monotonic-a", /upto must strictly increase/]])
  expect(re.test(call(label).answer?.error || ""), `${label}: the VM refused, in its words (${call(label).answer?.error})`);
// ---- the restart ----
expect(VM.b.proofKey === VM.a.proofKey && SB.ok && SB.claims.proofKey === SA.claims?.proofKey, `restart: boot B logged and attested the SAME proof key (${VM.b.proofKey === VM.a.proofKey ? "same" : "DIFFERENT"})`);
expect(SA.ok && SB.ok && call("statement-a").answer.evidence.spki !== call("statement-b").answer.evidence.spki, "restart: a new boot (another transport key) vouched for it");
const all = fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile());
expect(!all.some((f) => fs.readFileSync(path.join(d, f), "utf8").includes("PRIVATE KEY")), "no private key anywhere in the results");
console.log(fails.length ? `FAIL (${fails.length})` : "PASS the lease proof key on the device"); process.exit(fails.length ? 1 : 0);
