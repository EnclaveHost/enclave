// Enclave public TCP relay — the UNTRUSTED half of the platform's direct-TCP path.
//
//   client ──TLS──> relay (this, any box) ──wss──> enclave shim ──> supervisor ──> app
//            └────────── the TLS key lives only in the enclave ──────────┘
//
// The enclave's sole ingress is the Tinfoil shim (HTTPS/443), so someone has to
// own the raw public port. This daemon does — and nothing else. It peeks the
// SNI hostname from the TLS ClientHello WITHOUT terminating TLS, maps
// <deploymentId>.<RELAY_DOMAIN>:<port> to the enclave's WebSocket bridge at
// /x/<deploymentId>/tls/<logical port>, and splices bytes. The client's TLS
// session terminates INSIDE the attested enclave (the supervisor holds the
// platform cert as an enclave secret), so this box only ever sees ciphertext
// and connection metadata. It is stateless and holds no secrets: run it on a
// $3 VPS, run several behind round-robin DNS, or let strangers run their own.
//
// Config (env):
//   RELAY_DOMAIN            optional  LEGACY SNI suffix(es) (the retired
//                                     tcp.* zone). Kept only so stragglers
//                                     with cached DNS keep working during the
//                                     sunset tail; new config sets APP_DOMAIN
//                                     and leaves this unset.
//   APP_DOMAIN              optional  app-subdomain SNI suffix(es), e.g.
//                                     "app.enclave.host" - the ONE-hostname
//                                     surface. A DECLARED tcp port routes to
//                                     the tenant's socket via the in-enclave
//                                     /tls/ terminator (443 included, if
//                                     declared); undeclared 443 routes to
//                                     /x/<label>/https (the browser bridge
//                                     into the app's HTTP surface). All TLS
//                                     terminates in-CVM with ACME certs; this
//                                     box never holds keys. Unset = off.
//   DOMAINS_API             optional  api-relay origin to read the custom-domain
//                                     routing map from (GET /v1/domains/map),
//                                     e.g. "https://api.enclave.host". Customer
//                                     hostnames are exact-matched against that
//                                     map and route exactly like the app
//                                     subdomain they name. Unset = off, and an
//                                     unknown SNI keeps being refused. The map
//                                     is public read-only data (every hostname
//                                     in it is already in DNS and in the CT
//                                     logs), so this needs no credential —
//                                     which keeps this box "holds no secrets".
//   REDIRECT_HTTP_PORT      optional  logical port to answer plaintext HTTP on
//                                     with a 301 to https (default 80; 0 = off).
//                                     Only for hostnames this relay routes.
//   REGISTRY_ADDRESS        required* EnclaveRegistry on Base: FLEET discovery — the
//                                     relay routes each SNI'd deployment to the
//                                     enclave that OWNS it (learned from every
//                                     enclave's /v1/net-map), so it follows an
//                                     arbitrary, changing set of enclaves.
//   ENCLAVES                required* *instead: static comma list of enclave
//                                     origins (ENCLAVE_URL = legacy one-entry alias)
//   BASE_RPC / REGISTRY_POLL_SEC / STALE_AFTER_SEC   registry-mode knobs (fleet.mjs)
//   NET_POLL_SEC            optional  /v1/net-map poll cadence (default 5)
//   RELAY_PORTS             required  comma list of "public[:logical]" ports and
//                                     "lo-hi" ranges (range = pass-through, public
//                                     == logical). "1-49999" serves every logical
//                                     port the platform allows — the box needs no
//                                     firewall, and a tenant's new tcp:N works with
//                                     no relay config change. e.g.:
//                                       RELAY_PORTS=1-49999            all apps
//                                       (pin net.ipv4.ip_local_port_range above
//                                       the range first — 58000 65535 — or range
//                                       binds race the box's outbound ephemerals)
//                                       RELAY_PORTS=6667,6697:6667     just IRC
//   RELAY_EXCLUDE           optional  ports never bound (default "22"; sshd)
//   RELAY_BIND              optional  comma list of LOCAL addresses to listen on
//                                     (default: wildcard/dual-stack — all
//                                     interfaces). Set SPECIFIC addresses when
//                                     this box ALSO runs the dedicated-IP relay
//                                     (tcp6-relay), which binds
//                                     [<per-deployment IPv6>]:port out of a
//                                     routed /64: a wildcard listener here would
//                                     grab [::]:port across that whole /64 and
//                                     block those binds. `RELAY_BIND=0.0.0.0`
//                                     serves all IPv4 (this relay's v4-fallback
//                                     role) without touching the v6 /64; add the
//                                     box's own main v6 to also serve v6 SNI.
//   RELAY_MAX_CONNS         optional  concurrent client connection cap (1024)
//   RELAY_HELLO_TIMEOUT_MS  optional  ms to wait for a full ClientHello (10000)
//   RELAY_HANDSHAKE_MS      optional  ms to open the enclave WS after routing
//                                     before tearing the connection down (10000)
//   RELAY_IDLE_MS           optional  idle timeout on a spliced connection so a
//                                     silent client can't hold a slot (180000)

