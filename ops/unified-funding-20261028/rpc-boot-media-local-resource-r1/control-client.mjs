// control-client.mjs - the supervisor's side of guestd-control/1. The protocol is specified in auth.go beside this
// file; this is a second implementation of it, held to the same wire format by TestTheJSClientInteroperates, and to
// its failure behaviour by TestTheClientUnderChaos.
//
// It fails CLOSED at every step:
//   - no request is sent without a session, and a guestd that does not speak the protocol - including one in its
//     unauthenticated lab mode - is refused, never used without authentication;
//   - a guestd that does not prove possession of the pairing key, or holds a different one, is refused;
//   - an answer whose MAC does not verify, that exceeds the byte cap, that is cut short, or that does not arrive in
//     time is never returned.
//
// CONCURRENCY. One handshake at a time (single flight): callers that need a session while one is being made wait
// for it. Every request CAPTURES the session it was signed under and verifies its answer against that same
// session, so a session replaced while a request is in flight cannot make an authentic answer fail - the race
// reported against a40f1019 (testdata/control-client-a40f1019.mjs), where two concurrent first requests made two
// handshakes and the first request's answer was checked against the second's key. A session is renewed only if it
// is still the one that failed; concurrent failures share the one renewal.
//
// RETRIES. An authentication failure cannot be signed, so a 401 asking for a new handshake is not proof that the
// request did NOT run: something between the client and guestd could have forwarded the request and replaced its
// answer. So a request is sent again after renewal only if it is IDEMPOTENT (GET and HEAD by default; the caller
// declares any other), or if the caller's RECONCILE proves it did not happen. Otherwise the error says the outcome
// is unknown, and nothing is repeated. A timeout or a broken answer is never retried here.
import crypto from "node:crypto";

const PROTO = "guestd-control/1";
const hmac = (key, ...parts) => crypto.createHmac("sha256", key).update(parts.join("\n")).digest();
const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class GuestdControlError extends Error {
  // kind: "protocol" | "refused" | "timeout" | "transport" | "oversize" | "mac" | "outcome-unknown"
  // mayHaveExecuted: true when guestd may have acted on the request although no verified answer came back
  constructor(kind, message, mayHaveExecuted = false) {
    super(message);
    this.kind = kind;
    this.mayHaveExecuted = mayHaveExecuted;
  }
}

export function keyId(key) {
  return crypto.createHash("sha256").update(Buffer.concat([Buffer.from(PROTO + " kid\n"), key])).digest("hex").slice(0, 16);
}

// The key file's text: exactly 64 lowercase hex digits and an optional newline, never the all-zero key.
export function parseKey(text) {
  if (!/^[0-9a-f]{64}\n?$/.test(String(text))) throw new Error("a pairing key is exactly 64 lowercase hex digits");
  const k = Buffer.from(String(text).trim(), "hex");
  if (k.every((b) => b === 0)) throw new Error("the all-zero key is refused");
  return k;
}

