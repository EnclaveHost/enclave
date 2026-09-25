// U7 on the DNS relay: an operator-signed dns-01 TXT push is authorized by the on-chain lease for THIS deployment's
// subdomain, and (U7) only while the api-relay holds that lease holder ELIGIBLE. The fleet-HMAC push, which names no
// box, is held to the same lease and eligibility for a deployment's name (round 5). A dns-01 answer is a certificate for the
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
import { createHmac } from "node:crypto";
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

test("U7 dns-relay: the fleet HMAC alone gets a dns-01 answer for a deployment's name only while it has a live, ELIGIBLE lease holder", async (t) => {
  const GOOD = "0x" + "d7".repeat(32), BAD = "0x" + "b0".repeat(32), GONE = "0x" + "e1".repeat(32);
  const TWIN1 = "0x" + "c3c3c3c3" + "01".repeat(28), TWIN2 = "0x" + "c3c3c3c3" + "02".repeat(28);   // one 8-hex label, two rows
  const box = "https://box.example", bad = "https://bad.example";
  const now = Math.floor(Date.now() / 1000), op = "0x" + "0f".repeat(20);
  const row = (id, ep, leaseUntil) => ({ id, owner: "0x" + "aa".repeat(20), runner: keccak256(stringToBytes(ep)), runnerOperator: op, leaseUntil });
  const ledger = [row(GOOD, box, now + 3600), row(BAD, bad, now + 3600), row(GONE, box, now - 60), row(TWIN1, box, now + 3600), row(TWIN2, box, now + 3600)];
  const rpc = stubRpc(ledger); rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  let boxEligible = true;
  const feed = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ enclaves: [{ endpoint: box, id: keccak256(stringToBytes(box)), eligible: boxEligible },
                                        { endpoint: bad, id: keccak256(stringToBytes(bad)), eligible: false }] }));
  });
  feed.listen(0, "127.0.0.1"); await once(feed, "listening");
  t.after(() => { rpc.close(); feed.close(); });
  const KEY = "22".repeat(32);   // the synthetic derived key bootDns configures
  const env = { DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20), BASE_RPC: `http://127.0.0.1:${rpc.address().port}`, TCP_ZONE: "tcp.test", BOX_ZONE: "box.test",
                ELIGIBILITY_POLL_SEC: "1", ELIGIBILITY_API: `http://127.0.0.1:${feed.address().port}` };
  const dns = await bootDns(env);
  t.after(() => dns.p.kill("SIGKILL"));
  let seq = 0;
  const push = async (apiPort, label, { zone = APP_ZONE, method = "POST", sig, name } = {}) => {
    const raw = JSON.stringify({ name: name ?? `_acme-challenge.${label}.${zone}`, value: "h" + seq++, ts: Math.floor(Date.now() / 1000) });
    const r = await fetch(`http://127.0.0.1:${apiPort}/v1/txt`, { method,
      headers: { "content-type": "application/json", "x-relay-sig": sig ?? createHmac("sha256", KEY).update(raw).digest("hex") }, body: raw });
    return { status: r.status, body: await r.json() };
  };
  await delay(1500);                                          // the first eligibility poll
  const ok = async (label, opts, why) => { const r = await push(dns.apiPort, label, opts); assert.equal(r.status, 200, `${label}: ${why}: ${JSON.stringify(r.body)}\n${dns.log()}`); };
  const refused = async (label, re, opts) => {
    const r = await push(dns.apiPort, label, opts);
    assert.equal(r.status, 403, `${label}: ${JSON.stringify(r.body)}`); assert.equal(r.body.error, "hmac_auth_refused"); assert.match(r.body.message, re, label);
  };
  const h8 = (id) => id.slice(2, 10);
  await ok(h8(GOOD), {}, "the eligible holder's deployment");
  await ok(GOOD.slice(2), {}, "its full id as the label");
  await ok("www", {}, "a name that is no deployment's keeps the HMAC's authority");
  for (const label of [h8(BAD), "dep-" + h8(BAD), "dep_" + h8(BAD), "0x" + h8(BAD), "dep-0x" + h8(BAD), BAD.slice(2)])
    await refused(label, /not an eligible host \(U7\)/);                  // every form the api-relay routes to that deployment
  await refused(h8(BAD), /not an eligible host \(U7\)/, { zone: "tcp.test" });
  await refused(h8(GONE), /no live lease/);
  await refused("99999999", /no single on-ledger deployment/);
  await refused("c3c3c3c3", /no single on-ledger deployment/, {});       // ambiguous: names two rows
  // never at a zone APEX, the challenge name of a WILDCARD over every deployment (enclave-5d, round 6): any case, a trailing
  // dot, POST or DELETE, whatever the signature
  for (const name of ["_acme-challenge.app.test", "_acme-challenge.tcp.test", "_acme-challenge.box.test", "_acme-challenge.APP.TEST.", "_ACME-CHALLENGE.tcp.test"])
    for (const method of ["POST", "DELETE"]) {
      const r = await push(dns.apiPort, "", { name, method });
      assert.equal(r.status, 403, `${method} ${name}: ${JSON.stringify(r.body)}`); assert.equal(r.body.error, "apex_refused");
    }
  // removing a value is not issuance: the HMAC keeps that authority
  assert.equal((await push(dns.apiPort, h8(BAD), { method: "DELETE" })).status, 200);
  // a wrong HMAC is still just wrong
  assert.equal((await push(dns.apiPort, h8(GOOD), { sig: "00".repeat(32) })).status, 401);
  // eligibility lost: the same push is refused; regained: answered again
  boxEligible = false; await delay(1600);
  await refused(h8(GOOD), /not an eligible host \(U7\)/);
  boxEligible = true; await delay(1600);
  await ok(h8(GOOD), {}, "eligible again");
  // a relay with no readable ledger cannot tie a deployment name to a lease holder: refused, not waved through
  const noLedger = await bootDns({ ...env, DEPLOYMENTS_ADDRESS: "" });
  t.after(() => noLedger.p.kill("SIGKILL"));
  await delay(1500);
  const r = await push(noLedger.apiPort, h8(GOOD));
  assert.equal(r.status, 403, JSON.stringify(r.body)); assert.match(r.body.message, /no single on-ledger deployment \(or no readable ledger\)/);
  assert.equal((await push(noLedger.apiPort, "www")).status, 200);
});