import net from "node:net";
import WebSocket, { createWebSocketStream } from "ws";
import { createFleet, fleetConfig, fetchJson, installProcessGuards } from "./fleet.mjs";
import * as connlog from "./connlog.mjs";

// publish this process's connection rows for the agent to serve (tmpfs)
connlog.startSnapshot("inbound");
installProcessGuards("tcp-relay");

const need = (k) => {
  const v = (process.env[k] || "").trim();
  if (!v) { console.error(`fatal: ${k} is required`); process.exit(1); }
  return v;
};

// Comma-separated: during a domain cutover both the new and the old SNI suffix
// route (e.g. "tcp.enclave.host,tcp.nan.host"); the first entry is primary.
const DOMAINS   = (process.env.RELAY_DOMAIN || "").toLowerCase().split(",")
  .map(s => s.trim().replace(/^\.+|\.+$/g, "")).filter(Boolean);   // legacy tcp.* suffixes; empty = none
const DOMAIN    = DOMAINS[0] || null;
// App-subdomain suffixes (in-enclave browser TLS). Optional; empty = feature off.
const APP_DOMAINS = (process.env.APP_DOMAIN || "").toLowerCase().split(",")
  .map(s => s.trim().replace(/^\.+|\.+$/g, "")).filter(Boolean);
