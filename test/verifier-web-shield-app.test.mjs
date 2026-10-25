// verifier/web/shield-app.mjs: ONE APP's Enclave Shield partition verified in a browser, chained to the host boot the page
// verified first. The rules are the relay's (relay/vbs-app-core.mjs, relay/vbs-vm-report-core.mjs, platformAdmitted), so the
// claim tested is PARITY with relay/vbs-app-verify.mjs verifyVbsAppEvidence (and verifyShieldAppPolicy's platform rule): on
// the synthetic fixtures, accepted or refused, the two builds return the same verdict and the same first reason, with the
// browser's IDKS read from the host session's log exactly as the relay reads it. Then the runtime digest and ABI/2 binding
// against isolation/contract/vectors.json, the whole flow against a stand-in relay + TPM + guest (host first, then exactly one
// app request, never retried), and the BUNDLED build run where no Node global exists. Synthetic TPM world: needs openssl.
//   run: node --test test/verifier-web-shield-app.test.mjs   (the bundle test needs the `buffer` package; NODE_PATH may name it)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomBytes, createHash, sign, constants, generateKeyPairSync, webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyVbsAppEvidence } from "../relay/vbs-app-verify.mjs";
import { verifyShieldAppPolicy } from "../relay/shield-app-policy.mjs";
import { verifyHvNodeEvidence, hvNodeBinding } from "../relay/hvnode-verify.mjs";
import { activateCredential } from "../relay/vbs-credential.mjs";
import { parseTcgLog, vsmKey } from "../relay/vbs-tcglog.mjs";
import { ABI2, bind2, runtimeId } from "../isolation/contract/runtime.mjs";
import { verifyShieldAppEvidenceWeb, verifyShieldAppWith, runtimeIdWeb, bind2Web, SHIELD_APP_CHECK_ORDER, SHIELD_APP_CHECKS } from "../verifier/web/shield-app.mjs";
import { verifyHvNodeEvidenceWeb, SHIELD_CHECK_ORDER } from "../verifier/web/shield-host.mjs";
import { verifyShieldAppWeb } from "../verifier/web/index.mjs";
import { haveOpenssl, tmpdir, makeVbsWorld, buildLog, buildQuote } from "./fixtures/vbs-synthetic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "..");
const sha = (b) => createHash("sha256").update(b).digest(), b64 = (b) => Buffer.from(b).toString("base64"), hex = (b) => Buffer.from(b).toString("hex");
const options = { skip: !haveOpenssl && "openssl absent" };
const world = haveOpenssl ? makeVbsWorld(tmpdir("vweb-shield-app-")) : null;
const other = haveOpenssl ? makeVbsWorld(tmpdir("vweb-shield-app-other-")) : null;   // another node: another boot, another IDKS
const IMAGE = "ab".repeat(32), APP = "cd".repeat(32);
const IDENTITY = { signer: "91".repeat(32), productId: 1818455653, moduleId: 1734437220 };
const IMAGE_IDENTITIES = [{ measurement: IMAGE, identity: IDENTITY }];
const RUNTIME = { name: "wasmtime", version: "48.0.1", execution: "jit", targetIsa: "x86_64", hostIsa: "x86_64", cpuFeatures: "host-detected", wx: "enforced", cache: "none" };
const RID = runtimeId(RUNTIME);

test("runtimeIdWeb and bind2Web (over @noble) equal the contract's runtimeId and bind2 on every vector; inadmissible identities throw in both", () => {
  const V = JSON.parse(fs.readFileSync(path.join(REPO, "isolation/contract/vectors.json"), "utf8"));
  const spki = Buffer.from(V.bind[0].spki_hex, "hex"), nonce = Buffer.from(V.bind[0].nonce_hex, "hex");
  let valid = 0, refused = 0;
  for (const v of V.runtime) {
    if (!v.valid) { assert.throws(() => runtimeIdWeb(v.identity), /inadmissible runtime identity/); assert.throws(() => runtimeId(v.identity)); refused++; continue; }
    const rid = runtimeIdWeb(v.identity);
    assert.equal(hex(rid), v.runtime_id); assert.equal(hex(bind2Web(spki, nonce, rid)), v.bind2); assert.equal(hex(bind2Web(spki, nonce, rid)), hex(bind2(spki, nonce, runtimeId(v.identity))));
    valid++;
  }
  assert.ok(valid >= 5 && refused >= 7);
  const shuffled = Object.fromEntries(Object.keys(RUNTIME).reverse().map((k) => [k, RUNTIME[k]]));
  assert.equal(hex(runtimeIdWeb(shuffled)), hex(RID), "field order cannot change an identity");
  assert.throws(() => runtimeIdWeb({ ...RUNTIME, extra: "x" }), /unknown field/);
  assert.throws(() => bind2Web(spki, Buffer.alloc(31), RID), /nonce must be 32 bytes/);
});