// Read at most cap bytes of an answer. A declared length over the cap is refused before reading; a body that grows
// past it is cancelled mid-stream.
async function readCapped(res, cap, what) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    throw new GuestdControlError("oversize", `${what}: ${declared} bytes declared, over the ${cap}-byte cap`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let n = 0;
  for await (const c of res.body) {
    n += c.length;
    if (n > cap) throw new GuestdControlError("oversize", `${what}: the answer exceeded the ${cap}-byte cap`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export class GuestdControl {
  constructor(baseUrl, key, opts = {}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("a pairing key is 32 bytes");
    this.base = String(baseUrl).replace(/\/$/, "");
    this.key = key;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.maxResponseBytes = opts.maxResponseBytes ?? 1 << 20;
    this.maxHandshakeBytes = opts.maxHandshakeBytes ?? 16 << 10;
    this.session = null;       // the current session: frozen {id, key, instance, next()}
    this._connecting = null;   // the one handshake in flight, if any
    this.handshakes = 0;       // completed handshakes, for tests and diagnostics
  }

  get instance() { return this.session ? this.session.instance : null; }

  // One fetch with a hard deadline over the whole exchange, body included, and a byte cap on the answer.
  async _fetch(url, init, timeoutMs, cap, what) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      const raw = await readCapped(res, cap, what);
      return { res, raw };
    } catch (e) {
      if (e instanceof GuestdControlError) throw e;
      if (ac.signal.aborted) throw new GuestdControlError("timeout", `${what}: no answer within ${timeoutMs} ms`);
      throw new GuestdControlError("transport", `${what}: ${e.cause?.message || e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // connect() returns THE session being made, making one only if none is in flight. A failed handshake is not
  // remembered: the next caller starts a fresh one.
  connect() {
    if (!this._connecting) {
      this._connecting = this._handshake().finally(() => { this._connecting = null; });
    }
    return this._connecting;
  }

  async _handshake() {
    const t = this.handshakeTimeoutMs, cap = this.maxHandshakeBytes;
    const h = await this._fetch(this.base + "/control/hello", {}, t, cap, "hello");
    let hj = {};
    try { hj = JSON.parse(h.raw.toString() || "{}"); } catch {}
    if (h.res.status !== 200 || hj.proto !== PROTO)
      throw new GuestdControlError("protocol", `guestd at ${this.base} does not speak ${PROTO} (${h.res.status}`
        + `${hj.error ? ": " + hj.error : ""}); refusing to use an unauthenticated manager`);
    const kid = keyId(this.key);
    if (hj.kid !== kid) throw new GuestdControlError("protocol", `guestd holds pairing key ${hj.kid}, not ours (${kid})`);
    const clientNonce = crypto.randomBytes(32).toString("hex");
    const mac = hmac(this.key, PROTO + " session", hj.instance, hj.nonce, clientNonce, kid).toString("hex");
    const s = await this._fetch(this.base + "/control/session", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instance: hj.instance, nonce: hj.nonce, clientNonce, kid, mac }) }, t, cap, "session");
    let sj = {};
    try { sj = JSON.parse(s.raw.toString() || "{}"); } catch {}
    if (s.res.status !== 200) throw new GuestdControlError("refused", `guestd refused the session: ${sj.error || s.res.status}`);
    const skey = hmac(this.key, PROTO + " skey", hj.instance, hj.nonce, clientNonce, String(sj.session));
    if (!same(hmac(skey, PROTO + " proof", clientNonce).toString("hex"), sj.proof))
      throw new GuestdControlError("protocol", "guestd did not prove the pairing key: not our manager");
    let n = 0n;
    const session = Object.freeze({ id: String(sj.session), key: skey, instance: String(hj.instance),
      next: () => (++n).toString() });
    this.session = session;
    this.handshakes++;
    return session;
  }

  async _current() { return this.session || this.connect(); }

  // Renew only the session that failed: if another caller already replaced it, use theirs.
  async _renew(stale) {
    if (this.session && this.session !== stale) return this.session;
    if (this.session === stale) this.session = null;
    return this.connect();
  }

  // sign(method, path, body[, session]) -> { seq, headers }. Exposed for the interop test.
  sign(method, path, body, session = this.session) {
    const seq = session.next();
    const mac = hmac(session.key, PROTO + " req", session.id, seq, method, path, sha256hex(body)).toString("hex");
    return { seq, headers: { "x-guestd-session": session.id, "x-guestd-seq": seq, "x-guestd-mac": mac } };
  }

  // One signed exchange under ONE session: the answer is verified against the session that signed the request.
  async _send(session, method, path, body, timeoutMs, idempotent) {
    const { seq, headers } = this.sign(method, path, body, session);
    let r;
    try {
      r = await this._fetch(this.base + path, { method,
        headers: body ? { ...headers, "content-type": "application/json" } : headers, body: body || undefined },
        timeoutMs, this.maxResponseBytes, `${method} ${path}`);
    } catch (e) {
      // no verified answer: for a request that changes state, the change may or may not have happened
      e.mayHaveExecuted = !idempotent;
      if (!idempotent) e.message += "; the outcome is UNKNOWN - reconcile before repeating it";
      throw e;
    }
    let j = {};
    try { j = JSON.parse(r.raw.toString() || "{}"); } catch {}
    if (r.res.status === 401) {
      // unsigned by construction: only the fact of refusal is used, never its text as a statement of what ran
      if (j.reauth === true) return { reauth: true };
      throw new GuestdControlError("refused", `guestd refused ${method} ${path} (401)`, !idempotent);
    }
    const want = hmac(session.key, PROTO + " resp", session.id, seq, String(r.res.status), sha256hex(r.raw)).toString("hex");
    if (!same(want, r.res.headers.get("x-guestd-response-mac") || ""))
      throw new GuestdControlError("mac", `the answer to ${method} ${path} (status ${r.res.status}) failed its MAC: not accepted`,
        !idempotent);
    return { result: { status: r.res.status, body: j } };
  }

  // request(method, path[, json][, {idempotent, reconcile, timeoutMs}]) -> { status, body } | throws.
  //   idempotent  safe to send again (default: GET and HEAD only)
  //   reconcile   async (client) => value | null: after a renewal, decide whether a non-idempotent request ran.
  //               A value means it did, and is returned as {status: "reconciled", body: value}; null means it did
  //               not, and it is sent once more under the new session.
  async request(method, path, json, { idempotent = method === "GET" || method === "HEAD", reconcile, timeoutMs } = {}) {
    const body = json === undefined ? "" : JSON.stringify(json);
    const t = timeoutMs ?? this.requestTimeoutMs;
    let session = await this._current();
    let r = await this._send(session, method, path, body, t, idempotent);
    if (!r.reauth) return r.result;
    session = await this._renew(session);
    if (!idempotent) {
      if (!reconcile)
        throw new GuestdControlError("outcome-unknown", `guestd asked for a new handshake on ${method} ${path}; an `
          + "unsigned 401 does not prove the request did not run, so it is not repeated - reconcile first", true);
      const found = await reconcile(this);
      if (found !== null && found !== undefined) return { status: "reconciled", body: found };
    }
    r = await this._send(session, method, path, body, t, idempotent);
    if (r.reauth) throw new GuestdControlError("refused", `guestd refused ${method} ${path} again after a new handshake`, !idempotent);
    return r.result;
  }
}
