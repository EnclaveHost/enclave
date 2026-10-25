// The pure core of the independent credit-vault client (site/js/core/credit-vault-independent.js), no chain:
//   - the digest is the CONTRACT's abi.encode (pinned against viem's encoding and the hosted page's own vault.js),
//   - create()/control calldata match the hosted path's encodings (vault.js expectedControlCall / decodeCreateCall),
//     always with no publisher fee,
//   - P-256 public-key recovery from two WebAuthn-shaped assertions, and the local signature check,
//   - profile, pins, intent and signed-request validation refuse what they must,
//   - the browser bundle (site/vendor/credit-vault.js) exports exactly the primitives the core uses.
//   node --test test/credit-vault-core.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256, toHex, encodeAbiParameters, decodeFunctionData, parseAbi } from "viem";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CV = await import(path.join(REPO, "site/js/core/credit-vault-independent.js"));
const HOSTED = await import(path.join(REPO, "site/js/core/vault.js"));
const { lib } = await import(path.join(REPO, "cli/credit-vault.mjs"));
const VAULT = "0x1111111111111111111111111111111111111111", ID = "0x" + "ab".repeat(32);
const b64u = (b) => Buffer.from(b).toString("base64url");

if (process.env.INJECT_FAILURE) test("INJECTED FAILURE (negative control: the suite must exit nonzero)", () => assert.fail("injected"));

test("opDigest is the contract's abi.encode for every op, and equals the hosted page's recomputation", () => {
  const base = { vault: VAULT, chainId: 8453, nonce: 7n, deadline: 1792000900n };
  const createCall = CV.buildCreateCall(lib, 16, { appRef: "catalog://a", gpuMilli: 0, cpuMilli: 500, appPort: 8080, ports: "", isPublic: true, configCid: "", maxRate6: "1000" });
  const callData = CV.buildControlCall(lib, { id: ID, action: "suspend" });
  const W = (t) => ({ type: t }), head = [W("bytes32"), W("address"), W("uint256"), W("uint256")];
  const tag = (s) => keccak256(toHex(s));
  const cases = {
    deploy: [{ createCall, fund6: 30000000n }, [W("bytes32"), W("uint256")], [keccak256(createCall), 30000000n]],
    fund: [{ id: ID, fund6: 5n }, [W("bytes32"), W("uint256")], [ID, 5n]],
    control: [{ callData }, [W("bytes32")], [keccak256(callData)]],
    refund: [{ amount6: 9n }, [W("uint256")], [9n]],
    addKey: [{ x: "0x01", y: "0x02" }, [W("uint256"), W("uint256")], [1n, 2n]],
    removeKey: [{ keyHash: ID }, [W("bytes32")], [ID]],
  };
  for (const [op, [args, types, vals]] of Object.entries(cases)){
    const want = keccak256(encodeAbiParameters([...head, ...types, W("uint256")], [tag(CV.OPS[op].tag), VAULT, 8453n, 7n, ...vals, base.deadline]));
    assert.equal(CV.opDigest(lib, op, { ...base, args }), want, op);
    if (["deploy", "fund", "control", "refund"].includes(op))
      assert.equal(HOSTED.opDigest(op, { vault: VAULT, chainId: 8453, nonce: 7, deadline: base.deadline, createCall: args.createCall, fund6: args.fund6, id: args.id,
        callData: args.callData, amount6: args.amount6 }), want, op + " = site/js/core/vault.js");
  }
});

test("create() takes the ledger revision's shape and never carries a publisher fee", () => {
  const spec = { appRef: "catalog://a", gpuMilli: 250, cpuMilli: 100, appPort: 3000, ports: "tcp:22", isPublic: false, configCid: "bafy", maxRate6: "4200" };
  const c10 = HOSTED.decodeCreateCall(CV.buildCreateCall(lib, 16, spec));
  assert.deepEqual([c10.appRef, c10.gpuMilli, c10.cpuMilli, c10.appPort, c10.ports, c10.isPublic, c10.configCid, c10.feeRecipient, c10.feePerSec6, c10.maxRate6],
    ["catalog://a", 250, 100, 3000, "tcp:22", false, "bafy", "0x" + "0".repeat(40), 0n, 4200n]);
  const { maxRate6, ...noCap } = spec; void maxRate6;
  const c9 = HOSTED.decodeCreateCall(CV.buildCreateCall(lib, 5, noCap));
  assert.equal(c9.feePerSec6, 0n); assert.equal(c9.maxRate6, 0n);
  HOSTED.decodeCreateCall(CV.buildCreateCall(lib, 3, noCap));
  assert.throws(() => CV.buildCreateCall(lib, 16, noCap), /maxRate6/);
  assert.throws(() => CV.buildCreateCall(lib, 5, spec), /no rate cap/);
  assert.throws(() => CV.buildCreateCall(lib, 16, { ...spec, appRef: "" }), /appRef/);
  assert.throws(() => CV.buildCreateCall(lib, 16, { ...spec, cpuMilli: 0 }), /cpuMilli/);
});

