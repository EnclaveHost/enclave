// Bring-your-own domains: a customer's OWN hostname (shop.example.com) serving
// their deployment, with a CA certificate minted inside the enclave that runs
// it. No masking, no iframes — the app answers on its own name, and the TLS
// key for that name never leaves the CVM.
//
// This is the relay-owned half: the record store, the ownership/routing proof,
// and the authorization gate that decides which names an enclave may mint a
// certificate for. The issuance itself lives in supervisor.js (in-enclave
// ACME), the SNI routing in relay/relay.js, and the customer-facing UI in
// site/components/deployments.
//
// WHY THREE DNS RECORDS. The customer creates:
//
//   example.com                     CNAME  <label>.app.enclave.host   (routing)
//   _acme-challenge.example.com     CNAME  _acme-challenge.<label>.app.enclave.host
//   _enclave-challenge.example.com  TXT    enclave-verify-<token>     (ownership)
//
// The first is how their traffic reaches us. The second DELEGATES certificate
// issuance to the zone we already run authoritatively (relay/dns-relay.js), so
// the enclave keeps using the dns-01 flow it already has — see the CA note
// below for why that matters more than the record count. The third proves this
// particular tenant asked for it: a CNAME alone is control of the name TODAY,
// but dangling CNAMEs outlive the tenants who set them, and without a token a
// stale record left pointing at our edge would let the next person to type that
// hostname into the dashboard collect a certificate for it.
//
// WHY dns-01 AND NOT tls-alpn-01. tls-alpn-01 would need no delegation record
// at all — the relay already peeks the ClientHello, so it could route an
// acme-tls/1 handshake to a challenge terminator in the CVM. But only Let's
// Encrypt and Google Trust Services offer it, and both cap DUPLICATE
// certificates (same exact name set) at 5 per week. CVMs have no disk: every
// release re-mints every key and re-issues every certificate (the trade that
// makes an exfiltratable key impossible), which is precisely why the platform
// runs on ZeroSSL, whose ACME has no such ceiling. Under tls-alpn-01 a
// customer's domain would go dark a day or two into any normal release week —
// a much worse outcome than one extra CNAME. So custom domains ride the
// existing dns-01 path and inherit its CA failover list unchanged.
//
// WHY THE DELEGATION TARGET IS THE APP'S OWN CHALLENGE NAME (rather than a
// per-domain alias): dns-relay's operator-signature path authorizes a TXT push
// at _acme-challenge.<label>.<zone> only when <label> is a hex prefix of a
// deployment the pusher holds the live on-chain lease for. Pointing every
// custom domain at that same name means a self-hosted seller box — which holds
// no fleet secret — can mint its tenants' custom-domain certificates with the
// authority it already has. A per-domain alias would have needed a new
// authorization rule there. Concurrent orders are fine: the challenge store
// keeps a SET of values per name and DELETE removes one value, not the name.
//
// TRUST MODEL. A hostname here is public information (it is in DNS and, once a
// certificate exists, in the CT logs), so the routing map is served openly —
// relay.js reads it with no credential. What is NOT public is the association
// between a hostname and an ACCOUNT: an add that collides with another
// tenant's domain gets the same generic refusal as a malformed one, so this
// endpoint can't be used to enumerate who hosts what.
//
// AUTH — the same three parties as relay/secrets.js, and deliberately the same
// shapes, so there is one owner-signature convention on this relay:
//   owner:  EIP-191 personal_sign over a canonical string; the recovered
//           address must equal the deployment's ON-CHAIN owner. Signatures
//           expire (<=10 min) and are single-use to expiry.
//   enclave: the lease-holder fetch (fleet HMAC and/or the endpoint's own
//           registry operator key), identical to a secrets fetch — the enclave
//           pulls the names it is allowed to mint for, and reports back what
//           issuance actually did.
//   nobody: GET /v1/domains/map (routing) and the loopback /internal/tls-ask
//           authorization gate, both read-only over already-public facts.
//
// Endpoints (relay-OWNED state: these answer with zero live enclaves, because
// an owner stages a domain long before the app that will serve it is running):
//   POST /v1/domains/:id            {hostname, expiry, signature}   attach
//   POST /v1/domains/:id/list       {expiry, signature}             list
//   POST /v1/domains/:id/verify     {hostname, expiry, signature}   re-check now
//   POST /v1/domains/:id/delete     {hostname, expiry, signature}   detach
//   POST /v1/domains/fetch          {id, endpoint, ts, sig, opSig, report?}
//   GET  /v1/domains/map                                            routing map
//
// Config (env): CUSTOM_DOMAINS=0 disables the feature; AUTH_DATA_DIR is the
// shared activation switch (as for accounts/billing/secrets); SECRETS_KEY is
// reused for the fleet-HMAC half of the enclave fetch (it authenticates the
// same party about the same deployments, and a second fleet key would be a
// second thing to rotate); DOMAIN_EDGE_IPS optionally pins the addresses an
// apex record must resolve to (default: learned from our own app zone).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { domainToASCII } from "node:url";
import { JsonStore, dataDir, dataFile, makeRateLimiter } from "./store.js";

// The wire/storage contract.
export const DOMAIN_LIMITS = {
  perDeployment: 10,      // attached hostnames per app
  maxHostname: 253,       // RFC 1035 total length
  maxLabel: 63,
};
export const CHALLENGE_PREFIX = "_enclave-challenge";
export const TOKEN_PREFIX = "enclave-verify-";
const SIG_TTL_SEC = 600, FETCH_SKEW_SEC = 300;