// ---- the synthetic node: host session + app document + the guest's report -------------------------------------------------------
// The paravisor's HCLA envelope around a VBS report (relay/vbs-vm-report.mjs layout), signed by `signer`.
function vbsReport(input, { signer = world.idks.privateKey, debug = 0, enabledVtl = 5, guestVtl = 2, svn = 0, image = IMAGE, identity = IDENTITY } = {}) {
  const claims = Buffer.from(JSON.stringify({ "user-data": input.toString("hex") })), env = Buffer.alloc(1236 + claims.length);
  const w = (o, n) => env.writeUInt32LE(n, o);
  w(0, 0x414c4348); w(4, 2); w(8, env.length); w(12, 2); w(1216, 20 + claims.length); w(1220, 1); w(1224, 1); w(1228, 1); w(1232, claims.length); claims.copy(env, 1236);
  const r = env.subarray(32, 592); [560, 1, 1, 256, 0, 2].forEach((n, i) => r.writeUInt32LE(n, i * 4)); sha(claims).copy(r, 24); Buffer.from(image, "hex").copy(r, 120);
  r.writeUInt32LE(enabledVtl, 216); r.writeUInt32LE(debug, 220); r.writeUInt32LE(guestVtl, 224); r.writeUInt32LE(svn, 228);
  Buffer.from(identity.signer, "hex").copy(r, 152); r.writeUInt32LE(identity.productId, 232); r.writeUInt32LE(identity.moduleId, 236);
  sign("sha256", r.subarray(0, 304), { key: signer, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).copy(r, 304);
  return env;
}
// the node's hv-node evidence for (nonce, credential), the IDKS of `idksOf` in its log
function hostFrame(w, { nonce = randomBytes(32), credential = randomBytes(32), log = {}, idksOf = w } = {}) {
  const statement = Buffer.from("{}"), bound = hvNodeBinding(w.transport.spki, nonce, statement);
  const L = buildLog({ idksPub: idksOf.idks.publicKey, ...log });
  const Q = buildQuote({ aikPriv: w.aik.privateKey, aikName: w.aik.name, pcrs: L.pcrs, pcr0: w.pcr0, extraData: sha(bound) });
  const evidence = { statement: b64(statement), signature: b64(sign(null, bound, w.transport.privateKey)), log: b64(L.log), quote: { attest: b64(Q.attest), sig: b64(Q.sig), aikPub: b64(w.aik.tpmtPublic) },
                     credential: b64(credential), ek: { cert: b64(w.ek.cert), chain: [b64(w.ca.inter)] }, pcr0: w.pcr0.toString("hex"), platform: {} };
  return { evidence, nonce, credential };
}
// the app's document for (handshakeSpki, nonce); `bindTo` bends what the guest put in its user data, `report` the report
function appDoc({ handshakeSpki, nonce, runtime = RUNTIME, bindTo = {}, report = {}, doc = {} }) {
  const b = { spki: handshakeSpki, nonce, rid: RID, app: APP, ...bindTo };
  const input = Buffer.concat([bind2(b.spki, b.nonce, b.rid), Buffer.from(b.app, "hex")]);
  return { abi: ABI2, nonce: hex(nonce), transportKey: b64(handshakeSpki), appSha256: APP, runtime, report: b64(Buffer.from(JSON.stringify({ vbsVmReport: b64(vbsReport(input, report)) }))), ...doc };
}
const tlsKey = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" });
// a full input for verifyVbsAppEvidence; o bends one part
function fixture(o = {}) {
  const hs = hostFrame(world, { idksOf: o.idksOf ?? world, log: o.log ?? {} });
  const handshakeSpki = tlsKey(), nonce = randomBytes(32);
  return { doc: appDoc({ handshakeSpki, nonce, ...o }), handshakeSpki, nonce, expectedAppSha256: APP, expectedRuntimeId: hex(RID),
           hostSession: { evidence: hs.evidence, nonce: hs.nonce, transportKeySpki: world.transport.spki, expectedCredential: hs.credential, mintedFor: { ekCert: world.ek.cert, aikName: world.aik.name } } };
}
const P = () => ({ ekRoots: world.ca.bundlePem, allowedMeasurements: [IMAGE], imageIdentities: IMAGE_IDENTITIES });
// the browser side of one input: the host session verified by the browser build, the IDKS read from that same log, then the app
async function web(input, policy = P(), platforms = "attested") {
  const host = await verifyHvNodeEvidenceWeb(input.hostSession, { ekRoots: policy.ekRoots });
  if (!host.ok || !host.admissible) return { host };
  const k = vsmKey(parseTcgLog(Buffer.from(input.hostSession.evidence.log, "base64")).events, "IDKS");
  const app = await verifyShieldAppEvidenceWeb({ ...input, idks: k ? { modulus: k.modulus, exponent: k.exponent } : null, boot: host.boot },
                                               { allowedMeasurements: policy.allowedMeasurements, imageIdentities: policy.imageIdentities, minimumGuestSvn: policy.minimumGuestSvn, platforms });
  return { host, app };
}
async function same(input, policy = P()) {
  const n = verifyVbsAppEvidence(input, policy), w = await web(input, policy);
  if (!w.app) { assert.equal(n.ok, false, "the relay refuses what the browser's host check refuses"); assert.match(n.reason, /host boot verification failed|complete authenticated host session/); return { n, w }; }
  assert.equal(w.app.ok, n.ok, `the same verdict: relay ${n.reason ?? "ok"} / browser ${w.app.reason ?? "ok"}`);
  assert.equal(w.app.reason, n.reason, "the same first reason");
  if (n.ok) assert.equal(w.app.measurement, n.measurement);
  return { n, w };
}
const failsAt = (w, key) => assert.equal(w.app.checks[key], false, `${key}: ${JSON.stringify(w.app.checks)} ${w.app.reason}`);

test("parity with verifyVbsAppEvidence: the full chain accepted by both, every app check true", options, async () => {
  const { n, w } = await same(fixture());
  assert.equal(n.ok, true, n.reason); assert.equal(w.app.ok, true, w.app.reason);
  for (const c of SHIELD_APP_CHECKS) assert.equal(w.app.checks[c.key], true, c.key);
  assert.equal(w.app.measurement, IMAGE); assert.equal(w.app.guestSvn, 0);
});

test("parity: every refusal of test/vbs-app-verify.test.mjs, and the binding, VTL, SVN, image, document and runtime cases, refused by both with the same reason at the named check", options, async () => {
  const f = fixture();
  // vbs-app-verify.test.mjs: changed app, key, runtime, either nonce; debug; no image pins; no root pins; another signer; a bad boot
  for (const [patch, key] of [[{ expectedAppSha256: "00".repeat(32) }, "app-identity"], [{ expectedRuntimeId: "00".repeat(32) }, "app-runtime"], [{ nonce: randomBytes(32) }, "app-document"], [{ handshakeSpki: Buffer.alloc(44) }, "app-document"]]) {
    const { w } = await same({ ...f, ...patch }); failsAt(w, key);
  }
  for (const hostSession of [{ ...f.hostSession, nonce: randomBytes(32) }, { ...f.hostSession, expectedCredential: randomBytes(32) }, { ...f.hostSession, capture: { quoteExtraData: randomBytes(32) } }]) {
    const { w } = await same({ ...f, hostSession }); assert.ok(!w.app, "the browser's host check refuses; no app check runs");
  }
  failsAt((await same(fixture({ report: { debug: 1 } }))).w, "app-isolation");
  failsAt((await same(f, { ...P(), allowedMeasurements: [] })).w, "app-measurement");
  assert.ok(!(await same(f, { ...P(), ekRoots: "" })).w.app, "no pinned root: the host check refuses");
  failsAt((await same(fixture({ report: { signer: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey } }))).w, "app-signature");
  assert.ok(!(await same(fixture({ log: { secureBoot: 0 } }))).w.app);
  // another IDKS, another boot, user data over another nonce / TLS key / app / runtime
  failsAt((await same(fixture({ report: { signer: other.idks.privateKey } }))).w, "app-signature");
  { const { n, w } = await same(fixture({ idksOf: other })); failsAt(w, "app-signature"); assert.match(n.reason, /signature/); }   // signed by world's IDKS, the boot names other's
  for (const bindTo of [{ nonce: randomBytes(32) }, { spki: tlsKey() }, { app: "ee".repeat(32) }, { rid: runtimeId({ ...RUNTIME, version: "49.0.0" }) }]) {
    const { n, w } = await same(fixture({ bindTo })); failsAt(w, "app-binding"); assert.equal(n.reason, "guest binding differs from verifier request");
  }
  for (const report of [{ debug: 1 }, { enabledVtl: 4 }, { guestVtl: 1 }, { guestVtl: 0 }]) failsAt((await same(fixture({ report }))).w, "app-isolation");
  failsAt((await same(fixture({ report: { svn: 2 } }), { ...P(), minimumGuestSvn: 3 })).w, "app-svn");
  assert.equal((await same(fixture({ report: { svn: 3 } }), { ...P(), minimumGuestSvn: 3 })).w.app.ok, true, "at the floor passes");
  failsAt((await same(fixture({ report: { image: "ef".repeat(32) } }))).w, "app-measurement");
  // the document against the handshake / request
  for (const doc of [{ transportKey: b64(tlsKey()) }, { nonce: "00".repeat(32) }, { abi: "enclave-domain-abi/1" }]) failsAt((await same({ ...f, doc: { ...f.doc, ...doc } })).w, "app-document");
  failsAt((await same({ ...f, doc: { ...f.doc, appSha256: "ee".repeat(32) } })).w, "app-identity");
  for (const runtime of [{ ...RUNTIME, extra: "x" }, { ...RUNTIME, wx: "off" }, { ...RUNTIME, version: "49.0.0" }, null]) failsAt((await same({ ...f, doc: { ...f.doc, runtime } })).w, "app-runtime");
  // the report itself: bounds, shape, an edited byte
  for (const report of [5, "x".repeat(40000), b64(Buffer.from("not json")), b64(Buffer.from('{"vbsVmReport":5}')), b64(Buffer.from(JSON.stringify({ vbsVmReport: "x".repeat(13000) })))])
    failsAt((await same({ ...f, doc: { ...f.doc, report } })).w, "app-report");
  const env = Buffer.from(JSON.parse(Buffer.from(f.doc.report, "base64")).vbsVmReport, "base64");
  for (const [at, key] of [[0, "app-report"], [32 + 120, "app-signature"], [32 + 304, "app-signature"], [1240, "app-report"]]) {
    const e = Buffer.from(env); e[at] ^= 1;
    failsAt((await same({ ...f, doc: { ...f.doc, report: b64(Buffer.from(JSON.stringify({ vbsVmReport: b64(e) }))) } })).w, key);
  }
  failsAt((await same({ ...f, doc: null })).w, "app-document");
});

test("parity with verifyShieldAppPolicy's platform rule: pinned TPM/firmware pairs or \"attested\", never a wrong pin or anything else", options, async () => {
  const f = fixture(), pin = { ekCertSha256: hex(sha(world.ek.cert)), pcr0: hex(world.pcr0) };
  const policy = (platforms) => ({ schema: "enclave-shield-app-policy/1", ekRoots: world.ca.bundlePem, platforms, images: [{ measurement: IMAGE, runtimeId: hex(RID) }] });
  for (const platforms of [[pin], "attested", [{ ...pin, pcr0: "00".repeat(32) }], [{ ...pin, ekCertSha256: "00".repeat(32) }], [], "*", null, {}]) {
    const n = verifyShieldAppPolicy(f, policy(platforms)), w = await web(f, P(), platforms);
    assert.equal(w.app.ok, n.ok, `${JSON.stringify(platforms)}: relay ${n.reason ?? "ok"} / browser ${w.app.reason ?? "ok"}`);
    if (!n.ok) { assert.equal(w.app.checks["app-platform"], false); assert.equal(w.app.reason, n.reason); }
  }
});

test('relay/browser identity parity: authentic reports with high SVN cannot choose another release authority', options, async () => {
  const policy = { ...P(), minimumGuestSvn: 13 };
  for (const patch of [{ signer: '92'.repeat(32) }, { productId: 1 }, { moduleId: 1 }]) {
    const { n, w } = await same(fixture({ report: { svn: 100, identity: { ...IDENTITY, ...patch } } }), policy);
    assert.equal(n.ok, false); failsAt(w, 'app-image-identity');
    assert.equal(w.app.checks['app-signature'], true); assert.equal(w.app.checks['app-svn'], true);
  }
  const { n } = await same(fixture({ report: { svn: 13 } }), policy); assert.equal(n.ok, true);
  for (const imageIdentities of [null, [], [{ measurement: IMAGE, identity: { ...IDENTITY, moduleId: -1 } }]])
    failsAt((await same(fixture(), { ...P(), imageIdentities })).w, 'app-image-identity');
  const legacy = await same(fixture(), { ...P(), imageIdentities: undefined });
  assert.equal(legacy.n.ok, true); assert.equal(legacy.w.app.checks['app-image-identity'], undefined);
});

// ---- the flow against a stand-in relay + TPM + guest ------------------------------------------------------------------------
// The stub plays the relay, the node's TPM and the app's partition: the host's two POSTs as in the host test, then the app GET,
// answered with a report over the nonce in its URL. It refuses a `this` (a browser's fetch throws "Illegal invocation").
function standIn(w, { app = {}, host = {}, status = null } = {}) {
  const calls = [];
  let hostNonce = null;
  const handshakeSpki = tlsKey();
  async function fetchImpl(url, init) {
    "use strict";
    if (this !== undefined) throw new TypeError("Illegal invocation");
    calls.push({ url, init });
    const answer = (code, body) => ({ status: code, text: async () => JSON.stringify(body) });
    if (url.endsWith("/attestation") && init.method === "POST") {
      hostNonce = Buffer.from(JSON.parse(init.body).nonce, "hex");
      return answer(200, { name: "nucbox-test", mode: "hv-node", session: "ab12".repeat(8), nonce: hex(hostNonce), keys: { ek: b64(w.ek.cert), ekChain: [b64(w.ca.inter)], aikPub: b64(w.aik.tpmtPublic), aikName: b64(w.aik.name) } });
    }
    if (url.endsWith("/attestation/credential")) {
      const b = JSON.parse(init.body);
      const credential = activateCredential(w.ek.privateKey, w.aik.name, Buffer.from(b.credentialBlob, "base64"), Buffer.from(b.secret, "base64"));
      const f = hostFrame(w, { nonce: hostNonce, credential, ...host });
      return answer(200, { name: "nucbox-test", mode: "hv-node", nonce: hex(hostNonce), document: { format: "windows-hv-node/v1", body: b64(Buffer.from(JSON.stringify(f.evidence))), transportKey: b64(w.transport.spki) } });
    }
    const m = url.match(/\/v1\/enclaves\/nucbox-test\/apps\/(0x[0-9a-f]{64})\/attestation\?nonce=([0-9a-f]{64})$/);
    if (m && init.method === "GET") {
      if (status) return answer(status, { error: "busy", message: "checked moments ago", retryAfter: 30 });
      const nonce = Buffer.from(m[2], "hex");
      const body = { name: "nucbox-test", mode: "hv-node", deployment: m[1], nonce: m[2], fetchedAt: "2026-10-15T12:00:00.000Z",
                     document: appDoc({ handshakeSpki, nonce, ...(app.doc || {}) }), handshakeSpki: b64(handshakeSpki),
                     expected: { source: "derived by this relay from the deployment's catalog entry and config, not by the app", appSha256: APP, runtimeId: hex(RID) },
                     policy: { source: "this relay's Shield app policy (the operator's own list)", measurements: [IMAGE], imageIdentities: IMAGE_IDENTITIES, minimumGuestSvn: 0, platforms: "attested" } };
      return answer(200, app.mutate ? app.mutate(body) : body);
    }
    return answer(404, { error: "not_found" });
  }
  return { fetchImpl, calls, handshakeSpki, appCalls: () => calls.filter((c) => c.url.includes("/apps/")) };
}
const DEP = "0x" + "12".repeat(32);
const rnd = (n) => webcrypto.getRandomValues(new Uint8Array(n));
const runFlow = (w, s, opts = {}) => verifyShieldAppWith({ fetchImpl: s.fetchImpl, randomBytes: rnd, now: () => new Date(), ekRoots: w.ca.bundlePem, ekRootPins: [w.ca.rootPin] },
                                                       { apiBase: "https://api.test", name: "nucbox-test", deployment: DEP, ...opts });

test("the flow: the host first, then ONE app request over a fresh nonce; a full pass is LIMITED with four omissions, every check true, the facts filled", options, async () => {
  const s = standIn(world);
  const v = await runFlow(world, s);
  assert.equal(v.status, "limited", v.reasons.join("\n")); assert.equal(v.technology, "hyperv-partition"); assert.equal(v.name, "nucbox-test");
  assert.deepEqual(v.checkOrder, [...SHIELD_CHECK_ORDER, ...SHIELD_APP_CHECKS.map((c) => c.key)]); assert.deepEqual(v.checkOrder, [...SHIELD_APP_CHECK_ORDER]);
  for (const k of v.checkOrder) { assert.equal(v.checks[k], true, k); assert.ok(v.checkLabels[k].length > 20, k); }
  assert.deepEqual(v.omissions, ["platform-firmware-unpinned", "host-exclusion-unevidenced", "app-expectation-relay-derived", "image-list-operator-stated"]);
  for (const o of v.omissions) assert.ok(v.omissionLabels[o].length > 40, o);
  assert.equal(v.reasons.filter((r) => r.startsWith("OMITTED")).length, 4);
  assert.match(v.summary, /hypervisor.*stay trusted.*no evidence of its own/); assert.doesNotMatch(JSON.stringify(v), /vbs-like/i);
  // the requests: two host POSTs, then exactly one app GET whose nonce is not the host's
  assert.equal(s.calls.length, 3); assert.equal(s.appCalls().length, 1);
  const appCall = s.appCalls()[0], appNonce = appCall.url.split("nonce=")[1], hostNonce = JSON.parse(s.calls[0].init.body).nonce;
  assert.equal(appCall.url, `https://api.test/v1/enclaves/nucbox-test/apps/${DEP}/attestation?nonce=${appNonce}`);
  assert.equal(appCall.init.method, "GET"); assert.equal(appCall.init.credentials, "omit"); assert.equal(appCall.init.redirect, "error"); assert.notEqual(appNonce, hostNonce);
  const facts = Object.fromEntries(v.facts);
  assert.equal(facts.Deployment, DEP); assert.equal(facts["App SHA-256 (expected; derived by the relay)"], APP); assert.equal(facts["Runtime id (expected)"], hex(RID));
  assert.match(facts.Runtime, /^wasmtime 48\.0\.1 \(jit, x86_64 on x86_64/); assert.equal(facts["Image measurement (on the operator's list)"], IMAGE); assert.equal(facts["Guest SVN"], "0");
  assert.equal(facts["App TLS key sha256 (the key the app's TLS certificate must carry)"], hex(sha(s.handshakeSpki)));
  assert.equal(facts["App nonce (drawn by this page)"], `${appNonce.slice(0, 32)}…`); assert.equal(facts["PCR 0 (platform firmware, unpinned)"], hex(world.pcr0));
  assert.match(facts["Platform policy"], /^attested/); assert.match(facts["Expected app and runtime: source"], /catalog/);
});

test("the flow refuses: a host that fails (no app request at all), a 503 busy (one request, never retried), the relay answering for another nonce/deployment, a report signed by another IDKS, a debug partition, an off-list image; errors are errors", options, async () => {
  // the host fails: its verdict, the app checks undefined, no app request
  let s = standIn(world, { host: { log: { secureBoot: 0 } } }), v = await runFlow(world, s);
  assert.equal(v.status, "rejected"); assert.equal(v.checks["boot-state"], false); assert.equal(s.appCalls().length, 0);
  for (const c of SHIELD_APP_CHECKS) assert.equal(v.checks[c.key], undefined, c.key);
  assert.deepEqual(v.checkOrder, [...SHIELD_APP_CHECK_ORDER]);
  // busy: one request, an error, never a retry
  s = standIn(world, { status: 503 }); v = await runFlow(world, s);
  assert.equal(v.status, "error"); assert.match(v.reasons.join(), /busy.*does not retry.*30 s/); assert.equal(s.appCalls().length, 1);
  for (const c of SHIELD_APP_CHECKS) assert.equal(v.checks[c.key], undefined);
  s = standIn(world, { status: 500 }); v = await runFlow(world, s); assert.equal(v.status, "error"); assert.equal(s.appCalls().length, 1);
  // the relay's answer
  for (const [mutate, re] of [[(b) => ({ ...b, nonce: "00".repeat(32) }), /another nonce/], [(b) => ({ ...b, deployment: "0x" + "34".repeat(32) }), /another deployment/], [(b) => ({ ...b, name: "nucbox-other" }), /another host/]]) {
    s = standIn(world, { app: { mutate } }); v = await runFlow(world, s); assert.equal(v.status, "rejected"); assert.match(v.reasons.join(), re); assert.equal(s.appCalls().length, 1);
  }
  for (const mutate of [(b) => ({ ...b, mode: "metal" }), (b) => ({ ...b, expected: undefined }), (b) => ({ ...b, policy: { ...b.policy, measurements: [] } }), (b) => ({ ...b, policy: { ...b.policy, platforms: "*" } }),
                        (b) => ({ ...b, policy: { ...b.policy, minimumGuestSvn: -1 } }), (b) => ({ ...b, handshakeSpki: "" }), (b) => ({ ...b, document: null })]) {
    s = standIn(world, { app: { mutate } }); v = await runFlow(world, s); assert.equal(v.status, "error", v.reasons.join());
  }
  // the evidence
  for (const [doc, key] of [[{ report: { signer: other.idks.privateKey } }, "app-signature"], [{ report: { debug: 1 } }, "app-isolation"], [{ report: { image: "ef".repeat(32) } }, "app-measurement"],
                            [{ bindTo: { app: "ee".repeat(32) } }, "app-binding"], [{ doc: { appSha256: "ee".repeat(32) } }, "app-identity"]]) {
    s = standIn(world, { app: { doc } }); v = await runFlow(world, s);
    assert.equal(v.status, "rejected", key); assert.equal(v.checks[key], false, `${key}: ${v.reasons.join()}`); assert.equal(v.checks["app-report"], true);
    assert.ok(v.omissions.includes("app-expectation-relay-derived"));
  }
  s = standIn(world, { app: { mutate: (b) => ({ ...b, handshakeSpki: b64(tlsKey()) }) } }); v = await runFlow(world, s);
  assert.equal(v.status, "rejected"); assert.equal(v.checks["app-document"], false);
  s = standIn(world, { app: { mutate: (b) => ({ ...b, policy: { ...b.policy, platforms: [{ ekCertSha256: "00".repeat(32), pcr0: hex(world.pcr0) }] } }) } }); v = await runFlow(world, s);
  assert.equal(v.status, "rejected"); assert.equal(v.checks["app-platform"], false);
  // inputs and failures
  s = standIn(world); v = await runFlow(world, s, { deployment: "0x12" }); assert.equal(v.status, "error"); assert.equal(s.calls.length, 0, "a bad deployment id asks nothing");
  v = await runFlow(world, s, { name: "../x" }); assert.equal(v.status, "error");
  let n = 0; const flaky = { fetchImpl: s.fetchImpl, randomBytes: (k) => { if (++n === 4) throw new Error("no entropy"); return rnd(k); }, ekRoots: world.ca.bundlePem, ekRootPins: [world.ca.rootPin] };
  s = standIn(world); flaky.fetchImpl = s.fetchImpl; v = await verifyShieldAppWith(flaky, { apiBase: "https://api.test", name: "nucbox-test", deployment: DEP });
  assert.equal(v.status, "error"); assert.match(v.reasons.join(), /no entropy/); assert.equal(s.appCalls().length, 0);
  s = standIn(world); const big = { ...s, fetchImpl: async (url, init) => { const f = s.fetchImpl; return url.includes("/apps/") ? { status: 200, text: async () => "x".repeat(300 * 1024) } : f(url, init); } };
  v = await runFlow(world, big); assert.equal(v.status, "error"); assert.match(v.reasons.join(), /exceeds/);
});

// The REAL host capture (d1's, test/fixtures/hvnode/capture-20260925-061116) through the export: the page's randomness replays
// the session's nonce and credential, the stand-in returns the node's recorded keys and document, and the embedded AMD roots
// verify that boot; then one app request, answered with a report signed by a key that is NOT that boot's IDKS (nobody has the
// real one), which is refused at exactly that check while every other app check holds.
const CAP = path.join(HERE, "fixtures", "hvnode", "capture-20260925-061116");
const REAL_RANDOM = webcrypto.getRandomValues.bind(webcrypto);   // the tests below stand in for globalThis.crypto's
const NO_IDKS = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
function replayCapture({ status = null } = {}) {
  const frame = JSON.parse(fs.readFileSync(path.join(CAP, "frame.json"), "utf8")), minted = JSON.parse(fs.readFileSync(path.join(CAP, "minted-for.json"), "utf8"));
  const ev = JSON.parse(Buffer.from(frame.rad.body, "base64").toString("utf8"));
  const queue = [Buffer.from(fs.readFileSync(path.join(CAP, "nonce.hex"), "utf8").trim(), "hex"), Buffer.from(fs.readFileSync(path.join(CAP, "expected-credential.hex"), "utf8").trim(), "hex")];
  const calls = [], handshakeSpki = tlsKey();
  async function fetchImpl(url, init) {
    "use strict";
    if (this !== undefined) throw new TypeError("Illegal invocation");
    calls.push({ url, init });
    const answer = (code, body) => ({ status: code, text: async () => JSON.stringify(body) });
    const m = url.match(/\/apps\/(0x[0-9a-f]{64})\/attestation\?nonce=([0-9a-f]{64})$/);
    if (m) {
      if (status) return answer(status, { error: "busy", message: "checked moments ago" });
      return answer(200, { name: "nucbox-k11-4", mode: "hv-node", deployment: m[1], nonce: m[2], document: appDoc({ handshakeSpki, nonce: Buffer.from(m[2], "hex"), report: { signer: NO_IDKS } }),
                           handshakeSpki: b64(handshakeSpki), expected: { source: "relay", appSha256: APP, runtimeId: hex(RID) }, policy: { source: "operator", measurements: [IMAGE], imageIdentities: IMAGE_IDENTITIES, minimumGuestSvn: 0, platforms: "attested" } });
    }
    const nonce = JSON.parse(calls[0].init.body).nonce;
    if (url.endsWith("/attestation")) return answer(200, { name: "nucbox-k11-4", mode: "hv-node", session: "s1", nonce, keys: { ek: minted.ekCert, ekChain: [], aikPub: ev.quote.aikPub, aikName: b64(Buffer.from(minted.aikName, "hex")) } });
    return answer(200, { name: "nucbox-k11-4", mode: "hv-node", nonce, document: { format: "windows-hv-node/v1", body: frame.rad.body, transportKey: frame.rad.transportKey } });
  }
  return { calls, fetchImpl, getRandomValues: (a) => { if (queue.length) a.set(queue.shift()); else REAL_RANDOM(a); return a; }, appCalls: () => calls.filter((c) => c.url.includes("/apps/")) };
}
const assertRealChain = (v, R) => {
  assert.equal(v.status, "rejected", v.reasons.join("\n"));
  for (const k of SHIELD_CHECK_ORDER) assert.equal(v.checks[k], true, `host ${k}`);
  for (const c of SHIELD_APP_CHECKS) assert.equal(v.checks[c.key], c.key === "app-signature" ? false : true, c.key);
  assert.match(v.reasons.join(), /VBS report signature failed/); assert.equal(R.appCalls().length, 1); assert.equal(R.calls.length, 3);
};

test("REAL capture through verifyShieldAppWeb (embedded AMD roots): the host passes, one app request follows, and a report not signed by that boot's IDKS is refused at exactly that check", async () => {
  const real = globalThis.crypto.getRandomValues;
  let R = replayCapture();
  globalThis.crypto.getRandomValues = R.getRandomValues;
  let v; try { v = await verifyShieldAppWeb({ apiBase: "https://api.test", name: "nucbox-k11-4", deployment: DEP, fetchImpl: R.fetchImpl }); } finally { globalThis.crypto.getRandomValues = real; }
  assertRealChain(v, R);
  assert.equal(Object.fromEntries(v.facts)["EK root (pinned)"].startsWith("CN=AMDTPM sha256:"), true);
  R = replayCapture({ status: 503 });
  globalThis.crypto.getRandomValues = R.getRandomValues;
  try { v = await verifyShieldAppWeb({ apiBase: "https://api.test", name: "nucbox-k11-4", deployment: DEP, fetchImpl: R.fetchImpl }); } finally { globalThis.crypto.getRandomValues = real; }
  assert.equal(v.status, "error"); assert.match(v.reasons.join(), /busy/); assert.equal(R.appCalls().length, 1, "never retried");
  assert.equal((await verifyShieldAppWeb({ name: "nucbox-k11-4", deployment: "nope", fetchImpl: R.fetchImpl })).status, "error");
});

// ---- the bundle: built as verifier/web/build.mjs builds it, run where no Node global exists ----------------------------------
test("BUNDLED (esbuild, node:crypto aliased to the throwing shim, Buffer from the `buffer` package) and run with no process, require or Buffer: the real capture's chain through verifyShieldAppWeb; the app evidence agrees with the relay, accepted and refused", async (t) => {
  const { build } = await import("esbuild");
  const { OPTIONS } = await import("../verifier/web/build.mjs");
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vweb-shield-app-bundle-")), "bundle.js");
  try {
    await build({ entryPoints: [path.join(REPO, OPTIONS.entry)], outfile: out, bundle: true, format: "iife", globalName: "EnclaveVerifier", platform: OPTIONS.platform, target: [OPTIONS.target],
                  absWorkingDir: REPO, logLevel: "silent", nodePaths: (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean),
                  alias: Object.fromEntries(Object.entries(OPTIONS.alias).map(([k, v]) => [k, path.join(REPO, v)])), inject: OPTIONS.inject.map((p) => path.join(REPO, p)) });
  } catch (e) {
    if (/Could not resolve "buffer"/.test(e.message)) return t.skip("the `buffer` package is not installed (npm ci, or NODE_PATH naming a node_modules that has it)");
    throw e;
  }
  const R = replayCapture();
  const ctx = { crypto: { subtle: webcrypto.subtle, getRandomValues: R.getRandomValues }, TextEncoder, TextDecoder, atob, btoa, AbortController, setTimeout, clearTimeout, console, URL };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(out, "utf8"), ctx, { filename: "bundle.js" });
  for (const g of ["process", "require", "Buffer", "global"]) assert.equal(vm.runInContext(`typeof ${g}`, ctx), "undefined", `${g} is not reachable in the context`);
  const W = ctx.EnclaveVerifier;
  const readBack = (x) => JSON.parse(JSON.stringify(x));
  const v = readBack(await W.verifyShieldAppWeb({ apiBase: "https://api.test", name: "nucbox-k11-4", deployment: DEP, fetchImpl: R.fetchImpl }));
  assertRealChain(v, R); assert.deepEqual(v.checkOrder, [...SHIELD_APP_CHECK_ORDER]);
  if (!world) return;
  // the app evidence itself, bundled, against the relay on the synthetic fixtures
  const inner = vm.runInContext("(a) => new Uint8Array(a)", ctx), toU8 = (b) => inner(Array.from(b));   // bytes of the page's own realm
  const one = async (f, policy = P()) => {
    const k = vsmKey(parseTcgLog(Buffer.from(f.hostSession.evidence.log, "base64")).events, "IDKS"), boot = verifyHvNodeEvidence(f.hostSession, { ekRoots: world.ca.bundlePem }).boot;
    const w = readBack(await W.verifyShieldAppEvidenceWeb({ doc: readBack(f.doc), handshakeSpki: toU8(f.handshakeSpki), nonce: toU8(f.nonce), expectedAppSha256: f.expectedAppSha256, expectedRuntimeId: f.expectedRuntimeId,
                                                            idks: { modulus: toU8(k.modulus), exponent: toU8(k.exponent) }, boot: readBack(boot) },
                                                          { allowedMeasurements: policy.allowedMeasurements, imageIdentities: policy.imageIdentities, minimumGuestSvn: policy.minimumGuestSvn ?? 0, platforms: "attested" }));
    const n = verifyVbsAppEvidence(f, policy);
    assert.equal(w.ok, n.ok, `relay ${n.reason ?? "ok"} / bundle ${w.reason ?? "ok"}`); assert.equal(w.reason, n.reason);
    return w;
  };
  const ok = await one(fixture()); assert.equal(ok.ok, true, ok.reason); for (const c of SHIELD_APP_CHECKS) assert.equal(ok.checks[c.key], true, c.key);
  assert.equal((await one(fixture({ report: { signer: other.idks.privateKey } }))).checks["app-signature"], false);
  assert.equal((await one(fixture({ report: { debug: 1 } }))).checks["app-isolation"], false);
  assert.equal((await one(fixture({ report: { svn: 100, identity: { ...IDENTITY, signer: '92'.repeat(32) } } }))).checks['app-image-identity'], false);
  assert.equal((await one(fixture(), { ...P(), imageIdentities: null })).checks['app-image-identity'], false);
  assert.equal((await one(fixture({ bindTo: { nonce: randomBytes(32) } }))).checks["app-binding"], false);
  assert.equal((await one(fixture(), { ...P(), allowedMeasurements: ["ef".repeat(32)] })).checks["app-measurement"], false);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});
