// ABI/2 evidence from an app run in a Pixel pVM (shielded/anchor/avf/PVM-CPU.md, "The app runtime", milestone 5).
//
// The pVM CPU payload runs one portable WebAssembly component in its protected VM, compiled there to Pulley and
// interpreted (runtime/pvm-rt). Before the component runs, the payload asks the VM for a second AVF certificate whose
// 64-byte challenge is
//     Bind2(transport SPKI, attach nonce, RuntimeID(identity))  ||  AppID (the component's SHA-256)
// and prints the identity and the runtime self-test tuple beside it (payload/anchor_payload.c, app_attest_abi2). This file
// is the verifier: the chain to a pinned Google root, a secure VM, the published APK (relay/avf-verify.mjs), and a
// challenge that equals what the verifier recomputes from the stated identity, its own nonce, the transport key it
// holds, and the app it expects. A restated identity, another nonce, another key or another app changes the challenge.
//
// RuntimeID, Bind2 and the identity rules are the isolation contract's (isolation/contract/runtime.go and runtime.mjs,
// RUNTIME.md; the same judge rules as isolation/m2/judge.mjs checkRuntimeSelfTest). The contract is not on main yet, so
// they are restated here and pinned to the contract's vectors (test/pvm-app-attest.test.mjs, vectors from
// isolation/contract/vectors.json at fb5e466c). When the contract lands on main, import runtime.mjs instead.
//
// The rules themselves (closed shapes v1..v4, Bind2/Bind3, the identity and self-test, the instance, app and TLS keys) live in
// relay/pvm-evidence-core.mjs with the cryptography passed in, so the browser build runs the same text
// (verifier/web/pvm-host.mjs); this file supplies node:crypto and relay/avf-verify.mjs and keeps every export it had.
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { verifyAvfEvidence } from "./avf-verify.mjs";
import { pvmEvidenceRules, hex32 } from "./pvm-evidence-core.mjs";
export { BIND2_DOMAIN, BIND3_DOMAIN, INSTANCE_SIG_DOMAIN, canonical, validateRuntimeIdentity, instanceSigMessage, checkRuntimeSelfTest,
         PVM_APP_EVIDENCE_FORMAT, PVM_APP_EVIDENCE_FORMAT_V2, APP_KEY_DOMAIN, SEALED_WINDOW_SECONDS, SEALED_MAX_REQUESTS, appKeyMessage,
         PVM_APP_EVIDENCE_FORMAT_V3, APP_KEY_DOMAIN_V3, appKeyMessageV3, PVM_APP_EVIDENCE_FORMAT_V4, TLS_KEY_DOMAIN } from "./pvm-evidence-core.mjs";

const NODE_CRYPTO = {
  sha256: (b) => createHash("sha256").update(b).digest(),
  ed25519Verify: (spki, message, signature) => cryptoVerify(null, message, createPublicKey({ key: spki, format: "der", type: "spki" }), signature),
  isP256Spki: (der) => { try { createPublicKey({ key: der, format: "der", type: "spki" }); return true; } catch { return false; } },
  verifyAvf: verifyAvfEvidence,
};
// runtimeId, bind2, bind3, instanceIdOf, tlsKeyMessage, verifyPvmAppAbi2 and verifyPvmAppEvidence: documented at their
// definitions in relay/pvm-evidence-core.mjs
export const { runtimeId, bind2, bind3, instanceIdOf, tlsKeyMessage, verifyPvmAppAbi2, verifyPvmAppEvidence } = pvmEvidenceRules(NODE_CRYPTO);

/** The app attestation's pieces from a captured pVM log (ABI2_LINK<i>[k], ABI2 runtime, ABI2 selftest, ABI2 binding, and v3's
 * ABI2 instance: the instance key, its signature over the challenge and the InstanceID the VM computed). */