// Status machine (the four states the API and UI speak):
//   pending_dns  attached; the DNS proof is not (yet) in place
//   verified     ownership + routing proven; the enclave MAY mint a cert
//   active       a certificate exists and the enclave is serving the name
//   failed       repeated checks found nothing; still re-checked, but slowly
// active -> pending_dns is a DEMOTION, not an error: DNS that disappears must
// withdraw both the routing and the authorization to keep renewing.
export const STATUSES = ["pending_dns", "verified", "active", "failed"];

const SECRETS_KEY = (process.env.SECRETS_KEY || "").trim();
const DISABLED = /^(0|false|off|no)$/i.test((process.env.CUSTOM_DOMAINS ?? "1").trim());

// The zone customer records point AT, and the zones nobody may attach FROM.
// APP_DOMAIN is the same env api-relay/relay.js read; RESERVED_ZONES exists so
// a future zone can be fenced off without a code change.
const APP_DOMAINS = (process.env.APP_DOMAIN || "app.enclave.host").toLowerCase().split(",")
  .map((s) => s.trim().replace(/^\.+|\.+$/g, "")).filter(Boolean);
const APP_ZONE = APP_DOMAINS[0] || "app.enclave.host";
const RESERVED_ZONES = [...new Set([
  ...(process.env.RESERVED_ZONES || "enclave.host,nan.host").toLowerCase().split(",")
    .map((s) => s.trim().replace(/^\.+|\.+$/g, "")).filter(Boolean),
  ...APP_DOMAINS,
])];

// Hostnames that are structurally ours-or-nobody's, independent of the zones
// above: RFC 6761/8375 special-use names and the usual internal conventions.
// A tenant attaching one of these could only ever be trying to make our edge
// answer for a name that resolves differently inside somebody's network.
const RESERVED_SUFFIXES = ["local", "localhost", "internal", "intranet", "lan", "home", "corp",
                           "test", "example", "invalid", "onion", "alt", "home.arpa", "in-addr.arpa", "ip6.arpa"];

// ---------------------------------------------------------------------------
// PURE half — hostname normalization, validation, and the DNS verdicts. No I/O,
// no store access: this is what test/custom-domains.test.mjs exercises directly.
// ---------------------------------------------------------------------------

// An IPv4/IPv6 literal in any of the shapes a hostname field might carry one
// (bare, bracketed, zone-suffixed). Certificates for IP literals are a
// different product with different validation rules; more to the point, an IP
// here would let a tenant point our routing at an address they merely reached,
// not one they own.
function isIpLiteral(h) {
  if (/^\[.*\]$/.test(h)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^[0-9a-f:]+$/i.test(h) && h.includes(":")) return true;
  // a final label that is all digits cannot be a real TLD, and is how a
  // partially-written v4 literal ("10.0.0") arrives
  const last = h.split(".").pop() || "";
  return /^\d+$/.test(last);
}

// Fold a user-supplied hostname to its canonical wire form, or throw with the
// reason. IDN goes to punycode HERE and nowhere else, so the store, the
// certificate, the routing map and the comparison in relay.js all speak one
// spelling of a name (a Unicode label and its xn-- form must never be two rows).
export function normalizeHostname(raw) {
  let h = String(raw ?? "").trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "").replace(/\/.*$/, "");     // paste-tolerance: a pasted URL
  h = h.replace(/\.+$/, "");                                  // trailing root dot
  if (!h) throw new Error("Enter a hostname.");
  if (h.includes("@")) throw new Error("That looks like an email address, not a hostname.");
  if (h.includes(":")) {
    // a v6 literal is all colons and hex; anything else with a colon is a
    // pasted port or scheme remnant, and deserves the more useful message
    if (/^\[?[0-9a-f:]+\]?$/i.test(h)) throw new Error("Attach a hostname, not an IP address.");
    throw new Error("A hostname has no port or scheme — enter just the name (shop.example.com).");
  }
  if (h.includes("*")) throw new Error("Wildcard hostnames are not supported; attach each name you want to serve.");
  if (h.includes("_")) throw new Error("Underscores are not valid in a hostname.");
  // IDN -> A-label. domainToASCII returns "" for input it cannot represent,
  // which is also how it reports the malformed-punycode cases.
  const ascii = domainToASCII(h);
  if (!ascii) throw new Error("That is not a valid hostname.");
  h = ascii;
  if (h.length > DOMAIN_LIMITS.maxHostname) throw new Error(`A hostname is at most ${DOMAIN_LIMITS.maxHostname} characters.`);
  if (isIpLiteral(h)) throw new Error("Attach a hostname, not an IP address.");
  const labels = h.split(".");
  if (labels.length < 2) throw new Error("Use a fully-qualified hostname (example.com), not a single label.");
  for (const l of labels) {
    if (!l) throw new Error("That hostname has an empty label (a doubled dot).");
    if (l.length > DOMAIN_LIMITS.maxLabel) throw new Error(`"${l}" is longer than ${DOMAIN_LIMITS.maxLabel} characters.`);
    if (!/^[a-z0-9-]+$/.test(l)) throw new Error(`"${l}" contains characters that are not valid in a hostname.`);
    if (l.startsWith("-") || l.endsWith("-")) throw new Error(`"${l}" may not start or end with a hyphen.`);
  }
  return h;
}

