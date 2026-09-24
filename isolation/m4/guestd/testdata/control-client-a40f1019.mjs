// PRESERVED AS REPORTED (a40f1019), for the regression test only: its concurrent-handshake race is the genuine
// failure TestTheReportedRaceIsRealInTheOldClient (chaos_test.go) keeps demonstrating. Never import this outside testdata.
// control-client.mjs - the supervisor's side of guestd-control/1. The protocol is specified in auth.go beside this
// file; this is a second implementation of it, held to the same wire format by TestTheJSClientInteroperates.
//
// NOTHING USES IT YET: wiring it into supervisor.js (and delivering the pairing key into the node CVM) is part of
// C3/C7 in isolation/DEPLOYMENT-PATH.md. It is written to fail CLOSED at every step:
//   - no request is sent without a session, and a guestd that does not speak the protocol - including one in its
//     unauthenticated lab mode - is refused, never used without authentication;
//   - a guestd that does not prove possession of the pairing key, or holds a different one, is refused;
//   - an answer whose MAC does not verify is thrown away, never returned;
//   - a session guestd reports gone (expired, or lost to a restart) is re-established ONCE, then the error stands.
import crypto from "node:crypto";

const PROTO = "guestd-control/1";
const hmac = (key, ...parts) => crypto.createHmac("sha256", key).update(parts.join("\n")).digest();
const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

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

export class GuestdControl {
  constructor(baseUrl, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("a pairing key is 32 bytes");
    this.base = String(baseUrl).replace(/\/$/, "");
    this.key = key;
    this.session = null;
    this.instance = null;
  }

  async connect() {
    this.session = null;
    const h = await fetch(this.base + "/control/hello");
    const hj = await h.json().catch(() => ({}));
    if (h.status !== 200 || hj.proto !== PROTO)
      throw new Error(`guestd at ${this.base} does not speak ${PROTO} (${h.status}${hj.error ? ": " + hj.error : ""}); `
        + "refusing to use an unauthenticated manager");
    const kid = keyId(this.key);
    if (hj.kid !== kid) throw new Error(`guestd holds pairing key ${hj.kid}, not ours (${kid})`);
    const clientNonce = crypto.randomBytes(32).toString("hex");
    const mac = hmac(this.key, PROTO + " session", hj.instance, hj.nonce, clientNonce, kid).toString("hex");
    const s = await fetch(this.base + "/control/session", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ instance: hj.instance, nonce: hj.nonce, clientNonce, kid, mac }) });
    const sj = await s.json().catch(() => ({}));
    if (s.status !== 200) throw new Error(`guestd refused the session: ${sj.error || s.status}`);
    const skey = hmac(this.key, PROTO + " skey", hj.instance, hj.nonce, clientNonce, String(sj.session));
    if (!same(hmac(skey, PROTO + " proof", clientNonce).toString("hex"), sj.proof))
      throw new Error("guestd did not prove the pairing key: not our manager");
    this.session = { id: String(sj.session), key: skey, seq: 0n };
    this.instance = hj.instance;
  }

  // sign(method, path, body) -> { seq, headers } for the next sequence number. Exposed for the interop test.
  sign(method, path, body) {
    const s = this.session;
    s.seq += 1n;
    const n = s.seq.toString();
    const mac = hmac(s.key, PROTO + " req", s.id, n, method, path, sha256hex(body)).toString("hex");
    return { seq: n, headers: { "x-guestd-session": s.id, "x-guestd-seq": n, "x-guestd-mac": mac } };
  }

  // request(method, path[, json]) -> { status, body }, or throws. body is the parsed JSON answer.
  async request(method, path, json, retried = false) {
    if (!this.session) await this.connect();
    const body = json === undefined ? "" : JSON.stringify(json);
    const { seq, headers } = this.sign(method, path, body);
    const res = await fetch(this.base + path, { method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers, body: body || undefined });
    const raw = Buffer.from(await res.arrayBuffer());
    let j = {};
    try { j = JSON.parse(raw.toString() || "{}"); } catch {}
    if (res.status === 401) {
      // An authentication failure cannot be signed (guestd has no session to sign it with), so its text is not
      // trusted - only the fact that the request was not served. reauth asks for one new handshake.
      if (j.reauth === true && !retried) { this.session = null; return this.request(method, path, json, true); }
      throw new Error(`guestd refused ${method} ${path} (401)`);
    }
    const want = hmac(this.session.key, PROTO + " resp", this.session.id, seq, String(res.status), sha256hex(raw)).toString("hex");
    if (!same(want, res.headers.get("x-guestd-response-mac") || ""))
      throw new Error(`the answer to ${method} ${path} (status ${res.status}) failed its MAC: not accepted`);
    return { status: res.status, body: j };
  }
}
