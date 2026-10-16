// relay/hvnode-verify.mjs — the NucBox node's ATTACH evidence, tunnel format "windows-hv-node/v1" (enclave-5d's proposal
// of 2026-09-25, reviewed by the verifier lane; the contract is docs/security/nucbox-custom-vm-verifier.md). Steven's
// direction: the custom type-1 partition is the ONLY NucBox target, the ee-engine VBS-enclave backend is retired, test
// signing stays off, host_excluded=no until evidence supports admission.
//
// What this proves, and all it proves: the node's tunnel transport key is held by a process on a machine whose genuine
// on-die TPM measured an ACCEPTED boot state, in this boot, for this relay's nonce. The node IS the host: nothing here
// excludes the host, and there is no TEE claim. Every result says so (technology "windows-tpm-host", tier "hv-node",
// hostExcluded false, measurement null). The node's own /health summary rides along as `statement` and is kept as
// `hostStatement`, bound to this exchange and never read for a decision.
//
//   EK cert  --chains to-->  pinned AMD/Intel root                     (1) genuine on-die TPM
//   credential round trip (minted by the relay for EK + AK name)       (2, 3) the quoting key lives in THAT TPM
//   quote(sha256(bound), SHA-256 PCRs {0,7,12,13,14}) by that key      (4) the log is what the TPM measured
//   log --replays to--> quoted PCRs 7/12/13/14; records recomputed     (5) Secure Boot on, TESTSIGNING 0, VBS/HVCI, no debug
//   VSM_IDKS_INFO on PCR 12                                            (6) recorded: the key a same-boot VM report must verify under
//   Ed25519(transportKey) over bound                                    (8) possession of the key the quote names
//   bound = "enclave-hv-node-bind-v1\n" || spki(44) || nonce(32) || sha256(statementBytes)(32)
//
// The policy is PRODUCTION ONLY: there is no dev tier and no relaxation (METAL_VBS_ALLOW_TESTSIGNING and any
// allowTestSigning are ignored); a failed check refuses. PCR 0 is quoted and its value recorded, but there is no
// independent pin for this platform's firmware (a value read from the box is not a pin; enclave-d1), so every result
// carries the omission "platform-firmware-unpinned" rather than a pass.
//
// Capture mode ({ capture: { quoteExtraData } }) re-verifies a RECORDED session whose quote carried a raw nonce (the
// boot-68 tpmattest session, before this transcript existed): the TPM and boot checks run, possession is not exercised,
// and the result is never admissible.
//
// The checks themselves are relay/hvnode-core.mjs (hvNodeChecks), shared with the browser build
// (verifier/web/shield-host.mjs) so the site applies these exact rules; this module answers its crypto requests with
// node:crypto, synchronously, and keeps the relay's policy loading (the pinned roots as X509Certificate objects).
import { createHash, createPublicKey, verify as cryptoVerify, X509Certificate, constants } from "node:crypto";
import { rsaKeyFromModulus, verifyEkChain, loadTpmRoots, VBS_FORMAT } from "./vbs-verify.mjs";
import { replayPcrs, unhashedEvents, sipaFields, vsmKey, secureBootFromLog, bootCounterFromLog } from "./vbs-tcglog.mjs";
import { hvNodeChecks, hvNodeBindingWith, runSync } from "./hvnode-core.mjs";
export { HVNODE_FORMAT, HVNODE_BIND_DOMAIN, HVNODE_TECHNOLOGY, HVNODE_TIER, HVNODE_MAX_STATEMENT_BYTES, HVNODE_OMISSIONS, HVNODE_SCOPE } from "./hvnode-core.mjs";

// formats the relay must refuse outright for this node class, with the reason it states
export const RETIRED_FORMATS = Object.freeze({
  [VBS_FORMAT]: "the Windows VBS-enclave backend (ee-engine) is retired (Steven, 2026-09-25): the custom type-1 partition is the only NucBox target, and a VBS-enclave report never stands in for a custom-VM report",
});
export const retiredFormat = (format) => (Object.prototype.hasOwnProperty.call(RETIRED_FORMATS, format) ? RETIRED_FORMATS[format] : null);

const sha256 = (...parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest(); };
const ENV = Object.freeze({ sha256, tcg: Object.freeze({ replayPcrs, unhashedEvents, sipaFields, vsmKey, secureBootFromLog, bootCounterFromLog }) });
// hvNodeChecks' crypto requests, answered with node:crypto
const NODE_OPS = Object.freeze({
  cert: ({ der }) => new X509Certificate(der),
  chain: ({ leaf, extra, trust, now }) => verifyEkChain(leaf, extra, trust, now),
  rsaKey: ({ modulus, exponent }) => rsaKeyFromModulus(modulus, exponent),
  rsaPkcs1Sha256: ({ key, data, sig }) => cryptoVerify("sha256", data, { key, padding: constants.RSA_PKCS1_PADDING }, sig),
  ed25519: ({ spki, data, sig }) => cryptoVerify(null, data, createPublicKey({ key: spki, format: "der", type: "spki" }), sig),
});

// bound = domain || spki(44, Ed25519) || nonce(32) || sha256(statement)(32): every part fixed width
export const hvNodeBinding = (spki, nonce, statementBytes) => hvNodeBindingWith(sha256, spki, nonce, statementBytes);

// policy: { ekRoots: PEM bundle, ekRootPins?: [sha256], now? }. Nothing else is read: no allow-lists that could relax.
function normalizePolicy(policy = {}) {
  const trust = policy.ekRoots ? loadTpmRoots(policy.ekRoots) : { roots: [], intermediates: [], pins: [] };
  if (Array.isArray(policy.ekRootPins) && policy.ekRootPins.length) { const pins = new Set(policy.ekRootPins.map((p) => String(p).toLowerCase())); trust.pins = trust.pins.filter((p) => pins.has(p)); }
  return { trust, now: policy.now || Date.now() };
}

export function verifyHvNodeEvidence(input = {}, policy = {}) {
  return runSync(hvNodeChecks(input, normalizePolicy(policy), ENV), NODE_OPS);
}
