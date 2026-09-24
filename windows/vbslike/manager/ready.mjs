// ready.mjs - is a domain RUNNING? The one place that decides it, and it is deliberately hard to
// satisfy.
//
// `running` means both of these, on ONE TLS session and ONE key:
//   1. the domain served an attestation document that judge-hv accepts as monitor-signed, bound to
//      THIS handshake's key and a nonce we chose this second, for the app we expect; and
//   2. the domain answered GET /.well-known/enclave-ready 200 with a readiness DOCUMENT that says
//      ready:true for that same appId.
//
// Anything else is `starting` (before the deadline) or `failed`. Console bytes are not readiness, a
// started partition is not readiness, and an app answering 200 is not readiness.
//
// THE TRAP THIS IS BUILT AROUND (enclave-99, measured on the box 2026-09-24). On an initrd where
// /.well-known/enclave-ready does not exist, the request fell through the proxy to the APP, which
// answered 200 with its own body - "Hello World!\n". A rule that read `status === 200` as ready
// would have promoted the app's own greeting to `running`. Worse, the same rule makes an app that
// 404s unknown paths permanently unready. So a bare 200 is NEVER enough: the body must parse as
// the readiness document, say ready:true, and name the appId we asked about. A 200 that does not
// is a FAILURE with the body quoted, not a retry, because the domain is answering something and
// that something is wrong.
//
// NOTHING HERE SAYS ATTESTED. judge-hv's verdict on a T0-hv partition is "monitor-signed", the
// host is not excluded, and no chain is verified. `running` is an operational statement about one
// domain, never a security claim about the boundary.
import tls from "node:tls";
import crypto from "node:crypto";
import { judge } from "../verify/judge-hv.mjs";

const NONCE_LEN = 32;

/** One TLS session, reused for every request, so the document and the readiness answer share a key. */
function connect({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false, servername: host }, () => {
      const cert = sock.getPeerX509Certificate ? sock.getPeerX509Certificate() : null;
      const spki = cert ? cert.publicKey.export({ type: "spki", format: "der" }) : null;
      if (!spki) { sock.destroy(); return reject(new Error("the domain presented no usable public key")); }
      resolve({ sock, spki });
    });
    sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error(`no TLS session within ${timeoutMs} ms`)); });
    sock.on("error", reject);
  });
}

/** A minimal HTTP/1.1 GET over an OPEN socket, so every request rides the session we verified. */
function get(sock, host, path, { timeoutMs = 10_000, maxBytes = 1 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; cleanup(); fn(v); } };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > maxBytes) return finish(reject, new Error(`answer over the ${maxBytes}-byte cap`));
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const head = buf.subarray(0, sep).toString("latin1");
      const status = Number((head.split("\r\n")[0] || "").split(" ")[1]);
      const len = /content-length:\s*(\d+)/i.exec(head);
      const body = buf.subarray(sep + 4);
      if (len && body.length < Number(len[1])) return;      // still arriving
      if (!len && !/connection:\s*close/i.test(head)) return; // no framing we can use yet
      finish(resolve, { status, body });
    };
    const onEnd = () => {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return finish(reject, new Error("the domain closed before sending headers"));
      const head = buf.subarray(0, sep).toString("latin1");
      finish(resolve, { status: Number((head.split("\r\n")[0] || "").split(" ")[1]), body: buf.subarray(sep + 4) });
    };
    const timer = setTimeout(() => finish(reject, new Error(`no answer to ${path} within ${timeoutMs} ms`)), timeoutMs);
    function cleanup() { clearTimeout(timer); sock.off("data", onData); sock.off("end", onEnd); sock.off("error", onErr); }
    const onErr = (e) => finish(reject, e);
    sock.on("data", onData); sock.on("end", onEnd); sock.on("error", onErr);
    sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\nAccept: application/json\r\n\r\n`);
  });
}

/**
 * The readiness answer, judged as a DOCUMENT rather than as a status code.
 * Returns { ok, reason, doc }.
 */
export function judgeReadyBody(status, bodyBuf, appId) {
  const text = Buffer.isBuffer(bodyBuf) ? bodyBuf.toString("utf8") : String(bodyBuf ?? "");
  if (status === 503) return { ok: false, retry: true, reason: "the domain answered 503: still starting" };
  if (status === 404) return { ok: false, retry: false, reason: "the domain has no /.well-known/enclave-ready route: this guest cannot report readiness" };
  if (status !== 200) return { ok: false, retry: false, reason: `the domain answered ${status} to the readiness request` };
  let doc;
  try { doc = JSON.parse(text); } catch {
    // THE TRAP: a 200 whose body is the app's own answer, because the route fell through a proxy.
    return { ok: false, retry: false, reason: "the readiness route answered 200 but the body is not a readiness "
      + `document (${JSON.stringify(text.slice(0, 40))}): the request probably reached the APP, and an app's own `
      + "answer is not evidence that it is ready" };
  }
  if (doc === null || typeof doc !== "object") return { ok: false, retry: false, reason: "the readiness body is not an object" };
  if (doc.ready !== true) return { ok: false, retry: doc.ready === false, reason: `the readiness document says ready=${JSON.stringify(doc.ready)}` };
  const got = String(doc.appId || doc.app || "").toLowerCase();
  if (got !== String(appId).toLowerCase())
    return { ok: false, retry: false, reason: `the readiness document names app ${got || "(none)"}, not ${appId}` };
  return { ok: true, retry: false, reason: null, doc };
}

