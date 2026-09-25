// verifier/pvm-proof-key.mjs: the consumer-side gate over a pVM runner's lease PROOF KEY statement
// ("enclave-proof-key/v1", shielded/anchor/avf/PROOF-KEY.md, agreed 2026-09-24 with the pVM owner and the Linux isolation
// owner) and over the ProofOfTime CHECKPOINTS that key signs ("enclave-pvm-checkpoint/v1"). The owner's canonical verifiers
// (relay/pvm-app-attest.mjs verifyPvmProofKey and relay/pvm-checkpoint.mjs verifyPvmCheckpoint, at the pvm-app-attest pin)
// are run and must agree, and this file ADDS what a consumer must not take from the module it is judging:
//   1. the evidence inside the statement is re-verified through verifier/pvm-evidence.mjs (this branch's consumer checks:
//      closed shape, v3 only, no downgrade, the echo, the instance rules) and the owner's claims are held to that reading;
//   2. the 271-byte message is rebuilt HERE from PROOF-KEY.md and the Ed25519 signature is checked under the transport SPKI
//      that re-verification returned, so the module's message builder is not the only reading of the bytes;
//   3. the statement is held to the CONSUMER'S PINS before any cryptography: chainId, proofOfTime and registry from the
//      address book (a pinned commit, never the statement), deployment from the selected policy entry, and, when the
//      caller has the ledger row, operator and enclaveId. The owner's verifier compares only the deployment; a statement
//      for another chain or another contract verifies there and is refused here;
//   4. a checkpoint's EIP-712 digest is recomputed from EnclaveProofOfTime.sol's own type strings (domain separator and
//      struct hash by hand, as the contract encodes them) and its signer recovered; the owner's digest must equal it.
// A proof-key verdict ADMITS NOTHING (admissionSafe is always false): it names the key a checkpoint must be signed by and the
// exact lease it may sign for. A checkpoint verdict says the bytes are a ProofOfTime the attested key signed for this lease;
// what the chain still decides (the anchor's freshness, the window, the lease) is stated in PROOF-KEY.md and not judged here.
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { keccak256, encodeAbiParameters, parseAbiParameters, toHex, concatHex, recoverAddress } from "viem";
import { verifyPvmEvidence, loadOwnerModule, STRICT_INTEGRATION, PVM_EVIDENCE_FORMAT_V3 } from "./pvm-evidence.mjs";

export const PROOF_KEY_FORMAT = "enclave-proof-key/v1";
export const PROOF_KEY_HEADER = "enclave-proof-key-v1\n";      // gitleaks:allow -- a public domain-separation string, not a key
export const PROOF_KEY_MESSAGE_BYTES = 271;                    // 21 + 32 + 32 + 1 + 32 + 1 + 20 + 8 + 20 + 20 + 32 + 32 + 20
export const INSTANCE_TYPE_PVM = "pvm-instance-id", INSTANCE_TYPE_BYTE_PVM = 0x01;
export const SIG_ALG_ED25519 = "ed25519", SIG_ALG_BYTE_ED25519 = 0x01;
export const CHECKPOINT_FORMAT = "enclave-pvm-checkpoint/v1";
// EnclaveProofOfTime.sol's own strings (contracts/EnclaveProofOfTime.sol); the suite holds these equal to the source
export const EIP712_DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
export const PROOF_OF_TIME_DOMAIN = Object.freeze({ name: "EnclaveProofOfTime", version: "1" });
export const PROOF_OF_TIME_TYPE = "ProofOfTime(bytes32 id,bytes32 enclaveId,address operator,uint64 upto,uint64 anchorBlock,bytes32 anchorHash)";
export const MAX_STATEMENT_BYTES = 320 * 1024;                 // the evidence's own bound is 256 KiB (pvm-evidence.mjs)
const STATEMENT_KEYS = ["chainId", "deployment", "enclaveId", "evidence", "format", "instance", "operator", "proofKey", "proofOfTime", "registry", "sig", "sigAlg"];
const CHECKPOINT_KEYS = ["anchorBlock", "anchorHash", "chainId", "deployment", "enclaveId", "format", "operator", "proofOfTime", "registry", "sig", "upto"];
const ADDR = /^0x[0-9a-f]{40}$/, B32 = /^0x[0-9a-f]{64}$/, HEX64 = /^[0-9a-f]{64}$/, ZERO_ADDR = "0x" + "0".repeat(40);
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const short = (h) => String(h).slice(0, 18) + "…";
const toBuf = (x) => (Buffer.isBuffer(x) ? x : typeof x === "string" && /^[0-9a-f]*$/i.test(x) ? Buffer.from(x, "hex") : Buffer.alloc(0));

