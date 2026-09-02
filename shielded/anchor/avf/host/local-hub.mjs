// local-hub.mjs -- a fleet tunnel hub on this box, for driving the phone's
// relay attach end to end before it meets api.enclave.host.
//
//   node host/local-hub.mjs [--port 8787] [--code-hash hex] [--authority hex] [--root-pin hex]
//   adb reverse tcp:8787 tcp:8787
//   ... am start-foreground-service ... --es relay ws://127.0.0.1:8787/v1/fleet-tunnel --es name pixel
//
// With no pins given it uses placeholders, so a real chain is REFUSED at the
// code-hash step (after the root and signature passed): that refusal, and the
// reasons before it, are what this run is for.
import http from "node:http";
import { createTunnelHub } from "../../../../relay/tunnel.js";
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg("--port", 8787);
const avf = { codeHashes: [arg("--code-hash", "00".repeat(32))], authorityHashes: [arg("--authority", "00".repeat(64))] };
if (arg("--root-pin", null)) avf.rootPins = [arg("--root-pin")];
const hub = createTunnelHub({ allow: [], attest: { avf }, onChange: (why, name) => {
  console.log(`[hub] ${why} ${name}:`, JSON.stringify(hub.origins().find((o) => o.name === name) || null));
  if (why === "attach" || why === "hello") hub.fetchJson(`tunnel://${name}`, "/availability").then((r) => console.log(`[hub] ${name} /availability ->`, JSON.stringify(r).slice(0, 300))).catch((e) => console.log(`[hub] ${name} /availability failed: ${e.message}`));
} });
const server = http.createServer((_req, res) => res.end("local hub\n"));
server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
server.listen(port, "127.0.0.1", () => console.log(`[hub] listening ws://127.0.0.1:${port}/v1/fleet-tunnel  avf policy: code=${avf.codeHashes[0].slice(0, 16)}… authority=${avf.authorityHashes[0].slice(0, 16)}…${avf.rootPins ? " root pinned to " + avf.rootPins[0].slice(0, 16) + "…" : " (Google roots)"}`));
