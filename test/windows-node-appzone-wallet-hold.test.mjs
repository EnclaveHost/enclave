// The node's own app zone under a wallet hold (host.mjs #walletHold -> servingWithdrawn -> appZone closeDeployment): the
// partition splices it already carries for the held deployment end, others do not, and a hold that lands while a new
// stream is being resolved is not served (the admitted() re-check). Real http upgrade + ws client over loopback.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { appZone } from "../windows/node/appzone.mjs";

const A = "0x" + "a1".repeat(32), B = "0x" + "b2".repeat(32), C = "0x" + "c3".repeat(32);

test("closeDeployment ends only the held deployment's spliced streams; a hold during resolve is refused with 503", { timeout: 10_000 }, async () => {
  const held = new Set(), served = [];
  let releaseC; const slowC = new Promise((r) => { releaseC = r; });
  const target = (id) => ({ id, isolation: { instance: "hv" + id.slice(2, 10), appId: "e".repeat(64), expectName: `${id.slice(2, 10)}.app.enclave.host` } });
  const zone = appZone({
    resolve: async (ref) => { const id = [A, B, C].find((x) => x.startsWith(ref)); if (id === C) await slowC; return id ? target(id) : null; },
    serveHttp: async () => ({ status: 500 }), log: () => {}, admitted: (id) => !held.has(id),
    isolationSplicer: { serve: (s, t) => { served.push(t.id); return new Promise((r) => s.on("close", () => r({ outcome: "closed" }))); } },
  });
  const server = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  server.on("upgrade", (req, socket, head) => zone.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = (id) => `ws://127.0.0.1:${server.address().port}/x/${id}/https`, clients = [];
  try {
    const a = new WebSocket(url(A)), b = new WebSocket(url(B)); clients.push(a, b);
    await Promise.all([once(a, "open"), once(b, "open")]);
    while (served.length < 2) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(served.sort(), [A, B].sort());
    const aClosed = once(a, "close");
    held.add(A);
    assert.equal(zone.closeDeployment(A), 1, "exactly the held deployment's stream");
    await aClosed;
    assert.equal(b.readyState, WebSocket.OPEN, "another deployment's stream is untouched");
    // a new stream for the held deployment: refused by admitted() (the host's appZoneTarget refuses it as well)
    const outcome = (ws) => Promise.race([once(ws, "unexpected-response").then(([, res]) => res.statusCode), once(ws, "open").then(() => "spliced")]);
    const a2 = new WebSocket(url(A)); clients.push(a2); a2.on("error", () => {});
    assert.equal(await outcome(a2), 503);
    // the hold lands while C's resolve is still awaiting: refused at the re-check, never spliced
    const c = new WebSocket(url(C)); clients.push(c); c.on("error", () => {});
    await new Promise((r) => setTimeout(r, 50));
    held.add(C); releaseC();
    assert.equal(await outcome(c), 503); assert.equal(served.includes(C), false);
    b.close();
  } finally { for (const w of clients) w.terminate(); zone.closeAll(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});

test("without admitted() the app zone behaves as before (the option defaults to always served)", { timeout: 10_000 }, async () => {
  const served = [];
  const zone = appZone({ resolve: async () => ({ id: A, isolation: { instance: "hv1", appId: "e".repeat(64), expectName: "x" } }), serveHttp: async () => ({ status: 500 }),
    log: () => {}, isolationSplicer: { serve: (s, t) => { served.push(t.id); return new Promise((r) => s.on("close", () => r({ outcome: "closed" }))); } } });
  const server = http.createServer(); server.on("upgrade", (req, socket, head) => zone.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const a = new WebSocket(`ws://127.0.0.1:${server.address().port}/x/${A}/https`); await once(a, "open");
    while (!served.length) await new Promise((r) => setTimeout(r, 10));
    assert.equal(zone.closeDeployment(B), 0); assert.equal(a.readyState, WebSocket.OPEN); a.close();
  } finally { zone.closeAll(); await new Promise((r) => server.close(r)); }
});
