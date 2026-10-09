// sni-router.mjs -- the one app port a pVM host shows its TUNA privacy agent (config pvm.appPort), in front of the phone's slot
// VMs (PVM-CPU.md "Slots by share"). Every slot VM ends its app's TLS itself, on its own port; this reads ONLY the server name
// in the client's first TLS record (the ClientHello's SNI, sent in the clear by every client), picks the slot VM serving that
// name, and from then on copies ciphertext both ways, the ClientHello included, byte for byte. It never terminates TLS, never
// sees plaintext, and refuses (closes) anything that is not a ClientHello naming an app served here.
import net from "node:net";

const MAX_HELLO = 64 << 10;   // a ClientHello over several records, at most (a post-quantum key share is ~1.2 KiB)

/**
 * The SNI of a TLS ClientHello at the start of `buf`: { name } when complete, { need: true } when more bytes are needed, or
 * { error } when the bytes are not a ClientHello (or carry no host name).
 */
export function clientHelloName(buf) {
  // the handshake bytes, from as many consecutive handshake records as the ClientHello spans
  const hs = [];
  let o = 0, have = 0, want = -1;
  while (true) {
    if (buf.length < o + 5) return { need: true };
    if (buf[o] !== 0x16) return { error: "not a TLS handshake record" };
    if (buf[o + 1] !== 0x03) return { error: "not a TLS record version" };
    const len = buf.readUInt16BE(o + 3);
    if (len === 0 || len > 16384 + 2048) return { error: "a malformed TLS record" };
    if (buf.length < o + 5 + len) return { need: true };
    hs.push(buf.subarray(o + 5, o + 5 + len)); have += len; o += 5 + len;
    if (want < 0 && have >= 4) {
      const h = Buffer.concat(hs);
      if (h[0] !== 0x01) return { error: "the first handshake message is not a ClientHello" };
      want = 4 + h.readUIntBE(1, 3);
      if (want > MAX_HELLO) return { error: "the ClientHello is too large" };
    }
    if (want >= 0 && have >= want) break;
  }
  const h = Buffer.concat(hs).subarray(0, want);
  try {
    let p = 4 + 2 + 32;                         // type, length; legacy_version; random
    p += 1 + h[p];                              // legacy_session_id
    p += 2 + h.readUInt16BE(p);                 // cipher_suites
    p += 1 + h[p];                              // legacy_compression_methods
    if (p === h.length) return { error: "the ClientHello has no extensions (no server name)" };
    const end = p + 2 + h.readUInt16BE(p); p += 2;
    if (end > h.length) return { error: "the ClientHello's extensions overrun it" };
    while (p + 4 <= end) {
      const type = h.readUInt16BE(p), elen = h.readUInt16BE(p + 2); p += 4;
      if (p + elen > end) return { error: "an extension overruns the ClientHello" };
      if (type === 0) {                         // server_name: a list of (type, name); host_name is type 0
        let q = p + 2;
        const lend = p + 2 + h.readUInt16BE(p);
        while (q + 3 <= lend && lend <= p + elen) {
          const nt = h[q], nl = h.readUInt16BE(q + 1); q += 3;
          if (q + nl > lend) break;
          if (nt === 0) {
            const name = h.subarray(q, q + nl).toString("latin1").toLowerCase().replace(/\.$/, "");
            if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(name)) return { error: "the server name is not a host name" };
            return { name };
          }
          q += nl;
        }
        return { error: "the server_name extension names no host" };
      }
      p += elen;
    }
    return { error: "the ClientHello names no server" };
  } catch { return { error: "a malformed ClientHello" }; }
}

/**
 * The router. portFor(name) -> the loopback port of the slot VM serving `name`, or null. connect(port) is injectable for
 * tests. Each connection: the ClientHello within 10 s, else closed.
 */
export function createSniRouter({ portFor, log = () => {}, connect = (port) => net.connect(port, "127.0.0.1"), helloTimeoutMs = 10_000 }) {
  return net.createServer((sock) => {
    sock.on("error", () => {});
    let buf = Buffer.alloc(0), done = false;
    const timer = setTimeout(() => { done = true; sock.destroy(); }, helloTimeoutMs);
    const onData = (chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_HELLO + 4096) { done = true; clearTimeout(timer); sock.destroy(); return; }
      const r = clientHelloName(buf);
      if (r.need) return;
      done = true; clearTimeout(timer);
      sock.off("data", onData); sock.pause();
      if (r.error) { log({ ev: "sni-refused", why: r.error }); sock.destroy(); return; }
      const port = portFor(r.name);
      if (!port) { log({ ev: "sni-refused", name: r.name, why: "no app served here by that name" }); sock.destroy(); return; }
      const up = connect(port);
      const close = () => { sock.destroy(); up.destroy(); };
      up.on("error", close); sock.on("close", close); up.on("close", close);
      up.once("connect", () => { up.write(buf); sock.pipe(up); up.pipe(sock); sock.resume(); });
    };
    sock.on("data", onData);
  });
}