// Is this one of OUR names? Certificates for the platform's own zones are
// minted by the platform, never on a tenant's say-so: authorizing one here
// would let any tenant obtain a certificate for api.enclave.host (and, with the
// routing that comes with it, serve their own content on it). Checked against
// the apex AND every subdomain, and applied at BOTH ends — the add endpoint
// refuses it, and the tls-ask gate refuses it again even if a record somehow
// existed.
export function isReservedHostname(h) {
  const host = String(h || "").toLowerCase().replace(/\.+$/, "");
  if (!host) return true;
  for (const z of RESERVED_ZONES) if (host === z || host.endsWith("." + z)) return true;
  for (const s of RESERVED_SUFFIXES) if (host === s || host.endsWith("." + s)) return true;
  return false;
}

// Full input check: normalize, then apply policy. Returns the canonical
// hostname or throws the message shown verbatim to the customer.
export function checkHostname(raw) {
  const h = normalizeHostname(raw);
  if (isReservedHostname(h))
    throw new Error("That hostname belongs to the platform. Attach a domain you control.");
  return h;
}

// The three records we tell the customer to create, for one deployment label.
export const routingTarget = (label) => `${label}.${APP_ZONE}`;
export const challengeHost = (hostname) => `${CHALLENGE_PREFIX}.${hostname}`;
export const acmeAliasFor  = (label) => `_acme-challenge.${label}.${APP_ZONE}`;
export const acmeDelegationHost = (hostname) => `_acme-challenge.${hostname}`;
export const mintToken = () => TOKEN_PREFIX + randomBytes(16).toString("hex");

// Does any TXT record at the challenge name carry our token? A TXT RR is a
// SEQUENCE of strings and resolvers hand it back in different shapes (joined,
// quoted, or split at 255 bytes), so compare against a concatenated,
// unquoted rendering of each record.
export function txtMatches(records, token) {
  if (!token) return false;
  for (const r of records || []) {
    const flat = String(r).replace(/"\s+"/g, "").replace(/^"|"$/g, "").trim();
    if (flat === token) return true;
  }
  return false;
}

// Does this hostname route to US? Two shapes are equivalent and both count:
//
//   CNAME  the record we asked for, or any name in our app zone. A subdomain
//          can hold a CNAME, so this is the normal case.
//   A/AAAA the address(es) our edge answers on. An APEX cannot hold a CNAME
//          (RFC 1034), so apex customers either use their provider's CNAME
//          FLATTENING — which publishes our edge's A/AAAA under their apex —
//          or set the A record by hand. Both arrive here as plain addresses
//          pointing at our edge, which is exactly as good a proof of routing.
//
// `edge` is the set of addresses our own app zone resolves to (learned, not
// hardcoded), so this keeps working the day the edge address changes.
export function routingMatches({ cnames = [], addrs = [] }, { target, edge = [] }) {
  const want = String(target || "").toLowerCase().replace(/\.+$/, "");
  for (const c of cnames) {
    const n = String(c).toLowerCase().replace(/\.+$/, "");
    if (n === want) return { ok: true, how: "cname" };
    if (APP_DOMAINS.some((z) => n === z || n.endsWith("." + z))) return { ok: true, how: "cname-zone" };
  }
  const edgeSet = new Set(edge.map((a) => String(a).toLowerCase()));
  for (const a of addrs) if (edgeSet.has(String(a).toLowerCase())) return { ok: true, how: "flattened" };
  return { ok: false, how: cnames.length ? "cname-elsewhere" : addrs.length ? "address-elsewhere" : "unresolved" };
}

// CAA is advisory here, never a hard failure: it is the single most common
// reason a correctly-pointed domain still cannot get a certificate, and the
// error the CA returns for it is opaque. If the zone publishes issue/issuewild
// records and none of them names a CA we actually use, say so BEFORE the order
// fails. An unparseable or empty CAA set means "no opinion" -> allowed.
const CA_ISSUERS = ["sectigo.com", "letsencrypt.org", "pki.goog"];
export function caaBlocks(records) {
  const issuers = [];
  for (const r of records || []) {
    const m = /^\s*\d+\s+(issue|issuewild)\s+"?([^"]*)"?\s*$/i.exec(String(r));
    if (m && m[2].trim()) issuers.push(m[2].trim().toLowerCase().split(";")[0].trim());
  }
  if (!issuers.length) return null;
  if (issuers.some((i) => CA_ISSUERS.some((ca) => i === ca || i.endsWith("." + ca)))) return null;
  return issuers;
}

// One record's verdict from its three lookups. Pure so the state machine is
// testable without DNS: the sweep does the I/O and hands the answers here.
export function evaluate({ txt, routing, caa, token, target, edge }) {
  const ownership = txtMatches(txt, token);
  const route = routingMatches(routing || {}, { target, edge });
  if (ownership && route.ok) return { ok: true, how: route.how, caa: caaBlocks(caa) };
  const hints = [];
  if (!ownership) hints.push(`No TXT record at ${CHALLENGE_PREFIX}.<your domain> carrying this domain's token yet.`);
  if (!route.ok) hints.push({
    "cname-elsewhere":  `The hostname resolves, but its CNAME does not point at ${target}.`,
    "address-elsewhere": `The hostname resolves to an address that is not our edge. For an apex, use CNAME flattening or point A/AAAA at our edge.`,
    unresolved:         `The hostname does not resolve yet. Add the CNAME to ${target} (DNS can take a few minutes to publish).`,
  }[route.how]);
  return { ok: false, how: route.how, caa: caaBlocks(caa), reason: hints.filter(Boolean).join(" ") };
}

// ---------------------------------------------------------------------------
// STORE + I/O half
// ---------------------------------------------------------------------------

let store = null;                 // JsonStore { byHost: { <hostname>: record } }
let enabled = false;
export const domainsEnabled = () => enabled;