// Customer-owned hostnames. These share nothing with the suffix rules above:
// a custom domain is an EXACT name, learned from the api-relay's routing map,
// and it resolves to the very same deployment (and therefore the very same
// enclave, cert and bridge path) as that deployment's own app subdomain.
const DOMAINS_API = (process.env.DOMAINS_API || "").trim().replace(/\/+$/, "");
const REDIRECT_HTTP_PORT = parseInt(process.env.REDIRECT_HTTP_PORT || "80", 10);
// FLEET discovery (REGISTRY_ADDRESS / ENCLAVES / legacy ENCLAVE_URL): the relay
// learns which enclave owns each deployment from their /v1/net-map, so one box
// serves the whole fleet and follows enclaves as they come and go.
const CFG = fleetConfig();
if (!CFG.registryAddress && !CFG.staticList.length) {
  console.error("fatal: set REGISTRY_ADDRESS (on-chain discovery) or ENCLAVES (static list)");
  process.exit(1);
}
const fleet    = createFleet(CFG, (m) => console.log("[relay]", m));
const POLL_MS  = parseInt(process.env.NET_POLL_SEC || "5", 10) * 1000;
const wsOrigin = (o) => o.replace(/^http/, "ws");
const MAX_CONNS = parseInt(process.env.RELAY_MAX_CONNS || "1024", 10);
const HELLO_MS  = parseInt(process.env.RELAY_HELLO_TIMEOUT_MS || "10000", 10);
const HS_MS     = parseInt(process.env.RELAY_HANDSHAKE_MS || "10000", 10);   // enclave WS-open timeout (fix 4)
const IDLE_MS   = parseInt(process.env.RELAY_IDLE_MS || "180000", 10);       // spliced-connection idle timeout (fix 4)
const EXCLUDE = new Set((process.env.RELAY_EXCLUDE || "22").split(",").map((s) => +s.trim()).filter(Boolean));
// Local addresses to listen on. Empty (default) -> one wildcard/dual-stack
// listener per port (all interfaces). A list -> one listener per (address,
// port), so this relay can share a box with the dedicated-IP relay without its
// wildcard v6 bind swallowing the routed /64 (see RELAY_BIND above).
const BIND_ADDRS = (process.env.RELAY_BIND || "").split(",").map((s) => s.trim()).filter(Boolean);
const LISTEN_ON = BIND_ADDRS.length ? BIND_ADDRS : [null];   // null = wildcard
const PORTS = [];
for (const s of need("RELAY_PORTS").split(",")) {
  const range = /^\s*(\d{1,5})\s*-\s*(\d{1,5})\s*$/.exec(s);
  const single = /^\s*(\d{1,5})(?::(\d{1,5}))?\s*$/.exec(s);
  if (range) {
    for (let p = +range[1]; p <= +range[2]; p++) if (!EXCLUDE.has(p)) PORTS.push({ public: p, logical: p, quiet: true });
  } else if (single) {
    PORTS.push({ public: +single[1], logical: +(single[2] || single[1]) });
  } else {
    console.error(`fatal: RELAY_PORTS: bad entry "${s}" (use public[:logical] or lo-hi)`); process.exit(1);
  }
}

// Extract the SNI server_name from a TLS ClientHello.
//   string -> hostname (lowercased)   null -> need more bytes   false -> reject
function sniFromClientHello(buf) {
  if (buf.length < 5) return null;
  if (buf[0] !== 0x16) return false;                   // not a TLS handshake record
  const recLen = buf.readUInt16BE(3);
  if (recLen > 18432) return false;                    // no sane ClientHello is this big
  if (buf.length < 5 + recLen) return null;            // wait for the full record
  const d = buf.subarray(5, 5 + recLen);
  let o = 0;
  const u8  = () => d[o++];
  const u16 = () => { const v = d.readUInt16BE(o); o += 2; return v; };
  try {
    if (u8() !== 0x01) return false;                   // handshake type ClientHello
    o += 3 + 2 + 32;                                   // length, legacy_version, random
    // NB: not `o += u8()` — compound assignment reads the OLD o before the
    // helper advances it, silently losing the length-byte skip.
    const sid = u8(); o += sid;                        // session id
    const cs = u16(); o += cs;                         // cipher suites
    const cm = u8(); o += cm;                          // compression methods
    if (o >= d.length) return false;                   // no extensions -> no SNI
    const extEnd = o + 2 + d.readUInt16BE(o); o += 2;
    while (o + 4 <= extEnd && o + 4 <= d.length) {
      const type = u16(), len = u16();
      if (type === 0x0000) {                           // server_name
        let p = o + 2;                                 // skip server_name_list length
        if (d[p] !== 0x00) return false;               // name_type 0 = host_name
        const nameLen = d.readUInt16BE(p + 1);
        return d.subarray(p + 3, p + 3 + nameLen).toString("ascii").toLowerCase();
      }
      o += len;
    }
    return false;
  } catch { return false; }                            // truncated/garbled -> reject
}

