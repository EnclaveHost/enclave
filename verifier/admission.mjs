// verifier/admission.mjs: the consumer's gate. The ONE place that may release a client request to an enclave.
//
// A verifier verdict is an input here, not a decision. The gate releases only when
//   1. the verdict is "verified" with admissionSafe true, an empty omissions list and every check true;
//   2. every expectation was supplied by the CLIENT (app id, measurement or runtime pins, root pins, TCB
//      floor where the technology has one, a fresh 32-byte challenge) and the verdict's claims match them;
//   3. the transport is bound in a way THIS kind of client can check: a native client (Node, CLI) compares
//      the peer key its own TLS handshake saw with the key the verifier bound; a browser client cannot read
//      the peer certificate, so it needs an application-layer public key bound into the evidence and never
//      claims TLS certificate pinning;
//   4. the challenge is single-use: a registry refuses a nonce seen before, whatever the verdict.
// Everything else is "hold": limited, unsupported, rejected, malformed verdicts, missing or empty policy,
// a stale or reused challenge, a peer key that is not the bound key. A hold names its reason.
import { createHash } from "node:crypto";

export const RELEASE = "release", HOLD = "hold";
const hex = (b) => Buffer.from(b).toString("hex");
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const isHex = (s, n) => typeof s === "string" && s.length === n && /^[0-9a-f]+$/.test(s);
const nonEmptyList = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0);

// Single-use challenges. A client makes one registry per session and hands it to every admit() call.
export function createNonceRegistry({ max = 65536 } = {}) {
  const seen = new Set();
  return {
    consume(nonceHex) { if (seen.has(nonceHex)) return false; if (seen.size >= max) seen.delete(seen.values().next().value); seen.add(nonceHex); return true; },
    has: (nonceHex) => seen.has(nonceHex), size: () => seen.size,
  };
}

