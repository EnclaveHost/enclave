// The owner's hosting caps and their local API (hosting.mjs), without a Host: the handler is driven with a stub that
// has the Host's three methods. What these hold to: the caps survive a restart byte for byte and are written
// atomically; an unreadable caps file offers nothing new rather than everything; the token file is fresh, and on
// Windows is only ever created inside a directory whose DACL was set and read back first (so it is born private);
// and nobody off the machine, or without the token, gets an answer.
// The Host's own use of the caps (capacity, the claim gate, the isolated spawn gate) is test/windows-node-hosting-caps.test.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { CAP_STEP, DEFAULT_CAPS, snapShare, loadCaps, saveCaps, capsUpdate, mintToken, expectedDacl, daclProblem, fsOps,
         isLoopback, hostingAdminHandler, startHostingAdmin } from "./hosting.mjs";

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

test("the token elsewhere: fresh every start, a 0700 directory and a 0600 file, and a planted file is replaced, never read", async () => {
  const dir = tmp(), file = path.join(dir, "hosting", "hosting-admin.token");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "planted-by-someone-else\n");
  const a = await mintToken(file, { platform: "linux" });
  assert.match(a, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
  assert.equal(fs.readFileSync(file, "utf8").trim(), a);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const b = await mintToken(file, { platform: "linux" });
  assert.notEqual(a, b, "a new token per start");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["hosting-admin.token"], "no temporary file left");
});

// ---- the token on Windows, as far as it runs here: the two PowerShell steps faked, the file steps real and watched ----
const SYSTEM = "S-1-5-18", ADMINS = "S-1-5-32-544", USERS = "S-1-5-32-545";
const SELF = "S-1-5-21-1-2-3-1001", TRAY = "S-1-5-21-1-2-3-1002", MALLORY = "S-1-5-21-1-2-3-1666";
const FULL = 0x1F01FF, RX = 0x1200A9;
const usersInherited = [{ sid: USERS, rights: RX, allow: true, inherited: true, flags: 3 }];

/**
 * A Windows machine as far as mintToken can see it: %ProgramData%\Enclave (P) and its token directory (D) on a real
 * disk, the inspection and the DACL step faked, and every step - each inspection, the DACL, each file created, renamed
 * or removed - in one ordered log. Until protect() runs, D (if there) inherits Users:(RX), as a fresh folder would.
 */
function windowsBox({ parent = {}, existing = false, dirBefore = {}, readBack = {}, fileSeen = {}, traySid = TRAY, inspectFails = null } = {}) {
  const root = fs.realpathSync(tmp()), P = path.join(root, "Enclave"), D = path.join(P, "hosting"), F = path.join(D, "hosting-admin.token");
  if (existing) fs.mkdirSync(D, { recursive: true });
  const log = []; let dacl = false;
  const rel = (p) => path.relative(root, p);
  // the read-back is what protect() was asked to set, unless a test says the machine shows something else
  const set = () => win.want.map((w) => ({ sid: w.sid, rights: w.rights, allow: true, inherited: false, flags: 3 }));
  const view = (p) => {
    if (p === P) return { exists: true, dir: true, reparse: false, owner: SYSTEM, protected: false, rules: usersInherited, ...parent };
    if (p === D) {
      if (!fs.existsSync(D)) return { exists: false };
      return dacl ? { exists: true, dir: true, reparse: false, owner: SYSTEM, protected: true, rules: set(), ...readBack }
                  : { exists: true, dir: true, reparse: false, owner: SYSTEM, protected: false, rules: usersInherited, ...dirBefore };
    }
    if (p === F) return !fs.existsSync(F) ? { exists: false }
      : { exists: true, dir: false, reparse: false, owner: SYSTEM, protected: false, rules: set().map((r) => ({ ...r, inherited: true, flags: 0 })), ...fileSeen };
    throw new Error(`inspected an unexpected path ${p}`);
  };
  const win = {
    async inspect(paths, trayUser) {
      log.push(["inspect", ...paths.map(rel)]);
      if (inspectFails) throw new Error(inspectFails);
      return { selfSid: SELF, traySid: trayUser ? traySid : null, items: paths.map(view) };
    },
    async protect(d, want) { log.push(["protect", rel(d)]); win.want = want; fs.mkdirSync(d, { recursive: true }); dacl = true; return { action: "created" }; },
  };
  const fsx = { ...fsOps,
    writeNew: (p, data) => { log.push(["create", rel(p)]); return fsOps.writeNew(p, data); },
    rename: (a, b) => { log.push(["rename", rel(a), rel(b)]); return fsOps.rename(a, b); },
    unlink: (p) => { log.push(["unlink", rel(p)]); return fsOps.unlink(p); } };
  const mint = (o = {}) => mintToken(F, { platform: "win32", trayUser: "NUCBOX-K11\\steven", win, fsx, ...o });
  return { root, P, D, F, log, win, fsx, mint, steps: () => log.map((e) => e[0]) };
}

