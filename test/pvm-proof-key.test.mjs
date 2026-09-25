// The pVM lease proof key (shielded/anchor/avf/PROOF-KEY.md, agreed with the verifier session and the Linux isolation owner),
// end to end on a LOCAL lease: the REAL EnclaveRegistry, EnclaveDeployments and EnclaveProofOfTime on anvil
// (test/fixtures/lease-chain.mjs: no network, no funds, nothing public), a fake VM that speaks the device's wire protocol
// (test/fixtures/pvm-fake-vm.mjs: PROOFKEY, CHECKPOINT) and the canonical verifier (relay/pvm-app-attest.mjs
// verifyPvmProofKey; relay/pvm-checkpoint.mjs). The owner's order: the tenant creates and funds a deployment; the VM starts
// with its pins; its attested statement is verified; the OPERATOR (a separate account -- the gas wallet) registers exactly
// the attested proof key and claims; checkpoints the VM signs are posted by anyone and advance provenUntil. Every refusal
// the proposal lists is shown where it belongs: the chain, the VM, or the verifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyPvmProofKey } from "../relay/pvm-app-attest.mjs";
import { verifyPvmCheckpoint } from "../relay/pvm-checkpoint.mjs";
import { tmpdir, makeCa, haveOpenssl, AUTH } from "./fixtures/avf-synthetic.mjs";
import { startFakeVm, newInstance, PIXEL } from "./fixtures/pvm-fake-vm.mjs";
import { startLeaseChain, haveAnvil } from "./fixtures/lease-chain.mjs";
import net from "node:net";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const APP = "1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339";
const CODE = createHash("sha256").update("pvm proof-key test build").digest();
const ask = (port, line) => new Promise((resolve, reject) => {
  const c = net.connect(port, "127.0.0.1", () => c.write(line + "\n")); let b = "";
  c.on("data", (d) => (b += d)); c.on("end", () => { try { resolve(JSON.parse(b.split("\n")[0])); } catch (e) { reject(e); } }); c.on("error", reject);
});
const nonceHex = () => sha(String(Math.random()) + Date.now());

