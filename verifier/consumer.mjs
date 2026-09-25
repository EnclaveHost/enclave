// verifier/consumer.mjs: the production consumers' entry into this verifier: the CLI's --verifier mode, the enclave
// self-check's second result and the relay's re-verification of dialed rows (docs/security/independent-verifier-plan.md
// section 9, stages 2, 3 and 6). It composes what already exists and adds nothing to the verdict rules:
//   - ONE capture over the caller's OWN TLS connection (captureHosted): the attestation document and the certificate that
//     handshake presented, together, so the binding is judged on the key this caller actually talked to;
//   - the expected measurements from VERIFIED release provenance only (releaseExpectations: the release's Sigstore bundle
//     against the pinned Sigstore root, verifier/provenance.mjs), never from the enclave, a proxy or a command line;
//   - the verdict from verifier/snp.mjs through the same envelope registry as the harness: a format this verifier does not
//     judge (TDX, GPU, VBS, Hyper-V, anything unknown) is "unsupported", never green;
//   - the Tinfoil reference on the same bytes when the caller asks (referenceVerify), and the comparison in the live
//     differential's words (compareVerdicts: agree, agree-refuse, disagree, reference-missing).
// Everything network-bound is bounded (timeouts, byte caps); nothing is cached here (verifier/collateral-cache.mjs is the
// caller's choice of collateral adapter); nothing is written.
import https from "node:https";
import { isIP } from "node:net";
import { createHash, X509Certificate } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseEnvelope, EnvelopeError, FORMATS, TECH } from "./envelope.mjs";
import { verifySnp, parseReportStrict } from "./snp.mjs";
import { spkiOfCert } from "./tls-binding.mjs";
import { httpCollateral, fileCollateral, memoryCollateral, layeredCollateral } from "./collateral.mjs";
import { cachedCollateral } from "./collateral-cache.mjs";
export { httpCollateral, fileCollateral, memoryCollateral, layeredCollateral, cachedCollateral };
import { verifyReleaseAttestation, DEFAULT_RELEASE_POLICY } from "./provenance.mjs";
import { snpProductHint, kdsVcekUrl } from "../relay/snp-verify.mjs";
import { verifyReleaseIndex, candidatesFromIndex, INDEX_ASSET } from "./release-index.mjs";
import { createFileIndexMemory as createIndexMemory } from "./index-memory-file.mjs";
export { createIndexMemory };
export { webStorageStore, memoryStore } from "./index-memory.mjs";
const cmpVersion = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
import PINNED_TRUSTED_ROOT from "./roots/sigstore-trusted-root.json" with { type: "json" };

export const RAD_PATH = "/.well-known/tinfoil-attestation";
export const DEFAULT_REPO = DEFAULT_RELEASE_POLICY.repository;
export const FLAVOR_SUFFIXES = Object.freeze(["", "-cpu", "-gpu8"]);
export const TRUSTED_ROOT = PINNED_TRUSTED_ROOT;
export const USER_AGENT = "enclave-verifier";
export const GITHUB_API = "https://api.github.com", GITHUB_DOWNLOADS = "https://github.com";
const hex = (b) => Buffer.from(b).toString("hex");
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const TAG_RE = /^v\d+\.\d+\.\d+$/;

// A bounded GET: a timeout, a byte cap enforced while streaming, one accept header. Throws on any non-2xx.
export async function fetchBounded(url, { fetchImpl = globalThis.fetch, timeoutMs = 20000, maxBytes = 4 * 1024 * 1024, accept = "application/json" } = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ctrl.signal, headers: { accept, "user-agent": USER_AGENT }, redirect: "follow" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const chunks = []; let seen = 0;
    for await (const c of r.body ?? []) { seen += c.length; if (seen > maxBytes) { ctrl.abort(); throw new Error(`${url}: body exceeds ${maxBytes} bytes`); } chunks.push(Buffer.from(c)); }
    return Buffer.concat(chunks);
  } finally { clearTimeout(t); }
}

