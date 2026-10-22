// Public, credentialless CORS on exactly the two owner-read routes (custody/v2/http.mjs OWNER_READ_ROUTES, ingress.mjs), so
// the policy owner's own browser can call its committee directly (site/js/core/independent-secrets.js):
//   - the preflight is answered before the rate limit, the body and the custodian (no token, challenge or budget spent);
//   - every owner-read answer, refusals included, carries Access-Control-Allow-Origin: *, and never Allow-Credentials;
//   - every other route, and a custodian without owner read, answers exactly as before (no CORS, OPTIONS 405);
//   - the REAL Caddy site from directCustodyIngress forwards the preflight for exactly those two paths (CADDY_BIN).
//   run: node --test --test-concurrency=1 test/custody-owner-read-cors.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createCustodyRouter, OWNER_READ_ROUTES } from "../custody/v2/http.mjs";
import { Refusal } from "../custody/v2/custodian.mjs";
import { directCustodyIngress } from "../custody/v2/ingress.mjs";
import { mintLocalCa } from "./helpers/local-tls.mjs";

const ORIGIN = "https://dashboard.example";
/** a custodian stand-in that counts what reaches it (the router is what is under test) */
function stubCustodian({ ownerRead = true } = {}) {
  const calls = { challenge: 0, release: 0, ownerChallenge: 0, ownerRead: 0 };
  const c = {
    encKeyHex: "11".repeat(32),
    challenge: () => { calls.challenge++; return { encKey: "11".repeat(32), nonce: "22".repeat(32), expiresAt: 1 }; },
    release: async () => { calls.release++; throw new Refusal(403, "bad_challenge", "no"); },
  };
  if (ownerRead) {
    c.ownerChallenge = () => { calls.ownerChallenge++; return { encKey: "11".repeat(32), nonce: "33".repeat(32), expiresAt: 1 }; };
    c.ownerRead = async (b) => { calls.ownerRead++; if (b.refuse) throw new Refusal(403, "owner_sig", "not the owner"); return { v: 2, encKey: "11".repeat(32), count: 1, sealed: "AA==" }; };
  }
  return { c, calls };
}
async function serve(custodian, rate) {
  const member = { info: () => ({ v: 2 }), evidence: async () => ({}), join: async () => ({}), approve: async () => ({}), setHostSig: async () => ({}), approveCode: async () => ({}) };
  const srv = http.createServer(createCustodyRouter({ custodian, member, runIndependent: async () => ({}), servedCommittee: () => null, chainId: 8453, vault: "0x" + "56".repeat(20), rate }));
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); srv.close(); } };
}
const req = async (url, method, { body, headers = {} } = {}) => {
  const r = await fetch(url, { method, headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, headers: Object.fromEntries(r.headers), text: await r.text() };
};
const preflight = { "access-control-request-method": "POST", "access-control-request-headers": "content-type" };

test("router: the owner-read preflight is answered before the rate limit, the body and the custodian; exact headers; no credentials", async () => {
  const { c, calls } = stubCustodian(); let tokens = 0;
  const s = await serve(c, () => { tokens++; return true; });
  try {
    for (const p of OWNER_READ_ROUTES) {
      const r = await req(s.url + p, "OPTIONS", { headers: preflight });
      assert.equal(r.status, 204, p);
      assert.equal(r.headers["access-control-allow-origin"], "*");
      assert.equal(r.headers["access-control-allow-methods"], "POST");
      assert.equal(r.headers["access-control-allow-headers"], "content-type");
      assert.equal(r.headers["access-control-max-age"], "600");
      assert.equal(r.headers["access-control-allow-credentials"], undefined, "never credentials");
      assert.equal(r.text, "", "a preflight carries no data");
    }
    assert.equal(tokens, 0, "no rate token spent by a preflight");
    assert.deepEqual(calls, { challenge: 0, release: 0, ownerChallenge: 0, ownerRead: 0 }, "the custodian never saw a preflight");
  } finally { s.close(); }
});

test("router: every owner-read answer carries ACAO *, refusals and router errors included; the guest routes carry none", async () => {
  const { c, calls } = stubCustodian(); let allow = true;
  const s = await serve(c, () => allow);
  try {
    let r = await req(s.url + "/v2/custody/owner-read/challenge", "POST", { body: {} });
    assert.equal(r.status, 200); assert.equal(r.headers["access-control-allow-origin"], "*"); assert.equal(JSON.parse(r.text).nonce, "33".repeat(32));
    r = await req(s.url + "/v2/custody/owner-read", "POST", { body: { v: 2 } });
    assert.equal(r.status, 200); assert.equal(r.headers["access-control-allow-origin"], "*");
    r = await req(s.url + "/v2/custody/owner-read", "POST", { body: { refuse: true } });
    assert.equal(r.status, 403); assert.equal(JSON.parse(r.text).error, "owner_sig"); assert.equal(r.headers["access-control-allow-origin"], "*", "a refusal is readable by the page");
    r = await fetch(s.url + "/v2/custody/owner-read", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{not json" });
    assert.equal(r.status, 400); assert.equal(r.headers.get("access-control-allow-origin"), "*");
    r = await fetch(s.url + "/v2/custody/owner-read", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "x".repeat(262145) });
    assert.equal(r.status, 413); assert.equal(r.headers.get("access-control-allow-origin"), "*");
    allow = false;
    r = await req(s.url + "/v2/custody/owner-read/challenge", "POST", { body: {} });
    assert.equal(r.status, 429); assert.equal(r.headers["access-control-allow-origin"], "*");
    allow = true;
    for (const [p, m] of [["/v2/custody/challenge", "POST"], ["/v2/custody/release", "POST"], ["/v2/custody/info", "GET"], ["/v2/custody/join", "POST"]]) {
      r = await req(s.url + p, m, m === "POST" ? { body: {} } : {});
      assert.equal(r.headers["access-control-allow-origin"], undefined, `${m} ${p} stays without CORS`);
    }
    for (const p of ["/v2/custody/challenge", "/v2/custody/release", "/v2/custody/info", "/v2/custody/owner-read/x"]) {
      r = await req(s.url + p, "OPTIONS", { headers: preflight });
      assert.equal(r.status, 405, `OPTIONS ${p} is refused as before`); assert.equal(r.headers["access-control-allow-origin"], undefined);
    }
    assert.equal(calls.ownerChallenge, 1); assert.equal(calls.ownerRead, 2);
  } finally { s.close(); }
});

test("router: a custodian WITHOUT owner read (an older image) answers these paths exactly as before: OPTIONS 405, POST 404, no CORS", async () => {
  const { c } = stubCustodian({ ownerRead: false });
  const s = await serve(c, () => true);
  try {
    for (const p of OWNER_READ_ROUTES) {
      let r = await req(s.url + p, "OPTIONS", { headers: preflight });
      assert.equal(r.status, 405); assert.equal(r.headers["access-control-allow-origin"], undefined);
      r = await req(s.url + p, "POST", { body: {} });
      assert.equal(r.status, 404); assert.equal(JSON.parse(r.text).error, "not_found"); assert.equal(r.headers["access-control-allow-origin"], undefined);
    }
  } finally { s.close(); }
});

test("ingress: the generated Caddy site has the preflight matcher for exactly the two owner-read paths", () => {
  const site = directCustodyIngress({ endpoint: "https://custody.example", mgmtPort: 8787 });
  assert.match(site, /@owner_read_preflight \{\n {4}method OPTIONS\n {4}path \/v2\/custody\/owner-read\/challenge \/v2\/custody\/owner-read\n {2}\}/);
  assert.match(site, /handle @owner_read_preflight \{\n {4}reverse_proxy 127\.0\.0\.1:8787\n {2}\}/);
  assert.equal((site.match(/method OPTIONS/g) || []).length, 1, "no other OPTIONS is forwarded");
});

const caddy = process.env.CADDY_BIN;
test("REAL Caddy (directCustodyIngress, TLS): the preflight and ACAO pass for the owner-read paths only; other OPTIONS stay 404; the custodian never sees a preflight's cost",
  { skip: !caddy && "set CADDY_BIN to run the real Caddy ingress", timeout: 30000 }, async () => {
  const ca = mintLocalCa(); let child, diagnostics = "";
  const { c, calls } = stubCustodian(); let tokens = 0;
  const s = await serve(c, () => { tokens++; return true; });
  const backendPort = Number(new URL(s.url).port);
  const request = (port, route, method, { body = "", headers = {} } = {}) => new Promise((resolve, reject) => {
    const r = https.request({ hostname: "127.0.0.1", servername: "localhost", port, path: route, method, ca: ca.caPem,
      headers: { host: "localhost", origin: ORIGIN, ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}), ...headers }, timeout: 3000 }, (res) => {
      const chunks = []; res.on("data", (x) => chunks.push(x)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on("error", reject); r.on("timeout", () => r.destroy(Error("timeout"))); r.end(body || undefined);
  });
  try {
    const reservation = net.createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port; await new Promise((r) => reservation.close(r));
    const site = directCustodyIngress({ endpoint: "https://localhost", mgmtPort: backendPort });
    const config = "{\n admin off\n auto_https off\n}\n" + site.replace("https://localhost {", `https://localhost:${port} {\n bind 127.0.0.1\n tls ${ca.dir}/leaf.pem ${ca.dir}/leaf.key`);
    const configPath = path.join(ca.dir, "Caddyfile"); fs.writeFileSync(configPath, config, { mode: 0o600 });
    execFileSync(caddy, ["adapt", "--config", configPath, "--adapter", "caddyfile"], { stdio: "pipe" });
    child = spawn(caddy, ["run", "--config", configPath, "--adapter", "caddyfile"], { env: { ...process.env, XDG_CONFIG_HOME: ca.dir, XDG_DATA_HOME: ca.dir }, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (x) => { diagnostics = (diagnostics + x).slice(-3000); });
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      if (child.exitCode !== null) throw Error("Caddy exited: " + diagnostics);
      try { ready = (await request(port, "/v2/custody/info", "GET")).status === 200; } catch {}
      if (!ready) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready, "Caddy is serving");
    const t0 = tokens;
    for (const p of OWNER_READ_ROUTES) {
      const r = await request(port, p, "OPTIONS", { headers: preflight });
      assert.equal(r.status, 204, `preflight through Caddy: ${p} ${diagnostics.slice(-300)}`);
      assert.equal(r.headers["access-control-allow-origin"], "*"); assert.equal(r.headers["access-control-allow-methods"], "POST");
      assert.equal(r.headers["access-control-allow-headers"], "content-type"); assert.equal(r.headers["access-control-allow-credentials"], undefined);
    }
    assert.equal(tokens, t0, "Caddy forwarded the preflights; the custodian spent nothing on them");
    let r = await request(port, "/v2/custody/owner-read/challenge", "POST", { body: "{}" });
    assert.equal(r.status, 200); assert.equal(r.headers["access-control-allow-origin"], "*");
    r = await request(port, "/v2/custody/owner-read", "POST", { body: JSON.stringify({ refuse: true }) });
    assert.equal(r.status, 403); assert.equal(r.headers["access-control-allow-origin"], "*");
    r = await request(port, "/v2/custody/release", "POST", { body: "{}" });
    assert.equal(r.headers["access-control-allow-origin"], undefined, "the guest release is unchanged through Caddy");
    for (const p of ["/v2/custody/release", "/v2/custody/challenge", "/v2/custody/info", "/v2/custody/host-binding", "/state"]) {
      r = await request(port, p, "OPTIONS", { headers: preflight });
      assert.equal(r.status, 404, `OPTIONS ${p} stays Caddy's 404`);
    }
    assert.deepEqual({ ownerChallenge: calls.ownerChallenge, ownerRead: calls.ownerRead }, { ownerChallenge: 1, ownerRead: 1 });
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 2000))]); }
    s.close(); ca.cleanup();
  }
});
