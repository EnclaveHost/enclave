// The ENS origins of the site (native https://enclavehost.eth, the eth.link and eth.limo gateway hosts) get an EXACT
// Access-Control-Allow-Origin from the REAL relay, and never Access-Control-Allow-Credentials; the apex keeps its
// credentialed grant; nothing else (look-alikes, http, null, other sites) gets any; no wildcard can be configured in.
// RELAY_FILE selects the relay script (the patched live file, or the unpatched live file as the negative control).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootDaemon, listenOnFreePort } from "./helpers/daemon.mjs";

const RELAY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay", process.env.RELAY_FILE || "api-relay.js");
const ENS = ["https://enclavehost.eth", "https://enclavehost.eth.link", "https://enclavehost.eth.limo"];
const NOT = ["https://evil.example", "https://enclavehost.eth.evil.example", "https://xenclavehost.eth", "http://enclavehost.eth",
             "https://enclavehost.eth.limo.evil.example", "null", "https://ENCLAVEHOST.ETH"];

async function startRelay(t, env = {}) {
  const rpc = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const q = JSON.parse(b || "{}"); const one = (m) => ({ jsonrpc: "2.0", id: m.id, result: "0x" + "0".repeat(64) });
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q))); }); });
  await listenOnFreePort(rpc);
  const { child, port } = await bootDaemon({
    start: (port) => spawn(process.execPath, [RELAY], { env: { ...process.env, ENCLAVES: "http://127.0.0.1:1", API_RELAY_PORT: String(port),
      API_RELAY_BIND: "127.0.0.1", BASE_RPC: `http://127.0.0.1:${rpc.address().port}`, RPC_FALLBACKS: "0", DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20),
      FEATURED_VIEWS_FILE: path.join(os.tmpdir(), `feat-views-cors-${port}.json`), CORS_ORIGINS: "", ...env }, stdio: ["ignore", "pipe", "pipe"] }),
    claimed: (log, port) => log.includes(`[api-relay] :${port}`),
    ready: async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).ok,
  });
  t.after(() => { child.kill("SIGKILL"); rpc.close(); });
  return `http://127.0.0.1:${port}`;
}
const ask = async (base, method, origin, extra = {}) => {
  const r = await fetch(base + "/health", { method, headers: { Accept: "application/json", ...(origin ? { Origin: origin } : {}), ...extra } });
  await r.arrayBuffer();
  return { status: r.status, acao: r.headers.get("access-control-allow-origin"), acac: r.headers.get("access-control-allow-credentials"),
           acah: r.headers.get("access-control-allow-headers"), vary: r.headers.get("vary") };
};

test("ENS origins: exact Allow-Origin, never credentials; GET and preflight", async (t) => {
  const base = await startRelay(t);
  for (const o of ENS) {
    const g = await ask(base, "GET", o);
    assert.equal(g.status, 200);
    assert.equal(g.acao, o, `GET from ${o} must be allowed exactly`);
    assert.equal(g.acac, null, `${o} must never get Allow-Credentials`);
    assert.match(g.vary || "", /Origin/);
    const p = await ask(base, "OPTIONS", o, { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,content-type" });
    assert.equal(p.status, 204);
    assert.equal(p.acao, o);
    assert.equal(p.acac, null);
    assert.match(p.acah || "", /authorization/i, "a signed-in page's Authorization header is allowed in the preflight");
  }
});

test("the apex keeps its credentialed grant; nothing else is allowed", async (t) => {
  const base = await startRelay(t);
  for (const o of ["https://enclave.host", "https://www.enclave.host"]) {
    const g = await ask(base, "GET", o);
    assert.deepEqual([g.acao, g.acac], [o, "true"]);
  }
  for (const o of NOT) {
    const g = await ask(base, "GET", o);
    assert.equal(g.acao, null, `${o} must get no Allow-Origin`);
    assert.equal(g.acac, null);
  }
  assert.equal((await ask(base, "GET", null)).acao, null, "no Origin, no CORS grant");
});

test("CORS_PUBLIC_ORIGINS cannot configure a wildcard or a non-https origin", async (t) => {
  const base = await startRelay(t, { CORS_PUBLIC_ORIGINS: "*,http://enclavehost.eth,https://*.eth.limo,https://enclavehost.eth.limo" });
  for (const o of ["https://evil.example", "http://enclavehost.eth", "https://x.eth.limo"]) assert.equal((await ask(base, "GET", o)).acao, null, o);
  assert.equal((await ask(base, "GET", "https://enclavehost.eth.limo")).acao, "https://enclavehost.eth.limo");
  assert.equal((await ask(base, "GET", "https://enclavehost.eth")).acao, null, "an explicit list replaces the default");
});
