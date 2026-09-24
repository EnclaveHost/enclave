#!/usr/bin/env node
// verifier/admission-vectors.mjs: generate verifier/admission-vectors.json from the consumer gate (verifier/admission.mjs),
// so another implementation of the release decision (the pVM owner's client flow, docs/security/pvm-client-bootstrap-
// review.md) can be held to the same rule the way the runtime identity is held to the contract vectors. Every vector is
// deterministic: a verdict as the verifier produces it, the client's expectations, the client kind, the peer key the
// client's own handshake saw (native), and the nonces already used; the output is the decision and the last reason.
//   node verifier/admission-vectors.mjs            (rewrites the file; test/verifier-admission-vectors.test.mjs replays it)
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { admit, createNonceRegistry } from "./admission.mjs";

export const VECTORS_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "admission-vectors.json");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const bytes = (tag, n = 32) => { const out = Buffer.alloc(n); let h = Buffer.alloc(0); while (h.length < n) h = Buffer.concat([h, createHash("sha256").update(`admission-vector ${tag} ${h.length}`).digest()]); h.copy(out, 0, 0, n); return out; };
const hex = (b) => b.toString("hex");
// expectations with Buffers, and their JSON form (hex)
const SPKI_G = bytes("genoa spki", 91), SPKI_T = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes("turin spki", 32)]);
const NONCE = bytes("nonce"), APP = bytes("app"), MEAS = hex(bytes("measurement", 48)), RID = hex(bytes("runtime id"));
const ROOTS = { Genoa: hex(bytes("ark genoa")), Turin: hex(bytes("ark turin")) };
const hosted = { status: "verified", admissionSafe: true, omissions: [], checks: { "report shape": true, chain: true, crl: true, signature: true, binding: true, "certificate binding": true, "tcb policy": true, measurement: true },
  claims: { technology: "amd-sev-snp", family: "hosted-tinfoil", product: "Genoa", arkFingerprint: ROOTS.Genoa, measurement: MEAS, freshness: "served certificate window", hpkePublicKey: hex(bytes("hpke")), tlsSpkiSha256: sha256(SPKI_G), transportSpkiSha256: sha256(SPKI_G) } };
const domain = { status: "verified", admissionSafe: true, omissions: [], checks: { "report shape": true, chain: true, crl: true, signature: true, binding: true, "app id": true, "tcb policy": true, measurement: true },
  claims: { technology: "amd-sev-snp", family: "domain", product: "Turin", arkFingerprint: ROOTS.Turin, measurement: MEAS, appId: hex(APP), abi: "enclave-domain-abi/2", freshness: "verifier nonce", transportSpkiSha256: sha256(SPKI_T) } };
const pvmV2 = { status: "verified", admissionSafe: true, omissions: [], checks: { "echo matches client": true, pvmEvidence: true },
  claims: { technology: "android-avf", family: "pvm-app", format: "enclave-pvm-app-evidence/v2", freshness: "client-nonce", nonce: hex(NONCE), appId: hex(APP), runtimeId: RID, transportSpki: hex(SPKI_T), transportSpkiSha256: sha256(SPKI_T), appKey: hex(bytes("app key")), sealed: { windowSeconds: 600, maxRequests: 256 } } };
const pvmV1 = { ...pvmV2, claims: { ...pvmV2.claims, format: "enclave-pvm-app-evidence/v1", appKey: null, sealed: null } };
// v3: the instance inside the challenge (INSTANCE-BINDING.md); InstanceID = sha256(instance SPKI), never a field
const SPKI_I = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes("instance spki", 32)]), IID = sha256(SPKI_I), IID2 = sha256(Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes("other instance", 32)]));
const pvmV3 = { ...pvmV2, claims: { ...pvmV2.claims, format: "enclave-pvm-app-evidence/v3", instanceId: IID, instanceKey: hex(SPKI_I) } };
const limited = { ...hosted, status: "limited", admissionSafe: false, omissions: ["tcb-floor-unjudged"], checks: { ...hosted.checks, "tcb policy": null } };
const snpExpect = { allowedMeasurements: [MEAS], minTcb: { Genoa: { bootloader: 1, tee: 0, snp: 1, microcode: 1 } }, roots: ROOTS };
const pvmExpect = { nonce: NONCE, appId: APP, allowedRuntimeIds: [RID], allowedCodeHashes: [hex(bytes("code"))], allowedAuthorityHashes: [hex(bytes("authority", 64))], rootPins: [hex(bytes("google root"))] };

