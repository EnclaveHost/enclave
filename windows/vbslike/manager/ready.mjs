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
import http from "node:http";
import crypto from "node:crypto";
import { judge } from "../verify/judge-hv.mjs";

const NONCE_LEN = 32;

/**
 * The transport key as the data plane names it: sha256 of the DER SPKI this handshake presented,
 * lowercase hex. One definition, used by the verdict and by anything that compares against it, so a
 * route can never be admitted on a differently-derived value.
 */
export function transportKeyOf(spki) {
  if (!Buffer.isBuffer(spki) && !(spki instanceof Uint8Array)) throw new Error("the SPKI must be bytes");
  if (!spki.length) throw new Error("the SPKI is empty");
  return crypto.createHash("sha256").update(spki).digest("hex");
}

/**
 * One TLS session, reused for every request, so the document and the readiness answer share a key.
 *
 * The HTTP is node:http driven over that one socket through an Agent whose createConnection hands
 * it back, rather than a hand-rolled parser. The first version here DID hand-roll it and understood
 * only content-length and connection:close - which is wrong against this guest: its front is Go
 * net/http, which sends any body over its 2,048-byte buffer with `Transfer-Encoding: chunked`, and
 * the attestation document is ~2,208 bytes. So every real document either came back with the chunk
 * framing still in it ("the attestation answer is not JSON") or hung until the attempt timeout on a
 * keep-alive connection with no framing the parser could use. Found by enclave-99 against the spec.
 * Writing HTTP by hand to save a dependency that is in the standard library was not worth it.
 */
function session_({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false, servername: host }, () => {
      const cert = sock.getPeerX509Certificate ? sock.getPeerX509Certificate() : null;
      const spki = cert ? cert.publicKey.export({ type: "spki", format: "der" }) : null;
      if (!spki) { sock.destroy(); return reject(new Error("the domain presented no usable public key")); }
      sock.setTimeout(0);
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      agent.createConnection = () => sock;
      resolve({ sock, spki, agent });
    });
    sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error(`no TLS session within ${timeoutMs} ms`)); });
    sock.on("error", reject);
  });
}

