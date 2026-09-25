// shielded/anchor/avf/web/pvm-sealed.js: the browser channel's HPKE (the vendored @hpke/core, RFC 9180) and its answers
// (RFC 9458 4.4 whole; SEALED-STREAMING.md streamed), on WebCrypto. Held to:
//   - RFC 9180's own test vector A.1.1 through the vendored library (and the vendored bytes to their pinned build);
//   - a round trip, tampering and misuse with a recipient built from the same library;
//   - the cross-language vectors the VM side must reproduce byte for byte (runtime/pvm-rt/tests/sealed-vectors.json and
//     sealed-stream-vectors.json, read by tests/sealed.rs) -- the stream vector is also the verifier session's offline
//     fixture (known plaintext, enc, rn, the exported secret and the ephemeral key);
//   - every adversarial case agreed with the verifier session for streams (SEALED-STREAMING.md "Adversarial cases").
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import * as S from "../shielded/anchor/avf/web/pvm-sealed.js";

const h = (s) => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (b) => Buffer.from(b).toString("hex");
const te = new TextEncoder(), td = new TextDecoder();
const pkcs8 = (sk) => Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(sk)]);
const pubOf = (sk) => new Uint8Array(createPublicKey(createPrivateKey({ key: pkcs8(sk), format: "der", type: "pkcs8" })).export({ type: "spki", format: "der" }).subarray(12));
const keyPair = async (sk) => ({ privateKey: await crypto.subtle.importKey("pkcs8", pkcs8(sk), { name: "X25519" }, true, ["deriveBits"]),
                                 publicKey: await crypto.subtle.importKey("raw", pubOf(sk), { name: "X25519" }, true, []) });
const seed = (s) => createHash("sha256").update(`pvm-sealed-vector ${s}`).digest();
const VEC = new URL("../shielded/anchor/avf/runtime/pvm-rt/tests/", import.meta.url);

