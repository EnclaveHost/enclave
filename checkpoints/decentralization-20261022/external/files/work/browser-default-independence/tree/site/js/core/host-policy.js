/* ============================================================
   Host-owner admission policy in the browser: a host owner's veto,
   scoped to the hosts it owns.

   A host's accepted owner commits a policy through
   EnclaveHostOwnership.setPolicy (network/host-admission-policy.mjs):
   the contract stores keccak256("enclave-host-admission:v1\n" +
   canonical(policy)); the document itself is public and mirrored by
   anyone (bytes, never authority). This module reads the commitment at
   the page's agreed block, resolves a nonzero hash from the profile's
   policy mirrors (each document hash-checked), and applies the same
   refusal rule the host applies (hostAdmissionRefusal, ported).

   Scope: a refusal marks ONLY that host ("its owner declines this
   deployment"). Every other host stays eligible, so an owner (Enclave's
   wallet included) can refuse service on hosts it owns and cannot stop
   another consenting host. A policy that cannot be fetched marks THAT
   host "owner policy unavailable"; nothing else changes, and a missing
   document is never read as "allow".
   ============================================================ */
import { canonical } from "../../../network/canonical.mjs";
import { keccak256Utf8 } from "./keccak.js";

const ID = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/, ZERO32 = "0x" + "0".repeat(64);
const SEL_AUTHORITY = keccak256Utf8("authority(bytes32)").slice(2, 10);
const POLICY_MAX = 2 * 1024 * 1024;

export function validateHostAdmissionPolicy(p){
  if (!p || p.version !== 1 || p.chainId !== 8453 || !ADDRESS.test(p.ownershipContract) || !ID.test(p.hostId)
    || typeof p.requireCatalogApproval !== "boolean" || Object.keys(p).some((k) => !["version", "chainId", "ownershipContract", "hostId", "requireCatalogApproval", "denyDeployments", "denyAppRefs"].includes(k)))
    throw Error("invalid host policy");
  for (const k of ["denyDeployments", "denyAppRefs"]){
    if (!Array.isArray(p[k]) || p[k].length > 4096 || new Set(p[k]).size !== p[k].length) throw Error("invalid host deny list");
    for (const v of p[k]) if (typeof v !== "string" || (k === "denyDeployments" ? !ID.test(v) : !/^catalog:\/\/0x[0-9a-f]{64}\/(?:0|[1-9][0-9]{0,8})$/.test(v))) throw Error("invalid host deny entry");
  }
  return structuredClone(p);
}
export const hostAdmissionPolicyHash = (p) => keccak256Utf8("enclave-host-admission:v1\n" + canonical(validateHostAdmissionPolicy(p)));

/* The host's own rule (network/host-admission-policy.mjs hostAdmissionRefusal). deploymentId may be null for a record
   not created yet (only the app and catalog-approval rules can apply then). -> reason | null */
export function hostAdmissionRefusal(p, { hostId, deploymentId = null, appRef, version }){
  p = validateHostAdmissionPolicy(p);
  if (p.hostId !== hostId) throw Error("host policy cannot apply to another host");
  const ref = typeof appRef === "string" && appRef.match(/^catalog:\/\/(0x[0-9a-fA-F]{64})\/([0-9]{1,9})$/);
  if (!ref) return "this host owner admits catalog apps only";   // the host's rule throws for a non-catalog reference: it declines
  const canonicalRef = `catalog://${ref[1].toLowerCase()}/${Number(ref[2])}`;
  if ((deploymentId && p.denyDeployments.includes(String(deploymentId).toLowerCase())) || p.denyAppRefs.includes(canonicalRef)) return "this host owner declines this deployment";
  if (p.requireCatalogApproval && (!version || version.active !== true || version.yanked !== false || Number(version.approval) !== 1)) return "this host owner requires current catalog approval";
  return null;
}

/* EnclaveHostOwnership.authority(hostId) at the snapshot: { owner, pendingOwner, revision, policyHash }. */
export async function hostAuthority(reader, snap, ownership, hostId){
  const out = String(await reader.call(snap, ownership, "0x" + SEL_AUTHORITY + hostId.replace(/^0x/, ""))).replace(/^0x/, "");
  const w = (i) => out.slice(i * 64, i * 64 + 64);
  if (out.length < 256) throw new Error("malformed host authority");
  return { owner: "0x" + w(0).slice(24), pendingOwner: "0x" + w(1).slice(24), revision: BigInt("0x" + w(2)).toString(), policyHash: "0x" + w(3) };
}

/* A document by hash from the mirrors; the first hash-matching one wins (a withholding or lying mirror cannot hide it). */
export async function fetchPolicy(hash, mirrors, { fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 8000 } = {}){
  if (!ID.test(hash)) throw new Error("policy hash required");
  if (!mirrors.length) throw new Error("no host policy mirror is configured");
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await Promise.any(mirrors.map(async (origin) => {
      const r = await fetchImpl(origin + "/" + hash + ".json", { credentials: "omit", redirect: "error", cache: "no-store", signal: ctrl.signal });
      if (!r.ok){ await r.body?.cancel(); throw new Error("HTTP " + r.status); }
      const text = await r.text();
      if (text.length > POLICY_MAX) throw new Error("policy too large");
      const p = JSON.parse(text);
      if (hostAdmissionPolicyHash(p) !== hash) throw new Error("policy does not match its commitment");
      return p;
    }));
  } catch { throw new Error("no hash-matching host policy available"); }
  finally { clearTimeout(t); ctrl.abort(); }
}

/* For each host id: { owner, revision, state: "unowned" | "open" | "policy", policy?, error? } at ONE snapshot. */
export async function readHostPolicies({ reader, snap, ownership, hostIds, mirrors = [], fetchImpl }){
  const out = new Map();
  if (!ownership || !ADDRESS.test(String(ownership).toLowerCase())){ for (const h of hostIds) out.set(h, { state: "unknown", error: "this profile pins no host-ownership contract" }); return out; }
  const cache = new Map();
  await Promise.all(hostIds.map(async (hostId) => {
    try {
      const a = await hostAuthority(reader, snap, ownership, hostId);
      if (/^0x0{40}$/.test(a.owner)) return out.set(hostId, { state: "unowned", owner: null, revision: a.revision });
      if (a.policyHash === ZERO32) return out.set(hostId, { state: "open", owner: a.owner, revision: a.revision });
      if (!cache.has(a.policyHash)) cache.set(a.policyHash, fetchPolicy(a.policyHash, mirrors, { fetchImpl }));
      const policy = await cache.get(a.policyHash);
      if (policy.hostId !== hostId || policy.ownershipContract !== String(ownership).toLowerCase()) throw new Error("the committed policy names another host");
      out.set(hostId, { state: "policy", owner: a.owner, revision: a.revision, policy });
    } catch (e){ out.set(hostId, { state: "unavailable", error: String(e.message || e).slice(0, 200) }); }
  }));
  return out;
}

/* The verdict for one host row: { eligible, reason } — a refusal or an unknown policy blocks ONLY this host. */
export function ownerVerdict(entry, { hostId, deploymentId = null, appRef, version }){
  if (!entry) return { eligible: true, reason: "" };
  if (entry.state === "unavailable") return { eligible: false, reason: "its owner's policy is unavailable (" + entry.error + ")" };
  if (entry.state !== "policy") return { eligible: true, reason: "" };
  const why = hostAdmissionRefusal(entry.policy, { hostId, deploymentId, appRef, version });
  return why ? { eligible: false, reason: why.replace("this host owner", "its owner " + entry.owner.slice(0, 8) + "…") } : { eligible: true, reason: "" };
}
