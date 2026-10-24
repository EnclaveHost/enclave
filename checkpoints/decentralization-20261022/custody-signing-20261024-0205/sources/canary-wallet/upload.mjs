// The upload stage, server side. The administrator's wallet signs ONE personal message in the browser; this process
// never holds a key. Every step is journaled (fsynced) BEFORE its side effect:
//   ready --begin--> authorizing {expiry}            the exact message goes to the browser only after this is durable
//   authorizing --signature--> uploading             the signer is recovered and must be the administrator; the
//                                                    signature is used once, in memory, and never written or logged
//   uploading --> stored-verified {cid, fetch}       token from the relay, the ONE pinned file to the gateway, the answer
//                                                    must be the pinned CID, and the bytes fetched back by that CID must
//                                                    hash to the pinned sha256
//   uploading --> pinned-unverified {cid}            the gateway answered the pinned CID but the fetch-back did not verify
//   uploading --> upload-unknown                     the add request was sent and no answer arrived (it may have pinned):
//                                                    /upload/verify-storage (a fetch) moves on ONLY when the bytes verify;
//                                                    any failed fetch (timeout, 5xx, network, even 404) proves nothing and
//                                                    keeps upload-unknown. /upload/retry-same-bytes is the administrator's
//                                                    EXPLICIT choice to authorize the same bytes/CID again while the earlier
//                                                    outcome stays unknown; nothing re-uploads by itself
//   uploading --> ready {lastError}                  a definite refusal BEFORE anything was sent to the gateway
//   uploading --> cid-mismatch {gatewayCid}          TERMINAL: the gateway named another CID; stop and ask root
// A process that stops in "uploading" restarts in "upload-unknown". "authorizing" returns to ready on an explicit
// wallet rejection (4001) or once its expiry has passed; any other wallet error leaves it as it is.
// PRIVACY: no remote response body is ever kept, logged or returned. Upstream errors become a fixed diagnostic plus at
// most an HTTP status (an error body could reflect the submitted signature or token); a CID from the gateway is kept
// only if it has the shape of a CID. Local errors that could echo the signature (recovery) are replaced as well.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { recoverMessageAddress, stringToHex } from "viem";

