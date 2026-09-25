// U7 on the DNS relay: an operator-signed dns-01 TXT push is authorized by the on-chain lease for THIS deployment's
// subdomain, and (U7) only while the api-relay holds that lease holder ELIGIBLE. A dns-01 answer is a certificate for the
// tenant's name, so an ineligible holder, or a relay with no eligibility source, gets none. Drives the REAL dns-relay
// against a stub Base ledger and a stub /enclaves; the operator key is generated per run.
//   run: node --test test/dns-relay-u7.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_ZONE = "app.test", IP_ZONE = "ip.test";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

// the ledger: EnclaveDeployments schema rev 2 (the 17-field row test/api-relay.test.mjs encodes)
const W = (v) => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase() : BigInt(v).toString(16)).padStart(64, "0");
function encPage(rows) {
  const tuples = rows.map((d) => {
    const strs = ["ipfs://x", "", ""].map((s) => { const hex = Buffer.from(s, "utf8").toString("hex");
      return { body: W(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0"), words: 1 + Math.ceil(hex.length / 64) }; });
    let off = 17 * 32;
    const heads = strs.map((s) => { const h = W(off); off += s.words * 32; return h; });
    return [W(d.id), W(d.owner), heads[0], heads[1], heads[2], W(0), W(10), W(8080), W(1), W(1), W(1700000000), W(3), W(5_000_000), W(0),
            W(d.runner), W(d.runnerOperator), W(d.leaseUntil)].join("") + strs.map((s) => s.body).join("");
  });
  let off = rows.length * 32;
  const heads = tuples.map((t) => { const h = W(off); off += t.length / 2; return h; });
  return "0x" + W(32) + W(rows.length) + heads.join("") + tuples.join("");
}
function stubRpc(ledger) {
  return http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      const one = (m) => {
        if (m.method !== "eth_call") return "0x";
        const data = m.params[0].data;
        if (data.startsWith("0x5d1b72b6")) return "0x" + W(2);
        if (data.startsWith("0x06661abd")) return "0x" + W(ledger.length);
        const start = Number(BigInt("0x" + data.slice(10, 74))), n = Number(BigInt("0x" + data.slice(74, 138)));
        return encPage(ledger.slice(start, start + n));
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(q) ? q.map((m) => ({ jsonrpc: "2.0", id: m.id, result: one(m) })) : { jsonrpc: "2.0", id: q.id, result: one(q) }));
    });
  });
}

async function bootDns(env) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const dnsPort = await freePort(), apiPort = await freePort();
    const e = { ...process.env, IP_ZONE, APP_ZONE, NS_NAME: "ns1.test", ENCLAVES: "https://example.invalid",
                DNS_PORT: String(dnsPort), DNS_API_PORT: String(apiPort), DNS_API_BIND: "127.0.0.1",
                DNS_TXT_KEY: "22".repeat(32), APP_A: "203.0.113.7", ...env };
    delete e.REGISTRY_ADDRESS; delete e.ADDRESS_BOOK_ADDRESS;
    const p = spawn(process.execPath, [path.join(ROOT, "relay", "dns-relay.js")], { env: e, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
    for (let i = 0; i < 100; i++) {
      if (p.exitCode != null) break;
      try { if ((await fetch(`http://127.0.0.1:${apiPort}/health`)).ok) return { p, apiPort, log: () => log }; } catch {}
      await delay(100);
    }
    try { p.kill("SIGKILL"); } catch {}
  }
  throw new Error("dns-relay did not come up");
}

test("U7 dns-relay: a lease-authorized dns-01 push needs an ELIGIBLE holder; ineligible or unconfigured = refused", async (t) => {
  const op = privateKeyToAccount(generatePrivateKey());
  const DEP = "0x" + "d7".repeat(32), RUNNER = keccak256(stringToBytes("https://box.example"));
  const ledger = [{ id: DEP, owner: "0x" + "aa".repeat(20), runner: RUNNER, runnerOperator: op.address,
                    leaseUntil: Math.floor(Date.now() / 1000) + 3600 }];
  const rpc = stubRpc(ledger); rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  let eligible = true;
  const feed = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ enclaves: [{ endpoint: "https://box.example", id: RUNNER, eligible }] }));
  });
  feed.listen(0, "127.0.0.1"); await once(feed, "listening");
  t.after(() => { rpc.close(); feed.close(); });
  const env = { DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20), BASE_RPC: `http://127.0.0.1:${rpc.address().port}`,
                ELIGIBILITY_POLL_SEC: "1" };
  const dns = await bootDns({ ...env, ELIGIBILITY_API: `http://127.0.0.1:${feed.address().port}` });
  t.after(() => dns.p.kill("SIGKILL"));
  let seq = 0;
  const push = async (apiPort) => {
    const body = { name: `_acme-challenge.${DEP.slice(2, 10)}.${APP_ZONE}`, value: "v" + seq, deploymentId: DEP, ts: Math.floor(Date.now() / 1000) + (seq++ % 100) };
    const raw = JSON.stringify(body);
    const r = await fetch(`http://127.0.0.1:${apiPort}/v1/txt`, { method: "POST",
      headers: { "content-type": "application/json", "x-operator-sig": await op.signMessage({ message: raw }) }, body: raw });
    return { status: r.status, body: await r.json() };
  };
  await delay(1500);                                         // the first eligibility poll
  let r = await push(dns.apiPort);
  assert.equal(r.status, 200, `${JSON.stringify(r.body)}\n${dns.log()}`);
  eligible = false;                                           // the api-relay no longer holds the lease holder eligible
  await delay(1600);
  r = await push(dns.apiPort);
  assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.error, "operator_auth_failed");
  assert.match(r.body.message, /not an eligible host \(U7\)/);
  eligible = true; await delay(1600);
  assert.equal((await push(dns.apiPort)).status, 200, "eligible again: authorized");

  // a relay with no eligibility source authorizes no lease-based push at all
  const none = await bootDns({ ...env, ELIGIBILITY_API: "", DOMAINS_API: "" });
  t.after(() => none.p.kill("SIGKILL"));
  r = await push(none.apiPort);
  assert.equal(r.status, 403, JSON.stringify(r.body)); assert.match(r.body.message, /not an eligible host \(U7\)/);
  assert.match(none.log(), /ELIGIBILITY_API \(or DOMAINS_API\) unset: NO host is eligible/);
});
