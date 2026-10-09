// test/verifier-hyperv-shield.test.mjs: a NucBox Shield partition document that carries the guest's VBS report is judged by
// verifier/index.mjs through the relay's own Shield checks (verifier/hyperv.mjs): "verified" only with a complete host TPM
// session, the policy's platform and image/runtime pins, this connection's key, this verifier's nonce and the expected app; every
// verdict says the host is not excluded; the consumer gate holds it; the browser build never verifies it. Synthetic TPM world
// (test/fixtures/vbs-synthetic.mjs), so it needs openssl.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash, sign, constants, generateKeyPairSync } from "node:crypto";
import { verifyEvidence, admit } from "../verifier/index.mjs";
import { verifyEvidenceWeb } from "../verifier/web/index.mjs";
import { hvNodeBinding } from "../relay/hvnode-verify.mjs";
import { ABI2, bind2, runtimeId } from "../isolation/contract/runtime.mjs";
import { haveOpenssl, tmpdir, makeVbsWorld, buildLog, buildQuote } from "./fixtures/vbs-synthetic.mjs";

const sha = (b) => createHash("sha256").update(b).digest(), b64 = (b) => b.toString("base64");
const world = haveOpenssl ? makeVbsWorld(tmpdir("verifier-hv-")) : null;
const IMAGE = "ab".repeat(32), APP = "cd".repeat(32), FORMAT = "hyperv-partition-domain/v1";
const RUNTIME = { name: "wasmtime", version: "48.0.1", execution: "jit", targetIsa: "x86_64", hostIsa: "x86_64", cpuFeatures: "host-detected", wx: "enforced", cache: "none" };
const RID = runtimeId(RUNTIME);
const options = { skip: !haveOpenssl && "openssl absent" };

// The paravisor's HCLA envelope around a VBS report (relay/vbs-vm-report.mjs layout), signed by `signer`.
function vbsReport(input, { signer = world.idks.privateKey, debug = 0, image = IMAGE } = {}) {
  const claims = Buffer.from(JSON.stringify({ "user-data": input.toString("hex") })), env = Buffer.alloc(1236 + claims.length);
  const w = (o, n) => env.writeUInt32LE(n, o);
  w(0, 0x414c4348); w(4, 2); w(8, env.length); w(12, 2); w(1216, 20 + claims.length); w(1220, 1); w(1224, 1); w(1228, 1); w(1232, claims.length); claims.copy(env, 1236);
  const r = env.subarray(32, 592); [560, 1, 1, 256, 0, 2].forEach((n, i) => r.writeUInt32LE(n, i * 4)); sha(claims).copy(r, 24); Buffer.from(image, "hex").copy(r, 120);
  r.writeUInt32LE(5, 216); r.writeUInt32LE(debug, 220); r.writeUInt32LE(2, 224);
  sign("sha256", r.subarray(0, 304), { key: signer, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).copy(r, 304);
  return env;
}

// One exchange: the caller's own host session (its nonce, its minted credential) and the partition's document for its request.
function exchange({ report = {}, boot = {}, vbs = true } = {}) {
  const hostNonce = randomBytes(32), credential = randomBytes(32), statement = Buffer.from("{}");
  const bound = hvNodeBinding(world.transport.spki, hostNonce, statement);
  const L = buildLog({ idksPub: world.idks.publicKey, ...boot });
  const Q = buildQuote({ aikPriv: world.aik.privateKey, aikName: world.aik.name, pcrs: L.pcrs, pcr0: world.pcr0, extraData: sha(bound) });
  const evidence = { statement: b64(statement), signature: b64(sign(null, bound, world.transport.privateKey)), log: b64(L.log),
    quote: { attest: b64(Q.attest), sig: b64(Q.sig), aikPub: b64(world.aik.tpmtPublic) }, credential: b64(credential),
    ek: { cert: b64(world.ek.cert), chain: [b64(world.ca.inter)] }, pcr0: world.pcr0.toString("hex") };
  const spki = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }), nonce = randomBytes(32);
  const launcher = { doc: { format: FORMAT, tier: "T0-hv", platform: { hostExcluded: false } }, sig: b64(randomBytes(64)) };
  if (vbs) launcher.vbsVmReport = b64(vbsReport(Buffer.concat([bind2(spki, nonce, RID), Buffer.from(APP, "hex")]), report));
  const doc = { format: FORMAT, tier: "T0-hv", abi: ABI2, nonce: nonce.toString("hex"), transportKey: b64(spki), appSha256: APP, runtime: RUNTIME,
    report: b64(Buffer.from(JSON.stringify(launcher))) };
  const context = { transportKeySpki: spki, nonce, expectedAppId: Buffer.from(APP, "hex"), expectedRuntimeId: RID,
    hostSession: { evidence, nonce: hostNonce, transportKeySpki: world.transport.spki, expectedCredential: credential, mintedFor: { ekCert: world.ek.cert, aikName: world.aik.name } } };
  return { doc, context };
}
const shieldPolicy = (extra = {}) => ({ schema: "enclave-shield-app-policy/1", ekRoots: world.ca.bundlePem,
  platforms: [{ ekCertSha256: sha(world.ek.cert).toString("hex"), pcr0: world.pcr0.toString("hex") }],
  images: [{ measurement: IMAGE, runtimeId: RID.toString("hex") }], ...extra });
