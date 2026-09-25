#!/usr/bin/env node
// verifier/release-index.mjs: the SIGNED release index (docs/security/independent-verifier-plan.md, M4).
//
// Today a consumer learns "which release is current" from GitHub's unauthenticated release index (/releases/latest) and
// then verifies THAT release's Sigstore provenance. Every release it is pointed at is genuine, but the pointer itself is
// not signed: whoever answers for GitHub's API can point a verifier at an older genuine release (a rollback), and the
// verifier's own floor (DEFAULT_RELEASE_POLICY.minimumRelease) is the only thing that stops it. The index closes that:
// the release workflow builds release-index.json (the latest tag and digest per flavor, the floor and the revocation
// list from verifier/release-policy.json at the tag, the recent releases), attests it keylessly under the SAME GitHub
// identity as the releases (actions/attest, predicate https://enclave.host/predicate/release-index/v1, subject = the
// file's sha256), and attaches it to the release. A consumer fetches the index from the latest release, fetches its
// attestation by the file's digest, verifies it through verifier/provenance.mjs (Fulcio chain to the pinned root, SCT,
// Rekor, DSSE, the identity policy), and only then takes its `latest` pointers and raises its floor to the index's
// minimumRelease. The floor only rises: an index whose floor is below the built-in one is refused. What the index does
// NOT solve: an OLD genuine index re-served in place of a newer one (index rollback) is signed too; `sequence` and
// `generatedAt` let a consumer that remembers the last index refuse to go backwards, and the built-in floor bounds the
// damage. A TUF-style timestamp role is the complete answer and is listed as remaining work.
//
//   node verifier/release-index.mjs build  --repo OWNER/NAME --out release-index.json [--predicate F] [--policy F] [--limit 20]
//   node verifier/release-index.mjs verify --index F --bundle F [--trusted-root F] [--repo OWNER/NAME] [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { verifyStatementBundle, identityClaimsOf, compareVersions, DEFAULT_RELEASE_POLICY } from "./provenance.mjs";

export const INDEX_SCHEMA = "enclave-release-index/v1";
export const INDEX_PREDICATE = "https://enclave.host/predicate/release-index/v1";
export const INDEX_ASSET = "release-index.json";
export const POLICY_SCHEMA = "enclave-release-policy/v1";
export const FLAVORS = Object.freeze(["gpu", "cpu", "gpu8"]);
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(-cpu|-gpu8)?$/;
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
export const parseTag = (tag) => { const m = TAG_RE.exec(String(tag || "")); return m ? { version: [+m[1], +m[2], +m[3]], flavor: m[4] ? m[4].slice(1) : "gpu" } : null; };
export const versionString = (v) => `v${v.join(".")}`;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- the policy file --------------------------------------------------------------------------------------------------
export function readReleasePolicy(file = path.join(REPO, "verifier", "release-policy.json")) {
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  return normalizePolicy(p);
}
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
export function buildReleaseIndex({ releases, policy, repository, generatedAt = new Date().toISOString(), sequence = null } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository || ""))) throw new Error("repository must be OWNER/NAME");
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
  const seq = sequence ?? rows.length;
  return { schema: INDEX_SCHEMA, repository, generatedAt, sequence: seq, minimumRelease: versionString(pol.minimumRelease), revoked: [...pol.revoked], latest,
           releases: rows.map((r) => ({ tag: r.tag, digest: r.digest, publishedAt: r.publishedAt, ...(r.revoked ? { revoked: true } : {}), ...(r.belowFloor ? { belowFloor: true } : {}) })) };
}
export const indexBytesOf = (index) => Buffer.from(JSON.stringify(index, null, 1) + "\n", "utf8");
// the predicate the attestation carries: the index's own digest and the pointers, so the statement alone names them
export const indexPredicateOf = (indexBytes, index) => ({ schema: INDEX_PREDICATE, indexSha256: sha256hex(indexBytes), repository: index.repository, generatedAt: index.generatedAt, sequence: index.sequence, minimumRelease: index.minimumRelease, latest: index.latest });

// ---- 2. the checks on a parsed index against the consumer's policy (pure; run after the signature) ----------------------
export function checkIndex({ index, digestHex, predicate, policy = DEFAULT_RELEASE_POLICY }) {
  const pol = { ...DEFAULT_RELEASE_POLICY, ...policy };
  const reasons = [], fail = (m) => ({ ok: false, reasons: [...reasons, `REJECT: ${m}`] });
  if (!index || typeof index !== "object") return fail("index is not an object");
  if (index.schema !== INDEX_SCHEMA) return fail(`index schema ${JSON.stringify(index.schema)} is not ${INDEX_SCHEMA}`);
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
  reasons.push(`release index ${index.sequence} of ${index.generatedAt.slice(0, 19)}Z: floor ${index.minimumRelease}, latest ${Object.values(latest).map((l) => l.tag).join(", ")}${index.revoked.length ? `, revoked ${index.revoked.join(", ")}` : ""}`);
  return { ok: true, reasons, latest, minimumRelease: min.version, revoked: [...index.revoked], sequence: index.sequence, generatedAt: index.generatedAt };
}