/** A canonical u64 decimal ("0" or no leading zero, digits only, < 2^64) -> BigInt, else null. */
export function canonicalU64(s) {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(s)) return null;
  const v = BigInt(s);
  return v < 1n << 64n ? v : null;
}
/** A canonical chain id: a u64 decimal in 1..2^64-1 -> BigInt, else null. */
export function canonicalChainId(s) { const v = canonicalU64(s); return v !== null && v >= 1n ? v : null; }

/** The 271 bytes the attested transport key signs (PROOF-KEY.md), built from this verifier's reading of the spec. */
export function proofKeyMessage({ nonce, appId, instanceId, proofKey, chainId, proofOfTime, registry, deployment, enclaveId, operator }) {
  const h = (x, n, what) => { const b = Buffer.isBuffer(x) ? x : toBuf(String(x).replace(/^0x/, "")); if (b.length !== n) throw new Error(`${what} is not ${n} bytes`); return b; };
  const id = typeof chainId === "bigint" ? chainId : canonicalChainId(chainId);
  if (id === null) throw new Error("chainId is not canonical");
  const u64 = Buffer.alloc(8); u64.writeBigUInt64BE(id);
  const m = Buffer.concat([Buffer.from(PROOF_KEY_HEADER, "latin1"), h(nonce, 32, "nonce"), h(appId, 32, "appId"), Buffer.from([INSTANCE_TYPE_BYTE_PVM]), h(instanceId, 32, "instanceId"),
    Buffer.from([SIG_ALG_BYTE_ED25519]), h(proofKey, 20, "proofKey"), u64, h(proofOfTime, 20, "proofOfTime"), h(registry, 20, "registry"), h(deployment, 32, "deployment"), h(enclaveId, 32, "enclaveId"), h(operator, 20, "operator")]);
  if (m.length !== PROOF_KEY_MESSAGE_BYTES) throw new Error(`the message is ${m.length} bytes, not ${PROOF_KEY_MESSAGE_BYTES}`);
  return m;
}

/** The checkpoint digest exactly as EnclaveProofOfTime.proofDigest computes it (abi.encode of the type hashes and fields). */
export function proofOfTimeDigest({ chainId, proofOfTime, id, enclaveId, operator, upto, anchorBlock, anchorHash }) {
  const domainSeparator = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"),
    [keccak256(toHex(EIP712_DOMAIN_TYPE)), keccak256(toHex(PROOF_OF_TIME_DOMAIN.name)), keccak256(toHex(PROOF_OF_TIME_DOMAIN.version)), BigInt(chainId), proofOfTime]));
  const structHash = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, address, uint64, uint64, bytes32"),
    [keccak256(toHex(PROOF_OF_TIME_TYPE)), id, enclaveId, operator, BigInt(upto), BigInt(anchorBlock), anchorHash]));
  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}

/** The owner's canonical modules at the pin: { statement: relay/pvm-app-attest.mjs, checkpoint: relay/pvm-checkpoint.mjs }, or null. */
export async function loadProofKeyModules() {
  const m = await loadOwnerModule();
  if (!m) return null;
  if (typeof m.verifyPvmProofKey !== "function" || typeof m.proofKeyMessage !== "function") {
    if (STRICT_INTEGRATION) throw new Error("strict integration: the pinned owner module has no verifyPvmProofKey/proofKeyMessage (pvm-app-attest at 047f7739 or later)");
    return null;
  }
  const modPath = process.env.ENCLAVE_PVM_MODULE || new URL("../relay/pvm-app-attest.mjs", import.meta.url).pathname;
  const cpPath = path.join(path.dirname(modPath), "pvm-checkpoint.mjs");
  let checkpoint = null;
  try { checkpoint = await import(pathToFileURL(cpPath).href); if (typeof checkpoint.verifyPvmCheckpoint !== "function") throw new Error("no verifyPvmCheckpoint export"); }
  catch (e) { if (STRICT_INTEGRATION) throw new Error(`strict integration: ${cpPath}: ${e.message}`); checkpoint = null; }
  return { statement: m, checkpoint };
}

