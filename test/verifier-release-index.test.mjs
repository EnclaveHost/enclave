// verifier/release-index.mjs: the signed release index. Build (pure) from a release list under a policy; the checks a
// consumer applies after the signature (pure); the attestation gate on authentic material (the v0.5.841 release bundle
// presented AS an index attestation must be refused: right identity, wrong predicate and subject); and the consumers'
// index-first path with its recorded fallback through a local release index; and the FIRST signed index (v0.5.847,
// Publish release run 36086615986, attestation 50058862), pinned at test/fixtures/verifier/release-index/v0.5.847/,
// verified positively and used by the consumers' index-first path with the real bytes.
//   run: node --test test/verifier-release-index.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildReleaseIndex, indexBytesOf, indexPredicateOf, checkIndex, verifyReleaseIndex, candidatesFromIndex, readReleasePolicy, normalizePolicy, parseTag, INDEX_SCHEMA, INDEX_PREDICATE, INDEX_ASSET } from "../verifier/release-index.mjs";
import { releaseExpectations, TRUSTED_ROOT } from "../verifier/consumer.mjs";
import { DEFAULT_RELEASE_POLICY } from "../verifier/provenance.mjs";

const REPO = new URL("..", import.meta.url).pathname, F = path.join(REPO, "test", "fixtures", "verifier", "release");
const rd = (n) => fs.readFileSync(path.join(F, n));
const digestOf = (tag) => rd(`${tag}.tinfoil.hash`).toString().trim();
const bundleOf = (tag) => { const j = JSON.parse(rd(`${tag}.attestation.json`).toString()); return j.attestations ? j.attestations[0]?.bundle : j; };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const D = (n) => n.toString(16).padStart(64, "0");
const POLICY = { minimumRelease: [0, 5, 840], revoked: [] };
const RELEASES = [{ tag: "v0.5.842", digest: D(842), publishedAt: "2026-09-25T00:00:02Z" }, { tag: "v0.5.842-cpu", digest: D(8421), publishedAt: "2026-09-25T00:00:01Z" },
                  { tag: "v0.5.841", digest: D(841), publishedAt: "2026-09-24T00:00:00Z" }, { tag: "v0.5.841-cpu", digest: D(8411), publishedAt: "2026-09-24T00:00:00Z" },
                  { tag: "v0.5.839", digest: D(839), publishedAt: "2026-09-23T00:00:00Z" }, { tag: "v0.5.700-gpu8", digest: D(700), publishedAt: "2026-09-01T00:00:00Z" },
                  { tag: "nightly", digest: D(1) }, { tag: "v0.5.843", digest: "not-a-digest" }];