export function abi2FromLog(text) {
  const certs = new Map();
  let identity = null, selftest = null, binding = null, instance = null;
  for (const line of text.split("\n")) {
    let m;
    if ((m = /ABI2_LINK(\d+)\[(\d+)\] ([0-9a-f]+)/.exec(line))) { const i = +m[1]; if (!certs.has(i)) certs.set(i, []); certs.get(i)[+m[2]] = m[3]; }
    else if ((m = /ABI2 runtime (\{.*\})\s*$/.exec(line))) identity = m[1];
    else if ((m = /ABI2 selftest (.*?)\s*$/.exec(line))) selftest = m[1];
    else if ((m = /ABI2 binding nonce=([0-9a-f]{64}) .* runtime_id=([0-9a-f]{64}) (bind2|bind3)=([0-9a-f]{64}) app=([0-9a-f]{64})/.exec(line)))
      binding = { nonce: m[1], runtimeId: m[2], [m[3]]: m[4], app: m[5] };
    else if ((m = /ABI2 instance key=([0-9a-f]{88}) sig=([0-9a-f]{128}) id=([0-9a-f]{64})/.exec(line)))
      instance = { instanceKey: m[1], instanceSig: m[2], instanceId: m[3] };
  }
  const chain = [...certs.keys()].sort((a, b) => a - b).map((i) => Buffer.from(certs.get(i).join(""), "hex"));
  return { chain, identity, selftest, binding, instance };
}

// ---- the lease proof key's attested statement (shielded/anchor/avf/PROOF-KEY.md; agreed with the verifier session and
// the Linux isolation owner): a platform-neutral "enclave-proof-key/v1" document whose pVM form carries a v3 envelope. The
// attested TRANSPORT key signs the proof key's address together with the exact domain and lease fields it will sign
// checkpoints for; the envelope is verified by verifyPvmAppEvidence above -- the only evidence parser -- and the InstanceID
// and AppID are taken from THAT verification, never from a field. ----
export const PROOF_KEY_FORMAT = "enclave-proof-key/v1";
export const PROOF_KEY_DOMAIN = "enclave-proof-key-v1\n";   // gitleaks:allow -- a public domain-separation string (PROOF-KEY.md), not a key
export const INSTANCE_TYPES = { "pvm-instance-id": 1, "snp-host-data": 2 };
// the attested transport key's algorithm, typed and signed (the SNP tier's front key is ECDSA P-256; the pVM's is Ed25519)
export const SIG_ALGS = { ed25519: 1, "ecdsa-p256-sha256": 2 };
const PK_KEYS = ["chainId", "deployment", "enclaveId", "evidence", "format", "instance", "operator", "proofKey", "proofOfTime", "registry", "sig", "sigAlg"];
const ADDR = /^0x[0-9a-f]{40}$/, B32 = /^0x[0-9a-f]{64}$/;
/** A canonical u64 decimal in 1..2^64-1 -> BigInt, else null (no sign, no leading zero, digits only). */
export function canonicalChainId(s) {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(s)) return null;
  const v = BigInt(s);
  return v >= 1n && v < 1n << 64n ? v : null;
}
/** The exact bytes the transport key signs. Every argument is already canonical (hex without 0x where raw). */
export function proofKeyMessage({ nonce, appId, instanceType, instanceValue, sigAlg, proofKey, chainId, proofOfTime, registry, deployment, enclaveId, operator }) {
  const u64 = Buffer.alloc(8); u64.writeBigUInt64BE(BigInt(chainId));
  const h = (x) => Buffer.from(String(x).replace(/^0x/, ""), "hex");
  return Buffer.concat([Buffer.from(PROOF_KEY_DOMAIN), h(nonce), h(appId), Buffer.from([instanceType]), h(instanceValue), Buffer.from([sigAlg]), h(proofKey), u64,
                        h(proofOfTime), h(registry), h(deployment), h(enclaveId), h(operator)]);
}
/**
 * verifyPvmProofKey(doc, expect) -> { ok, reasons, claims }   (claims include codeHash: the attested build, bare lowercase 64-hex)
 *   expect: the verifyPvmAppEvidence expectations (nonce, appId, pins, instanceIds for a bound deployment) PLUS
 *           deployment (REQUIRED: the client's selected deployment, 0x + 64 lowercase hex).
 *   claims: { proofKey, chainId, proofOfTime, registry, deployment, enclaveId, operator, instanceId, appId } -- the caller
 *           compares chainId/proofOfTime/registry with its address book, operator/enclaveId with the ledger row, and
 *           proofKey with EnclaveRegistry.get(enclaveId).proofKey, and releases nothing on a mismatch.
 */
