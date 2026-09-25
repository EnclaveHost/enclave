// verifier/web/provenance.mjs: release provenance IN THE BROWSER, from the signed release index's bytes, verified here.
// releaseExpectationsFromMirror({ mirrorUrl }) fetches the relay's same-origin mirror (relay/reverify.mjs mirror(), served
// at /v1/release-index: the index bytes, the index's attestation bundle and each named release's bundle, as the relay
// last fetched them) and then trusts NOTHING the mirror says about them: the index's digest is computed here, its Sigstore
// bundle is verified here against the PINNED trusted root (verifier/roots/sigstore-trusted-root.json, the same pin the
// Node consumers carry), the signing identity and the run invocation are read from the certificate here, the index's
// content checks (verifier/release-index-core.mjs checkIndex) run here, freshness is this client's own memory
// (verifier/index-memory.mjs over localStorage), and each release's bundle is verified here against the digest the SIGNED
// index names for that tag, under the index's floor and revocations. The mirror's status, freshness, publication and
// digest fields are recorded under `mirror.said` and never read for a decision: a mirror that lies gets refused or
// ignored, a mirror that is honest adds nothing. The result has the shape of verifier/consumer.mjs releaseExpectations
// (allowed: [{ tag, measurement, version, flavor, digest }], index: {...}) so the shadow can take its expected
// measurements from here instead of from the primary verifier's Sigstore step, which is the point: the browser obtains
// the expected measurement independently of @tinfoilsh/verifier.
//
// Floors and revocations follow verifier/release-policy.mjs, the same rules and the same compiled-in file as the Node
// consumer (verifier/consumer.mjs): the built-in floor is verifier/release-policy.json's, raised by this browser's
// remembered floor and by a verified index's, never lowered by anything fetched; every result carries `floorApplied`,
// `floorSource` (built-in, remembered, signed index, or an explicit caller floor) and `builtinFloor`.
// Limits, stated: the mirror is the only source here, so a mirror that is down means NO expectation (the caller falls
// back and must say so); this client's memory is per browser profile and starts empty, so the first index a profile sees
// is `first-seen` (authenticity, not freshness: a replayed genuine old index cannot be told from the newest until a newer
// one has been remembered); the same limits as the Node consumers', docs/security/independent-verifier-plan.md 10.5-10.7.
import PINNED_TRUSTED_ROOT from "../roots/sigstore-trusted-root.json" with { type: "json" };
import { verifyReleaseIndex, candidatesFromIndex } from "../release-index-core.mjs";
import { verifyReleaseAttestation } from "../provenance.mjs";
import { RELEASE_POLICY, floorOf, revokedOf, floorRecord } from "../release-policy.mjs";
import { createIndexMemory, webStorageStore, memoryStore } from "../index-memory.mjs";
import { base64ToBytes } from "./x509.mjs";

export const DEFAULT_REPO = "EnclaveHost/enclave";
export { RELEASE_POLICY };
export const MIRROR_PATH = "/v1/release-index";
export const MEMORY_KEY = "enclave.verifierIndexMemory";
export const TRUSTED_ROOT = PINNED_TRUSTED_ROOT;
const URL_RE = /^https?:\/\/[^/?#]+\/[^?#]+$/;   // absolute, with a path, no query or fragment

const safeStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
// this browser's index memory: localStorage under MEMORY_KEY when the page has storage, else a memory that lives for the
// page (which the record then reports as not persisted, so nobody reads a fresh profile's "first-seen" as durable)
export function createBrowserIndexMemory({ storage = safeStorage(), key = MEMORY_KEY, now, log } = {}) {
  const store = storage && typeof storage.getItem === "function" && typeof storage.setItem === "function" ? webStorageStore(storage, key) : memoryStore();
  return createIndexMemory({ store, ...(now ? { now } : {}), ...(log ? { log } : {}) });
}

async function fetchBounded(url, { fetchImpl, timeoutMs, maxBytes }) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ctrl.signal, redirect: "error", credentials: "omit", headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const reader = r.body.getReader(); const chunks = []; let n = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; n += value.length; if (n > maxBytes) { await reader.cancel().catch(() => {}); throw new Error(`body exceeds ${maxBytes} bytes`); } chunks.push(value); }
    const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  } finally { clearTimeout(t); }
}