// --- fleet index: which enclave OWNS each deployment --------------------------
// Poll every live enclave's /v1/net-map (the public tcp/udp deployments each
// serves) and remember origin -> {full ids}. A SNI label (which for on-chain
// ids is a hex PREFIX, or a legacy "dep_<base36>") resolves to the owning
// origin + the canonical full id. An enclave that fails a poll keeps its last
// set (a flaky RPC/enclave must not drop live routes); one that leaves the
// fleet is dropped.
const originDeps = new Map();          // origin -> Set<full deployment id>

async function poll() {
  const origins = fleet.origins();
  const live = new Set(origins);
  const results = await Promise.all(origins.map(async (o) =>
    ({ o, map: await fetchJson(o + "/v1/net-map") })));
  for (const { o, map } of results) {
    if (!map) continue;                                    // unreachable -> keep last-known
    if (!map.enabled) { originDeps.set(o, new Map()); continue; }
    originDeps.set(o, new Map((map.deployments || []).map((d) => [d.id, new Set(d.tcp || [])])));
  }
  for (const o of [...originDeps.keys()]) if (!live.has(o)) originDeps.delete(o);
}

// --- custom domains: hostname -> deployment id -------------------------------
// The api-relay's domain store is the authority for WHICH deployment a
// customer hostname belongs to (an owner signed for it and its DNS was
// verified); the chain stays the authority for WHICH ENCLAVE that deployment
// runs on (appOwnerOf below). Splitting it that way means neither a hostile
// enclave nor a hostile map reader can point somebody's domain anywhere: the
// map cannot name an enclave, and an enclave cannot name a domain.
//
// A poll that FAILS keeps the last map, exactly like the net-map poll: a relay
// blip must not dark every custom domain on the platform.
const customDomains = new Map();                           // hostname -> full deployment id
async function pollDomains() {
  if (!DOMAINS_API) return;
  const m = await fetchJson(DOMAINS_API + "/v1/domains/map");
  if (!m || !m.domains || typeof m.domains !== "object") return;
  const next = new Map();
  for (const [host, id] of Object.entries(m.domains)) {
    const h = String(host).toLowerCase().replace(/\.+$/, "");
    // Defensive, not decorative: this map is the one input to routing that
    // comes over the network, and a name matching an app/legacy suffix would
    // let a bad map shadow the suffix rules below.
    if (!/^[a-z0-9.-]{1,253}$/.test(h) || !/^(0x[0-9a-f]{64}|dep_[a-z0-9]+)$/.test(String(id).toLowerCase())) continue;
    if ([...APP_DOMAINS, ...DOMAINS].some((d) => h === d || h.endsWith("." + d))) continue;
    next.set(h, String(id).toLowerCase());
  }
  if (next.size !== customDomains.size) console.log(`[relay] custom domains: ${next.size} routed`);
  customDomains.clear();
  for (const [k, v] of next) customDomains.set(k, v);
}

// Resolve a SNI label to { origin, id, tcp } (tcp = the deployment's declared
// tcp ports). Matches an exact id, or (for on-chain bytes32 ids) a unique hex
// prefix; ambiguous prefixes are refused.
function resolve(label) {
  const l = label.toLowerCase().replace(/^dep[_-]/, "").replace(/^0x/, "");
  let hit = null;
  for (const [origin, deps] of originDeps) {
    for (const [id, tcp] of deps) {
      const n = id.toLowerCase().replace(/^0x/, "");
      if (id.toLowerCase() === label.toLowerCase() || n === l || ("dep_" + l) === id.toLowerCase()
          || (l.length >= 6 && n.startsWith(l))) {
        if (hit && hit.id !== id) return null;             // ambiguous -> refuse
        hit = { origin, id, tcp };
      }
    }
  }
  return hit;
}

let conns = 0;

