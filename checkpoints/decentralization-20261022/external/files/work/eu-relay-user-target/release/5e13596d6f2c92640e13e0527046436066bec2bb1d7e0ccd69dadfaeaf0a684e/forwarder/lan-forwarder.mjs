#!/usr/bin/env node
// lan-forwarder.mjs - the minipc FALLBACK path to warden's own lease relay, for a user service that cannot use systemd's
// IP access lists (IPAddressAllow/Deny need eBPF cgroup programs a per-user manager cannot attach). It does exactly one
// thing, with FIXED values that no argument, environment variable or file can change:
//   listen ONLY on 192.168.8.249:8549 (warden's LAN address), accept ONLY 192.168.8.238 (minipc), forward ONLY to
//   127.0.0.1:8549 (the relay host role's loopback listener).
// Any other peer is closed before a byte is read. Bounded: 8 concurrent connections, a 5 s connect, 15 s idle and 60 s
// total per connection, 256 KiB each way (a lease request or answer is at most 64 KiB). It reads no environment and no
// file, holds no credential, and resolves no name. What crosses is the relay's public protocol: signed lease intents the
// compute host verifies on its own RPC quorum. It is this host's own relay, never discovery and never a general proxy.
//   node lan-forwarder.mjs            (no arguments: any argument refuses, exit 2)
import net from "node:net";
import { pathToFileURL } from "node:url";

export const LISTEN = Object.freeze({ host: "192.168.8.249", port: 8549 });
export const PEER = "192.168.8.238";
export const TARGET = Object.freeze({ host: "127.0.0.1", port: 8549 });
export const LIMITS = Object.freeze({ connections: 8, connectMs: 5_000, idleMs: 15_000, lifetimeMs: 60_000, bytesEachWay: 256 * 1024 });
const v4 = (a) => String(a || "").replace(/^::ffff:/, "");

/** The forwarder over given values (the CLI passes only the frozen ones above; tests pass loopback fixtures). */
export function startForwarder({ listen = LISTEN, peer = PEER, target = TARGET, limits = LIMITS, log = () => {} } = {}) {
  for (const h of [listen.host, peer, target.host]) if (net.isIPv4(h) !== true) throw new Error(`forwarder: ${h} is not an IPv4 literal`);
  const stats = { accepted: 0, denied: 0, closed: 0, capped: 0, timedOut: 0 };
  const server = net.createServer({ pauseOnConnect: true }, (down) => {
    if (v4(down.remoteAddress) !== peer || v4(down.localAddress) !== listen.host) { stats.denied++; down.destroy(); return; }
    stats.accepted++;
    let done = false;
    const up = net.connect({ host: target.host, port: target.port });
    const end = (why) => { if (done) return; done = true; if (why) stats[why]++; stats.closed++; clearTimeout(life); clearTimeout(conn); down.destroy(); up.destroy(); };
    const life = setTimeout(() => end("timedOut"), limits.lifetimeMs);
    const conn = setTimeout(() => end("timedOut"), limits.connectMs);
    for (const s of [down, up]) { s.setTimeout(limits.idleMs, () => end("timedOut")); s.on("error", () => end()); s.on("close", () => end()); }
    const cap = (from, to) => { let n = 0; from.on("data", (b) => { n += b.length; if (n > limits.bytesEachWay) return end("capped"); if (!to.write(b)) from.pause(); }); to.on("drain", () => from.resume()); from.on("end", () => to.end()); };
    up.on("connect", () => { clearTimeout(conn); cap(down, up); cap(up, down); down.resume(); });
  });
  server.maxConnections = limits.connections;
  const ready = new Promise((ok, no) => { server.once("error", no); server.listen({ host: listen.host, port: listen.port, exclusive: true }, () => { server.off("error", no); ok(); }); });
  return { server, stats, ready, address: () => server.address(), close: () => new Promise((ok) => server.close(() => ok())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2) { console.error("lan-forwarder: takes no arguments (its listen address, peer and target are fixed)"); process.exit(2); }
  const f = startForwarder({ log: (m) => console.log(m) });
  f.ready.then(() => console.log(`[lan-forwarder] ${LISTEN.host}:${LISTEN.port} -> ${TARGET.host}:${TARGET.port}, peer ${PEER} only`),
    (e) => { console.error(`[lan-forwarder] cannot listen on ${LISTEN.host}:${LISTEN.port}: ${e.code || e.message}`); process.exit(1); });
  const report = setInterval(() => { if (f.stats.denied) console.log(`[lan-forwarder] ${JSON.stringify(f.stats)}`); }, 600_000); report.unref();
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => f.close().then(() => process.exit(0)));
}
