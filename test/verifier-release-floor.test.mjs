// The release floor and revocations every consumer applies come from ONE reviewed file, verifier/release-policy.json
// (verifier/release-policy.mjs), in the source modules and in both shipped bundles, and nothing fetched can lower them.
// Evidence on real bytes: the production mirror capture of 2026-09-25 (the index of run 36089632273, v0.5.848 and
// v0.5.848-cpu) and the genuine release v0.5.840, published five minutes before the floor's v0.5.841
// (test/fixtures/verifier/release/v0.5.840.*, SOURCES.json): it verifies under an explicit lower floor and is refused
// as a rollback by default, on every path. Node (verifier/consumer.mjs releaseExpectations against a local stand-in for
// GitHub serving the same index and bundles) and the browser (verifier/web/provenance.mjs releaseExpectationsFromMirror
// against a local mirror) are run on the same cases and compared, from source and from the compiled bundles; a temp copy
// of the tree with a raised floor and a revocation shows the built-in policy FOLLOWS the file.
//   run: node --test test/verifier-release-floor.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_POLICY, floorOf, revokedOf } from "../verifier/release-policy.mjs";
import { DEFAULT_RELEASE_POLICY, verifyReleaseAttestation } from "../verifier/provenance.mjs";
import { readReleasePolicy } from "../verifier/release-index.mjs";
import * as Node from "../verifier/consumer.mjs";
import * as Web from "../verifier/web/provenance.mjs";
import { createIndexMemory, webStorageStore, memoryStore } from "../verifier/index-memory.mjs";
import TRUSTED_ROOT from "../verifier/roots/sigstore-trusted-root.json" with { type: "json" };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const F = path.join(REPO, "test", "fixtures", "verifier");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const MIRROR = JSON.parse(fs.readFileSync(path.join(F, "release-index", "mirror-2026-09-25.json"), "utf8"));
const INDEX_BYTES = Buffer.from(MIRROR.indexBytes, "base64"), INDEX_SHA = sha(INDEX_BYTES);
const BUNDLE_847 = JSON.parse(fs.readFileSync(path.join(F, "release-index", "v0.5.847", "attestation.json"), "utf8")).attestations[0].bundle;
const fixtureRelease = (tag) => ({ tag, digest: fs.readFileSync(path.join(F, "release", `${tag}.tinfoil.hash`), "utf8").trim(), bundle: JSON.parse(fs.readFileSync(path.join(F, "release", `${tag}.attestation.json`), "utf8")).attestations[0].bundle });
const R840 = fixtureRelease("v0.5.840"), R841 = fixtureRelease("v0.5.841");
const RELEASES = new Map([...MIRROR.releases.map((r) => [r.tag, { tag: r.tag, digest: r.digest, bundle: r.attestation.bundle }]), [R840.tag, R840], [R841.tag, R841]]);
const [GPU, CPU] = ["v0.5.848", "v0.5.848-cpu"];
const RUN = MIRROR.publication.runId;
const fakeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } }; };

// one local origin: GitHub's paths for the Node consumer, /v1/release-index for the browser; `world` says what each serves
const world = { index: true, indexBundle: MIRROR.attestation.bundle, latest: "v0.5.840", mirror: MIRROR, mirrorStatus: 200 };
const srv = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(body); };
  if (u === "/v1/release-index") return send(world.mirrorStatus, world.mirrorStatus === 200 ? JSON.stringify(world.mirror) : "{}");
  if (u === "/EnclaveHost/enclave/releases/latest/download/release-index.json") return world.index ? send(200, INDEX_BYTES, "application/octet-stream") : send(404, "Not Found", "text/plain");
  if (u === "/repos/EnclaveHost/enclave/releases/latest") return send(200, JSON.stringify({ tag_name: world.latest }));
  let m = /^\/EnclaveHost\/enclave\/releases\/download\/([^/]+)\/tinfoil\.hash$/.exec(u);
  if (m) return RELEASES.has(m[1]) ? send(200, RELEASES.get(m[1]).digest + "\n", "text/plain") : send(404, "Not Found", "text/plain");
  m = /^\/repos\/EnclaveHost\/enclave\/attestations\/sha256:([0-9a-f]{64})$/.exec(u);
  if (m) {
    if (m[1] === INDEX_SHA) return send(200, JSON.stringify({ attestations: [{ bundle: world.indexBundle }] }));
    for (const r of RELEASES.values()) if (r.digest === m[1]) return send(200, JSON.stringify({ attestations: [{ bundle: r.bundle }] }));
    return send(404, "{}");
  }
  send(404, "Not Found", "text/plain");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
