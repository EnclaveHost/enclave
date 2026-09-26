// The owner's hosting caps and their local API (hosting.mjs), without a Host: the handler is driven with a stub that
// has the Host's three methods. What these hold to: the caps survive a restart byte for byte and are written
// atomically; an unreadable caps file offers nothing new rather than everything; the token file is fresh, private and
// never readable with the token in it; and nobody off the machine, or without the token, gets an answer.
// The Host's own use of the caps (capacity, the claim gate, the isolated spawn gate) is test/windows-node-hosting-caps.test.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { CAP_STEP, DEFAULT_CAPS, snapShare, loadCaps, saveCaps, capsUpdate, mintToken, aclArgs, isLoopback,
         hostingAdminHandler, startHostingAdmin } from "./hosting.mjs";

const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ee-hosting-"));

test("snapShare: numbers from 0 to 1 snap to twentieths; anything else is refused, strings included", () => {
  assert.equal(CAP_STEP, 0.05);
  for (const [v, want] of [[0, 0], [1, 1], [0.3, 0.3], [0.32, 0.3], [0.33, 0.35], [0.024, 0], [0.026, 0.05], [0.999, 1], [0.15, 0.15]])
    assert.equal(snapShare(v), want, String(v));
  for (const v of [-0.01, 1.01, NaN, Infinity, "0.5", null, undefined, true, [0.5], { v: 0.5 }]) assert.equal(snapShare(v), null, String(v));
});

test("persistence: caps written are the caps read back, through a rename, with nothing left beside the file", () => {
  const dir = tmp(), file = path.join(dir, "hosting-caps.json");
  assert.deepEqual(loadCaps(file), { caps: { cpuShare: 1, gpuShare: 1 }, error: null }, "no file: the defaults");
  saveCaps(file, { cpuShare: 0.35, gpuShare: 0 });
  assert.deepEqual(loadCaps(file), { caps: { cpuShare: 0.35, gpuShare: 0 }, error: null });
  saveCaps(file, { cpuShare: 1, gpuShare: 0.6 });
  assert.deepEqual(loadCaps(file).caps, { cpuShare: 1, gpuShare: 0.6 }, "a second write replaces the first");
  assert.deepEqual(fs.readdirSync(dir), ["hosting-caps.json"], "no temporary file is left behind");
  // a field that is absent is its default; a file written by hand off the grid is snapped on the way in
  fs.writeFileSync(file, JSON.stringify({ cpuShare: 0.42 }));
  assert.deepEqual(loadCaps(file).caps, { cpuShare: 0.4, gpuShare: DEFAULT_CAPS.gpuShare });
});

test("a save that cannot land changes nothing and leaves no temporary file", () => {
  const dir = tmp(), file = path.join(dir, "hosting-caps.json");
  saveCaps(file, { cpuShare: 0.5, gpuShare: 0.5 });
  fs.rmSync(file); fs.mkdirSync(file);                           // the rename's target is now a directory
  assert.throws(() => saveCaps(file, { cpuShare: 0.1, gpuShare: 0.1 }));
  assert.deepEqual(fs.readdirSync(dir), ["hosting-caps.json"], "the temporary file was cleaned up");
});

test("an unreadable caps file fails CLOSED: 0 on both axes and the reason, never the whole machine", () => {
  const dir = tmp(), file = path.join(dir, "hosting-caps.json");
  for (const text of ["{not json", "[0.5, 0.5]", "null", JSON.stringify({ cpuShare: "0.5" }), JSON.stringify({ cpuShare: 2 }),
                      JSON.stringify({ gpuShare: -1 })]) {
    fs.writeFileSync(file, text);
    const r = loadCaps(file);
    assert.deepEqual(r.caps, { cpuShare: 0, gpuShare: 0 }, text);
    assert.match(r.error, /offering nothing new until they are set again from the tray/, text);
  }
});

test("capsUpdate: validates, snaps, keeps the axis not named, and refuses unknown fields and empty updates", () => {
  const cur = { cpuShare: 1, gpuShare: 1 };
  assert.deepEqual(capsUpdate(cur, { cpuShare: 0.33 }), { cpuShare: 0.35, gpuShare: 1 });
  assert.deepEqual(capsUpdate(cur, { cpuShare: 0, gpuShare: 0.5 }), { cpuShare: 0, gpuShare: 0.5 });
  for (const [body, re] of [[{ cpuShare: 1.5 }, /cpuShare must be a number from 0 to 1/], [{ gpuShare: "1" }, /gpuShare must be/],
                            [{ cpu: 0.5 }, /unknown field "cpu"/], [{}, /nothing to set/], [null, /JSON object/], [[0.5], /JSON object/]]) {
    assert.throws(() => capsUpdate(cur, body), (e) => e.status === 400 && re.test(e.message), JSON.stringify(body));
  }
  assert.deepEqual(cur, { cpuShare: 1, gpuShare: 1 }, "the current caps are never mutated");
});