function handle(client, logicalPort) {
  if (conns >= MAX_CONNS) { client.destroy(); return; }
  conns++;
  client.once("close", () => conns--);
  client.on("error", () => client.destroy());
  // A splice must not re-Nagle bytes that were already framed upstream. Node
  // leaves Nagle ON for net.createServer sockets (http.Server turns it off for
  // you; a raw listener gets no such favor), and `ws` already clears it on the
  // enclave leg — so this client socket was the ONE Nagle-enabled hop in the
  // whole path. The cost was a full CLIENT round trip, not a small one: the
  // enclave answers a request in two writes (headers, then body) or answers two
  // pipelined requests a millisecond apart, the first write goes out, and the
  // second is held hostage until the client ACKs the first. Measured 2026-08-11
  // from a box 171 ms from this relay: two pipelined /ping responses generated
  // 1 ms apart in the enclave arrived 170 ms apart. Every header/body split, SSE
  // frame and HID input event paid it.
  client.setNoDelay(true);

  // buffer until the ClientHello is complete, route on its SNI, then splice
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => client.destroy(), HELLO_MS);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Plaintext on the HTTP port. A customer's own domain is a name people TYPE,
    // and they type it without a scheme — so the first request a custom domain
    // ever sees is usually http://. Before this, that connection was reset as a
    // malformed ClientHello ("this site can't be reached", with a valid site one
    // redirect away). Answer it ourselves; nothing is terminated and no app
    // bytes are involved, so the box still holds no keys and sees no plaintext
    // that wasn't already addressed to it.
    if (REDIRECT_HTTP_PORT && logicalPort === REDIRECT_HTTP_PORT && buf.length && buf[0] !== 0x16) {
      // the cap is on the BYTES SEEN, not on "still waiting for the terminator":
      // a complete-but-enormous head is just as much unbounded work, and no
      // legitimate request to a redirector is 8 KB
      if (buf.length > 8192) { clearTimeout(timer); client.destroy(); return; }
      const head = buf.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.off("data", onData); clearTimeout(timer);
      return httpsRedirect(client, head.slice(0, end));
    }
    const sni = sniFromClientHello(buf);
    if (sni === null) { if (buf.length > 20000) { clearTimeout(timer); client.destroy(); } return; }
    client.off("data", onData); clearTimeout(timer);
    // A CUSTOMER's own hostname: exact match, and it lands on precisely the
    // path its deployment's own subdomain would have. Checked before the suffix
    // rules because it is an exact lookup and cannot be a suffix match (the
    // add endpoint refuses any name in a zone we own, and pollDomains drops
    // one anyway).
    const customId = (sni !== false) && customDomains.get(sni);
    if (customId) {
      const label = customId.startsWith("0x") ? customId.slice(2, 10) : customId.replace(/^dep[-_]/, "");
      const owned = resolve(label);
      // Same 443-precedence rule as the app zone: a tenant that DECLARED tcp:443
      // owns 443 on every name that reaches them, their own domain included.
      if (owned && owned.tcp.has(logicalPort)) {
        client.pause();
        return splice(client, owned.origin, owned.id, `/x/${encodeURIComponent(owned.id)}/tls/${logicalPort}`, buf);
      }
      if (logicalPort !== 443) return client.destroy();
      client.pause();
      appOwnerOf(customId).then((origin) => {
        if (!origin || client.destroyed) return client.destroy();
        splice(client, origin, customId, `/x/${encodeURIComponent(customId)}/https`, buf);
      });
      return;
    }
    // App-subdomain names ride the same passthrough but land on the enclave's
    // /x/<label>/https path (in-enclave ACME cert + the app's normal HTTP
    // serving) instead of a tenant TCP port. Browsers only: 443.
    const appDom = (sni !== false) && APP_DOMAINS.find(d => sni.endsWith("." + d));
    if (appDom) {
      const label = sni.slice(0, -(appDom.length + 1));
      if (!/^[a-z0-9-]{1,64}$/.test(label)) return client.destroy();
      // the subdomain label spells hex ids WITHOUT the 0x (DNS-friendly), but
      // the supervisor resolves 0x-prefixed ids - restore it (depFromHost does
      // the same on the api-relay). Legacy dep- labels map back to dep_.
      const dep = /^[0-9a-f]{8,64}$/.test(label) ? "0x" + label : label.replace(/^dep-/, "dep_");
      // ONE hostname per deployment: every DECLARED tcp port routes to the
      // tenant's socket (via the in-enclave /tls/ terminator) - including 443
      // if they declared it (their socket outranks the platform HTTPS bridge).
      // Undeclared 443 = the HTTPS bridge into the app's HTTP surface;
      // undeclared anything-else = nothing there. The tcp.<domain> zone keeps
      // serving as a deprecated alias of the declared-port half of this.
      const owned = resolve(label);
      if (owned && owned.tcp.has(logicalPort)) {
        client.pause();
        return splice(client, owned.origin, owned.id, `/x/${encodeURIComponent(owned.id)}/tls/${logicalPort}`, buf);
      }
      if (logicalPort !== 443) return client.destroy();
      client.pause();
      appOwnerOf(dep).then((origin) => {
        if (!origin || client.destroyed) return client.destroy();
        splice(client, origin, dep, `/x/${encodeURIComponent(dep)}/https`, buf);
      });
      return;
    }
    const dom = (sni !== false) && DOMAINS.find(d => sni.endsWith("." + d));
    if (!dom) return client.destroy();
    // Deployment ids are "dep_<base36>", but "_" is not a valid hostname label
    // char - OpenSSL refuses to wildcard-match it, so strict clients (psql,
    // python) would reject the cert. The advertised hostname therefore spells
    // it "dep-<base36>"; map that back to the canonical id here.
    const label = sni.slice(0, -(dom.length + 1)).replace(/^dep-/, "dep_");
    if (!/^[a-z0-9_-]{1,64}$/.test(label)) return client.destroy();
    // route to the enclave that owns this deployment (learned from net-map)
    const r = resolve(label);
    if (!r) return client.destroy();                       // unknown / not-public / ambiguous
    client.pause();
    splice(client, r.origin, r.id, `/x/${encodeURIComponent(r.id)}/tls/${logicalPort}`, buf);
  };
  client.on("data", onData);
}

