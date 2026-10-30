// Hosting delegation for an owner-only host (the NucBox hv-node row, enclave-87's (B), 2026-09-26).
//
// An hv-node row is a host-attested boot state, never a TEE, so it may serve a deployment only when that deployment's
// OWNER consented to this host. The served owners are:
//   - the box's OPERATOR: the on-chain operator of the box's registered name, who signed this attach (implicit), and
//   - every owner who signed a DELEGATION to that operator for that box (this module).
// The registry's payoutWallet never authorizes anything: it is the operator's own declaration, not an owner's consent.
//
// The delegation is an EIP-191 personal_sign over EXACTLY these seven lines, joined by "\n", no trailing newline:
//   enclave-host-delegation-v1
//   owner: 0x<40 lowercase hex>          the owner whose deployments may be served
//   operator: 0x<40 lowercase hex>       the box's registered operator (the attach signer)
//   box: <tunnel name>                   the attach name ([A-Za-z0-9_-]{1,64})
//   chain: <decimal chain id>            8453 (Base)
//   registry: 0x<40 lowercase hex>       the EnclaveRegistry the name is registered in
//   expires: <decimal unix seconds>      no leading zeros; at most MAX_DELEGATION_SEC ahead of the verifier's clock
// Parsing is STRICT (exact keys, order, one space after each colon, lowercase hex, nothing else): a variant is refused,
// never normalized, so the bytes the owner signed are the bytes every verifier reads. ONE implementation, used by the relay
// (tunnel.js) and, vendored or imported, by the node; test/fixtures/host-delegation-vectors.json pins its verdicts.
export const DELEGATION_TAG = "enclave-host-delegation-v1";
export const MAX_DELEGATION_SEC = 180 * 86400;       // the relay refuses an expiry further out (87: sign 90 days)
export const MAX_DELEGATIONS = 8;                    // per attach frame
export const MAX_DELEGATION_BYTES = 1024;            // per message and per signature
const ADDR = /^0x[0-9a-f]{40}$/, NAME = /^[A-Za-z0-9_-]{1,64}$/, DEC = /^(0|[1-9][0-9]{0,15})$/, SIG = /^0x[0-9a-fA-F]{130}$/;
const KEYS = ["owner", "operator", "box", "chain", "registry", "expires"];