export async function releaseExpectationsFromMirror({ mirrorUrl, fetchImpl = globalThis.fetch, trustedRoot = PINNED_TRUSTED_ROOT, policy = {}, repo = DEFAULT_REPO, memory = null,
                                                      timeoutMs = 8000, maxBytes = 1024 * 1024, maxIndexBytes = 256 * 1024 } = {}) {
  const out = { source: "mirror", verifiedLocally: true, repo, ok: false, latestTag: null, candidates: [], allowed: [], reasons: [], index: { status: "unavailable" }, mirror: { url: mirrorUrl, fetched: false, said: null } };
  const callerFloor = Array.isArray(policy.minimumRelease) ? policy.minimumRelease : null;
  const remembered = memory && typeof memory.floor === "function" ? memory.floor() : null;
  let floor = floorOf({ caller: callerFloor, remembered });
  let pol = { ...policy, repository: repo, minimumRelease: floor.floor, revoked: revokedOf(policy.revoked) };
  const failIndex = (status, reasons, extra = {}) => {
    out.index = { status, ...extra, ...floorRecord(floor), reasons };
    out.reasons.push(`no release's provenance verified: the signed release index was ${status} (${reasons.join("; ")}); there is no expected measurement, so nothing can be verified (fail closed)`);
    return out;
  };
  if (typeof mirrorUrl !== "string" || !URL_RE.test(mirrorUrl)) return failIndex("unavailable", ["mirrorUrl must be an absolute http(s) URL with a path and no query"]);
  if (typeof fetchImpl !== "function") return failIndex("unavailable", ["no fetch"]);
  // 1. the mirror's bytes, bounded; what it SAYS is recorded and nothing more
  let said;
  try {
    const bytes = await fetchBounded(mirrorUrl, { fetchImpl, timeoutMs, maxBytes });
    said = JSON.parse(new TextDecoder().decode(bytes));
    if (!said || typeof said !== "object" || Array.isArray(said)) throw new Error("the body is not a JSON object");
  } catch (e) { return failIndex("unavailable", [`the mirror could not be read: ${e && e.message ? e.message : e}`]); }
  out.mirror.fetched = true;
  out.mirror.said = { status: said.status ?? null, freshness: said.freshness ?? null, publication: said.publication ?? null, verifiedAt: said.verifiedAt ?? null, note: "what the relay said about its own run: recorded, not used" };
  if (typeof said.indexBytes !== "string" || !said.attestation || typeof said.attestation !== "object" || !said.attestation.bundle) return failIndex("unavailable", [`the mirror carried no index bytes with an attestation bundle (it said: ${said.status ?? "nothing"})`]);
  let indexBytes; try { indexBytes = base64ToBytes(said.indexBytes); } catch (e) { return failIndex("unavailable", [`the mirror's index bytes are not base64: ${e && e.message ? e.message : e}`]); }
  if (indexBytes.length > maxIndexBytes) return failIndex("unavailable", [`the mirror's index is ${indexBytes.length} bytes, over the ${maxIndexBytes}-byte cap`]);
  // 2. the index: digest computed here, signature and identity verified here against the pinned root, content checked here
  let v;
  try { v = await verifyReleaseIndex({ indexBytes, bundle: said.attestation.bundle, trustedRoot, policy: { ...policy, repository: repo } }); }
  catch (e) { v = { ok: false, signed: false, reasons: [`REJECT: the index attestation could not be verified: ${e && e.message ? e.message : e}`] }; }
  if (!v.ok) return failIndex("refused", v.reasons.slice(-2), { authenticity: v.signed ? "signed" : "unverified", ...(v.publication ? { publication: v.publication } : {}), ...(v.digest ? { indexSha256: v.digest } : {}) });
  const base = { authenticity: "signed", indexSha256: v.digest, publication: v.publication, sequenceAuthenticated: v.sequenceAuthenticated, schema: v.schema, generatedAt: v.generatedAt, minimumRelease: `v${v.minimumRelease.join(".")}`, signedTag: v.claims?.tag ?? null };
  // 3. freshness: this client's memory (publication order from the certificate's run invocation; the floor only rises)
  const m = memory ? memory.consider({ publication: v.publication, digest: v.digest, minimumRelease: v.minimumRelease, tag: v.claims?.tag ?? null }) : null;
  if (m && !m.ok) return failIndex("refused", [m.why], { ...base, freshness: m.kind });
  // the index raises the floor (it verified at or above the built-in one) and ADDS revocations: none is ever undone
  floor = floorOf({ caller: callerFloor, remembered, index: v.minimumRelease });
  pol = { ...pol, minimumRelease: floor.floor, revoked: revokedOf(pol.revoked, v.revoked) };
  out.index = { status: "verified", ...base, freshness: m ? m.kind : "not-remembered", latest: Object.fromEntries(Object.entries(v.latest).map(([f, l]) => [f, l.tag])), revoked: v.revoked, ...floorRecord(floor),
                ...(m && m.persisted === false ? { memoryNotPersisted: true } : {}), reasons: v.reasons.slice(-1) };
  out.mirror.indexSha256Claimed = said.indexSha256 === v.digest ? "matches" : "differs from the digest computed here (ignored)";
  out.latestTag = v.latest.gpu?.tag ?? candidatesFromIndex(v)[0]?.tag ?? null;
  // 4. each release the SIGNED index names: its bundle from the mirror, verified against the index's digest for that tag
  const carried = new Map();
  for (const r of Array.isArray(said.releases) ? said.releases : []) if (r && typeof r.tag === "string" && r.attestation && r.attestation.bundle && !carried.has(r.tag)) carried.set(r.tag, r.attestation.bundle);
  for (const c of candidatesFromIndex(v)) {
    const tag = c.tag, digest = String(c.digest || "").toLowerCase();
    const bundle = carried.get(tag);
    if (!bundle) { out.candidates.push({ tag, digest, provenance: "unavailable", why: "the mirror carried no attestation bundle for this tag" }); continue; }
    if (pol.revoked.includes(tag)) { out.candidates.push({ tag, digest, provenance: "refused", why: `revoked (${RELEASE_POLICY.revoked.includes(tag) ? `the built-in policy, ${RELEASE_POLICY.source}` : "by the signed release index or this client's policy"})` }); continue; }
    let r;
    try { r = await verifyReleaseAttestation({ bundle, digestHex: digest, trustedRoot, policy: pol }); }
    catch (e) { r = { ok: false, reasons: [`REJECT: the release attestation could not be verified: ${e && e.message ? e.message : e}`], claims: null }; }
    if (r.ok && r.claims.tag && r.claims.tag !== tag) r = { ok: false, reasons: [...r.reasons, `REJECT: the bundle was signed for ${r.claims.tag}; the index names ${tag}`], claims: null };
    out.candidates.push({ tag, digest, provenance: r.ok ? "verified" : "refused", measurement: r.ok ? r.claims.snpMeasurement : null, version: r.ok ? r.claims.version : null, flavor: r.ok ? r.claims.flavor : null, reasons: r.reasons.slice(-2) });
    if (r.ok) out.allowed.push({ tag, measurement: r.claims.snpMeasurement, version: r.claims.version, flavor: r.claims.flavor, digest });
  }
  out.ok = out.allowed.length > 0;
  out.reasons.push(out.ok ? `${out.allowed.length} release(s) with provenance verified in this client against the pinned Sigstore root: ${out.allowed.map((a) => a.tag).join(", ")}`
                          : "no release's provenance verified: there is no expected measurement, so nothing can be verified (fail closed)");
  return out;
}
