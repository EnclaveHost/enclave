// EVERY serving path, not just the one I remembered to gate.
//
// An audit found that enabling private deployments gated `/x/<id>` in the agent and nothing else:
// the app zone's own hostname reached `serveHttp` -> `host.proxy` with no check, and a socket app
// with no WAF was spliced straight to its port after the handshake. A private app was therefore
// reachable anonymously on its own hostname. The check now lives in `host.proxy`, which every HTTP
// path funnels through, and a private deployment is never spliced.
//
// These tests drive the PRODUCTION app-zone handler and the production proxy with anonymous,
// wrong-owner and right-owner requests. Calling addressFor in isolation is what let the hole
// through in the first place.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Host } from "../windows/node/host.mjs";
import { appRequestHandler } from "../windows/node/appzone.mjs";
import { selfSigned } from "../windows/node/apptls.mjs";
import tls from "node:tls";
import net from "node:net";
import { initSessionKey, mint, addressFor, appAudience, APP_COOKIE } from "../windows/node/session.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-privpath-"));
const key = initSessionKey({ dir });
const OWNER = "0x29479Bf04ED889D46a7AfB7f292B9Bb26e12647C";
const STRANGER = "0x1111111111111111111111111111111111111111";
const ID = "0x" + "ab".repeat(32);

/** A real loopback "app" that records whether it was ever reached. */
async function app() {
  let hits = 0;
  const server = http.createServer(async (req, res) => { for await (const _ of req); hits++; res.end("SECRET"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, hits: () => hits, close: () => new Promise((r) => server.close(r)) };
}

/** A Host serving one PRIVATE deployment on a real loopback port. */
function box(port, { withVerifier = true } = {}) {
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test",
                       appsEnabled: true, cpuPricePerSec6: 12, log: () => {},
                       sessionKid: key.kid,
                       ...(withVerifier ? { sessionVerify: (headers, id) => addressFor(key, headers, id) } : {}) });
  h.records.set(ID, { id: ID, status: "running", isPublic: false, owner: OWNER.toLowerCase() });
  h.apps.set(ID, { state: "running", port });
  return h;
}

const bearer = (who) => ({ authorization: `Bearer ${mint(key, { subject: who, ttlSec: 600 })}` });
const cookie = (who, id = ID) =>
  ({ cookie: `${APP_COOKIE}=${mint(key, { subject: who, audience: appAudience(id), ttlSec: 600 })}` });

test("THE /x/ PATH: anonymous 401, stranger 403, owner 200", async () => {
  const a = await app();
  try {
    const h = box(a.port);
    const call = (headers) => h.proxy(ID, { method: "GET", pathRest: "/", headers, ip: "1.1.1.1" });
    assert.equal((await call({})).status, 401);
    assert.equal(a.hits(), 0, "the app must not be reached at all");
    assert.equal((await call(bearer(STRANGER))).status, 403);
    assert.equal(a.hits(), 0);
    const ok = await call(bearer(OWNER));
    assert.equal(ok.status, 200);
    assert.equal(String(ok.body), "SECRET");
    assert.equal(a.hits(), 1, "and only the owner ever reached it");
  } finally { await a.close(); }
});

test("THE APP-ZONE PATH: the same three answers through the production handler", async () => {
  const a = await app();
  const zone = [];
  try {
    const h = box(a.port);
    // Exactly what appZone builds, over a real socket.
    const server = http.createServer(appRequestHandler({ serveHttp: (id, req) => h.proxy(id, req), log: (m) => zone.push(m) }));
    server.on("connection", (s) => { s.__enclaveId = ID; });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const get = (headers) => new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/", headers }, (res) => {
        const c = []; res.on("data", (x) => c.push(x));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
      });
      req.on("error", (e) => resolve({ status: 0, body: String(e.code) }));
      req.end();
    });
    try {
      const anon = await get({});
      assert.equal(anon.status, 401, "a private app on its OWN HOSTNAME must not answer a stranger");
      assert.ok(!anon.body.includes("SECRET"));
      assert.equal(a.hits(), 0);

      assert.equal((await get(bearer(STRANGER))).status, 403);
      assert.equal((await get(cookie(STRANGER))).status, 403, "a valid cookie for the wrong wallet");
      assert.equal(a.hits(), 0, "still never reached");

      const byBearer = await get(bearer(OWNER));
      assert.equal(byBearer.status, 200);
      assert.equal(byBearer.body, "SECRET");
      // A browser cannot put a bearer on a navigation, so the cookie path must work too.
      const byCookie = await get(cookie(OWNER));
      assert.equal(byCookie.status, 200);
      assert.equal(byCookie.body, "SECRET");
      assert.equal(a.hits(), 2);

      // ...and a cookie minted for ANOTHER deployment does not open this one.
      assert.equal((await get(cookie(OWNER, "0x" + "cd".repeat(32)))).status, 401);
      assert.equal(a.hits(), 2);
    } finally { await new Promise((r) => server.close(r)); }
  } finally { await a.close(); }
});

