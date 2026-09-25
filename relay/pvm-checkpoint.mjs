// pvm-checkpoint.mjs -- a pVM runner's EnclaveProofOfTime checkpoint, checked BEFORE any chain sees it
// (shielded/anchor/avf/PROOF-KEY.md). The VM answers `CHECKPOINT <upto> <anchorBlock> <anchorHash>` with one
// "enclave-pvm-checkpoint/v1" object; this holds it to the pins a verified proof-key statement named (relay/pvm-app-attest.mjs
// verifyPvmProofKey) and recovers its signer, which must be the attested proof key. The chain re-checks everything that is
// its to check (the anchor's freshness, the window, the lease) -- this only refuses what can be refused offline: another
// deployment, domain or operator, a malformed or high-s signature, another signer.
//   typedDataOf(pins, { upto, anchorBlock, anchorHash })       -> the EIP-712 typed data (viem's shape), for posting and tests
//   verifyPvmCheckpoint(doc, { pins, proofKey })              -> Promise<{ ok, reasons, checkpoint }>
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { canonicalChainId } from "./pvm-app-attest.mjs";

export const CHECKPOINT_FORMAT = "enclave-pvm-checkpoint/v1";
export const PROOF_TYPES = { ProofOfTime: [{ name: "id", type: "bytes32" }, { name: "enclaveId", type: "bytes32" }, { name: "operator", type: "address" },
  { name: "upto", type: "uint64" }, { name: "anchorBlock", type: "uint64" }, { name: "anchorHash", type: "bytes32" }] };
const KEYS = ["anchorBlock", "anchorHash", "chainId", "deployment", "enclaveId", "format", "operator", "proofOfTime", "registry", "sig", "upto"];
const ADDR = /^0x[0-9a-f]{40}$/, B32 = /^0x[0-9a-f]{64}$/;
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const u64 = (s) => (typeof s === "string" && /^(0|[1-9][0-9]{0,19})$/.test(s) && BigInt(s) < 1n << 64n ? BigInt(s) : null);

export function typedDataOf(pins, { upto, anchorBlock, anchorHash }) {
  return { domain: { name: "EnclaveProofOfTime", version: "1", chainId: BigInt(pins.chainId), verifyingContract: pins.proofOfTime },
           types: PROOF_TYPES, primaryType: "ProofOfTime",
           message: { id: pins.deployment, enclaveId: pins.enclaveId, operator: pins.operator, upto: BigInt(upto), anchorBlock: BigInt(anchorBlock), anchorHash } };
}

export async function verifyPvmCheckpoint(doc, { pins, proofKey } = {}) {
  const no = (m) => ({ ok: false, reasons: [m], checkpoint: null });
  if (!pins || !proofKey) return no("no verified pins or proof key: refusing (fail closed)");
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return no("the checkpoint is not an object");
  if (Object.keys(doc).sort().join() !== KEYS.join()) return no(`the checkpoint's fields must be exactly ${KEYS.join(",")}`);
  if (doc.format !== CHECKPOINT_FORMAT) return no(`the checkpoint's format is not ${CHECKPOINT_FORMAT}`);
  for (const k of ["proofOfTime", "registry", "operator"]) if (!ADDR.test(doc[k] || "")) return no(`${k} is not 0x + 40 lowercase hex`);
  for (const k of ["deployment", "enclaveId", "anchorHash"]) if (!B32.test(doc[k] || "")) return no(`${k} is not 0x + 64 lowercase hex`);
  if (canonicalChainId(doc.chainId) === null) return no("chainId is not a canonical decimal in 1..2^64-1");
  const upto = u64(doc.upto), anchorBlock = u64(doc.anchorBlock);
  if (upto === null || anchorBlock === null) return no("upto and anchorBlock must be canonical u64 decimals");
  for (const k of ["chainId", "proofOfTime", "registry", "deployment", "enclaveId", "operator"])
    if (doc[k] !== pins[k]) return no(`the checkpoint's ${k} is not the verified statement's (${String(doc[k]).slice(0, 18)}… vs ${String(pins[k]).slice(0, 18)}…)`);
  if (!/^0x[0-9a-f]{130}$/.test(doc.sig || "")) return no("the signature is not 0x + 65 bytes of lowercase hex");
  const s = BigInt("0x" + doc.sig.slice(66, 130)), v = parseInt(doc.sig.slice(130), 16);
  if (v !== 27 && v !== 28) return no(`the signature's v is ${v}, not 27 or 28`);
  if (s > HALF_N) return no("the signature's s is high: the contract refuses it (malleability guard)");
  const td = typedDataOf(pins, { upto, anchorBlock, anchorHash: doc.anchorHash });
  let signer;
  try { signer = (await recoverTypedDataAddress({ ...td, signature: doc.sig })).toLowerCase(); } catch (e) { return no(`the signature does not recover: ${e.message}`); }
  if (signer !== proofKey) return no(`the checkpoint is signed by ${signer}, not the attested proof key ${proofKey}`);
  return { ok: true, reasons: [`a ProofOfTime checkpoint by the attested proof key for deployment ${doc.deployment.slice(0, 18)}…, upto ${upto}`],
           checkpoint: { id: doc.deployment, enclaveId: doc.enclaveId, upto, anchorBlock, anchorHash: doc.anchorHash, sig: doc.sig, digest: hashTypedData(td) } };
}