test("Windows: the directory's DACL is SET and READ BACK before the first file is created in it; the token lands by rename and is checked there", async () => {
  const b = windowsBox();
  const token = await b.mint();
  assert.deepEqual(b.steps(), ["inspect", "protect", "inspect", "create", "rename", "inspect"]);
  assert.deepEqual(b.log[2], ["inspect", "Enclave", "Enclave/hosting"], "the read-back, before anything is created");
  assert.match(b.log[3][1], /^Enclave\/hosting\/\.hosting-admin\.[0-9a-f]{16}\.tmp$/, "a random name, created new, inside the verified directory");
  assert.deepEqual(b.log[4], ["rename", b.log[3][1], "Enclave/hosting/hosting-admin.token"]);
  assert.deepEqual(b.log[5], ["inspect", "Enclave/hosting", "Enclave/hosting/hosting-admin.token"], "the file as it landed");
  assert.equal(fs.readFileSync(b.F, "utf8").trim(), token);
  assert.deepEqual(fs.readdirSync(b.D), ["hosting-admin.token"], "no temporary file left");
  assert.deepEqual(b.win.want, [{ sid: SYSTEM, rights: FULL }, { sid: ADMINS, rights: FULL }, { sid: SELF, rights: FULL }, { sid: TRAY, rights: RX }],
    "SYSTEM, Administrators and the node's account full; the tray's user read and traverse");
  // an existing directory takes the same path: the DACL is re-set and read back before anything is created
  const again = windowsBox({ existing: true });
  await again.mint();
  assert.deepEqual(again.steps(), ["inspect", "protect", "inspect", "create", "rename", "inspect"]);
});

