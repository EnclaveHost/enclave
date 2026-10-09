// The pVM marketplace (relay/pvm-market.mjs; PVM-CPU.md "Serving buyers"): a phone's protected VM takes buyers' apps only on
// the relay's own verdicts. A fake hub answers the relay's evidence request with v4 evidence made here over THE RELAY'S nonce
// (a synthetic AVF chain from a test CA, test/fixtures/avf-synthetic.mjs; the real device document is checked in
// test/pvm-app-evidence-v4.test.mjs):
//   - capacity: the market switched on with the tier's pins, an AVF row tiered pvm-cpu, its attach signed by its registered
//     operator, a registered (keccak) id -- each condition alone withdraws it;
//   - per app: served only after evidence for exactly the catalog's component (CID-verified by the relay), from the VM attached
//     as this host, binding a TLS key -- and a certificate only for that key; a deployment that is private, GPU, unleased,
//     configured, secret-bearing or unapproved is never served; an app or ledger change, a re-attach and the TTL end it.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { tmpdir, makeCa, issueLeaf, extension, haveOpenssl, CODE, AUTH } from "./fixtures/avf-synthetic.mjs";
import { createPvmMarket, pvmOptionsRefusal } from "../relay/pvm-market.mjs";
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
  return { keyFp: sha(spki), tlsSpkiSha256: sha(tls.publicKey.export({ format: "der", type: "spki" })), evidence };
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
  return { m, row, hub, ledger, clock, vm, fetched };
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
    [{ leaseUntil: 1 }, /not leased to this host/], [{ configCid: '{"config":{"a":1}}' }, /options config are not served/],
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
  // the pure rule, for the host agent's twin
  assert.equal(pvmOptionsRefusal({ active: true, isPublic: true, gpuMilli: 0, configCid: '{"network":{"transport":"tuna"},"isolation":{"require":"avf-pvm-per-app"}}' }), null);
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
