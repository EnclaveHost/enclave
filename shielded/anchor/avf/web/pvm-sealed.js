// pvm-sealed.js -- the BROWSER channel's encryption (PVM-CPU.md, "The browser channel"; SEALED-STREAMING.md; LAB, not
// production). A page cannot see a TLS peer's certificate, so it encrypts each HTTP request to the VM's app key (an X25519
// key made in the VM, vouched for by the attested transport key in v2 evidence: pvm-verify.js) and only that VM can read it
// or answer it. No cryptography of ours: HPKE is @hpke/core (vendor/, pinned and integrity-checked by build-hpke.sh), the
// rest is WebCrypto (HKDF-SHA256, AES-128-GCM).
//   - request: HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM, one seal;
//       info = LABEL [" chunked"] " request" || 0x00 || hdr || AppID || RuntimeID, aad = the evidence nonce;
//       hdr key id 0 = the whole response at once, 1 = the response streamed (the key id is inside info: flipping it breaks
//       the request);
//   - whole response (RFC 9458 section 4.4): secret = Export(LABEL " response", 16), response nonce rn (16), key and nonce
//       by HKDF(salt = enc || rn), AES-128-GCM over the HTTP/1.1 response;
//   - streamed response (SEALED-STREAMING.md): secret = Export(LABEL " chunked response", 16), the same key/base derivation,
//       then chunks `type || quicvarint(len) || ct`, chunk i under nonce = base XOR be96(i) and aad = CHUNK_AAD_LABEL ||
//       evidence nonce || rn || be64(i) || type; type 0 data, 1 FIN, 2 ABORT; exactly one FIN or ABORT ends it.
// Frame to the VM: u32 length (big endian) || nonce(32) || hdr(7) || enc(32) || ct. Answer: 0x00 || rn || (ct | chunks), or
// 0x01 || a reason (unauthenticated: a hint; any refusal means fetch fresh evidence -- never re-send a ciphertext).
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes128Gcm } from "./vendor/hpke-core-1.9.0.js";
import { cat, fromHex, toHex } from "./pvm-verify.js";

export const LABEL = "enclave-pvm-sealed-http/v1";
export const HDR = Uint8Array.of(0x00, 0x00, 0x20, 0x00, 0x01, 0x00, 0x01);
export const HDR_CHUNKED = Uint8Array.of(0x01, 0x00, 0x20, 0x00, 0x01, 0x00, 0x01);
export const CHUNK = { DATA: 0, FIN: 1, ABORT: 2 };
export const CHUNK_AAD_LABEL = "enclave-pvm-sealed-chunk-v1";
export const CHUNK_PLAINTEXT = 16384, MAX_CHUNK_CT = CHUNK_PLAINTEXT + 16, MAX_CHUNKS = 2 ** 20, MAX_STREAM_BYTES = 16 << 20;
const te = new TextEncoder(), td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
export const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
const b = (x) => (typeof x === "string" ? fromHex(x) : x);

export const requestInfo = (appId, runtimeId, chunked = false) =>
  cat(te.encode(`${LABEL}${chunked ? " chunked" : ""} request`), Uint8Array.of(0), chunked ? HDR_CHUNKED : HDR, b(appId), b(runtimeId));

/** Encrypt one HTTP/1.1 request to the VM: { frame (to send), ctx (to open the answer) }. `ekm` is for test vectors only. */
export async function sealRequest({ appKey, appId, runtimeId, nonce, request, chunked = false }, ekm = undefined) {
  const pkR = b(appKey), a = b(appId), r = b(runtimeId), n = b(nonce);
  if (pkR.length !== 32 || a.length !== 32 || r.length !== 32 || n.length !== 32) throw new Error("appKey, appId, runtimeId and nonce are 32 bytes each");
  const pt = typeof request === "string" ? te.encode(request) : request;
  const recipientPublicKey = await suite.kem.deserializePublicKey(pkR);
  const sender = await suite.createSenderContext({ recipientPublicKey, info: requestInfo(a, r, chunked), ...(ekm ? { ekm } : {}) });
  const ct = new Uint8Array(await sender.seal(pt, n));
  const enc = new Uint8Array(sender.enc);
  const secret = new Uint8Array(await sender.export(te.encode(`${LABEL}${chunked ? " chunked" : ""} response`), 16));
  const body = cat(n, chunked ? HDR_CHUNKED : HDR, enc, ct);
  const frame = cat(Uint8Array.of(body.length >>> 24, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255), body);
  return { frame, ctx: { enc, secret, nonce: n, chunked } };
}

