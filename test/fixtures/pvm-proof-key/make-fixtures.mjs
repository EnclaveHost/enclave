#!/usr/bin/env node
// make-fixtures.mjs -- writes test/fixtures/pvm-proof-key/fixtures.json: REPLAYABLE vectors for the lease proof key's
// statement and checkpoints (shielded/anchor/avf/PROOF-KEY.md), made from the DEVICE run results/pvm-cpu-proof-key: the
// Pixel's own PROOFKEY statement (a real v3 envelope under Google's roots) with its nonce, the lease values it was made
// against, the Pixel's own checkpoints, and negatives derived from them -- each with the EXACT reason the canonical verifier
// gives. The exact reason is recorded from the verifier, but only after it is checked here against the refusal each case is
// FOR (the `intent` pattern), so a wrong refusal cannot be baked in as expected. Replayed by test/pvm-proof-key-fixtures.test.mjs;
// the verifier session pins the file by commit.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "../../..");
const RUN = path.join(REPO, "shielded/anchor/avf/results/pvm-cpu-proof-key");
const { verifyPvmProofKey } = await import(path.join(REPO, "relay/pvm-app-attest.mjs"));
const { verifyPvmCheckpoint } = await import(path.join(REPO, "relay/pvm-checkpoint.mjs"));
const run = JSON.parse(fs.readFileSync(path.join(RUN, "run.json"), "utf8"));
const calls = fs.readFileSync(path.join(RUN, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const call = (l) => calls.find((c) => c.label === l);
const st = call("statement-a"), nonce = /^PROOFKEY ([0-9a-f]{64})$/.exec(st.request)[1];
const inst = /INSTANCE id=([0-9a-f]{64})/.exec(fs.readFileSync(path.join(RUN, "vm/a.log"), "utf8"))[1];
const now = Date.parse(st.utcEnd);
const base = { nonce, appId: run.app, allowedRuntimeIds: [run.runtimeId], allowedCodeHashes: [run.code], allowedAuthorityHashes: [run.authority],
               rootPins: run.googleRootPins, instanceIds: [inst], deployment: run.pins.deployment, now };
const cases = [];
const add = (name, what, doc, over, intent) => {
  const expect = { ...base, ...over };
  const v = verifyPvmProofKey(doc, expect);
  if (intent === null) { if (!v.ok) throw new Error(`${name}: expected to verify, got ${v.reasons.at(-1)}`); }
  else if (v.ok || !intent.test(v.reasons.at(-1))) throw new Error(`${name}: expected a refusal matching ${intent}, got ${v.ok ? "ok" : v.reasons.at(-1)}`);
  cases.push({ name, what, statement: doc, expect, want: v.ok ? { ok: true, claims: v.claims } : { ok: false, reason: v.reasons.at(-1) } });
};
const S = st.answer, other = "0x" + "d2".repeat(32);
add("device-statement", "the Pixel's own statement, verified over its nonce, pins, deployment and logged instance", S, {}, null);
add("replayed-under-new-nonce", "the same statement presented for another nonce: fails at the nonce", S, { nonce: "ab".repeat(32) }, /another nonce/);
add("other-deployment", "a statement for a deployment other than the selected one", S, { deployment: other }, /not the selected/);
add("no-expected-deployment", "no expected deployment: fail closed", S, { deployment: undefined }, /no expected deployment/);
add("other-instance-bound", "the deployment bound to another instance", S, { instanceIds: ["ab".repeat(32)] }, /not one bound/);
add("other-app", "the caller expects another app", S, { appId: "0c".repeat(32) }, /names another app/);
for (const k of ["proofKey", "proofOfTime", "registry", "operator"]) add(`edited-${k}`, `${k} edited after signing`, { ...S, [k]: "0x" + "12".repeat(20) }, {}, /not signed by the attested transport key/);
add("edited-enclaveId", "enclaveId edited after signing", { ...S, enclaveId: "0x" + "34".repeat(32) }, {}, /not signed by the attested transport key/);
add("edited-chainId", "chainId edited after signing", { ...S, chainId: "1" }, {}, /not signed by the attested transport key/);
for (const [n, bad] of [["hex", "0x7a69"], ["leading-zero", "031337"], ["2^64", "18446744073709551616"], ["zero", "0"], ["negative", "-1"]])
  add(`chainId-${n}`, `a non-canonical chainId (${bad})`, { ...S, chainId: bad }, {}, /chainId is not a canonical/);
add("uppercase-address", "an address in uppercase hex", { ...S, proofKey: "0x" + S.proofKey.slice(2).toUpperCase() }, {}, /proofKey is not 0x \+ 40 lowercase hex/);
add("short-bytes32", "a bytes32 too short", { ...S, enclaveId: S.enclaveId.slice(0, 40) }, {}, /enclaveId is not 0x \+ 64 lowercase hex/);
add("zero-proof-key", "the zero proof key", { ...S, proofKey: "0x" + "00".repeat(20) }, {}, /zero address/);
add("instance-not-the-evidence", "an instance value the evidence does not prove", { ...S, instance: { type: "pvm-instance-id", value: "ab".repeat(32) } }, { instanceIds: undefined }, /not the one its evidence proves/);
add("instance-type-snp", "another platform's instance type", { ...S, instance: { ...S.instance, type: "snp-host-data" } }, {}, /not pvm-instance-id/);
add("instance-type-unknown", "an instance type outside the closed table", { ...S, instance: { ...S.instance, type: "tdx-rtmr" } }, {}, /not pvm-instance-id/);
add("sigAlg-ecdsa", "another signature algorithm", { ...S, sigAlg: "ecdsa-p256-sha256" }, {}, /not ed25519/);
add("extra-field", "an unknown field", { ...S, extra: 1 }, {}, /fields must be exactly/);
add("evidence-v2", "a v2 envelope in place of v3", { ...S, evidence: { ...S.evidence, format: "enclave-pvm-app-evidence/v2" } }, {}, /refused as a downgrade/);

// ---- the Pixel's own checkpoints, against the device statement's claims ----
const claims = cases[0].want.claims;
const cps = [];
const addCp = async (name, what, doc, over, intent) => {
  const r = await verifyPvmCheckpoint(doc, { pins: claims, proofKey: claims.proofKey, ...over });
  if (intent === null) { if (!r.ok) throw new Error(`${name}: expected ok, got ${r.reasons[0]}`); }
  else if (r.ok || !intent.test(r.reasons[0])) throw new Error(`${name}: expected a refusal matching ${intent}, got ${r.ok ? "ok" : r.reasons[0]}`);
  cps.push({ name, what, checkpoint: doc, pins: over.pins || claims, proofKey: over.proofKey || claims.proofKey,
             want: r.ok ? { ok: true, digest: r.checkpoint.digest } : { ok: false, reason: r.reasons[0] } });
};
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
for (const l of ["checkpoint-a1", "checkpoint-a2"]) await addCp(`device-${l}`, `the Pixel's ${l}, signed by the attested proof key`, call(l).answer, {}, null);
const C = call("checkpoint-a1").answer, s = BigInt("0x" + C.sig.slice(66, 130)), vv = parseInt(C.sig.slice(130), 16);
await addCp("high-s", "the same signature with s -> n - s (and v flipped): the contract's malleability guard",
            { ...C, sig: C.sig.slice(0, 66) + (N - s).toString(16).padStart(64, "0") + (vv === 27 ? "1c" : "1b") }, {}, /s is high/);
await addCp("v-29", "v outside 27/28", { ...C, sig: C.sig.slice(0, 130) + "1d" }, {}, /v is 29/);
await addCp("other-deployment", "a checkpoint naming another deployment", { ...C, deployment: other }, {}, /deployment is not the verified statement's/);
await addCp("other-signer", "the same checkpoint expected from another proof key", C, { proofKey: "0x" + "12".repeat(20) }, /not the attested proof key/);
await addCp("edited-upto", "upto edited after signing", { ...C, upto: String(BigInt(C.upto) + 1n) }, {}, /not the attested proof key/);

const out = { type: "enclave-pvm-proof-key-fixtures/1", generatedBy: "test/fixtures/pvm-proof-key/make-fixtures.mjs",
  source: "shielded/anchor/avf/results/pvm-cpu-proof-key (the Pixel 10 device run)", spec: "shielded/anchor/avf/PROOF-KEY.md",
  note: "REAL device evidence: verify at `expect.now` (the run's time); the lease values are a LOCAL anvil chain's (run.json)", lease: { pins: run.pins, addresses: run.addresses },
  statements: cases, checkpoints: cps };
fs.writeFileSync(path.join(HERE, "fixtures.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${cases.length} statement cases and ${cps.length} checkpoint cases`);
