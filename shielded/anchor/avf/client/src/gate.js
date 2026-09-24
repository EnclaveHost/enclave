// gate.js -- the pVM client's release rule (client/DESIGN.md): one decision between "the evidence verified" and "send the
// request". It is the Enclave verifier session's admission rule (verifier/admission.mjs on research/independent-verifier;
// its admission-vectors.json is replayed against this file by test/pvm-client-gate.test.mjs), restricted to what THIS
// client serves: android-avf pVM apps. Every other technology holds here, fail closed.
//   admit(verdict, expect, { clientKind, observedPeerSpki, usedNonces }) -> { decision: "release" | "hold", reason, pinned }
// Release only when the verdict is verified, admission-safe, with nothing omitted and every check true; every
// expectation is the client's own and matched; the freshness is the client's single-use nonce; and the transport is bound
// the way THIS client kind can check -- native: the peer key it saw is the attested transport key; browser: an
// application-layer key (v2/v3 appKey) and its sealed window (TLS pinning is never claimed for a page). With
// expect.instanceIds (a deployment the signed policy binds to VM instances; INSTANCE-BINDING.md, agreed with the verifier
// session, which owns the vectors), only a v3 verdict whose instanceId is listed releases -- native and browser alike.
import { sha256, toHex, fromHex } from "../../web/pvm-verify.js";

const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const V3 = "enclave-pvm-app-evidence/v3";
const hexOf = (v) => (v && typeof v === "object" && typeof v.hex === "string" ? v.hex : v instanceof Uint8Array ? toHex(v) : typeof v === "string" ? v : null);
const hold = (reason) => ({ decision: "hold", reason: `HOLD: ${reason}`, pinned: null });

export async function admit(verdict, expect = {}, { clientKind, observedPeerSpki = null, usedNonces = [] } = {}) {
  if (clientKind !== "native" && clientKind !== "browser") return hold(`unknown client kind ${JSON.stringify(clientKind)}`);
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) return hold("malformed verdict (not an object)");
  const c = verdict.claims || {};
  if (c.technology !== "android-avf" || c.family !== "pvm-app") return hold(`no admission rule in this client for technology ${JSON.stringify(c.technology)}`);
  if (verdict.status !== "verified") return hold(`the verdict is ${JSON.stringify(verdict.status)}, not verified`);
  if (verdict.admissionSafe !== true) return hold("the verdict is not admission-safe");
  if (!Array.isArray(verdict.omissions) || verdict.omissions.length) return hold("the verdict lists omissions");
  const checks = verdict.checks && typeof verdict.checks === "object" ? Object.entries(verdict.checks) : [];
  if (!checks.length || checks.some(([, v]) => v !== true)) return hold("a check is not true");
  for (const k of ["allowedRuntimeIds", "allowedCodeHashes", "allowedAuthorityHashes", "rootPins"])
    if (!Array.isArray(expect[k]) || !expect[k].length) return hold(`client supplied no ${k}`);
  const nonce = hexOf(expect.nonce), app = hexOf(expect.appId);
  if (!nonce || !HEX(64).test(nonce) || c.freshness !== "client-nonce" || c.nonce !== nonce) return hold("the verifier compared a different challenge than the client's");
  if ((usedNonces || []).map(hexOf).includes(nonce)) return hold("the challenge was used before: a replayed exchange, whatever its verdict");
  if (!app || c.appId !== app) return hold("the verified app id is not the client's expected app");
  if (!expect.allowedRuntimeIds.includes(c.runtimeId)) return hold("the verified runtime id is not one the client admits");
  if (typeof c.transportSpki !== "string" || !/^302a300506032b6570032100[0-9a-f]{64}$/.test(c.transportSpki)) return hold("the verdict binds no transport key");
  // v3 always names its instance, bound deployment or not: a v3 verdict without one is malformed
  if (c.format === V3 && (typeof c.instanceId !== "string" || !HEX(64).test(c.instanceId))) return hold("a v3 verdict without an InstanceID is malformed");
  if (expect.instanceIds !== undefined) {   // a bound deployment: the instance is part of what must match, never optional
    const ids = expect.instanceIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8 || !ids.every((i) => typeof i === "string" && HEX(64).test(i)) || new Set(ids).size !== ids.length)
      return hold("the instance expectation is malformed: 1..8 unique InstanceIDs (64 lowercase hex), or none");
    if (c.format !== V3) return hold("the selected deployment is bound to instances: only a v3 verdict naming the instance can release");
    if (!ids.includes(c.instanceId)) return hold("the verified instance is not one bound to the selected deployment");
  }
  if (clientKind === "native") {
    const peer = hexOf(observedPeerSpki);
    if (!peer) return hold("native client: no peer key observed on this connection");
    if (peer !== c.transportSpki) return hold("the peer key this connection presented is not the key the evidence binds");
    return { decision: "release", reason: "RELEASE", pinned: { transportSpkiSha256: toHex(await sha256(fromHex(c.transportSpki))) } };
  }
  if ((c.format !== "enclave-pvm-app-evidence/v2" && c.format !== V3) || typeof c.appKey !== "string" || !HEX(64).test(c.appKey))
    return hold("browser client: the evidence binds no application-layer public key, and browser code cannot read the peer TLS certificate, so nothing here binds the transport");
  const s = c.sealed;
  if (!s || !Number.isSafeInteger(s.windowSeconds) || !Number.isSafeInteger(s.maxRequests) || s.windowSeconds < 1 || s.maxRequests < 1)
    return hold("browser client: the evidence states no sealed window");
  return { decision: "release", reason: "RELEASE", pinned: { appKey: c.appKey, sealed: { windowSeconds: s.windowSeconds, maxRequests: s.maxRequests } } };
}

/** The verdict shape the gate reads, from this client's own verification (relay/pvm-app-attest.mjs verifyPvmAppEvidence). */
export async function verdictOf(v, env, nonceHex) {
  return {
    status: v.ok ? "verified" : "rejected", admissionSafe: v.ok === true, omissions: [],
    checks: { "echo matches client": !!env && env.nonce === nonceHex, pvmEvidence: v.ok === true },
    claims: { technology: "android-avf", family: "pvm-app", format: env && env.format, freshness: v.freshness, nonce: env && env.nonce, appId: v.appId,
              runtimeId: v.runtimeId, transportSpki: v.transportSpki, transportSpkiSha256: v.transportSpki ? toHex(await sha256(fromHex(v.transportSpki))) : null,
              appKey: v.appKey, sealed: v.appKey ? { windowSeconds: v.sealedWindowSeconds, maxRequests: v.sealedMaxRequests } : null,
              instanceId: v.instanceId || null },
  };
}
