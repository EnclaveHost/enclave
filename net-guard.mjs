// net-guard — SSRF destination classifier for dedicated-IP egress (guardrail 2).
//
// CANONICAL COPY. Imported by egress.js (enclave-side, checks literal-IP
// destinations before they leave the CVM) AND by relay/egress-relay.js on the
// relay box (checks each address DNS resolves to, before dialling). relay/
// deploy.sh ships this exact file to the relay box, so there is ONE source of
// truth — do not fork it.
//
// Policy: allow only globally-routable unicast. Refuse loopback, link-local,
// unique-local (ULA), private (RFC1918 / CGNAT), documentation/benchmark, and
// multicast — the ranges an app could use to pivot into the enclave's or the
// relay box's own localhost / private-network services. v4-mapped and
// NAT64-mapped IPv6 are unwrapped and judged by their embedded v4 address, so
// `::ffff:127.0.0.1` can't sneak loopback past the v6 path.

const v4mask = (bits) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);

function inV4(n, cidr, bits) { return (n & v4mask(bits)) === (cidr & v4mask(bits)); }

// Private / non-global IPv4 ranges (RFC 1918/5735/6598/etc.)
function blockedV4(n) {
  const R = [
    [0x00000000, 8],  [0x0a000000, 8],  [0x64400000, 10], [0x7f000000, 8],
    [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
    [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
    [0xcb007100, 24], [0xe0000000, 4],  [0xf0000000, 4],
  ];
  return R.some(([c, b]) => inV4(n >>> 0, c >>> 0, b));
}

const B = (hexOrBig) => (typeof hexOrBig === "bigint" ? hexOrBig : BigInt(hexOrBig));
function inV6(n, prefixBig, bits) {
  const mask = bits === 0 ? 0n : ((~0n) << BigInt(128 - bits)) & ((1n << 128n) - 1n);
  return (n & mask) === (prefixBig & mask);
}

function blockedV6(n) {
  if (n === 0n || n === 1n) return true;                    // :: and ::1
  if (n < (1n << 96n)) return true;                         // ::/96 (v4-compat, deprecated + non-global)
  // NOTE (dead-code removal): a v4-mapped `::ffff:a.b.c.d` branch used to sit here
  // (`if (inV6(n, 0xffffn<<32n, 96)) return blockedV4(...)`). It was UNREACHABLE:
  // every v4-mapped address (`::ffff:0:0/96`) is < 2^96, so the `n < 2^96` guard
  // above already returns true for all of them. Removing it changes nothing —
  // v4-mapped addresses stay blocked wholesale (a deliberate, harmless over-block;
  // `::ffff:127.0.0.1` still can't reach loopback). Do NOT re-add a per-embedded-v4
  // check; it would never run. The NAT64 line below is left exactly as-is.
  if (inV6(n, 0x0064ff9bn << 64n, 96)) return blockedV4(Number(n & 0xffffffffn));
  if (inV6(n, 0x0100n << 112n, 64)) return true;            // 100::/64 discard-only
  if (inV6(n, 0x20010db8n << 96n, 32)) return true;         // 2001:db8::/32 documentation
  if (inV6(n, 0xfc00n << 112n, 7)) return true;             // fc00::/7 unique-local
  if (inV6(n, 0xfe80n << 112n, 10)) return true;            // fe80::/10 link-local
  if (inV6(n, 0xff00n << 112n, 8)) return true;             // ff00::/8 multicast
  return false;                                             // global unicast
}

// parseIp("1.2.3.4") -> {family:4, value:Number}; parseIp("2a01::1") ->
// {family:6, value:BigInt}. Returns null if `s` is not a bare IP literal.
export function parseIp(s) {
  if (typeof s !== "string") return null;
  s = s.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const o = s.split(".").map(Number);
    if (o.some((x) => x > 255)) return null;
    return { family: 4, value: ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0 };
  }
  if (s.includes(":")) {
    try { return { family: 6, value: v6ToBig(s) }; } catch { return null; }
  }
  return null;
}

function v6ToBig(s) {
  // support an embedded IPv4 tail (e.g. ::ffff:1.2.3.4)
  let tailV4 = null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIp(tail);
    if (!v4 || v4.family !== 4) throw new Error("bad v4 tail");
    tailV4 = v4.value;
    s = s.slice(0, lastColon + 1) + ((v4.value >>> 16).toString(16)) + ":" + ((v4.value & 0xffff).toString(16));
  }
  const dbl = s.split("::");
  if (dbl.length > 2) throw new Error("multiple ::");
  const head = dbl[0] ? dbl[0].split(":").filter(Boolean) : [];
  const rest = dbl.length === 2 ? (dbl[1] ? dbl[1].split(":").filter(Boolean) : []) : null;
  let groups;
  if (rest === null) { groups = head; }
  else { const mid = Array(8 - head.length - rest.length).fill("0"); groups = [...head, ...mid, ...rest]; }
  if (groups.length !== 8) throw new Error("bad group count");
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) throw new Error("bad group");
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  void tailV4;
  return n;
}

