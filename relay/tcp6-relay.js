// NAN dedicated-IP TCP relay — serves each deployment's declared tcp:N ports on
// its OWN IPv6, at the real (logical) port. UNTRUSTED, like the other relays.
//
//   client ──TCP──> [<per-deployment IPv6>]:N ──WSS──> enclave
//                                                 /x/<id>/tcp/N ──TCP──> app
//
// Unlike the SNI relay (relay.js), which multiplexes every deployment onto
// shared public ports and demuxes by the TLS ClientHello's SNI, this relay
// routes purely by DESTINATION ADDRESS: every deployment gets its own IPv6 out
// of the box's routed /64 (the supervisor derives it from the id; see
// /v1/net-map), so the client needs no SNI and no TLS at all - ANY tcp protocol
// works (databases, game servers, plaintext, or the app's own TLS), at the port
// the app declared. Bytes are spliced raw to the enclave's /tcp/ bridge (the
// app owns its port end to end); the relay holds no keys and no state beyond
// live connections.
//
// PREREQUISITE (the box, once): AnyIP so the whole /64 is bind-able without
// configuring 2^64 addresses —
//     ip -6 route add local <prefix>/64 dev lo
// The systemd unit does this in ExecStartPre. CAP_NET_BIND_SERVICE lets it
// serve privileged logical ports (tcp:443, tcp:80) on the dedicated address.
//
// TRUST: the relay sees ciphertext only if the app speaks TLS; a plaintext app
// is visible to the relay (it can drop, not usefully forge - no keys, no state).
// Apps needing confidentiality terminate their own TLS. Documented in README.md.
//
// Config (env):
//   ENCLAVE_URL        required   enclave origin (https:// -> wss://)
//   NET_POLL_SEC       optional   /v1/net-map poll cadence (default 5)
//   TCP6_MAX_CONNS     optional   concurrent client-connection cap (default 4096)
//   TCP6_HANDSHAKE_MS  optional   ms to establish the enclave WS before giving up (10000)

import net from "node:net";
import WebSocket, { createWebSocketStream } from "ws";

const need = (k) => { const v = (process.env[k] || "").trim(); if (!v) { console.error(`fatal: ${k} is required`); process.exit(1); } return v; };
const ENCLAVE   = need("ENCLAVE_URL").replace(/\/+$/, "").replace(/^http/, "ws");
const MAP_URL   = need("ENCLAVE_URL").replace(/\/+$/, "") + "/v1/net-map";
const POLL_MS   = parseInt(process.env.NET_POLL_SEC || "5", 10) * 1000;
const MAX_CONNS = parseInt(process.env.TCP6_MAX_CONNS || "4096", 10);
const HS_MS     = parseInt(process.env.TCP6_HANDSHAKE_MS || "10000", 10);

// one listener per (deployment, address, logical port); each accepts many client
// connections, each getting its own WS to the enclave so streams stay separate.
const listeners = new Map();   // `${id}|${address}|${port}` -> { srv, id, address, port }
let connCount = 0;

function openListener(id, address, port) {
  const key = `${id}|${address}|${port}`;
  if (listeners.has(key)) return;
  const srv = net.createServer((client) => splice(client, id, port));
  const L = { srv, id, address, port };
  listeners.set(key, L);
  srv.on("error", (e) => {
    if (e.code === "EADDRNOTAVAIL")
      console.error(`[tcp6-relay] cannot bind [${address}]:${port} — is AnyIP set? (ip -6 route add local <prefix>/64 dev lo)`);
    else if (e.code === "EACCES")
      console.error(`[tcp6-relay] cannot bind [${address}]:${port} — privileged port needs CAP_NET_BIND_SERVICE`);
    else if (e.code !== "EADDRINUSE")
      console.error(`[tcp6-relay] [${address}]:${port}: ${e.message}`);
    try { srv.close(); } catch {} listeners.delete(key);
  });
  srv.listen(port, address, () => console.log(`[tcp6-relay] [${address}]:${port} -> ${ENCLAVE}/x/${id}/tcp/${port}`));
}

function splice(client, id, port) {
  if (connCount >= MAX_CONNS) { client.destroy(); return; }
  connCount++;
  client.once("close", () => connCount--);
  client.on("error", () => client.destroy());
  client.pause();

  const ws = new WebSocket(`${ENCLAVE}/x/${encodeURIComponent(id)}/tcp/${port}`, { perMessageDeflate: false });
  const wsStream = createWebSocketStream(ws);
  const hsTimer = setTimeout(() => { try { ws.terminate(); } catch {} client.destroy(); }, HS_MS);
  const close = () => { clearTimeout(hsTimer); client.destroy(); try { ws.terminate(); } catch {} };
  ws.on("unexpected-response", (_req, res) => {
    console.log(`[tcp6-relay] ${id} tcp:${port} refused by enclave (HTTP ${res.statusCode})`);
    close();
  });
  client.on("close", close);
  wsStream.on("error", close); wsStream.on("close", close);
  ws.on("error", close);
  ws.on("open", () => {
    clearTimeout(hsTimer);
    client.pipe(wsStream); wsStream.pipe(client);
    client.resume();
  });
}

function closeListener(key) {
  const L = listeners.get(key); if (!L) return;
  try { L.srv.close(); } catch {} listeners.delete(key);   // in-flight connections keep their own sockets/WS
}

async function poll() {
  let map;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(MAP_URL, { signal: ctrl.signal }); clearTimeout(t);
    if (!r.ok) throw new Error("HTTP " + r.status);
    map = await r.json();
  } catch (e) { console.error("[tcp6-relay] net-map poll failed:", e.message); return; }
  if (!map.enabled) {
    if (listeners.size) console.log("[tcp6-relay] dedicated addressing disabled at enclave; unbinding");
    for (const k of [...listeners.keys()]) closeListener(k);
    return;
  }
  const want = new Set();
  for (const d of map.deployments || []) {
    if (!d.address) continue;
    for (const port of d.tcp || []) { want.add(`${d.id}|${d.address}|${port}`); openListener(d.id, d.address, port); }
  }
  for (const k of [...listeners.keys()]) if (!want.has(k)) closeListener(k);   // deployment gone → stop binding
}

await poll();
setInterval(poll, POLL_MS);
console.log(`[tcp6-relay] polling ${MAP_URL} every ${POLL_MS / 1000}s`);
