// The pVM marketplace (relay/pvm-market.mjs; PVM-CPU.md "Serving buyers"): a phone's protected VM takes buyers' apps only on
// the relay's own verdicts. A fake hub answers the relay's evidence request with v4 evidence made here over THE RELAY'S nonce
// (a synthetic AVF chain from a test CA, test/fixtures/avf-synthetic.mjs; the real device document is checked in
// test/pvm-app-evidence-v4.test.mjs):
//   - capacity: the market switched on with the tier's pins, an AVF row tiered pvm-cpu, its attach signed by its registered
//     operator, a registered (keccak) id -- each condition alone withdraws it;
//   - per app: served only after evidence for exactly the catalog's component (CID-verified by the relay), from the VM attached
//     as this host, binding a TLS key -- and a certificate only for that key; a deployment that is private, GPU, unleased,
//     confidential-computing, GPU-bound or unapproved is never served; an app or ledger change, a re-attach and the TTL end it.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { tmpdir, makeCa, issueLeaf, extension, haveOpenssl, CODE, AUTH } from "./fixtures/avf-synthetic.mjs";
import { createPvmMarket, pvmOptionsRefusal } from "../relay/pvm-market.mjs";
import { createPvmSecretRelease, sealKeyMessage, pvmSecretsMessage } from "../relay/pvm-secrets.mjs";
import { openRelease, verifyResponse, ed25519RawPublic } from "../relay/secrets-release.mjs";
import { privateKeyToAccount } from "viem/accounts";
import { bind3, instanceIdOf, instanceSigMessage, appKeyMessageV3, tlsKeyMessage, PVM_APP_EVIDENCE_FORMAT_V4 } from "../relay/pvm-app-attest.mjs";

const skip = !haveOpenssl && "no openssl";
const PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
const RID = createHash("sha256").update(PIXEL).digest("hex");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const COMPONENT = Buffer.from("\0asm\x0d\0\x01\0 a buyer's wasi:http component");
const APP = sha(COMPONENT), CID = "bafkreifakecidforthecomponentbytes0000000000000000000";
const ROW_ID = "0x" + "c6".repeat(32), OPERATOR = "0x" + "aa".repeat(20), D = "0x" + "d1".repeat(32);
const APP_REF = `catalog://0x${"ab".repeat(32)}/0`;

/** A VM: its transport, instance, app and TLS keys; evidence for any nonce (forge: one named defect). */
function fakeVm(dir, ca, { appId = APP, forge = null } = {}) {
  const t = generateKeyPairSync("ed25519"), inst = generateKeyPairSync("ed25519"), app = generateKeyPairSync("x25519"), tls = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = t.publicKey.export({ format: "der", type: "spki" }), ispki = inst.publicKey.export({ format: "der", type: "spki" }), iid = instanceIdOf(ispki);
  const appKey = app.publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  const tlsSpki = (forge === "other-tls" ? generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey : tls.publicKey).export({ format: "der", type: "spki" });
  const evidence = (nonceHex) => {
    const nonce = Buffer.from(nonceHex, "hex"), challenge = Buffer.concat([bind3(spki, nonce, Buffer.from(RID, "hex"), iid), Buffer.from(appId, "hex")]);
    const leaf = issueLeaf(dir, { ext: extension({ challenge, code: CODE, auth: AUTH }) }).leaf;
    const signedTls = forge === "other-tls" ? tls.publicKey.export({ format: "der", type: "spki" }) : tlsSpki;
    return { format: PVM_APP_EVIDENCE_FORMAT_V4, nonce: nonceHex, app: appId, spki: spki.toString("hex"), instanceKey: ispki.toString("hex"),
      instanceSig: edSign(null, instanceSigMessage(challenge), inst.privateKey).toString("hex"), appKey,
      appKeySig: edSign(null, appKeyMessageV3(nonce, appId, iid, appKey), t.privateKey).toString("hex"),
      tlsSpki: tlsSpki.toString("hex"), tlsKeySig: edSign(null, tlsKeyMessage(nonce, appId, iid, signedTls), t.privateKey).toString("hex"),
      appSha256: appId, transportKey: tlsSpki.toString("base64"), identity: PIXEL, selftest: "exec_pages=refused:EACCES wx=clean maps=1 scope=self",
      chain: [leaf, ca.inter, ca.root].map((c) => c.toString("base64")) };
  };
  // the VM's seal key for (app, deployment) and its statement over a nonce (relay/pvm-secrets.mjs), signed by the transport key
  const sealKp = generateKeyPairSync("x25519"), sealRaw = sealKp.publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const seal = (nonceHex, id, { by = t.privateKey, key = sealRaw } = {}) => ({ format: "enclave-pvm-seal-key/v1", deployment: id, app: appId,
    sealKey: key.toString("hex"), nonce: nonceHex, sig: edSign(null, sealKeyMessage({ nonce: nonceHex, id, app: appId, sealKey: key.toString("hex") }), by).toString("hex") });
  return { keyFp: sha(spki), tlsSpkiSha256: sha(tls.publicKey.export({ format: "der", type: "spki" })), evidence, seal, sealPrivate: sealKp.privateKey, other: generateKeyPairSync("ed25519") };
}