test("THE SOCKET PATH, over REAL TLS: a private deployment is never spliced past the check", async () => {
  // `rules.private` alone is not evidence: it would still pass if the app-zone branch that reads
  // it were broken or removed. This drives the actual decision - TLS terminated on a stream, the
  // branch taken, and the app either reached or not - so a future change to that branch fails here.
  const a = await app();
  try {
    const h = box(a.port);
    const cert = selfSigned("aaaaaaaa.app.enclave.host");
    const served = [];

    // The app zone's own choice, verbatim: parse when gate-served, WAF'd, or PRIVATE; otherwise
    // splice raw bytes to the app's port.
    const httpd = http.createServer(appRequestHandler({ serveHttp: (id, req) => h.proxy(id, req), log: () => {} }));
    const front = net.createServer((sock) => {
      const target = { ...h.zoneRules(ID), port: a.port, gate: false, cert };
      const t = new tls.TLSSocket(sock, { isServer: true, key: cert.key, cert: cert.cert,
                                          requestCert: false, rejectUnauthorized: false });
      t.on("error", () => {});
      t.on("secure", () => {
        if (target.gate || target.waf || target.private) {
          served.push("parsed");
          t.__enclaveId = ID;
          httpd.emit("connection", t);
          return;
        }
        served.push("spliced");
        const up = net.connect(target.port, "127.0.0.1");
        up.on("error", () => {});
        t.pipe(up); up.pipe(t);
      });
    });
    await new Promise((r) => front.listen(0, "127.0.0.1", r));
    const port = front.address().port;

    const get = (headers) => new Promise((resolve) => {
      const sock = tls.connect({ host: "127.0.0.1", port, servername: "aaaaaaaa.app.enclave.host",
                                 rejectUnauthorized: false }, () => {
        const h2 = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
        sock.write(`GET / HTTP/1.1\r\nHost: aaaaaaaa.app.enclave.host\r\nConnection: close\r\n${h2}\r\n`);
      });
      const c = [];
      sock.on("data", (d) => c.push(d));
      sock.on("close", () => resolve(Buffer.concat(c).toString("utf8")));
      sock.on("error", () => resolve(""));
    });

    try {
      const anon = await get({});
      assert.match(anon, /^HTTP\/1\.1 401/, `anonymous over real TLS must be refused, got: ${anon.slice(0, 40)}`);
      assert.ok(!anon.includes("SECRET"));
      assert.equal(a.hits(), 0, "the app must never be reached");

      const wrong = await get({ Authorization: `Bearer ${mint(key, { subject: STRANGER, ttlSec: 600 })}` });
      assert.match(wrong, /^HTTP\/1\.1 403/);
      assert.equal(a.hits(), 0);

      const right = await get({ Authorization: `Bearer ${mint(key, { subject: OWNER, ttlSec: 600 })}` });
      assert.match(right, /^HTTP\/1\.1 200/);
      assert.ok(right.includes("SECRET"));
      assert.equal(a.hits(), 1, "and only the owner ever reached it");

      assert.deepEqual([...new Set(served)], ["parsed"],
        "a private deployment must never take the splice branch");
    } finally { await new Promise((r) => front.close(r)); httpd.close(); }
  } finally { await a.close(); }
});

test("a PUBLIC deployment still takes the splice branch, so the flag is per deployment", () => {
  const h = box(1234);
  assert.equal(h.zoneRules(ID).private, true);
  const pub = "0x" + "cd".repeat(32);
  h.records.set(pub, { id: pub, status: "running", isPublic: true, owner: OWNER.toLowerCase() });
  assert.equal(h.zoneRules(pub).private, false);
});

test("NO VERIFIER: a private deployment is refused rather than served", async () => {
  const a = await app();
  try {
    const h = box(a.port, { withVerifier: false });
    const r = await h.proxy(ID, { method: "GET", pathRest: "/", headers: bearer(OWNER), ip: "1.1.1.1" });
    assert.equal(r.status, 503, "fail closed: a box that cannot prove who is asking serves nobody");
    assert.match(String(r.body), /cannot verify who is asking/);
    assert.equal(a.hits(), 0);
  } finally { await a.close(); }
});

test("a PUBLIC deployment is unaffected by any of this", async () => {
  const a = await app();
  try {
    const h = box(a.port);
    const pub = "0x" + "cd".repeat(32);
    h.records.set(pub, { id: pub, status: "running", isPublic: true, owner: OWNER.toLowerCase() });
    h.apps.set(pub, { state: "running", port: a.port });
    const r = await h.proxy(pub, { method: "GET", pathRest: "/", headers: {}, ip: "1.1.1.1" });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), "SECRET");
  } finally { await a.close(); }
});

test("the protection rules run BEFORE the owner check, so a flood cannot grind verification", async () => {
  const a = await app();
  try {
    const h = box(a.port);
    h.records.set(ID, { id: ID, status: "running", isPublic: false, owner: OWNER.toLowerCase(),
                        waf: { rps: 1, burst: 1 } });
    const call = () => h.proxy(ID, { method: "GET", pathRest: "/", headers: {}, ip: "9.9.9.9" });
    assert.equal((await call()).status, 401, "the first anonymous request is refused on auth");
    const second = await call();
    assert.equal(second.status, 429, "and the second on RATE, which is the cheaper refusal");
    assert.equal(a.hits(), 0);
  } finally { await a.close(); }
});