test.after(() => srv.close());
const reset = (w = {}) => Object.assign(world, { index: true, indexBundle: MIRROR.attestation.bundle, latest: "v0.5.840", mirror: MIRROR, mirrorStatus: 200 }, w);
const runNode = (N, o = {}) => N.releaseExpectations({ apiBase: BASE, downloadBase: BASE, timeoutMs: 5000, ...o });
const runWeb = (W, o = {}) => W.releaseExpectationsFromMirror({ mirrorUrl: `${BASE}/v1/release-index`, timeoutMs: 5000, ...o });
const FLOOR_FIELDS = ["floorApplied", "floorSource", "builtinFloor", "callerBelowBuiltin"];
const floorPart = (r) => Object.fromEntries(FLOOR_FIELDS.filter((k) => r.index[k] !== undefined).map((k) => [k, r.index[k]]));
const allowedPart = (r) => r.allowed.map((a) => ({ tag: a.tag, measurement: a.measurement, digest: a.digest, version: a.version, flavor: a.flavor }));

test("the built-in policy IS verifier/release-policy.json: the file, the compiled-in module, the provenance default, and both shipped bundles (whose manifests pin the file's sha256)", async () => {
  const file = readReleasePolicy();
  assert.deepEqual(file, { minimumRelease: [0, 5, 841], revoked: [] }, "the reviewed policy: floor v0.5.841, nothing revoked");
  assert.deepEqual([...RELEASE_POLICY.minimumRelease], file.minimumRelease); assert.deepEqual([...RELEASE_POLICY.revoked], file.revoked); assert.equal(RELEASE_POLICY.source, "verifier/release-policy.json");
  assert.deepEqual([...DEFAULT_RELEASE_POLICY.minimumRelease], file.minimumRelease, "the provenance default is the file's floor, not a hand-kept constant");
  assert.deepEqual([...DEFAULT_RELEASE_POLICY.revoked], file.revoked);
  assert.ok(Object.isFrozen(RELEASE_POLICY) && Object.isFrozen(RELEASE_POLICY.minimumRelease) && Object.isFrozen(DEFAULT_RELEASE_POLICY));
  const fileSha = sha(fs.readFileSync(path.join(REPO, "verifier", "release-policy.json")));
  const bundles = [
    { name: "node", file: path.join(REPO, "verifier", "dist", "enclave-verifier-node.mjs"), manifest: path.join(REPO, "verifier", "dist", "MANIFEST.json") },
    // the relay's copy carries a short manifest naming its source; its inputs are the Node bundle's (same sha256)
    { name: "relay copy", file: path.join(REPO, "relay", "vendor", "enclave-verifier-node.mjs"), manifest: path.join(REPO, "verifier", "dist", "MANIFEST.json"), copyManifest: path.join(REPO, "relay", "vendor", "enclave-verifier-node.MANIFEST.json") },
    { name: "web", file: path.join(REPO, "verifier", "web", "dist", "enclave-verifier-web.js"), manifest: path.join(REPO, "verifier", "web", "dist", "MANIFEST.json") },
    { name: "site vendor", file: path.join(REPO, "site", "vendor", "enclave-verifier.js"), manifest: path.join(REPO, "verifier", "web", "dist", "MANIFEST.json") },
  ];
  for (const b of bundles) {
    const man = JSON.parse(fs.readFileSync(b.manifest, "utf8"));
    if (b.copyManifest) { const cm = JSON.parse(fs.readFileSync(b.copyManifest, "utf8")); assert.equal(cm.copiedFrom, "verifier/dist/enclave-verifier-node.mjs"); assert.equal(cm.artifact.sha256, man.artifact.sha256, `${b.name}: a byte-identical copy`); }
    const input = man.inputs.find((i) => i.path === "verifier/release-policy.json");
    assert.ok(input, `${b.name}: the manifest lists verifier/release-policy.json as a bundled input`);
    assert.equal(input.sha256, fileSha, `${b.name}: the bundled policy is this tree's file`);
    assert.equal(sha(fs.readFileSync(b.file)), man.artifact.sha256, `${b.name}: the artifact is the manifest's`);
    const mod = await import(pathToFileURL(b.file).href);
    assert.deepEqual([...mod.RELEASE_POLICY.minimumRelease], file.minimumRelease, `${b.name}: the compiled-in floor`);
    assert.deepEqual([...mod.RELEASE_POLICY.revoked], file.revoked, `${b.name}: the compiled-in revocations`);
  }
});

