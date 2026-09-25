/* ============================================================
   guestd-control/1, the server side, for the Windows manager.

   The protocol is specified in isolation/m4/guestd/auth.go and implemented twice already: there in
   Go, and in control-client.mjs as the supervisor's side. This is the third, and it is deliberately
   NOT a variant - the manager must be reachable by the supervisor's existing client with no change
   on that side, so control.test.mjs drives this server with that very client rather than with a
   mock of it. If the two ever disagree, the test fails here.

   What the pairing key is for, taken from auth.go so nobody has to infer it: the host is outside
   the trust boundary and its root controls this manager regardless, so K is not a defence against
   the host operator. It stops another local user or process, any guest reaching a bridged
   transport, a recorded request replayed later or at another manager, and a supervisor mistaking an
   impostor for its manager. Nothing a domain's security rests on comes from this channel.

   WITHOUT A KEY THERE IS NO CHANNEL. `/control/*` answers that no credentials are configured, so a
   client expecting the protocol fails closed rather than falling back to an unauthenticated one.
   ============================================================ */
import crypto from "node:crypto";

export const PROTO = "guestd-control/1";
const hmac = (key, ...parts) => crypto.createHmac("sha256", key).update(parts.join("\n")).digest();
const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
const eq = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function keyId(key) {
  return crypto.createHash("sha256").update(Buffer.concat([Buffer.from(PROTO + " kid\n"), key])).digest("hex").slice(0, 16);
}

/** Exactly 64 lowercase hex digits and an optional newline, never the all-zero key. */
export function parseKey(text) {
  if (!/^[0-9a-f]{64}\n?$/.test(String(text))) throw new Error("a pairing key is exactly 64 lowercase hex digits");
  const k = Buffer.from(String(text).trim(), "hex");
  if (k.every((b) => b === 0)) throw new Error("the all-zero key is refused");
  return k;
}

const NONCE_TTL_MS = 30_000, IDLE_MS = 10 * 60_000, MAX_MS = 60 * 60_000;
const MAX_NONCES = 64, MAX_SESSIONS = 8, SEQ_WINDOW = 64;

export class ControlServer {
  /**
   * @param key      the 32-byte pairing key, or null for "no credentials configured"
   * @param handle   async ({method, path, body}) => { status, body } - the manager's own routes
   */
  constructor({ key = null, handle, now = () => Date.now() }) {
    this.key = key; this.handle = handle; this.now = now;
    // NEW at every start, and part of both the handshake MAC and the session key, so nothing signed
    // for another manager - or for this one before a restart - is accepted.
    this.instance = crypto.randomBytes(16).toString("hex");
    this.kid = key ? keyId(key) : null;
    this.nonces = new Map();     // nonce -> issuedAt
    this.sessions = new Map();   // id -> { skey, born, seen, highest, used:Set }
  }