test("the token: fresh every start, 0600 here, and a file planted before the node started is replaced, not trusted", () => {
  const dir = tmp(), file = path.join(dir, "sub", "hosting-admin.token");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "planted-by-someone-else\n");
  const a = mintToken(file, { platform: "linux" });
  assert.match(a, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
  assert.equal(fs.readFileSync(file, "utf8").trim(), a);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const b = mintToken(file, { platform: "linux" });
  assert.notEqual(a, b, "a new token per start");
});

test("the token on Windows: the ACL is applied while the file is EMPTY, and a failed ACL leaves no token file at all", () => {
  const file = path.join(tmp(), "hosting-admin.token");
  const seen = [];
  const tok = mintToken(file, { platform: "win32", trayUser: "NUCBOX-K11\\steven",
                                restrict: (f, user) => seen.push({ f, user, size: fs.statSync(f).size }) });
  assert.deepEqual(seen, [{ f: file, user: "NUCBOX-K11\\steven", size: 0 }], "restricted once, before the token was written");
  assert.equal(fs.readFileSync(file, "utf8").trim(), tok);
  assert.throws(() => mintToken(file, { platform: "win32", restrict: () => { throw new Error("icacls: access denied"); } }), /access denied/);
  assert.equal(fs.existsSync(file), false, "no file is left that might hold a token under an inherited ACL");
});

test("icacls arguments: inheritance removed; SYSTEM, Administrators and the node's own account full; the tray user read-only", () => {
  assert.deepEqual(aclArgs("C:\\ProgramData\\Enclave\\hosting-admin.token", { selfSid: "S-1-5-21-1-2-3-1001", trayUser: "NUCBOX-K11\\steven" }),
    ["C:\\ProgramData\\Enclave\\hosting-admin.token", "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F",
     "*S-1-5-21-1-2-3-1001:F", "NUCBOX-K11\\steven:R"]);
  assert.deepEqual(aclArgs("f", { selfSid: "S-1-5-18" }), ["f", "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F"],
    "running as SYSTEM adds no second grant; no tray user, no read grant");
});

test("isLoopback: 127/8, ::1 and v4-mapped 127/8 only", () => {
  for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.2"]) assert.equal(isLoopback(a), true, a);
  for (const a of ["10.0.0.5", "192.168.1.148", "::ffff:10.0.0.5", "0.0.0.0", "::", "fe80::1", "127.0.0.1.evil", "", undefined, null])
    assert.equal(isLoopback(a), false, String(a));
});

