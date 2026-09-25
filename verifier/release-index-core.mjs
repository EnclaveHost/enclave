// verifier/release-index-core.mjs: the signed release index, the PURE parts: the schemas, the publication order (the signing
// run's invocation from the certificate), the build of an index from a release list (no I/O), the checks a consumer applies
// after the signature, and the verification of an index's attestation through verifier/provenance.mjs. No Node module:
// this runs unchanged in the browser build (verifier/web/provenance.mjs) and under Node. The builder's I/O, the policy
// file and the command live in verifier/release-index.mjs; the design is written up there and in
// docs/security/independent-verifier-plan.md, sections 10.5 and 10.6.
import { verifyStatementBundle, identityClaimsOf, compareVersions, DEFAULT_RELEASE_POLICY } from "./provenance.mjs";

const sha256HexOf = async (bytes) => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))).map((b) => b.toString(16).padStart(2, "0")).join("");
export const INDEX_SCHEMA = "enclave-release-index/v2";
export const INDEX_SCHEMA_V1 = "enclave-release-index/v1";     // the first index (v0.5.847): `sequence` was a bounded list count, unauthenticated
export const INDEX_SCHEMAS = Object.freeze([INDEX_SCHEMA, INDEX_SCHEMA_V1]);
export const INDEX_PREDICATE = "https://enclave.host/predicate/release-index/v1";
export const INDEX_ASSET = "release-index.json";
export const POLICY_SCHEMA = "enclave-release-policy/v1";
export const FLAVORS = Object.freeze(["gpu", "cpu", "gpu8"]);
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(-cpu|-gpu8)?$/;
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
export const parseTag = (tag) => { const m = TAG_RE.exec(String(tag || "")); return m ? { version: [+m[1], +m[2], +m[3]], flavor: m[4] ? m[4].slice(1) : "gpu" } : null; };
export const versionString = (v) => `v${v.join(".")}`;

// ---- the policy file --------------------------------------------------------------------------------------------------
export function normalizePolicy(p) {
  if (!p || p.schema !== POLICY_SCHEMA) throw new Error(`release policy schema must be ${POLICY_SCHEMA}`);
  const min = parseTag(p.minimumRelease);
  if (!min || min.flavor !== "gpu") throw new Error(`release policy minimumRelease must be a bare vX.Y.Z tag, not ${JSON.stringify(p.minimumRelease)}`);
  const revoked = Array.isArray(p.revoked) ? p.revoked.map(String) : null;
  if (!revoked || revoked.some((t) => !parseTag(t))) throw new Error("release policy revoked must be a list of release tags");
  return { minimumRelease: min.version, revoked };
}

// ---- 1. build (pure) --------------------------------------------------------------------------------------------------
// releases: [{ tag, digest, publishedAt }], every digest the release's own tinfoil.hash. The latest per flavor is the
// highest version among releases that are not revoked and not below the floor; releases below the floor or revoked are
// still LISTED (so a consumer can name what it refuses), never pointed at.
// publication: { runId, attempt } of the workflow run building this index (GitHub's, from the run's own environment);
// the index carries them as `sequence` and `attempt`, and the verifier requires them to equal the signing
// certificate's run invocation. There is no default and no count: an index without a publication is not built.
export function buildReleaseIndex({ releases, policy, repository, generatedAt = new Date().toISOString(), publication = null } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository || ""))) throw new Error("repository must be OWNER/NAME");
  const pub = normalizePublication(publication);
  if (!pub) throw new Error("publication { runId, attempt } is required: the index's order is the signing run's, never a count");
  const pol = normalizePolicy({ schema: POLICY_SCHEMA, minimumRelease: versionString(policy.minimumRelease), revoked: policy.revoked });
  const rows = [];
  for (const r of releases || []) {
    const t = parseTag(r?.tag); if (!t) continue;                                      // not a release tag of ours (drafts, other tags)
    if (!/^[0-9a-f]{64}$/.test(String(r.digest || "").toLowerCase())) continue;         // no tinfoil.hash: not a verifiable release
    rows.push({ tag: r.tag, digest: String(r.digest).toLowerCase(), publishedAt: r.publishedAt ?? null, version: t.version, flavor: t.flavor,
                revoked: pol.revoked.includes(r.tag), belowFloor: compareVersions(t.version, pol.minimumRelease) < 0 });
  }
  rows.sort((a, b) => compareVersions(b.version, a.version) || a.flavor.localeCompare(b.flavor));
  const latest = {};
  for (const f of FLAVORS) { const c = rows.find((r) => r.flavor === f && !r.revoked && !r.belowFloor); if (c) latest[f] = { tag: c.tag, digest: c.digest, publishedAt: c.publishedAt }; }
  return { schema: INDEX_SCHEMA, repository, generatedAt, sequence: pub.runId, attempt: pub.attempt, minimumRelease: versionString(pol.minimumRelease), revoked: [...pol.revoked], latest,
           releases: rows.map((r) => ({ tag: r.tag, digest: r.digest, publishedAt: r.publishedAt, ...(r.revoked ? { revoked: true } : {}), ...(r.belowFloor ? { belowFloor: true } : {}) })) };
}
export const indexBytesOf = (index) => Buffer.from(JSON.stringify(index, null, 1) + "\n", "utf8");

