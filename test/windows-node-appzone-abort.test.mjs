// The app zone's request handler, driven as the production article over real sockets.
//
// Two findings from an independent audit, both about a peer being able to reach past a rule:
//
//   1. the body read sat OUTSIDE the handler's try. A client that sends a partial body and
//      disconnects makes the request stream reject, and in an async callback an escaped rejection
//      is an unhandled promise rejection - a process exit. One TCP client could end the agent for
//      every tenant on the box.
//   2. the client address was read from `x-forwarded-for`. On this path the relay splices TLS
//      without terminating it, so nothing inserts that header and anything arriving in it was
//      written by the caller inside their own TLS session. Varying it would mint a fresh
//      rate-limit bucket per request.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { appRequestHandler, APP_ZONE_BUCKET } from "../windows/node/appzone.mjs";

/** A server running the PRODUCTION handler, recording what it was asked to serve. */
async function zone() {
  const seen = [];
  const server = http.createServer(appRequestHandler({
    serveHttp: async (_id, req) => { seen.push(req); return { status: 200, headers: {}, body: Buffer.from("ok") }; },
    log: () => {},
  }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

const get = (port, headers = {}) => new Promise((resolve) => {
  const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/", headers }, (res) => {
    const c = []; res.on("data", (x) => c.push(x));
    res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
  });
  req.on("error", (e) => resolve({ status: 0, body: String(e.code || e.message) }));
  req.end();
});

test("a client that aborts mid-body does not take the process down, and the next request works", async () => {
  const z = await zone();
  // An unhandled rejection is a process exit, so the only honest check is to watch for one.
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    // Promise a 4 KB body, send one byte, then vanish. This is the audit's case.
    await new Promise((resolve) => {
      const c = net.connect(z.port, "127.0.0.1", () => {
        c.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4096\r\n\r\nx");
        setTimeout(() => { c.destroy(); resolve(); }, 30);
      });
      c.on("error", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 150));      // let any rejection surface
    assert.deepEqual(unhandled, [], "an aborted request must not produce an unhandled rejection");
    // ...and the server is still serving, which is the part that actually matters to a tenant.
    const after = await get(z.port);
    assert.equal(after.status, 200);
    assert.equal(after.body, "ok");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await z.close();
  }
});

test("x-forwarded-for on the app zone buys nothing: every caller shares one bucket", async () => {
  const z = await zone();
  try {
    for (const spoof of ["1.2.3.4", "9.9.9.9", "10.0.0.1, 8.8.8.8", ""]) {
      await get(z.port, spoof ? { "x-forwarded-for": spoof } : {});
    }
    assert.equal(z.seen.length, 4);
    for (const [i, req] of z.seen.entries())
      assert.equal(req.ip, APP_ZONE_BUCKET,
        `request ${i} was bucketed as ${req.ip}: a caller-supplied header must not choose its own bucket`);
    // The header still REACHES the app - it is the app's business what it makes of it. What it
    // must not do is decide whose rate allowance this box spends.
    assert.equal(z.seen[0].headers["x-forwarded-for"], "1.2.3.4");
  } finally { await z.close(); }
});

test("an ordinary request is served normally through the same handler", async () => {
  const z = await zone();
  try {
    const r = await get(z.port);
    assert.equal(r.status, 200);
    assert.equal(z.seen.length, 1);
    assert.equal(z.seen[0].method, "GET");
  } finally { await z.close(); }
});