function setup({ vmOpts = {}, row: rowOver = {}, info: infoOver = {}, dep = {}, enabled = true, catalog = {} } = {}) {
  const dir = tmpdir("pvm-market-"), ca = makeCa(dir);
  const clock = { t: 1_800_000_000_000 };
  const vm = fakeVm(dir, ca, vmOpts);
  const row = { name: "pixel10-pvm-cpu", id: ROW_ID, tunnel: true, mode: "avf", tier: "pvm-cpu", ...rowOver };
  const hub = { asked: [], info: (n) => n === row.name ? { name: n, mode: "avf", tier: "pvm-cpu", keyFp: vm.keyFp, operator: OPERATOR, ...infoOver } : null,
    fetchJson: async (origin, path) => { hub.asked.push(path); const n = /nonce=([0-9a-f]{64})/.exec(path)[1]; return hub.answer ? hub.answer(n) : vm.evidence(n); } };
  const ledger = { d: { id: D, owner: "0x" + "bb".repeat(20), appRef: APP_REF, configCid: "", isPublic: true, active: true, cpuMilli: 1000, gpuMilli: 0,
                        runner: ROW_ID, leaseUntil: Math.floor(clock.t / 1000) + 1800, ...dep } };
  const fetched = [];
  const m = createPvmMarket({ hub, enabled, pins: { codeHashes: new Set([CODE.toString("hex")]), authorityHashes: new Set([AUTH.toString("hex")]), runtimeIds: new Set([RID]) },
    rootPins: [ca.rootPin], now: () => clock.t, log: () => {},
    confirmRow: async (id) => (id === D ? { ...ledger.d } : null),
    readCatalog: async () => ({ app: { active: true }, version: { cid: CID, memMb: 128, ports: "", approval: 1, yanked: false, ...catalog } }),
    fetchVerified: async (cid) => { fetched.push(cid); return cid === CID ? { ok: true, bytes: COMPONENT } : { ok: false }; } });
  return { m, row, hub, ledger, clock, vm, fetched, ca, dir };
}

test("capacity: on only with the market switched on, an admitted pvm-cpu AVF tunnel, its registered operator's attach and a registered id", { skip }, () => {
  assert.equal(setup().m.eligible(setup().row), true);
  assert.equal(setup({ enabled: false }).m.eligible(setup().row), false, "PVM_MARKET off");
  assert.equal(createPvmMarket({ hub: setup().hub, enabled: true, pins: null, log: () => {} }).enabled, false, "no tier pins: off");
  for (const [k, v] of [["tier", ""], ["mode", "snp"], ["tunnel", false], ["id", "tunnel:pixel10-pvm-cpu"]]) {
    const s = setup({ row: { [k]: v } });
    assert.equal(s.m.eligible(s.row), false, `${k}=${v}`);
  }
  const s = setup({ info: { operator: undefined } });
  assert.equal(s.m.eligible(s.row), false, "an attach no registered operator signed is not a market host");
});