/**
 * judgeRunning({ host, port, appId, launcherKey, expectRuntime, deadlineMs })
 *   -> { status: "running" | "starting" | "failed", reason, checks: { document, ready } }
 *
 * The document is judged FIRST. A domain whose document does not verify is `failed` even when its
 * readiness answer is a perfect 200: a 200 from something we have not identified is not evidence
 * about the thing we meant to ask.
 */
export async function judgeRunning({ host = "127.0.0.1", port, appId, launcherKey, expectRuntime,
                                     deadlineMs = 60_000, attemptTimeoutMs = 10_000, now = Date.now,
                                     sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!port) throw new Error("a port is required");
  if (!appId) throw new Error("an appId is required");
  if (!launcherKey) throw new Error("the launcher key is required: an unsigned document proves nothing");
  const end = now() + deadlineMs;
  const checks = { document: null, ready: null };
  let last = "no attempt completed";

  while (true) {
    let session = null;
    try {
      session = await connect({ host, port, timeoutMs: attemptTimeoutMs });
      const nonce = crypto.randomBytes(NONCE_LEN);
      const r = await get(session.sock, host, `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`,
                          { timeoutMs: attemptTimeoutMs });
      if (r.status === 503) { last = "the domain answered 503 to the attestation request: still starting"; }
      else if (r.status !== 200) { last = `the domain answered ${r.status} to the attestation request`; }
      else {
        let doc = null;
        try { doc = JSON.parse(r.body.toString("utf8")); } catch { doc = null; }
        if (!doc) {
          checks.document = { ok: false, reason: "the attestation answer is not JSON" };
          return { status: "failed", reason: checks.document.reason, checks };
        }
        const v = judge({ doc, spki: session.spki, nonce, expectedAppSha256: appId, launcherKey, expectRuntime });
        checks.document = { ok: !!v.ok, verdict: v.verdict ?? null, reasons: v.reasons ?? v.checks ?? null };
        if (!v.ok) {
          // a document that does not verify is terminal: we are not talking to what we meant to
          return { status: "failed",
                   reason: `the domain's attestation document was not accepted: ${(v.reasons || []).join("; ") || "rejected"}`,
                   checks };
        }
        // SAME session, SAME key: the readiness answer must come from what we just identified
        const rr = await get(session.sock, host, "/.well-known/enclave-ready", { timeoutMs: attemptTimeoutMs });
        const jr = judgeReadyBody(rr.status, rr.body, appId);
        checks.ready = { ok: jr.ok, status: rr.status, reason: jr.reason };
        if (jr.ok) return { status: "running", reason: null, checks };
        if (!jr.retry) return { status: "failed", reason: jr.reason, checks };
        last = jr.reason;
      }
    } catch (e) {
      last = (e && e.message) || String(e);
    } finally {
      try { session && session.sock.destroy(); } catch {}
    }
    if (now() >= end) return { status: "failed", reason: `not ready within ${deadlineMs} ms: ${last}`, checks };
    await sleep(Math.min(1000, Math.max(50, end - now())));
    if (now() >= end) return { status: "failed", reason: `not ready within ${deadlineMs} ms: ${last}`, checks };
  }
}

/** For a caller that wants the intermediate word while it waits rather than a verdict. */
export function startingReason(checks) {
  if (!checks || !checks.document) return "no attestation document yet";
  if (!checks.ready) return "document verified; no readiness answer yet";
  return checks.ready.reason || "waiting";
}
