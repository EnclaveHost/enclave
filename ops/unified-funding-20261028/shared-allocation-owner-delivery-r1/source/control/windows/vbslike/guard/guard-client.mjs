/* ============================================================
   enclave-permit-guard/1: the authenticated local channel between the manager and the guard (SOURCE ONLY).

   Transport: a Windows named pipe (\\.\pipe\...) created by the guard service; node:net speaks it (and a Unix
   socket in the portable TEST harness). The pipe's own ACL (install-guard.ps1: SYSTEM + the manager's service
   account) limits who can connect; the MAC below is what binds a session:
     guard -> hello    { proto, guard, nonce }                       guard = this guard process's instance (new each start)
     mgr   -> attach   { pid, created, epoch, clientNonce, mac }     mac = H(K, attach, guard, nonce, clientNonce, pid, created, epoch)
     guard -> attached { proof }                                     after it checked pid+created is a live process (not PID alone)
     mgr   -> req      { seq, op, args, mac }                        seq is exactly previous+1; mac = H(skey, req, seq, op, sha(args))
     guard -> res      { seq, ok, value | error, mac }               mac = H(skey, res, seq, ok, sha(value|error))
   skey = H(K, skey, guard, nonce, clientNonce). Any MAC/sequence/size failure closes the connection, and a closed
   connection IS the manager-death signal at the guard (its instances are removed). K is not a defence against a
   host administrator (T0-hv); it stops another local process from posing as the manager or the guard.
   ============================================================ */
import net from "node:net";
import crypto from "node:crypto";

export const GUARD_PROTO = "enclave-permit-guard/1";
export const MAX_FRAME = 64 * 1024;
export const hmac = (key, ...parts) => crypto.createHmac("sha256", key).update(parts.map(String).join("\n")).digest("hex");
export const shaJson = (v) => crypto.createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");
export const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Newline-delimited JSON frames, bounded. onFrame(obj) or onBad(why). */
export function frames(sock, onFrame, onBad) {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (d) => {
    buf += d;
    if (buf.length > MAX_FRAME * 2) return onBad("frame too large");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.length > MAX_FRAME) return onBad("frame too large");
      let o; try { o = JSON.parse(line); } catch { return onBad("frame is not JSON"); }
      if (!o || typeof o !== "object" || Array.isArray(o)) return onBad("frame is not an object");
      onFrame(o);
    }
  });
}
export const send = (sock, o) => { if (!sock.destroyed) sock.write(JSON.stringify(o) + "\n"); };

/**
 * GuardClient.connect({ path, key, identity: {pid, created, epoch}, timeoutMs }) -> client
 * client.call(op, args) -> value (throws on refusal, MAC failure, timeout or loss); client.onLost(fn); client.close()
 * A lost session is never retried silently: the manager treats it as guard unavailability (withdraw + remove).
 */
export class GuardClient {
  static connect({ path, key, identity, timeoutMs = 10_000, connect = net.connect }) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw Error("guard key is 32 bytes");
    return new Promise((resolve, reject) => {
      const sock = connect(path);
      const c = new GuardClient(sock, key);
      const t = setTimeout(() => { sock.destroy(); reject(Error("guard handshake timed out")); }, timeoutMs);
      let stage = "hello", clientNonce = null, guard = null, nonce = null;
      sock.on("error", (e) => { clearTimeout(t); if (stage !== "ready") reject(Error(`guard unavailable: ${e.message}`)); c.#lost(e.message); });
      sock.on("close", () => { clearTimeout(t); if (stage !== "ready") reject(Error("guard closed the connection during the handshake")); c.#lost("connection closed"); });
      frames(sock, (o) => {
        if (stage === "hello") {
          if (o.t !== "hello" || o.proto !== GUARD_PROTO || !/^[0-9a-f]{32}$/.test(o.guard || "") || !/^[0-9a-f]{64}$/.test(o.nonce || "")) { sock.destroy(); return; }
          guard = o.guard; nonce = o.nonce; clientNonce = crypto.randomBytes(32).toString("hex");
          send(sock, { t: "attach", pid: identity.pid, created: identity.created, epoch: identity.epoch, clientNonce,
            mac: hmac(key, "attach", guard, nonce, clientNonce, identity.pid, identity.created, identity.epoch) });
          stage = "attach"; return;
        }
        if (stage === "attach") {
          const skey = Buffer.from(hmac(key, "skey", guard, nonce, clientNonce), "hex");
          if (o.t !== "attached" || !same(String(o.proof || ""), hmac(skey, "proof", clientNonce))) { sock.destroy(); return; }
          c.skey = skey; c.guard = guard; stage = "ready"; clearTimeout(t); resolve(c); return;
        }
        c.#answer(o);
      }, () => sock.destroy());
    });
  }
  constructor(sock, key) { this.sock = sock; this.key = key; this.seq = 0; this.pending = new Map(); this.lost = null; this.listeners = []; }
  #lost(why) {
    if (this.lost) return;
    this.lost = why;
    for (const [, p] of this.pending) p.reject(Object.assign(Error(`guard session lost: ${why}`), { mayHaveExecuted: true }));
    this.pending.clear();
    for (const fn of this.listeners.splice(0)) { try { fn(why); } catch { /* the loss stands */ } }
  }
  #answer(o) {
    const p = this.pending.get(o.seq);
    const body = o.ok === true ? o.value : o.error;
    if (o.t !== "res" || !p || !same(String(o.mac || ""), hmac(this.skey, "res", o.seq, o.ok === true, shaJson(body)))) { this.sock.destroy(); return; }
    this.pending.delete(o.seq);
    if (o.ok === true) p.resolve(o.value); else p.reject(Error(`guard refused: ${String(body)}`));
  }
  onLost(fn) { if (this.lost) fn(this.lost); else this.listeners.push(fn); }
  call(op, args = {}, { timeoutMs = 10_000 } = {}) {
    if (this.lost) return Promise.reject(Error(`guard session lost: ${this.lost}`));
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      // A timeout is NOT a refusal: the guard may have acted. The session is closed so the guard removes
      // everything this manager registered, and the caller treats the guard as unavailable.
      const t = setTimeout(() => { this.sock.destroy(); }, timeoutMs);
      this.pending.set(seq, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      send(this.sock, { t: "req", seq, op, args, mac: hmac(this.skey, "req", seq, op, shaJson(args)) });
    });
  }
  close() { this.sock.destroy(); }
}