test("a genuine release just below the floor: v0.5.840 verifies under an explicit lower floor and is refused by DEFAULT as a rollback; v0.5.841 verifies by default", async () => {
  const lo = await verifyReleaseAttestation({ bundle: R840.bundle, digestHex: R840.digest, trustedRoot: TRUSTED_ROOT, policy: { minimumRelease: [0, 5, 0] } });
  assert.equal(lo.ok, true, lo.reasons.join("\n")); assert.equal(lo.claims.tag, "v0.5.840"); assert.equal(lo.claims.flavor, "gpu");
  const def = await verifyReleaseAttestation({ bundle: R840.bundle, digestHex: R840.digest, trustedRoot: TRUSTED_ROOT });
  assert.equal(def.ok, false); assert.match(def.reasons.at(-1), /v0\.5\.840 is below the minimum release v0\.5\.841 \(a genuine but rolled-back release\)/);
  const at = await verifyReleaseAttestation({ bundle: R841.bundle, digestHex: R841.digest, trustedRoot: TRUSTED_ROOT });
  assert.equal(at.ok, true, at.reasons.join("\n")); assert.match(at.reasons.at(-1), /meets the minimum v0\.5\.841/);
  // the offline path the CLI uses for explicit files (releaseExpectationsFrom), from source and from the Node bundle
  const NB = await import(pathToFileURL(path.join(REPO, "verifier", "dist", "enclave-verifier-node.mjs")).href);
  for (const N of [Node, NB]) {
    const e = await N.releaseExpectationsFrom([R840, R841]);
    assert.deepEqual(e.candidates.map((c) => [c.tag, c.provenance]), [["v0.5.840", "refused"], ["v0.5.841", "verified"]]);
    assert.deepEqual(e.allowed.map((a) => a.tag), ["v0.5.841"]);
  }
});