/** The response key (AES-128-GCM) and base nonce: HKDF-SHA256(salt = enc || rn, ikm = secret), info "key" / "nonce". */
export async function responseKeys(ctx, rn, usage = "decrypt") {
  const ikm = await subtle().importKey("raw", ctx.secret, "HKDF", false, ["deriveBits"]);
  const salt = cat(ctx.enc, rn);
  const kb = new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("key") }, ikm, 128));
  const base = new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("nonce") }, ikm, 96));
  return { key: await subtle().importKey("raw", kb, "AES-GCM", false, [usage]), base };
}
const gcm = async (op, key, iv, data, aad) =>
  new Uint8Array(await subtle()[op]({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, data));

/** Open the VM's whole answer: { ok: true, response (bytes) } or { ok: false, refused }. */
export async function openResponse(ctx, bytes) {
  const x = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (ctx.chunked) return { ok: false, refused: "a chunked request's answer is a stream: openStream" };
  if (!x.length) return { ok: false, refused: "no answer (the carrier gave nothing)" };
  if (x[0] === 1) return { ok: false, refused: `the VM refused (unauthenticated hint): ${td.decode(x.subarray(1, 300))}` };
  if (x[0] !== 0 || x.length < 1 + 16 + 16) return { ok: false, refused: "the answer is not a sealed response" };
  const rn = x.subarray(1, 17), { key, base } = await responseKeys(ctx, rn);
  try { return { ok: true, response: await gcm("decrypt", key, base, x.subarray(17), new Uint8Array(0)) }; }
  catch { return { ok: false, refused: "the answer does not open under this request's keys (tampered, or not from the VM)" }; }
}

// ---- streamed responses ----
export function chunkNonce(base, i) {
  const n = base.slice(), c = new DataView(new ArrayBuffer(8)); c.setBigUint64(0, BigInt(i));
  for (let k = 0; k < 8; k++) n[4 + k] ^= c.getUint8(k);
  return n;
}
export function chunkAad(nonce, rn, i, type) {
  const c = new DataView(new ArrayBuffer(8)); c.setBigUint64(0, BigInt(i));
  return cat(te.encode(CHUNK_AAD_LABEL), nonce, rn, new Uint8Array(c.buffer), Uint8Array.of(type));
}
export function varint(v) {   // QUIC variable-length integer (RFC 9000 section 16)
  if (v < 64) return Uint8Array.of(v);
  if (v < 16384) return Uint8Array.of(0x40 | (v >> 8), v & 255);
  if (v < 2 ** 30) return Uint8Array.of(0x80 | (v >>> 24), (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const d = new DataView(new ArrayBuffer(8)); d.setBigUint64(0, BigInt(v) | 0xc000000000000000n); return new Uint8Array(d.buffer);
}

/**
 * Read a streamed answer. `source` is an async iterable of byte chunks (a fetch body reader, or arrays in tests). Each
 * chunk's plaintext is handed to `onData` only after its tag verifies, strictly in order. Returns one verdict:
 *   { ok: true, complete: true, chunks, bytes }                       -- a FIN opened: the answer is whole
 *   { ok: false, complete: false, error, detail, chunks, bytes }     -- error is one of
 *       refused (the VM's unauthenticated pre-stream hint) | truncated (the stream ended with no FIN or ABORT) |
 *       aborted (an authenticated ABORT: the VM said the answer failed; what came before is an authentic prefix only) |
 *       tamper (a chunk did not open: altered, reordered, duplicated, dropped, spliced, replayed, or another key) |
 *       oversize | malformed (framing: an unknown type, a chunk shorter than a tag, an empty data chunk) |
 *       trailing (bytes after FIN) | cancelled (the caller aborted)
 * Buffering is bounded: at most one chunk (16 KiB + 16 + 9) is held.
 */
export async function openStream(ctx, source, { onData = () => {}, signal } = {}) {
  let buf = new Uint8Array(0), state = "status", keys = null, rn = null, i = 0, bytes = 0, end = null;
  const out = (o) => ({ chunks: i, bytes, complete: false, ...o });
  const fail = (error, detail) => { end = out({ ok: false, error, detail }); return end; };
  const step = async () => {   // consume what is buffered; returns a verdict, or null for "need more"
    for (;;) {
      if (state === "status") {
        if (!buf.length) return null;
        if (buf[0] === 1) { state = "refusal"; continue; }
        if (buf[0] !== 0) return fail("malformed", "the answer is not a sealed stream");
        buf = buf.subarray(1); state = "rn"; continue;
      }
      if (state === "refusal") { if (buf.length > 300) return fail("refused", `the VM refused (unauthenticated hint): ${td.decode(buf.subarray(1, 300))}`); return null; }
      if (state === "rn") {
        if (buf.length < 16) return null;
        rn = buf.slice(0, 16); buf = buf.subarray(16); keys = await responseKeys(ctx, rn); state = "chunk"; continue;
      }
      if (state === "done" || state === "aborted") return buf.length ? fail("trailing", `${buf.length} bytes after the ${state === "done" ? "FIN" : "ABORT"}`) : null;
      if (signal && signal.aborted) return fail("cancelled", "the caller aborted");   // nothing is released after a cancel
      // state chunk: type(1) || varint(len) || ct(len)
      if (buf.length < 2) return null;
      const type = buf[0];
      if (type > 2) return fail("malformed", `chunk ${i} has an unknown type ${type}`);
      const vl = 1 << (buf[1] >> 6);
      if (buf.length < 1 + vl) return null;
      let len = buf[1] & 0x3f;
      for (let k = 1; k < vl; k++) len = len * 256 + buf[1 + k];
      if (len > MAX_CHUNK_CT) return fail("oversize", `chunk ${i} claims ${len} bytes (at most ${MAX_CHUNK_CT}): refused, never truncated`);
      if (len < 16) return fail("malformed", `chunk ${i} is ${len} bytes: shorter than a tag`);
      if (type === CHUNK.DATA && len === 16) return fail("malformed", `chunk ${i} is an empty data chunk`);
      if (type === CHUNK.ABORT && len > 256 + 16) return fail("oversize", `abort chunk ${i} too long`);
      if (i >= MAX_CHUNKS) return fail("oversize", "too many chunks");
      if (buf.length < 1 + vl + len) return null;
      const ct = buf.slice(1 + vl, 1 + vl + len); buf = buf.subarray(1 + vl + len);
      let pt;
      try { pt = await gcm("decrypt", keys.key, chunkNonce(keys.base, i), ct, chunkAad(ctx.nonce, rn, i, type)); }
      catch { return fail("tamper", `chunk ${i} does not open under this request's keys (altered, reordered, duplicated, dropped, spliced, replayed, or not the VM's)`); }
      i++; bytes += pt.length;
      if (bytes > MAX_STREAM_BYTES) return fail("oversize", "the stream exceeds 16 MiB");
      if (type === CHUNK.DATA) onData(pt);
      else if (type === CHUNK.FIN) { if (pt.length) onData(pt); state = "done"; }
      else { state = "aborted"; end = out({ ok: false, error: "aborted", detail: `the VM aborted the answer (authenticated): ${td.decode(pt)}` }); }
    }
  };
  try {
    for await (const piece of source) {
      if (signal && signal.aborted) return fail("cancelled", "the caller aborted");
      if (buf.length + piece.length > MAX_CHUNK_CT + 9 + 300 + 64 * 1024) return fail("oversize", "the carrier sent more than one chunk ahead");
      buf = buf.length ? cat(buf, piece) : piece;
      const v = await step();
      if (v && v.error !== "aborted") return v;
    }
  } catch (e) {
    if ((signal && signal.aborted) || e.name === "AbortError") return fail("cancelled", "the caller aborted");
    return fail("truncated", `the carrier failed: ${e.message}`);
  }
  const v = await step();
  if (v && v.error !== "aborted") return v;
  if (state === "done") return out({ ok: true, complete: true });
  if (state === "aborted") return end;
  if (state === "refusal") return fail("refused", `the VM refused (unauthenticated hint): ${td.decode(buf.subarray(1, 300))}`);
  return fail("truncated", state === "chunk" && i > 0 ? `the stream ended after ${i} chunks with no FIN: INCOMPLETE` : "the stream ended before any chunk: INCOMPLETE");
}

/** Seal a whole response or a stream as the VM does -- TESTS and the fake VM only (the VM's own is pvm-rt sealed.rs). */
export async function sealResponseForTest(ctx, response, rn) {
  const { key, base } = await responseKeys(ctx, rn, "encrypt");
  return cat(Uint8Array.of(0), rn, await gcm("encrypt", key, base, response, new Uint8Array(0)));
}
export async function sealStreamForTest(ctx, rn, chunks) {   // chunks: [{ type, pt }] in order
  const { key, base } = await responseKeys(ctx, rn, "encrypt");
  const parts = [Uint8Array.of(0), rn];
  for (const [i, c] of chunks.entries()) {
    const ct = await gcm("encrypt", key, chunkNonce(base, i), c.pt, chunkAad(ctx.nonce, rn, i, c.type));
    parts.push(Uint8Array.of(c.type), varint(ct.length), ct);
  }
  return cat(...parts);
}

/** A GET/POST as HTTP/1.1 bytes. */
export function httpRequest(method, path, body = null, headers = {}) {
  if (!/^\/[\x21-\x7e]*$/.test(path)) throw new Error("path must be an origin-form path");
  const x = body == null ? null : typeof body === "string" ? te.encode(body) : body;
  let h = `${method} ${path} HTTP/1.1\r\nhost: pvm-app\r\nconnection: close\r\n`;
  for (const [k, v] of Object.entries(headers)) { if (!/^[a-z0-9-]+$/i.test(k) || /[\r\n]/.test(v)) throw new Error("bad header"); h += `${k}: ${v}\r\n`; }
  if (x) h += `content-length: ${x.length}\r\n`;
  return x ? cat(te.encode(h + "\r\n"), x) : te.encode(h + "\r\n");
}
const crlf = (x, from) => { for (let i = from; i + 1 < x.length; i++) if (x[i] === 13 && x[i + 1] === 10) return i; return -1; };
/** A whole HTTP/1.1 response (content-length, chunked, or to the end). */
export function parseHttpResponse(bytes) {
  let i = -1;
  for (let p = 0; p + 3 < bytes.length; p++) if (bytes[p] === 13 && bytes[p + 1] === 10 && bytes[p + 2] === 13 && bytes[p + 3] === 10) { i = p; break; }
  if (i < 0) throw new Error("no HTTP header");
  const head = td.decode(bytes.subarray(0, i)), m = /^HTTP\/1\.1 (\d{3})/.exec(head);
  if (!m) throw new Error("not an HTTP/1.1 response");
  let body = bytes.subarray(i + 4);
  if (/\r\ntransfer-encoding: *chunked/i.test(head)) {
    const parts = []; let p = 0;
    for (;;) {
      const j = crlf(body, p); if (j < 0) throw new Error("truncated chunked body");
      const n = parseInt(td.decode(body.subarray(p, j)).split(";")[0], 16);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("bad chunk size");
      if (!n) break;
      if (j + 2 + n > body.length) throw new Error("truncated chunk");
      parts.push(body.subarray(j + 2, j + 2 + n)); p = j + 2 + n + 2;
    }
    body = cat(...parts);
  } else {
    const cl = /\r\ncontent-length: *(\d+)/i.exec(head);
    if (cl) { if (body.length < +cl[1]) throw new Error("truncated body"); body = body.subarray(0, +cl[1]); }
  }
  return { status: Number(m[1]), head, body: td.decode(body), bytes: body };
}

/**
 * An HTTP/1.1 response parsed as it arrives (the plaintext of a streamed answer): `push(bytes)` hands each complete body
 * line (split on "\n") to onLine; `end()` says whether the HTTP message itself was complete (chunked terminator or
 * content-length reached). Bounded: a 16 KiB head, 64 KiB per line.
 */
export function httpStream({ onHead = () => {}, onLine = () => {} } = {}) {
  let head = null, raw = new Uint8Array(0), chunked = false, need = null, line = new Uint8Array(0), done = false, left = null;
  const body = (x) => {
    let s = 0;
    for (let k = 0; k < x.length; k++) if (x[k] === 10) { const l = cat(line, x.subarray(s, k)); line = new Uint8Array(0); s = k + 1; onLine(td.decode(l)); }
    line = cat(line, x.subarray(s));
    if (line.length > 64 * 1024) throw new Error("a body line exceeds 64 KiB");
  };
  const pump = () => {
    for (;;) {
      if (done) { if (raw.length) throw new Error("bytes after the HTTP message"); return; }
      if (!head) {
        let i = -1;
        for (let p = 0; p + 3 < raw.length; p++) if (raw[p] === 13 && raw[p + 1] === 10 && raw[p + 2] === 13 && raw[p + 3] === 10) { i = p; break; }
        if (i < 0) { if (raw.length > 16384) throw new Error("HTTP head exceeds 16 KiB"); return; }
        const h = td.decode(raw.subarray(0, i)), m = /^HTTP\/1\.1 (\d{3})/.exec(h);
        if (!m) throw new Error("not an HTTP/1.1 response");
        head = { status: Number(m[1]), head: h }; raw = raw.subarray(i + 4);
        chunked = /\r\ntransfer-encoding: *chunked/i.test(h);
        const cl = /\r\ncontent-length: *(\d+)/i.exec(h); left = cl ? Number(cl[1]) : null;
        onHead(head); continue;
      }
      if (!chunked) {
        if (left == null) { body(raw); raw = new Uint8Array(0); return; }
        const n = Math.min(left, raw.length); body(raw.subarray(0, n)); left -= n; raw = raw.subarray(n); if (!left) done = true; return;
      }
      if (need == null) {
        const j = crlf(raw, 0); if (j < 0) { if (raw.length > 64) throw new Error("bad chunk header"); return; }
        const n = parseInt(td.decode(raw.subarray(0, j)).split(";")[0], 16);
        if (!Number.isSafeInteger(n) || n < 0) throw new Error("bad chunk size");
        raw = raw.subarray(j + 2);
        if (!n) { if (raw.length < 2) { raw = cat(Uint8Array.of(48, 13, 10), raw); return; } raw = raw.subarray(2); done = true; continue; }
        need = n; continue;
      }
      if (raw.length < need + 2) { if (raw.length > need) return; body(raw); need -= raw.length; raw = new Uint8Array(0); return; }
      body(raw.subarray(0, need)); raw = raw.subarray(need + 2); need = null;
    }
  };
  return {
    push(x) { raw = raw.length ? cat(raw, x) : x; pump(); },
    end() { if (line.length) { onLine(td.decode(line)); line = new Uint8Array(0); } return { head, complete: done || (!chunked && left == null && !!head) }; },
  };
}
export { toHex };