  #sweep() {
    const t = this.now();
    for (const [n, at] of this.nonces) if (t - at > NONCE_TTL_MS) this.nonces.delete(n);
    for (const [id, s] of this.sessions) if (t - s.seen > IDLE_MS || t - s.born > MAX_MS) this.sessions.delete(id);
  }

  /** GET /control/hello - unauthenticated, and bounded so it cannot grow memory. */
  hello() {
    this.#sweep();
    if (!this.key) return { status: 503, body: { error: "no credentials are configured for guestd-control/1" } };
    while (this.nonces.size >= MAX_NONCES) this.nonces.delete(this.nonces.keys().next().value);
    const nonce = crypto.randomBytes(32).toString("hex");
    this.nonces.set(nonce, this.now());
    return { status: 200, body: { proto: PROTO, instance: this.instance, nonce, kid: this.kid,
                                  nonceTtlSec: NONCE_TTL_MS / 1000 } };
  }

  /** POST /control/session - one nonce, once, and this manager proves it holds K too. */
  session(req) {
    this.#sweep();
    if (!this.key) return { status: 503, body: { error: "no credentials are configured for guestd-control/1" } };
    const { instance, nonce, clientNonce, kid, mac } = req || {};
    if (instance !== this.instance) return { status: 401, body: { error: "instance is not this manager's" } };
    if (!eq(String(kid || ""), this.kid)) return { status: 401, body: { error: "a different pairing key" } };
    if (typeof nonce !== "string" || !this.nonces.has(nonce)) return { status: 401, body: { error: "unknown or spent nonce" } };
    if (typeof clientNonce !== "string" || clientNonce.length < 16) return { status: 401, body: { error: "clientNonce too short" } };
    const want = hmac(this.key, PROTO + " session", instance, nonce, clientNonce, this.kid).toString("hex");
    if (!eq(want, String(mac || ""))) return { status: 401, body: { error: "the handshake MAC did not verify" } };
    this.nonces.delete(nonce);                      // single use, and only after the MAC verified

    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
    const id = crypto.randomBytes(16).toString("hex");
    const skey = hmac(this.key, PROTO + " skey", instance, nonce, clientNonce, id);
    this.sessions.set(id, { skey, born: this.now(), seen: this.now(), highest: 0, used: new Set() });
    return { status: 200, body: { session: id, idleSec: IDLE_MS / 1000, maxSec: MAX_MS / 1000,
                                  proof: hmac(skey, PROTO + " proof", clientNonce).toString("hex") } };
  }

  /**
   * Any other request. Returns { status, body, headers } with the answer's own MAC, so the client
   * can tell this manager's answer from anything that replaced it.
   *
   * A 401 is unsigned by construction - there is no key to sign it with when the request did not
   * authenticate - so it carries `reauth` and nothing a caller should read as a statement about
   * what ran.
   */
  async call({ method, path, headers = {}, body = "" }) {
    this.#sweep();
    if (!this.key) return { status: 503, body: { error: "no credentials are configured for guestd-control/1" } };
    const id = String(headers["x-guestd-session"] || "");
    const seqRaw = String(headers["x-guestd-seq"] || "");
    const mac = String(headers["x-guestd-mac"] || "");
    const s = this.sessions.get(id);
    if (!s) return { status: 401, body: { error: "no such session", reauth: true } };
    if (!/^[0-9]+$/.test(seqRaw)) return { status: 401, body: { error: "a sequence number is required", reauth: true } };
    const seq = Number(seqRaw);
    if (!(seq >= 1)) return { status: 401, body: { error: "sequence numbers start at 1", reauth: true } };
    // Replay: once each, inside a 64-wide window below the highest seen, because concurrent
    // requests may arrive out of order.
    if (seq <= s.highest - SEQ_WINDOW) return { status: 401, body: { error: "sequence number too old", reauth: true } };
    if (s.used.has(seq)) return { status: 401, body: { error: "sequence number already used", reauth: true } };

    const want = hmac(s.skey, PROTO + " req", id, String(seq), method, path, sha256hex(Buffer.from(body || ""))).toString("hex");
    if (!eq(want, mac)) return { status: 401, body: { error: "the request MAC did not verify", reauth: true } };

    // Recorded only AFTER the MAC verified, so a forgery cannot burn a number.
    s.used.add(seq);
    if (seq > s.highest) s.highest = seq;
    for (const n of s.used) if (n <= s.highest - SEQ_WINDOW) s.used.delete(n);
    s.seen = this.now();

    let out;
    try { out = await this.handle({ method, path, body }); }
    catch (e) { out = { status: 500, body: { error: e.message } }; }
    const raw = Buffer.from(JSON.stringify(out.body ?? {}));
    return { status: out.status, body: out.body ?? {},
             headers: { "x-guestd-response-mac": hmac(s.skey, PROTO + " resp", id, String(seq), String(out.status), sha256hex(raw)).toString("hex") } };
  }
}
