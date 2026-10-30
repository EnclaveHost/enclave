// relay/shield-app-fresh.mjs: ONE Shield app's fresh partition report over a caller's nonce. The relay asks the live node
// once, hands the guest's report back verbatim beside its own expectation (the app derived from the catalog, the images its
// policy admits for that runtime), drops an answer over another nonce, and keeps page reports rare: one app check per box
// at a time, one per app per gap, no retry, a busy node passed on as busy. Only a public deployment leased to the box.
//   run: node --test test/relay-shield-app-fresh.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createShieldAppFresh, appsOn, admittedImages } from "../relay/shield-app-fresh.mjs";

const HOST = { name: "shield-box", id: "0x" + "aa".repeat(32) };
const DEP = "0x" + "d1".repeat(32), RUNTIME = "ee".repeat(32), APP = "cd".repeat(32);
const IMG = "ab".repeat(32), IMG_CFG = "ac".repeat(32), IMG_OTHER = "ad".repeat(32);
const POLICY = { schema: "enclave-shield-app-policy/1", hosts: "*", platforms: "attested", minimumGuestSvn: 3, ekRoots: "x", cpu: { runtimeId: RUNTIME },
  images: [{ measurement: IMG, runtimeId: RUNTIME }, { measurement: IMG_CFG, runtimeId: RUNTIME, configBundleV5: true }, { measurement: IMG_OTHER, runtimeId: "ff".repeat(32) }] };
const lease = () => Math.floor(Date.now() / 1000) + 3600;
const row = (over = {}) => ({ id: DEP, active: true, isPublic: true, runner: HOST.id, leaseUntil: lease(), appRef: "catalog://0x" + "5a".repeat(32) + "/1", ...over });

function world({ answer, rows = { [DEP]: row() }, policy = POLICY } = {}) {
  const paths = [];
  const hub = { info: (n) => (n === HOST.name ? { mode: "hv-node" } : n === "metal0" ? { mode: "snp" } : null),
    request: async (_o, { path }) => { paths.push(path); const n = new URL(path, "http://x").searchParams.get("nonce"); const a = await answer(n);
      return { status: a.status, headers: {}, body: Buffer.from(JSON.stringify(a.body)) }; } };
  let clock = 1_000_000;
  const fresh = createShieldAppFresh({ hub, policy, confirmRow: async (id) => rows[id] || null, appGapMs: 30000, now: () => clock,
    expect: async () => ({ appSha256: APP, runtimeId: RUNTIME, requiresConfigBundleV5: false, requiresSecretsV1: false, requiresConfigSocketServer: false }) });
  return { fresh, paths, tick: (ms) => { clock += ms; }, setRow: (r) => { rows[DEP] = r; } };
}
const good = (n) => ({ status: 200, body: { handshakeSpki: "MFkw", doc: { abi: 2, nonce: n, transportKey: "MFkw", appSha256: APP, report: "e30=" } } });