// ---- the publication: GitHub's run invocation, the authenticated order ---------------------------------------------------
const RUN_RE = /\/actions\/runs\/(\d{1,15})\/attempts\/(\d{1,6})$/;
export function normalizePublication(p) {
  if (!p) return null;
  const runId = Number(p.runId), attempt = Number(p.attempt);
  if (!Number.isSafeInteger(runId) || runId <= 0 || !Number.isSafeInteger(attempt) || attempt <= 0) return null;
  return { runId, attempt };
}
// from the signing certificate's run invocation URI (identityClaimsOf(...).runInvocation)
export function publicationOf(runInvocation) {
  const m = RUN_RE.exec(String(runInvocation || ""));
  return m ? { runId: Number(m[1]), attempt: Number(m[2]), uri: String(runInvocation) } : null;
}
export const comparePublications = (a, b) => (a.runId - b.runId) || (a.attempt - b.attempt);

// ---- 2. the checks on a parsed index against the consumer's policy (pure; run after the signature) ----------------------
export function checkIndex({ index, digestHex, predicate, policy = DEFAULT_RELEASE_POLICY, publication = null }) {
  const pol = { ...DEFAULT_RELEASE_POLICY, ...policy };
  const reasons = [], fail = (m) => ({ ok: false, reasons: [...reasons, `REJECT: ${m}`] });
  if (!index || typeof index !== "object") return fail("index is not an object");
  if (!INDEX_SCHEMAS.includes(index.schema)) return fail(`index schema ${JSON.stringify(index.schema)} is not ${INDEX_SCHEMA} (or the first index's ${INDEX_SCHEMA_V1})`);
  const pub = normalizePublication(publication);
  if (!pub) return fail("the signing certificate names no run invocation: the index cannot be ordered, so it is not accepted");
  let sequenceAuthenticated = false;
  if (index.schema === INDEX_SCHEMA) {
    if (index.sequence !== pub.runId || index.attempt !== pub.attempt) return fail(`the index names publication run ${index.sequence} attempt ${index.attempt}, the signing certificate says run ${pub.runId} attempt ${pub.attempt}`);
    if (predicate && (predicate.attempt !== index.attempt)) return fail("the predicate and the index disagree (attempt)");
    sequenceAuthenticated = true;
  } else reasons.push(`index schema v1: its sequence ${index.sequence} is a bounded count, NOT an order; ordered by the signing run ${pub.runId} attempt ${pub.attempt} alone`);
  if (index.repository !== pol.repository) return fail(`index names repository ${JSON.stringify(index.repository)}, the policy's is ${pol.repository}`);
  if (!predicate || predicate.schema !== INDEX_PREDICATE) return fail("the statement's predicate is not a release-index predicate");
  if (String(predicate.indexSha256 || "").toLowerCase() !== String(digestHex).toLowerCase()) return fail("the predicate's indexSha256 is not the digest of these index bytes");
  if (predicate.repository !== index.repository || predicate.sequence !== index.sequence || predicate.minimumRelease !== index.minimumRelease) return fail("the predicate and the index disagree (repository, sequence or minimumRelease)");
  const min = parseTag(index.minimumRelease);
  if (!min || min.flavor !== "gpu") return fail(`index minimumRelease ${JSON.stringify(index.minimumRelease)} is not a bare vX.Y.Z tag`);
  if (compareVersions(min.version, pol.minimumRelease) < 0) return fail(`index floor ${index.minimumRelease} is BELOW this verifier's built-in floor ${versionString(pol.minimumRelease)}: the floor only rises`);
  if (!Number.isInteger(index.sequence) || index.sequence < 0) return fail("index sequence must be a non-negative integer");
  const gen = Date.parse(index.generatedAt); if (!Number.isFinite(gen)) return fail("index generatedAt is not a date");
  if (!Array.isArray(index.revoked) || index.revoked.some((t) => !parseTag(t))) return fail("index revoked must be a list of release tags");
  if (!index.latest || typeof index.latest !== "object") return fail("index has no latest pointers");
  const latest = {};
  for (const [f, e] of Object.entries(index.latest)) {
    if (!FLAVORS.includes(f)) return fail(`index latest names an unknown flavor ${JSON.stringify(f)}`);
    const t = parseTag(e?.tag); if (!t || t.flavor !== f) return fail(`index latest.${f} tag ${JSON.stringify(e?.tag)} is not a ${f} release tag`);
    if (!/^[0-9a-f]{64}$/.test(String(e.digest || ""))) return fail(`index latest.${f} carries no sha256 digest`);
    if (index.revoked.includes(e.tag)) return fail(`index latest.${f} points at a revoked release ${e.tag}`);
    if (compareVersions(t.version, min.version) < 0) return fail(`index latest.${f} ${e.tag} is below the index's own floor ${index.minimumRelease}`);
    latest[f] = { tag: e.tag, digest: e.digest.toLowerCase(), version: t.version };
  }
  if (!Object.keys(latest).length) return fail("index points at no release at all");
  reasons.push(`release index of ${index.generatedAt.slice(0, 19)}Z (run ${pub.runId} attempt ${pub.attempt}): floor ${index.minimumRelease}, latest ${Object.values(latest).map((l) => l.tag).join(", ")}${index.revoked.length ? `, revoked ${index.revoked.join(", ")}` : ""}`);
  return { ok: true, reasons, latest, minimumRelease: min.version, revoked: [...index.revoked], sequence: index.sequence, generatedAt: index.generatedAt, publication: pub, sequenceAuthenticated, schema: index.schema };
}

