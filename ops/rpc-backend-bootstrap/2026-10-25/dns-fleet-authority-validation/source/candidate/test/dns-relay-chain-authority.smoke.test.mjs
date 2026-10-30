// Startup smoke of the REAL relay/dns-relay.js against the REAL generated relay/network-runtime.bundle.mjs (built in this
// private tree by the launcher; the test refuses to run without it). Loopback only: every chain server is a local fake on
// 127.0.0.1, DNS/API listeners bind 127.0.0.1 on free ports, the platform host policy is off. Run under `unshare -rn`
// with lo up (the launcher), so no external network exists at all. Asserts:
//   mixed selection (verifier + BASE_RPC): exit 1 at startup, "fatal: chain authority", no listener, no chain request;
//   clean verifier: the fleet's registry read arrives at the fake LOCAL VERIFIER (eth_call to REGISTRY_ADDRESS) and the
//     fake legacy BASE_RPC server is never contacted;
//   legacy (no verifier env): the same read arrives at the BASE_RPC server (default path unchanged).
// Endpoint selection only: the fake verifier proves nothing; proof/finality are the verifier's own (other suites).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELAY = path.join(path.dirname(fileURLToPath(import.meta.url)), "../relay");
const REG = "0x" + "12".repeat(20);
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
function fakeRpc() {             // minimal JSON-RPC: count() -> 0 (empty registry), anything else -> error; records requests
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 1 << 20) req.destroy(); });
    req.on("end", () => {
      let j; try { j = JSON.parse(b); } catch { res.writeHead(400).end(); return; }
      const one = (q) => { seen.push({ method: q.method, to: q.params?.[0]?.to?.toLowerCase?.() ?? null, data: q.params?.[0]?.data ?? null });
        if (q.method === "eth_call" && String(q.params?.[0]?.data || "").startsWith("0x06661abd")) return { jsonrpc: "2.0", id: q.id, result: "0x" + "00".repeat(32) };   // count()
        if (q.method === "eth_chainId") return { jsonrpc: "2.0", id: q.id, result: "0x2105" };
        return { jsonrpc: "2.0", id: q.id, error: { code: -32000, message: "fake: not served" } }; };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((c) => srv.close(c)) })));
}
async function startRelay(extra, { until = null, timeoutMs = 20_000 } = {}) {
  const [dns, api] = [await freePort(), await freePort()];
  const env = { PATH: process.env.PATH, HOME: process.env.HOME || "/tmp", REGISTRY_ADDRESS: REG, TRUSTED_OPERATORS: "0x" + "34".repeat(20),
    IP_ZONE: "ip.test.invalid", APP_ZONE: "app.test.invalid", NS_NAME: "ns1.test.invalid", DNS_PORT: String(dns), DNS_BIND: "127.0.0.1",
    DNS_API_PORT: String(api), DNS_API_BIND: "127.0.0.1", DNS_TXT_KEY: "smoke-test-key-0123456789abcdef", ENCLAVE_PLATFORM_HOST_POLICY: "off", ...extra }; // gitleaks:allow -- fixed synthetic smoke-test value; never a deployed credential
  const child = spawn(process.execPath, [path.join(RELAY, "dns-relay.js")], { cwd: RELAY, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 100))]);
    if (code !== undefined) return { code, out, err };
    if (until && until()) break;
  }
  child.kill("SIGKILL"); await exited;
  return { code: null, out, err, timedOut: !(until && until()) };
}

test("the generated network-runtime bundle is present and exports relayChainAuthority", async () => {
  const b = path.join(RELAY, "network-runtime.bundle.mjs");
  assert.ok(fs.existsSync(b), "build it first: (cd relay && node build-network.mjs)");
  assert.equal(typeof (await import(b)).relayChainAuthority, "function");
});

test("mixed selection (verifier + BASE_RPC) stops dns-relay at startup before any listener or chain request", async () => {
  const v = await fakeRpc(), legacy = await fakeRpc();
  try {
    const r = await startRelay({ ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: v.url, BASE_RPC: legacy.url });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.err, /fatal: chain authority: .*BASE_RPC/, r.err);
    assert.doesNotMatch(r.out, /\[dns-relay\] (udp|tcp) |challenge-push api/, "no listener was opened");
    assert.deepEqual([v.seen.length, legacy.seen.length], [0, 0], "no chain server was contacted");
  } finally { await v.close(); await legacy.close(); }
});

test("clean verifier selection: the fleet's registry read goes to the local verifier, never to BASE_RPC", async () => {
  const v = await fakeRpc();
  try {
    const r = await startRelay({ ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: v.url },
      { until: () => v.seen.some((q) => q.method === "eth_call" && q.to === REG && String(q.data).startsWith("0x06661abd")) });
    assert.notEqual(r.timedOut, true, `no registry read reached the verifier: ${r.out}${r.err}`);
    assert.equal(r.code, null, `dns-relay exited: ${r.out}${r.err}`);
    assert.match(r.out, /on-chain fleet: EnclaveRegistry/);
    assert.ok(v.seen.every((q) => q.method !== "eth_sendRawTransaction"));
  } finally { await v.close(); }
});

test("legacy (no verifier env): the same read goes to BASE_RPC - default path unchanged", async () => {
  const legacy = await fakeRpc();
  try {
    const r = await startRelay({ BASE_RPC: legacy.url }, { until: () => legacy.seen.some((q) => q.method === "eth_call" && q.to === REG) });
    assert.notEqual(r.timedOut, true, `no registry read reached BASE_RPC: ${r.out}${r.err}`);
    assert.equal(r.code, null, `dns-relay exited: ${r.out}${r.err}`);
  } finally { await legacy.close(); }
});