// Which enclave owns an app-subdomain label. HTTP-mode apps never appear in
// /v1/net-map (they declare no tcp/udp ports), so the tcp-zone index above
// can't answer - probe /x/<label> on each origin instead (the supervisor's
// HTTP path resolves hex prefixes; any non-404 = "lives here") and cache.
const APP_OWNER = new Map();                               // label -> { origin, at }
const APP_OWNER_TTL_MS = 5 * 60_000;
async function appOwnerOf(label) {
  const hit = APP_OWNER.get(label);
  // in-fleet origins are cache-valid while they stay in the fleet; a
  // lease-authorized origin (below) is not in origins by definition, so it
  // rides the TTL alone and re-proves its lease on expiry
  if (hit && Date.now() - hit.at < APP_OWNER_TTL_MS && (hit.byLease || fleet.origins().includes(hit.origin))) return hit.origin;
  // SECURITY (fix 1c / B3): prefer the deployment's ON-CHAIN runner over "first
  // enclave answering non-404", so a hostile enclave can't hijack another
  // tenant's app-subdomain by answering for its id. Only used when the fleet
  // exposes a deployments source (ADDRESS_BOOK/DEPLOYMENTS_ADDRESS); otherwise
  // null -> the probe below (unchanged behavior).
  // leaseEndpointFor also answers for a box OUTSIDE the operator allowlist,
  // provided the ledger says it holds this deployment's live lease. That is
  // the correct authority here: the lease holder already runs the app and
  // terminates its TLS in its own enclave, so splicing ciphertext to it grants
  // nothing — and without this an unvetted SELLER box could never serve its
  // apps publicly (control-plane trust is unaffected; see fleet.mjs).
  const byRunner = await ((fleet.leaseEndpointFor ?? fleet.runnerEndpointFor)?.(label) ?? Promise.resolve(null)).catch(() => null);
  if (byRunner) { APP_OWNER.set(label, { origin: byRunner, at: Date.now(), byLease: !fleet.origins().includes(byRunner) }); return byRunner; }
  // …and when the on-chain answer is "two deployments answer to this prefix",
  // the probe below must NOT break the tie. A label is 8 hex of a
  // keccak256(creator, nonce) id: a twin is ground offline and created for one
  // transaction, and on THIS path the race decides who receives a client's
  // ClientHello for the victim's hostname — to an enclave that can hold a real
  // CA cert for the same label. Ambiguous names serve nobody.
  if (await (fleet.prefixAmbiguous?.(label) ?? Promise.resolve(false)).catch(() => false)) {
    console.log(`[relay] ${label} names more than one deployment on the ledger — refusing`);
    return null;
  }
  const found = await Promise.all(fleet.origins().map(async (o) => {
    try {
      const r = await fetch(`${o}/x/${encodeURIComponent(label)}`,
                            { method: "HEAD", signal: AbortSignal.timeout(4000) });
      return r.status !== 404 ? o : null;
    } catch { return null; }
  }));
  const origin = found.find(Boolean) || null;
  if (origin) APP_OWNER.set(label, { origin, at: Date.now() });
  return origin;
}