// ---- 1. the expected measurements, from verified release provenance only ----------------------------------------------
// candidates: [{ tag, digest, bundle }] (or { tag, error }) -> { repo, candidates: [...with provenance], allowed: [{ tag,
// measurement, version, flavor, digest }], ok }. A candidate whose provenance does not verify contributes no measurement;
// with no verified candidate there is no expected measurement at all, and every consumer fails closed on that (ok: false).
export async function releaseExpectationsFrom(candidates, { repo = DEFAULT_REPO, trustedRoot = TRUSTED_ROOT, policy = {}, latestTag = null, keepArtifacts = false } = {}) {
  const out = { repo, latestTag, candidates: [], allowed: [], ok: false, reasons: [], ...(keepArtifacts ? { artifacts: { releases: [] } } : {}) };
  for (const c of candidates || []) {
    const tag = String(c?.tag ?? "");
    if (!c || c.error || !c.bundle) { out.candidates.push({ tag, digest: c?.digest ?? null, provenance: "unavailable", why: c?.error || c?.note || "no attestation bundle" }); continue; }
    const digest = String(c.digest || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) { out.candidates.push({ tag, digest: c.digest ?? null, provenance: "refused", why: "the release digest is not 64 hex characters" }); continue; }
    if (Array.isArray(policy.revoked) && policy.revoked.includes(tag)) { out.candidates.push({ tag, digest, provenance: "refused", why: "revoked by the signed release index" }); continue; }
    const r = await verifyReleaseAttestation({ bundle: c.bundle, digestHex: digest, trustedRoot, policy: { ...policy, repository: repo } });
    out.candidates.push({ tag, digest, provenance: r.ok ? "verified" : "refused", measurement: r.ok ? r.claims.snpMeasurement : null,
                          version: r.ok ? r.claims.version : null, flavor: r.ok ? r.claims.flavor : null, reasons: r.reasons.slice(-2) });
    if (r.ok) out.allowed.push({ tag, measurement: r.claims.snpMeasurement, version: r.claims.version, flavor: r.claims.flavor, digest });
    if (r.ok && keepArtifacts) out.artifacts.releases.push({ tag, digest, bundle: c.bundle });
  }
  out.ok = out.allowed.length > 0;
  out.reasons.push(out.ok ? `${out.allowed.length} release(s) with verified provenance: ${out.allowed.map((a) => a.tag).join(", ")}`
                          : "no release's provenance verified: there is no expected measurement, so nothing can be verified (fail closed)");
  return out;
}
// Live: the latest release from GitHub's public API (or explicit tags), each flavor's tinfoil.hash and its attestation
// bundle from the attestation API; then releaseExpectationsFrom. Direct, not through a Tinfoil proxy.
// The SIGNED index first (verifier/release-index.mjs): the latest release's release-index.json and its attestation by
// the file's digest; verified (authenticity) and, with an indexMemory, not older than the last one seen (freshness:
// first-seen | newest-seen | same; replay, equivocation and floor-regression refuse), it names the tags to verify and
// raises the floor. Absent or refused, the unsigned pointer (/releases/latest) is the recorded fallback (`index.status`)
// under the REMEMBERED floor, unless requireIndex, which fails closed. `index.freshness: not-remembered` says a consumer
// without a memory cannot tell a replayed genuine index from the newest: authenticity alone.
export async function releaseExpectations({ repo = DEFAULT_REPO, tags = null, fetchImpl = globalThis.fetch, timeoutMs = 20000, maxBytes = 4 * 1024 * 1024,
                                            apiBase = GITHUB_API, downloadBase = GITHUB_DOWNLOADS, trustedRoot = TRUSTED_ROOT, policy = {}, useIndex = true, requireIndex = false, indexMemory = null, keepArtifacts = false } = {}) {
  let indexArtifact = null;
  const get = (url, accept) => fetchBounded(url, { fetchImpl, timeoutMs, maxBytes, accept });
  let latestTag = null, list = tags, index = { status: "not-consulted" };
  let pol = { ...policy };
  // the remembered floor applies to EVERY path, the fallback included: a fallback never accepts below what a verified index established
  const remembered = indexMemory?.floor?.() ?? null;
  const builtin = pol.minimumRelease ?? DEFAULT_RELEASE_POLICY.minimumRelease;
  if (remembered && cmpVersion(remembered, builtin) > 0) pol = { ...pol, minimumRelease: remembered };
  if (!list && useIndex) {
    try {
      const bytes = await get(`${downloadBase}/${repo}/releases/latest/download/${INDEX_ASSET}`, "application/json");
      const digest = sha256hex(bytes);
      const att = JSON.parse((await get(`${apiBase}/repos/${repo}/attestations/sha256:${digest}`)).toString("utf8"));
      const bundle = att?.attestations?.[0]?.bundle ?? null;
      if (!bundle) index = { status: "unavailable", reasons: ["the attestation API returned no bundle for the index"] };
      else {
        // verified against the caller's (built-in) policy; the REMEMBERED floor is the memory's to judge (floor-regression), not a signature check
        const v = await verifyReleaseIndex({ indexBytes: bytes, bundle, trustedRoot, policy: { ...policy, repository: repo } });
        if (v.ok) {
          const m = indexMemory ? indexMemory.consider({ publication: v.publication, digest: v.digest, minimumRelease: v.minimumRelease, tag: v.claims?.tag ?? null }) : null;
          const base = { authenticity: "signed", publication: v.publication, sequenceAuthenticated: v.sequenceAuthenticated, schema: v.schema, generatedAt: v.generatedAt, minimumRelease: `v${v.minimumRelease.join(".")}`, signedTag: v.claims?.tag ?? null };
          if (m && !m.ok) index = { status: "refused", ...base, freshness: m.kind, reasons: [m.why] };
          else {
            index = { status: "verified", ...base, freshness: m ? m.kind : "not-remembered", latest: Object.fromEntries(Object.entries(v.latest).map(([f, l]) => [f, l.tag])), revoked: v.revoked, ...(m && m.persisted === false ? { memoryNotPersisted: true } : {}) };
            list = candidatesFromIndex(v).map((c) => c.tag); latestTag = v.latest.gpu?.tag ?? list[0] ?? null;
            pol = { ...pol, minimumRelease: v.minimumRelease, revoked: [...new Set([...(Array.isArray(pol.revoked) ? pol.revoked.map(String) : []), ...v.revoked])] };   // the index adds revocations; a caller's is never undone
            if (keepArtifacts) indexArtifact = { bytes: bytes.toString("base64"), sha256: v.digest, bundle };
          }
        } else index = { status: "refused", authenticity: v.signed ? "signed" : "unverified", ...(v.publication ? { publication: v.publication } : {}), reasons: v.reasons.slice(-2) };
      }
    } catch (e) { index = { status: "unavailable", reasons: [e.message] }; }
    if (index.status !== "verified" && requireIndex) return { ...(await releaseExpectationsFrom([], { repo, trustedRoot, policy: pol })), latestTag: null, index: { ...index, floorApplied: `v${(pol.minimumRelease ?? builtin).join(".")}` }, indexError: `the signed release index is required and was ${index.status}${index.freshness ? ` (${index.freshness})` : ""}: ${(index.reasons || []).join("; ")}` };
  }
  if (!list) {
    try {
      latestTag = JSON.parse((await get(`${apiBase}/repos/${repo}/releases/latest`)).toString("utf8"))?.tag_name;
      if (!TAG_RE.test(String(latestTag))) throw new Error(`the release index named ${JSON.stringify(latestTag)}, not a vX.Y.Z tag`);
    } catch (e) { return { ...(await releaseExpectationsFrom([], { repo, trustedRoot, policy: pol })), latestTag: null, index, indexError: e.message }; }
    list = FLAVOR_SUFFIXES.map((s) => latestTag + s);
  }
  const candidates = [];
  for (const tag of list) {
    try {
      const digest = (await get(`${downloadBase}/${repo}/releases/download/${tag}/tinfoil.hash`, "text/plain")).toString("utf8").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(digest)) { candidates.push({ tag, error: `tinfoil.hash is not a sha256 (${digest.slice(0, 24)}...)` }); continue; }
      const att = JSON.parse((await get(`${apiBase}/repos/${repo}/attestations/sha256:${digest}`)).toString("utf8"));
      const bundle = att?.attestations?.[0]?.bundle ?? null;
      candidates.push({ tag, digest, bundle, note: bundle ? null : "the attestation API returned no inline bundle" });
    } catch (e) { candidates.push({ tag, error: e.message }); }
  }
  const from = await releaseExpectationsFrom(candidates, { repo, trustedRoot, policy: pol, latestTag, keepArtifacts });
  return { ...from, index: { ...index, floorApplied: `v${(pol.minimumRelease ?? builtin).join(".")}` }, ...(keepArtifacts ? { artifacts: { index: indexArtifact, releases: from.artifacts?.releases ?? [] } } : {}) };
}