// isBlockedHost — the SSRF gate. `host` is a literal IP or a domain name.
// Domains other than localhost are ALLOWED here and re-checked after the relay
// resolves them (we can't judge an unresolved name; the relay sees the real IP).
export function isBlockedHost(host) {
  if (typeof host !== "string" || !host) return true;
  const h = host.toLowerCase().replace(/\.$/, "");
  const ip = parseIp(host);
  if (ip) return ip.family === 4 ? blockedV4(ip.value) : blockedV6(ip.value);
  return h === "localhost" || h.endsWith(".localhost");
}

/* ---- "is this address one of MINE?" ----------------------------------------
   Three relays are handed an address over the network and then bind it: the
   tcp6 and udp relays bind it as a LISTENER (from each enclave's /v1/net-map),
   and the egress relay SOURCE-binds it (from its control channel). In every
   case the enclave derives the address from an authenticated deployment id, so
   the value is normally right - but "normally right" is not the property that
   matters when the sender is a fleet member that could be rogue or
   compromised. Whoever picks the address picks which local address:port this
   production box serves, and a wildcard (`::`) or loopback (`::1`) answer turns
   one deployment's bridge into an interceptor for traffic that was never its.

   The policy has one source wherever there is one to have: if the operator
   declared a prefix, membership in it IS the test. That declaration is local
   config - the attacker supplies the address, never the /64 - so a box whose
   TCP6_PREFIX is its real routed /64 refuses loopback, wildcard, IPv4 and every
   other box's address by the same check, and a local test rig can legitimately
   declare `::1/128` and bind exactly loopback.

   With no prefix declared there is nothing to check against, so bindRefusal
   falls back to the global-unicast table: wildcard, loopback, link-local, ULA,
   multicast. Two rules hold either way, because no declaration makes them
   sensible - the address must be IPv6 (isBlockedHost alone would pass a public
   v4, this box's OWN public v4 included) and it must not be the unspecified
   address, which is never one deployment's address however configured.
   ---------------------------------------------------------------------------- */

// Parse a "2a01:4f8:c17:abcd::/64" style CIDR into a reusable membership test.
// Throws on a malformed value: every caller treats that as fatal at boot,
// because silently falling back to "unconstrained" is the outcome this exists
// to prevent. An empty/unset value returns an explicitly unconstrained gate.
export function v6PrefixGate(cidr) {
  const raw = String(cidr || "").trim();
  if (!raw) return { constrained: false, cidr: "", check: () => true };
  const [addr, lenStr] = raw.split("/");
  const len = parseInt(lenStr || "64", 10);
  const p = parseIp((addr || "").trim());
  if (!p || p.family !== 6 || !(len >= 0 && len <= 128))
    throw new Error(`not a valid IPv6 CIDR: ${raw}`);
  const mask = len === 0 ? 0n : (((1n << 128n) - 1n) << BigInt(128 - len)) & ((1n << 128n) - 1n);
  const net = p.value & mask;
  return {
    constrained: true, cidr: raw,
    check: (a) => { const s = parseIp(a); return !!s && s.family === 6 && (s.value & mask) === net; },
  };
}

// Why a network-supplied address must NOT be bound, or "" if it may be. The
// string is the log line: a refusal is usually a misconfigured enclave, and the
// operator needs to see which address was offered and why it lost.
export function bindRefusal(address, gate) {
  if (typeof address !== "string" || !address.trim()) return "empty address";
  const a = address.trim();
  // Only a bare literal. Brackets, a zone id (%eth0), a mask, or surrounding
  // space all reach bind() as something the kernel may or may not accept - and
  // for the two poll-driven binders an argument bind() THROWS on kills every
  // listener still queued that round, so it has to lose here.
  if (a !== address || /[[\]%/\s]/.test(a)) return "not a bare IP literal";
  const ip = parseIp(a);
  if (!ip) return "not an IP literal";
  // IPv6 only, and NOT because v4 is exotic: isBlockedHost refuses only
  // non-global v4, so a public v4 would otherwise pass - including this box's
  // OWN public v4, which is the wildcard problem wearing a different hat (bind
  // a port the fronting proxy does not hold and you are serving the internet on
  // the platform's address). Dedicated addressing is v6 by construction.
  if (ip.family !== 6) return "not IPv6 (dedicated addressing is IPv6-only)";
  // never one deployment's address, under any prefix a declaration could name
  if (ip.value === 0n) return "the unspecified address (would bind every interface)";
  // a declared prefix is the operator's own statement of what this box may
  // bind, so it decides - including the narrow `::1/128` a local rig declares.
  // Nothing else to check against means falling back to the range table.
  if (gate && gate.constrained) return gate.check(a) ? "" : `outside this box's ${gate.cidr}`;
  if (isBlockedHost(a)) return "not a global unicast address (wildcard, loopback, link-local, ULA, multicast or v4-mapped)";
  return "";
}

export const _internal = { blockedV4, blockedV6, v6ToBig };