// admit(verdict, expect, options) -> { decision, reasons, pinned }
//   expect: { nonce: Buffer(32) (required unless the format's freshness is the served certificate window),
//             appId?: Buffer(32), allowedMeasurements?: [hex], minTcb?: object, roots?: {product: sha256hex} | Map,
//             allowedRuntimeIds?: [hex], allowedCodeHashes?: [hex], allowedAuthorityHashes?: [hex], rootPins?: [hex] }
//   options: { clientKind: "native" | "browser", observedPeerSpki?: Buffer (native), nonceRegistry? }
export function admit(verdict, expect = {}, { clientKind = "native", observedPeerSpki = null, nonceRegistry = null } = {}) {
  const reasons = [];
  const hold = (why) => ({ decision: HOLD, reasons: [...reasons, `HOLD: ${why}`], pinned: null });
  // 0. the challenge is consumed FIRST, so that a replayed challenge holds even when the verdict looks fine
  const nonceHex = Buffer.isBuffer(expect.nonce) && expect.nonce.length === 32 ? hex(expect.nonce) : null;
  if (nonceRegistry && nonceHex && !nonceRegistry.consume(nonceHex)) return hold("the challenge was used before: a replayed exchange, whatever its verdict");

  // 1. the verdict itself
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) return hold("malformed verdict (not an object)");
  const { status, admissionSafe, omissions, checks, claims } = verdict;
  if (status !== "verified") return hold(`verdict is ${JSON.stringify(status)}${Array.isArray(omissions) && omissions.length ? ` (omitted: ${omissions.join(", ")})` : ""}: only "verified" releases`);
  if (admissionSafe !== true) return hold("verdict is not marked admission-safe");
  if (!Array.isArray(omissions) || omissions.length) return hold(`verdict carries omissions (${(omissions || []).join(", ") || "not a list"})`);
  if (!checks || typeof checks !== "object" || !Object.keys(checks).length) return hold("verdict carries no checks");
  const notTrue = Object.entries(checks).filter(([, v]) => v !== true).map(([k, v]) => `${k}=${v}`);
  if (notTrue.length) return hold(`not every check is true: ${notTrue.join(", ")}`);
  if (!claims || typeof claims !== "object") return hold("verdict carries no claims");
  reasons.push(`verdict: verified, admission-safe, ${Object.keys(checks).length} checks true, nothing omitted`);

  // 2. expectations: supplied by the client, matched against the claims
  const tech = claims.technology;
  if (tech === "amd-sev-snp") {
    if (!nonEmptyList(expect.allowedMeasurements)) return hold("client supplied no allowed measurements (policy from verified provenance is the client's to hold)");
    if (!isHex(claims.measurement, 96) || !expect.allowedMeasurements.map((m) => m.toLowerCase()).includes(claims.measurement)) return hold("the verified measurement is not one the client expects");
    if (!expect.minTcb || typeof expect.minTcb !== "object") return hold("client supplied no minimum-TCB policy");
    const roots = expect.roots instanceof Map ? Object.fromEntries(expect.roots) : expect.roots;
    if (!roots || typeof roots !== "object" || !Object.keys(roots).length) return hold("client supplied no root pins");
    if (!claims.product || roots[claims.product] !== claims.arkFingerprint) return hold(`the root the verifier chained to (${String(claims.arkFingerprint).slice(0, 16)}...) is not the client's pin for ${claims.product}`);
    if (claims.family === "domain") {
      if (!Buffer.isBuffer(expect.appId) || expect.appId.length !== 32) return hold("client supplied no expected app id for a domain document");
      if (claims.appId !== hex(expect.appId)) return hold("the verified app id is not the client's expected app");
    }
    reasons.push(`expectations met: measurement, TCB floor, ${claims.product} root pin${claims.family === "domain" ? ", app id" : ""}`);
  } else if (tech === "android-avf") {
    for (const k of ["allowedRuntimeIds", "allowedCodeHashes", "allowedAuthorityHashes", "rootPins"]) if (!nonEmptyList(expect[k])) return hold(`client supplied no ${k}`);
    if (!Buffer.isBuffer(expect.appId) || expect.appId.length !== 32) return hold("client supplied no expected app id");
    if (claims.appId !== hex(expect.appId)) return hold("the verified app id is not the client's expected app");
    if (!isHex(claims.runtimeId, 64) || !expect.allowedRuntimeIds.map((r) => r.toLowerCase()).includes(claims.runtimeId)) return hold("the verified runtime id is not one the client admits");
    if (claims.nonce !== undefined && claims.nonce !== nonceHex) return hold("the verifier compared a different challenge than the client's");
    // instance binding (v3): with expect.instanceIds (from the signed policy's entry, never assembled by the caller) only a v3
    // verdict naming a listed InstanceID releases; anything else holds, native and browser alike; a malformed expectation holds
    if (expect.instanceIds !== undefined) {
      if (!Array.isArray(expect.instanceIds) || !expect.instanceIds.length || expect.instanceIds.length > 8 || !expect.instanceIds.every((i) => isHex(i, 64)) || new Set(expect.instanceIds).size !== expect.instanceIds.length) return hold("the instance expectation is malformed: 1..8 unique InstanceIDs (64 lowercase hex), or none");
      if (claims.format !== "enclave-pvm-app-evidence/v3" || !isHex(claims.instanceId, 64)) return hold("the selected deployment is bound to instances: only a v3 verdict naming the instance can release");
      if (!expect.instanceIds.includes(claims.instanceId)) return hold("the verified instance is not one bound to the selected deployment");
      reasons.push("instance: the verified InstanceID is one the signed policy binds to this deployment");
    } else if (claims.format === "enclave-pvm-app-evidence/v3" && !isHex(claims.instanceId, 64)) return hold("a v3 verdict without an InstanceID is malformed");
    reasons.push("expectations met: app id, runtime id, code and authority hashes, root pins (all client-supplied)");
  } else return hold(`no admission rule for technology ${JSON.stringify(tech)}`);

  // 3. freshness: a client challenge, or (hosted format only) the served certificate window
  const certWindow = claims.freshness === "served certificate window";
  if (certWindow) {
    if (claims.family !== "hosted-tinfoil") return hold("certificate-window freshness is only the hosted format's rule");
    reasons.push("freshness: the served certificate's validity window and the hatt binding (hosted format; no client challenge in this format)");
  } else {
    if (!nonceHex) return hold("client supplied no 32-byte challenge");
    if (!["verifier nonce", "client-nonce"].includes(claims.freshness)) return hold(`the verdict's freshness is ${JSON.stringify(claims.freshness)}, not the client's challenge`);
    reasons.push("freshness: the client's own single-use challenge");
  }

  // 4. transport binding, by what this kind of client can actually check
  const pinned = {};
  if (clientKind === "native") {
    if (!Buffer.isBuffer(observedPeerSpki) || observedPeerSpki.length < 44) return hold("native client supplied no observed peer key from its own TLS handshake");
    const bound = claims.transportSpkiSha256 || claims.tlsSpkiSha256 || (claims.transportSpki ? sha256hex(Buffer.from(claims.transportSpki, "hex")) : null);
    if (!isHex(bound, 64)) return hold("the verdict binds no transport key");
    if (sha256hex(observedPeerSpki) !== bound) return hold("the peer key this connection presented is not the key the evidence binds");
    pinned.transportSpkiSha256 = bound; reasons.push("transport: the connection's peer key is the key the evidence binds (pinned)");
  } else if (clientKind === "browser") {
    const appKey = claims.appKey || claims.hpkePublicKey || null;
    if (!isHex(appKey, 64)) return hold("browser client: the evidence binds no application-layer public key, and browser code cannot read the peer TLS certificate, so nothing here binds the transport");
    pinned.appKey = appKey; reasons.push("transport: application-layer key bound in the evidence (browser client; TLS certificate pinning is NOT claimed, browser code cannot see the peer certificate)");
    if (claims.sealed) { pinned.sealed = { ...claims.sealed }; reasons.push(`sealed channel: this key is good for ${claims.sealed.windowSeconds} s and ${claims.sealed.maxRequests} requests from the evidence exchange; re-attest after that, never retry a refused request`); }
  } else return hold(`unknown client kind ${JSON.stringify(clientKind)}`);

  return { decision: RELEASE, reasons: [...reasons, "RELEASE"], pinned };
}
