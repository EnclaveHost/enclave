// shielded/anchor/avf/web/pvm-sealed.js: the browser channel's HPKE (RFC 9180) and OHTTP-shaped response (RFC 9458 4.4),
// on WebCrypto alone. Held to RFC 9180's own test vector (A.1.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base
// mode, from rust-hpke's copy of the RFC vectors), then to a round trip, tampering and misuse, then to the cross-language
// vector the VM side must reproduce byte for byte (runtime/pvm-rt/tests/sealed-vectors.json, read by tests/sealed.rs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, createPrivateKey, createPublicKey, diffieHellman } from "node:crypto";
import * as S from "../shielded/anchor/avf/web/pvm-sealed.js";

const h = (s) => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (b) => Buffer.from(b).toString("hex");
const te = new TextEncoder();
const pkcs8 = (sk) => Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(sk)]);
const pubOf = (sk) => new Uint8Array(createPublicKey(createPrivateKey({ key: pkcs8(sk), format: "der", type: "pkcs8" })).export({ type: "spki", format: "der" }).subarray(12));

test("RFC 9180 A.1.1 (X25519, HKDF-SHA256, AES-128-GCM, base): key schedule, first seal, exports", async () => {
  const v = { info: "4f6465206f6e2061204772656369616e2055726e", skEm: "52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736",
    pkEm: "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431", pkRm: "3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d",
    key: "4531685d41d65f03dc48f6b8302c05b0", base_nonce: "56d890e5accaaf011cff4b7d", exporter_secret: "45ff1c2e220db587171952c0592d5f5ebe103f1561a2614e38f2ffd47e99e3f8", // gitleaks:allow -- RFC 9180 A.1.1: a PUBLISHED test vector, not a secret
    aad: "436f756e742d30", pt: "4265617574792069732074727574682c20747275746820626561757479",
    ct: "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a" };
  const s = await S.sealBase(h(v.pkRm), h(v.info), h(v.aad), h(v.pt), { skE: h(v.skEm), pkE: h(v.pkEm) });
  assert.equal(hex(s.enc), v.pkEm);
  assert.equal(hex(s.ks.key), v.key); assert.equal(hex(s.ks.baseNonce), v.base_nonce); assert.equal(hex(s.ks.exporterSecret), v.exporter_secret);
  assert.equal(hex(s.ct), v.ct);
  for (const [ctx, want] of [["", "3853fe2b4035195a573ffc53856e77058e15d9ea064de3e59f4961d0095250ee"], ["00", "2e8f0b54673c7029649d4eb9d5e33bf1872cf76d623ff164ac185da9e88c21a5"],
                             ["54657374436f6e74657874", "e9e43065102c3836401bed8c3c3c75ae46be1639869391d62c61f1ec7af54931"]])
    assert.equal(hex(await S.exportSecret(s.exporterSecret, h(ctx), 32)), want);
});

// a stand-in for the VM's side in JS (node:crypto X25519 + the module's own schedule), only to exercise the page's side
async function vmOpen(skR, frame, appId, runtimeId) {
  const body = frame.subarray(4), nonce = body.subarray(0, 32), hdr = body.subarray(32, 39), enc = body.subarray(39, 71), ct = body.subarray(71);
  assert.deepEqual([...hdr], [...S.HDR]);
  const dh = diffieHellman({ privateKey: createPrivateKey({ key: pkcs8(skR), format: "der", type: "pkcs8" }),
                             publicKey: createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(enc)]), format: "der", type: "spki" }) });
  const pkR = pubOf(skR);
  const te2 = new TextEncoder(), kem = S.HDR.subarray(1, 3);
  const L = (label, suite) => te2.encode(label);
  // DHKEM ExtractAndExpand, then the same key schedule the page used
  const kemSuite = new Uint8Array([...te2.encode("KEM"), ...kem]);
  const prk = await S.extract(new Uint8Array(0), new Uint8Array([...te2.encode("HPKE-v1"), ...kemSuite, ...L("eae_prk"), ...dh]));
  const shared = await S.expand(prk, new Uint8Array([0, 32, ...te2.encode("HPKE-v1"), ...kemSuite, ...L("shared_secret"), ...enc, ...pkR]), 32);
  const ks = await S.keySchedule(shared, S.requestInfo(appId, runtimeId));
  const k = await crypto.subtle.importKey("raw", ks.key, "AES-GCM", false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ks.baseNonce, additionalData: nonce }, k, ct));
  return { pt, nonce, ctx: { enc, exporterSecret: ks.exporterSecret } };
}