// Answer a plaintext HTTP request on the redirect port with a 301 to the same
// URL over https. `head` is the request head with no trailing CRLFCRLF.
//
// Everything that reaches the response is validated rather than escaped: the
// Host is matched against a strict hostname charset and the target must be
// printable ASCII with no space, so neither can carry the CR/LF that would let
// a client write its own response headers (a bare LF inside the request line
// survives a split on CRLF, which is exactly how that bug is usually written).
// Hostnames this relay does not route get 421, the same answer as an unknown
// SNI — never a redirect, so this is not a general-purpose reflector.
const HTTP_METHOD_RE = /^[A-Z]{3,10}$/;
// What an unrouted hostname is told. A bare status code is a dead end: the
// first person to point a real domain here and get "HTTP ERROR 421" had no way
// to tell a DNS mistake from a platform one (2026-07-30 — it was neither; the
// relay simply had not been told where to read the domain map). Say the one
// thing that distinguishes the cases. It discloses nothing: the answer is
// identical whether the hostname is attached to somebody else, half-verified,
// or has never been heard of.
const UNROUTED_BODY = "This hostname is not served here.\n\n"
  + "If you are attaching a custom domain, it is not verified yet — open the\n"
  + "Domains section of your deployment to see which DNS record is missing.\n";
function httpsRedirect(client, head) {
  const reply = (status, extra = "", body = "") => {
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n`
             + `Content-Type: text/plain; charset=utf-8\r\n`
             + `Content-Length: ${Buffer.byteLength(body)}\r\n`
             + `Cache-Control: no-store\r\n${extra}\r\n${body}`);
  };
  const lines = head.split("\r\n");
  const [method, target, version] = (lines[0] || "").split(" ");
  if (!HTTP_METHOD_RE.test(method || "") || !/^HTTP\/1\.[01]$/.test(version || "")) return reply("400 Bad Request");
  if (!target || !target.startsWith("/") || !/^[!-~]+$/.test(target)) return reply("400 Bad Request");
  let host = "";
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0 && l.slice(0, i).trim().toLowerCase() === "host") { host = l.slice(i + 1).trim().toLowerCase(); break; }
  }
  host = host.replace(/:\d+$/, "").replace(/\.+$/, "");
  if (!/^[a-z0-9.-]{1,253}$/.test(host)) return reply("400 Bad Request");
  const routed = customDomains.has(host)
    || [...APP_DOMAINS, ...DOMAINS].some((d) => host.endsWith("." + d));
  if (!routed) return reply("421 Misdirected Request", "", UNROUTED_BODY);
  reply("301 Moved Permanently", `Location: https://${host}${target}\r\n`);
}

function splice(client, origin, dep, path, hello) {
  // Someone reached this app. Recorded HERE rather than at accept() because
  // this is the first point a connection has a deployment to belong to - before
  // the SNI is read it is just a socket, and an unroutable one is nobody's
  // traffic. Every routed path lands here, so this is also the only place that
  // has to remember to do it. Address, time and (at teardown) how many bytes
  // moved: there is nothing else to see through a splice that never terminates
  // TLS, and the byte counts come free from the socket rather than from
  // watching the stream.
  const clog = connlog.note(dep, "in", client.remoteAddress, client.remotePort);
  const ws = new WebSocket(wsOrigin(origin) + path, { perMessageDeflate: false });
  const wsStream = createWebSocketStream(ws);
  // WS-open handshake timeout: a slow/never-opening enclave bridge must not pin
  // the client slot (MAX_CONNS) forever (fix 4; mirrors tcp6-relay's hsTimer).
  const hsTimer = setTimeout(() => { try { ws.terminate(); } catch {} client.destroy(); }, HS_MS);
  const close = () => {
    connlog.done(clog, client.bytesRead, client.bytesWritten);
    clearTimeout(hsTimer); client.destroy(); try { ws.terminate(); } catch {}
  };
  ws.on("unexpected-response", (_req, res) => {
    console.log(`[relay] ${dep} ${path} refused by enclave (HTTP ${res.statusCode})`);
    close();
  });
  client.on("error", close); client.on("close", close);
  wsStream.on("error", close); wsStream.on("close", close);
  ws.on("open", () => {
    clearTimeout(hsTimer);
    // idle timeout on the spliced connection: after a valid ClientHello a silent
    // client (or a stalled enclave side) must not hold a slot indefinitely (fix 4).
    client.setTimeout(IDLE_MS, close);
    wsStream.write(hello);                       // the buffered ClientHello goes first
    client.pipe(wsStream); wsStream.pipe(client);
  });
}

// Learn the fleet + the dep->enclave index BEFORE accepting, so the first
// connections can route; then keep both fresh.
await fleet.start();
await poll();
setInterval(poll, POLL_MS);
// custom-domain map: same "keep the last good answer" rule as the net-map poll
if (DOMAINS_API) {
  await pollDomains().catch(() => {});
  setInterval(() => pollDomains().catch(() => {}), Math.max(POLL_MS, 30_000)).unref?.();
  console.log(`[relay] custom domains via ${DOMAINS_API}/v1/domains/map`);
}

// Range entries skip ports that are busy or privileged-and-denied (a box that
// also runs sshd etc. keeps working); explicitly listed ports stay fatal so a
// typo'd config can't silently serve nothing.
let bound = 0, skipped = 0, pending = PORTS.length * LISTEN_ON.length;
const on = BIND_ADDRS.length ? ` on ${BIND_ADDRS.join(", ")}` : "";
const summary = () => console.log(
  `[relay] listening on ${bound} socket(s)${on} (${skipped} skipped); routing <sni>.${DOMAIN}/tls/<port> to the owning enclave (${originDeps.size} live)`);
for (const p of PORTS) {
  for (const addr of LISTEN_ON) {
    const at = addr ? `[${addr}]:${p.public}` : `:${p.public}`;
    const srv = net.createServer((c) => handle(c, p.logical));
    srv.on("error", (e) => {
      if (!p.quiet) { console.error(`fatal: listen ${at}: ${e.message}`); process.exit(1); }
      skipped++; if (--pending === 0) summary();
    });
    const cb = () => {
      if (!p.quiet) console.log(`[relay] ${at} -> <sni>.${DOMAIN}/tls/${p.logical}`);
      bound++; if (--pending === 0) summary();
    };
    if (addr) srv.listen(p.public, addr, cb); else srv.listen(p.public, cb);
  }
}