// ---- 2. the capture: the document and the certificate of ONE TLS connection --------------------------------------------
// Node's fetch does not expose the peer certificate, so this is an https.request on a fresh connection: the response and
// res.socket.getPeerX509Certificate() come from the same handshake. WebPKI validation is Node's default (rejectUnauthorized)
// unless the caller's `tls` options say otherwise (a test with its own CA passes { ca }); the verdict never depends on it,
// the binding does: the report must name THIS certificate's key, and the certificate must carry this document's hash.
export function captureHosted({ host, port = 443, path = RAD_PATH, timeoutMs = 20000, maxBytes = 1024 * 1024, tls = {}, now = () => new Date() } = {}) {
  if (!host) return Promise.reject(new Error("captureHosted needs a host"));
  return new Promise((resolve, reject) => {
    const opts = { host, port, path, method: "GET", agent: false, headers: { accept: "application/json", "user-agent": USER_AGENT, connection: "close" }, ...tls };
    if (!isIP(host)) opts.servername = host;
    const req = https.request(opts, (res) => {
      let cert = null, tlsInfo = null;
      try {
        const s = res.socket; cert = s.getPeerX509Certificate() ?? null;
        tlsInfo = { protocol: s.getProtocol?.() ?? null, cipher: s.getCipher?.()?.name ?? null, authorized: s.authorized === true, servername: opts.servername ?? null };
      } catch (e) { req.destroy(e); return; }
      const chunks = []; let n = 0;
      res.on("data", (c) => { n += c.length; if (n > maxBytes) { req.destroy(new Error(`${host}${path}: body exceeds ${maxBytes} bytes`)); return; } chunks.push(c); });
      res.on("error", reject);
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) throw new Error(`${host}${path}: HTTP ${res.statusCode}`);
          if (!cert) throw new Error(`${host}: the TLS connection presented no certificate`);
          let rad; try { rad = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error(`${host}${path}: the body is not JSON`); }
          if (!rad || typeof rad !== "object" || typeof rad.format !== "string" || typeof rad.body !== "string") throw new Error(`${host}${path}: the document is not { format, body }`);
          const certPem = cert.toString();
          const { spki } = spkiOfCert(certPem);
          resolve({ host, port, path, at: now().toISOString(), rad, certPem, spki, tls: tlsInfo,
                    certificate: { subject: cert.subject, issuer: cert.issuer, notBefore: cert.validFrom, notAfter: cert.validTo, sha256: cert.fingerprint256.replace(/:/g, "").toLowerCase(), sans: cert.subjectAltName || "" } });
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${host}: no response within ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}

// ---- 3. the verdict --------------------------------------------------------------------------------------------------
const unsupported = (technology, why) => ({ status: "unsupported", admissionSafe: false, omissions: [], technology, reasons: [`UNSUPPORTED: ${why}`], checks: {}, claims: null });
export function reportOf(rad) {
  const spec = FORMATS[rad?.format];
  if (!spec || spec.technology !== TECH.SNP || spec.supported === false) return null;
  let body = Buffer.from(String(rad.body), "base64");
  if (spec.gzip && body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body, { maxOutputLength: 64 * 1024 });
  const p = parseReportStrict(body);
  const product = snpProductHint(p);
  return { p, product, chipHex: hex(p.chipId), tcbHex: hex(p.reportedTcb), kdsPath: product ? kdsVcekUrl(product, p).replace(/^https:\/\/[^/]+\//, "") : null, measurement: hex(p.measurement), version: p.version };
}
// capture -> the verdict of verifier/snp.mjs under a measurement policy that is exactly the verified releases' measurements.
// collateral: an adapter (verifier/collateral.mjs / collateral-cache.mjs); default AMD KDS over HTTPS with the timeout.
export async function verifyHostedCapture(capture, { allowed = [], minTcb = undefined, policy = {}, collateral = null, timeoutMs = 20000, now = undefined } = {}) {
  const at = now ? new Date(now) : new Date();
  const finish = (v) => {
    const failedChecks = Object.entries(v.checks || {}).filter(([, x]) => x === false).map(([k]) => k);
    const measurement = v.claims?.measurement ?? null;
    return { ...v, at: at.toISOString(), measurement, failedChecks, matched: allowed.find((a) => a.measurement === measurement)?.tag ?? null, expected: allowed.map((a) => a.tag) };
  };
  const rad = capture?.rad;
  let env;
  try { env = parseEnvelope(rad); }
  catch (e) {
    if (!(e instanceof EnvelopeError)) throw e;
    return finish({ status: e.code === "unsupported" ? "unsupported" : "rejected", admissionSafe: false, omissions: [], technology: FORMATS[rad?.format]?.technology ?? null, reasons: [`${e.code.toUpperCase()}: ${e.message}`], checks: {}, claims: null });
  }
  if (env.spec.technology !== TECH.SNP)
    return finish(unsupported(env.spec.technology, `${env.format} carries ${env.spec.technology} evidence, which this consumer does not verify (it judges AMD SEV-SNP evidence only; nothing else is ever green here)`));
  if (!Buffer.isBuffer(capture.spki) || !capture.certPem) return finish({ status: "rejected", admissionSafe: false, omissions: [], technology: TECH.SNP, reasons: ["REJECT: the capture carries no served certificate; the binding cannot be judged"], checks: { binding: false }, claims: null });
  const snpPolicy = { ...policy, allowedMeasurements: allowed.map((a) => a.measurement), ...(minTcb ? { minTcb } : {}) };
  const v = await verifySnp(env, snpPolicy, { transportKeySpki: capture.spki, certPem: capture.certPem, host: capture.host, now: at }, collateral ?? httpCollateral({ timeoutMs }));
  const out = finish({ technology: TECH.SNP, ...v });
  if (!allowed.length) out.reasons.push("no expected measurement was available (no release's provenance verified): the measurement check cannot pass");
  return out;
}

// ---- 4. the reference, on the same bytes -----------------------------------------------------------------------------
// @tinfoilsh/verifier's verifyAttestation (report + chain, with the VCEK handed in) and verifyCertificate (the hosted
// binding), exactly as the live differential runs them. Its own provenance leg (a Tinfoil proxy) is not run: the same
// provenance-derived policy is applied to the measurement it reports, so like is compared with like.
const measurementOf = (m) => typeof m === "string" ? m.toLowerCase() : Array.isArray(m?.registers) && typeof m.registers[0] === "string" ? m.registers[0].toLowerCase() : null;
export async function referenceVerify(capture, { collateral = null, timeoutMs = 20000, load = () => import("@tinfoilsh/verifier") } = {}) {
  let mod = null;
  try { mod = await load(); } catch (e) { return { installed: false, library: "@tinfoilsh/verifier", error: e.message }; }
  if (!mod || typeof mod.verifyAttestation !== "function") return { installed: false, library: "@tinfoilsh/verifier", error: "the module has no verifyAttestation" };
  const ref = { installed: true, library: "@tinfoilsh/verifier" };
  let rep; try { rep = reportOf(capture.rad); } catch (e) { return { ...ref, attestationOk: false, attestationError: `report: ${e.message}` }; }
  if (!rep?.product) return { ...ref, attestationOk: false, attestationError: "not a supported SEV-SNP document (the reference is given nothing)" };
  let vcek = null;
  try { vcek = await (collateral ?? httpCollateral({ timeoutMs })).vcek(rep.product, rep.chipHex, rep.tcbHex, rep.kdsPath); } catch (e) { return { ...ref, attestationOk: false, attestationError: `VCEK: ${e.message}` }; }
  if (!vcek?.der) return { ...ref, attestationOk: false, attestationError: "no VCEK from the collateral source" };
  try { ref.attestation = await mod.verifyAttestation({ format: capture.rad.format, body: capture.rad.body }, Buffer.from(vcek.der).toString("base64")); ref.attestationOk = true; ref.measurement = measurementOf(ref.attestation?.measurement); }
  catch (e) { ref.attestationOk = false; ref.attestationError = e.message; return ref; }
  try { ref.certificate = await mod.verifyCertificate(capture.certPem, capture.host, { format: capture.rad.format, body: capture.rad.body }, ref.attestation.hpkePublicKey); ref.certificateOk = true; }
  catch (e) { ref.certificateOk = false; ref.certificateError = e.message; }
  return ref;
}

// ---- 5. the comparison, in the live differential's words -------------------------------------------------------------
// agree: both verified, the same measurement, one a verified release vouches for. agree-limited: the same, but ours is
// "limited" (every check passed, an omission stands, e.g. no TCB floor was stated): not an acceptance. agree-refuse: both
// refuse and agree on the bytes. disagree: anything else (exit 1 in the differential). reference-missing: nothing to
// compare with; a differential that cannot compare has not run.
export function compareVerdicts({ ours, reference, allowed = [] }) {
  const inProvenance = (m) => !!m && allowed.some((a) => a.measurement === m);
  if (!reference || reference.skipped || reference.installed === false) return { agreement: "reference-missing", reasons: [reference?.error ? `reference: ${reference.error}` : "no reference verifier ran"] };
  const theirsBytes = reference.attestationOk === true && reference.certificateOk === true;
  const theirsAccepts = theirsBytes && inProvenance(reference.measurement);
  const failed = Object.entries(ours?.checks || {}).filter(([, v]) => v === false).map(([k]) => k);
  // "limited" = every check passed and something was NOT judged (an omission such as tcb-floor-unjudged when the caller
  // stated no TCB floor): the bytes are accepted, the verdict is withheld. It is never read as acceptance here either.
  const limitedClean = ours?.status === "limited" && failed.length === 0;
  const oursBytes = ours?.status === "verified" || limitedClean || (ours?.status === "rejected" && failed.length === 1 && failed[0] === "measurement");
  const oursMeasurement = ours?.claims?.measurement ?? null;
  const detail = { bytesAgree: oursBytes === theirsBytes, oursBytesOk: oursBytes, referenceBytesOk: theirsBytes, sameMeasurement: !!reference.measurement && reference.measurement === oursMeasurement,
                   measurementInProvenance: inProvenance(oursMeasurement), oursFailedChecks: failed };
  if (ours?.status === "verified" && theirsAccepts && detail.sameMeasurement) return { agreement: "agree", ...detail, reasons: [`both verified ${oursMeasurement.slice(0, 16)}..., a verified release's measurement`] };
  if (limitedClean && theirsAccepts && detail.sameMeasurement)
    return { agreement: "agree-limited", ...detail, omissions: ours.omissions ?? [], reasons: [`both accept the bytes and the measurement ${oursMeasurement.slice(0, 16)}...; ours withholds "verified" for ${(ours.omissions || []).join(", ") || "an omission"} (the reference applies its own built-in floor; ours judges only a floor the caller states)`] };
  // both refuse: they must also agree on what they saw (two measurements for the same bytes is a disagreement, whatever the policy)
  if (ours?.status !== "verified" && !theirsAccepts && detail.bytesAgree && (!oursBytes || detail.sameMeasurement))
    return { agreement: "agree-refuse", ...detail, reasons: [oursBytes ? `both accept the bytes; the measurement ${oursMeasurement ? oursMeasurement.slice(0, 16) : "-"}... is not one a verified release vouches for` : `both refuse the bytes (ours: ${failed.join(",") || ours?.status}; reference: ${reference.attestationError || reference.certificateError || "refused"})`] };
  return { agreement: "disagree", ...detail, reasons: [`ours ${ours?.status} (${oursMeasurement ? oursMeasurement.slice(0, 16) : "-"}; failed ${failed.join(",") || "none"}), reference bytes ${theirsBytes ? "ok" : "refused"} (${reference.measurement ? reference.measurement.slice(0, 16) : "-"}${reference.attestationError ? `; ${reference.attestationError}` : ""}${reference.certificateError ? `; ${reference.certificateError}` : ""})`] };
}

// ---- 5b. two consumers' verdicts side by side (the CLI's --verifier both, the self-check's two legs) --------------------
// Descriptive, not a verdict: each leg fetched for itself (the reference through its own proxies), so "agree" says the
// two independent runs reached the same green with the same measurement, "agree-limited" that the reference passed
// where ours withheld `verified` for a stated omission, "agree-refuse" that both refused, "differ" anything else, and
// "not-compared" that one leg never ran to a verdict. Nothing here makes a refusal into a pass.
export function dualAgreement({ reference, own }) {
  if (!reference || !own || reference.available === false || own.status === "unavailable") return "not-compared";
  const same = !!reference.measurement && String(reference.measurement).toLowerCase() === String(own.measurement || "").toLowerCase();
  if (reference.pass === true && own.status === "verified" && same) return "agree";
  if (reference.pass === true && own.status === "limited" && same) return "agree-limited";
  if (reference.pass !== true && own.status !== "verified" && own.status !== "limited") return "agree-refuse";
  return "differ";
}

// ---- 6. one call for a consumer ---------------------------------------------------------------------------------------
// expectations: a releaseExpectations() result (the caller may cache it); null fetches it live. reference: true runs the
// Tinfoil reference beside ours; false records it as skipped. The result carries every reason and nothing secret.
export async function verifyHost({ host, port = 443, path = RAD_PATH, timeoutMs = 20000, tls = {}, collateral = null, expectations = null, repo = DEFAULT_REPO,
                                   reference = true, referenceLoad = undefined, minTcb = undefined, policy = {}, now = undefined, fetchImpl = globalThis.fetch, indexMemory = null, requireIndex = false } = {}) {
  const at = (now ? new Date(now) : new Date()).toISOString();
  const exp = expectations ?? await releaseExpectations({ repo, fetchImpl, timeoutMs, indexMemory, requireIndex });
  const out = { verifier: "enclave", host, at, expectations: { repo: exp.repo, latestTag: exp.latestTag ?? null, ok: exp.ok, allowed: exp.allowed.map((a) => ({ tag: a.tag, measurement: a.measurement })), candidates: exp.candidates, index: exp.index ?? null, ...(exp.indexError ? { indexError: exp.indexError } : {}) },
                capture: null, enclave: null, reference: null, comparison: null };
  let cap;
  try { cap = await captureHosted({ host, port, path, timeoutMs, tls, now: () => new Date(at) }); }
  catch (e) { out.enclave = { status: "unavailable", admissionSafe: false, reasons: [`capture: ${e.message}`], checks: {}, claims: null, failedChecks: [], matched: null, expected: exp.allowed.map((a) => a.tag) }; out.comparison = { agreement: "reference-missing", reasons: ["no capture"] }; return out; }
  let rep = null; try { rep = reportOf(cap.rad); } catch { rep = null; }
  out.capture = { at: cap.at, format: cap.rad.format, product: rep?.product ?? null, reportVersion: rep?.version ?? null, measurement: rep?.measurement ?? null, tls: cap.tls, certificate: cap.certificate };
  out.enclave = await verifyHostedCapture(cap, { allowed: exp.allowed, minTcb, policy, collateral, timeoutMs, now: at });
  out.reference = reference ? await referenceVerify(cap, { collateral, timeoutMs, ...(referenceLoad ? { load: referenceLoad } : {}) }) : { skipped: true };
  out.comparison = compareVerdicts({ ours: out.enclave, reference: out.reference, allowed: exp.allowed });
  return out;
}
// ---- 7. the enclave's self-check leg (supervisor.js runSelfCheck, stage 2) ---------------------------------------------
// The enclave verifies ITSELF with this verifier: the capture goes to the shim over loopback (the trusted in-CVM source the
// existing self-check uses; the public hairpin is refused there for a stated reason) with SNI set to the public name so the
// shim presents the public certificate; the certificate and hostname rules are judged against the PUBLIC name. The release
// index may be GitHub directly or the github-proxy the enclave can reach: either only serves bytes that must verify against
// the pinned Sigstore root. Everything failing degrades to a status, never a throw: a self-check is a diagnostic.
export async function selfCheckHosted({ publicHost, loopback = { host: "127.0.0.1", port: 443 }, repo = DEFAULT_REPO, releaseIndex = null, expectations = null,
                                        collateral = null, minTcb = undefined, timeoutMs = 15000, fetchImpl = globalThis.fetch, now = undefined, indexMemory = null, requireIndex = false } = {}) {
  const at = (now ? new Date(now) : new Date()).toISOString();
  const brief = (v, extra = {}) => ({ verifier: "enclave", status: v.status, at, release: v.matched ?? null, expected: v.expected ?? [], measurement: v.measurement ?? null,
                                      failedChecks: v.failedChecks ?? [], omissions: v.omissions ?? [], checks: v.checks ?? {}, reasons: (v.reasons ?? []).slice(-4), ...extra });
  if (!publicHost) return brief({ status: "unavailable", reasons: ["public origin not known yet"] });
  let exp = expectations;
  if (!exp) {
    try { exp = await releaseExpectations({ repo, fetchImpl, timeoutMs, indexMemory, requireIndex, ...(releaseIndex ? { apiBase: releaseIndex.apiBase, downloadBase: releaseIndex.downloadBase ?? releaseIndex.apiBase } : {}) }); }
    catch (e) { return brief({ status: "unavailable", reasons: [`release provenance: ${e.message}`] }); }
  }
  let cap;
  try {
    cap = await captureHosted({ host: loopback.host, port: loopback.port, timeoutMs, tls: { rejectUnauthorized: false, servername: publicHost } });
    cap = { ...cap, host: publicHost };
  } catch (e) { return brief({ status: "unavailable", reasons: [`capture over loopback: ${e.message}`] }, { expected: exp.allowed.map((a) => a.tag), latestTag: exp.latestTag ?? null, indexError: exp.indexError ?? null }); }
  let v;
  try { v = await verifyHostedCapture(cap, { allowed: exp.allowed, minTcb, collateral, timeoutMs, now: at }); }
  catch (e) { return brief({ status: "unavailable", reasons: [`verifier: ${e.message}`] }, { expected: exp.allowed.map((a) => a.tag) }); }
  return brief(v, { latestTag: exp.latestTag ?? null, index: exp.index ?? null, ...(exp.indexError ? { indexError: exp.indexError } : {}), certificate: { subject: cap.certificate.subject, sha256: cap.certificate.sha256, notAfter: cap.certificate.notAfter } });
}
export const sha256Hex = sha256hex;