// The exact text for a signer to personal_sign (the signing helper prints this).
export function delegationText({ owner, operator, box, chain, registry, expires }) {
  const f = { owner: String(owner || "").toLowerCase(), operator: String(operator || "").toLowerCase(), box: String(box || ""),
              chain: String(chain ?? ""), registry: String(registry || "").toLowerCase(), expires: String(expires ?? "") };
  const why = fieldProblem(f);
  if (why) throw new Error(`delegation: ${why}`);
  return [DELEGATION_TAG, ...KEYS.map((k) => `${k}: ${f[k]}`)].join("\n");
}
function fieldProblem(f) {
  if (!ADDR.test(f.owner)) return "owner is not a 0x address";
  if (!ADDR.test(f.operator)) return "operator is not a 0x address";
  if (!NAME.test(f.box)) return "box is not a tunnel name";
  if (!DEC.test(f.chain) || f.chain === "0") return "chain is not a decimal chain id";
  if (!ADDR.test(f.registry)) return "registry is not a 0x address";
  if (!DEC.test(f.expires)) return "expires is not decimal unix seconds";
  return null;
}
// message -> { owner, operator, box, chain, registry, expires } or { error }
export function parseDelegation(message) {
  if (typeof message !== "string" || message.length > MAX_DELEGATION_BYTES) return { error: "not a delegation message" };
  const lines = message.split("\n");
  if (lines.length !== 1 + KEYS.length || lines[0] !== DELEGATION_TAG) return { error: "not an enclave-host-delegation-v1 message" };
  const f = {};
  for (let i = 0; i < KEYS.length; i++) {
    const pre = `${KEYS[i]}: `;
    if (!lines[i + 1].startsWith(pre)) return { error: `line ${i + 2} is not '${KEYS[i]}: …'` };
    f[KEYS[i]] = lines[i + 1].slice(pre.length);
  }
  const why = fieldProblem(f);
  if (why) return { error: why };
  if (message !== delegationText(f)) return { error: "not in canonical form" };   // belt and braces: the bytes round-trip
  return f;
}
async function defaultRecover(message, signature) {
  const { recoverMessageAddress } = await import("viem");
  return recoverMessageAddress({ message, signature });
}
// Verify ONE { message, signature } against what the verifier itself knows: the attach-verified operator, the attach name,
// its chain id and registry address, and its own clock. -> { ok: true, owner } | { ok: false, reason }
export async function verifyDelegation(d, { operator, box, chain, registry, now = Math.floor(Date.now() / 1000), recover = defaultRecover } = {}) {
  const message = d && d.message, signature = d && d.signature;
  if (typeof signature !== "string" || !SIG.test(signature)) return { ok: false, reason: "the signature is not a 65-byte hex personal_sign" };
  const f = parseDelegation(message);
  if (f.error) return { ok: false, reason: f.error };
  if (f.operator !== String(operator || "").toLowerCase()) return { ok: false, reason: `delegates to operator ${f.operator}, not this box's ${String(operator || "(none)").toLowerCase()}` };
  if (f.box !== String(box || "")) return { ok: false, reason: `names box ${f.box}, not ${box}` };
  if (f.chain !== String(chain)) return { ok: false, reason: `names chain ${f.chain}, not ${chain}` };
  if (f.registry !== String(registry || "").toLowerCase()) return { ok: false, reason: `names registry ${f.registry}, not ${String(registry || "").toLowerCase()}` };
  const exp = Number(f.expires);
  if (!(exp > now)) return { ok: false, reason: `expired at ${f.expires}` };
  if (exp > now + MAX_DELEGATION_SEC) return { ok: false, reason: `expires more than ${MAX_DELEGATION_SEC / 86400} days out` };
  let signer;
  try { signer = String(await recover(message, signature)).toLowerCase(); } catch { return { ok: false, reason: "the signature does not recover" }; }
  if (signer !== f.owner) return { ok: false, reason: `signed by ${signer}, not the owner ${f.owner}` };
  return { ok: true, owner: f.owner, expires: exp };
}
// The served owners for a verified operator: { operator } ∪ { owner of each VALID delegation }, plus the reasons the rest
// were ignored (logged by the caller). An invalid delegation never fails the attach; it is simply not served.
export async function servedOwners(delegations, ctx) {
  const owners = new Set(), refused = [];
  const op = String(ctx && ctx.operator || "").toLowerCase();
  if (ADDR.test(op)) owners.add(op);
  const list = Array.isArray(delegations) ? delegations.slice(0, MAX_DELEGATIONS) : [];
  if (Array.isArray(delegations) && delegations.length > MAX_DELEGATIONS) refused.push({ index: MAX_DELEGATIONS, reason: `more than ${MAX_DELEGATIONS} delegations; the rest ignored` });
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (!d || typeof d.message !== "string" || typeof d.signature !== "string" || d.message.length > MAX_DELEGATION_BYTES || d.signature.length > MAX_DELEGATION_BYTES) {
      refused.push({ index: i, reason: "not a { message, signature } pair within size" }); continue;
    }
    const v = await verifyDelegation(d, ctx);
    if (v.ok) owners.add(v.owner); else refused.push({ index: i, reason: v.reason });
  }
  return { owners: [...owners].sort(), refused };
}
// The hv-node attach signature v2 (enclave-bf): the operator consents to THIS transport key on THIS TPM, not merely to a
// session nonce. keyFp = sha256(transport SPKI DER) hex; ekCertSha256 = sha256(EK certificate DER) hex.
export const attachMessageV2 = (name, nonceB64, keyFpHex, ekCertSha256Hex) =>
  `enclave-tunnel-attach/2:${name}:${nonceB64}:${String(keyFpHex).toLowerCase()}:${String(ekCertSha256Hex).toLowerCase()}`;