const rlOwner  = makeRateLimiter({ capacity: 20, refillPerSec: 20 / 300 });   // per wallet: 20 burst, 4/min sustained
const rlAdd    = makeRateLimiter({ capacity: 10, refillPerSec: 10 / 600 });   // per wallet, attach/verify only (each costs DNS lookups)
const rlIp     = makeRateLimiter({ capacity: 60, refillPerSec: 1 });          // per source ip
const rlFetch  = makeRateLimiter({ capacity: 120, refillPerSec: 10 });        // fleet traffic
const rlMap    = makeRateLimiter({ capacity: 120, refillPerSec: 4 });         // routing map readers

export async function initDomains() {
  const dir = dataDir();
  if (DISABLED || !dir) {
    console.log(`[domains] disabled (${DISABLED ? "CUSTOM_DOMAINS=0" : "no writable AUTH_DATA_DIR"}) — custom domains 503`);
    return;
  }
  store = new JsonStore(dataFile(dir, "domains.json"), { byHost: {} }, { durable: true });
  enabled = true;
  const rows = Object.values(store.data.byHost);
  const live = rows.filter((r) => r.status === "active" || r.status === "verified").length;
  console.log(`[domains] enabled — ${rows.length} attached, ${live} serving (routing target zone ${APP_ZONE})`);
}

// The deployment label a hostname points at: the first 8 hex of an on-chain id,
// mirroring supervisor appCertLabel / api-relay depFromHost. One spelling of
// this rule per process; they are pinned against each other in the tests.
export const labelFor = (id) => {
  const s = String(id).toLowerCase();
  return s.startsWith("0x") ? s.slice(2, 10) : s.replace(/^dep[-_]/, "");
};

const recOf = (host) => (store?.data.byHost || {})[host] || null;
const rowsFor = (depId) => Object.values(store?.data.byHost || {})
  .filter((r) => r.deploymentId === depId)
  .sort((a, b) => a.createdAt - b.createdAt);

// What the API returns for one record. The token is included only for the
// OWNER's own views (they need it to create the TXT); every other surface —
// the routing map, the fetch, the ask gate — must not carry it.
const publicView = (r) => ({
  hostname: r.hostname,
  status: r.status,
  token: r.token,
  records: {
    routing:   { type: "CNAME", name: r.hostname, value: routingTarget(labelFor(r.deploymentId)),
                 note: "An apex domain cannot hold a CNAME: use your provider's CNAME flattening, or point A/AAAA at our edge." },
    challenge: { type: "TXT",   name: challengeHost(r.hostname), value: r.token },
    acme:      { type: "CNAME", name: acmeDelegationHost(r.hostname), value: acmeAliasFor(labelFor(r.deploymentId)),
                 note: "Delegates certificate issuance and renewal; leave it in place." },
  },
  createdAt: new Date(r.createdAt).toISOString(),
  verifiedAt: r.verifiedAt ? new Date(r.verifiedAt).toISOString() : null,
  checkedAt: r.checkedAt ? new Date(r.checkedAt).toISOString() : null,
  lastError: r.lastError || null,
  caaWarning: r.caaWarning || null,
  certificate: r.cert ? { ok: !!r.cert.ok, ca: r.cert.ca || null, error: r.cert.error || null,
                          at: r.cert.at ? new Date(r.cert.at).toISOString() : null } : null,
});

// hostname -> deployment id, for routing. Both verified and active are routed:
// a verified name whose certificate has not landed yet fails closed at the
// enclave (sniDecide refuses it) rather than at the relay, which keeps the
// "unknown name is refused, known name is either right or refused" story whole.
export function domainMap() {
  const out = {};
  if (!enabled) return out;
  for (const r of Object.values(store.data.byHost))
    if (r.status === "verified" || r.status === "active") out[r.hostname] = r.deploymentId;
  return out;
}

// One hostname's deployment, for the request path (a per-request domainMap()
// would rebuild the whole object to answer one lookup). Same rule as the map:
// verified and active route, everything else is unknown.
export function domainDeployment(hostname) {
  if (!enabled) return null;
  const h = String(hostname || "").toLowerCase().split(":")[0].replace(/\.+$/, "");
  const r = recOf(h);
  return r && (r.status === "verified" || r.status === "active") ? r.deploymentId : null;
}

// The certificate-authorization gate. This is the "ask" endpoint of Caddy's
// on_demand_tls / certmagic's DecisionFunc, in the shape this stack needs: it
// answers only from memory (a DNS lookup here would put a network round trip in
// front of every TLS handshake), it says yes ONLY for a name whose ownership
// and routing we have actually proven, and it says no for our own zones no
// matter what any record claims.
export function tlsAskAllowed(hostname) {
  if (!enabled) return false;
  const h = String(hostname || "").toLowerCase().replace(/\.+$/, "").split(":")[0];
  if (!h || isReservedHostname(h)) return false;
  const r = recOf(h);
  return !!r && (r.status === "verified" || r.status === "active");
}

// The names one deployment's enclave may mint certificates for.
export const certNamesFor = (depId) => rowsFor(String(depId).toLowerCase())
  .filter((r) => r.status === "verified" || r.status === "active")
  .map((r) => r.hostname);

// --- DNS over HTTPS ---------------------------------------------------------
// Deliberately NOT the system resolver: this box runs the platform's own
// authoritative daemon on :53, and a verification that consulted it could
// confirm our own zone instead of the customer's. DoH also gives us the CNAME
// chain in one answer, which is what the apex/flattening rule needs to see.
const DOH_RESOLVERS = (process.env.DOMAIN_DOH_RESOLVERS
  || "https://cloudflare-dns.com/dns-query,https://dns.google/resolve")
  .split(",").map((s) => s.trim()).filter(Boolean);