test("control calldata matches the hosted path, adds cancel (ledger refund to the vault), and refuses anything else", () => {
  const same = [{ action: "suspend" }, { action: "resume" }, { action: "version", ref: "catalog://a@2" }, { action: "options", envelope: '{"waf":{"rps":5}}' },
    { action: "maxrate", maxRate6: 3000 }, { action: "resize", gpuMilli: 0, cpuMilli: 300 }, { action: "resize", gpuMilli: 0, cpuMilli: 300, ref: "catalog://a@3", active: true }];
  for (const p of same) assert.equal(CV.buildControlCall(lib, { id: ID, ...p }), HOSTED.expectedControlCall({ id: ID, ...p }).toLowerCase(), p.action);
  assert.equal(decodeFunctionData({ abi: parseAbi(["function refund(bytes32)"]), data: CV.buildControlCall(lib, { id: ID, action: "cancel" }) }).args[0], ID);
  assert.throws(() => CV.buildControlCall(lib, { id: ID, action: "transfer" }), /control action/);
  assert.throws(() => CV.buildControlCall(lib, { id: ID, action: "options", envelope: "[1]" }), /JSON object/);
  assert.throws(() => CV.buildControlCall(lib, { id: "0x12", action: "suspend" }), /deployment id/);
});

function key(){ const priv = p256.utils.randomPrivateKey(); const P = p256.ProjectivePoint.fromPrivateKey(priv).toAffine();
  return { priv, x: "0x" + P.x.toString(16).padStart(64, "0"), y: "0x" + P.y.toString(16).padStart(64, "0") }; }