test("the committed policy file parses: a bare vX.Y.Z floor and a list of revoked tags", () => {
  const p = readReleasePolicy(); assert.deepEqual(p.minimumRelease, [0, 5, 841]); assert.deepEqual(p.revoked, []);
  assert.throws(() => normalizePolicy({ schema: "x" }), /schema/); assert.throws(() => normalizePolicy({ schema: "enclave-release-policy/v1", minimumRelease: "v0.5.841-cpu", revoked: [] }), /bare vX\.Y\.Z/);
  assert.throws(() => normalizePolicy({ schema: "enclave-release-policy/v1", minimumRelease: "v0.5.841", revoked: ["latest"] }), /list of release tags/);
  assert.deepEqual(parseTag("v0.5.842-cpu"), { version: [0, 5, 842], flavor: "cpu" }); assert.equal(parseTag("v0.5"), null);
});
test("build: latest per flavor is the highest release that is neither revoked nor below the floor; others are listed and marked; non-release tags and digest-less releases are left out", () => {
  const i = buildReleaseIndex({ releases: RELEASES, policy: POLICY, repository: "EnclaveHost/enclave", generatedAt: "2026-09-25T02:00:00Z", sequence: 7 });
  assert.equal(i.schema, INDEX_SCHEMA); assert.equal(i.minimumRelease, "v0.5.840"); assert.equal(i.sequence, 7);
  assert.deepEqual(Object.keys(i.latest), ["gpu", "cpu"]); assert.equal(i.latest.gpu.tag, "v0.5.842"); assert.equal(i.latest.cpu.tag, "v0.5.842-cpu");
  assert.equal(i.releases.length, 6, "nightly and the digest-less v0.5.843 are not releases here"); assert.equal(i.releases.find((r) => r.tag === "v0.5.839").belowFloor, true); assert.equal(i.releases.find((r) => r.tag === "v0.5.700-gpu8").belowFloor, true);
  const r = buildReleaseIndex({ releases: RELEASES, policy: { minimumRelease: [0, 5, 840], revoked: ["v0.5.842"] }, repository: "EnclaveHost/enclave" });
  assert.equal(r.latest.gpu.tag, "v0.5.841", "a revoked latest falls back to the next genuine release"); assert.equal(r.releases.find((x) => x.tag === "v0.5.842").revoked, true);
  const bytes = indexBytesOf(i), pred = indexPredicateOf(bytes, i);
  assert.equal(pred.schema, INDEX_PREDICATE); assert.equal(pred.indexSha256, sha(bytes)); assert.deepEqual(pred.latest, i.latest); assert.equal(pred.sequence, 7);
  assert.throws(() => buildReleaseIndex({ releases: [], policy: POLICY, repository: "nope" }), /OWNER\/NAME/);
});
test("checkIndex: every refusal by name; the floor only rises; latest may not point below the floor or at a revoked tag", () => {
  const i = buildReleaseIndex({ releases: RELEASES, policy: POLICY, repository: "EnclaveHost/enclave", generatedAt: "2026-09-25T02:00:00Z", sequence: 7 });
  const bytes = indexBytesOf(i), pred = indexPredicateOf(bytes, i), pol = { ...DEFAULT_RELEASE_POLICY, minimumRelease: [0, 5, 0] };
  const ok = checkIndex({ index: i, digestHex: sha(bytes), predicate: pred, policy: pol });
  assert.equal(ok.ok, true, ok.reasons.join(" ")); assert.deepEqual(ok.minimumRelease, [0, 5, 840]); assert.equal(ok.latest.gpu.tag, "v0.5.842"); assert.match(ok.reasons.at(-1), /floor v0\.5\.840, latest v0\.5\.842, v0\.5\.842-cpu/);
  const refuse = (mut, re, p = pol) => { const x = structuredClone(i), pr = structuredClone(pred); const d = mut(x, pr); const r = checkIndex({ index: x, digestHex: d ?? sha(bytes), predicate: pr, policy: p }); assert.equal(r.ok, false); assert.match(r.reasons.at(-1), re); };
  refuse((x) => { x.schema = "other"; }, /schema/);
  refuse((x) => { x.repository = "Someone/else"; }, /names repository/);
  refuse((x, pr) => { pr.indexSha256 = "00".repeat(32); }, /indexSha256/);
  refuse(() => "ff".repeat(32), /indexSha256/);
  refuse((x, pr) => { pr.sequence = 99; }, /predicate and the index disagree/);
  refuse((x, pr) => { x.minimumRelease = "v0.5.841-cpu"; pr.minimumRelease = x.minimumRelease; }, /bare vX\.Y\.Z/);
  refuse(() => {}, /BELOW this verifier's built-in floor/, { ...pol, minimumRelease: [0, 5, 841] });
  refuse((x) => { x.sequence = -1; }, /sequence/, { ...pol });
  refuse((x, pr) => { x.sequence = 1.5; pr.sequence = 1.5; }, /sequence/);
  refuse((x) => { x.generatedAt = "yesterday"; }, /generatedAt/);
  refuse((x) => { x.revoked = ["x"]; }, /revoked must be/);
  refuse((x) => { x.latest.tdx = { tag: "v0.5.842", digest: D(1) }; }, /unknown flavor/);
  refuse((x) => { x.latest.cpu.tag = "v0.5.842"; }, /not a cpu release tag/);
  refuse((x) => { x.latest.gpu.digest = "zz"; }, /no sha256 digest/);
  refuse((x) => { x.revoked = ["v0.5.842"]; }, /points at a revoked release/);
  refuse((x) => { x.latest.gpu = { tag: "v0.5.839", digest: D(839) }; }, /below the index's own floor/);
  refuse((x) => { x.latest = {}; }, /points at no release/);
});
test("verifyReleaseIndex on authentic material: the v0.5.841 release bundle presented as an index attestation is refused (its subject is the release digest, not the index's; its predicate is the measurement predicate); no bundle and a wrong root are refused", async () => {
  const i = buildReleaseIndex({ releases: RELEASES, policy: POLICY, repository: "EnclaveHost/enclave" }); const bytes = indexBytesOf(i);
  const r = await verifyReleaseIndex({ indexBytes: bytes, bundle: bundleOf("v0.5.841"), trustedRoot: TRUSTED_ROOT });
  assert.equal(r.ok, false); assert.equal(r.digest, sha(bytes)); assert.match(r.reasons.at(-1), /Sigstore verification failed|subject .* is not the (expected|index) digest|predicate type/);
  const n = await verifyReleaseIndex({ indexBytes: bytes, bundle: null, trustedRoot: TRUSTED_ROOT }); assert.equal(n.ok, false); assert.match(n.reasons.at(-1), /bundle is not an object/);
  const w = await verifyReleaseIndex({ indexBytes: bytes, bundle: bundleOf("v0.5.841"), trustedRoot: { certificateAuthorities: [] } }); assert.equal(w.ok, false);
  assert.deepEqual(candidatesFromIndex({ latest: { gpu: { tag: "a", digest: "1" }, cpu: { tag: "b", digest: "2" } } }), [{ tag: "a", digest: "1" }, { tag: "b", digest: "2" }]);
});
// A release index with the three routes the consumers fetch plus the index asset and its attestation route.
async function fakeIndex({ latest = "v0.5.841", indexBytes = null, indexBundle = null } = {}) {
  const srv = http.createServer((req, res) => {
    const u = req.url || "", send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(body); };
    if (u === "/repos/EnclaveHost/enclave/releases/latest") return send(200, JSON.stringify({ tag_name: latest }));
    if (u === `/EnclaveHost/enclave/releases/latest/download/${INDEX_ASSET}`) return indexBytes ? send(200, indexBytes) : send(404, "Not Found", "text/plain");
    let m = /^\/EnclaveHost\/enclave\/releases\/download\/([^/]+)\/tinfoil\.hash$/.exec(u);
    if (m) { const f = path.join(F, `${m[1]}.tinfoil.hash`); return fs.existsSync(f) ? send(200, fs.readFileSync(f), "text/plain") : send(404, "Not Found", "text/plain"); }
    m = /^\/repos\/EnclaveHost\/enclave\/attestations\/sha256:([0-9a-f]{64})$/.exec(u);
    if (m) {
      if (indexBytes && m[1] === sha(indexBytes)) return indexBundle ? send(200, JSON.stringify({ attestations: [{ bundle: indexBundle }] })) : send(404, "{}");
      for (const t of ["v0.5.841", "v0.5.841-cpu"]) if (digestOf(t) === m[1]) return send(200, rd(`${t}.attestation.json`));
      return send(404, "{}");
    }
    return send(404, "{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(() => r())) };
}
test("consumers, index first: no index asset -> `unavailable` and the unsigned pointer is the recorded fallback (still ok); an index whose attestation is a release bundle -> `refused`, fallback; requireIndex fails closed with the reason; useIndex:false never consults it", async () => {
  const i = buildReleaseIndex({ releases: [{ tag: "v0.5.841", digest: digestOf("v0.5.841") }, { tag: "v0.5.841-cpu", digest: digestOf("v0.5.841-cpu") }], policy: { minimumRelease: [0, 5, 841], revoked: [] }, repository: "EnclaveHost/enclave" });
  const bytes = indexBytesOf(i);
  const none = await fakeIndex();
  try {
    const e = await releaseExpectations({ apiBase: none.base, downloadBase: none.base });
    assert.equal(e.ok, true); assert.equal(e.index.status, "unavailable"); assert.match(e.index.reasons[0], /HTTP 404/); assert.deepEqual(e.allowed.map((a) => a.tag), ["v0.5.841", "v0.5.841-cpu"]);
    const strict = await releaseExpectations({ apiBase: none.base, downloadBase: none.base, requireIndex: true });
    assert.equal(strict.ok, false); assert.deepEqual(strict.allowed, []); assert.match(strict.indexError, /signed release index is required and was unavailable/);
    const off = await releaseExpectations({ apiBase: none.base, downloadBase: none.base, useIndex: false });
    assert.equal(off.index.status, "not-consulted"); assert.equal(off.ok, true);
  } finally { await none.close(); }
  const wrong = await fakeIndex({ indexBytes: bytes, indexBundle: bundleOf("v0.5.841") });
  try {
    const e = await releaseExpectations({ apiBase: wrong.base, downloadBase: wrong.base });
    assert.equal(e.index.status, "refused"); assert.ok(e.index.reasons.length); assert.equal(e.ok, true, "the fallback still verified the releases' own provenance"); assert.deepEqual(e.allowed.map((a) => a.tag), ["v0.5.841", "v0.5.841-cpu"]);
    const strict = await releaseExpectations({ apiBase: wrong.base, downloadBase: wrong.base, requireIndex: true }); assert.equal(strict.ok, false); assert.match(strict.indexError, /was refused/);
  } finally { await wrong.close(); }
  const nobundle = await fakeIndex({ indexBytes: bytes, indexBundle: null });
  try { const e = await releaseExpectations({ apiBase: nobundle.base, downloadBase: nobundle.base }); assert.equal(e.index.status, "unavailable"); assert.equal(e.ok, true); } finally { await nobundle.close(); }
});
test("a revoked tag never contributes a measurement, whatever its provenance says", async () => {
  const { releaseExpectationsFrom } = await import("../verifier/consumer.mjs");
  const e = await releaseExpectationsFrom([{ tag: "v0.5.841", digest: digestOf("v0.5.841"), bundle: bundleOf("v0.5.841") }, { tag: "v0.5.841-cpu", digest: digestOf("v0.5.841-cpu"), bundle: bundleOf("v0.5.841-cpu") }], { policy: { revoked: ["v0.5.841"] } });
  assert.deepEqual(e.candidates.map((c) => c.provenance), ["refused", "verified"]); assert.match(e.candidates[0].why, /revoked/); assert.deepEqual(e.allowed.map((a) => a.tag), ["v0.5.841-cpu"]);
});
test("the release workflow carries the index job: its own job after the measure step, pinned actions, the predicate type, the asset name, no secret beyond the job token", () => {
  const y = fs.readFileSync(path.join(REPO, ".github", "workflows", "tinfoil-release-publish.yml"), "utf8");
  assert.match(y, /^  release-index:\n    needs: measure-and-release/m); assert.match(y, /uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6/);
  assert.match(y, /predicate-type: https:\/\/enclave\.host\/predicate\/release-index\/v1/); assert.match(y, /subject-path: release-index\.json/);
  assert.match(y, /node verifier\/release-index\.mjs build --repo "\$\{\{ github\.repository \}\}" --out release-index\.json --predicate release-index\.predicate\.json/);
  const job = y.slice(y.indexOf("  release-index:"), y.indexOf("  update-fleet:"));
  assert.ok(job.indexOf("npm ci --ignore-scripts --no-audit --no-fund") < job.indexOf("node verifier/release-index.mjs build"), "the lockfile install precedes the build: the module imports the Sigstore library at load (the first run failed on ERR_MODULE_NOT_FOUND)");
  assert.match(y, /gh release upload "\$\{\{ github\.ref_name \}\}" release-index\.json --clobber/);
  for (const m of y.matchAll(/uses: ([^@\s]+)@([0-9a-f]{40})/g)) assert.ok(m[2], m[1]);
  assert.equal(/secrets\.(?!GITHUB_TOKEN|TINFOIL_API_KEY)/.test(y), false, "no new secret");
});

const FX = path.join(REPO, "test", "fixtures", "verifier", "release-index", "v0.5.847");
const fxIndex = () => fs.readFileSync(path.join(FX, "release-index.json")), fxBundle = () => JSON.parse(fs.readFileSync(path.join(FX, "attestation.json"), "utf8")).attestations[0].bundle;
test("the first signed index (v0.5.847) VERIFIES: Sigstore under the release identity at refs/tags/v0.5.847, the index predicate, the subject is the file's digest, floor v0.5.841, latest v0.5.847 (gpu) and v0.5.845-cpu (cpu); one changed byte or a built-in floor above the index's refuses", async () => {
  const bytes = fxIndex(), bundle = fxBundle();
  const r = await verifyReleaseIndex({ indexBytes: bytes, bundle, trustedRoot: TRUSTED_ROOT });
  assert.equal(r.ok, true, r.reasons.join(" | ")); assert.equal(r.digest, "0d6ffeab4db91eefd06860610c8314c13a67768fc481b45809485ef70c2e3570"); assert.equal(r.sequence, 100);
  assert.deepEqual(r.minimumRelease, [0, 5, 841]); assert.deepEqual(r.revoked, []); assert.equal(r.latest.gpu.tag, "v0.5.847"); assert.equal(r.latest.cpu.tag, "v0.5.845-cpu");
  assert.equal(r.claims.tag, "v0.5.847"); assert.deepEqual(r.claims.version, [0, 5, 847]); assert.equal(r.claims.flavor, "gpu"); assert.match(r.claims.workflow, /tinfoil-release-publish\.yml@refs\/tags\/v0\.5\.847$/); assert.equal(r.claims.trigger, "workflow_dispatch");
  assert.equal(r.index.releases.length, 20); assert.deepEqual(candidatesFromIndex(r), [{ tag: "v0.5.847", digest: r.latest.gpu.digest }, { tag: "v0.5.845-cpu", digest: r.latest.cpu.digest }]);
  const flipped = Buffer.from(bytes); flipped[flipped.length - 3] ^= 0x01;
  const m = await verifyReleaseIndex({ indexBytes: flipped, bundle, trustedRoot: TRUSTED_ROOT }); assert.equal(m.ok, false); assert.match(m.reasons.at(-1), /Sigstore verification failed|not the index digest/);
  const above = await verifyReleaseIndex({ indexBytes: bytes, bundle, trustedRoot: TRUSTED_ROOT, policy: { minimumRelease: [0, 5, 842] } }); assert.equal(above.ok, false); assert.match(above.reasons.at(-1), /BELOW this verifier's built-in floor v0\.5\.842/);
  const other = await verifyReleaseIndex({ indexBytes: bytes, bundle, trustedRoot: TRUSTED_ROOT, policy: { repository: "Someone/else" } }); assert.equal(other.ok, false);
});
test("consumers with the real signed index: index-first names v0.5.847 and v0.5.845-cpu, raises the floor to v0.5.841, records index.status verified and the signing tag; requireIndex is satisfied; the releases' own provenance is still verified (an unavailable bundle for one leaves it unavailable)", async () => {
  const bytes = fxIndex(), bundle = fxBundle();
  const idx = await fakeIndex({ indexBytes: bytes, indexBundle: bundle });
  try {
    const e = await releaseExpectations({ apiBase: idx.base, downloadBase: idx.base, requireIndex: true });
    assert.equal(e.index.status, "verified"); assert.equal(e.index.sequence, 100); assert.equal(e.index.minimumRelease, "v0.5.841"); assert.deepEqual(e.index.latest, { gpu: "v0.5.847", cpu: "v0.5.845-cpu" }); assert.equal(e.index.signedTag, "v0.5.847");
    assert.equal(e.latestTag, "v0.5.847"); assert.deepEqual(e.candidates.map((c) => c.tag), ["v0.5.847", "v0.5.845-cpu"]);
    // this local index serves no attestation for those two releases (only the v0.5.841 fixtures), so their provenance is unavailable here: the index names them, it never vouches for their measurements
    assert.deepEqual(e.candidates.map((c) => c.provenance), ["unavailable", "unavailable"]); assert.equal(e.ok, false);
  } finally { await idx.close(); }
});