const verdict = (family) => {
  const reasons = [], checks = {};
  const out = (status, extra = {}) => ({ status, admissionSafe: false, omissions: [], technology: "android-avf", family, reasons, checks, claims: null, ...extra });
  return { reasons, checks, out, fail: (check, m) => { reasons.push(`REJECT: ${m}`); checks[check] = false; return out("rejected"); } };
};

/**
 * verifyProofKey(doc, { expect, pins, now?, modules? }) -> verdict { status, reasons, checks, claims }
 *   expect: the v3 evidence expectations (nonce, appId, allowedRuntimeIds, allowedCodeHashes, allowedAuthorityHashes,
 *           rootPins, instanceIds for a bound deployment), as verifier/pvm-evidence.mjs takes them (hex or Buffer)
 *   pins:   { chainId, proofOfTime, registry, deployment, operator?, enclaveId? } -- the CONSUMER'S values (address book,
 *           policy selection, ledger row). Without them nothing is judged.
 *   claims: { proofKey, chainId, proofOfTime, registry, deployment, enclaveId, operator, instanceId, appId, codeHash,
 *             transportSpkiSha256, evidenceFormat } -- the input to verifyCheckpoint. codeHash (since the pvm-app-attest pin
 *             20054bab) is the attested build, bare lowercase 64-hex, checked HERE to be one of the consumer's own
 *             allowedCodeHashes, never taken from the owner's claims alone
 */
