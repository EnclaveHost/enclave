// The browser's release provenance (verifier/web/provenance.mjs) on the REAL production mirror answer captured on
// 2026-09-25 (test/fixtures/verifier/release-index/mirror-2026-09-25.json: the index of run 36089632273 and the bundles of
// v0.5.848 and v0.5.848-cpu, as api.enclave.host/v1/release-index served them). The module runs unbundled under Node here
// with the same WebCrypto path the bundle uses; the built bundle and the site glue are exercised in
// test/site-verifier-shadow.test.mjs. Every decision is the client's own: the mirror's fields are recorded and ignored,
// the index's signature and identity are checked against the pinned root, the releases against the index's digests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { releaseExpectationsFromMirror, createBrowserIndexMemory, MEMORY_KEY } from "../verifier/web/provenance.mjs";
import { createIndexMemory, memoryStore, webStorageStore } from "../verifier/index-memory.mjs";

const F = new URL("./fixtures/verifier/release-index/", import.meta.url);
const MIRROR = JSON.parse(fs.readFileSync(new URL("mirror-2026-09-25.json", F), "utf8"));
const BUNDLE_847 = JSON.parse(fs.readFileSync(new URL("v0.5.847/attestation.json", F), "utf8")).attestations[0].bundle;
const RUN = 36089632273, GPU = "v0.5.848", CPU = "v0.5.848-cpu";
const HEX96 = /^[0-9a-f]{96}$/;
const fakeStorage = () => { const m = new Map(); return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };

// one server; each test sets what it answers
let answer = { status: 200, body: MIRROR }, hits = [];
const srv = http.createServer((req, res) => {
  hits.push(req.url);
  if (typeof answer === "function") return answer(req, res);
  res.writeHead(answer.status, { "content-type": "application/json" }); res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${srv.address().port}/v1/release-index`;
test.after(() => srv.close());
const run = (opts = {}) => releaseExpectationsFromMirror({ mirrorUrl: URL_, ...opts });
const withIndex = (mut) => { const idx = JSON.parse(Buffer.from(MIRROR.indexBytes, "base64").toString("utf8")); mut(idx); return Buffer.from(JSON.stringify(idx, null, 1) + "\n").toString("base64"); };

test("the production mirror capture verifies in the client: index signed by the release run, both releases' provenance verified against the index's digests, the mirror's own verdict recorded and unused", async () => {
  answer = { status: 200, body: { ...MIRROR, status: "refused", freshness: "replay", verifiedAt: "1999-01-01T00:00:00Z" } };   // a mirror that lies about ITS run changes nothing
  const r = await run();
  assert.equal(r.ok, true, r.reasons.join("\n")); assert.equal(r.source, "mirror"); assert.equal(r.verifiedLocally, true);
  assert.equal(r.index.status, "verified"); assert.equal(r.index.authenticity, "signed"); assert.equal(r.index.freshness, "not-remembered", "no memory given: authenticity only, and it says so");
  assert.deepEqual(r.index.publication, { runId: RUN, attempt: 1, uri: `https://github.com/EnclaveHost/enclave/actions/runs/${RUN}/attempts/1` });
  assert.equal(r.index.sequenceAuthenticated, true); assert.equal(r.index.schema, "enclave-release-index/v2"); assert.equal(r.index.signedTag, GPU);
  assert.equal(r.index.minimumRelease, "v0.5.841"); assert.equal(r.index.floorApplied, "v0.5.841"); assert.deepEqual(r.index.latest, { gpu: GPU, cpu: CPU }); assert.deepEqual(r.index.revoked, []);
  assert.equal(r.index.indexSha256, MIRROR.indexSha256); assert.equal(r.mirror.indexSha256Claimed, "matches");
  assert.equal(r.latestTag, GPU);
  assert.deepEqual(r.allowed.map((a) => a.tag), [GPU, CPU]);
  for (const a of r.allowed) { assert.match(a.measurement, HEX96); assert.deepEqual(a.version, [0, 5, 848]); assert.match(a.digest, /^[0-9a-f]{64}$/); }
  assert.deepEqual(r.allowed.map((a) => a.flavor), ["gpu", "cpu"]);
  assert.notEqual(r.allowed[0].measurement, r.allowed[1].measurement);
  assert.deepEqual(r.candidates.map((c) => c.provenance), ["verified", "verified"]);
  assert.deepEqual(r.mirror.said, { status: "refused", freshness: "replay", publication: MIRROR.publication, verifiedAt: "1999-01-01T00:00:00Z", note: "what the relay said about its own run: recorded, not used" });
  assert.match(r.reasons.at(-1), /2 release\(s\) with provenance verified in this client/);
});