test("per app: served only after the VM's v4 evidence for the catalog's own component; the certificate only for that TLS key", { skip }, async () => {
  const s = setup();
  assert.equal(s.m.servesUntil(s.row, s.ledger.d), 0, "nothing before evidence");
  await s.m.refresh([s.row], [s.ledger.d]);
  assert.equal(s.hub.asked.length, 1);
  assert.match(s.hub.asked[0], new RegExp(`^/v1/pvm/evidence\\?deployment=${D}&nonce=[0-9a-f]{64}$`));
  assert.deepEqual(s.fetched, [CID], "the relay fetched the component itself, by the catalog's CID");
  const until = s.m.servesUntil(s.row, s.ledger.d);
  assert.ok(until > s.clock.t / 1000 && until <= s.ledger.d.leaseUntil, "served, and never past the lease");
  assert.deepEqual(s.m.served(s.row, [s.ledger.d]).map((x) => x.id), [D]);
  // the certificate: exactly the evidenced TLS key, nothing else
  assert.equal((await s.m.certificate(s.row, s.ledger.d, s.vm.tlsSpkiSha256)).ok, true);
  const other = await s.m.certificate(s.row, s.ledger.d, "ee".repeat(32));
  assert.equal(other.ok, false); assert.match(other.reason, /certificate key differs/);
});

test("per app: refused for another app, another VM's evidence, a TLS key the transport key did not sign, or a bad nonce", { skip }, async () => {
  for (const [name, s, re] of [
    ["another component", setup({ vmOpts: { appId: "ab".repeat(32) } }), /names another app/],
    ["unsigned TLS key", setup({ vmOpts: { forge: "other-tls" } }), /TLS key is not signed/],
    ["another VM", (() => { const x = setup(); x.hub.info = (n) => ({ name: n, mode: "avf", tier: "pvm-cpu", keyFp: "00".repeat(32), operator: OPERATOR }); return x; })(), /not from the VM attached as this host/],
    ["a stale nonce", (() => { const x = setup(); x.hub.answer = () => x.vm.evidence("11".repeat(32)); return x; })(), /another nonce/],
    ["an error", (() => { const x = setup(); x.hub.answer = () => ({ error: "attestation unavailable" }); return x; })(), /no evidence from the live host/],
    // genuine v3 evidence (the same VM, every signature valid) binds no TLS key: never served to buyers
    ["v3 evidence", (() => { const x = setup(); x.hub.answer = (n) => { const { tlsSpki, tlsKeySig, appSha256, transportKey, ...v3 } = x.vm.evidence(n);
      return { ...v3, format: "enclave-pvm-app-evidence/v3" }; }; return x; })(), /binds no TLS key/],
  ]) {
    const r = await s.m.certificate(s.row, s.ledger.d, s.vm.tlsSpkiSha256);
    assert.equal(r.ok, false, name); assert.match(r.reason, re, name);
    assert.equal(s.m.servesUntil(s.row, s.ledger.d), 0, `${name}: not served`);
  }
});