const TYPE = { A: 1, AAAA: 28, CNAME: 5, TXT: 16, CAA: 257 };

async function dohOnce(resolver, name, type) {
  const url = `${resolver}?name=${encodeURIComponent(name)}&type=${type}`;
  const r = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const b = await r.json();
  // NXDOMAIN (3) is a real answer, not an error: the name genuinely is not
  // there. Anything else non-zero is a resolver problem -> try the next one.
  if (b.Status !== 0 && b.Status !== 3) throw new Error(`rcode ${b.Status}`);
  return { nxdomain: b.Status === 3, answers: Array.isArray(b.Answer) ? b.Answer : [] };
}
// First resolver that answers wins; an error from all of them is `null`, which
// the sweep treats as "no information" rather than "the record is gone".
async function doh(name, type) {
  let last = null;
  for (const r of DOH_RESOLVERS) {
    try { return await dohOnce(r, name, type); }
    catch (e) { last = e; }
  }
  console.warn(`[domains] DoH lookup failed for ${name}/${type}: ${last?.message || "unknown"}`);
  return null;
}
const dataOf = (answers, type) => (answers || []).filter((a) => a.type === type).map((a) => String(a.data || ""));

// Our own edge addresses, learned by resolving a name in our app zone (the
// zone is a wildcard, so any label answers). Cached; on a lookup failure the
// last known set is kept, because "we could not resolve ourselves" must not
// invalidate every customer's apex record.
let _edge = { addrs: [], at: 0 };
const EDGE_TTL_MS = 5 * 60_000;
const EDGE_PIN = (process.env.DOMAIN_EDGE_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);
async function edgeAddrs() {
  if (EDGE_PIN.length) return EDGE_PIN;
  if (Date.now() - _edge.at < EDGE_TTL_MS && _edge.addrs.length) return _edge.addrs;
  const probe = `edge-probe.${APP_ZONE}`;
  const [a, aaaa] = await Promise.all([doh(probe, TYPE.A), doh(probe, TYPE.AAAA)]);
  const addrs = [...dataOf(a?.answers, TYPE.A), ...dataOf(aaaa?.answers, TYPE.AAAA)];
  if (addrs.length) _edge = { addrs, at: Date.now() };
  else if (!_edge.addrs.length) console.warn(`[domains] could not learn our own edge addresses from ${probe} — apex (flattened) verification will not pass until it resolves`);
  return _edge.addrs;
}

// One record's three lookups, then the pure verdict.
async function checkRecord(rec) {
  const target = routingTarget(labelFor(rec.deploymentId));
  const [txt, route, caa, edge] = await Promise.all([
    doh(challengeHost(rec.hostname), TYPE.TXT),
    doh(rec.hostname, TYPE.A),                 // the answer carries the CNAME chain too
    doh(rec.hostname, TYPE.CAA),
    edgeAddrs(),
  ]);
  // Every lookup failing is a local network problem, not a customer error.
  if (!txt && !route) return { indeterminate: true };
  const aaaa = (route && !dataOf(route.answers, TYPE.A).length) ? await doh(rec.hostname, TYPE.AAAA) : null;
  return evaluate({
    txt: dataOf(txt?.answers, TYPE.TXT),
    routing: { cnames: dataOf(route?.answers, TYPE.CNAME),
               addrs: [...dataOf(route?.answers, TYPE.A), ...dataOf(aaaa?.answers, TYPE.AAAA)] },
    caa: dataOf(caa?.answers, TYPE.CAA),
    token: rec.token, target, edge,
  });
}

// Apply a verdict to a record. This is the whole status machine, in one place.
//   pending/failed + ok        -> verified   (the enclave may now mint)
//   active/verified + !ok      -> strike; at the limit, demote to pending_dns
//   pending + !ok repeatedly   -> failed     (still checked, just slowly)
// DEMOTION IS DELIBERATELY SLOW: DNS is not reliable enough to withdraw a
// customer's live routing on one bad answer, and an indeterminate lookup (our
// own resolvers unreachable) is not a strike at all.
const DEMOTE_STRIKES = 5;          // ~1h15m of failed checks for a live domain
const FAIL_STRIKES   = 24;         // pending domain nobody is fixing
function applyVerdict(rec, v) {
  rec.checkedAt = Date.now();
  if (v.indeterminate) return false;
  rec.caaWarning = v.caa ? `The domain's CAA records only allow ${v.caa.join(", ")}. Add a CAA record for sectigo.com (or remove the restriction) or the certificate order will be refused.` : null;
  if (v.ok) {
    const was = rec.status;
    rec.strikes = 0;
    rec.lastError = null;
    if (was !== "active") { rec.status = "verified"; rec.verifiedAt = rec.verifiedAt || Date.now(); }
    if (was !== rec.status) console.log(`[domains] ${rec.hostname} ${was} -> ${rec.status} (${v.how})`);
    return was !== rec.status;
  }
  rec.strikes = (rec.strikes || 0) + 1;
  rec.lastError = v.reason || "The DNS records for this domain could not be confirmed.";
  const wasLive = rec.status === "active" || rec.status === "verified";
  if (wasLive && rec.strikes >= DEMOTE_STRIKES) {
    rec.status = "pending_dns";
    rec.verifiedAt = null;
    rec.cert = null;
    console.log(`[domains] ${rec.hostname} demoted to pending_dns after ${rec.strikes} failed checks — routing and certificate authorization withdrawn`);
    return true;
  }
  if (!wasLive && rec.status !== "failed" && rec.strikes >= FAIL_STRIKES) {
    rec.status = "failed";
    console.log(`[domains] ${rec.hostname} -> failed after ${rec.strikes} checks`);
    return true;
  }
  return false;
}