test("Windows: refused before the DACL step and before any file - a reparse point or a foreign owner, on the directory or the folder above", async () => {
  for (const [o, re] of [
    [{ parent: { reparse: true } }, /Enclave: it is a reparse point/],
    [{ parent: { owner: MALLORY } }, /Enclave: it is owned by S-1-5-21-1-2-3-1666, not SYSTEM, Administrators or this node's account/],
    [{ parent: { dir: false } }, /Enclave: it is not a directory/],
    [{ existing: true, dirBefore: { reparse: true } }, /hosting: it is a reparse point/],
    [{ existing: true, dirBefore: { owner: MALLORY } }, /hosting: it is owned by S-1-5-21-1-2-3-1666/],
  ]) {
    const b = windowsBox(o);
    await assert.rejects(b.mint(), re, JSON.stringify(o));
    assert.deepEqual(b.steps(), ["inspect"], `${JSON.stringify(o)}: nothing set, nothing created`);
    assert.equal(fs.existsSync(b.F), false);
  }
});

test("Windows: a real link or junction where the directory (or a folder above it) should be is refused, whatever the inspection says", async () => {
  const b = windowsBox();
  const elsewhere = path.join(b.root, "elsewhere");
  fs.mkdirSync(elsewhere); fs.mkdirSync(b.P); fs.symlinkSync(elsewhere, b.D);
  await assert.rejects(b.mint(), /hosting: it is a symbolic link or a junction/);
  assert.deepEqual(b.steps(), []); assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing was written through the link");
  // a link further up: the folder resolves somewhere else
  const c = windowsBox();
  const alias = path.join(c.root, "alias"); fs.symlinkSync(c.root, alias);
  await assert.rejects(mintToken(path.join(alias, "Enclave", "hosting", "hosting-admin.token"),
    { platform: "win32", win: c.win, fsx: c.fsx }), /resolves to .*: a folder on the way is a junction or a link/);
  assert.deepEqual(c.steps(), []);
});

test("Windows: the DACL must READ BACK exactly as set - anything else and no file is ever created", async () => {
  const exact = expectedDacl({ selfSid: SELF, traySid: TRAY }).map((w) => ({ sid: w.sid, rights: w.rights, allow: true, inherited: false, flags: 3 }));
  for (const [readBack, re] of [
    [{ protected: false }, /not protected: it still inherits/],
    [{ rules: [...exact, { sid: USERS, rights: RX, allow: true, inherited: false, flags: 3 }] }, /grants S-1-5-32-545/],
    [{ rules: [...exact, ...usersInherited] }, /grants S-1-5-32-545/],
    [{ rules: exact.filter((r) => r.sid !== TRAY) }, /does not grant S-1-5-21-1-2-3-1002/],
    [{ rules: exact.map((r) => (r.sid === TRAY ? { ...r, rights: FULL } : r)) }, /gives S-1-5-21-1-2-3-1002 0x1f01ff, not 0x1200a9/],
    [{ rules: exact.map((r) => (r.sid === TRAY ? { ...r, allow: false } : r)) }, /deny entry for S-1-5-21-1-2-3-1002/],
    [{ rules: exact.map((r) => ({ ...r, inherited: true })) }, /entry for S-1-5-18 is inherited/],
    [{ rules: exact.map((r) => ({ ...r, flags: 0 })) }, /not inherited by what is created inside/],
    [{ rules: [...exact, exact[0]] }, /has 5 entries, not the 4 this node set/],
    [{ owner: MALLORY }, /owned by S-1-5-21-1-2-3-1666/],
    [{ reparse: true }, /reparse point/],
  ]) {
    const b = windowsBox({ readBack });
    await assert.rejects(b.mint(), re, JSON.stringify(readBack));
    assert.deepEqual(b.steps(), ["inspect", "protect", "inspect"], `${JSON.stringify(readBack)}: set, read back, refused, nothing created`);
    assert.deepEqual(fs.readdirSync(b.D), []);
  }
  // .NET adds SYNCHRONIZE to every allow entry; the comparison ignores that bit and nothing else
  const noSync = exact.map((r) => ({ ...r, rights: r.rights & ~0x100000 }));
  assert.equal(daclProblem({ exists: true, dir: true, reparse: false, owner: SYSTEM, protected: true, rules: noSync }, expectedDacl({ selfSid: SELF, traySid: TRAY }), [SYSTEM, ADMINS, SELF]), null);
});

test("Windows: the file as it landed must carry exactly the directory's entries, inherited; otherwise its token is never used and the file is removed", async () => {
  const inherited = expectedDacl({ selfSid: SELF, traySid: TRAY }).map((w) => ({ sid: w.sid, rights: w.rights, allow: true, inherited: true, flags: 0 }));
  for (const [fileSeen, re] of [
    [{ rules: inherited.map((r) => ({ ...r, inherited: false })) }, /its own, not inherited from the token directory/],
    [{ rules: [...inherited, { sid: USERS, rights: RX, allow: true, inherited: true, flags: 0 }] }, /grants S-1-5-32-545/],
    [{ owner: MALLORY }, /owned by S-1-5-21-1-2-3-1666/],
    [{ reparse: true }, /reparse point/],
  ]) {
    const b = windowsBox({ fileSeen });
    await assert.rejects(b.mint(), re, JSON.stringify(fileSeen));
    assert.equal(fs.existsSync(b.F), false, "the unverified token file is removed");
    assert.deepEqual(fs.readdirSync(b.D), []);
  }
});

test("Windows: a token already there is NEVER trusted - replaced by a fresh one, and gone if the fresh one fails its check", async () => {
  const b = windowsBox({ existing: true });
  fs.writeFileSync(b.F, "planted-by-someone-else\n");
  const t1 = await b.mint();
  assert.notEqual(t1, "planted-by-someone-else"); assert.equal(fs.readFileSync(b.F, "utf8").trim(), t1);
  const t2 = await b.mint();
  assert.notEqual(t2, t1, "a new token every start, never the last one");
  const c = windowsBox({ existing: true, fileSeen: { owner: MALLORY } });
  fs.writeFileSync(c.F, "planted-by-someone-else\n");
  await assert.rejects(c.mint(), /owned by/);
  assert.equal(fs.existsSync(c.F), false, "neither the planted token nor the unverified new one is left");
});

test("Windows: a tray user that does not resolve to a SID, or an inspection that fails, mints nothing", async () => {
  const b = windowsBox({ traySid: null });
  await assert.rejects(b.mint(), /the tray user did not resolve to a SID/);
  assert.deepEqual(b.steps(), ["inspect"]);
  const c = windowsBox({ inspectFails: "Some or all identity references could not be translated." });
  await assert.rejects(c.mint(), /could not be translated/);
  assert.deepEqual(c.steps(), ["inspect"]);
  // no tray user configured: SYSTEM, Administrators and the node's account only
  const d = windowsBox();
  await d.mint({ trayUser: "" });
  assert.deepEqual(d.win.want.map((w) => w.sid), [SYSTEM, ADMINS, SELF]);
  assert.deepEqual(expectedDacl({ selfSid: SYSTEM }).map((w) => w.sid), [SYSTEM, ADMINS], "running as SYSTEM adds no third full grant");
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