const lc = (x) => String(x ?? "").toLowerCase();
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const base32 = (buf) => { let bits = 0, v = 0, o = ""; for (const x of buf) { v = ((v << 8) | x) & 0xffff; bits += 8; while (bits >= 5) { o += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) o += B32[(v << (5 - bits)) & 31]; return o; };
/** CIDv1, raw codec, sha2-256: what Kubo's cid-version=1 add gives a file of one chunk (<= 256 KiB). */
export const rawCid = (bytes) => "b" + base32(Buffer.from([0x01, 0x55, 0x12, 0x20, ...createHash("sha256").update(bytes).digest()]));
export const uploadMessage = (sha, expiry) => `enclave-upload:${sha}:${expiry}`;

/** The ONE file: exactly `size` bytes (never more is read), the pinned sha256 and CID. */
export function readComponent(c) {
  const fd = fs.openSync(c.file, "r");
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size !== c.size) throw Error(`the component is ${st.size} bytes, not the pinned ${c.size}`);
    const buf = Buffer.alloc(c.size + 1);
    const n = fs.readSync(fd, buf, 0, c.size + 1, 0);
    if (n !== c.size) throw Error("the component changed size while being read");
    const bytes = buf.subarray(0, c.size);
    if (sha256(bytes) !== c.sha256) throw Error("the component's sha256 is not the pinned one");
    if (rawCid(bytes) !== c.cid) throw Error("the component's CID is not the pinned one");
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** A body capped at `max` bytes (a longer answer is refused, not truncated). */
async function cappedBody(r, max) {
  const len = Number(r.headers.get("content-length") || 0);
  if (len > max) throw Object.assign(Error(`answer of ${len} bytes is over the ${max}-byte cap`), { capped: true });
  const parts = []; let n = 0;
  for await (const ch of r.body) { n += ch.length; if (n > max) throw Object.assign(Error(`answer over the ${max}-byte cap`), { capped: true }); parts.push(Buffer.from(ch)); }
  return Buffer.concat(parts);
}
/** A transport failure as a FIXED phrase (never the error's own text, which may carry request data). */
const netFailure = (e) => (e?.capped ? "was over the size cap" : e?.name === "TimeoutError" || e?.name === "AbortError" ? "timed out" : "could not be reached or the connection failed");
const CID_SHAPE = /^(b[a-z2-7]{20,110}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;

export function uploadStage({ trust, journal, fetchImpl = fetch, now = () => Date.now() }) {
  const U = trust.upload, C = trust.component;
  let state = journal.read();
  if (state.status === "uploading") { state = { ...state, status: "upload-unknown", note: "the process stopped during the upload; verify storage before anything else" }; journal.write(state); }
  const set = (v) => { journal.write(v); state = v; };
  const pub = () => { const { status, expiry, cid, gatewayCid, fetched, lastError, note, uploadedAt, verifiedAt } = state; return { status, expiry, cid, gatewayCid, fetched, lastError, note, uploadedAt, verifiedAt }; };
  const call = (url, init, timeoutMs = U.timeoutMs) => fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });

  /** Fetch the pinned CID back (raw block) and check every byte. -> { bytes, sha256 } or throws. */
  async function fetchBack() {
    let r, b;
    try { r = await call(U.fetchUrl + C.cid + "?format=raw", { headers: { accept: "application/vnd.ipld.raw" } }, U.fetchTimeoutMs ?? U.timeoutMs); }
    catch (e) { throw Object.assign(Error(`the storage fetch ${netFailure(e)}`), { kind: "transient" }); }
    if (!r.ok) throw Object.assign(Error(`the gateway answered HTTP ${r.status} for the CID`), { kind: r.status === 404 ? "not-served" : "transient", status: r.status });
    try { b = await cappedBody(r, C.size); } catch (e) { throw Object.assign(Error(`the storage fetch ${netFailure(e)}`), { kind: e?.capped ? "mismatch" : "transient" }); }
    if (b.length !== C.size || sha256(b) !== C.sha256 || rawCid(b) !== C.cid) throw Object.assign(Error("the bytes served for the CID are not the pinned component"), { kind: "mismatch" });
    return { bytes: b.length, sha256: sha256(b), at: new Date(now()).toISOString() };
  }

  const routes = {
    "/upload/begin": async () => {
      const expired = state.status === "authorizing" && now() / 1000 >= state.expiry;
      if (state.status !== "ready" && !expired) throw Error(`the upload is ${state.status}; it cannot be authorized again now`);
      readComponent(C);                                                         // the file is still exactly the pinned one
      const expiry = Math.floor(now() / 1000) + U.expirySec;
      set({ status: "authorizing", expiry, issuedAt: new Date(now()).toISOString() });   // durable before the browser sees it
      const message = uploadMessage(C.sha256, expiry);
      return { message, messageHex: stringToHex(message), expiry, address: trust.admin };
    },
    "/upload/rejected": async (b) => {
      if (state.status !== "authorizing" || b.code !== 4001) throw Error("only an explicit wallet rejection (4001) resets the authorization");
      set({ status: "ready", note: "the administrator rejected the upload signature" });
      return pub();
    },
    "/upload/signature": async (b) => {
      if (state.status !== "authorizing") throw Error(`the upload is ${state.status}, not awaiting a signature`);
      const sig = String(b.signature || "");
      if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw Error("that is not a 65-byte personal_sign signature");
      if (now() / 1000 > state.expiry - 30) throw Error("the authorization is about to expire or has expired; start the upload again");
      let signer;
      try { signer = lc(await recoverMessageAddress({ message: uploadMessage(C.sha256, state.expiry), signature: sig })); }
      catch { throw Error("the signature could not be recovered; nothing was uploaded"); }   // never the library's text (it may echo the signature)
      // trust.uploadSigner exists ONLY in test fixtures (no real administrator key there); production recovers to trust.admin
      if (signer !== lc(trust.uploadSigner ?? trust.admin)) throw Error("the message was not signed by the administrator account; nothing was uploaded");
      const bytes = readComponent(C), expiry = state.expiry;
      set({ status: "uploading", expiry, startedAt: new Date(now()).toISOString() });   // no signature in the journal
      // 1. the relay's token (a refusal here means nothing reached the gateway). Fixed diagnostics only.
      const refuseBeforeGateway = (why) => { set({ status: "ready", expiry, lastError: why }); return Error(why + "; nothing was uploaded"); };
      let r, tok;
      try { r = await call(U.tokenUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hash: C.sha256, expiry, signature: sig }) }); }
      catch (e) { throw refuseBeforeGateway(`the relay ${netFailure(e)}`); }
      let body;
      try { body = await cappedBody(r, 4096); } catch (e) { throw refuseBeforeGateway(`the relay's answer ${netFailure(e)}`); }
      if (!r.ok) throw refuseBeforeGateway(`the relay refused the authorization (HTTP ${r.status})`);
      try { tok = JSON.parse(body.toString("utf8")); } catch { tok = null; }
      if (!tok || !/^[0-9a-f]{64}$/.test(tok.token || "") || lc(tok.address) !== signer || Number(tok.expiry) !== expiry)
        throw refuseBeforeGateway("the relay's answer is not a token for the administrator and this expiry");
      // 2. the gateway: from here an unanswered request may still have pinned
      try {
        r = await call(U.addUrl, { method: "POST", body: bytes, headers: { "content-type": "application/wasm", "x-upload-address": signer,
          "x-upload-expiry": String(expiry), "x-upload-token": tok.token } }, U.addTimeoutMs ?? U.timeoutMs);
        body = await cappedBody(r, 4096);
      } catch (e) {
        set({ status: "upload-unknown", expiry, lastError: `the gateway's answer ${netFailure(e)}` });
        throw Error("the gateway did not answer; it may have stored the component. Verify storage before anything else.");
      }
      tok = null;
      if (!r.ok) { set({ status: "ready", expiry, lastError: `the gateway refused the upload (HTTP ${r.status})` }); throw Error(state.lastError); }
      let cid; try { cid = JSON.parse(body.toString("utf8")).cid; } catch { cid = null; }
      if (cid !== C.cid) {
        const shown = typeof cid === "string" && CID_SHAPE.test(cid) ? cid : "(an answer that is not a CID)";
        set({ status: "cid-mismatch", expiry, gatewayCid: shown });
        throw Error(`STOP: the gateway answered ${shown}, not the pinned ${C.cid}. Nothing may be published; ask root.`);
      }
      const uploadedAt = new Date(now()).toISOString();
      try { set({ status: "stored-verified", cid, expiry, uploadedAt, fetched: await fetchBack(), verifiedAt: new Date(now()).toISOString() }); }
      catch (e) { set({ status: "pinned-unverified", cid, expiry, uploadedAt, lastError: e.message }); }
      return pub();
    },
    "/upload/verify-storage": async () => {
      if (!["pinned-unverified", "upload-unknown"].includes(state.status)) throw Error(`the upload is ${state.status}; there is nothing to verify`);
      try { set({ ...state, status: "stored-verified", cid: C.cid, fetched: await fetchBack(), verifiedAt: new Date(now()).toISOString(), lastError: undefined, note: undefined }); }
      catch (e) {
        // a failed fetch proves nothing about an earlier upload: the state stays as it was, with an honest reason
        const why = e.kind === "not-served"
          ? `${e.message} just now. That does not prove the earlier upload was not stored (the outcome stays unknown); try again later, or choose to upload the same bytes again`
          : `${e.message}; the outcome stays unknown. Try again later`;
        set({ ...state, lastError: state.status === "upload-unknown" ? why : e.message, checkedAt: new Date(now()).toISOString() });
      }
      return pub();
    },
    "/upload/retry-same-bytes": async (b) => {
      // the administrator's explicit choice: authorize the SAME bytes (same sha256, same CID) again although the earlier
      // upload's outcome is unknown. Nothing is uploaded here; the normal begin/signature steps follow.
      if (state.status !== "upload-unknown") throw Error(`the upload is ${state.status}; a same-bytes retry is only for an unknown outcome`);
      if (b.confirm !== "retry-same-bytes") throw Error("a same-bytes retry needs the explicit confirmation from the page");
      set({ status: "ready", note: "the administrator chose to upload the same bytes again; the earlier upload's outcome was never established", previous: { expiry: state.expiry, lastError: state.lastError } });
      return pub();
    },
  };
  /** Publishing needs the stored, verified component, re-fetched NOW (not only the journal's word). */
  async function gate() {
    if (state.status !== "stored-verified") return `the component is not stored and verified yet (upload ${state.status})`;
    try { await fetchBack(); return null; } catch (e) { return `the stored component did not verify just now: ${e.message}`; }
  }
  return { routes, gate, status: pub, get state() { return state; }, fetchBack };
}