export function verifyPvmProofKey(doc, expect = {}) {
  const no = (m, reasons = []) => ({ ok: false, reasons: [...reasons, m], claims: null });
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return no("the proof-key statement is not an object");
  if (Object.keys(doc).sort().join() !== PK_KEYS.join()) return no(`the proof-key statement's fields must be exactly ${PK_KEYS.join(",")}`);
  if (doc.format !== PROOF_KEY_FORMAT) return no(`the statement's format is not ${PROOF_KEY_FORMAT}`);
  if (typeof expect.deployment !== "string" || !B32.test(expect.deployment)) return no("no expected deployment (0x + 64 lowercase hex): refusing (fail closed)");
  const i = doc.instance;
  if (!i || typeof i !== "object" || Array.isArray(i) || Object.keys(i).sort().join() !== "type,value") return no("the statement's instance must be exactly { type, value }");
  if (i.type !== "pvm-instance-id") return no(`instance type ${JSON.stringify(i.type)} is not pvm-instance-id: this verifier reads pVM statements only`);
  if (typeof i.value !== "string" || !/^[0-9a-f]{64}$/.test(i.value)) return no("the instance value is not 64 lowercase hex");
  if (doc.sigAlg !== "ed25519") return no(`sigAlg ${JSON.stringify(doc.sigAlg)} is not ed25519: a pVM statement is signed by the Ed25519 transport key`);
  for (const k of ["proofKey", "proofOfTime", "registry", "operator"]) if (typeof doc[k] !== "string" || !ADDR.test(doc[k])) return no(`${k} is not 0x + 40 lowercase hex`);
  for (const k of ["deployment", "enclaveId"]) if (typeof doc[k] !== "string" || !B32.test(doc[k])) return no(`${k} is not 0x + 64 lowercase hex`);
  if (/^0x0{40}$/.test(doc.proofKey)) return no("the proof key is the zero address");
  const chainId = canonicalChainId(doc.chainId);
  if (chainId === null) return no("chainId is not a canonical decimal in 1..2^64-1");
  if (typeof doc.sig !== "string" || !/^[0-9a-f]{128}$/.test(doc.sig)) return no("the statement's sig is not 128 lowercase hex");
  if (doc.deployment !== expect.deployment) return no(`the statement is for deployment ${doc.deployment.slice(0, 18)}…, not the selected ${expect.deployment.slice(0, 18)}…`);
  const { deployment: _d, ...evExpect } = expect;
  const v = verifyPvmAppEvidence(doc.evidence, evExpect);
  if (!v.ok) return no(`the statement's evidence: ${v.reasons.at(-1)}`, v.reasons.slice(0, -1));
  if (!v.instanceId) return no("the statement's evidence names no instance (v3 required)", v.reasons);
  if (i.value !== v.instanceId) return no("the statement's instance is not the one its evidence proves", v.reasons);
  const msg = proofKeyMessage({ nonce: hex32(expect.nonce, "nonce").toString("hex"), appId: v.appId, instanceType: INSTANCE_TYPES["pvm-instance-id"],
    instanceValue: v.instanceId, sigAlg: SIG_ALGS.ed25519, proofKey: doc.proofKey, chainId, proofOfTime: doc.proofOfTime, registry: doc.registry, deployment: doc.deployment,
    enclaveId: doc.enclaveId, operator: doc.operator });
  let ok = false;
  try { ok = cryptoVerify(null, msg, createPublicKey({ key: Buffer.from(v.transportSpki, "hex"), format: "der", type: "spki" }), Buffer.from(doc.sig, "hex")); } catch { ok = false; }
  if (!ok) return no("the statement is not signed by the attested transport key over these fields", v.reasons);
  // the build the VM attests (the AVF anchor's code hash, one of expect.allowedCodeHashes): bare lowercase 64-hex, the form the
  // pins use, so a consumer (the runner agent's registered measurement; the verifier session's independent reading) compares
  // it byte for byte
  if (typeof v.measurement !== "string" || !/^[0-9a-f]{64}$/.test(v.measurement)) return no("the attested code hash is not 64 lowercase hex", v.reasons);
  return { ok: true, reasons: [...v.reasons, `the attested transport key vouches for proof key ${doc.proofKey} on chain ${chainId}, deployment ${doc.deployment.slice(0, 18)}…`],
           claims: { proofKey: doc.proofKey, chainId: chainId.toString(), proofOfTime: doc.proofOfTime, registry: doc.registry, deployment: doc.deployment,
                     enclaveId: doc.enclaveId, operator: doc.operator, instanceId: v.instanceId, appId: v.appId, codeHash: v.measurement } };
}