test("shield-app-fresh: the node's report over the caller's nonce, verbatim, beside this relay's expectation and the images its policy admits", async () => {
  const w = world({ answer: good });
  const nonce = Buffer.alloc(32, 7);
  const leased = { ...HOST };
  w.setRow({ ...row(), leaseUntil: Math.floor(1_000_000 / 1000) + 3600 });
  const r = await w.fresh(leased, DEP, nonce);
  assert.equal(w.paths.length, 1, "one request, no retry");
  assert.equal(w.paths[0], `/v1/shield/evidence?deployment=${DEP}&nonce=${nonce.toString("hex")}`);
  assert.deepEqual(r.document, good(nonce.toString("hex")).body.doc);
  assert.equal(r.handshakeSpki, "MFkw");
  assert.deepEqual([r.expected.appSha256, r.expected.runtimeId], [APP, RUNTIME]); assert.match(r.expected.source, /derived by this relay from the deployment's catalog/);
  assert.deepEqual(r.policy.measurements, [IMG, IMG_CFG], "the images for that runtime that meet its requirements (the relay's own admission candidates)");
  assert.equal(r.policy.minimumGuestSvn, 3); assert.equal(r.policy.platforms, "attested");
});

test('fresh reports carry independently configured image authority pins; incomplete sets are refused before contacting the node', async () => {
  const identity = { signer: '91'.repeat(32), productId: 1818455653, moduleId: 1734437220 };
  const policy = { ...POLICY, images: POLICY.images.map(p => ({ ...p, identity })) };
  const w = world({ answer: good, policy });
  const proof = await w.fresh(HOST, DEP, Buffer.alloc(32, 7));
  assert.deepEqual(proof.policy.imageIdentities, [IMG, IMG_CFG].map(measurement => ({ measurement, identity })));
  const partial = structuredClone(policy); delete partial.images[1].identity;
  const bad = world({ answer: good, policy: partial });
  await assert.rejects(bad.fresh(HOST, DEP, Buffer.alloc(32, 7)), /pins are required/);
  assert.equal(bad.paths.length, 0);
});

test("shield-app-fresh: one check per app per gap and one per box at a time; a busy node is busy; a foreign or missing report is refused; never retried", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const w = world({ answer: async (n) => { await gate; return good(n); } });
  w.setRow({ ...row(), leaseUntil: Math.floor(1_000_000 / 1000) + 3600 });
  const first = w.fresh(HOST, DEP, Buffer.alloc(32, 1));
  await assert.rejects(w.fresh(HOST, "0x" + "d2".repeat(32), Buffer.alloc(32, 2)), (e) => e.code === "busy", "another app on the same box waits");
  release(); await first;
  await assert.rejects(w.fresh(HOST, DEP, Buffer.alloc(32, 3)), (e) => e.code === "busy" && e.retryAfter === 30, "the same app inside its gap");
  w.tick(31_000);
  const busyNode = world({ answer: () => ({ status: 429, body: { error: "evidence_busy" } }) });
  busyNode.setRow({ ...row(), leaseUntil: lease() + 10_000_000 });
  await assert.rejects(busyNode.fresh(HOST, DEP, Buffer.alloc(32, 4)), (e) => e.code === "busy");
  assert.equal(busyNode.paths.length, 1, "not retried");
  const foreign = world({ answer: () => good("00".repeat(32)) }); foreign.setRow({ ...row(), leaseUntil: lease() + 10_000_000 });
  await assert.rejects(foreign.fresh(HOST, DEP, Buffer.alloc(32, 5)), (e) => e.code === "attestation_failed" && /another nonce/.test(e.message));
  const none = world({ answer: () => ({ status: 503, body: { error: "app_evidence_unavailable", reason: "guest busy" } }) }); none.setRow({ ...row(), leaseUntil: lease() + 10_000_000 });
  await assert.rejects(none.fresh(HOST, DEP, Buffer.alloc(32, 6)), (e) => e.code === "busy" && e.retryAfter === 30, "a guest whose report path was busy: busy, not a verdict");
  const broken = world({ answer: () => ({ status: 500, body: { error: "boom" } }) }); broken.setRow({ ...row(), leaseUntil: lease() + 10_000_000 });
  await assert.rejects(broken.fresh(HOST, DEP, Buffer.alloc(32, 7)), (e) => e.code === "attestation_failed" && /500: boom/.test(e.message));
});

test("shield-app-fresh: only a public deployment leased to this Shield box, a well-formed id and nonce, a configured policy", async () => {
  const w = world({ answer: good });
  const bad = async (r, code, re) => { const x = world({ answer: good }); x.setRow(r); await assert.rejects(x.fresh(HOST, DEP, Buffer.alloc(32, 9)), (e) => e.code === code && (!re || re.test(e.message))); assert.equal(x.paths.length, 0, "the node is never asked"); };
  await bad({ ...row(), isPublic: false, leaseUntil: lease() + 1e7 }, "not_here");
  await bad({ ...row(), active: false, leaseUntil: lease() + 1e7 }, "not_here");
  await bad({ ...row(), runner: "0x" + "bb".repeat(32), leaseUntil: lease() + 1e7 }, "not_here");
  await bad({ ...row(), leaseUntil: 1 }, "not_here");
  await assert.rejects(w.fresh({ name: "metal0", id: HOST.id }, DEP, Buffer.alloc(32, 1)), (e) => e.code === "no_box");
  await assert.rejects(w.fresh(HOST, "0x12", Buffer.alloc(32, 1)), (e) => e.code === "bad_deployment");
  await assert.rejects(w.fresh(HOST, DEP, Buffer.alloc(31)), (e) => e.code === "bad_nonce");
  const off = createShieldAppFresh({ hub: {}, policy: null, confirmRow: async () => null });
  await assert.rejects(off(HOST, DEP, Buffer.alloc(32, 1)), (e) => e.code === "not_configured");
});

test("shield-app-fresh: appsOn lists the public deployments leased to the box now; admittedImages follows the app's requirements", () => {
  const now = Date.now(), rows = [row(), row({ id: "0x" + "d2".repeat(32), isPublic: false }), row({ id: "0x" + "d3".repeat(32), runner: "0x" + "bb".repeat(32) }),
    row({ id: "0x" + "d4".repeat(32), leaseUntil: 1 }), row({ id: "0x" + "d5".repeat(32), active: false })];
  assert.deepEqual(appsOn(HOST, rows, now).map((a) => a.id), [DEP]);
  assert.deepEqual(appsOn({ name: "x", id: "tunnel:x" }, rows, now), [], "a box without a registry id serves nothing here");
  assert.deepEqual(admittedImages(POLICY, { runtimeId: RUNTIME, requiresConfigBundleV5: true }), [IMG_CFG]);
  assert.deepEqual(admittedImages(POLICY, { runtimeId: "00".repeat(32) }), []);
});