const cases = [
  ["hosted verified, native, own peer key is the bound key", hosted, snpExpect, { clientKind: "native", observedPeerSpki: SPKI_G }],
  ["hosted verified, native, another peer key", hosted, snpExpect, { clientKind: "native", observedPeerSpki: SPKI_T }],
  ["hosted verified, native, no observed peer key", hosted, snpExpect, { clientKind: "native" }],
  ["hosted verified, browser, HPKE key present", hosted, snpExpect, { clientKind: "browser" }],
  ["hosted verified, browser, HPKE key absent", { ...hosted, claims: { ...hosted.claims, hpkePublicKey: undefined } }, snpExpect, { clientKind: "browser" }],
  ["limited (no TCB floor) never releases", limited, snpExpect, { clientKind: "browser" }],
  ["unsupported never releases", { ...hosted, status: "unsupported", admissionSafe: false }, snpExpect, { clientKind: "browser" }],
  ["rejected never releases", { ...hosted, status: "rejected", admissionSafe: false }, snpExpect, { clientKind: "browser" }],
  ["verified but not admission-safe", { ...hosted, admissionSafe: false }, snpExpect, { clientKind: "browser" }],
  ["verified but with an omission listed", { ...hosted, omissions: ["crl-revocation-unchecked"] }, snpExpect, { clientKind: "browser" }],
  ["verified but a check is null", { ...hosted, checks: { ...hosted.checks, crl: null } }, snpExpect, { clientKind: "browser" }],
  ["verified but a check is false", { ...hosted, checks: { ...hosted.checks, crl: false } }, snpExpect, { clientKind: "browser" }],
  ["no allowed measurements from the client", hosted, { ...snpExpect, allowedMeasurements: [] }, { clientKind: "browser" }],
  ["measurement not the client's", hosted, { ...snpExpect, allowedMeasurements: [hex(bytes("other", 48))] }, { clientKind: "browser" }],
  ["no TCB floor from the client", hosted, { ...snpExpect, minTcb: undefined }, { clientKind: "browser" }],
  ["no root pins from the client", hosted, { ...snpExpect, roots: {} }, { clientKind: "browser" }],
  ["root pin for another product only", hosted, { ...snpExpect, roots: { Turin: ROOTS.Turin } }, { clientKind: "browser" }],
  ["root pin differs from the chained root", hosted, { ...snpExpect, roots: { Genoa: hex(bytes("other ark")) } }, { clientKind: "browser" }],
  ["domain verified, native, nonce + app id + peer key", domain, { ...snpExpect, nonce: NONCE, appId: APP }, { clientKind: "native", observedPeerSpki: SPKI_T }],
  ["domain verified, native, no nonce", domain, { ...snpExpect, appId: APP }, { clientKind: "native", observedPeerSpki: SPKI_T }],
  ["domain verified, native, no app id", domain, { ...snpExpect, nonce: NONCE }, { clientKind: "native", observedPeerSpki: SPKI_T }],
  ["domain verified, native, another app id", domain, { ...snpExpect, nonce: NONCE, appId: bytes("other app") }, { clientKind: "native", observedPeerSpki: SPKI_T }],
  ["domain verified, browser (no application-layer key in a domain document)", domain, { ...snpExpect, nonce: NONCE, appId: APP }, { clientKind: "browser" }],
  ["domain verified, nonce already used", domain, { ...snpExpect, nonce: NONCE, appId: APP }, { clientKind: "native", observedPeerSpki: SPKI_T, used: [hex(NONCE)] }],
  ["pVM v2 verified, browser, app key + sealed window", pvmV2, pvmExpect, { clientKind: "browser" }],
  ["pVM v2 verified, native, own peer key is the transport key", pvmV2, pvmExpect, { clientKind: "native", observedPeerSpki: SPKI_T }],
  ["pVM v2 verified, native, another peer key", pvmV2, pvmExpect, { clientKind: "native", observedPeerSpki: SPKI_G }],
  ["pVM v1 verified, browser (no app key)", pvmV1, pvmExpect, { clientKind: "browser" }],
  ["pVM v1 verified, native", pvmV1, pvmExpect, { clientKind: "native", observedPeerSpki: SPKI_T }],
  ["pVM: runtime id not admitted by the client", pvmV2, { ...pvmExpect, allowedRuntimeIds: [hex(bytes("other runtime"))] }, { clientKind: "browser" }],
  ["pVM: empty code hashes", pvmV2, { ...pvmExpect, allowedCodeHashes: [] }, { clientKind: "browser" }],
  ["pVM: empty authority hashes", pvmV2, { ...pvmExpect, allowedAuthorityHashes: [] }, { clientKind: "browser" }],
  // v3 instance binding: the signed policy's instances for the selected deployment are the expectation
  ["pVM v3 verified, browser, deployment bound to this instance", pvmV3, { ...pvmExpect, instanceIds: [IID] }, { clientKind: "browser" }],
  ["pVM v3 verified, native, bound, own peer key is the transport key", pvmV3, { ...pvmExpect, instanceIds: [IID2, IID] }, { clientKind: "native", observedPeerSpki: SPKI_T }],
  ["pVM v3 verified, unbound deployment (no instance expectation)", pvmV3, pvmExpect, { clientKind: "browser" }],
  ["pVM v3: bound to another instance", pvmV3, { ...pvmExpect, instanceIds: [IID2] }, { clientKind: "browser" }],
  ["pVM v3: malformed instance expectation (empty list)", pvmV3, { ...pvmExpect, instanceIds: [] }, { clientKind: "browser" }],
  ["pVM v3: malformed instance expectation (uppercase)", pvmV3, { ...pvmExpect, instanceIds: [IID.toUpperCase()] }, { clientKind: "browser" }],
  ["pVM v3: malformed instance expectation (nine)", pvmV3, { ...pvmExpect, instanceIds: Array.from({ length: 9 }, (_, i) => hex(bytes(`inst ${i}`))) }, { clientKind: "browser" }],
  ["pVM v2 verdict where the deployment is bound (the adapter refuses this as a downgrade; the gate holds too)", pvmV2, { ...pvmExpect, instanceIds: [IID] }, { clientKind: "browser" }],
  ["pVM v3 verdict lacking its InstanceID", { ...pvmV3, claims: { ...pvmV3.claims, instanceId: null } }, pvmExpect, { clientKind: "browser" }],
  ["pVM: empty root pins", pvmV2, { ...pvmExpect, rootPins: [] }, { clientKind: "browser" }],
  ["pVM: another app id expected", pvmV2, { ...pvmExpect, appId: bytes("other app") }, { clientKind: "browser" }],
  ["pVM: the verifier compared another challenge", { ...pvmV2, claims: { ...pvmV2.claims, nonce: hex(bytes("other nonce")) } }, pvmExpect, { clientKind: "browser" }],
  ["pVM: no client nonce", pvmV2, { ...pvmExpect, nonce: undefined }, { clientKind: "browser" }],
  ["pVM: nonce already used", pvmV2, pvmExpect, { clientKind: "browser", used: [hex(NONCE)] }],
  ["unknown client kind", pvmV2, pvmExpect, { clientKind: "curl" }],
  ["malformed verdict (a string)", "verified", pvmExpect, { clientKind: "browser" }],
  ["technology without an admission rule", { ...pvmV2, claims: { ...pvmV2.claims, technology: "intel-tdx" } }, pvmExpect, { clientKind: "browser" }],
];
const toJson = (v) => Buffer.isBuffer(v) ? { hex: hex(v) } : Array.isArray(v) ? v.map(toJson) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)])) : v;
export function runCase([name, verdict, expect, opts]) {
  const reg = createNonceRegistry(); for (const n of opts.used || []) reg.consume(n);
  const r = admit(verdict, expect, { clientKind: opts.clientKind, observedPeerSpki: opts.observedPeerSpki || null, nonceRegistry: reg });
  return { name, verdict: toJson(verdict), expect: toJson(expect), clientKind: opts.clientKind, observedPeerSpki: opts.observedPeerSpki ? hex(opts.observedPeerSpki) : null, usedNonces: opts.used || [], decision: r.decision, reason: r.reasons.at(-1), pinned: r.pinned };
}
export const vectors = () => ({ note: "generated by verifier/admission-vectors.mjs from verifier/admission.mjs; Buffers are {hex}; replayed by test/verifier-admission-vectors.test.mjs; another release-decision implementation must produce the same decision for every case", rule: "release only when status is verified, admissionSafe is true, omissions is empty, every check is true, every expectation is client-supplied and matched, freshness is the client's single-use challenge (or the hosted certificate window), and the transport is bound in a way THIS client kind can check: native = the observed peer key hashes to the bound key, browser = an application-layer key is bound (TLS pinning is never claimed)", cases: cases.map(runCase) });
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const v = vectors(); fs.writeFileSync(VECTORS_PATH, JSON.stringify(v, null, 1) + "\n");
  console.log(`${v.cases.length} vectors -> ${path.relative(process.cwd(), VECTORS_PATH)}: ${v.cases.filter((c) => c.decision === "release").length} release, ${v.cases.filter((c) => c.decision === "hold").length} hold`);
}