test("memory over web storage: first-seen, then same after a reload (a new memory over the same storage), then replay when the storage remembers a newer publication; a not-persisting storage is reported", async () => {
  answer = { status: 200, body: MIRROR };
  const st = fakeStorage();
  const a = await run({ memory: createBrowserIndexMemory({ storage: st }) });
  assert.equal(a.index.status, "verified"); assert.equal(a.index.freshness, "first-seen"); assert.equal(a.index.memoryNotPersisted, undefined);
  assert.ok(st.map.has(MEMORY_KEY), "the record is in storage under the documented key");
  const saved = JSON.parse(st.map.get(MEMORY_KEY)); assert.equal(saved.publication.runId, RUN); assert.equal(saved.digest, MIRROR.indexSha256);
  const b = await run({ memory: createBrowserIndexMemory({ storage: st }) });   // the page reloaded: a new memory, the same storage
  assert.equal(b.index.freshness, "same"); assert.equal(b.ok, true);
  // the storage remembers a NEWER publication (a later index this profile once verified): today's mirror answer is a replay
  const newer = createIndexMemory({ store: webStorageStore(st) });
  assert.equal(newer.consider({ publication: { runId: RUN + 1, attempt: 1 }, digest: "ab".repeat(32), minimumRelease: [0, 5, 841], tag: "v0.5.849" }).kind, "newest-seen");
  const c = await run({ memory: createBrowserIndexMemory({ storage: st }) });
  assert.equal(c.ok, false); assert.equal(c.index.status, "refused"); assert.equal(c.index.freshness, "replay"); assert.equal(c.index.authenticity, "signed", "a genuine old index: authentic, not fresh");
  assert.deepEqual(c.allowed, []); assert.match(c.reasons.at(-1), /fail closed/);
  // a storage that throws on write: the record is not durable and the result says so; the verdict is unchanged
  const broken = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
  const d = await run({ memory: createBrowserIndexMemory({ storage: broken, log: () => {} }) });
  assert.equal(d.ok, true); assert.equal(d.index.freshness, "first-seen"); assert.equal(d.index.memoryNotPersisted, true);
  // no storage at all (a page without localStorage): a memory for the page, reported the same way
  const e = await run({ memory: createBrowserIndexMemory({ storage: null }) });
  assert.equal(e.index.freshness, "first-seen"); assert.equal(e.index.memoryNotPersisted, undefined, "memoryStore saves for the page; durable for the page's lifetime");
});

test("equivocation: the storage remembers this publication with OTHER bytes; both values are refused, and re-fetching does not clear it", async () => {
  const st = fakeStorage();
  const seeded = createIndexMemory({ store: webStorageStore(st) });
  assert.equal(seeded.consider({ publication: MIRROR.publication, digest: "cd".repeat(32), minimumRelease: [0, 5, 841], tag: GPU }).kind, "first-seen");
  answer = { status: 200, body: MIRROR };
  const a = await run({ memory: createBrowserIndexMemory({ storage: st }) });
  assert.equal(a.ok, false); assert.equal(a.index.status, "refused"); assert.equal(a.index.freshness, "equivocation");
  const b = await run({ memory: createBrowserIndexMemory({ storage: st }) });   // reload, same bytes again
  assert.equal(b.index.freshness, "equivocation"); assert.deepEqual(b.allowed, []);
});

test("swapped index bundle (v0.5.847's signature over v0.5.848's bytes) and tampered index bytes (one digest changed, the mirror's indexSha256 left as it was): refused, unverified, nothing allowed", async () => {
  answer = { status: 200, body: { ...MIRROR, attestation: { bundle: BUNDLE_847 } } };
  const a = await run({ memory: createIndexMemory({ store: memoryStore() }) });
  assert.equal(a.ok, false); assert.equal(a.index.status, "refused"); assert.equal(a.index.authenticity, "unverified"); assert.deepEqual(a.allowed, []); assert.deepEqual(a.candidates, []);
  assert.match(a.reasons.at(-1), /fail closed/);
  answer = { status: 200, body: { ...MIRROR, indexBytes: withIndex((idx) => { idx.latest.gpu.digest = "00" + idx.latest.gpu.digest.slice(2); }) } };
  const b = await run();
  assert.equal(b.ok, false); assert.equal(b.index.status, "refused"); assert.equal(b.index.authenticity, "unverified"); assert.notEqual(b.index.indexSha256, MIRROR.indexSha256, "the digest is computed here, not read from the mirror");
  // the index carried as the mirror's own `index` object is never read: a mirror that swaps it changes nothing
  answer = { status: 200, body: { ...MIRROR, index: { schema: "enclave-release-index/v2", latest: { gpu: { tag: "v9.9.9", digest: "ff".repeat(32) } } } } };
  const c = await run();
  assert.equal(c.ok, true); assert.deepEqual(c.index.latest, { gpu: GPU, cpu: CPU });
});