// How long before a record is looked at again. A freshly attached domain is
// checked often (the customer is watching the dashboard); a settled one rarely.
function dueIn(rec) {
  if (rec.status === "pending_dns") return (Date.now() - rec.createdAt < 15 * 60_000) ? 30_000 : 5 * 60_000;
  if (rec.status === "failed") return 60 * 60_000;
  return 15 * 60_000;
}
const isDue = (rec, now) => now - (rec.checkedAt || 0) >= dueIn(rec);

const SWEEP_MS = 30_000, SWEEP_BATCH = 12;
export function startDomainSweep(ctx) {
  if (!enabled) return;
  const tick = async () => {
    const now = Date.now();
    const due = Object.values(store.data.byHost).filter((r) => isDue(r, now)).slice(0, SWEEP_BATCH);
    if (!due.length) return;
    let dirty = false;
    for (const rec of due) {
      // applyVerdict always stamps checkedAt, so any completed check is a write
      try { applyVerdict(rec, await checkRecord(rec)); dirty = true; }
      catch (e) { console.warn(`[domains] check ${rec.hostname}: ${e.message}`); }
    }
    if (dirty) store.saveSoon();
  };
  setInterval(() => { tick().catch((e) => console.error("[domains] sweep:", e.message)); }, SWEEP_MS).unref?.();
  // Off-ledger purge, mirroring the secrets sweep: a deployment that leaves the
  // ledger entirely takes its domains with it after a grace period.
  setInterval(async () => {
    let rows; try { rows = await ctx.ledgerRows(); } catch { return; }
    if (!rows.length) return;                        // an empty read is an RPC hiccup, not an empty chain
    const onLedger = new Set(rows.map((d) => String(d.id).toLowerCase()));
    let dirty = false;
    for (const [host, rec] of Object.entries(store.data.byHost)) {
      if (onLedger.has(rec.deploymentId)) { if (rec.missingSince) { delete rec.missingSince; dirty = true; } continue; }
      if (!rec.missingSince) { rec.missingSince = Date.now(); dirty = true; }
      else if (Date.now() - rec.missingSince > 7 * 86400_000) {
        delete store.data.byHost[host]; dirty = true;
        console.log(`[domains] purged ${host} (deployment off-ledger > 7d)`);
      }
    }
    if (dirty) store.saveSoon();
  }, 3600_000).unref?.();
}

// --- HTTP layer -------------------------------------------------------------

const bad = (ctx, res, req, code, error, message) => ctx.json(res, code, { error, message }, req);

export const addMessage    = (id, expiry, hostname) => `enclave-domains:add:${id}:${expiry}:${hostname}`;
export const listMessage   = (id, expiry) => `enclave-domains:list:${id}:${expiry}`;
export const verifyMessage = (id, expiry, hostname) => `enclave-domains:verify:${id}:${expiry}:${hostname}`;
export const deleteMessage = (id, expiry, hostname) => `enclave-domains:del:${id}:${expiry}:${hostname}`;
export const fetchSig = (keyHex, id, endpoint, ts) =>
  createHmac("sha256", createHmac("sha256", Buffer.from(keyHex, "hex")).update("domains-fetch v1").digest())
    .update(`${id}:${endpoint}:${ts}`).digest("hex");

// single-use owner signatures, as in secrets.js
const seenSigs = new Map();
function sigFresh(signature, expiry) {
  const now = Math.floor(Date.now() / 1000);
  if (seenSigs.size > 10_000) for (const [k, e] of seenSigs) if (e < now) seenSigs.delete(k);
  const mark = createHash("sha256").update(signature).digest("base64");
  if (seenSigs.has(mark)) return false;
  seenSigs.set(mark, expiry);
  return true;
}

async function rowOf(ctx, id, { fresh = false } = {}) {
  if (fresh) ctx.ledgerExpire();
  let rows; try { rows = await ctx.ledgerRows(); } catch { return null; }
  return rows.find((d) => String(d.id).toLowerCase() === id) || null;
}

// Owner gate — identical in shape to secrets.js ownerGate (one convention for
// owner-signed relay calls; the message string is what differs).
async function ownerGate(ctx, req, res, id, b, message) {
  const now = Math.floor(Date.now() / 1000);
  const expiry = parseInt(b.expiry, 10);
  const signature = String(b.signature || "");
  if (!Number.isFinite(expiry) || expiry < now || expiry > now + SIG_TTL_SEC)
    return bad(ctx, res, req, 422, "bad_expiry", `expiry must be a unix time within the next ${SIG_TTL_SEC / 60} minutes.`), null;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
    return bad(ctx, res, req, 422, "bad_sig", "signature must be a 65-byte personal_sign hex."), null;
  let address;
  try {
    const { recoverMessageAddress } = await import("viem");
    address = (await recoverMessageAddress({ message, signature })).toLowerCase();
  } catch (e) { return bad(ctx, res, req, 400, "bad_sig", "Could not recover the signer: " + (e.shortMessage || e.message)), null; }
  if (!rlOwner(address))
    return bad(ctx, res, req, 429, "rate_limited", "Too many domain requests from this wallet; retry shortly."), null;
  let d = await rowOf(ctx, id);
  if (!d) d = await rowOf(ctx, id, { fresh: true });
  if (!d) return bad(ctx, res, req, 404, "not_found", `No deployment ${id} on the ledger.`), null;
  if (String(d.owner).toLowerCase() !== address)
    return bad(ctx, res, req, 403, "not_owner", "The signer does not own this deployment."), null;
  if (!sigFresh(signature, expiry))
    return bad(ctx, res, req, 409, "sig_replayed", "This signature was already used; sign a fresh request."), null;
  return { d, address };
}

