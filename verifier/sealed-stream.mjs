// verifier/sealed-stream.mjs: the CONSUMER's reader for a streamed sealed answer from a pVM (the pVM owner's
// SEALED-STREAMING.md at pvm-cpu/portable-runtime 36f040d1, recorded in docs/security/pvm-sealed-streaming-review.md).
//
// Written from the protocol text, not from the owner's reader (which the differential test runs beside this one).
// No cryptography of ours: HKDF-SHA256 and AES-128-GCM from node:crypto. No HPKE here: the client's own HPKE sender
// context yields `secret` (Export("enclave-pvm-sealed-http/v1 chunked response", 16)) and `enc`; the fixture supplies them.
//
// Two layers, kept apart on purpose:
//   openSealedResponse({ admission, pinned, ctx, evidenceAt, now })  the POLICY layer: refuses to read a byte unless the
//     consumer gate RELEASED for a browser client with an application-layer key (verifier/admission.mjs), the pinned
//     key is the one the request was sealed to, and the sealed window has not lapsed on the client's clock;
//   readSealedStream(ctx, source, { onData, signal })                  the WIRE layer: the state machine of the protocol.
// Outcomes are distinct and never confused: { status: "complete" } only after an authenticated FIN opened;
// "aborted" for an authenticated ABORT (an authentic PREFIX, never an answer); "incomplete" when the stream ended
// without FIN or ABORT; "refused" for the VM's unauthenticated pre-stream hint; "rejected" for anything the reader
// refused (tamper | oversize | malformed | trailing) and for policy; "cancelled" when the caller aborted. Plaintext is
// handed out only after its chunk's tag verified, strictly in index order; `prefix` is exactly that plaintext.
import { createDecipheriv, hkdfSync, timingSafeEqual } from "node:crypto";

export const LABEL = "enclave-pvm-sealed-http/v1";
export const CHUNK_AAD_LABEL = "enclave-pvm-sealed-chunk-v1";
export const CHUNK = Object.freeze({ DATA: 0, FIN: 1, ABORT: 2 });
export const CHUNK_PLAINTEXT_MAX = 16384, TAG = 16, MAX_CHUNK_CT = CHUNK_PLAINTEXT_MAX + TAG, ABORT_REASON_MAX = 256;
export const MAX_CHUNKS = 2 ** 20, MAX_STREAM_BYTES = 16 << 20, MAX_HINT_BYTES = 300;
export const MAX_BUFFER = 1 + 8 + MAX_CHUNK_CT + 64 * 1024;   // one chunk (type, varint, ct) plus what one carrier read may add

export class SealedStreamError extends Error { constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; this.detail = detail; } }