const judge = ({ doc, context }, hyperv = shieldPolicy()) => verifyEvidence(doc, { policy: { hyperv }, context });

test("a complete exchange is verified, binds this connection's key, and says the host is not excluded", options, async () => {
  const x = exchange(), v = await judge(x);
  assert.equal(v.status, "verified", v.reasons.join("\n")); assert.equal(v.admissionSafe, true); assert.deepEqual(v.omissions, []);
  assert.equal(v.technology, "hyperv-partition"); assert.deepEqual(v.checks, { "shield app policy": true });
  assert.equal(v.claims.measurement, IMAGE); assert.equal(v.claims.appId, APP); assert.equal(v.claims.runtimeId, RID.toString("hex"));
  assert.equal(v.claims.transportSpkiSha256, sha(x.context.transportKeySpki).toString("hex"));
  assert.equal(v.claims.hostExcluded, false); assert.equal(v.claims.teeCpu, null); assert.equal(v.claims.freshness, "verifier nonce");
  assert.equal(v.claims.boot.ekCertSha256, sha(world.ek.cert).toString("hex")); assert.equal(v.claims.boot.secureBoot, 1);
  assert.match(v.reasons.join("\n"), /NOT host-excluded/);
});

test("the consumer gate holds a verified partition verdict: no admission rule releases on this technology", options, async () => {
  const x = exchange(), v = await judge(x);
  const g = admit(v, { nonce: x.context.nonce, appId: x.context.expectedAppId }, { clientKind: "native", observedPeerSpki: x.context.transportKeySpki });
  assert.equal(g.decision, "hold"); assert.match(g.reasons.join("\n"), /no admission rule for technology "hyperv-partition"/);
});

test("a launcher-only document (no guest VBS report) stays unsupported, whatever the inputs", options, async () => {
  const v = await judge(exchange({ vbs: false }));
  assert.equal(v.status, "unsupported"); assert.equal(v.admissionSafe, false); assert.equal(v.claims, null);
  assert.match(v.reasons.join("\n"), /launcher-signed only.*judge-hv/);
});

test("missing verifier inputs are refused before anything is judged", options, async () => {
  const x = exchange();
  for (const [patch, why] of [[{ hostSession: undefined }, /host boot session the caller ran itself/], [{ hostSession: { ...x.context.hostSession, capture: { quoteExtraData: randomBytes(32) } } }, /capture-mode/],
    [{ nonce: undefined }, /32-byte nonce/], [{ expectedAppId: undefined }, /expected app id/], [{ expectedRuntimeId: undefined }, /expected runtime id/],
    [{ transportKeySpki: undefined }, /transport key SPKI/]]) {
    const v = await judge({ doc: x.doc, context: { ...x.context, ...patch } });
    assert.equal(v.status, "rejected"); assert.equal(v.admissionSafe, false); assert.match(v.reasons.join("\n"), why);
  }
  for (const hyperv of [{}, shieldPolicy({ platforms: [] }), shieldPolicy({ images: [] }), shieldPolicy({ ekRoots: "" })])
    assert.equal((await judge(x, hyperv)).status, "rejected", "an empty or partial policy refuses");
});

test("another key, nonce, app, runtime, host nonce or credential is rejected", options, async () => {
  const x = exchange(), hs = x.context.hostSession;
  for (const patch of [{ transportKeySpki: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }) },
    { nonce: randomBytes(32) }, { expectedAppId: randomBytes(32) }, { expectedRuntimeId: randomBytes(32) },
    { hostSession: { ...hs, nonce: randomBytes(32) } }, { hostSession: { ...hs, expectedCredential: randomBytes(32) } }]) {
    const v = await judge({ doc: x.doc, context: { ...x.context, ...patch } });
    assert.equal(v.status, "rejected", JSON.stringify(Object.keys(patch))); assert.deepEqual(v.checks, { "shield app policy": false });
  }
});

test("an unpinned platform or image, a debug report, a report from another signer and a boot with Secure Boot off are rejected", options, async () => {
  const x = exchange();
  assert.equal((await judge(x, shieldPolicy({ platforms: [{ ekCertSha256: sha(world.ek.cert).toString("hex"), pcr0: "00".repeat(32) }] }))).status, "rejected");
  assert.equal((await judge(x, shieldPolicy({ images: [{ measurement: "00".repeat(32), runtimeId: RID.toString("hex") }] }))).status, "rejected");
  assert.equal((await judge(x, shieldPolicy({ images: [{ measurement: IMAGE, runtimeId: "00".repeat(32) }] }))).status, "rejected");
  assert.equal((await judge(exchange({ report: { debug: 1 } }))).status, "rejected");
  assert.equal((await judge(exchange({ report: { signer: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey } }))).status, "rejected");
  assert.equal((await judge(exchange({ boot: { secureBoot: 0 } }))).status, "rejected");
});

test("a report that is not a JSON object is rejected, and the browser build never verifies a partition document", options, async () => {
  const x = exchange();
  assert.equal((await judge({ doc: { ...x.doc, report: b64(Buffer.from("not json")) }, context: x.context })).status, "rejected");
  const w = await verifyEvidenceWeb(x.doc, { policy: { hyperv: shieldPolicy() }, context: x.context });
  assert.equal(w.status, "unsupported"); assert.equal(w.admissionSafe, false);
});
