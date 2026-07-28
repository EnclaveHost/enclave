// relay/boxhost.js — the canonical hostname of a self-hosted (tunnel-attached)
// enclave, and the one place that derives it.
//
// WHY A HOSTNAME AT ALL. A tunnel box used to be reachable only as a PATH on
// the relay: https://api.enclave.host/t/<name>/…. That works for proxying and
// nothing else. Every attestation verifier in the ecosystem — tinfoil-cli's
// `-e`, @tinfoilsh/verifier, the site's in-browser check — takes a bare HOST
// and builds /.well-known/tinfoil-attestation from it, so a path-scoped
// endpoint gets truncated to the relay's own hostname and verifies the RELAY.
// Worse, the client's TLS terminates at the relay, so the quote's reportData
// (which binds the BOX's key) can never match the certificate the browser
// actually saw. Both are fatal to verification and neither is fixable while
// the box's identity is a path. So a box gets a real name, in a zone that
// answers with SNI passthrough to the box's own in-CVM certificate.
//
// WHY NOT THE SELLER'S CHOSEN NAME. Tunnel names are seller-supplied labels.
// Hanging them off the apex (metal0.enclave.host) puts arbitrary strings in
// the same namespace as app./api./www./mcp. — one seller naming their box
// "app" is an outage, and the blocklist that prevents it has to be updated
// every time we add a subdomain, forever. Two structural fixes instead:
//
//   1. A DEDICATED ZONE. Boxes live under BOX_ZONE (box.enclave.host), never
//      the apex. A box named "app" resolves app.box.enclave.host, which simply
//      is not app.enclave.host. The collision class stops existing rather than
//      being enumerated.
//   2. A DERIVED LABEL. The seller's string is not the identity. The label is
//      e<16 hex> = keccak256(operator ‖ label)[0:8], so:
//        - two operators who both pick "metal0" get different hosts (no
//          cross-operator squatting),
//        - nobody can mint support.box.enclave.host or official.box.… — every
//          label in the zone is `e` + hex, so there is no phishable name,
//        - it is NOT circular: the preimage is the on-chain operator address,
//          never the endpoint, so the registry id stays keccak(endpoint).
//
// Grinding buys nothing here. The operator address is in the preimage, so
// colliding with a target box means grinding your own KEY to 64 bits, and even
// then the hub still gates the attach on the operator key registered for that
// name (api-relay tunnelNameOwner). Contrast the 32-bit deployment-id prefixes
// that <prefix>.app.enclave.host uses, where the id itself is the grindable
// quantity — that one needed an ambiguity check; this does not.
//
// THE DERIVED LABEL IS ALSO THE TUNNEL NAME, and that is load-bearing rather
// than tidy. Ownership of a name is resolved by reading the registry entry at
// keccak256(endpoint) and taking its operator. If the box attached under its
// friendly label while registering the derived host, that lookup would need
// the operator to compute the host and the host to find the operator — so it
// would degrade into scanning every registry entry and re-deriving each one.
// Attaching under e<hex> keeps it a single get(): the hub knows the name, the
// name IS the host's label, and the host's keccak IS the id. The seller's
// friendly string stays a display name (registry entry / UI) and never has to
// be resolvable by anyone.

let _keccak = null;

// keccak256 over raw bytes, loaded once (viem is already a relay dependency).
async function keccakHex(bytes) {
  if (!_keccak) {
    const { keccak256 } = await import("viem");
    _keccak = keccak256;
  }
  return _keccak(bytes);
}

// The zone boxes live in. Unset = the scheme is off and callers fall back to
// the legacy /t/<name> path form, so a relay that has not been given a zone
// keeps working exactly as before rather than serving unresolvable names.
export const boxZone = (env = process.env) =>
  (env.BOX_ZONE || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "") || null;

// Seller labels: a single DNS label, already enforced at the handshake
// (tunnel.js NAME_RE_OK). Re-checked here because this function's output ends
// up in a URL and in an on-chain id — a dot would silently add a namespace
// level, and an empty string would collide every box onto one name.
const LABEL_OK = /^[A-Za-z0-9_-]{1,64}$/;

// A minted label is `e` + 16 hex. Anchored here so the router, the dns-01 gate
// and the attach handshake all agree on what one of ours looks like.
const MINTED_LABEL = /^e[0-9a-f]{16}$/;

/* The tunnel name (and DNS label) a box attaches and registers under.

   `operator` is the address that registered (or will register) the box on
   chain — the one identity that survives a reboot, since the image measurement
   proves only WHICH RELEASE and the transport key is minted per boot.
   `friendly` is the seller's own string; it never leaves this function.

   Callers that do not know the operator cannot compute a label, and get null
   rather than a guess: a box with no on-chain registration has no derived
   identity, and stays on the legacy /t/<name> path until it has one. */
export async function boxLabel(operator, friendly, zone = boxZone()) {
  if (!zone) return null;
  if (!LABEL_OK.test(String(friendly || ""))) return null;
  const op = String(operator || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(op)) return null;
  const bytes = Buffer.concat([Buffer.from(op.slice(2), "hex"), Buffer.from(String(friendly), "utf8")]);
  return `e${(await keccakHex(bytes)).slice(2, 2 + 16)}`;      // 64 bits, hex
}

// The host a minted label answers on. Split from boxLabel because the relay
// routes by label (it has one from the attach) while clients see the host.
export const boxHostOf = (label, zone = boxZone()) =>
  zone && MINTED_LABEL.test(String(label || "")) ? `${label}.${zone}` : null;

// The full https origin a box registers on chain and advertises as its
// attestation endpoint. Its keccak256 IS the registry id, exactly as for a
// colo box with a real endpoint — tunnel boxes stop being a special case, and
// the id is computable from the attach name alone.
export const boxOrigin = (label, zone = boxZone()) => {
  const h = boxHostOf(label, zone);
  return h ? `https://${h}` : null;
};

// Is this host one of ours, shaped like a minted label? Used to route by Host
// header without a lookup, and to refuse dns-01 pushes for names outside the
// scheme. Deliberately strict: the zone alone is not enough, because a
// wildcard zone answers for EVERY name and only e<16hex> is one we minted.
export function isBoxHost(host, zone = boxZone()) {
  if (!zone) return false;
  const h = String(host || "").toLowerCase().replace(/\.$/, "").split(":")[0];
  if (!h.endsWith("." + zone)) return false;
  return MINTED_LABEL.test(h.slice(0, -(zone.length + 1)));
}

// The label a request Host names, or null if it is not a box host at all.
export const boxLabelOfHost = (host, zone = boxZone()) => {
  if (!isBoxHost(host, zone)) return null;
  const h = String(host).toLowerCase().replace(/\.$/, "").split(":")[0];
  return h.slice(0, -(zone.length + 1));
};
