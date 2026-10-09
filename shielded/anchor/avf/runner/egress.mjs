// The pVM app's way out (PVM-CPU.md "Egress"): the host half of runtime/pvm-rt/src/egress.rs.
//
// The VM has no network. When its app opens an outbound connection (or looks a name up), the VM writes one line on a vsock
// stream the phone's host app keeps open to it; the host app carries that line here (adb reverse) prefixed with the launch's
// egress token, and this server answers it:
//   EGRESS <token> CONNECT <host> <port>   ->  "OK\n", then the stream IS the connection (bytes both ways)
//   EGRESS <token> RESOLVE <name>          ->  "OK <ip>,<ip>...\n"
//   anything refused                        ->  "ERR <reason>\n", closed
//
// The rules are the platform's guest egress (network/README.md, native-guestd-tuna.patch; NucBox public-web), not new ones:
//   - every connection and every DNS query travels through THIS app's own TUNA circuits: the privacy agent writes them to
//     egress-routes.json ({apps: {<deployment>: {proxies, dns}}}, expiring), and an app with no live route gets nothing.
//     There is no direct fallback and the host's resolver is never asked;
//   - names are resolved by DNS-over-HTTPS through the same proxy, to the resolver's PINNED address, verified by its TLS
//     name; a sibling circuit is tried when one fails;
//   - a destination must be a public address (relay/net-guard.mjs isBlockedHost: no loopback, private, link-local, CGNAT,
//     multicast or reserved) on a port other than 25; a name with ANY non-public answer is refused whole, and the judged
//     literal is what is dialled (never resolved twice);
//   - per app: at most 96 open connections and 2400 new ones a minute (the NucBox public-web caps).
// The token is per VM launch and known only to the agent and the phone: a local process on this machine that is not the
// phone's host app gets nothing.
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";
import { connectSOCKS, SocksHttpsAgent } from "../../../../network/socks-connect.mjs";
import { isBlockedHost } from "../../../../relay/net-guard.mjs";

export const EGRESS_LIMITS = Object.freeze({ concurrent: 96, perMinute: 2400 });
const LINE_MAX = 600;
const NAME = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;

/** This app's live route: { proxies: ["ip:port", ...], dns: [{address, serverName, path}] }, or the reason there is none. */
export function routeFor(routesFile, deployment, now = Date.now()) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(routesFile, "utf8")); } catch { throw new Error("no egress routes yet (the privacy agent has not written them)"); }
  if (!doc || doc.version !== 1 || !Number.isFinite(doc.expiresAt)) throw new Error("the egress routes are malformed");
  if (doc.expiresAt <= now) throw new Error("the egress routes have expired (the privacy agent is not refreshing them)");
  const r = doc.apps && doc.apps[String(deployment).toLowerCase()];
  if (!r || !Array.isArray(r.proxies) || !r.proxies.length || !Array.isArray(r.dns) || !r.dns.length) throw new Error("this app has no authorized egress route");
  for (const p of r.proxies) if (typeof p !== "string" || !/^127\.0\.0\.1:[0-9]{1,5}$/.test(p)) throw new Error("an egress proxy is not a loopback SOCKS address");
  for (const d of r.dns) {
    if (!d || typeof d.address !== "string" || typeof d.serverName !== "string" || typeof d.path !== "string" || !d.path.startsWith("/")) throw new Error("an egress DNS server is malformed");
    const [ip, port] = [d.address.replace(/:[0-9]+$/, ""), Number(d.address.split(":").pop())];
    if (!net.isIP(ip) || isBlockedHost(ip) || port !== 443) throw new Error("an egress DNS server is not a public :443 address");
  }
  return r;
}

/** Why this literal destination is refused, or null. */
export function destinationRefusal(ip, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "the port is not 1..65535";
  if (port === 25) return "port 25 (mail) is refused";
  if (!net.isIP(ip)) return "not an address";
  if (isBlockedHost(ip)) return "not a public address";
  return null;
}

/** A name's addresses by DNS-over-HTTPS (JSON) through `proxy` to the pinned resolvers: A then AAAA, as guestd asks. */
export async function resolveVia(proxy, servers, name, { request = https.request } = {}) {
  const out = [];
  for (const type of [1, 28]) {
    let accepted = null;
    for (const s of servers) {
      try {
        const ip = s.address.replace(/:[0-9]+$/, "");
        const body = await new Promise((resolve, reject) => {
          const req = request({ host: ip, port: 443, servername: s.serverName, path: `${s.path}?name=${encodeURIComponent(name)}&type=${type}`,
            headers: { host: s.serverName, accept: "application/dns-json" }, agent: new SocksHttpsAgent(proxy), timeout: 8000 }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`DNS ${res.statusCode}`)); }
            const chunks = []; let n = 0;
            res.on("data", (b) => { n += b.length; if (n > 65536) res.destroy(new Error("DNS answer too large")); else chunks.push(b); });
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); res.on("error", reject);
          });
          req.on("error", reject); req.on("timeout", () => req.destroy(new Error("DNS timeout"))); req.end();
        });
        const doc = JSON.parse(body);
        if (doc.Status !== 0 && doc.Status !== 3) continue;   // 3 = NXDOMAIN: an answer, empty
        const got = [];
        for (const a of doc.Answer || []) if (a.type === type) {
          if (net.isIP(a.data) !== (type === 1 ? 4 : 6)) throw new Error("a malformed DNS answer");
          got.push(a.data);
        }
        accepted = got; break;
      } catch { /* the next resolver */ }
    }
    if (!accepted) throw new Error("guarded DNS unavailable");
    out.push(...accepted);
  }
  if (!out.length) throw new Error("the name has no addresses");
  return out;
}