test("per app: a deployment a pVM does not serve is never asked for evidence", { skip }, async () => {
  for (const [dep, re] of [[{ isPublic: false }, /only public/], [{ gpuMilli: 250 }, /CPU-only/], [{ runner: "0x" + "99".repeat(32) }, /not leased to this host/],
    [{ leaseUntil: 1 }, /not leased to this host/], [{ configCid: '{"domains":["x.example"]}' }, /options domains are not served/],
    [{ configCid: '{"config":["a"]}' }, /config override is not a JSON object/], [{ configCid: '{"configCid":"not a cid"}' }, /not a bare CID/],
    [{ configCid: '{"isolation":{"require":"snp-guest-per-app"}}' }, /isolation requirement/], [{ configCid: '{"isolation":{"cpuTee":true}}' }, /isolation requirement/],
    [{ active: false }, /not active/]]) {
    const s = setup({ dep });
    const r = await s.m.certificate(s.row, s.ledger.d, s.vm.tlsSpkiSha256);
    assert.equal(r.ok, false, JSON.stringify(dep)); assert.match(r.reason, re, JSON.stringify(dep));
    assert.equal(s.hub.asked.length, 0, `${JSON.stringify(dep)}: no evidence asked`);
  }
  const p = setup({ catalog: { approval: 0 } });
  assert.match((await p.m.certificate(p.row, p.ledger.d)).reason, /not approved/);
  const y = setup({ catalog: { yanked: true } });
  assert.match((await y.m.certificate(y.row, y.ledger.d)).reason, /yanked/);
  // the pure rule, for the host agent's twin: the CPU hosts' options are served (the host agent applies them)
  assert.equal(pvmOptionsRefusal({ active: true, isPublic: true, gpuMilli: 0, configCid: '{"network":{"transport":"tuna"},"isolation":{"require":"avf-pvm-per-app"}}' }), null);
  assert.equal(pvmOptionsRefusal({ active: true, isPublic: true, gpuMilli: 0, configCid: '{"config":{"a":"$SECRET"},"waf":{"rps":5}}' }), null);
  assert.equal(pvmOptionsRefusal({ active: true, isPublic: true, gpuMilli: 0, configCid: '{"configCid":"bafkreigdyrztxyzxyzxyzxyz"}' }), null);
  assert.equal(pvmOptionsRefusal({ active: true, isPublic: true, gpuMilli: 250, configCid: '{"gpu":{"optional":true}}' }), null, "the owner's gpu.optional");
  assert.equal(pvmOptionsRefusal({ active: true, isPublic: true, gpuMilli: 250, configCid: "" }, { gpuOptional: true }), null, "the publisher's gpuOptional");
  assert.match(pvmOptionsRefusal({ active: true, isPublic: true, gpuMilli: 250, configCid: "" }), /CPU-only/);
  // a configured deployment, and one whose publisher made the card optional, are verified and served like any other
  const c = setup({ dep: { configCid: '{"config":{"endpoint":"$S3"},"waf":{"rps":5}}' } });
  assert.equal((await c.m.certificate(c.row, c.ledger.d, c.vm.tlsSpkiSha256)).ok, true);
  assert.ok(c.m.servesUntil(c.row, c.ledger.d) > 0);
  const g = setup({ dep: { gpuMilli: 250 }, catalog: { config: '{"gpuOptional":true}' } });
  assert.equal((await g.m.certificate(g.row, g.ledger.d, g.vm.tlsSpkiSha256)).ok, true, "publisher gpuOptional");
  assert.ok(g.m.servesUntil(g.row, g.ledger.d) > 0);
});

test("served state ends with a ledger change, a re-attach (another transport key) and the TTL; a transient failure keeps it to its TTL", { skip }, async () => {
  const s = setup();
  await s.m.refresh([s.row], [s.ledger.d]);
  assert.ok(s.m.servesUntil(s.row, s.ledger.d) > 0);
  assert.equal(s.m.servesUntil(s.row, { ...s.ledger.d, appRef: `catalog://0x${"ab".repeat(32)}/1` }), 0, "another app version: not this verdict");
  assert.equal(s.m.servesUntil(s.row, { ...s.ledger.d, runner: "0x" + "99".repeat(32) }), 0, "leased elsewhere");
  const keyFp = s.vm.keyFp;
  s.hub.info = (n) => ({ name: n, mode: "avf", tier: "pvm-cpu", keyFp: "12".repeat(32), operator: OPERATOR });
  assert.equal(s.m.servesUntil(s.row, s.ledger.d), 0, "a re-attached VM (another transport key) must prove itself again");
  s.hub.info = (n) => ({ name: n, mode: "avf", tier: "pvm-cpu", keyFp, operator: OPERATOR });
  // a transient failure (the tunnel timed out) leaves the verdict to its TTL
  s.clock.t += 5 * 60_000;
  s.hub.answer = () => { throw new Error("tunnel request timeout"); };
  await s.m.refresh([s.row], [s.ledger.d]);
  assert.ok(s.m.servesUntil(s.row, s.ledger.d) > 0, "still served within the TTL");
  s.clock.t += 6 * 60_000;
  assert.equal(s.m.servesUntil(s.row, s.ledger.d), 0, "the TTL ended it");
  // a refusal that says something about the app revokes at once
  const r = setup(); await r.m.refresh([r.row], [r.ledger.d]); assert.ok(r.m.servesUntil(r.row, r.ledger.d) > 0);
  r.clock.t += 5 * 60_000; r.hub.answer = () => r.vm.evidence("22".repeat(32));
  await r.m.refresh([r.row], [r.ledger.d]);
  assert.equal(r.m.servesUntil(r.row, r.ledger.d), 0, "evidence for another nonce revokes the verdict");
});

