// relay-agent.mjs — how a relay box joins the fleet's view of itself.
//
// A relay carries traffic; it runs no tenants and sells no compute. But the
// fleet only knows what it can see, and everything that lists a box — the
// console's fleet panel, the per-deployment relay picker — reads /availability
// from a registered endpoint. A relay box has nowhere to serve that from: it
// terminates no TLS by design (that is the whole point of the SNI splice), so
// it has no certificate and no HTTPS surface of its own, and giving it one
// would mean putting an ACME key on the one box in the fleet whose security
// argument is that it holds no keys.
//
// So it dials IN, over the fleet tunnel the CGNAT sellers already use
// (relay/tunnel.js, metal/PROTOCOL.md). The hub answers for it at
// https://<relay>/t/<name>, which is a name the hub already owns a certificate
// for. No inbound, no cert, no key on this box beyond the attach token.
//
// SCOPE, deliberately narrow: this agent answers a fixed, static description of
// the box and NOTHING else. metal/guest/agent.mjs forwards tunnel requests into
// a real supervisor and splices raw streams into it; this one has no upstream
// at all and refuses stream frames outright. A relay must never become a
// generic proxy into someone's network — least of all one reachable from the
// public hub.
//
// Env (/etc/nan-relay/relay-agent.env):
//   RELAY_NAME            required  fleet name, e.g. "us-west" — what a deployment
//                                   names in {"network":{"relay":"…"}}
//   RELAY_TUNNEL_TOKEN    required  attach secret; its sha256 is what the hub allowlists
//   RELAY_HUB             optional  wss://api.enclave.host/v1/fleet-tunnel (default)
//   RELAY_PUBLIC_ADDRESS  required  the address DNS should answer for deployments
//                                   that choose this relay. The whole point of the
//                                   row: a name the picker shows, an address the
//                                   zone serves.
//   RELAY_REGION          optional  routing hint shown beside the name
//   RELAY_SNI/_TCP/_UDP/_EGRESS/_TUNNEL_HUB   which services this box actually runs
//   RELAY_PORTS           optional  the public port range it binds

import WebSocket from "ws";

const need = (k) => { const v = (process.env[k] || "").trim();
  if (!v) { console.error(`fatal: ${k} is required`); process.exit(1); } return v; };
const on = (k) => /^(1|true|yes|on)$/i.test((process.env[k] || "").trim());

const NAME    = need("RELAY_NAME");
const ADDRESS = need("RELAY_PUBLIC_ADDRESS");
// Two ways to prove the name, and the second is the one to prefer.
//   RELAY_OPERATOR_KEY — the private half of the key that registered this
//     relay's endpoint in EnclaveRegistry. The hub challenges, we sign, it
//     recovers and checks the chain. Nothing about this box is written down
//     anywhere else: rotating the relay is a registry transaction.
//   RELAY_TUNNEL_TOKEN — bootstrap. Its sha256 has to be committed to the hub's
//     allowlist, which hardcodes fleet membership into source and reserves the
//     name against every other path. Fine to start with, worth leaving behind.
const OPERATOR_KEY = (process.env.RELAY_OPERATOR_KEY || "").trim();
const TOKEN        = (process.env.RELAY_TUNNEL_TOKEN || "").trim();
if (!OPERATOR_KEY && !TOKEN) {
  console.error("fatal: set RELAY_OPERATOR_KEY (attach by on-chain ownership) or RELAY_TUNNEL_TOKEN (bootstrap)");
  process.exit(1);
}
const HUB     = (process.env.RELAY_HUB || "wss://api.enclave.host/v1/fleet-tunnel").trim();
// The hub only honours a publicUrl that is its OWN /t/<name> route
// (selfRoutedUrl), so derive the origin from the dial URL rather than
// string-editing it: ws:// and wss:// both have to land on the matching http
// scheme, or the identity frame is silently ignored and the row stays unstamped.
const HUB_ORIGIN = (() => {
  const u = new URL(HUB);
  u.protocol = u.protocol === "ws:" ? "http:" : "https:";
  return u.origin;
})();
const log = (m) => console.log(`[relay-agent] ${m}`);

// The box's own description. Zero resources is not an omission — it is the
// claim that makes this a relay: api-relay reads DECLARED zeros (never absent
// fields) as "carries traffic, sells nothing", badges the row, and keeps it out
// of the serving set that sizes the fleet. claimEnabled:false says the same
// thing to the router in the language it already speaks.
const availability = () => ({
  gpu: false, type: "cpu",
  gpuShareFree: 0, cpuShareFree: 0, maxShare: 0,
  usedGpuShare: 0, usedCpuShare: 0,
  vcpusFree: 0, ramGbFree: 0, cpuGflopsFree: 0,
  nodeVcpus: 0, nodeRamGb: 0, nodeGflops: 0,
  smFree: 0, smTotal: 0, vramFreeGb: 0, gpuTflopsFree: 0,
  cardVramGb: 0, cardTflops: 0, cards: 0,
  claimEnabled: false,                       // never takes work; the router must not size against it
  relay: {
    sni:       on("RELAY_SNI"),
    tcp:       on("RELAY_TCP"),
    udp:       on("RELAY_UDP"),
    egress:    on("RELAY_EGRESS"),
    tunnelHub: on("RELAY_TUNNEL_HUB"),
    address: ADDRESS,                        // what the zone answers for deployments that pick this relay
    ...(process.env.RELAY_REGION ? { region: process.env.RELAY_REGION.trim() } : {}),
    ...(process.env.RELAY_PORTS ? { ports: process.env.RELAY_PORTS.trim() } : {}),
    ...(process.env.RELAY_V6_PREFIX ? { v6Prefix: process.env.RELAY_V6_PREFIX.trim() } : {}),
  },
  updatedAt: new Date().toISOString(),
});