test("Node and the browser on the same cases, from source: verified index (no memory, fresh memory), index unavailable, index refused, strict, remembered floor, revocation; the floor fields are EQUAL and never below the built-in one", async () => {
  // 1. the index verifies; no memory: the signed index sets the floor (equal to the built-in), both releases allowed
  reset();
  let n = await runNode(Node), w = await runWeb(Web);
  assert.equal(n.index.status, "verified"); assert.equal(w.index.status, "verified");
  assert.deepEqual(floorPart(n), { floorApplied: "v0.5.841", floorSource: "signed index", builtinFloor: "v0.5.841" }); assert.deepEqual(floorPart(w), floorPart(n));
  assert.equal(n.index.freshness, "not-remembered"); assert.equal(w.index.freshness, n.index.freshness);
  assert.deepEqual(allowedPart(w), allowedPart(n)); assert.deepEqual(n.allowed.map((a) => a.tag), [GPU, CPU]);
  // 2. a fresh profile / fresh memory (no history): first-seen in both, the same floor
  n = await runNode(Node, { indexMemory: createIndexMemory({ store: memoryStore() }) }); w = await runWeb(Web, { memory: Web.createBrowserIndexMemory({ storage: fakeStorage() }) });
  assert.equal(n.index.freshness, "first-seen"); assert.equal(w.index.freshness, "first-seen"); assert.deepEqual(floorPart(w), floorPart(n)); assert.deepEqual(allowedPart(w), allowedPart(n));
  // 3. the index is unavailable: Node falls back to the unsigned pointer (v0.5.840, genuine) and REFUSES it under the
  //    built-in floor; the browser has no fallback source (nothing allowed); both apply the built-in floor
  reset({ index: false, mirrorStatus: 503 });
  n = await runNode(Node); w = await runWeb(Web);
  assert.equal(n.index.status, "unavailable"); assert.equal(w.index.status, "unavailable");
  assert.deepEqual(floorPart(n), { floorApplied: "v0.5.841", floorSource: "built-in", builtinFloor: "v0.5.841" }); assert.deepEqual(floorPart(w), floorPart(n));
  assert.equal(n.latestTag, "v0.5.840"); assert.equal(n.candidates[0].tag, "v0.5.840"); assert.equal(n.candidates[0].provenance, "refused");
  assert.match(n.candidates[0].reasons.join(" "), /below the minimum release v0\.5\.841/); assert.deepEqual(n.allowed, []); assert.equal(n.ok, false);
  assert.deepEqual(w.allowed, []); assert.equal(w.ok, false);
  // 4. the index is REFUSED (v0.5.847's index signature over v0.5.848's bytes): the same fallback, the same floor
  reset({ indexBundle: BUNDLE_847, mirror: { ...MIRROR, attestation: { bundle: BUNDLE_847 } } });
  n = await runNode(Node); w = await runWeb(Web);
  assert.equal(n.index.status, "refused"); assert.equal(w.index.status, "refused"); assert.equal(n.index.authenticity, "unverified"); assert.equal(w.index.authenticity, "unverified");
  assert.deepEqual(floorPart(w), floorPart(n)); assert.equal(n.index.floorApplied, "v0.5.841"); assert.deepEqual(n.allowed, []); assert.deepEqual(w.allowed, []);
  // 5. strict (Node's requireIndex; the browser has no other source, so it is strict by construction): fail closed, built-in floor
  reset({ index: false, mirrorStatus: 503 });
  n = await runNode(Node, { requireIndex: true });
  assert.equal(n.ok, false); assert.equal(n.latestTag, null); assert.deepEqual(n.candidates, []); assert.match(n.indexError, /required and was unavailable/); assert.equal(n.index.floorApplied, "v0.5.841");
  // 6. a REMEMBERED higher floor (a newer index once verified with floor v0.5.848): today's index is a floor regression in
  //    both; the remembered floor applies to Node's fallback, so even the pointer's v0.5.848 would need to meet it
  reset({ latest: GPU });
  const seed = (mem) => mem.consider({ publication: { runId: RUN + 7, attempt: 1 }, digest: "ab".repeat(32), minimumRelease: [0, 5, 848], tag: "v0.5.855" });
  const nm = createIndexMemory({ store: memoryStore() }), st = fakeStorage(); seed(nm); seed(createIndexMemory({ store: webStorageStore(st) }));
  n = await runNode(Node, { indexMemory: nm }); w = await runWeb(Web, { memory: Web.createBrowserIndexMemory({ storage: st }) });
  assert.equal(n.index.status, "refused"); assert.equal(w.index.status, "refused"); assert.equal(n.index.freshness, "replay"); assert.equal(w.index.freshness, "replay");
  assert.deepEqual(floorPart(n), { floorApplied: "v0.5.848", floorSource: "remembered", builtinFloor: "v0.5.841" }); assert.deepEqual(floorPart(w), floorPart(n));
  assert.deepEqual(n.allowed.map((a) => a.tag), [GPU, CPU], "Node's fallback: the pointer's v0.5.848 meets the remembered floor v0.5.848"); assert.deepEqual(w.allowed, []);
  // 7. revocations accumulate: a caller's revocation survives a verified index (which revokes nothing), in both
  reset();
  n = await runNode(Node, { policy: { revoked: [GPU] } }); w = await runWeb(Web, { policy: { revoked: [GPU] } });
  assert.deepEqual(n.allowed.map((a) => a.tag), [CPU]); assert.deepEqual(allowedPart(w), allowedPart(n));
  assert.deepEqual(n.candidates.find((c) => c.tag === GPU).provenance, "refused"); assert.deepEqual(w.candidates.find((c) => c.tag === GPU).provenance, "refused");
  assert.deepEqual(revokedOf([GPU], []), [GPU]); assert.deepEqual(revokedOf(null, undefined), []);
});