/** One GET on the established session. node:http handles chunked, content-length and keep-alive. */
export function get(sess, host, path, { timeoutMs = 10_000, maxBytes = 1 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ agent: sess.agent, host, port: 0, path, method: "GET",
                               headers: { Host: host, Accept: "application/json" } }, (res) => {
      const chunks = [];
      let n = 0;
      res.on("data", (d) => {
        n += d.length;
        if (n > maxBytes) { req.destroy(new Error(`answer over the ${maxBytes}-byte cap`)); return; }
        chunks.push(d);
      });
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer to ${path} within ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
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
 * checkAnswer({ host, port, appId, transportKeySha256, timeoutMs }) -> { ok: true } | { ok: false, keyChanged, reason }
 *
 * The cheap question a RUNNING domain is asked on a timer (Manager.sweepAnswers): is it still answering, and on the key
 * it was verified on? ONE TLS session. First, the handshake's SPKI must hash to the verified key: another key means
 * another boot or another domain (keyChanged), never a blip. Then GET /.well-known/enclave-ready is judged as a
 * document for this app (judgeReadyBody). No attestation document is fetched: the key was verified once, and this checks
 * that the same key still answers. Never throws: a connect or TLS error is an answer of its own (ok:false).
 */
export async function checkAnswer({ host = "127.0.0.1", port, appId, transportKeySha256, timeoutMs = 10_000 } = {}) {
  let sess;
  try { sess = await session_({ host, port, timeoutMs }); }
  catch (e) { return { ok: false, keyChanged: false, reason: `no TLS session: ${e.message}` }; }
  try {
    const got = transportKeyOf(sess.spki), want = String(transportKeySha256 || "").toLowerCase();
    if (got !== want) return { ok: false, keyChanged: true, reason: `the domain answers on key ${got}, not the verified ${want}` };
    const r = await get(sess, host, "/.well-known/enclave-ready", { timeoutMs });
    const j = judgeReadyBody(r.status, r.body, appId);
    return j.ok ? { ok: true } : { ok: false, keyChanged: false, reason: j.reason };
  } catch (e) {
    return { ok: false, keyChanged: false, reason: e.message };
  } finally {
    try { sess.agent.destroy(); } catch { /* closed */ }
    try { sess.sock.destroy(); } catch { /* closed */ }
  }
}

/**
 * judgeRunning({ host, port, appId, launcherKey, expectedVmId, expectRuntime, expectedStatement, expectedImageSha256, deadlineMs })
 *   expectedVmId: the partition the launcher holding launcherKey is bound to; judge-hv refuses a report naming another
 *     ("report names another partition").
 *   expectedStatement + expectedImageSha256: the record's launcher statement and image, judged as a PAIR (judge-hv);
 *   absent, no image is compared (the HCS lab's records carry none).
 *   -> { status: "running" | "starting" | "failed", reason, checks: { document, ready } }
 *
 * The document is judged FIRST. A domain whose document does not verify is `failed` even when its
 * readiness answer is a perfect 200: a 200 from something we have not identified is not evidence
 * about the thing we meant to ask.
 */
export async function judgeRunning({ host = "127.0.0.1", port, appId, launcherKey, expectedVmId, expectRuntime,
                                     expectedStatement, expectedImageSha256, deadlineMs = 60_000, attemptTimeoutMs = 10_000, now = Date.now,
                                     sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!port) throw new Error("a port is required");
  if (!appId) throw new Error("an appId is required");
  if (!launcherKey) throw new Error("the launcher key is required: an unsigned document proves nothing");
  const end = now() + deadlineMs;
  const checks = { document: null, ready: null };
  let last = "no attempt completed";
  let transportKeySha256 = null;

  while (true) {
    let session = null;
    try {
      session = await session_({ host, port, timeoutMs: attemptTimeoutMs });
      const nonce = crypto.randomBytes(NONCE_LEN);
      const r = await get(session, host, `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`,
                          { timeoutMs: attemptTimeoutMs });
      if (r.status === 503) { last = "the domain answered 503 to the attestation request: still starting"; }
      else if (r.status !== 200) { last = `the domain answered ${r.status} to the attestation request`; }
      else {
        let doc = null;
        try { doc = JSON.parse(r.body.toString("utf8")); } catch { doc = null; }
        if (!doc) {
          checks.document = { ok: false, reason: "the attestation answer is not JSON" };
          return { status: "failed", transportKeySha256, reason: checks.document.reason, checks };
        }
        const v = judge({ doc, spki: session.spki, nonce, expectedAppSha256: appId, launcherKey, expectedVmId, expectRuntime,
                          expectedStatement, expectedImageSha256 });
        // judge-hv answers { verdict, reasons, checks } and has NO `ok` field: reading v.ok was
        // always false, so a perfectly good monitor-signed document reported "was not accepted"
        // and this rule could never have said running (enclave-99, against the spec).
        // "monitor-signed" is the ONLY acceptable verdict. "unsigned" means the signature did not
        // verify, and "reject" that something structural failed; neither is a weaker pass.
        const accepted = v.verdict === "monitor-signed";
        // The key we judged ON. A manager that verifies a domain and forgets which key it verified
        // it on leaves the data plane nothing to compare: 5d's splice admits a route on
        // `key=<64hex>` and the /vms view names transportKeySha256, so the value has to travel with
        // the verdict rather than be re-derived from a later handshake - a later handshake is a
        // different session and could be a different peer.
        transportKeySha256 = transportKeyOf(session.spki);
        checks.document = { ok: accepted, verdict: v.verdict ?? null, reasons: v.reasons ?? null,
                            transportKeySha256 };
        if (!accepted) {
          // a document that does not verify is terminal: we are not talking to what we meant to
          return { status: "failed", transportKeySha256,
                   reason: `the domain's attestation document was not accepted (verdict ${v.verdict}): `
                     + `${(v.reasons || []).join("; ") || "no reason given"}`,
                   checks };
        }
        // SAME session, SAME key: the readiness answer must come from what we just identified
        const rr = await get(session, host, "/.well-known/enclave-ready", { timeoutMs: attemptTimeoutMs });
        const jr = judgeReadyBody(rr.status, rr.body, appId);
        checks.ready = { ok: jr.ok, status: rr.status, reason: jr.reason };
        if (jr.ok) return { status: "running", reason: null, transportKeySha256, checks };
        if (!jr.retry) return { status: "failed", transportKeySha256, reason: jr.reason, checks };
        last = jr.reason;
      }
    } catch (e) {
      last = (e && e.message) || String(e);
    } finally {
      try { session && session.sock.destroy(); } catch {}
    }
    if (now() >= end) return { status: "failed", transportKeySha256, reason: `not ready within ${deadlineMs} ms: ${last}`, checks };
    await sleep(Math.min(1000, Math.max(50, end - now())));
    if (now() >= end) return { status: "failed", transportKeySha256, reason: `not ready within ${deadlineMs} ms: ${last}`, checks };
  }
}

/** For a caller that wants the intermediate word while it waits rather than a verdict. */
export function startingReason(checks) {
  if (!checks || !checks.document) return "no attestation document yet";
  if (!checks.ready) return "document verified; no readiness answer yet";
  return checks.ready.reason || "waiting";
}