export async function verifyProofKey(doc, { expect = {}, pins = null, now = Date.now(), modules = null } = {}) {
  const V = verdict("pvm-proof-key"), { reasons, checks, out, fail } = V;
  // 0. the consumer's pins, first: a statement is judged against what THIS side knows, never against itself
  if (!pins || typeof pins !== "object" || Array.isArray(pins)) return fail("pins", "no consumer pins (chainId, proofOfTime, registry, deployment): refusing (fail closed)");
  const pinChain = canonicalChainId(pins.chainId);
  if (pinChain === null) return fail("pins", "pins.chainId is not a canonical decimal in 1..2^64-1");
  for (const k of ["proofOfTime", "registry"]) if (!ADDR.test(pins[k] ?? "")) return fail("pins", `pins.${k} is not 0x + 40 lowercase hex (the address book's value)`);
  if (!B32.test(pins.deployment ?? "")) return fail("pins", "pins.deployment is not 0x + 64 lowercase hex (the selected policy entry's id)");
  if (pins.operator !== undefined && !ADDR.test(pins.operator ?? "")) return fail("pins", "pins.operator is not 0x + 40 lowercase hex");
  if (pins.enclaveId !== undefined && !B32.test(pins.enclaveId ?? "")) return fail("pins", "pins.enclaveId is not 0x + 64 lowercase hex");
  // 1. the statement's closed shape and canonical forms (refused, never normalised)
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return fail("statement shape", "the statement is not an object");
  let size = 0; try { size = Buffer.byteLength(JSON.stringify(doc)); } catch { return fail("statement shape", "the statement is not serialisable"); }
  if (size > MAX_STATEMENT_BYTES) return fail("statement shape", `the statement exceeds ${MAX_STATEMENT_BYTES} bytes`);
  if (Object.keys(doc).sort().join(",") !== STATEMENT_KEYS.join(",")) return fail("statement shape", `the statement's fields must be exactly ${STATEMENT_KEYS.join(", ")}`);
  if (doc.format !== PROOF_KEY_FORMAT) return fail("statement shape", `the statement's format is not ${PROOF_KEY_FORMAT}`);
  const inst = doc.instance;
  if (!inst || typeof inst !== "object" || Array.isArray(inst) || Object.keys(inst).sort().join(",") !== "type,value") return fail("statement shape", "the statement's instance must be exactly { type, value }");
  if (inst.type !== INSTANCE_TYPE_PVM) return fail("statement shape", `instance type ${JSON.stringify(inst.type)} is not ${INSTANCE_TYPE_PVM}: a pVM statement carries no other type`);
  if (!HEX64.test(inst.value ?? "")) return fail("statement shape", "the instance value is not 64 lowercase hex");
  if (doc.sigAlg !== SIG_ALG_ED25519) return fail("statement shape", `sigAlg ${JSON.stringify(doc.sigAlg)} is not ${SIG_ALG_ED25519}: a pVM statement is signed by its Ed25519 transport key`);
  for (const k of ["proofKey", "proofOfTime", "registry", "operator"]) if (!ADDR.test(doc[k] ?? "")) return fail("statement shape", `${k} is not 0x + 40 lowercase hex`);
  for (const k of ["deployment", "enclaveId"]) if (!B32.test(doc[k] ?? "")) return fail("statement shape", `${k} is not 0x + 64 lowercase hex`);
  if (doc.proofKey === ZERO_ADDR) return fail("statement shape", "the proof key is the zero address");
  const chainId = canonicalChainId(doc.chainId);
  if (chainId === null) return fail("statement shape", "chainId is not a canonical decimal in 1..2^64-1");
  if (!/^[0-9a-f]{128}$/.test(doc.sig ?? "")) return fail("statement shape", "the statement's sig is not 128 lowercase hex (64 raw Ed25519 bytes)");
  checks["statement shape"] = true;
  // 2. the pins, before any cryptography
  if (doc.deployment !== pins.deployment) return fail("pins", `the statement is for deployment ${short(doc.deployment)}, not the selected ${short(pins.deployment)}`);
  if (chainId !== pinChain) return fail("pins", `the statement names chain ${doc.chainId}, not the consumer's ${pins.chainId}`);
  if (doc.proofOfTime !== pins.proofOfTime) return fail("pins", `the statement's proofOfTime ${short(doc.proofOfTime)} is not the address book's ${short(pins.proofOfTime)}`);
  if (doc.registry !== pins.registry) return fail("pins", `the statement's registry ${short(doc.registry)} is not the address book's ${short(pins.registry)}`);
  if (pins.operator !== undefined && doc.operator !== pins.operator) return fail("pins", `the statement's operator ${short(doc.operator)} is not the ledger row's ${short(pins.operator)}`);
  if (pins.enclaveId !== undefined && doc.enclaveId !== pins.enclaveId) return fail("pins", `the statement's enclaveId ${short(doc.enclaveId)} is not the ledger row's ${short(pins.enclaveId)}`);
  checks.pins = true; reasons.push(`the statement names the consumer's chain ${pins.chainId}, contracts and deployment ${short(pins.deployment)}${pins.operator !== undefined ? ", operator" : ""}${pins.enclaveId !== undefined ? ", runner" : ""}`);
  // 3. the evidence, through this branch's consumer checks: v3 only, the client's own nonce and app, bound instances
  const ev = { nonce: toBuf(expect.nonce), appId: toBuf(expect.appId), allowedRuntimeIds: expect.allowedRuntimeIds, allowedCodeHashes: expect.allowedCodeHashes,
    allowedAuthorityHashes: expect.allowedAuthorityHashes, rootPins: expect.rootPins, formats: [PVM_EVIDENCE_FORMAT_V3], ...(expect.instanceIds !== undefined ? { instanceIds: expect.instanceIds } : {}) };
  const e = await verifyPvmEvidence(doc.evidence, ev, { now });
  reasons.push(...e.reasons.map((r) => `evidence: ${r}`));
  if (e.status !== "verified") return fail("evidence", `the statement's evidence did not verify (${e.status})`);
  if (!e.claims.instanceId) return fail("evidence", "the statement's evidence names no instance (v3 required)");
  if (inst.value !== e.claims.instanceId) return fail("evidence", "the statement's instance is not the one its evidence proves");
  checks.evidence = true;
  // 4. the message, rebuilt here, and the signature under the transport key the re-verification returned
  let msg, sigOk = false;
  try {
    msg = proofKeyMessage({ nonce: ev.nonce, appId: e.claims.appId, instanceId: e.claims.instanceId, proofKey: doc.proofKey, chainId, proofOfTime: doc.proofOfTime, registry: doc.registry, deployment: doc.deployment, enclaveId: doc.enclaveId, operator: doc.operator });
    sigOk = cryptoVerify(null, msg, createPublicKey({ key: Buffer.from(e.claims.transportSpki, "hex"), format: "der", type: "spki" }), Buffer.from(doc.sig, "hex"));
  } catch { sigOk = false; }
  if (!sigOk) return fail("signature", `the statement is not signed by the attested transport key over the ${PROOF_KEY_MESSAGE_BYTES}-byte message rebuilt here`);
  checks.signature = true;
  // 5. the owner's canonical verifier must agree, and its claims must be this reading's
  const mods = modules || await loadProofKeyModules();
  if (!mods) { checks.owner = null; reasons.push("UNSUPPORTED: the owner's verifyPvmProofKey is not available here (pvm-app-attest at 047f7739 or later)"); return out("unsupported"); }
  let o;
  try { o = mods.statement.verifyPvmProofKey(doc, { nonce: ev.nonce, appId: ev.appId, allowedRuntimeIds: ev.allowedRuntimeIds, allowedCodeHashes: ev.allowedCodeHashes, allowedAuthorityHashes: ev.allowedAuthorityHashes, rootPins: ev.rootPins, ...(ev.instanceIds ? { instanceIds: ev.instanceIds } : {}), now, deployment: pins.deployment }); }
  catch (err) { return fail("owner", `the owner's verifier threw: ${err.message}`); }
  if (!o || o.ok !== true) return fail("owner", `the owner's verifier refused: ${o && Array.isArray(o.reasons) ? o.reasons.at(-1) : "no result"}`);
  // the attested build: the re-verified evidence's measurement, 64 lowercase hex, and one of the CONSUMER'S allowedCodeHashes
  // (compared here, independently of both modules); the owner's claims.codeHash must then be exactly this value
  const codeHash = typeof e.claims.measurement === "string" && HEX64.test(e.claims.measurement) ? e.claims.measurement : null;
  const consumerCodes = (Array.isArray(expect.allowedCodeHashes) ? expect.allowedCodeHashes : []).map((h) => (Buffer.isBuffer(h) ? h.toString("hex") : String(h)).toLowerCase());
  if (!codeHash || !consumerCodes.includes(codeHash)) return fail("owner", "the attested code hash is not 64 lowercase hex or not one of the consumer's allowedCodeHashes");
  const claims = { codeHash, proofKey: doc.proofKey, chainId: chainId.toString(), proofOfTime: doc.proofOfTime, registry: doc.registry, deployment: doc.deployment, enclaveId: doc.enclaveId, operator: doc.operator, instanceId: e.claims.instanceId, appId: e.claims.appId };
  const canon = (x) => JSON.stringify(Object.fromEntries(Object.keys(x || {}).sort().map((k) => [k, x[k]])));
  if (canon(o.claims) !== canon(claims)) return fail("owner", "the owner's claims differ from this verifier's reading of the same statement");
  checks.owner = true;
  reasons.push(`the attested transport key (sha256 ${e.claims.transportSpkiSha256.slice(0, 16)}…) vouches for proof key ${doc.proofKey} on chain ${chainId} for deployment ${short(doc.deployment)}; a proof-key verdict admits nothing`);
  return out("verified", { claims: { ...claims, transportSpkiSha256: e.claims.transportSpkiSha256, evidenceFormat: doc.evidence.format } });
}