const be64 = (i) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(i)); return b; };
export function responseKeys(ctx, rn) {
  const salt = Buffer.concat([ctx.enc, rn]);
  return { key: Buffer.from(hkdfSync("sha256", ctx.secret, salt, Buffer.from("key"), 16)), base: Buffer.from(hkdfSync("sha256", ctx.secret, salt, Buffer.from("nonce"), 12)) };
}
export function chunkNonce(base, i) { const n = Buffer.from(base); const c = be64(i); for (let k = 0; k < 8; k++) n[4 + k] ^= c[k]; return n; }
export function chunkAad(nonce, rn, i, type) { return Buffer.concat([Buffer.from(CHUNK_AAD_LABEL), nonce, rn, be64(i), Buffer.from([type])]); }
// QUIC variable-length integer (RFC 9000 section 16): returns { value, size } or null when more bytes are needed
export function readVarint(b, off) {
  if (off >= b.length) return null;
  const size = 1 << (b[off] >> 6); if (off + size > b.length) return null;
  let v = b[off] & 0x3f; for (let k = 1; k < size; k++) v = v * 256 + b[off + k];
  return { value: v, size };
}
export function encodeVarint(v) {
  if (v < 64) return Buffer.from([v]); if (v < 16384) return Buffer.from([0x40 | (v >> 8), v & 255]);
  if (v < 2 ** 30) return Buffer.from([0x80 | (v >>> 24), (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v) | 0xc000000000000000n); return b;
}
function openChunk(keys, ctx, rn, i, type, ct) {
  if (ct.length < TAG) throw new SealedStreamError("malformed", `chunk ${i} is shorter than a tag`);
  const d = createDecipheriv("aes-128-gcm", keys.key, chunkNonce(keys.base, i), { authTagLength: TAG });
  d.setAAD(chunkAad(ctx.nonce, rn, i, type)); d.setAuthTag(ct.subarray(ct.length - TAG));
  try { return Buffer.concat([d.update(ct.subarray(0, ct.length - TAG)), d.final()]); }
  catch { throw new SealedStreamError("tamper", `chunk ${i} does not open under this request's keys (altered, reordered, duplicated, dropped, spliced, replayed, or not this VM's)`); }
}

function checkCtx(ctx) {
  if (!ctx || !Buffer.isBuffer(ctx.enc) || ctx.enc.length !== 32) throw new SealedStreamError("policy", "ctx.enc must be the request's 32-byte encapsulated key");
  if (!Buffer.isBuffer(ctx.secret) || ctx.secret.length !== 16) throw new SealedStreamError("policy", "ctx.secret must be the 16-byte exported chunked-response secret");
  if (!Buffer.isBuffer(ctx.nonce) || ctx.nonce.length !== 32) throw new SealedStreamError("policy", "ctx.nonce must be the 32-byte evidence nonce");
}

// readSealedStream(ctx, source, { onData, signal }) -> outcome. `source` is a Buffer or an (async) iterable of byte pieces.
export async function readSealedStream(ctx, source, { onData = () => {}, signal = null } = {}) {
  checkCtx(ctx);
  const prefix = [];
  let buf = Buffer.alloc(0), state = "status", keys = null, rn = null, i = 0, bytes = 0, aborted = null;
  const base = () => ({ chunks: i, bytes, prefix: Buffer.concat(prefix) });
  const outcome = (status, extra = {}) => ({ status, complete: status === "complete", ...base(), ...extra });
  const rejected = (e) => outcome("rejected", { error: e.code, detail: e.detail });
  const release = (pt) => { prefix.push(pt); bytes += pt.length; onData(pt); };
  const step = () => {   // consume what is buffered; returns an outcome, or null for "need more"
    for (;;) {
      if (state === "status") {
        if (!buf.length) return null;
        if (buf[0] === 0x01) { state = "hint"; buf = buf.subarray(1); continue; }
        if (buf[0] !== 0x00) throw new SealedStreamError("malformed", `the answer starts with 0x${buf[0].toString(16)}, not a sealed stream`);
        buf = buf.subarray(1); state = "rn"; continue;
      }
      if (state === "hint") { if (buf.length > MAX_HINT_BYTES) throw new SealedStreamError("malformed", "the refusal hint exceeds 300 bytes"); return null; }
      if (state === "rn") { if (buf.length < 16) return null; rn = Buffer.from(buf.subarray(0, 16)); buf = buf.subarray(16); keys = responseKeys(ctx, rn); state = "chunk"; continue; }
      if (state === "ended") { if (buf.length) throw new SealedStreamError("trailing", `${buf.length} byte(s) after the ${aborted ? "ABORT" : "FIN"}`); return null; }
      // state chunk
      if (buf.length < 2) return null;
      const type = buf[0];
      if (type !== CHUNK.DATA && type !== CHUNK.FIN && type !== CHUNK.ABORT) throw new SealedStreamError("malformed", `chunk ${i} has unknown type ${type}`);
      const vi = readVarint(buf, 1); if (!vi) return null;
      const len = vi.value;
      if (len > MAX_CHUNK_CT) throw new SealedStreamError("oversize", `chunk ${i} claims ${len} bytes (at most ${MAX_CHUNK_CT}): refused, never truncated`);
      if (len < TAG) throw new SealedStreamError("malformed", `chunk ${i} is ${len} bytes: shorter than a tag`);
      if (type === CHUNK.DATA && len === TAG) throw new SealedStreamError("malformed", `chunk ${i} is an empty data chunk`);
      if (type === CHUNK.ABORT && len > ABORT_REASON_MAX + TAG) throw new SealedStreamError("oversize", `abort chunk ${i} exceeds ${ABORT_REASON_MAX} bytes of reason`);
      if (i >= MAX_CHUNKS) throw new SealedStreamError("oversize", `more than ${MAX_CHUNKS} chunks`);
      const need = 1 + vi.size + len; if (buf.length < need) return null;
      const ct = buf.subarray(1 + vi.size, need); buf = buf.subarray(need);
      const pt = openChunk(keys, ctx, rn, i, type, ct);   // throws tamper
      i++;
      if (bytes + pt.length > MAX_STREAM_BYTES) throw new SealedStreamError("oversize", "the stream exceeds 16 MiB of plaintext");
      if (type === CHUNK.DATA) { release(pt); continue; }
      if (type === CHUNK.FIN) { if (pt.length) release(pt); state = "ended"; continue; }
      aborted = pt.toString("utf8"); state = "ended"; continue;   // ABORT: an authentic prefix, never an answer
    }
  };
  const pieces = Buffer.isBuffer(source) || source instanceof Uint8Array ? [Buffer.from(source)] : source;
  try {
    for await (const piece of pieces) {
      if (signal?.aborted) return outcome("cancelled", { error: "cancelled", detail: `the caller aborted after ${i} chunk(s); nothing after it is released` });
      const p = Buffer.from(piece);
      if (buf.length + p.length > MAX_BUFFER) throw new SealedStreamError("oversize", "the carrier sent more than one chunk ahead of the reader");
      buf = buf.length ? Buffer.concat([buf, p]) : p;
      const v = step(); if (v) return v;
    }
  } catch (e) {
    if (e instanceof SealedStreamError) return rejected(e);
    if (signal?.aborted || e?.name === "AbortError") return outcome("cancelled", { error: "cancelled", detail: "the caller aborted" });
    return outcome("incomplete", { error: "truncated", detail: `the carrier failed: ${e.message}` });
  }
  try { const v = step(); if (v) return v; } catch (e) { if (e instanceof SealedStreamError) return rejected(e); throw e; }
  if (state === "ended") return aborted !== null ? outcome("aborted", { error: "aborted", detail: `the VM aborted the answer (authenticated): ${aborted}`, reason: aborted }) : outcome("complete");
  if (state === "hint") return outcome("refused", { error: "refused", detail: `the VM refused before any sealed byte (unauthenticated hint): ${buf.toString("utf8")}` });
  return outcome("incomplete", { error: "truncated", detail: state === "chunk" && i > 0 ? `the stream ended after ${i} chunk(s) with no FIN or ABORT: INCOMPLETE` : "the stream ended before any chunk: INCOMPLETE" });
}

// The policy layer. `admission` is the consumer gate's result for a BROWSER client (verifier/admission.mjs admit()):
// it must have released, with an application-layer key and a sealed window; `pinned.appKey` must be the key the request
// was sealed to (`sealedTo`, hex); `evidenceAt` is when the client's evidence exchange happened; `now` is the client's clock.
// Nothing is read from the stream before these hold. A native client on TLS pinning does not come through here.
export async function openSealedResponse({ admission, ctx, sealedTo, evidenceAt, now = Date.now(), source, onData, signal }) {
  const policy = (detail) => ({ status: "rejected", complete: false, error: "policy", detail, chunks: 0, bytes: 0, prefix: Buffer.alloc(0) });
  if (!admission || admission.decision !== "release") return policy(`the consumer gate did not release (${admission?.reasons?.at(-1) || "no admission result"}): no sealed request should have been sent, and no answer is read`);
  const pinned = admission.pinned || {};
  if (typeof pinned.appKey !== "string" || !/^[0-9a-f]{64}$/.test(pinned.appKey)) return policy("the gate released without an application-layer key (a native TLS-pinned client?): a sealed stream is the browser path and needs the pinned app key");
  if (typeof sealedTo !== "string" || sealedTo.toLowerCase() !== pinned.appKey) return policy("the request was sealed to a key that is not the pinned app key");
  if (!pinned.sealed || !Number.isInteger(pinned.sealed.windowSeconds)) return policy("the gate's pinned output carries no sealed window: not v2 evidence");
  const at = evidenceAt instanceof Date ? evidenceAt.getTime() : Number(evidenceAt);
  if (!Number.isFinite(at)) return policy("evidenceAt (when the evidence exchange happened) is required");
  if (now - at > pinned.sealed.windowSeconds * 1000) return policy(`the sealed window (${pinned.sealed.windowSeconds} s from the evidence exchange) lapsed on the client's clock: re-attest, do not send`);
  try { checkCtx(ctx); } catch (e) { return policy(e.detail); }
  return readSealedStream(ctx, source, { onData, signal });
}
