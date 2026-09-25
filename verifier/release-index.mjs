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
// minimumRelease. The floor only rises: an index whose floor is below the built-in one is refused.
//
// AUTHENTICITY versus FRESHNESS. The signature proves an index is ours; it does not by itself prove it is the newest.
// The publication ORDER is taken from what the signature authenticates: the signing certificate's run invocation
// (GitHub's OIDC claim, `.../actions/runs/<run_id>/attempts/<attempt>`), which GitHub assigns at run CREATION, which is
// observed to increase with creation time, and which no builder can choose. What that order does NOT say: a higher run
// id is "created later", not "completed later" and not "lists everything published before it"; GitHub documents run
// ids as unique and publishes no ordering guarantee. A consumer's memory therefore refuses what it has already seen
// superseded; it does not prove that nothing newer exists (docs/security/independent-verifier-plan.md, section 10.6). The index file carries the same pair (`sequence` = the
// run id, `attempt`; schema v2) and the verifier requires them to EQUAL the certificate's; a v1 index (the first one,
// v0.5.847, whose `sequence` was a bounded list count) is ordered by its certificate alone and marked as such. A consumer
// that REMEMBERS the highest (run, attempt) it verified (verifier/index-memory.mjs) refuses an older publication
// (replay), the same publication with other bytes (equivocation) and a floor below the remembered one; a re-run of the
// same workflow run is attempt+1 and a re-dispatch a higher run id, both accepted. Concurrent CPU and GPU publications
// are two runs with two ids: the later-created run's index wins, and it lists the releases that existed when it was
// built, so a sibling flavor published in between may be missing until the next publication (a transient gap, never a
// downgrade: the remembered floor still applies). Without a memory, or on the unsigned fallback, only the built-in and
// remembered floors bound a rollback: that gap is stated in the result (`index.freshness`) and closed per consumer by
// `requireIndex` once its memory is in place.
//
//   node verifier/release-index.mjs build  --repo OWNER/NAME --out release-index.json [--predicate F] [--policy F] [--limit 20]
//                                          [--run-id N --run-attempt N]   (default: GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT; required)
//   node verifier/release-index.mjs verify --index F --bundle F [--trusted-root F] [--repo OWNER/NAME] [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compareVersions } from "./provenance.mjs";
import { INDEX_PREDICATE, parseTag, normalizePolicy, normalizePublication, buildReleaseIndex, indexBytesOf, versionString, verifyReleaseIndex } from "./release-index-core.mjs";
export * from "./release-index-core.mjs";

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- the policy file --------------------------------------------------------------------------------------------------
export function readReleasePolicy(file = path.join(REPO, "verifier", "release-policy.json")) {
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  return normalizePolicy(p);
}
// the predicate the attestation carries: the index's own digest and the pointers, so the statement alone names them
export const indexPredicateOf = (indexBytes, index) => ({ schema: INDEX_PREDICATE, indexSha256: sha256hex(indexBytes), repository: index.repository, generatedAt: index.generatedAt, sequence: index.sequence, ...(index.attempt !== undefined ? { attempt: index.attempt } : {}), minimumRelease: index.minimumRelease, latest: index.latest });

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
    const publication = normalizePublication({ runId: opt("run-id") ?? process.env.GITHUB_RUN_ID, attempt: opt("run-attempt") ?? process.env.GITHUB_RUN_ATTEMPT });
    if (!publication) die("--run-id/--run-attempt (or GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT) are required: the index's order is the signing run's, never a count");
    const index = buildReleaseIndex({ releases, policy, repository: repo, publication });
    const bytes = indexBytesOf(index); fs.writeFileSync(out, bytes);
    if (opt("predicate")) fs.writeFileSync(opt("predicate"), JSON.stringify(indexPredicateOf(bytes, index), null, 1) + "\n");
    console.log(`release index: run ${index.sequence} attempt ${index.attempt}; ${releases.length} release(s) with digests of ${list.length}; floor ${index.minimumRelease}; latest ${JSON.stringify(index.latest)}; sha256 ${sha256hex(bytes)} -> ${out}`);
    return;
  }
  if (cmd === "verify") {
    const indexBytes = fs.readFileSync(opt("index") || die("--index F")); const j = JSON.parse(fs.readFileSync(opt("bundle") || die("--bundle F"), "utf8"));
    const bundle = j.attestations ? j.attestations[0]?.bundle : j;
    const trustedRoot = JSON.parse(fs.readFileSync(opt("trusted-root") || path.join(REPO, "verifier", "roots", "sigstore-trusted-root.json"), "utf8"));
    const r = await verifyReleaseIndex({ indexBytes, bundle, trustedRoot, policy: opt("repo") ? { repository: opt("repo") } : undefined });
    if (args.includes("--json")) console.log(JSON.stringify(r, null, 2)); else { for (const x of r.reasons) console.log(x); console.log(r.ok ? `VERIFIED release index: publication run ${r.publication.runId} attempt ${r.publication.attempt} (floor ${versionString(r.minimumRelease)}${r.sequenceAuthenticated ? "" : "; schema v1, ordered by the certificate alone"})` : "REFUSED"); }
    process.exit(r.ok ? 0 : 1);
  }
  die("usage: release-index.mjs build|verify ...");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`release-index: ${e.message}`); process.exit(2); });