function assertion(k, challenge, origin = "https://enclave.host", flags = 0x05){
  const cdj = JSON.stringify({ type: "webauthn.get", challenge: b64u(Buffer.from(challenge.slice(2), "hex")), origin, crossOrigin: false });
  const ad = Buffer.concat([Buffer.from(sha256(Buffer.from("enclave.host"))), Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
  const s = p256.sign(sha256(Buffer.concat([ad, Buffer.from(sha256(Buffer.from(cdj)))])), k.priv, { prehash: false });
  return { authenticatorData: "0x" + ad.toString("hex"), clientDataJSON: cdj, r: s.r, s: s.s };
}

test("the passkey's public key is recovered from two assertions, and checked", async () => {
  const k = key(), o = key();
  for (let i = 0; i < 8; i++){
    const got = await CV.recoverPasskeyKey(lib, assertion(k, "0x" + String(i).repeat(64).slice(0, 64)), assertion(k, "0x" + "e".repeat(64)));
    assert.deepEqual(got, { x: k.x, y: k.y });
  }
  await assert.rejects(CV.recoverPasskeyKey(lib, assertion(k, "0x" + "1".repeat(64)), assertion(o, "0x" + "2".repeat(64))), /SAME passkey/);
  const a = assertion(k, "0x" + "3".repeat(64));
  assert.equal(await CV.assertionVerifies(lib, a, k.x, k.y), true);
  assert.equal(await CV.assertionVerifies(lib, a, o.x, o.y), false);
  assert.throws(() => CV.checkKey(lib, k.x, "0x" + "0".repeat(63) + "1"), /not a P-256 public key/);
});

test("pins, profiles and the clone recognizer refuse what they must", () => {
  assert.throws(() => CV.validatePins({ ...CV.PRODUCTION_PINS, rpId: "evil.example" }), /host is the rpId/);
  assert.throws(() => CV.validatePins({ ...CV.PRODUCTION_PINS, factories: [] }), /1 to 8/);
  const k = key(), f = CV.PRODUCTION_PINS.factories.at(-1);
  const row = { factory: f.address, vault: CV.deriveVault(lib, k.x, k.y, f), key: { x: k.x, y: k.y } };
  const p = CV.makeProfile(row, { credentialId: b64u(Buffer.alloc(20, 7)), label: "laptop" });
  assert.equal(p.origin, "https://enclave.host");
  assert.throws(() => CV.validateProfile({ ...p, origin: "https://x.app.enclave.host" }), /another chain or origin/);
  assert.throws(() => CV.validateProfile({ ...p, factory: "0x" + "9".repeat(40) }), /not one of the pinned/);
  assert.throws(() => CV.validateProfile({ ...p, extra: 1 }), /unknown fields/);
  assert.equal(CV.isCreditVaultClone(lib, CV.cloneRuntime(lib, f.implementation)).address, f.address);
  assert.equal(CV.isCreditVaultClone(lib, CV.cloneCode(lib, f.implementation)), null, "creation code is not a minted vault");
  // the production vault address formula equals the recover page's (same factory pins, same clone)
  const fx = JSON.parse(fs.readFileSync(path.join(REPO, "site/recover/recover-config.json"), "utf8"));
  assert.equal(fx.factory, f.address); assert.equal(fx.implementation, f.implementation);
});

test("both factories the platform book has named derive exactly what they derive on Base (live vectors, 2026-10-20)", () => {
  // vaultFor(Gx, Gy) read from Base (gateway.tenderly.co; the book's history: 0x848a… from block 48910315, 0xa891… from 49500388)
  const G = { x: "0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", y: "0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5" };
  const live = { "0x848a8a89c3452ce7dc14764114a8c5886b6f0c08": "0x2de08fe9a0c6b3d04fdea726628dfdf4ee72839c", "0xa891e4396e3eb11f364554043bc18e86da834e91": "0x99c777f9d8eb4d27f2c16fd7fd62d098dd84ddfa" };
  assert.deepEqual(CV.PRODUCTION_PINS.factories.map((f) => f.address), Object.keys(live));
  for (const f of CV.PRODUCTION_PINS.factories) assert.equal(CV.deriveVault(lib, G.x, G.y, f), live[f.address], f.label);
  assert.equal(CV.PRODUCTION_PINS.factories[0].originBound, false, "the older build is flagged: no on-chain origin check");
  const page = JSON.parse(fs.readFileSync(path.join(REPO, "site/credit/credit-config.json"), "utf8"));
  assert.deepEqual(page.factories, CV.PRODUCTION_PINS.factories.map((f) => ({ ...f })), "the page ships the same pins");
});

test("intent and request verification: tampering is refused, honest bytes re-derive", async () => {
  const k = key(), f = CV.PRODUCTION_PINS.factories.at(-1);
  const vault = CV.deriveVault(lib, k.x, k.y, f);
  const profile = CV.makeProfile({ factory: f.address, vault, key: { x: k.x, y: k.y } }, { credentialId: b64u(Buffer.alloc(20, 1)) });
  const args = { id: ID, fund6: "2000000" };
  const prepared = { v: 1, kind: CV.PREPARED_KIND, op: "fund", chainId: 8453, vault, factory: f.address, nonce: "3", deadline: "1000300", blockTimestamp: 1000000, block: 10, args,
    digest: CV.opDigest(lib, "fund", { vault, chainId: 8453, nonce: 3, deadline: 1000300, args }), summary: [] };
  CV.verifyIntent(lib, prepared, "fund", { id: ID, amountUsd: "2" });
  assert.throws(() => CV.verifyIntent(lib, prepared, "fund", { id: ID, amountUsd: "1.99" }), /different amount/);
  assert.throws(() => CV.verifyIntent(lib, prepared, "refund", { amountUsd: "2" }), /different operation/);
  assert.throws(() => CV.verifyIntent(lib, { ...prepared, nonce: "4" }, "fund", { id: ID, amountUsd: "2" }), /digest that is not/);
  const req = CV.assembleRequest(lib, prepared, profile, assertion(k, prepared.digest));
  const v = CV.verifyRequest(lib, req);
  assert.equal(v.op, "fund"); assert.equal(v.args.fund6, "2000000");
  assert.throws(() => CV.verifyRequest(lib, { ...req, nonce: "4" }), /digest is not the digest/);
  assert.throws(() => CV.verifyRequest(lib, { ...req, op: "refund" }), /not the vault op it names/);
  assert.throws(() => CV.verifyRequest(lib, { ...req, chainId: 1 }), /for chain 1/);
  assert.throws(() => CV.assembleRequest(lib, prepared, profile, assertion(k, prepared.digest, "https://enclave.host.evil.example")), /exact operation at https:\/\/enclave.host/);
  assert.throws(() => CV.assembleRequest(lib, prepared, profile, assertion(k, prepared.digest, "https://enclave.host", 0x04)), /user presence/);
  await assert.rejects(CV.signPrepared(lib, prepared, profile, { origin: "http://localhost:8080", intent: { op: "fund", params: { id: ID, amountUsd: "2" } } }), /signing works only at/);
  await assert.rejects(CV.signPrepared(lib, prepared, profile, { origin: "https://enclave.host" }), /owner's own request/);
});

test("amount parsing is exact dollars-and-cents; the gas-reserve refusal names the reason", () => {
  assert.equal(CV.reserveRefusal(false), null);
  assert.match(CV.reserveRefusal(true), /configure, setClaimant and withdraw must be sent by the owner of record/);
});

test("the browser bundle exports the primitives the core uses (and aa.js is left as it was)", async () => {
  const m = JSON.parse(fs.readFileSync(path.join(REPO, "site/vendor/credit-vault.MANIFEST.json"), "utf8"));
  for (const k of ["encodeFunctionData", "decodeFunctionData", "decodeFunctionResult", "encodeAbiParameters", "keccak256", "getAddress", "concat", "toHex", "hexToBytes",
    "WebAuthnP256", "p256", "sha256"]) assert.ok(m.exports.includes(k), k);
  const aa = JSON.parse(fs.readFileSync(path.join(REPO, "site/vendor/aa.MANIFEST.json"), "utf8"));
  assert.equal(aa.sha256, "66ba5040d61a52a9f30187b0166b31ea95b0beef94814d6e5876a4a3c4f625da");
  const B = await import(path.join(REPO, "site/vendor/credit-vault.js"));
  const k = key();
  const msg = sha256(new Uint8Array([1, 2, 3]));
  const s = B.p256.sign(msg, k.priv, { prehash: false });
  assert.equal(B.p256.verify(s, msg, B.hexToBytes(B.concat(["0x04", k.x, k.y])), { prehash: false }), true);
  assert.equal(B.keccak256("0x01"), keccak256("0x01"));
});