/**
 * verifyCheckpoint(doc, { claims, modules? }) -> verdict { status, reasons, checks, checkpoint }
 *   claims: the claims of a VERIFIED proof-key statement (proofKey, chainId, proofOfTime, registry, deployment, enclaveId,
 *           operator); nothing else may name the pins a checkpoint is held to.
 *   checkpoint: { id, enclaveId, operator, upto, anchorBlock, anchorHash, digest, signer, sig } (upto/anchorBlock as decimal strings)
 */
export async function verifyCheckpoint(doc, { claims = null, modules = null } = {}) {
  const V = verdict("pvm-checkpoint"), { reasons, checks, out, fail } = V;
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return fail("pins", "no verified proof-key claims: refusing (fail closed)");
  const pinChain = canonicalChainId(claims.chainId);
  if (pinChain === null || !ADDR.test(claims.proofKey ?? "") || claims.proofKey === ZERO_ADDR || !ADDR.test(claims.proofOfTime ?? "") || !ADDR.test(claims.registry ?? "") || !ADDR.test(claims.operator ?? "") || !B32.test(claims.deployment ?? "") || !B32.test(claims.enclaveId ?? ""))
    return fail("pins", "the proof-key claims are malformed (chainId, proofKey, proofOfTime, registry, operator, deployment, enclaveId)");
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return fail("checkpoint shape", "the checkpoint is not an object");
  if (Object.keys(doc).sort().join(",") !== CHECKPOINT_KEYS.join(",")) return fail("checkpoint shape", `the checkpoint's fields must be exactly ${CHECKPOINT_KEYS.join(", ")}`);
  if (doc.format !== CHECKPOINT_FORMAT) return fail("checkpoint shape", `the checkpoint's format is not ${CHECKPOINT_FORMAT}`);
  for (const k of ["proofOfTime", "registry", "operator"]) if (!ADDR.test(doc[k] ?? "")) return fail("checkpoint shape", `${k} is not 0x + 40 lowercase hex`);
  for (const k of ["deployment", "enclaveId", "anchorHash"]) if (!B32.test(doc[k] ?? "")) return fail("checkpoint shape", `${k} is not 0x + 64 lowercase hex`);
  const chainId = canonicalChainId(doc.chainId);
  if (chainId === null) return fail("checkpoint shape", "chainId is not a canonical decimal in 1..2^64-1");
  const upto = canonicalU64(doc.upto), anchorBlock = canonicalU64(doc.anchorBlock);
  if (upto === null || anchorBlock === null) return fail("checkpoint shape", "upto and anchorBlock must be canonical u64 decimals");
  if (!/^0x[0-9a-f]{130}$/.test(doc.sig ?? "")) return fail("checkpoint shape", "the signature is not 0x + 65 bytes of lowercase hex (r || s || v)");
  checks["checkpoint shape"] = true;
  // the pins: every field a checkpoint names must be the verified statement's
  if (chainId !== pinChain) return fail("pins", `the checkpoint names chain ${doc.chainId}, not the statement's ${claims.chainId}`);
  for (const k of ["proofOfTime", "registry", "deployment", "enclaveId", "operator"]) if (doc[k] !== claims[k]) return fail("pins", `the checkpoint's ${k} ${short(doc[k])} is not the verified statement's ${short(claims[k])}`);
  checks.pins = true;
  // the signature's form: the contract's own malleability guard (s <= n/2) and v in {27, 28}
  const r = BigInt("0x" + doc.sig.slice(2, 66)), s = BigInt("0x" + doc.sig.slice(66, 130)), v = parseInt(doc.sig.slice(130), 16);
  if (v !== 27 && v !== 28) return fail("signature", `the signature's v is ${v}, not 27 or 28`);
  if (r === 0n || r >= SECP256K1_N || s === 0n) return fail("signature", "the signature's r or s is out of range");
  if (s > SECP256K1_N / 2n) return fail("signature", "the signature's s is high: the contract refuses it (malleability guard)");
  // the digest, exactly as EnclaveProofOfTime.proofDigest computes it, and the signer
  const digest = proofOfTimeDigest({ chainId, proofOfTime: doc.proofOfTime, id: doc.deployment, enclaveId: doc.enclaveId, operator: doc.operator, upto, anchorBlock, anchorHash: doc.anchorHash });
  let signer;
  try { signer = (await recoverAddress({ hash: digest, signature: doc.sig })).toLowerCase(); } catch (e) { return fail("signature", `the signature does not recover: ${e.message}`); }
  if (signer !== claims.proofKey) return fail("signature", `the checkpoint is signed by ${signer}, not the attested proof key ${claims.proofKey}`);
  checks.signature = true;
  // the owner's canonical checker must agree on the outcome and on the digest
  const mods = modules || await loadProofKeyModules();
  if (!mods || !mods.checkpoint) { checks.owner = null; reasons.push("UNSUPPORTED: the owner's verifyPvmCheckpoint is not available here"); return out("unsupported"); }
  let o;
  try { o = await mods.checkpoint.verifyPvmCheckpoint(doc, { pins: { chainId: claims.chainId, proofOfTime: claims.proofOfTime, registry: claims.registry, deployment: claims.deployment, enclaveId: claims.enclaveId, operator: claims.operator }, proofKey: claims.proofKey }); }
  catch (err) { return fail("owner", `the owner's checker threw: ${err.message}`); }
  if (!o || o.ok !== true) return fail("owner", `the owner's checker refused: ${o && Array.isArray(o.reasons) ? o.reasons[0] : "no result"}`);
  if (!o.checkpoint || o.checkpoint.digest !== digest) return fail("owner", "the owner's digest is not the one computed here from the contract's own type strings");
  checks.owner = true;
  reasons.push(`a ProofOfTime checkpoint by the attested proof key ${claims.proofKey} for deployment ${short(doc.deployment)}, upto ${upto}, anchored at block ${anchorBlock}; the anchor's freshness, the window and the lease are the chain's to judge`);
  return out("verified", { checkpoint: { id: doc.deployment, enclaveId: doc.enclaveId, operator: doc.operator, upto: upto.toString(), anchorBlock: anchorBlock.toString(), anchorHash: doc.anchorHash, digest, signer, sig: doc.sig } });
}
