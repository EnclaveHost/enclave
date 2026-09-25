// guestd-control/1: the Windows manager's server side, proved by the SUPERVISOR'S OWN CLIENT.
//
// The point of this file is that it does not mock the other end. isolation/m4/guestd/control-client.mjs
// is the client the supervisor actually uses against the Linux tier's guestd; it is pointed at this
// manager over a real loopback socket. If the Windows side ever drifts from the protocol, this
// fails, which is the only way a third implementation of a wire format is safe to have.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { ControlServer, keyId, parseKey, PROTO } from "./control.mjs";
import { GuestdControl } from "../../../isolation/m4/guestd/control-client.mjs";

const KEY = Buffer.from("11".repeat(32), "hex");

/** The manager's routes behind the channel: enough to be worth authenticating. */
const routes = async ({ method, path, body }) => {
  if (method === "GET" && path === "/health") return { status: 200, body: { backend: "hyperv-partition-per-app", canStart: false } };
  if (method === "GET" && path === "/vms") return { status: 200, body: { vms: [] } };
  if (method === "POST" && path === "/vms") return { status: 200, body: { echo: JSON.parse(body || "{}") } };
  if (method === "GET" && path === "/boom") throw new Error("kaboom");
  return { status: 404, body: { error: "not_found" } };
};

async function serve({ key = KEY } = {}) {
  const ctl = new ControlServer({ key, handle: routes });
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    const u = new URL(req.url, "http://127.0.0.1");
    let out;
    if (req.method === "GET" && u.pathname === "/control/hello") out = ctl.hello();
    else if (req.method === "POST" && u.pathname === "/control/session") out = ctl.session(JSON.parse(body || "{}"));
    else out = await ctl.call({ method: req.method, path: req.url, headers: req.headers, body });
    const raw = Buffer.from(JSON.stringify(out.body ?? {}));
    res.writeHead(out.status, { "content-type": "application/json", "content-length": raw.length, ...(out.headers || {}) });
    res.end(raw);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { ctl, srv, base, close: () => new Promise((r) => srv.close(r)) };
}