export async function handleDomains(req, res, u, ctx) {
  if (u.pathname === "/v1/domains/map" && req.method === "GET") {
    if (!rlMap(ctx.clientIp(req))) return bad(ctx, res, req, 429, "rate_limited", "Too many map reads; retry shortly.");
    // Public by design: every hostname here is already in DNS and in the CT
    // logs, and relay.js must be able to read it with no credential to route.
    return ctx.json(res, 200, { updatedAt: new Date().toISOString(), zone: APP_ZONE, domains: domainMap() }, req);
  }
  if (!enabled)
    return bad(ctx, res, req, 503, "domains_disabled", "Custom domains are not configured on this relay.");
  if (req.method !== "POST")
    return bad(ctx, res, req, 405, "method_not_allowed", "Domain endpoints are POST-only (signatures never belong in URLs).");
  if (!rlIp(ctx.clientIp(req)))
    return bad(ctx, res, req, 429, "rate_limited", "Too many domain requests; retry shortly.");
  let raw; try { raw = await ctx.readBody(req, 16384); } catch (e) { return bad(ctx, res, req, 413, "too_large", e.message); }
  let b; try { b = JSON.parse(raw.toString() || "{}"); } catch { return bad(ctx, res, req, 400, "bad_json", "Body must be JSON."); }

  if (u.pathname === "/v1/domains/fetch") return handleFetch(req, res, b, ctx);

  const m = u.pathname.match(/^\/v1\/domains\/(0x[0-9a-fA-F]{64})(?:\/(list|verify|delete))?$/);
  if (!m) return bad(ctx, res, req, 404, "not_found", "POST /v1/domains/:id, /:id/list, /:id/verify, /:id/delete, or /v1/domains/fetch.");
  const id = m[1].toLowerCase(), action = m[2] || "add";
  const expiry = parseInt(b.expiry, 10);

  if (action === "list") {
    const gate = await ownerGate(ctx, req, res, id, b, listMessage(id, expiry));
    if (!gate) return;
    return ctx.json(res, 200, { id, label: labelFor(id), zone: APP_ZONE,
      limit: DOMAIN_LIMITS.perDeployment, domains: rowsFor(id).map(publicView) }, req);
  }

  // Every remaining action names a hostname. Normalize BEFORE the signature
  // check so the signed message and the stored key are the same canonical
  // spelling — a customer typing "EXAMPLE.com " must not produce a signature
  // over a string that never matches a record again.
  let hostname;
  try { hostname = checkHostname(b.hostname); }
  catch (e) { return bad(ctx, res, req, 422, "bad_hostname", e.message); }

  if (action === "delete") {
    const gate = await ownerGate(ctx, req, res, id, b, deleteMessage(id, expiry, hostname));
    if (!gate) return;
    const rec = recOf(hostname);
    if (!rec || rec.deploymentId !== id)
      return bad(ctx, res, req, 404, "not_attached", "That hostname is not attached to this deployment.");
    delete store.data.byHost[hostname];
    store.flush();
    // The enclave drops the certificate on its next fetch (it holds them in
    // memory only, so "forgetting" is what happens by default); the relay stops
    // routing the name as soon as the map is re-read.
    console.log(`[domains] ${hostname} detached from ${id}`);
    return ctx.json(res, 200, { id, hostname, detached: true,
      note: "Routing stops within a minute and the certificate is dropped at the enclave. Remove the DNS records at your provider too." }, req);
  }

  if (action === "verify") {
    const gate = await ownerGate(ctx, req, res, id, b, verifyMessage(id, expiry, hostname));
    if (!gate) return;
    if (!rlAdd(gate.address))
      return bad(ctx, res, req, 429, "rate_limited", "Too many verification attempts; they run automatically every few minutes.");
    const rec = recOf(hostname);
    if (!rec || rec.deploymentId !== id)
      return bad(ctx, res, req, 404, "not_attached", "That hostname is not attached to this deployment.");
    if (rec.status === "failed") { rec.status = "pending_dns"; rec.strikes = 0; }
    const v = await checkRecord(rec);
    applyVerdict(rec, v);
    store.saveSoon();
    return ctx.json(res, 200, { id, ...publicView(rec) }, req);
  }

  // attach
  const gate = await ownerGate(ctx, req, res, id, b, addMessage(id, expiry, hostname));
  if (!gate) return;
  if (!rlAdd(gate.address))
    return bad(ctx, res, req, 429, "rate_limited", "Too many domains attached from this wallet; retry shortly.");
  const existing = recOf(hostname);
  if (existing) {
    // SAME owner: say exactly what is going on, they can act on it. ANOTHER
    // tenant: the SAME refusal a reserved name gets, with no hint that a record
    // exists — this endpoint must not become a way to ask "who hosts X?".
    if (existing.deploymentId === id)
      return ctx.json(res, 200, { id, ...publicView(existing), note: "Already attached." }, req);
    const other = await rowOf(ctx, existing.deploymentId);
    if (other && String(other.owner).toLowerCase() === gate.address)
      return bad(ctx, res, req, 409, "attached_elsewhere",
        `That hostname is attached to your deployment ${existing.deploymentId.slice(0, 10)}…. Detach it there first.`);
    return bad(ctx, res, req, 409, "unavailable",
      "That hostname is not available. If you control it, remove it from wherever it is attached and try again.");
  }
  const mine = rowsFor(id);
  if (mine.length >= DOMAIN_LIMITS.perDeployment)
    return bad(ctx, res, req, 409, "limit_reached",
      `This deployment already has ${DOMAIN_LIMITS.perDeployment} domains attached; detach one first.`);
  const rec = {
    hostname, deploymentId: id, token: mintToken(), status: "pending_dns",
    createdAt: Date.now(), verifiedAt: null, checkedAt: null, strikes: 0,
    lastError: null, caaWarning: null, cert: null,
  };
  store.data.byHost[hostname] = rec;
  store.flush();
  console.log(`[domains] ${hostname} attached to ${id} (pending_dns)`);
  // One immediate check: a customer who set the records before attaching gets
  // "verified" straight out of the add call instead of waiting for the sweep.
  try { applyVerdict(rec, await checkRecord(rec)); store.saveSoon(); } catch { /* the sweep retries */ }
  return ctx.json(res, 201, { id, ...publicView(rec) }, req);
}