/**
 * The server. `current()` answers { token, deployment } for the VM now serving (null when idle: nothing goes out).
 * `connect`/`resolve` are injectable for tests (defaults: SOCKS through the app's proxies, DoH through them).
 */
export function createEgressServer({ current, routesFile, log = () => {}, now = Date.now, connect = connectSOCKS, resolve = resolveVia, limits = EGRESS_LIMITS }) {
  const open = new Map();     // deployment -> open connections
  const minute = new Map();   // deployment -> [window start, count]
  const admit = (D) => {
    const t = now(), w = minute.get(D) || [t, 0];
    if (t - w[0] >= 60_000) { w[0] = t; w[1] = 0; }
    if ((open.get(D) || 0) >= limits.concurrent) return `at most ${limits.concurrent} open connections per app`;
    if (w[1] >= limits.perMinute) return `at most ${limits.perMinute} new connections a minute per app`;
    w[1]++; minute.set(D, w); return null;
  };
  const server = net.createServer((sock) => {
    sock.setNoDelay(true); sock.on("error", () => {});
    sock.setTimeout(20_000, () => sock.destroy());
    let buf = Buffer.alloc(0);
    const refuse = (why) => { sock.end(`ERR ${String(why).replace(/[\r\n]/g, " ").slice(0, 200)}\n`); };
    const onData = async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl < 0) { if (buf.length > LINE_MAX) sock.destroy(); return; }
      sock.off("data", onData); sock.pause();
      const line = buf.subarray(0, nl).toString("latin1").replace(/\r$/, ""), rest = buf.subarray(nl + 1);
      const [tag, token, op, a, b, ...extra] = line.split(" ");
      const cur = current();
      if (tag !== "EGRESS" || !cur || !cur.token || typeof token !== "string" || token.length !== cur.token.length
          || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(cur.token))) return refuse("not this launch's egress");
      if (extra.length) return refuse("malformed");
      const D = cur.deployment;
      let route;
      try { route = routeFor(routesFile, D, now()); } catch (e) { log({ ev: "egress-refused", deployment: D, why: e.message }); return refuse(e.message); }
      const host = String(a || "").toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
      if (!net.isIP(host) && !NAME.test(host)) return refuse("not a host name");
      try {
        if (op === "RESOLVE" && b === undefined) {
          const ips = net.isIP(host) ? [host] : await resolveOnRoute(route, host);
          sock.end(`OK ${ips.join(",")}\n`);
          return;
        }
        if (op !== "CONNECT") return refuse("malformed");
        const port = Number(b);
        if (!/^[0-9]{1,5}$/.test(String(b)) || port < 1 || port > 65535) return refuse("the port is not 1..65535");
        const ips = net.isIP(host) ? [host] : await resolveOnRoute(route, host);
        // a name with ANY non-public answer is refused whole; the judged literal is what is dialled
        for (const ip of ips) { const why = destinationRefusal(ip, port); if (why) { log({ ev: "egress-refused", deployment: D, port, why }); return refuse(why); } }
        const why = admit(D);
        if (why) { log({ ev: "egress-refused", deployment: D, why }); return refuse(why); }
        let up = null, last = null;
        for (const proxy of route.proxies) {
          try { up = await connect(proxy, ips[0], port, { signal: AbortSignal.timeout(15_000) }); break; } catch (e) { last = e; }
        }
        if (!up) return refuse(`no circuit reached it: ${last ? last.message : "none"}`);
        open.set(D, (open.get(D) || 0) + 1);
        let closed = false;
        const done = () => { if (closed) return; closed = true; open.set(D, Math.max(0, (open.get(D) || 1) - 1)); up.destroy(); sock.destroy(); };
        up.on("error", done); up.on("close", done); sock.on("close", done);
        sock.setTimeout(0); up.setTimeout(30 * 60_000, done);
        sock.write("OK\n");
        if (rest.length) up.write(rest);
        sock.pipe(up); up.pipe(sock); sock.resume();
      } catch (e) {
        refuse(e.message);
      }
    };
    sock.on("data", onData);
  });
  async function resolveOnRoute(route, name) {
    let last = null;
    for (const proxy of route.proxies) {
      try { return await resolve(proxy, route.dns, name); } catch (e) { last = e; }
    }
    throw last || new Error("guarded DNS unavailable");
  }
  server.openCount = (D) => open.get(String(D).toLowerCase()) || 0;
  return server;
}