test("the supervisor's own client completes a handshake and a signed request", async () => {
  const s = await serve();
  try {
    const c = new GuestdControl(s.base, KEY);
    const r = await c.request("GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.backend, "hyperv-partition-per-app");
    assert.equal(c.instance, s.ctl.instance, "the session is bound to THIS manager's instance");
  } finally { await s.close(); }
});

test("a body round-trips, and the answer's MAC is checked by the client", async () => {
  const s = await serve();
  try {
    const c = new GuestdControl(s.base, KEY);
    const r = await c.request("POST", "/vms", { derive: { cid: "bafy" } }, { idempotent: false });
    assert.deepEqual(r.body.echo, { derive: { cid: "bafy" } });
  } finally { await s.close(); }
});

test("a client holding a DIFFERENT pairing key is refused", async () => {
  const s = await serve();
  try {
    const c = new GuestdControl(s.base, Buffer.from("22".repeat(32), "hex"));
    await assert.rejects(() => c.request("GET", "/health"), (e) => e.kind === "refused" || e.kind === "protocol");
  } finally { await s.close(); }
});

test("with no key configured the channel refuses rather than falling back", async () => {
  const s = await serve({ key: null });
  try {
    assert.equal(s.ctl.hello().status, 503);
    const c = new GuestdControl(s.base, KEY);
    await assert.rejects(() => c.request("GET", "/health"), (e) => !!e.kind,
      "a client expecting the protocol must fail closed, never proceed unauthenticated");
  } finally { await s.close(); }
});

/* ---- the properties the wire format exists for, driven directly ------------------------------- */

const handshake = async (ctl) => {
  const h = ctl.hello().body;
  const clientNonce = crypto.randomBytes(32).toString("hex");
  const mac = crypto.createHmac("sha256", KEY).update([PROTO + " session", h.instance, h.nonce, clientNonce, h.kid].join("\n")).digest("hex");
  const s = ctl.session({ instance: h.instance, nonce: h.nonce, clientNonce, kid: h.kid, mac });
  const skey = crypto.createHmac("sha256", KEY).update([PROTO + " skey", h.instance, h.nonce, clientNonce, s.body.session].join("\n")).digest();
  return { h, s: s.body, skey, clientNonce };
};
const sign = (skey, id, seq, method, path, body = "") =>
  crypto.createHmac("sha256", skey).update([PROTO + " req", id, String(seq), method, path,
    crypto.createHash("sha256").update(Buffer.from(body)).digest("hex")].join("\n")).digest("hex");

test("this manager proves it holds the key too: the client checks the proof", async () => {
  const ctl = new ControlServer({ key: KEY, handle: routes });
  const { s, skey, clientNonce } = await handshake(ctl);
  const want = crypto.createHmac("sha256", skey).update([PROTO + " proof", clientNonce].join("\n")).digest("hex");
  assert.equal(s.proof, want, "an impostor without K cannot produce this");
});

test("a nonce is single use, and an unknown one is refused", async () => {
  const ctl = new ControlServer({ key: KEY, handle: routes });
  const h = ctl.hello().body;
  const cn = crypto.randomBytes(32).toString("hex");
  const mac = crypto.createHmac("sha256", KEY).update([PROTO + " session", h.instance, h.nonce, cn, h.kid].join("\n")).digest("hex");
  assert.equal(ctl.session({ instance: h.instance, nonce: h.nonce, clientNonce: cn, kid: h.kid, mac }).status, 200);
  assert.equal(ctl.session({ instance: h.instance, nonce: h.nonce, clientNonce: cn, kid: h.kid, mac }).status, 401, "spent");
  assert.equal(ctl.session({ instance: h.instance, nonce: "ff".repeat(32), clientNonce: cn, kid: h.kid, mac }).status, 401, "unknown");
});

test("a sequence number is accepted once, and a forgery cannot burn one", async () => {
  const ctl = new ControlServer({ key: KEY, handle: routes });
  const { s, skey } = await handshake(ctl);
  const ok = async (n) => (await ctl.call({ method: "GET", path: "/health", body: "",
    headers: { "x-guestd-session": s.session, "x-guestd-seq": String(n), "x-guestd-mac": sign(skey, s.session, n, "GET", "/health") } })).status;
  assert.equal(await ok(1), 200);
  assert.equal(await ok(1), 401, "replayed");
  // a WRONG mac at seq 2 must not consume seq 2
  const bad = await ctl.call({ method: "GET", path: "/health", body: "",
    headers: { "x-guestd-session": s.session, "x-guestd-seq": "2", "x-guestd-mac": "00".repeat(32) } });
  assert.equal(bad.status, 401);
  assert.equal(await ok(2), 200, "a forgery must not burn a sequence number");
});

test("a session signed for another instance is not accepted here", async () => {
  const a = new ControlServer({ key: KEY, handle: routes });
  const b = new ControlServer({ key: KEY, handle: routes });
  assert.notEqual(a.instance, b.instance, "a new instance at every start");
  const h = b.hello().body;
  const cn = crypto.randomBytes(32).toString("hex");
  const mac = crypto.createHmac("sha256", KEY).update([PROTO + " session", h.instance, h.nonce, cn, h.kid].join("\n")).digest("hex");
  assert.equal(a.session({ instance: h.instance, nonce: h.nonce, clientNonce: cn, kid: h.kid, mac }).status, 401);
});

test("the answer is MACed over status and body, so a swapped answer is caught", async () => {
  const ctl = new ControlServer({ key: KEY, handle: routes });
  const { s, skey } = await handshake(ctl);
  const r = await ctl.call({ method: "GET", path: "/health", body: "",
    headers: { "x-guestd-session": s.session, "x-guestd-seq": "1", "x-guestd-mac": sign(skey, s.session, 1, "GET", "/health") } });
  const raw = Buffer.from(JSON.stringify(r.body));
  const want = crypto.createHmac("sha256", skey).update([PROTO + " resp", s.session, "1", String(r.status),
    crypto.createHash("sha256").update(raw).digest("hex")].join("\n")).digest("hex");
  assert.equal(r.headers["x-guestd-response-mac"], want);
});

test("a route that throws becomes a signed 500, not an unsigned crash", async () => {
  const ctl = new ControlServer({ key: KEY, handle: routes });
  const { s, skey } = await handshake(ctl);
  const r = await ctl.call({ method: "GET", path: "/boom", body: "",
    headers: { "x-guestd-session": s.session, "x-guestd-seq": "1", "x-guestd-mac": sign(skey, s.session, 1, "GET", "/boom") } });
  assert.equal(r.status, 500);
  assert.ok(r.headers["x-guestd-response-mac"], "still MACed: the client must be able to trust the failure");
});

test("the nonce and session tables are bounded, so an unauthenticated hello cannot grow memory", () => {
  const ctl = new ControlServer({ key: KEY, handle: routes });
  for (let i = 0; i < 500; i++) ctl.hello();
  assert.ok(ctl.nonces.size <= 64, `nonces bounded, got ${ctl.nonces.size}`);
});

test("the key file rule is the shared one", () => {
  assert.equal(keyId(KEY).length, 16);
  assert.deepEqual(parseKey("11".repeat(32) + "\n"), KEY);
  assert.throws(() => parseKey("00".repeat(32)), /all-zero/);
  assert.throws(() => parseKey("nope"), /64 lowercase hex/);
  assert.throws(() => parseKey("AA".repeat(32)), /64 lowercase hex/, "lowercase only");
});