// ---- the API ----------------------------------------------------------------------------------------------------
const TOKEN = "t".repeat(43);
function stubHost({ failSave = false } = {}) {
  const s = { caps: { cpuShare: 1, gpuShare: 1 }, saves: 0 };
  s.hostingCaps = () => ({ ...s.caps });
  s.setHostingCaps = (next) => { if (failSave) throw new Error("disk full"); s.saves++; s.caps = { ...next }; };
  s.hostingView = () => ({ caps: { ...s.caps }, backend: "hv" });
  return s;
}
async function serve(host, bind = "127.0.0.1") {
  const server = http.createServer(hostingAdminHandler({ host, token: TOKEN }));
  await new Promise((r) => server.listen(0, bind, r));
  servers.push(server);
  return server.address().port;
}
function call(port, { method = "GET", path: p = "/v1/local/hosting", token = TOKEN, body, host = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token === null ? {} : { authorization: `Bearer ${token}` };
    const req = http.request({ host, port, method, path: p, headers, agent: false }, (res) => {
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => { const t = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(t); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json: j }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

test("GET with the token answers the host's view; a missing or wrong token is 401 and learns no routes", async () => {
  const h = stubHost(); const port = await serve(h);
  const ok = await call(port);
  assert.equal(ok.status, 200); assert.deepEqual(ok.json, { caps: { cpuShare: 1, gpuShare: 1 }, backend: "hv" });
  assert.equal(ok.headers["cache-control"], "no-store");
  for (const token of [null, "", "wrong", TOKEN + "x", TOKEN.slice(1)]) {
    const r = await call(port, { token });
    assert.equal(r.status, 401, `token ${JSON.stringify(token)}`); assert.equal(r.headers["www-authenticate"], "Bearer");
  }
  assert.equal((await call(port, { path: "/v1/local/other", token: null })).status, 401, "no token: not even a 404");
  assert.equal((await call(port, { path: "/v1/local/other" })).status, 404);
  assert.equal((await call(port, { method: "POST" })).status, 405);
  // a handler with no token configured answers nobody
  const none = http.createServer(hostingAdminHandler({ host: h, token: "" })); await new Promise((r) => none.listen(0, "127.0.0.1", r)); servers.push(none);
  assert.equal((await call(none.address().port, { token: "" })).status, 401);
});

test("PUT sets and snaps; a bad body is 400 and changes nothing; an oversize body is 413; a failed save is 500 and changes nothing", async () => {
  const h = stubHost(); const port = await serve(h);
  const r = await call(port, { method: "PUT", body: { cpuShare: 0.33, gpuShare: 0.5 } });
  assert.equal(r.status, 200); assert.deepEqual(r.json.caps, { cpuShare: 0.35, gpuShare: 0.5 });
  for (const body of [{ cpuShare: 1.2 }, { cpuShare: "0.2" }, { cpu: 0.2 }, {}, "not json", "[1]"]) {
    const bad = await call(port, { method: "PUT", body });
    assert.equal(bad.status, 400, JSON.stringify(body)); assert.equal(bad.json.error, "bad_request");
  }
  const big = await call(port, { method: "PUT", body: JSON.stringify({ cpuShare: 0.5, pad: "x".repeat(5000) }) });
  assert.equal(big.status, 413);
  assert.deepEqual(h.caps, { cpuShare: 0.35, gpuShare: 0.5 }); assert.equal(h.saves, 1, "only the good PUT saved");
  const unauth = await call(port, { method: "PUT", token: "wrong", body: { cpuShare: 0 } });
  assert.equal(unauth.status, 401); assert.deepEqual(h.caps, { cpuShare: 0.35, gpuShare: 0.5 }, "a wrong token sets nothing");
  const failing = stubHost({ failSave: true }); const p2 = await serve(failing);
  const f = await call(p2, { method: "PUT", body: { cpuShare: 0.1 } });
  assert.equal(f.status, 500); assert.match(f.json.message, /not saved, so nothing changed: disk full/);
  assert.deepEqual(failing.caps, { cpuShare: 1, gpuShare: 1 });
});

test("a NON-LOOPBACK peer is refused even with the right token (the handler's own check, whatever the bind)", async () => {
  const h = stubHost();
  const handler = hostingAdminHandler({ host: h, token: TOKEN });
  for (const remoteAddress of ["192.168.1.5", "::ffff:10.0.0.7", "fe80::2", undefined]) {
    const out = {};
    // an empty body that ends at once, so a handler that skipped the check fails on the assertion rather than hanging
    const req = { socket: { remoteAddress }, headers: { authorization: `Bearer ${TOKEN}` }, method: "PUT", url: "/v1/local/hosting",
                  on(ev, cb) { if (ev === "end") setImmediate(cb); } };
    const res = { writeHead: (s, hd) => { out.status = s; out.headers = hd; }, end: (b) => { out.body = JSON.parse(b); } };
    await handler(req, res);
    assert.equal(out.status, 403, String(remoteAddress)); assert.equal(out.body.error, "forbidden");
  }
  assert.equal(h.saves, 0, "nothing was set from off the machine");
});

test("a MISCONFIGURED bind (0.0.0.0) still refuses a peer arriving over a real non-loopback interface", async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (!lan) return t.skip("no non-loopback IPv4 interface on this machine");
  const h = stubHost(); const port = await serve(h, "0.0.0.0");
  const r = await call(port, { host: lan.address, method: "PUT", body: { cpuShare: 0 } });
  assert.equal(r.status, 403); assert.equal(h.saves, 0);
  assert.equal((await call(port)).status, 200, "the same server answers loopback");
});

test("startHostingAdmin listens on 127.0.0.1 and nowhere else", async () => {
  const s = startHostingAdmin({ host: stubHost(), port: 0, token: TOKEN });
  servers.push(s);
  await new Promise((r) => s.once("listening", r));
  assert.equal(s.address().address, "127.0.0.1");
});
