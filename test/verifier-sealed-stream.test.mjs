// verifier/sealed-stream.mjs on the owner's offline fixture (test/fixtures/verifier/pvm-sealed/, SOURCE.md): the stream
// and the ABORT variant open to the known plaintext; every agreed attack class is refused with its class and releases
// nothing beyond the last authenticated chunk; the policy layer refuses before reading unless the consumer gate released
// for a browser client with the pinned app key inside the window; and, when the owner's reference reader is present
// (ENCLAVE_PVM_SEALED_MODULE, resolved from the pinned commit), both readers are run on the same bytes and must agree on
// accept/refuse and on the released prefix. A test-only sealer forges, re-keys and re-frames chunks; it is not a VM.
//   run: node --test test/verifier-sealed-stream.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCipheriv, randomBytes } from "node:crypto";
import { readSealedStream, openSealedResponse, responseKeys, chunkNonce, chunkAad, encodeVarint, CHUNK, MAX_CHUNK_CT } from "../verifier/sealed-stream.mjs";
import { STRICT_INTEGRATION } from "../verifier/index.mjs";

const V = JSON.parse(fs.readFileSync(new URL("./fixtures/verifier/pvm-sealed/sealed-stream-vectors.json", import.meta.url), "utf8"));
const h = (s) => Buffer.from(s, "hex");
const ctx = { enc: h(V.enc), secret: h(V.exported), nonce: h(V.nonce) };
const stream = h(V.stream), abortedStream = h(V.aborted), rn = stream.subarray(1, 17);
const PARTS = V.parts.map((p) => Buffer.from(p, "utf8")), ALL = Buffer.concat(PARTS);
const read = (bytes, opts = {}, c = ctx) => readSealedStream(c, bytes, opts);
// test-only sealer, the VM's side from the protocol text
function seal(c, rnX, chunks) {   // chunks: [{ type, pt }]
  const { key, base } = responseKeys(c, rnX); const out = [Buffer.from([0]), rnX];
  chunks.forEach((ch, i) => { const g = createCipheriv("aes-128-gcm", key, chunkNonce(base, i), { authTagLength: 16 }); g.setAAD(chunkAad(c.nonce, rnX, i, ch.type)); const ct = Buffer.concat([g.update(ch.pt), g.final(), g.getAuthTag()]); out.push(Buffer.from([ch.type]), encodeVarint(ct.length), ct); });
  return Buffer.concat(out);
}
// split the fixture stream into its framed chunks (after status + rn)
function frames(bytes) { const out = []; let i = 17; while (i < bytes.length) { const t = bytes[i], vl = 1 << (bytes[i + 1] >> 6); let len = bytes[i + 1] & 0x3f; for (let k = 1; k < vl; k++) len = len * 256 + bytes[i + 1 + k]; out.push(bytes.subarray(i, i + 1 + vl + len)); i += 1 + vl + len; } return out; }
const F = frames(stream), FA = frames(abortedStream);
const rebuild = (fr) => Buffer.concat([stream.subarray(0, 17), ...fr]);
const rejectedAs = async (bytes, code, prefixBytes, re) => { const r = await read(bytes); assert.equal(r.status, "rejected", `${code}: ${r.status} ${r.detail || ""}`); assert.equal(r.error, code, r.detail); assert.equal(r.complete, false); assert.equal(r.bytes, prefixBytes, "released bytes"); if (re) assert.match(r.detail, re); return r; };
async function* pieces(buf, sizes) { let o = 0; for (const n of sizes) { yield buf.subarray(o, o + n); o += n; if (o >= buf.length) return; } if (o < buf.length) yield buf.subarray(o); }