test("nothing fetched lowers the floor: a mirror claiming a lower floor, an index-shaped object with a lower floor, a relay verdict of 'verified' without bytes; only an EXPLICIT caller floor can be lower, and the result says so", async () => {
  // the mirror's own fields (floorApplied, index.minimumRelease, status) are never read
  reset({ mirror: { ...MIRROR, floorApplied: "v0.5.0", index: { ...MIRROR.index, minimumRelease: "v0.5.0" }, status: "verified" } });
  let w = await runWeb(Web);
  assert.equal(w.index.status, "verified"); assert.equal(w.index.floorApplied, "v0.5.841"); assert.equal(w.index.minimumRelease, "v0.5.841", "the floor read from the SIGNED bytes");
  reset({ mirror: { status: "verified", floorApplied: "v0.5.0", index: { minimumRelease: "v0.5.0" } } });
  w = await runWeb(Web);
  assert.equal(w.index.status, "unavailable"); assert.equal(w.index.floorApplied, "v0.5.841"); assert.equal(w.index.floorSource, "built-in");
  // an explicit caller floor below the built-in one: honoured (the offline CLI's --min-release), never silent
  reset({ index: false, mirrorStatus: 503 });
  const n = await runNode(Node, { policy: { minimumRelease: [0, 5, 0] } });
  assert.deepEqual(floorPart(n), { floorApplied: "v0.5.0", floorSource: "caller", builtinFloor: "v0.5.841", callerBelowBuiltin: true });
  assert.deepEqual(n.allowed.map((a) => a.tag), ["v0.5.840"], "the caller asked for it, and the record shows the floor was the caller's, below the built-in one");
  w = await runWeb(Web, { policy: { minimumRelease: [0, 5, 0] } });
  assert.deepEqual(floorPart(w), floorPart(n));
  // floorOf's rule table: the highest wins; ties name the more specific authority; malformed inputs are ignored
  assert.deepEqual(floorOf({}), { floor: [0, 5, 841], source: "built-in", builtin: [0, 5, 841], callerBelowBuiltin: false });
  assert.equal(floorOf({ remembered: [0, 5, 841] }).source, "remembered"); assert.equal(floorOf({ remembered: [0, 5, 841], index: [0, 5, 841] }).source, "signed index");
  assert.deepEqual(floorOf({ remembered: [0, 5, 850], index: [0, 5, 849] }).floor, [0, 5, 850]);
  assert.deepEqual(floorOf({ remembered: [0, 5, 100] }).floor, [0, 5, 841], "a remembered floor below the built-in one never lowers it");
  assert.deepEqual(floorOf({ index: [0, 5, 100] }).floor, [0, 5, 841], "nor an index's (which checkIndex refuses anyway)");
  for (const bad of ["v0.5.0", [0, 5], [0, 5, -1], [0, 5, 1.5], null]) assert.deepEqual(floorOf({ caller: bad, remembered: bad, index: bad }).floor, [0, 5, 841]);
});

test("the compiled bundles give the SAME results as the source on the same cases (Node bundle vs verifier/consumer.mjs, browser bundle vs verifier/web/provenance.mjs)", async () => {
  const NB = await import(pathToFileURL(path.join(REPO, "verifier", "dist", "enclave-verifier-node.mjs")).href);
  const WB = await import(pathToFileURL(path.join(REPO, "site", "vendor", "enclave-verifier.js")).href);
  const strip = (r) => JSON.parse(JSON.stringify({ ok: r.ok, latestTag: r.latestTag, allowed: r.allowed, candidates: r.candidates, index: r.index, reasons: r.reasons }));
  const cases = [
    ["verified", {}, {}],
    ["unavailable", { index: false, mirrorStatus: 503 }, {}],
    ["refused", { indexBundle: BUNDLE_847, mirror: { ...MIRROR, attestation: { bundle: BUNDLE_847 } } }, {}],
    ["revoked", {}, { policy: { revoked: [GPU] } }],
  ];
  for (const [name, w, o] of cases) {
    reset(w);
    assert.deepEqual(strip(await runNode(NB, o)), strip(await runNode(Node, o)), `Node bundle == source: ${name}`);
    assert.deepEqual(strip(await runWeb(WB, o)), strip(await runWeb(Web, o)), `browser bundle == source: ${name}`);
  }
  // and the bundles' own memories behave as the source's: first-seen, then same over the same store
  reset();
  const st = fakeStorage();
  assert.equal((await runWeb(WB, { memory: WB.createBrowserIndexMemory({ storage: st }) })).index.freshness, "first-seen");
  assert.equal((await runWeb(WB, { memory: WB.createBrowserIndexMemory({ storage: st }) })).index.freshness, "same");
  const nm = NB.createIndexMemory({});
  assert.equal((await runNode(NB, { indexMemory: nm })).index.freshness, "first-seen"); assert.equal((await runNode(NB, { indexMemory: nm })).index.freshness, "same");
});