// The lease-holder fetch: an enclave asks which custom names it should be
// serving (and minting certificates for) on behalf of a deployment it runs, and
// reports back what issuance did. Authentication is byte-for-byte the secrets
// fetch's — see relay/secrets.js for why EITHER factor opens it and why the
// on-chain lease is what actually scopes it.
async function handleFetch(req, res, b, ctx) {
  if (!rlFetch(ctx.clientIp(req)))
    return bad(ctx, res, req, 429, "rate_limited", "Too many domain fetches; retry shortly.");
  const id = String(b.id || "").toLowerCase();
  const endpoint = String(b.endpoint || "").replace(/\/+$/, "");
  const ts = parseInt(b.ts, 10);
  const sig = String(b.sig || "");
  if (!/^0x[0-9a-f]{64}$/.test(id)) return bad(ctx, res, req, 422, "bad_id", "id must be a bytes32 deployment id.");
  if (!/^https?:\/\//.test(endpoint)) return bad(ctx, res, req, 422, "bad_endpoint", "endpoint must be the enclave's registered origin.");
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > FETCH_SKEW_SEC)
    return bad(ctx, res, req, 422, "bad_ts", `ts must be a unix time within ±${FETCH_SKEW_SEC}s.`);
  let fleetOk = false;
  if (/^[0-9a-f]{64}$/i.test(SECRETS_KEY) && /^[0-9a-f]{64}$/.test(sig))
    fleetOk = timingSafeEqual(Buffer.from(fetchSig(SECRETS_KEY, id, endpoint, ts), "hex"), Buffer.from(sig, "hex"));
  let opOk = false;
  if (ctx.operatorOfEndpoint) {
    let owner = null;
    try { owner = await ctx.operatorOfEndpoint(endpoint); } catch { owner = null; }
    if (owner && typeof b.opSig === "string" && /^0x[0-9a-fA-F]{130}$/.test(b.opSig)) {
      try {
        const { recoverMessageAddress } = await import("viem");
        const signer = (await recoverMessageAddress({
          message: `enclave-domains-fetch:${id}:${endpoint}:${ts}`, signature: b.opSig })).toLowerCase();
        if (signer !== String(owner).toLowerCase())
          return bad(ctx, res, req, 403, "wrong_operator", `The fetch is signed by ${signer}, but ${endpoint} is registered to ${owner}.`);
        opOk = true;
      } catch { /* falls through to the refusal below */ }
    }
  }
  if (!fleetOk && !opOk)
    return bad(ctx, res, req, 401, "bad_fetch_sig",
      "The fetch carries neither a valid fleet HMAC nor a signature by this endpoint's registered operator.");
  const epId = String(await ctx.endpointIdOf(endpoint)).toLowerCase();
  const holds = (row) => row && !/^0x0+$/.test(String(row.runner)) && Number(row.leaseUntil) * 1000 > Date.now()
    && String(row.runner).toLowerCase() === epId;
  let d = await rowOf(ctx, id);
  if (!holds(d)) d = await rowOf(ctx, id, { fresh: true });
  if (!d) return bad(ctx, res, req, 404, "not_found", `No deployment ${id} on the ledger.`);
  if (!holds(d)) return bad(ctx, res, req, 409, "not_lease_holder", "This endpoint does not hold the deployment's live lease.");

  // Issuance report (optional): the enclave says what happened to each name it
  // tried. This is the ONLY way a customer learns that a CA refused their
  // domain, so it is stored verbatim against the record and surfaced in the
  // dashboard. A report can only ever touch names attached to THIS deployment.
  if (Array.isArray(b.report)) {
    let dirty = false;
    for (const item of b.report.slice(0, DOMAIN_LIMITS.perDeployment)) {
      const host = String(item?.hostname || "").toLowerCase().replace(/\.+$/, "");
      const rec = recOf(host);
      if (!rec || rec.deploymentId !== id) continue;
      const ok = item.ok === true;
      rec.cert = { ok, ca: String(item.ca || "").slice(0, 64) || null,
                   error: ok ? null : String(item.error || "").slice(0, 300) || "issuance failed",
                   at: Date.now() };
      // "active" means a certificate exists and this enclave is serving it —
      // the only transition into it, and it needs the name verified first.
      if (ok && rec.status === "verified") { rec.status = "active"; console.log(`[domains] ${host} active (cert from ${rec.cert.ca || "ca"})`); }
      if (!ok && rec.status === "active") rec.status = "verified";
      dirty = true;
    }
    if (dirty) store.saveSoon();
  }
  return ctx.json(res, 200, { id,
    zone: APP_ZONE,
    challengeAlias: acmeAliasFor(labelFor(id)),
    domains: certNamesFor(id) }, req);
}