// ---- 3. verify: the attestation over the bytes, then the checks --------------------------------------------------------
export async function verifyReleaseIndex({ indexBytes, bundle, trustedRoot, policy = DEFAULT_RELEASE_POLICY }) {
  const digestHex = await sha256HexOf(indexBytes);
  const s = await verifyStatementBundle({ bundle, digestHex, trustedRoot, policy, predicateTypes: [INDEX_PREDICATE], subjectName: "the index digest" });
  // `signed` says whether the SIGNATURE and identity verified (authenticity); `ok` needs the checks on the content too
  if (!s.ok) return { ok: false, signed: false, reasons: s.reasons, index: null, claims: null, digest: digestHex };
  let index; try { index = JSON.parse(Buffer.from(indexBytes).toString("utf8")); } catch { return { ok: false, signed: true, reasons: [...s.reasons, "REJECT: the index bytes are not JSON"], index: null, claims: null, digest: digestHex }; }
  const claims = identityClaimsOf(s.cert, s.pol, bundle);
  const publication = publicationOf(claims.runInvocation);
  const c = checkIndex({ index, digestHex, predicate: s.statement.predicate, policy, publication });
  if (!c.ok) return { ok: false, signed: true, reasons: [...s.reasons, ...c.reasons], index, claims, digest: digestHex, publication };
  return { ok: true, signed: true, reasons: [...s.reasons, ...c.reasons], index, claims, digest: digestHex, latest: c.latest, minimumRelease: c.minimumRelease, revoked: c.revoked, sequence: c.sequence, generatedAt: c.generatedAt,
           publication, sequenceAuthenticated: c.sequenceAuthenticated, schema: c.schema };
}
// the release candidates a verified index names, in the shape releaseExpectations() takes
export const candidatesFromIndex = (v) => Object.values(v.latest || {}).map((l) => ({ tag: l.tag, digest: l.digest }));