test("swapped release bundle: the cpu bundle under the gpu tag is refused on the index's digest, the other release still verifies; a lying per-release digest field is ignored; a tag the mirror does not carry is unavailable; a tag the index does not name is not a candidate", async () => {
  const [gpu, cpu] = MIRROR.releases;
  answer = { status: 200, body: { ...MIRROR, releases: [{ tag: GPU, digest: gpu.digest, attestation: cpu.attestation }, cpu] } };
  const a = await run();
  assert.equal(a.ok, true); assert.deepEqual(a.allowed.map((x) => x.tag), [CPU]);
  assert.equal(a.candidates[0].provenance, "refused"); assert.equal(a.candidates[0].tag, GPU); assert.match(a.candidates[0].reasons.join(" "), /digest|subject/i);
  answer = { status: 200, body: { ...MIRROR, releases: [{ ...gpu, digest: "00".repeat(32) }, { ...cpu, digest: "not a digest" }] } };
  const b = await run();
  assert.equal(b.ok, true); assert.deepEqual(b.allowed.map((x) => x.tag), [GPU, CPU]); assert.equal(b.allowed[0].digest, gpu.digest, "the digest comes from the signed index");
  answer = { status: 200, body: { ...MIRROR, releases: [cpu, { tag: "v0.5.999", digest: "ee".repeat(32), attestation: gpu.attestation }] } };
  const c = await run();
  assert.equal(c.ok, true); assert.deepEqual(c.candidates.map((x) => [x.tag, x.provenance]), [[GPU, "unavailable"], [CPU, "verified"]]);
  assert.ok(!c.candidates.some((x) => x.tag === "v0.5.999"));
  answer = { status: 200, body: { ...MIRROR, releases: [] } };
  const d = await run();
  assert.equal(d.ok, false); assert.equal(d.index.status, "verified", "the index verified; no release bundle was carried"); assert.deepEqual(d.candidates.map((x) => x.provenance), ["unavailable", "unavailable"]);
});

test("mirror unavailable: HTTP 503, a non-JSON body, a body over the cap, a redirect, a mirror that says verified but carries no bytes, a bad URL: unavailable, nothing allowed, the reason names the cause", async () => {
  const unavailable = async (opts, why) => { const r = await run(opts); assert.equal(r.ok, false); assert.equal(r.index.status, "unavailable"); assert.deepEqual(r.allowed, []); assert.match(r.index.reasons.join(" "), why); assert.equal(r.index.floorApplied, "v0.5.0", "no index verified: the BUILT-IN floor (the library's, as the Node consumers report it), not the index's"); return r; };
  answer = { status: 503, body: { error: "down" } }; const a = await unavailable({}, /HTTP 503/); assert.equal(a.mirror.fetched, false);
  answer = { status: 200, body: "<html>not json" }; await unavailable({}, /could not be read/);
  answer = { status: 200, body: MIRROR }; await unavailable({ maxBytes: 1000 }, /exceeds 1000 bytes/);
  answer = (req, res) => { res.writeHead(302, { location: URL_ }); res.end(); }; await unavailable({}, /could not be read/);
  answer = { status: 200, body: { status: "verified", freshness: "first-seen", publication: MIRROR.publication } }; const e = await unavailable({}, /no index bytes/); assert.equal(e.mirror.fetched, true); assert.equal(e.mirror.said.status, "verified");
  answer = { status: 200, body: { ...MIRROR, indexBytes: "@@@" } }; await unavailable({}, /not base64|could not/);
  await unavailable({ mirrorUrl: "/v1/release-index" }, /absolute/);
  await unavailable({ mirrorUrl: URL_ + "?x=1" }, /absolute/);
  answer = { status: 200, body: MIRROR }; await unavailable({ fetchImpl: null }, /no fetch/);
});

test("floors: a caller's floor above the index refuses the index; a remembered floor above the index is a floor regression; a revoked tag in the index is refused per release", async () => {
  answer = { status: 200, body: MIRROR };
  const a = await run({ policy: { minimumRelease: [0, 5, 900] } });
  assert.equal(a.ok, false); assert.equal(a.index.status, "refused"); assert.equal(a.index.authenticity, "signed"); assert.match(a.index.reasons.join(" "), /BELOW/); assert.equal(a.index.floorApplied, "v0.5.900");
  const st = fakeStorage();
  createIndexMemory({ store: webStorageStore(st) }).consider({ publication: { runId: RUN - 1, attempt: 1 }, digest: "ab".repeat(32), minimumRelease: [0, 5, 900], tag: "v0.5.900" });
  const b = await run({ memory: createBrowserIndexMemory({ storage: st }) });
  assert.equal(b.ok, false); assert.equal(b.index.freshness, "floor-regression"); assert.equal(b.index.status, "refused");
  // the index is signed with an empty revoked list, so a revocation is exercised through the caller's policy: the index ADDS to it and never undoes it
  const c = await run({ policy: { revoked: [GPU] } });
  assert.deepEqual(c.allowed.map((x) => x.tag), [CPU]); assert.equal(c.candidates[0].provenance, "refused"); assert.match(c.candidates[0].why, /revoked/);
});