test("the built-in policy FOLLOWS the file: a copy of the tree with the floor raised to v0.5.848 and v0.5.848-cpu revoked refuses the older signed index (floor v0.5.841) as below its floor, falls back under the raised floor, and keeps the revocation whatever the caller passes; a malformed file fails the import", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "release-floor-"));
  try {
    fs.cpSync(path.join(REPO, "verifier"), path.join(tmp, "verifier"), { recursive: true, filter: (src) => !/[\\/](dist|integration)([\\/]|$)/.test(path.relative(REPO, src)) });
    fs.mkdirSync(path.join(tmp, "relay")); fs.copyFileSync(path.join(REPO, "relay", "snp-verify.mjs"), path.join(tmp, "relay", "snp-verify.mjs"));
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(tmp, "node_modules"), "dir");
    const pol = JSON.parse(fs.readFileSync(path.join(tmp, "verifier", "release-policy.json"), "utf8"));
    fs.writeFileSync(path.join(tmp, "verifier", "release-policy.json"), JSON.stringify({ ...pol, minimumRelease: "v0.5.848", revoked: ["v0.5.848-cpu"] }, null, 1) + "\n");
    const RN = await import(pathToFileURL(path.join(tmp, "verifier", "consumer.mjs")).href);
    const RW = await import(pathToFileURL(path.join(tmp, "verifier", "web", "provenance.mjs")).href);
    const RP = await import(pathToFileURL(path.join(tmp, "verifier", "provenance.mjs")).href);
    assert.deepEqual([...RN.RELEASE_POLICY.minimumRelease], [0, 5, 848]); assert.deepEqual([...RN.RELEASE_POLICY.revoked], ["v0.5.848-cpu"]);
    assert.deepEqual([...RW.RELEASE_POLICY.minimumRelease], [0, 5, 848]); assert.deepEqual([...RP.DEFAULT_RELEASE_POLICY.minimumRelease], [0, 5, 848]);
    // a genuine release below the raised floor is refused by default
    const r841 = await RP.verifyReleaseAttestation({ bundle: R841.bundle, digestHex: R841.digest, trustedRoot: TRUSTED_ROOT });
    assert.equal(r841.ok, false); assert.match(r841.reasons.at(-1), /below the minimum release v0\.5\.848/);
    // the window between a raise and its release: the signed index (floor v0.5.841) is refused as below the built-in floor;
    // Node falls back to the pointer under the raised floor; the built-in revocation holds against a caller's empty list
    reset({ latest: GPU });
    const n = await runNode(RN, { policy: { revoked: [] } });
    assert.equal(n.index.status, "refused"); assert.match(n.index.reasons.join(" "), /BELOW this verifier's built-in floor v0\.5\.848/);
    assert.deepEqual(floorPart(n), { floorApplied: "v0.5.848", floorSource: "built-in", builtinFloor: "v0.5.848" });
    assert.deepEqual(n.candidates.map((c) => [c.tag, c.provenance]), [[GPU, "verified"], [CPU, "refused"], ["v0.5.848-gpu8", "unavailable"]]);
    assert.match(n.candidates[1].why, /built-in policy, verifier\/release-policy\.json/); assert.deepEqual(n.allowed.map((a) => a.tag), [GPU]);
    // the browser: the same refusal, nothing allowed (the site shadow then records its labelled fallback)
    const w = await runWeb(RW, { policy: { revoked: [] } });
    assert.equal(w.index.status, "refused"); assert.deepEqual(floorPart(w), floorPart(n)); assert.deepEqual(w.allowed, []);
    // even a caller that lowers the floor cannot un-revoke a built-in revocation
    const rc = await RP.verifyReleaseAttestation({ bundle: RELEASES.get(CPU).bundle, digestHex: RELEASES.get(CPU).digest, trustedRoot: TRUSTED_ROOT, policy: { minimumRelease: [0, 5, 0], revoked: [] } });
    assert.equal(rc.ok, false); assert.match(rc.reasons.at(-1), /revoked by the built-in release policy/);
    // a malformed policy file fails the import: no bundle or module loads without a valid floor
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), "release-floor-bad-"));
    try {
      fs.copyFileSync(path.join(REPO, "verifier", "release-policy.mjs"), path.join(bad, "release-policy.mjs"));
      fs.writeFileSync(path.join(bad, "release-policy.json"), JSON.stringify({ ...pol, minimumRelease: "v0.5.848-cpu" }));
      await assert.rejects(import(pathToFileURL(path.join(bad, "release-policy.mjs")).href), /bare vX\.Y\.Z tag/);
    } finally { fs.rmSync(bad, { recursive: true, force: true }); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
