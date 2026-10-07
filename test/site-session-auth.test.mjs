// Host-routed owner calls from the site sign with the browser's WALLET SESSION (site/js/core/api.js _sessionReq),
// and fall back to the per-host SIWE token only when a host answers 401 to a live session (one that predates
// sessions), or 403 for one route. These pin: what is signed (method, the exact URL incl. query, the exact body
// string) and with which scope; that the header goes only to the configured endpoint; the per-host memory of a host
// that needs its own sign-in; that a dead session marks nothing; that no session means the old behaviour; and that
// the wallet is prompted only after a 401 (wallet.js asHostOwner), never for a poll.
//   run: node --test test/site-session-auth.test.mjs
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---- a browser just big enough for api.js / wallet.js / sessions.js ----
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k), clear: () => store.clear(),
};
const doc = new EventTarget();
doc.querySelector = () => null; doc.querySelectorAll = () => [];
globalThis.document = doc;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = (m) => import(pathToFileURL(path.join(ROOT, "site/js/core", m)).href);
const { Enclave, EnclaveError, WALLET_SESSION_KEY } = await core("api.js");
const { asHostOwner } = await core("wallet.js");
const { hostAuthorization, sessionStillLive, _useSdkForTests } = await core("sessions.js");

const BASE = "https://api.example.test/v1";
const ADDR = "0x1111111111111111111111111111111111111111";
const ID = "0x" + "ab".repeat(32);
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub) => `${b64u({ alg: "ES256" })}.${b64u({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

// ---- the network: a scripted host per request, every request recorded ----
let reqs = [], answer = null;
globalThis.fetch = async (url, init = {}) => {
  const r = { url: String(url), method: init.method || "GET", auth: (init.headers || {}).Authorization, body: init.body };
  reqs.push(r);
  const [status, body] = answer(r);
  return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
};
// ---- the session: hostAuthorization records what it was asked to sign ----
let signed = [], sessionOn = true, stillLive = true;
const hooks = {
  hostAuthorization: async (method, url, body, scope) => {
    signed.push({ method, url, body, scope });
    return sessionOn ? `EnclaveSession v1 test=${signed.length}` : null;
  },
  sessionStillLive: async () => stillLive,
};
const isSession = (r) => /^EnclaveSession /.test(r.auth || "");

beforeEach(() => {
  store.clear();
  reqs = []; signed = []; sessionOn = true; stillLive = true;
  answer = () => [200, { ok: true }];
  Enclave.base = BASE; Enclave.address = ADDR; Enclave.provider = null;
  Enclave.token = null; Enclave.tokenBase = null; Enclave.enclaveTokens = {};
  Enclave.sessionHooks = hooks; Enclave._ownerSession = null;
  Enclave._siweHosts = new Set(); Enclave._sessionRefused = new Set();
  store.set(WALLET_SESSION_KEY, "0x" + "cd".repeat(32));
});

test("each host-routed owner call is signed by the session: method, exact URL with its query, the scope it needs", async () => {
  await Enclave.logs(ID, { tail: 200 }, "metal0");
  await Enclave.attestation(ID, "metal0");
  await Enclave.restartDeployment(ID, "metal0");
  await Enclave.appToken(ID, "metal0");
  await Enclave.terminateDeployment(ID, "metal0", true);
  await Enclave.terminateDeployment(ID, "metal0");
  const want = [
    ["GET", `${BASE}/deployments/${ID}/logs?tail=200`, "api.logs"],
    ["GET", `${BASE}/deployments/${ID}/attestation`, "api.status"],
    ["POST", `${BASE}/deployments/${ID}/restart`, "api.restart"],
    ["POST", `${BASE}/deployments/${ID}/app-token`, "api.appAccess"],
    ["DELETE", `${BASE}/deployments/${ID}?evacuate=1`, "api.restart"],
    ["DELETE", `${BASE}/deployments/${ID}`, "api.restart"],
  ];
  assert.deepEqual(signed.map((s) => [s.method, s.url, s.scope]), want);
  assert.deepEqual(reqs.map((r) => [r.method, r.url]), want.map(([m, u]) => [m, u]), "sent exactly what was signed");
  assert.ok(reqs.every(isSession), "every one carried the session header");
  assert.ok(signed.every((s) => s.body === undefined) && reqs.every((r) => r.body === undefined), "no body invented");
  assert.deepEqual(Enclave.enclaveTokens, {}, "no per-host sign-in was needed");
});

test("a body is signed as the exact string that is sent", async () => {
  await Enclave._req("POST", "/deployments/" + ID + "/thing", { auth: true, enclave: "metal0", scope: "api.status",
    body: { b: "ü ✓", a: [1, 2], n: null } });
  assert.equal(signed[0].body, JSON.stringify({ b: "ü ✓", a: [1, 2], n: null }));
  assert.equal(reqs[0].body, signed[0].body);
});

test("a host that predates sessions (401 to a live one) falls back ONCE to its per-host sign-in, remembered per host", async () => {
  answer = (r) => isSession(r) && r.url.includes("/logs") ? [401, { message: "Missing or invalid session" }] : [200, { ok: 1 }];
  // no per-host token yet: the session try, then the not-signed-in 401 (no second request) - the caller's cue
  await assert.rejects(Enclave.logs(ID, { tail: 200 }, "Metal0"), (e) => e instanceof EnclaveError && e.status === 401);
  assert.equal(reqs.length, 1, "the session try is the only request");
  assert.ok(Enclave._siweHosts.has("metal0"), "the host is remembered (case-insensitively)");
  assert.equal(Enclave.sessionMayServe("metal0"), false);
  assert.equal(Enclave.sessionMayServe("kryptos"), true, "other hosts are not");

  // once signed in to it: straight to the per-host token, no session attempt for that host again
  Enclave.setSessionFor("metal0", jwt(ADDR));
  reqs = []; signed = [];
  await Enclave.logs(ID, { tail: 200 }, "metal0");
  await Enclave.restartDeployment(ID, "metal0");
  assert.equal(signed.length, 0, "the session isn't even asked for that host");
  assert.ok(reqs.every((r) => /^Bearer /.test(r.auth)));

  // another host still gets the session
  reqs = []; signed = [];
  await Enclave.restartDeployment(ID, "kryptos");
  assert.ok(isSession(reqs[0]));
});

test("with a per-host token already held, the fallback happens inside the same call", async () => {
  Enclave.setSessionFor("metal0", jwt(ADDR));
  answer = (r) => isSession(r) ? [401, {}] : [200, { lines: "x" }];
  const out = await Enclave.logs(ID, { tail: 200 }, "metal0");
  assert.deepEqual(out, { lines: "x" });
  assert.deepEqual(reqs.map((r) => (isSession(r) ? "session" : r.auth.split(" ")[0])), ["session", "Bearer"]);
});

test("a 401 under a session that turns out to be over marks no host", async () => {
  stillLive = false;
  answer = (r) => isSession(r) ? [401, { message: "this session has ended or expired" }] : [200, {}];
  await assert.rejects(Enclave.logs(ID, {}, "metal0"), (e) => e.status === 401);
  assert.equal(Enclave._siweHosts.size, 0);
});

test("a 403 (the host refused the session for this record) falls back for that route only", async () => {
  Enclave.setSessionFor("metal0", jwt(ADDR));
  answer = (r) => isSession(r) && r.url.endsWith("/restart") ? [403, { message: "not delegated" }] : [200, {}];
  await Enclave.restartDeployment(ID, "metal0");
  assert.deepEqual(reqs.map((r) => (isSession(r) ? "session" : "Bearer")), ["session", "Bearer"]);
  reqs = [];
  await Enclave.restartDeployment(ID, "metal0");
  assert.deepEqual(reqs.map((r) => (isSession(r) ? "session" : "Bearer")), ["Bearer"], "remembered for that route");
  reqs = [];
  await Enclave.logs(ID, {}, "metal0");
  assert.ok(isSession(reqs[0]), "the host's other routes still try the session");
  assert.equal(Enclave._siweHosts.size, 0, "a 403 is not an old host");
});

test("other failures under the session are real answers: thrown, no fallback", async () => {
  Enclave.setSessionFor("metal0", jwt(ADDR));
  answer = () => [503, { message: "The host holding it is not attached right now." }];
  await assert.rejects(Enclave.logs(ID, {}, "metal0"), (e) => e.status === 503 && /not attached/.test(e.message));
  assert.equal(reqs.length, 1);
});

test("no session: exactly the old behaviour (per-host token, or a local 401 with no request)", async () => {
  sessionOn = false;
  await assert.rejects(Enclave.logs(ID, {}, "metal0"), (e) => e.status === 401 && /Not signed in to metal0/.test(e.message));
  assert.equal(reqs.length, 0);
  Enclave.setSessionFor("metal0", jwt(ADDR));
  await Enclave.logs(ID, {}, "metal0");
  assert.equal(reqs.length, 1); assert.match(reqs[0].auth, /^Bearer /);

  // and with no session in this browser at all, the sessions client is never consulted
  Enclave.sessionHooks = null; store.delete(WALLET_SESSION_KEY); reqs = [];
  await Enclave.logs(ID, {}, "metal0");
  assert.match(reqs[0].auth, /^Bearer /);
  assert.equal(Enclave.sessionHooks, null, "sessions.js was not loaded");
});

test("list: signed with ?owner= for the relay's merge; a refusal falls back to the public read, never throws", async () => {
  await Enclave.listDeployments();
  assert.equal(signed[0].url, `${BASE}/deployments?owner=${ADDR}`);
  assert.equal(signed[0].scope, "api.status");
  assert.ok(isSession(reqs[0]));

  reqs = []; signed = [];
  answer = (r) => isSession(r) ? [401, { message: "replayed request" }] : [200, { data: [] }];
  const out = await Enclave.listDeployments();
  assert.deepEqual(out, { data: [] });
  assert.deepEqual(reqs.map((r) => [r.url, r.auth || null]),
    [[`${BASE}/deployments?owner=${ADDR}`, reqs[0].auth], [`${BASE}/deployments?owner=${ADDR}`, null]]);
});

test("get: signed WITHOUT ?owner= (a vault-held record is not the wallet's; the relay's fallback stays unscoped)", async () => {
  await Enclave.getDeployment(ID);
  assert.equal(signed[0].url, `${BASE}/deployments/${ID}`);
  assert.equal(signed[0].scope, "api.status");
});

test("sessionMayServe: only with a session in this browser, for the connected wallet, while nothing says it is over", () => {
  assert.equal(Enclave.sessionMayServe(""), true);
  store.delete(WALLET_SESSION_KEY);
  assert.equal(Enclave.sessionMayServe(""), false);
  store.set(WALLET_SESSION_KEY, "0xs1");
  Enclave._ownerSession = { sid: "0xs1", owner: "0x" + "22".repeat(20), live: true, expiresAt: Date.now() / 1000 + 600 };
  assert.equal(Enclave.sessionMayServe(""), false, "another wallet's session");
  Enclave._ownerSession = { sid: "0xs1", owner: ADDR, live: false, expiresAt: Date.now() / 1000 + 600 };
  assert.equal(Enclave.sessionMayServe(""), false, "ended");
  Enclave._ownerSession = { sid: "0xs1", owner: ADDR, live: true, expiresAt: Date.now() / 1000 - 1 };
  assert.equal(Enclave.sessionMayServe(""), false, "expired");
  Enclave._ownerSession = { sid: "0xs1", owner: ADDR, live: true, expiresAt: Date.now() / 1000 + 600 };
  assert.equal(Enclave.sessionMayServe(""), true);
  Enclave.address = null;
  assert.equal(Enclave.sessionMayServe(""), false, "no wallet connected");
});

// ---- sessions.js hostAuthorization over a stand-in SDK: the guards in front of every signature ----
const SID = "0x" + "cd".repeat(32), VAULT = "0x" + "55".repeat(20);
const sess = { status: null, made: [], reads: 0 };
function fakeSdk({ owner = ADDR, relay = "https://api.example.test", actions = (1n << 128n) | (1n << 129n) | (1n << 130n) } = {}) {
  sess.made = []; sess.reads = 0;
  sess.status = { live: true, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 600), actions };
  const rec = { id: SID, relay, label: "this browser", handle: { owner, vault: VAULT, sid: SID, relay } };
  _useSdkForTests({
    ACTIONS: { "api.status": 128, "api.logs": 129, "api.restart": 130, "api.upload": 131, "api.appAccess": 132 },
    IndexedDbStore: class { async load(id) { return id === SID ? rec : null; } async remove() {} },
    sessionFromRecord: async (r) => ({ handle: r.handle,
      status: async () => { sess.reads++; return sess.status; },
      apiAuthorization: async (m, u, b) => { sess.made.push([m, u, b]); return `EnclaveSession v1 vault=${VAULT},sid=${SID}`; } }),
  });
}

test("hostAuthorization signs the exact request for the connected wallet's live session, with the scope it holds", async () => {
  store.set(WALLET_SESSION_KEY, SID); fakeSdk();
  assert.match(await hostAuthorization("GET", BASE + "/deployments/x/logs?tail=200", undefined, "api.logs"), /^EnclaveSession v1 /);
  assert.match(await hostAuthorization("POST", BASE + "/deployments/x/restart", '{"a":1}', "api.restart"), /^EnclaveSession v1 /);
  assert.deepEqual(sess.made, [["GET", BASE + "/deployments/x/logs?tail=200", ""], ["POST", BASE + "/deployments/x/restart", '{"a":1}']],
    "no body is signed as the empty string; a body as itself");
  assert.equal(sess.reads, 1, "the chain status is cached between calls (a log poll must not read the chain every 5 s)");
  assert.equal(await hostAuthorization("POST", BASE + "/deployments/x/app-token", undefined, "api.appAccess"), null,
    "a scope the session lacks: no header (the per-host sign-in serves it)");
});

test("the session header is only ever made for the configured API endpoint, of the relay the session was opened against", async () => {
  store.set(WALLET_SESSION_KEY, SID); fakeSdk();
  for (const url of ["https://evil.example/v1/deployments/x/logs", BASE + "evil/deployments/x/logs", "https://api.example.test/v2/x",
                     "http://api.example.test/v1/deployments/x/logs"])
    assert.equal(await hostAuthorization("GET", url, undefined, "api.logs"), null, url);
  assert.equal(sess.made.length, 0);
  // the endpoint field pointed somewhere else: that relay never saw this session open, and gets nothing
  Enclave.base = "https://other-relay.example/v1";
  assert.equal(await hostAuthorization("GET", "https://other-relay.example/v1/deployments/x/logs", undefined, "api.logs"), null);
  Enclave.base = BASE;
  // and api.js only ever builds URLs on `base`
  Enclave.sessionHooks = null;
  await Enclave.logs(ID, {}, "metal0");
  assert.ok(isSession(reqs[0]));
  assert.ok(reqs.every((r) => r.url.startsWith(BASE + "/")));
});

test("hostAuthorization: another wallet's session, an ended one or an expired one signs nothing", async () => {
  store.set(WALLET_SESSION_KEY, SID);
  fakeSdk({ owner: "0x" + "22".repeat(20) });
  assert.equal(await hostAuthorization("GET", BASE + "/deployments/x/logs", undefined, "api.logs"), null, "another wallet's");
  fakeSdk(); sess.status.live = false;
  assert.equal(await hostAuthorization("GET", BASE + "/deployments/x/logs", undefined, "api.logs"), null, "ended");
  fakeSdk(); sess.status.expiresAt = BigInt(Math.floor(Date.now() / 1000) - 1);
  assert.equal(await hostAuthorization("GET", BASE + "/deployments/x/logs", undefined, "api.logs"), null, "expired");
  Enclave.address = null; fakeSdk();
  assert.equal(await hostAuthorization("GET", BASE + "/deployments/x/logs", undefined, "api.logs"), null, "no wallet connected");
  assert.equal(sess.made.length, 0);
});

test("sessionStillLive re-reads the chain: live -> true; over -> false, and this browser forgets the session", async () => {
  store.set(WALLET_SESSION_KEY, SID); fakeSdk();
  await hostAuthorization("GET", BASE + "/deployments/x/logs", undefined, "api.logs");
  assert.equal(await sessionStillLive(), true);
  assert.equal(sess.reads, 2, "a fresh read, not the cache");
  let ended = null; const on = (e) => { ended = e.detail; }; document.addEventListener("enclave:session", on);
  sess.status = { ...sess.status, live: false };
  assert.equal(await sessionStillLive(), false);
  document.removeEventListener("enclave:session", on);
  assert.equal(store.get(WALLET_SESSION_KEY), "", "forgotten");
  assert.deepEqual(ended, { active: false });
  assert.equal(Enclave.sessionMayServe(""), false);
});

// ---- wallet.js asHostOwner: the wallet is asked only after a 401, and never for prompt:false ----
const SIWE = (nonce) => ["api.example.test wants you to sign in with your Ethereum account:", ADDR, "",
  "Sign in to Enclave", "", "URI: https://api.example.test", "Version: 1", "Chain ID: 8453", "Nonce: " + nonce].join("\n");
function walletStub() {
  const asked = [];
  Enclave.provider = { request: async ({ method }) => { asked.push(method); return "0x" + "11".repeat(65); } };
  return asked;
}

test("asHostOwner: the session serves it - no wallet prompt", async () => {
  const asked = walletStub();
  const out = await asHostOwner("metal0", (h) => Enclave.restartDeployment(ID, h));
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(asked, []);
  assert.ok(isSession(reqs[0]));
});

test("asHostOwner: an old host's 401 -> ONE per-host SIWE (pinned to that host), then the call once more with its token", async () => {
  const asked = walletStub();
  answer = (r) => {
    if (isSession(r)) return [401, { message: "Missing or invalid session" }];
    if (r.url.includes("/auth/nonce")) return [200, { message: SIWE("n1") }];
    if (r.url.includes("/auth/login")) return [200, { token: jwt(ADDR) }];
    return /^Bearer /.test(r.auth || "") ? [200, { restarted: true }] : [401, {}];
  };
  const out = await asHostOwner("metal0", (h) => Enclave.restartDeployment(ID, h));
  assert.deepEqual(out, { restarted: true });
  assert.deepEqual(asked, ["personal_sign"], "one wallet signature");
  assert.deepEqual(reqs.map((r) => r.method + " " + r.url.replace(BASE, "") + (isSession(r) ? " [session]" : r.auth ? " [bearer]" : "")), [
    `POST /deployments/${ID}/restart [session]`,
    `GET /auth/nonce?address=${ADDR}&enclave=metal0`,
    `POST /auth/login?enclave=metal0`,
    `POST /deployments/${ID}/restart [bearer]`,
  ]);
});

test("asHostOwner prompt:false (polls, panels opened without a click): the 401 comes back, the wallet is never asked", async () => {
  const asked = walletStub();
  answer = (r) => isSession(r) ? [401, {}] : [200, {}];
  await assert.rejects(asHostOwner("metal0", (h) => Enclave.logs(ID, { tail: 200 }, h), { prompt: false }), (e) => e.status === 401);
  assert.deepEqual(asked, []);
});