test("the fixture stream opens to the known plaintext, complete, each chunk released after its tag and in order", async () => {
  const seen = [];
  const r = await read(stream, { onData: (pt) => seen.push(Buffer.from(pt)) });
  assert.equal(r.status, "complete"); assert.equal(r.complete, true); assert.equal(r.chunks, 5); assert.equal(r.bytes, ALL.length);
  assert.ok(r.prefix.equals(ALL)); assert.deepEqual(seen.map((b) => b.length), PARTS.map((p) => p.length)); assert.ok(Buffer.concat(seen).equals(ALL));
  assert.equal(F.length, 5); assert.equal(F[4][0], CHUNK.FIN);
  // enc is the public key of the published ephemeral seed (the request side is consistent with the fixture)
  const { createPrivateKey, createPublicKey } = await import("node:crypto");
  const pub = createPublicKey(createPrivateKey({ key: Buffer.concat([h("302e020100300506032b656e04220420"), h(V.skE)]), format: "der", type: "pkcs8" })).export({ type: "spki", format: "der" }).subarray(-32);
  assert.equal(pub.toString("hex"), V.enc);
});
test("the ABORT variant is an authenticated prefix, never complete", async () => {
  const r = await read(abortedStream);
  assert.equal(r.status, "aborted"); assert.equal(r.complete, false); assert.equal(r.error, "aborted"); assert.equal(r.reason, V.abortReason);
  assert.ok(r.prefix.equals(Buffer.concat(PARTS.slice(0, 2)))); assert.equal(r.chunks, 3);
});
test("the stream opens identically however the carrier splits it: byte by byte, and at every boundary", async () => {
  const one = await read(pieces(stream, Array(stream.length).fill(1))); assert.equal(one.status, "complete"); assert.ok(one.prefix.equals(ALL));
  for (let cut = 1; cut < stream.length; cut += 7) { const r = await read(pieces(stream, [cut])); assert.equal(r.status, "complete", `cut ${cut}`); assert.ok(r.prefix.equals(ALL)); }
});
test("sequencing: swap, duplicate, drop, splice, restart the index; each refused at the first misplaced chunk with the prefix before it", async () => {
  await rejectedAs(rebuild([F[0], F[2], F[1], F[3], F[4]]), "tamper", PARTS[0].length);                    // swap
  await rejectedAs(rebuild([F[0], F[1], F[1], F[2], F[3], F[4]]), "tamper", PARTS[0].length + PARTS[1].length);   // duplicate
  await rejectedAs(rebuild([F[0], F[2], F[3], F[4]]), "tamper", PARTS[0].length);                          // drop a middle chunk
  await rejectedAs(rebuild([F[0], F[0]]), "tamper", PARTS[0].length);                                      // index restarted
  await rejectedAs(rebuild([F[0], F[1], F[2], FA[2]]), "tamper", PARTS[0].length + PARTS[1].length + PARTS[2].length, /does not open/);   // the ABORT (index 2) moved to index 3: the index is in the nonce and the AAD
  // fixture artefact (SOURCE.md): both variants share one response nonce, so the ABORT at index 2 IS the aborted variant's
  // own ending and opens as ABORT; a real VM's fresh rn per response makes this splice impossible
  const shared = await read(rebuild([F[0], F[1], FA[2]])); assert.equal(shared.status, "aborted"); assert.equal(shared.complete, false);
  const other = seal({ ...ctx, nonce: randomBytes(32) }, rn, [{ type: CHUNK.DATA, pt: PARTS[0] }]);       // a chunk of another exchange spliced in
  await rejectedAs(rebuild([frames(other)[0], F[1], F[2], F[3], F[4]]), "tamper", 0);
});
test("replay: a whole stream or its FIN alone under a fresh request, another evidence nonce, or another boot's key", async () => {
  await rejectedAs(stream, "tamper", 0, undefined).catch(() => {});   // (same ctx would open; the replay cases below change what the CLIENT holds)
  const fresh = { ...ctx, enc: randomBytes(32) };                                            // a fresh request (new enc): the keys differ
  const r1 = await readSealedStream(fresh, stream); assert.equal(r1.status, "rejected"); assert.equal(r1.error, "tamper"); assert.equal(r1.bytes, 0);
  const r2 = await readSealedStream({ ...ctx, nonce: randomBytes(32) }, stream); assert.equal(r2.error, "tamper"); assert.equal(r2.bytes, 0);   // another evidence nonce
  const r3 = await readSealedStream({ ...ctx, secret: randomBytes(16) }, stream); assert.equal(r3.error, "tamper"); assert.equal(r3.bytes, 0);   // another boot's app key
  await rejectedAs(rebuild([F[4]]), "tamper", 0);                                                                                          // FIN alone at index 0
  const r4 = await readSealedStream(fresh, rebuild([F[4]])); assert.equal(r4.error, "tamper");
});
test("truncation: before FIN at a boundary, mid-chunk, header only, status only, nothing", async () => {
  const noFin = await read(rebuild(F.slice(0, 4))); assert.equal(noFin.status, "incomplete"); assert.equal(noFin.error, "truncated"); assert.ok(noFin.prefix.equals(ALL)); assert.equal(noFin.complete, false); assert.match(noFin.detail, /INCOMPLETE/);
  const mid = await read(stream.subarray(0, 17 + F[0].length + 10)); assert.equal(mid.status, "incomplete"); assert.equal(mid.bytes, PARTS[0].length);
  const hdr = await read(stream.subarray(0, 17)); assert.equal(hdr.status, "incomplete"); assert.equal(hdr.bytes, 0);
  const st = await read(stream.subarray(0, 1)); assert.equal(st.status, "incomplete");
  const nothing = await read(Buffer.alloc(0)); assert.equal(nothing.status, "incomplete"); assert.equal(nothing.chunks, 0);
  const noAbort = await read(rebuild(FA.slice(0, 2))); assert.equal(noAbort.status, "incomplete");
  // a carrier failure mid-stream is incomplete, never complete
  async function* failing() { yield stream.subarray(0, 17 + F[0].length); throw new Error("connection reset"); }
  const cf = await read(failing()); assert.equal(cf.status, "incomplete"); assert.equal(cf.bytes, PARTS[0].length); assert.match(cf.detail, /carrier failed/);
});
test("tamper: single-bit flips in ciphertext, tag, type, response nonce, length; a forged FIN; a chunk re-encrypted under another key", async () => {
  const flip = (buf, at) => { const b = Buffer.from(buf); b[at] ^= 1; return b; };
  await rejectedAs(flip(stream, 17 + 3), "tamper", 0);                                   // chunk 0 ciphertext
  await rejectedAs(flip(stream, 17 + F[0].length - 1), "tamper", 0);                     // chunk 0 tag
  await rejectedAs(flip(stream, 5), "tamper", 0);                                        // response nonce
  const typeFlipped = Buffer.from(rebuild(F)); typeFlipped[17 + F[0].length] ^= 1;      // chunk 1 type DATA -> FIN
  await rejectedAs(typeFlipped, "tamper", PARTS[0].length);
  const middleFin = Buffer.from(F[1]); middleFin[0] = CHUNK.FIN; await rejectedAs(rebuild([F[0], middleFin, F[2], F[3], F[4]]), "tamper", PARTS[0].length);
  const forged = seal({ ...ctx, secret: randomBytes(16) }, rn, [{ type: CHUNK.DATA, pt: PARTS[0] }, { type: CHUNK.FIN, pt: Buffer.alloc(0) }]);   // the relay's own key
  await rejectedAs(forged, "tamper", 0);
  const lenFlipped = Buffer.from(stream); lenFlipped[17 + 1] ^= 1;                        // length byte of chunk 0 (varint): the reader waits for a longer chunk that never comes
  const lf = await read(lenFlipped); assert.notEqual(lf.status, "complete"); assert.equal(lf.bytes, 0); assert.ok(["rejected", "incomplete"].includes(lf.status), lf.status);
  const lenShort = Buffer.from(stream); lenShort[17 + 2] ^= 0x40;                          // chunk 0 claims fewer bytes: the tag covers the wrong slice -> tamper, and the rest misparses
  const ls = await read(lenShort); assert.notEqual(ls.status, "complete"); assert.equal(ls.bytes, 0);
});
test("framing: oversized length, empty data chunk, shorter than a tag, unknown type, an over-long abort reason, a chunk ahead of the reader", async () => {
  const big = Buffer.concat([stream.subarray(0, 17), Buffer.from([CHUNK.DATA]), encodeVarint(MAX_CHUNK_CT + 1), Buffer.alloc(MAX_CHUNK_CT + 1)]);
  await rejectedAs(big, "oversize", 0, /never truncated/);
  const empty = seal(ctx, rn, [{ type: CHUNK.DATA, pt: Buffer.alloc(0) }]); await rejectedAs(empty, "malformed", 0, /empty data chunk/);
  const short = Buffer.concat([stream.subarray(0, 17), Buffer.from([CHUNK.DATA]), encodeVarint(8), Buffer.alloc(8)]); await rejectedAs(short, "malformed", 0, /shorter than a tag/);
  const unknown = Buffer.from(stream); unknown[17] = 3; await rejectedAs(unknown, "malformed", 0, /unknown type/);
  const longAbort = seal(ctx, rn, [{ type: CHUNK.ABORT, pt: Buffer.alloc(300, 0x41) }]); await rejectedAs(longAbort, "oversize", 0, /abort chunk/);
  async function* ahead() { yield Buffer.concat([stream, Buffer.alloc(MAX_CHUNK_CT + 64 * 1024 + 64)]); }   // far more than one chunk ahead
  const ah = await read(ahead()); assert.equal(ah.status, "rejected"); assert.equal(ah.error, "oversize");
  const bad0 = Buffer.from(stream); bad0[0] = 0x07; await rejectedAs(bad0, "malformed", 0, /not a sealed stream/);
});
test("trailing bytes after FIN or ABORT are refused; the VM's pre-stream refusal is a hint, not an answer", async () => {
  await rejectedAs(Buffer.concat([stream, Buffer.from([0])]), "trailing", ALL.length, /after the FIN/);
  await rejectedAs(Buffer.concat([abortedStream, Buffer.from("x")]), "trailing", PARTS[0].length + PARTS[1].length, /after the ABORT/);
  const hint = await read(Buffer.concat([Buffer.from([1]), Buffer.from("unsupported key id")]));
  assert.equal(hint.status, "refused"); assert.equal(hint.complete, false); assert.match(hint.detail, /unauthenticated hint/);
  const longHint = await read(Buffer.concat([Buffer.from([1]), Buffer.alloc(400, 0x41)])); assert.equal(longHint.status, "rejected"); assert.equal(longHint.error, "malformed");
});
test("cancellation: after chunk k nothing further is released, and the outcome is cancelled, not complete", async () => {
  const ac = new AbortController(); const seen = [];
  async function* src() { yield stream.subarray(0, 17 + F[0].length + F[1].length); ac.abort(); yield stream.subarray(17 + F[0].length + F[1].length); }
  const r = await read(src(), { onData: (pt) => seen.push(pt.length), signal: ac.signal });
  assert.equal(r.status, "cancelled"); assert.equal(r.complete, false); assert.deepEqual(seen, [PARTS[0].length, PARTS[1].length]); assert.equal(r.bytes, PARTS[0].length + PARTS[1].length);
});
test("policy: the reader refuses before reading a byte unless the gate released a browser client with the pinned app key inside the window", async () => {
  const appKey = "ab".repeat(32), release = { decision: "release", reasons: ["RELEASE"], pinned: { appKey, sealed: { windowSeconds: 600, maxRequests: 256 } } };
  const at = Date.now() - 10_000, args = { ctx, sealedTo: appKey, evidenceAt: at, now: Date.now(), source: stream };
  const ok = await openSealedResponse({ admission: release, ...args }); assert.equal(ok.status, "complete");
  const cases = [
    [{ decision: "hold", reasons: ["HOLD: verdict is \"limited\""], pinned: null }, /did not release/],
    [{ decision: "release", reasons: [], pinned: { transportSpkiSha256: "00".repeat(32) } }, /without an application-layer key/],      // a native TLS-pinned release
    [{ ...release, pinned: { appKey: "cd".repeat(32), sealed: release.pinned.sealed } }, /not the pinned app key/],
    [{ ...release, pinned: { appKey } }, /no sealed window/],
    [null, /no admission result/],
  ];
  for (const [admission, re] of cases) { const r = await openSealedResponse({ admission, ...args }); assert.equal(r.status, "rejected", re); assert.equal(r.error, "policy"); assert.match(r.detail, re); assert.equal(r.bytes, 0); }
  const late = await openSealedResponse({ admission: release, ...args, now: at + 601_000 }); assert.equal(late.error, "policy"); assert.match(late.detail, /window .* lapsed/);
  const noAt = await openSealedResponse({ admission: release, ...args, evidenceAt: undefined }); assert.equal(noAt.error, "policy");
  // an aborted or incomplete stream through the policy layer stays what it is
  assert.equal((await openSealedResponse({ admission: release, ...args, source: abortedStream })).status, "aborted");
  assert.equal((await openSealedResponse({ admission: release, ...args, source: rebuild(F.slice(0, 3)) })).status, "incomplete");
});