// ---- 3. verify: the attestation over the bytes, then the checks --------------------------------------------------------
export async function verifyReleaseIndex({ indexBytes, bundle, trustedRoot, policy = DEFAULT_RELEASE_POLICY }) {
  const digestHex = sha256hex(indexBytes);
  const s = await verifyStatementBundle({ bundle, digestHex, trustedRoot, policy, predicateTypes: [INDEX_PREDICATE], subjectName: "the index digest" });
  if (!s.ok) return { ok: false, reasons: s.reasons, index: null, claims: null, digest: digestHex };
  let index; try { index = JSON.parse(Buffer.from(indexBytes).toString("utf8")); } catch { return { ok: false, reasons: [...s.reasons, "REJECT: the index bytes are not JSON"], index: null, claims: null, digest: digestHex }; }
  const c = checkIndex({ index, digestHex, predicate: s.statement.predicate, policy });
  const claims = identityClaimsOf(s.cert, s.pol, bundle);
  if (!c.ok) return { ok: false, reasons: [...s.reasons, ...c.reasons], index, claims, digest: digestHex };
  return { ok: true, reasons: [...s.reasons, ...c.reasons], index, claims, digest: digestHex, latest: c.latest, minimumRelease: c.minimumRelease, revoked: c.revoked, sequence: c.sequence, generatedAt: c.generatedAt };
}
// the release candidates a verified index names, in the shape releaseExpectations() takes
export const candidatesFromIndex = (v) => Object.values(v.latest || {}).map((l) => ({ tag: l.tag, digest: l.digest }));

// ---- 4. the command ---------------------------------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2), cmd = args.shift();
  const opt = (n, d = null) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
  const die = (m) => { console.error(`release-index: ${m}`); process.exit(2); };
  if (cmd === "build") {
    const repo = opt("repo") || process.env.GITHUB_REPOSITORY || die("--repo OWNER/NAME"), out = opt("out") || die("--out F"), limit = Number(opt("limit", "20"));
    const policy = readReleasePolicy(opt("policy") || undefined);
    const headers = { accept: "application/vnd.github+json", "user-agent": "enclave-release-index", ...(process.env.GH_TOKEN || process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}` } : {}) };
    const get = async (url, accept) => { const r = await fetch(url, { headers: { ...headers, ...(accept ? { accept } : {}) }, signal: AbortSignal.timeout(20000), redirect: "follow" }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
    const list = JSON.parse((await get(`https://api.github.com/repos/${repo}/releases?per_page=100`)).toString("utf8")).filter((r) => !r.draft && parseTag(r.tag_name));
    list.sort((a, b) => compareVersions(parseTag(b.tag_name).version, parseTag(a.tag_name).version));
    const releases = [];
    for (const r of list.slice(0, limit)) {
      const asset = (r.assets || []).find((a) => a.name === "tinfoil.hash");
      if (!asset) { console.error(`release-index: ${r.tag_name}: no tinfoil.hash asset, listed without a digest`); continue; }
      let digest = null; try { digest = (await get(asset.browser_download_url, "application/octet-stream")).toString("utf8").trim().toLowerCase(); } catch (e) { console.error(`release-index: ${r.tag_name}: ${e.message}`); continue; }
      releases.push({ tag: r.tag_name, digest, publishedAt: r.published_at });
    }
    const index = buildReleaseIndex({ releases, policy, repository: repo, sequence: list.length });
    const bytes = indexBytesOf(index); fs.writeFileSync(out, bytes);
    if (opt("predicate")) fs.writeFileSync(opt("predicate"), JSON.stringify(indexPredicateOf(bytes, index), null, 1) + "\n");
    console.log(`release index: ${releases.length} release(s) with digests of ${list.length}; floor ${index.minimumRelease}; latest ${JSON.stringify(index.latest)}; sha256 ${sha256hex(bytes)} -> ${out}`);
    return;
  }
  if (cmd === "verify") {
    const indexBytes = fs.readFileSync(opt("index") || die("--index F")); const j = JSON.parse(fs.readFileSync(opt("bundle") || die("--bundle F"), "utf8"));
    const bundle = j.attestations ? j.attestations[0]?.bundle : j;
    const trustedRoot = JSON.parse(fs.readFileSync(opt("trusted-root") || path.join(REPO, "verifier", "roots", "sigstore-trusted-root.json"), "utf8"));
    const r = await verifyReleaseIndex({ indexBytes, bundle, trustedRoot, policy: opt("repo") ? { repository: opt("repo") } : undefined });
    if (args.includes("--json")) console.log(JSON.stringify(r, null, 2)); else { for (const x of r.reasons) console.log(x); console.log(r.ok ? `VERIFIED release index ${r.sequence} (floor ${versionString(r.minimumRelease)})` : "REFUSED"); }
    process.exit(r.ok ? 0 : 1);
  }
  die("usage: release-index.mjs build|verify ...");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`release-index: ${e.message}`); process.exit(2); });