test("a sealed request opens only for the app key's holder, under this app, runtime and nonce; the answer only for this request", async () => {
  const skR = createHash("sha256").update("vm app key").digest(), pkR = pubOf(skR);
  const appId = createHash("sha256").update("app").digest(), rid = createHash("sha256").update("runtime").digest(), nonce = createHash("sha256").update("nonce").digest();
  const req = S.httpRequest("GET", "/?graph=g&steps=8");
  const { frame, ctx } = await S.sealRequest({ appKey: pkR, appId, runtimeId: rid, nonce, request: req });
  assert.equal(frame.length, 4 + 32 + 7 + 32 + req.length + 16);
  assert.equal(new DataView(frame.buffer).getUint32(0), frame.length - 4);
  assert.ok(!Buffer.from(frame).includes(Buffer.from("graph=g")), "no plaintext in the frame");
  const o = await vmOpen(skR, frame, appId, rid);
  assert.equal(Buffer.from(o.pt).toString(), Buffer.from(req).toString());
  // another app or runtime in the VM's info, another key: the VM cannot open it
  await assert.rejects(vmOpen(skR, frame, createHash("sha256").update("other app").digest(), rid));
  await assert.rejects(vmOpen(skR, frame, appId, createHash("sha256").update("other runtime").digest()));
  await assert.rejects(vmOpen(createHash("sha256").update("relay key").digest(), frame, appId, rid));
  // the nonce is the AAD: a carrier that rewrites it breaks the request
  const renonced = frame.slice(); renonced[4] ^= 1; await assert.rejects(vmOpen(skR, renonced, appId, rid));
  const flipped = frame.slice(); flipped[frame.length - 1] ^= 1; await assert.rejects(vmOpen(skR, flipped, appId, rid));
  // the answer
  const resp = te.encode("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n5\r\n{\"a\":\r\n2\r\n1}\r\n0\r\n\r\n");
  const sealed = await S.sealResponseForTest(o.ctx, resp, new Uint8Array(16).fill(7));
  const opened = await S.openResponse(ctx, sealed);
  assert.equal(opened.ok, true, opened.refused);
  const parsed = S.parseHttpResponse(opened.response);
  assert.equal(parsed.status, 200); assert.equal(parsed.body, '{"a":1}');
  const t = sealed.slice(); t[30] ^= 1;
  assert.match((await S.openResponse(ctx, t)).refused, /does not open/);
  const other = await S.sealRequest({ appKey: pkR, appId, runtimeId: rid, nonce, request: req });   // another request's keys
  assert.match((await S.openResponse(other.ctx, sealed)).refused, /does not open/);
  assert.match((await S.openResponse(ctx, Uint8Array.of(1, ...te.encode("replayed")))).refused, /unauthenticated hint\): replayed/);
  assert.match((await S.openResponse(ctx, new Uint8Array(0))).refused, /carrier gave nothing/);
  // two requests never share an ephemeral key
  assert.notEqual(hex(other.ctx.enc), hex(ctx.enc));
  // misuse
  await assert.rejects(S.sealRequest({ appKey: pkR.subarray(1), appId, runtimeId: rid, nonce, request: req }), /32 bytes/);
  await assert.rejects(S.sealRequest({ appKey: new Uint8Array(32), appId, runtimeId: rid, nonce, request: req }));   // an all-zero (low-order) key: X25519 refuses
  assert.throws(() => S.httpRequest("GET", "http://x/"), /origin-form/);
  assert.throws(() => S.httpRequest("GET", "/", null, { "x-a": "b\r\nx: y" }), /bad header/);
});

test("the cross-language vector (runtime/pvm-rt/tests/sealed-vectors.json) is what this module computes", async () => {
  const file = new URL("../shielded/anchor/avf/runtime/pvm-rt/tests/sealed-vectors.json", import.meta.url);
  const seed = (s) => createHash("sha256").update(`pvm-sealed-vector ${s}`).digest();
  const skR = seed("skR"), skE = seed("skE"), appId = seed("app"), rid = seed("runtime"), nonce = seed("nonce"), rn = seed("response nonce").subarray(0, 16);
  const request = "GET /?graph=gemma-4-e2b-it-q4_0&steps=8 HTTP/1.1\r\nhost: pvm-app\r\nconnection: close\r\n\r\n";
  const response = "HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\n{\"ok\":true}";
  const { frame, ctx } = await S.sealRequest({ appKey: pubOf(skR), appId, runtimeId: rid, nonce, request }, { skE, pkE: pubOf(skE) });
  const sealedResponse = await S.sealResponseForTest(ctx, te.encode(response), rn);
  const v = { note: "generated by test/pvm-sealed.test.mjs from the seeds sha256('pvm-sealed-vector <name>'); the VM side (tests/sealed.rs) must open `frame` with skR and seal `response` under responseNonce to exactly `sealedResponse`",
              skR: hex(skR), pkR: hex(pubOf(skR)), skE: hex(skE), enc: hex(pubOf(skE)), appId: hex(appId), runtimeId: hex(rid), nonce: hex(nonce),
              request, frame: hex(frame), responseNonce: hex(rn), response, sealedResponse: hex(sealedResponse) };
  if (process.env.WRITE_SEALED_VECTORS) fs.writeFileSync(file, JSON.stringify(v, null, 1) + "\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), v);
});
