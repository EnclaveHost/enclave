// pvm-sealed.js -- the BROWSER channel's encryption (PVM-CPU.md, "The browser channel"; LAB, not production), on
// WebCrypto alone. A page cannot see a TLS peer's certificate, so it cannot pin the VM's TLS key; instead it encrypts each
// HTTP request to the VM's app key -- an X25519 key made in the VM, vouched for by the attested transport key in v2
// evidence (pvm-verify.js) -- and only the VM can read it or answer it:
//   - HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM, single shot;
//     info = LABEL " request" || 0x00 || hdr || AppID || RuntimeID  (hdr = key_id 0, kem 0x0020, kdf 0x0001, aead 0x0001),
//     aad  = the evidence nonce the page verified (the VM accepts a request only under a nonce it answered this boot,
//            for SEALED_WINDOW_SECONDS and SEALED_MAX_REQUESTS, each (nonce, enc) once);
//   - the response as in Oblivious HTTP (RFC 9458 section 4.4): secret = Export(LABEL " response", 16), a 16-byte
//     response nonce, salt = enc || response nonce, key/nonce by HKDF, AES-128-GCM;
//   - the plaintext is an HTTP/1.1 message (not RFC 9292 binary HTTP: the VM feeds it to the same hyper server as TLS).
// Frame to the VM (through any carrier): u32 length (big endian) || nonce(32) || hdr(7) || enc(32) || ciphertext.
// Frame back: 0x00 || response nonce(16) || ciphertext, or 0x01 || a reason (UTF-8, unauthenticated: a hint only; any
// refusal means fetch fresh evidence and encrypt again -- never re-send a ciphertext).
import { cat, fromHex, toHex } from "./pvm-verify.js";

export const LABEL = "enclave-pvm-sealed-http/v1";
export const HDR = Uint8Array.of(0x00, 0x00, 0x20, 0x00, 0x01, 0x00, 0x01);
const te = new TextEncoder(), td = new TextDecoder();
const KEM_SUITE = cat(te.encode("KEM"), Uint8Array.of(0x00, 0x20));
const HPKE_SUITE = cat(te.encode("HPKE"), HDR.subarray(1));
const subtle = () => globalThis.crypto.subtle;
const X25519_PKCS8 = fromHex("302e020100300506032b656e04220420");   // RFC 8410: a 32-byte private key follows