const ROUTES = {
  "/availability": () => [200, availability()],
  "/v1/health":    () => [200, { ok: true, role: "relay", name: NAME }],
};

function answer(frame, send) {
  const reply = (status, obj) => send({ t: "res", id: frame.id, status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(obj)).toString("base64") });
  const path = String(frame.path || "").split("?")[0];
  const route = ROUTES[path];
  if (!route) return reply(404, { error: "not_found", routes: Object.keys(ROUTES) });
  const [status, body] = route();
  reply(status, body);
}

// personal_sign over the hub's challenge, with the key that owns this name on
// chain. Imported lazily so a token-only box never loads viem at all.
async function signAttach(nonceB64) {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(OPERATOR_KEY.startsWith("0x") ? OPERATOR_KEY : `0x${OPERATOR_KEY}`);
  return account.signMessage({ message: `enclave-tunnel-attach:${NAME}:${nonceB64}` });
}

let ws = null, alive = false, backoff = 2000;
function dial() {
  const via = OPERATOR_KEY ? "operator key" : "token";
  log(`dialing ${HUB} as ${NAME} (${via})`);
  const headers = OPERATOR_KEY
    ? { "x-metal-name": NAME, "x-metal-attach": "operator" }
    : { "x-metal-name": NAME, "x-metal-token": TOKEN };
  ws = new WebSocket(HUB, { headers });
  const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
  const hello = () => {
    // publicUrl must be THIS tunnel's own route or the hub ignores it
    // (selfRoutedUrl); it is how the fleet stamps an identity on the row.
    send({ t: "hello", name: NAME, mode: "relay", ...(TOKEN ? { token: TOKEN } : {}),
           publicUrl: `${HUB_ORIGIN}/t/${NAME}` });
  };
  ws.on("open", () => {
    alive = true; backoff = 2000;
    // On the operator path the socket is open but NOT yet authorized: the hub
    // sends a challenge first and only binds once the signature checks out, so
    // hello waits for the accept. On the token path it was authorized before the
    // handshake, so it can go now.
    if (!OPERATOR_KEY) { hello(); log("tunnel open"); }
    else log("tunnel open, awaiting challenge");
  });
  ws.on("message", (data) => {
    let f; try { f = JSON.parse(data); } catch { return; }
    if (f.t === "req") return answer(f, send);
    if (f.t === "ping") return send({ t: "pong" });
    if (f.t === "challenge" && OPERATOR_KEY) {
      signAttach(String(f.nonce || ""))
        .then((operatorSig) => send({ t: "attach", operatorSig }))
        .catch((e) => log(`could not sign the attach challenge: ${e.message}`));
      return;
    }
    if (f.t === "attest-result") {
      if (!f.ok) return log(`attach REJECTED: ${f.reason}`);
      log("attach accepted (on-chain operator)");
      return hello();                       // authorized now — claim the identity
    }
    // Raw streams carry app traffic into a supervisor. There is no supervisor
    // here and there is no tenant here, so the only correct answer is no — a
    // relay that spliced hub streams into its own network would be exactly the
    // generic proxy this agent exists not to be.
    if (f.t === "s+") return send({ t: "s=", sid: f.sid, ok: false, err: "relay carries no streams" });
    if (f.t === "sd" || f.t === "sx") return;
  });
  ws.on("unexpected-response", (_q, res) => {
    log(`attach rejected: HTTP ${res.statusCode}${res.statusCode === 401 ? " (token not on the hub's allowlist for this name)" : ""}`);
    try { ws.terminate(); } catch {}
  });
  ws.on("close", () => {
    if (alive) log("tunnel closed");
    alive = false;
    setTimeout(dial, backoff);
    backoff = Math.min(backoff * 2, 60_000);   // a hub restart must not become a dial storm
  });
  ws.on("error", (e) => { log(`tunnel error: ${e.code || ""} ${e.message || e}`); try { ws.terminate(); } catch {} });
}

process.on("unhandledRejection", (r) => console.error("[relay-agent] unhandledRejection:", r));
process.on("uncaughtException", (e) => { console.error("[relay-agent] uncaughtException:", e); process.exit(1); });
dial();