// ---- sealed secrets for a pVM (relay/pvm-secrets.mjs): the operator asks, the relay verifies the VM and its seal key, the
// release is sealed to that key and signed by the relay's release key; nothing is read for anyone else ----
const OPKEY = "0x" + "11".repeat(32), opAccount = privateKeyToAccount(OPKEY), ENDPOINT = "https://api.enclave.host/t/pixel10-pvm-cpu";
function releaseSetup({ sealAnswer = null, operator = opAccount.address, dep = {}, lease = true } = {}) {
  const s = setup({ dep });
  const relKey = generateKeyPairSync("ed25519").privateKey;
  const read = [];
  s.hub.fetchJson = async (origin, path) => {
    s.hub.asked.push(path);
    const n = /nonce=([0-9a-f]{64})/.exec(path)[1];
    return { evidence: s.vm.evidence(n), seal: sealAnswer ? sealAnswer(n, s.vm) : s.vm.seal(n, D) };
  };
  const release = createPvmSecretRelease({ hub: s.hub, market: s.m, rootPins: [s.ca.rootPin],
    pins: { codeHashes: new Set([CODE.toString("hex")]), authorityHashes: new Set([AUTH.toString("hex")]), runtimeIds: new Set([RID]) },
    hostForEndpoint: (id) => (id === ROW_ID ? s.row : null), confirmRow: async (id) => (id === D ? { ...s.ledger.d, ...(lease ? {} : { runner: "0x" + "99".repeat(32) }) } : null),
    signingKey: () => relKey });
  const ctx = { operatorOfEndpoint: async () => operator, endpointIdOf: async () => ROW_ID };
  const reader = (id) => { read.push(id); return { env: { MCP_ADAPTER_API_KEY: "s3cret", S3_ENDPOINT: "https://s3.example" }, rev: 3 }; };
  const ask = async (over = {}) => {
    const ts = Math.floor(Date.now() / 1000);
    const opSig = await opAccount.signMessage({ message: pvmSecretsMessage(D, ENDPOINT, ts) });
    return release({ id: D, endpoint: ENDPOINT, ts, opSig, ...over }, ctx, reader);
  };
  return { ...s, relKey, read, ask };
}

test("pVM secrets: released sealed to the VM's attested seal key, signed by the release key, after every check", { skip }, async () => {
  const r = releaseSetup();
  const out = await r.ask();
  assert.equal(out.count, 2);
  const ticket = Buffer.from(out.nonce, "hex"), sealed = Buffer.from(out.sealed, "base64");
  assert.ok(verifyResponse({ publicKey: ed25519RawPublic(r.relKey), sig: Buffer.from(out.sig, "base64"), id: D, ticket, sealKey: Buffer.from(out.sealKey, "hex"), sealed }),
    "the VM checks the relay's signature before it opens");
  const plain = JSON.parse(openRelease({ id: D, ticket, sealPrivateKey: r.vm.sealPrivate, sealed }).toString());
  assert.deepEqual(plain.secrets, { MCP_ADAPTER_API_KEY: "s3cret", S3_ENDPOINT: "https://s3.example" });
  assert.equal(plain.id, D);
  assert.match(r.hub.asked.at(-1), new RegExp(`^/v1/pvm/secret-evidence\\?deployment=${D}&nonce=${out.nonce}$`), "over the relay's own nonce");
});