async function hmac(key, data) {
  const k = await subtle().importKey("raw", key.length ? key : new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", k, data));
}
export const extract = (salt, ikm) => hmac(salt, ikm);   // RFC 5869; an empty salt is HashLen zeros (HMAC pads either way)
export async function expand(prk, info, len) {
  const out = new Uint8Array(len); let t = new Uint8Array(0);
  for (let i = 1, o = 0; o < len; i++) { t = await hmac(prk, cat(t, info, Uint8Array.of(i))); out.set(t.subarray(0, Math.min(32, len - o)), o); o += 32; }
  return out;
}
const i2osp2 = (n) => Uint8Array.of(n >> 8, n & 255);
const labeledExtract = (suite, salt, label, ikm) => extract(salt, cat(te.encode("HPKE-v1"), suite, te.encode(label), ikm));
const labeledExpand = (suite, prk, label, info, len) => expand(prk, cat(i2osp2(len), te.encode("HPKE-v1"), suite, te.encode(label), info), len);

/** DHKEM(X25519) Encap: { enc, shared }. `skE` (32 bytes) only for test vectors; otherwise a fresh ephemeral key. */
export async function encap(pkR, skE = null) {
  const eph = skE ? { privateKey: await subtle().importKey("pkcs8", cat(X25519_PKCS8, skE), { name: "X25519" }, false, ["deriveBits"]), publicKey: null }
                  : await subtle().generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const enc = skE ? null : new Uint8Array(await subtle().exportKey("raw", eph.publicKey));
  const peer = await subtle().importKey("raw", pkR, { name: "X25519" }, false, []);
  const dh = new Uint8Array(await subtle().deriveBits({ name: "X25519", public: peer }, eph.privateKey, 256));   // throws on an all-zero result
  return { dh, enc };
}
async function kemShared(dh, enc, pkR) {
  const prk = await labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dh);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", cat(enc, pkR), 32);
}
/** HPKE base-mode key schedule: { key, baseNonce, exporterSecret }. */
export async function keySchedule(shared, info) {
  const pskIdHash = await labeledExtract(HPKE_SUITE, new Uint8Array(0), "psk_id_hash", new Uint8Array(0));
  const infoHash = await labeledExtract(HPKE_SUITE, new Uint8Array(0), "info_hash", info);
  const ctx = cat(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = await labeledExtract(HPKE_SUITE, shared, "secret", new Uint8Array(0));
  return { key: await labeledExpand(HPKE_SUITE, secret, "key", ctx, 16), baseNonce: await labeledExpand(HPKE_SUITE, secret, "base_nonce", ctx, 12),
           exporterSecret: await labeledExpand(HPKE_SUITE, secret, "exp", ctx, 32) };
}
export const exportSecret = (exporterSecret, context, len) => labeledExpand(HPKE_SUITE, exporterSecret, "sec", context, len);
async function gcm(op, key, iv, data, aad = new Uint8Array(0)) {
  const k = await subtle().importKey("raw", key, { name: "AES-GCM" }, false, [op]);
  return new Uint8Array(await subtle()[op]({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, k, data));
}
/** HPKE SetupBaseS + one Seal (sequence 0). `test` = { skE, pkE } for RFC vectors only. */
export async function sealBase(pkR, info, aad, pt, test = null) {
  const { dh, enc: e } = await encap(pkR, test && test.skE);
  const enc = e || test.pkE;
  const ks = await keySchedule(await kemShared(dh, enc, pkR), info);
  return { enc, ct: await gcm("encrypt", ks.key, ks.baseNonce, pt, aad), exporterSecret: ks.exporterSecret, ks };
}

export const requestInfo = (appId, runtimeId) => cat(te.encode(`${LABEL} request`), Uint8Array.of(0), HDR, appId, runtimeId);

/** Encrypt one HTTP/1.1 request to the VM: { frame (to send), ctx (to open the answer) }. */
export async function sealRequest({ appKey, appId, runtimeId, nonce, request }, test = null) {
  const pkR = typeof appKey === "string" ? fromHex(appKey) : appKey;
  const a = typeof appId === "string" ? fromHex(appId) : appId, r = typeof runtimeId === "string" ? fromHex(runtimeId) : runtimeId;
  const n = typeof nonce === "string" ? fromHex(nonce) : nonce;
  if (pkR.length !== 32 || a.length !== 32 || r.length !== 32 || n.length !== 32) throw new Error("appKey, appId, runtimeId and nonce are 32 bytes each");
  const pt = typeof request === "string" ? te.encode(request) : request;
  const s = await sealBase(pkR, requestInfo(a, r), n, pt, test);
  const body = cat(n, HDR, s.enc, s.ct);
  const frame = cat(Uint8Array.of(body.length >>> 24, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255), body);
  return { frame, ctx: { enc: s.enc, exporterSecret: s.exporterSecret } };
}
/** Open the VM's answer: { ok: true, response (bytes) } or { ok: false, refused }. */
export async function openResponse(ctx, bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!b.length) return { ok: false, refused: "no answer (the carrier gave nothing)" };
  if (b[0] === 1) return { ok: false, refused: `the VM refused (unauthenticated hint): ${td.decode(b.subarray(1, 300))}` };
  if (b[0] !== 0 || b.length < 1 + 16 + 16) return { ok: false, refused: "the answer is not a sealed response" };
  const rn = b.subarray(1, 17), secret = await exportSecret(ctx.exporterSecret, te.encode(`${LABEL} response`), 16);
  const prk = await extract(cat(ctx.enc, rn), secret);
  const key = await expand(prk, te.encode("key"), 16), iv = await expand(prk, te.encode("nonce"), 12);
  try { return { ok: true, response: await gcm("decrypt", key, iv, b.subarray(17)) }; }
  catch { return { ok: false, refused: "the answer does not open under this request's keys (tampered, or not from the VM)" }; }
}
/** Seal a response as the VM does (tests only: the VM's own is runtime/pvm-rt sealed.rs). */
export async function sealResponseForTest(ctx, response, rn) {
  const secret = await exportSecret(ctx.exporterSecret, te.encode(`${LABEL} response`), 16);
  const prk = await extract(cat(ctx.enc, rn), secret);
  const key = await expand(prk, te.encode("key"), 16), iv = await expand(prk, te.encode("nonce"), 12);
  return cat(Uint8Array.of(0), rn, await gcm("encrypt", key, iv, response));
}

/** A GET/POST as HTTP/1.1 bytes, and a parsed HTTP/1.1 response (content-length, chunked, or to the end). */
export function httpRequest(method, path, body = null, headers = {}) {
  if (!/^\/[\x21-\x7e]*$/.test(path)) throw new Error("path must be an origin-form path");
  const b = body == null ? null : typeof body === "string" ? te.encode(body) : body;
  let h = `${method} ${path} HTTP/1.1\r\nhost: pvm-app\r\nconnection: close\r\n`;
  for (const [k, v] of Object.entries(headers)) { if (!/^[a-z0-9-]+$/i.test(k) || /[\r\n]/.test(v)) throw new Error("bad header"); h += `${k}: ${v}\r\n`; }
  if (b) h += `content-length: ${b.length}\r\n`;
  return b ? cat(te.encode(h + "\r\n"), b) : te.encode(h + "\r\n");
}
const crlf = (b, from) => { for (let i = from; i + 1 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10) return i; return -1; };
export function parseHttpResponse(bytes) {   // on bytes: chunk sizes count bytes, not characters
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
export { toHex };