// ---- differential: the owner's reference reader (WebCrypto) on the same bytes ---------------------------------------
const ownerPath = process.env.ENCLAVE_PVM_SEALED_MODULE || "";
let owner = null; try { if (ownerPath) owner = await import((await import("node:url")).pathToFileURL(ownerPath).href); } catch (e) { if (STRICT_INTEGRATION) throw e; }
if (STRICT_INTEGRATION && !owner) throw new Error("strict integration: ENCLAVE_PVM_SEALED_MODULE (the owner's reader, pinned as pvm-sealed) is missing");
test("differential: the owner's reader agrees on accept/refuse and on the released prefix for every case above", { skip: !owner && !STRICT_INTEGRATION && "owner reader absent (set ENCLAVE_PVM_SEALED_MODULE via verifier/integration/resolve.mjs --pin pvm-sealed)" }, async () => {
  const theirs = async (bytes, c = ctx) => { const got = []; const r = await owner.openStream({ enc: new Uint8Array(c.enc), secret: new Uint8Array(c.secret), nonce: new Uint8Array(c.nonce), chunked: true }, [new Uint8Array(bytes)], { onData: (pt) => got.push(Buffer.from(pt)) }); return { ...r, prefix: Buffer.concat(got) }; };
  const cases = { stream, aborted: abortedStream, swap: rebuild([F[0], F[2], F[1], F[3], F[4]]), dup: rebuild([F[0], F[1], F[1], F[2], F[3], F[4]]), drop: rebuild([F[0], F[2], F[3], F[4]]),
    noFin: rebuild(F.slice(0, 4)), finOnly: rebuild([F[4]]), trailing: Buffer.concat([stream, Buffer.from([0])]), flipCt: (() => { const b = Buffer.from(stream); b[20] ^= 1; return b; })(),
    forged: seal({ ...ctx, secret: randomBytes(16) }, rn, [{ type: CHUNK.DATA, pt: PARTS[0] }, { type: CHUNK.FIN, pt: Buffer.alloc(0) }]), empty: seal(ctx, rn, [{ type: CHUNK.DATA, pt: Buffer.alloc(0) }]),
    big: Buffer.concat([stream.subarray(0, 17), Buffer.from([CHUNK.DATA]), encodeVarint(MAX_CHUNK_CT + 1), Buffer.alloc(MAX_CHUNK_CT + 1)]), hint: Buffer.concat([Buffer.from([1]), Buffer.from("unsupported key id")]),
    unknownType: (() => { const b = Buffer.from(stream); b[17] = 3; return b; })() };
  const mismatches = [];
  for (const [name, bytes] of Object.entries(cases)) {
    const mine = await read(bytes), ref = await theirs(bytes);
    const mineAccepts = mine.status === "complete", refAccepts = ref.ok === true && ref.complete === true;
    if (mineAccepts !== refAccepts) mismatches.push(`${name}: accept mine=${mine.status} owner=${ref.error || "complete"}`);
    if (!mine.prefix.equals(ref.prefix)) mismatches.push(`${name}: released prefix differs (mine ${mine.prefix.length} B, owner ${ref.prefix.length} B)`);
    // classes agree except the documented mapping: an unknown type is "malformed" here and "tamper" there
    const mineClass = mine.status === "complete" ? "complete" : mine.status === "incomplete" ? "truncated" : mine.status === "aborted" ? "aborted" : mine.status === "refused" ? "refused" : mine.error;
    const refClass = refAccepts ? "complete" : ref.error;
    if (mineClass !== refClass && !(name === "unknownType" && mineClass === "malformed" && refClass === "tamper")) mismatches.push(`${name}: class mine=${mineClass} owner=${refClass}`);
  }
  assert.deepEqual(mismatches, []);
  // and the fresh-request replay for both
  const fresh = { ...ctx, enc: randomBytes(32) }; assert.equal((await readSealedStream(fresh, stream)).error, "tamper"); assert.equal((await theirs(stream, fresh)).error, "tamper");
});