test("a LOCAL lease on the real contracts: the attested proof key registered by the operator, VM-signed checkpoints advancing provenUntil, and every refusal where it belongs",
     { skip: (!haveOpenssl && "no openssl") || (!haveAnvil && "no anvil"), timeout: 240000 }, async () => {
  const dir = tmpdir("pvm-pk-"), ca = makeCa(dir);
  const chain = await startLeaseChain();
  const vms = [];
  try {
    const endpoint = "https://api.enclave.host/t/pixel10-pvm-cpu", V = await import("viem");
    const enclaveId = V.keccak256(V.stringToBytes(endpoint));
    const D = await chain.createFunded(), D2 = await chain.createFunded();
    const pins = chain.pins(D, enclaveId), I = newInstance(), seed = Buffer.from(sha("instance secret: enclave-pvm-proof-key-v1"), "hex");   // gitleaks:allow -- a test LABEL standing in for the VM instance secret
    const vm = await startFakeVm({ dir, ca, code: CODE, appId: APP, instance: I, proofSeed: seed, proofPins: pins, checkpointEveryMs: 50 }); vms.push(vm);
    const expect = (nonce, over = {}) => ({ nonce, appId: APP, allowedRuntimeIds: [sha(PIXEL)], allowedCodeHashes: [CODE.toString("hex")],
      allowedAuthorityHashes: [AUTH.toString("hex")], rootPins: [ca.rootPin], instanceIds: [vm.instanceId], deployment: D, ...over });

    // ---- the attested statement, verified by the canonical module ----
    const n1 = nonceHex(), st = await ask(vm.evidencePort, `PROOFKEY ${n1}`);
    const v = verifyPvmProofKey(st, expect(n1));
    assert.equal(v.ok, true, v.reasons.at(-1));
    assert.deepEqual(v.claims, { proofKey: vm.proofKey, ...pins, instanceId: vm.instanceId, appId: APP, codeHash: CODE.toString("hex") });
    // ---- verifier refusals ----
    const refused = (doc, e, re, what) => { const r = verifyPvmProofKey(doc, e); assert.equal(r.ok, false, what); assert.match(r.reasons.at(-1), re, what); };
    refused(st, expect(nonceHex()), /answers another nonce/, "the same statement under a NEW nonce fails at the nonce");
    refused(st, expect(n1, { deployment: D2 }), /not the selected/, "a deployment other than the selected one");
    refused(st, expect(n1, { deployment: undefined }), /no expected deployment/, "no expected deployment: fail closed");
    refused(st, expect(n1, { instanceIds: ["ab".repeat(32)] }), /not one bound/, "another instance for a bound deployment");
    refused(st, expect(n1, { appId: "0c".repeat(32) }), /names another app/, "another app");
    for (const k of ["proofKey", "proofOfTime", "registry", "operator"])
      refused({ ...st, [k]: "0x" + "12".repeat(20) }, expect(n1), /not signed by the attested transport key/, `${k} edited`);
    for (const k of ["enclaveId"]) refused({ ...st, [k]: "0x" + "34".repeat(32) }, expect(n1), /not signed by the attested transport key/, `${k} edited`);
    refused({ ...st, chainId: "1" }, expect(n1), /not signed by the attested transport key/, "chainId edited");
    for (const bad of ["0x7a69", "031337", "18446744073709551616", "-1", "0", " 31337", "31337.0"]) refused({ ...st, chainId: bad }, expect(n1), /chainId is not a canonical/, `chainId ${bad}`);
    refused({ ...st, proofKey: st.proofKey.toUpperCase().replace("0X", "0x") }, expect(n1), /proofKey is not 0x \+ 40 lowercase hex/, "an uppercase address");
    refused({ ...st, enclaveId: st.enclaveId.slice(0, 40) }, expect(n1), /enclaveId is not 0x \+ 64 lowercase hex/, "a short bytes32");
    refused({ ...st, proofKey: "0x" + "00".repeat(20) }, expect(n1), /zero address/, "the zero proof key");
    refused({ ...st, instance: { type: "pvm-instance-id", value: "ab".repeat(32) } }, expect(n1, { instanceIds: undefined }), /not the one its evidence proves/, "an instance not the evidence's");
    refused({ ...st, instance: { type: "snp-host-data", value: st.instance.value } }, expect(n1), /not pvm-instance-id/, "another platform's instance type");
    refused({ ...st, sigAlg: "ecdsa-p256-sha256" }, expect(n1), /not ed25519/, "another signature algorithm");
    refused({ ...st, extra: 1 }, expect(n1), /fields must be exactly/, "an unknown field");
    const v2env = await ask(vm.evidencePort, `EVIDENCE ${n1}`);
    refused({ ...st, evidence: v2env }, expect(n1), /refused as a downgrade/, "a v2 envelope in place of v3");
    refused({ ...st, evidence: v2env }, expect(n1, { instanceIds: undefined }), /names no instance/, "a v2 envelope, unbound expectation");

    // ---- the operator registers EXACTLY the attested key, claims; the VM's checkpoints advance provenUntil ----
    assert.equal(await chain.register({ endpoint, proofKey: v.claims.proofKey }), enclaveId);
    assert.equal(await chain.registeredProofKey(enclaveId), v.claims.proofKey, "the registry carries the attested key");
    await chain.claim(D, enclaveId);
    const proven = [await chain.provenUntil(D)];
    const cp = async (upto, a) => { a = a || await chain.anchor(); return ask(vm.evidencePort, `CHECKPOINT ${upto} ${a.anchorBlock} ${a.anchorHash.slice(2)}`); };
    for (let i = 0; i < 3; i++) {
      await chain.advance(120);
      const now = await chain.now(), doc = await cp(now);
      const c = await verifyPvmCheckpoint(doc, { pins: v.claims, proofKey: v.claims.proofKey });
      assert.equal(c.ok, true, c.reasons[0]);
      const r = await chain.checkpoint({ ...c.checkpoint });
      assert.equal(r.ok, true, r.reason); assert.ok(r.provenUntil > proven.at(-1), "provenUntil advanced"); proven.push(r.provenUntil);
      await new Promise((res) => setTimeout(res, 60));
      if (i === 2) {   // the same checkpoint again: the chain refuses it
        const again = await chain.checkpoint({ ...c.checkpoint });
        assert.equal(again.ok, false); assert.match(again.reason, /nothing to prove/, "a replay");
      }
    }
    // ---- chain refusals ----
    await chain.advance(120); await new Promise((res) => setTimeout(res, 60));
    const good = await verifyPvmCheckpoint(await cp(await chain.now()), { pins: v.claims, proofKey: v.claims.proofKey });
    assert.equal(good.ok, true);
    assert.match((await chain.checkpoint({ ...good.checkpoint, id: D2 })).reason, /not the runner|bad proof signature/, "D's signature posted for D2");
    assert.match((await chain.checkpoint({ ...good.checkpoint, enclaveId: "0x" + "77".repeat(32) })).reason, /not the runner/, "another enclaveId");
    const rogue = await startFakeVm({ dir, ca, code: CODE, appId: APP, instance: I, proofSeed: Buffer.from(sha("another instance"), "hex"), proofPins: pins, checkpointEveryMs: 1 }); vms.push(rogue);
    const a1 = await chain.anchor(), forged = await ask(rogue.evidencePort, `CHECKPOINT ${await chain.now()} ${a1.anchorBlock} ${a1.anchorHash.slice(2)}`);
    assert.match((await verifyPvmCheckpoint(forged, { pins: v.claims, proofKey: v.claims.proofKey })).reasons[0], /not the attested proof key/, "another key, refused offline");
    assert.match((await chain.checkpoint({ id: D, enclaveId, upto: forged.upto, anchorBlock: forged.anchorBlock, anchorHash: forged.anchorHash, sig: forged.sig })).reason,
                 /bad proof signature/, "another key, refused by the chain");
    for (let i = 0; i < 300; i++) await chain.advance(1);   // the anchor falls out of blockhash range
    assert.match((await chain.checkpoint({ ...good.checkpoint })).reason, /stale or unknown anchor/, "a stale anchor");
    await assert.rejects(chain.setProofKey(enclaveId, "0x" + "99".repeat(20), chain.accounts.stranger), /reverted|not operator/, "setProofKey by a non-operator");
    // ---- offline checkpoint refusals: high s, bad v, other pins ----
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n, sig = good.checkpoint.sig;
    const s = BigInt("0x" + sig.slice(66, 130)), vv = parseInt(sig.slice(130), 16);
    const hi = sig.slice(0, 66) + (N - s).toString(16).padStart(64, "0") + (vv === 27 ? "1c" : "1b");
    const base = await cp(0).catch(() => null);   // (rate / monotonic refusal below; this call is refused, which is fine)
    const doc0 = { format: "enclave-pvm-checkpoint/v1", ...Object.fromEntries(["chainId", "proofOfTime", "registry", "deployment", "enclaveId", "operator"].map((k) => [k, v.claims[k]])),
                   upto: String(good.checkpoint.upto), anchorBlock: String(good.checkpoint.anchorBlock), anchorHash: good.checkpoint.anchorHash, sig };
    assert.equal((await verifyPvmCheckpoint(doc0, { pins: v.claims, proofKey: v.claims.proofKey })).ok, true, "the reassembled good checkpoint verifies");
    assert.match((await verifyPvmCheckpoint({ ...doc0, sig: hi }, { pins: v.claims, proofKey: v.claims.proofKey })).reasons[0], /s is high/);
    assert.match((await verifyPvmCheckpoint({ ...doc0, sig: sig.slice(0, 130) + "1d" }, { pins: v.claims, proofKey: v.claims.proofKey })).reasons[0], /v is 29/);
    assert.match((await verifyPvmCheckpoint({ ...doc0, deployment: D2 }, { pins: v.claims, proofKey: v.claims.proofKey })).reasons[0], /deployment is not the verified statement's/);
    // ---- the VM's own refusals ----
    const vmRefuses = async (line, re, what) => { const r = await ask(vm.evidencePort, line); assert.ok(r.error && re.test(r.error), `${what}: ${JSON.stringify(r)}`); };
    await new Promise((res) => setTimeout(res, 60));
    const a2 = await chain.anchor();
    await vmRefuses(`CHECKPOINT ${good.checkpoint.upto} ${a2.anchorBlock} ${a2.anchorHash.slice(2)}`, /strictly increase/, "a non-increasing upto");
    await vmRefuses(`CHECKPOINT 1 2 zz`, /request is CHECKPOINT/, "a malformed request");
    await vmRefuses(`CHECKPOINT 0x10 2 ${"aa".repeat(32)}`, /request is CHECKPOINT/, "a hex upto");
    vm.setServing(false);
    await vmRefuses(`CHECKPOINT ${Number(good.checkpoint.upto) + 500} ${a2.anchorBlock} ${a2.anchorHash.slice(2)}`, /not serving/, "the app not serving");
    vm.setServing(true);
    const slow = await startFakeVm({ dir, ca, code: CODE, appId: APP, instance: I, proofSeed: seed, proofPins: pins, checkpointEveryMs: 60000 }); vms.push(slow);
    assert.equal(slow.proofKey, vm.proofKey, "the same instance secret, the same proof key (a restart)");
    assert.ok((await ask(slow.evidencePort, `CHECKPOINT 10 ${a2.anchorBlock} ${a2.anchorHash.slice(2)}`)).sig);
    const rate = await ask(slow.evidencePort, `CHECKPOINT 11 ${a2.anchorBlock} ${a2.anchorHash.slice(2)}`);
    assert.match(rate.error, /at most one checkpoint every 60 s/, "the rate limit");
    const nopins = await startFakeVm({ dir, ca, code: CODE, appId: APP, instance: I, proofSeed: seed }); vms.push(nopins);
    assert.match((await ask(nopins.evidencePort, `CHECKPOINT 10 1 ${"aa".repeat(32)}`)).error, /no proof pins/);
    assert.match((await ask(nopins.evidencePort, `PROOFKEY ${nonceHex()}`)).error, /no proof pins/);
    void base;
  } finally { chain.stop(); for (const x of vms) x.close(); }
});