test("pVM secrets: nothing is read for a wrong operator, another lease holder, a seal key the VM's transport key did not sign, or a replay", { skip }, async () => {
  for (const [name, r, re] of [
    ["another operator", releaseSetup({ operator: "0x" + "22".repeat(20) }), /operator signature refused/],
    ["not the lease holder", releaseSetup({ lease: false }), /does not hold the deployment's live lease/],
    ["a private deployment", releaseSetup({ dep: { isPublic: false } }), /only public/],
    ["a seal key signed by another key", releaseSetup({ sealAnswer: (n, vm) => vm.seal(n, D, { by: vm.other.privateKey }) }), /not signed by the VM's attested transport key/],
    ["a statement for another deployment", releaseSetup({ sealAnswer: (n, vm) => vm.seal(n, "0x" + "ee".repeat(32)) }), /not for this deployment/],
    ["a statement for another nonce", releaseSetup({ sealAnswer: (n, vm) => vm.seal("ab".repeat(32), D) }), /not for this deployment, app and nonce/],
  ]) {
    await assert.rejects(r.ask(), re, name);
    assert.deepEqual(r.read, [], `${name}: no secret was read`);
  }
  const r = releaseSetup();
  const ts = Math.floor(Date.now() / 1000), opSig = await opAccount.signMessage({ message: pvmSecretsMessage(D, ENDPOINT, ts) });
  await r.ask({ ts, opSig });
  await assert.rejects(r.ask({ ts, opSig }), /replayed/);
  await assert.rejects(r.ask({ ts: ts - 600 }), /invalid release request/, "a stale request");
});

// ---- sibling VMs (pvm-market.mjs checkHostVm): a host runs one VM per app; evidence from a VM other than the tunnel's is
// the host's only when that VM proves the host's registered proof key over the relay's same nonce ----
import { siblingDigest } from "../relay/pvm-market.mjs";
const PROOF = privateKeyToAccount("0x" + "22".repeat(32)), STRANGER = privateKeyToAccount("0x" + "33".repeat(32));
function siblingSetup({ signer = PROOF, registered = PROOF.address, tamper = null, noReader = false } = {}) {
  const s = setup();
  const other = fakeVm(s.dir, s.ca);   // another VM: its own transport key, same build
  s.hub.fetchJson = async (origin, path) => {
    s.hub.asked.push(path);
    const n = /nonce=([0-9a-f]{64})/.exec(path)[1];
    if (path.startsWith("/v1/pvm/evidence")) return other.evidence(n);
    const ev = other.evidence(n);
    const st = { format: "enclave-pvm-sibling/v1", nonce: tamper === "nonce" ? "ab".repeat(32) : n, deployment: D, instanceId: instanceIdOf(Buffer.from(ev.instanceKey, "hex")).toString("hex"),
                 transportSpki: ev.spki, proofKey: signer.address.toLowerCase() };
    const sig = await signer.sign({ hash: "0x" + siblingDigest({ ...st, nonce: n }).toString("hex") });
    return { ...st, sig: sig.slice(2) };
  };
  const m = createPvmMarket({ hub: s.hub, enabled: true, pins: { codeHashes: new Set([CODE.toString("hex")]), authorityHashes: new Set([AUTH.toString("hex")]), runtimeIds: new Set([RID]) },
    rootPins: [s.ca.rootPin], now: () => s.clock.t, log: () => {}, confirmRow: async (id) => (id === D ? { ...s.ledger.d } : null),
    readCatalog: async () => ({ app: { active: true }, version: { cid: CID, memMb: 128, ports: "", approval: 1, yanked: false } }),
    fetchVerified: async (cid) => (cid === CID ? { ok: true, bytes: COMPONENT } : { ok: false }),
    ...(noReader ? {} : { proofKeyOf: async (id) => (id === ROW_ID ? registered.toLowerCase() : null) }) });
  return { ...s, m };
}

test("a sibling VM's evidence is the host's when it proves the host's registered proof key; nothing else is", { skip }, async () => {
  const ok = siblingSetup();
  const r = await ok.m.certificate(ok.row, ok.ledger.d);
  assert.equal(r.ok, true, r.reason);
  assert.ok(ok.hub.asked.some((p) => p.startsWith("/v1/pvm/sibling")), "the relay asked for the statement over its own nonce");
  for (const [name, s, re] of [
    ["a key the registry does not name", siblingSetup({ signer: STRANGER }), /does not hold this host's registered proof key/],
    ["the registry names another key", siblingSetup({ registered: STRANGER.address }), /does not hold this host's registered proof key/],
    ["a statement for another nonce", siblingSetup({ tamper: "nonce" }), /not for this nonce/],
    ["no proof-key reader: only the tunnel's VM", siblingSetup({ noReader: true }), /not from the VM attached as this host/],
  ]) {
    const x = await s.m.certificate(s.row, s.ledger.d);
    assert.equal(x.ok, false, name); assert.match(x.reason, re, name);
  }
});