test("the vendored @hpke/core is the pinned build (web/vendor/build-hpke.sh)", () => {
  const b = fs.readFileSync(new URL("../shielded/anchor/avf/web/vendor/hpke-core-1.9.0.js", import.meta.url));
  assert.equal(createHash("sha256").update(b).digest("hex"), "a4302f89ae432a27c0476a21c4aa33be7cd94419b51eca8e71ef05b634db3e34");
  assert.match(b.subarray(0, 400).toString(), /@hpke\/core 1\.9\.0 \(sha512-pFxWl1nN.*@hpke\/common 1\.10\.1 \(sha512-moJwhmtL/);
  assert.match(fs.readFileSync(new URL("../shielded/anchor/avf/web/vendor/hpke-LICENSE.txt", import.meta.url), "utf8"), /MIT License/);
});

test("RFC 9180 A.1.1 through the vendored library (X25519, HKDF-SHA256, AES-128-GCM, base): enc, first seal, exports", async () => {
  const v = { info: "4f6465206f6e2061204772656369616e2055726e", ikmE: "7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234",
    pkEm: "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431", pkRm: "3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d",
    aad: "436f756e742d30", pt: "4265617574792069732074727574682c20747275746820626561757479",
    ct: "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a" }; // gitleaks:allow -- RFC 9180 A.1.1: a PUBLISHED test vector, not a secret
  const sender = await S.suite.createSenderContext({ recipientPublicKey: await S.suite.kem.deserializePublicKey(h(v.pkRm)), info: h(v.info), ekm: h(v.ikmE) });
  assert.equal(hex(new Uint8Array(sender.enc)), v.pkEm);
  assert.equal(hex(new Uint8Array(await sender.seal(h(v.pt), h(v.aad)))), v.ct);
  for (const [ctx, want] of [["", "3853fe2b4035195a573ffc53856e77058e15d9ea064de3e59f4961d0095250ee"], ["00", "2e8f0b54673c7029649d4eb9d5e33bf1872cf76d623ff164ac185da9e88c21a5"],
                             ["54657374436f6e74657874", "e9e43065102c3836401bed8c3c3c75ae46be1639869391d62c61f1ec7af54931"]])
    assert.equal(hex(new Uint8Array(await sender.export(h(ctx), 32))), want);
});

// the VM's side, in JS, from the same library (tests only): open a frame, export the answer's secret
async function vmOpen(skR, frame, appId, runtimeId) {
  const body = frame.subarray(4), nonce = body.subarray(0, 32), hdr = body.subarray(32, 39), enc = body.subarray(39, 71), ct = body.subarray(71);
  const chunked = hdr[0] === 1;
  const rc = await S.suite.createRecipientContext({ recipientKey: await keyPair(skR), enc, info: S.requestInfo(appId, runtimeId, chunked) });
  const pt = new Uint8Array(await rc.open(ct, nonce));
  const secret = new Uint8Array(await rc.export(te.encode(`${S.LABEL}${chunked ? " chunked" : ""} response`), 16));
  return { pt, nonce, ctx: { enc, secret, nonce, chunked } };
}

test("a sealed request opens only for the app key's holder, under this app, runtime, nonce and mode; the answer only for this request", async () => {
  const skR = createHash("sha256").update("vm app key").digest(), pkR = pubOf(skR);
  const appId = createHash("sha256").update("app").digest(), rid = createHash("sha256").update("runtime").digest(), nonce = createHash("sha256").update("nonce").digest();
  const req = S.httpRequest("GET", "/?graph=g&steps=8");
  const { frame, ctx } = await S.sealRequest({ appKey: pkR, appId, runtimeId: rid, nonce, request: req });
  assert.equal(frame.length, 4 + 32 + 7 + 32 + req.length + 16);
  assert.ok(!Buffer.from(frame).includes(Buffer.from("graph=g")), "no plaintext in the frame");
  const o = await vmOpen(skR, frame, appId, rid);
  assert.equal(td.decode(o.pt), td.decode(req));
  await assert.rejects(vmOpen(skR, frame, createHash("sha256").update("other app").digest(), rid));
  await assert.rejects(vmOpen(skR, frame, appId, createHash("sha256").update("other runtime").digest()));
  await assert.rejects(vmOpen(createHash("sha256").update("relay key").digest(), frame, appId, rid));
  const renonced = frame.slice(); renonced[4] ^= 1; await assert.rejects(vmOpen(skR, renonced, appId, rid));
  const flipped = frame.slice(); flipped[frame.length - 1] ^= 1; await assert.rejects(vmOpen(skR, flipped, appId, rid));
  const moded = frame.slice(); moded[4 + 32] = 1; await assert.rejects(vmOpen(skR, moded, appId, rid), "a carrier flipping the mode breaks the request");
  const resp = te.encode("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n5\r\n{\"a\":\r\n2\r\n1}\r\n0\r\n\r\n");
  const sealed = await S.sealResponseForTest(o.ctx, resp, new Uint8Array(16).fill(7));
  const opened = await S.openResponse(ctx, sealed);
  assert.equal(opened.ok, true, opened.refused);
  assert.equal(S.parseHttpResponse(opened.response).body, '{"a":1}');
  const t = sealed.slice(); t[30] ^= 1;
  assert.match((await S.openResponse(ctx, t)).refused, /does not open/);
  const other = await S.sealRequest({ appKey: pkR, appId, runtimeId: rid, nonce, request: req });
  assert.match((await S.openResponse(other.ctx, sealed)).refused, /does not open/);
  assert.match((await S.openResponse(ctx, Uint8Array.of(1, ...te.encode("replayed")))).refused, /unauthenticated hint\): replayed/);
  assert.notEqual(hex(other.ctx.enc), hex(ctx.enc), "two requests never share an ephemeral key");
  await assert.rejects(S.sealRequest({ appKey: pkR.subarray(1), appId, runtimeId: rid, nonce, request: req }), /32 bytes/);
  await assert.rejects(S.sealRequest({ appKey: new Uint8Array(32), appId, runtimeId: rid, nonce, request: req }));   // a low-order key: X25519 refuses
  assert.throws(() => S.httpRequest("GET", "http://x/"), /origin-form/);
  assert.throws(() => S.httpRequest("GET", "/", null, { "x-a": "b\r\nx: y" }), /bad header/);
});

test("the whole-response cross-language vector (tests/sealed-vectors.json) is unchanged under the vendored library", async () => {
  const skR = seed("skR"), skE = seed("skE"), appId = seed("app"), rid = seed("runtime"), nonce = seed("nonce"), rn = seed("response nonce").subarray(0, 16);
  const request = "GET /?graph=gemma-4-e2b-it-q4_0&steps=8 HTTP/1.1\r\nhost: pvm-app\r\nconnection: close\r\n\r\n";
  const response = "HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\n{\"ok\":true}";
  const { frame, ctx } = await S.sealRequest({ appKey: pubOf(skR), appId, runtimeId: rid, nonce, request }, await keyPair(skE));
  const v = JSON.parse(fs.readFileSync(new URL("sealed-vectors.json", VEC), "utf8"));
  assert.equal(hex(frame), v.frame, "the request frame is byte-identical to the one the hand-written HPKE produced");
  assert.equal(hex(await S.sealResponseForTest(ctx, te.encode(response), rn)), v.sealedResponse);
});

// the stream vector: a chunked request, and its answer as data chunks + FIN, and an ABORT variant
async function streamVector() {
  const skR = seed("skR"), skE = seed("skE stream"), appId = seed("app"), rid = seed("runtime"), nonce = seed("nonce stream"), rn = seed("stream response nonce").subarray(0, 16);
  const request = "GET /?graph=gemma-4-e2b-it-q4_0&steps=3 HTTP/1.1\r\nhost: pvm-app\r\nconnection: close\r\n\r\n";
  const parts = ["HTTP/1.1 200 OK\r\ncontent-type: application/x-ndjson\r\ntransfer-encoding: chunked\r\n\r\n", "d\r\n{\"i\":0,\"t\":7}\n\r\n", "d\r\n{\"i\":1,\"t\":9}\n\r\n", "0\r\n\r\n"];
  const { frame, ctx } = await S.sealRequest({ appKey: pubOf(skR), appId, runtimeId: rid, nonce, request, chunked: true }, await keyPair(skE));
  const chunks = [...parts.map((p) => ({ type: S.CHUNK.DATA, pt: te.encode(p) })), { type: S.CHUNK.FIN, pt: new Uint8Array(0) }];
  const stream = await S.sealStreamForTest(ctx, rn, chunks);
  const aborted = await S.sealStreamForTest(ctx, rn, [chunks[0], chunks[1], { type: S.CHUNK.ABORT, pt: te.encode("the app's response ended with an error") }]);
  return { skR, skE, appId, rid, nonce, rn, request, parts, frame, ctx, stream, aborted };
}

test("the stream cross-language vector and offline fixture (tests/sealed-stream-vectors.json) is what this module computes", async () => {
  const x = await streamVector();
  const v = { note: "SEALED-STREAMING.md: generated by test/pvm-sealed.test.mjs from the seeds sha256('pvm-sealed-vector <name>'). The VM side (tests/sealed.rs) must open `frame` with skR and seal `parts` (then an empty FIN) under responseNonce to exactly `stream`, and the ABORT variant to `aborted`. A reader opens `stream` offline with enc + exported (the HPKE-exported 'chunked response' value) + nonce + responseNonce, or re-derives the secret from skE/skR.",
              skR: hex(x.skR), pkR: hex(pubOf(x.skR)), skE: hex(x.skE), enc: hex(x.ctx.enc), exported: hex(x.ctx.secret), appId: hex(x.appId), runtimeId: hex(x.rid),
              nonce: hex(x.nonce), request: x.request, frame: hex(x.frame), responseNonce: hex(x.rn), parts: x.parts,
              abortReason: "the app's response ended with an error", stream: hex(x.stream), aborted: hex(x.aborted) };
  const file = new URL("sealed-stream-vectors.json", VEC);
  if (process.env.WRITE_SEALED_VECTORS) fs.writeFileSync(file, JSON.stringify(v, null, 1) + "\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), v);
  // and the VM's side in JS opens the frame
  const o = await vmOpen(x.skR, x.frame, x.appId, x.rid);
  assert.equal(td.decode(o.pt), x.request); assert.equal(hex(o.ctx.secret), hex(x.ctx.secret));
});

// ---- the reader against every agreed adversarial case ----
const parse = (stream) => {   // the stream's framing, for the attacks: header + [{ type, raw }]
  const head = stream.subarray(0, 17), chunks = []; let p = 17;
  while (p < stream.length) { const vl = 1 << (stream[p + 1] >> 6); let len = stream[p + 1] & 0x3f; for (let k = 1; k < vl; k++) len = len * 256 + stream[p + 1 + k]; chunks.push(stream.subarray(p, p + 1 + vl + len)); p += 1 + vl + len; }
  return { head, chunks };
};
const join = (head, chunks) => new Uint8Array(Buffer.concat([head, ...chunks]));
async function read(ctx, bytes, pieces = 7) {   // feed in awkward pieces: framing must not depend on read boundaries
  const got = []; const src = (async function* () { for (let i = 0; i < bytes.length; i += pieces) yield bytes.subarray(i, i + pieces); })();
  const v = await S.openStream(ctx, src, { onData: (d) => got.push(td.decode(d)) });
  return { ...v, text: got.join("") };
}

test("stream reader: whole, split anywhere; every agreed attack refused with its class, plaintext only after each tag", async () => {
  const x = await streamVector(), ctx = x.ctx, whole = x.parts.join("");
  for (const n of [1, 3, 7, 64, 100000]) { const r = await read(ctx, x.stream, n); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.complete, true); assert.equal(r.text, whole); }
  const { head, chunks } = parse(x.stream);
  const cls = async (bytes, error, re, c = ctx) => { const r = await read(c, bytes); assert.equal(r.ok, false); assert.equal(r.complete, false); assert.equal(r.error, error, JSON.stringify(r)); if (re) assert.match(r.detail, re); return r; };
  // order: swap, duplicate, drop, splice from another stream, restarted index
  await cls(join(head, [chunks[1], chunks[0], ...chunks.slice(2)]), "tamper", /chunk 0/);
  await cls(join(head, [chunks[0], chunks[0], ...chunks.slice(1)]), "tamper", /chunk 1/);
  await cls(join(head, [chunks[0], ...chunks.slice(2)]), "tamper", /chunk 1/);
  const other = await S.sealStreamForTest(ctx, new Uint8Array(16).fill(9), x.parts.map((p) => ({ type: 0, pt: te.encode(p) })).concat([{ type: 1, pt: new Uint8Array(0) }]));
  await cls(join(head, [chunks[0], parse(other).chunks[1], ...chunks.slice(2)]), "tamper", /chunk 1/);                     // spliced from a stream under another rn
  const restarted = await S.sealStreamForTest(ctx, x.rn, [{ type: 0, pt: te.encode(x.parts[0]) }, { type: 0, pt: te.encode(x.parts[0]) }]);
  await cls(join(head, [chunks[0], ...parse(restarted).chunks.slice(0, 1)]), "tamper", /chunk 1/);                          // index restarted at 0
  // replay: the whole stream, or only its FIN, under another request (fresh enc) -- and the same stream under another evidence nonce
  const fresh = await S.sealRequest({ appKey: pubOf(x.skR), appId: x.appId, runtimeId: x.rid, nonce: x.nonce, request: x.request, chunked: true });
  const fo = await vmOpen(x.skR, fresh.frame, x.appId, x.rid);
  await cls(x.stream, "tamper", /chunk 0/, fresh.ctx);
  const freshStream = await S.sealStreamForTest(fo.ctx, x.rn, [{ type: 0, pt: te.encode(x.parts[0]) }, { type: 1, pt: new Uint8Array(0) }]);
  await cls(join(head, [chunks[0], ...chunks.slice(1)]), "tamper", /chunk 0/, fresh.ctx);                                // x's chunks under the fresh request
  await cls(join(parse(freshStream).head, [parse(freshStream).chunks[0], chunks.at(-1)]), "tamper", /chunk 1/, fresh.ctx); // x's FIN on fresh
  await cls(x.stream, "tamper", /chunk 0/, { ...ctx, nonce: new Uint8Array(32).fill(1) });                                 // another evidence nonce
  // truncation: before FIN (at a chunk boundary, mid-chunk, and with nothing), and a relay-forged FIN
  const t1 = await cls(join(head, chunks.slice(0, 3)), "truncated", /no FIN/);
  assert.equal(t1.text, x.parts.slice(0, 3).join(""), "what arrived before the cut is an authentic prefix, never called complete");
  await cls(x.stream.subarray(0, x.stream.length - 5), "truncated");
  await cls(head, "truncated", /before any chunk/);
  await cls(join(head, [...chunks.slice(0, 2), Uint8Array.of(1, 16, ...new Uint8Array(16))]), "tamper", /chunk 2/);
  // framing: oversized length, zero-length data chunk, a short chunk, an unknown type, trailing bytes after FIN
  await cls(join(head, [Uint8Array.of(0, 0x80, 0, 0x80, 0)]), "oversize", /refused, never truncated/);
  await cls(join(head, [Uint8Array.of(0, 16, ...new Uint8Array(16))]), "malformed", /empty data chunk/);
  await cls(join(head, [Uint8Array.of(0, 5, 1, 2, 3, 4, 5)]), "malformed", /shorter than a tag/);
  await cls(join(head, [Uint8Array.of(3, 16, ...new Uint8Array(16))]), "malformed", /unknown type/);
  await cls(join(head, [...chunks, Uint8Array.of(0)]), "trailing", /after the FIN/);
  await cls(join(head, [...chunks, chunks[0]]), "trailing", /after the FIN/);
  // single-bit flips: ciphertext, tag, the type (FIN flag on a middle chunk), the response nonce, the length prefix
  const flip = (u, at) => { const c = u.slice(); c[at] ^= 1; return c; };
  await cls(join(head, [chunks[0], flip(chunks[1], 5), ...chunks.slice(2)]), "tamper", /chunk 1/);
  await cls(join(head, [chunks[0], flip(chunks[1], chunks[1].length - 1), ...chunks.slice(2)]), "tamper", /chunk 1/);
  await cls(join(head, [chunks[0], flip(chunks[1], 0), ...chunks.slice(2)]), "tamper", /chunk 1/);                          // type 0 -> 1
  await cls(join(flip(head, 3), chunks), "tamper", /chunk 0/);
  const r = await read(ctx, join(head, [chunks[0], flip(chunks[1], 1), ...chunks.slice(2)]));
  assert.equal(r.ok, false); assert.equal(r.complete, false);
  // a chunk re-encrypted under the relay's own key
  const relayCtx = { ...ctx, secret: new Uint8Array(16).fill(5) };
  const relay = await S.sealStreamForTest(relayCtx, x.rn, [{ type: 0, pt: te.encode(x.parts[0]) }, { type: 0, pt: te.encode("evil") }]);
  await cls(join(head, [chunks[0], parse(relay).chunks[1]]), "tamper", /chunk 1/);
  // the VM's authenticated ABORT: a failed answer, its prefix authentic but never complete; bytes after it refused
  const ab = await read(ctx, x.aborted);
  assert.equal(ab.ok, false); assert.equal(ab.complete, false); assert.equal(ab.error, "aborted"); assert.match(ab.detail, /authenticated\): the app's response ended with an error/);
  assert.equal(ab.text, x.parts.slice(0, 2).join(""));
  await cls(join(parse(x.aborted).head, [...parse(x.aborted).chunks, chunks[2]]), "trailing", /after the ABORT/);
  // the unauthenticated pre-stream refusal, and cancellation by the caller after chunk k
  const rf = await read(ctx, Uint8Array.of(1, ...te.encode("replayed request: refused before it runs")));
  assert.equal(rf.error, "refused"); assert.match(rf.detail, /unauthenticated hint\): replayed/);
  const ac = new AbortController(); const seen = [];
  const src = (async function* () { yield join(head, chunks.slice(0, 2)); ac.abort(); yield join(new Uint8Array(0), chunks.slice(2)); })();
  const cv = await S.openStream(ctx, src, { signal: ac.signal, onData: (d) => seen.push(td.decode(d)) });
  assert.equal(cv.error, "cancelled"); assert.equal(cv.complete, false); assert.equal(seen.join(""), x.parts.slice(0, 2).join(""), "nothing released after the abort");
  // a cancel raised by a released chunk (the page saw enough) stops the chunks already buffered behind it
  const ac2 = new AbortController(), seen2 = [];
  const cv2 = await S.openStream(ctx, (async function* () { yield x.stream; })(), { signal: ac2.signal, onData: (d) => { seen2.push(td.decode(d)); if (seen2.length === 2) ac2.abort(); } });
  assert.equal(cv2.error, "cancelled"); assert.equal(seen2.length, 2, "chunks behind the cancel are not released");
});

test("the HTTP stream parser: NDJSON lines as they arrive, completeness only at the chunked terminator, bounded", async () => {
  const lines = []; const p = S.httpStream({ onLine: (l) => lines.push(l) });
  const all = te.encode("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n6\r\n{\"a\":1\r\n3\r\n}\n{\r\n7\r\n\"b\":2}\n\r\n0\r\n\r\n");
  for (let i = 0; i < all.length; i += 3) p.push(all.subarray(i, i + 3));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']); assert.equal(p.end().complete, true);
  const q = S.httpStream(); q.push(te.encode("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n6\r\n{\"a\":1\r\n")); assert.equal(q.end().complete, false);
  assert.throws(() => S.httpStream().push(new Uint8Array(20000)), /head exceeds/);
  const z = S.httpStream(); z.push(te.encode("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n"));
  assert.throws(() => z.push(te.encode("20000\r\n" + "x".repeat(70000))), /exceeds 64 KiB/);
});
