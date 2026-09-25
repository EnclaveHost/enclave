// Retiring the fleet HMAC for dns-01 pushes (relay/dns-relay.js RELAY_TXT_KEY + FLEET_TXT_HMAC; relay/certs.js signs with
// the relay key). The fleet HMAC is derived from the fleet SECRET every first-party box holds and names no box; the relay
// key is the relays' own, and with FLEET_TXT_HMAC=off a push is authorized only by that key or by a box's operator
// signature for what its lease or registered box name proves. Drives the REAL dns-relay against a stub Base ledger and a
// stub /enclaves. Every key here is synthetic (fixed test bytes or generated per run).
//   run: node --test test/dns-relay-txt-key.test.mjs
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


const FLEET_KEY = "22".repeat(32), RELAY_KEY = "7e".repeat(32);   // bootDns's synthetic DNS_TXT_KEY, and a separate relay key
const mac = (key, raw) => createHmac("sha256", key).update(raw).digest("hex");

async function world(t) {
  const opA = privateKeyToAccount(generatePrivateKey()), opB = privateKeyToAccount(generatePrivateKey());
  const GOOD = "0x" + "d7".repeat(32), BAD = "0x" + "b0".repeat(32), OTHER = "0x" + "a5".repeat(32);
  const box = "https://box.example", bad = "https://bad.example", now = Math.floor(Date.now() / 1000);
  const row = (id, ep, op) => ({ id, owner: "0x" + "aa".repeat(20), runner: keccak256(stringToBytes(ep)), runnerOperator: op.address, leaseUntil: now + 3600 });
  const rpc = stubRpc([row(GOOD, box, opA), row(BAD, bad, opA), row(OTHER, box, opB)]);
  rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  const feed = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ enclaves: [{ endpoint: box, id: keccak256(stringToBytes(box)), eligible: true },
                                        { endpoint: bad, id: keccak256(stringToBytes(bad)), eligible: false }] }));
  });
  feed.listen(0, "127.0.0.1"); await once(feed, "listening");
  t.after(() => { rpc.close(); feed.close(); });
  const env = { DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20), BASE_RPC: `http://127.0.0.1:${rpc.address().port}`, BOX_ZONE: "box.test",
                ELIGIBILITY_POLL_SEC: "1", ELIGIBILITY_API: `http://127.0.0.1:${feed.address().port}` };
  const boot = async (extra) => { const d = await bootDns({ ...env, ...extra }); t.after(() => d.p.kill("SIGKILL")); await delay(1500); return d; };
  let seq = 0;
  // one push: `keys` = { relay, fleet } (the key each header is signed with; absent = header absent), `op` = an operator
  // account whose EIP-191 signature rides along (the supervisor's dnsTxt sends the fleet HMAC AND this, with deploymentId)
  const push = async (d, name, { relay, fleet, op, dep, method = "POST" } = {}) => {
    const raw = JSON.stringify({ name, value: "v" + seq++, ts: Math.floor(Date.now() / 1000), ...(dep ? { deploymentId: dep } : {}) });
    const headers = { "content-type": "application/json" };
    if (relay) headers["x-relay-txt-sig"] = mac(relay, raw);
    if (fleet) headers["x-relay-sig"] = mac(fleet, raw);
    if (op) headers["x-operator-sig"] = await op.signMessage({ message: raw });
    const r = await fetch(`http://127.0.0.1:${d.apiPort}/v1/txt`, { method, headers, body: raw });
    return { status: r.status, body: await r.json() };
  };
  const healthAll = async (d) => (await fetch(`http://127.0.0.1:${d.apiPort}/health`)).json();
  const health = async (d) => (await healthAll(d)).pushAuth;
  const app = (id) => `_acme-challenge.${id.slice(2, 10)}.${APP_ZONE}`;
  return { opA, opB, GOOD, BAD, OTHER, boot, push, health, healthAll, app };
}

test("relay key: the platform certificate service's own key authorizes like the fleet HMAC, under the same U7 rules; the fleet HMAC still works while FLEET_TXT_HMAC is on", async (t) => {
  const w = await world(t);
  const d = await w.boot({ RELAY_TXT_KEY: RELAY_KEY });
  // every refusal must also have STORED nothing: the live TXT record count is unchanged across it
  const expect = async (pending, status, error, why) => {
    const before = (await w.healthAll(d)).txtRecords;
    const p = await pending();
    assert.equal(p.status, status, `${why}: ${JSON.stringify(p.body)}\n${d.log()}`); if (error) assert.equal(p.body.error, error, why);
    if (status !== 200) assert.equal((await w.healthAll(d)).txtRecords, before, `${why}: a refused push stored a record`);
  };
  await expect(() => w.push(d, w.app(w.GOOD), { relay: RELAY_KEY }), 200, null, "an eligible holder's deployment name");
  await expect(() => w.push(d, `_acme-challenge.www.${APP_ZONE}`, { relay: RELAY_KEY }), 200, null, "a non-deployment name");
  await expect(() => w.push(d, w.app(w.BAD), { relay: RELAY_KEY }), 403, "relay_auth_refused", "an INELIGIBLE holder's name (U7)");
  await expect(() => w.push(d, `_acme-challenge.${APP_ZONE}`, { relay: RELAY_KEY }), 403, "apex_refused", "the zone apex");
  await expect(() => w.push(d, w.app(w.GOOD), { relay: "3c".repeat(32) }), 401, "bad_signature", "signed with some other key");
  // the fleet HMAC, on by default: still authorizes; alone it is counted as the one credential the flip would refuse
  await expect(() => w.push(d, w.app(w.GOOD), { fleet: FLEET_KEY }), 200, null, "fleet HMAC alone (on)");
  await expect(() => w.push(d, w.app(w.GOOD), { fleet: FLEET_KEY, op: w.opA, dep: w.GOOD }), 200, null, "fleet HMAC + the holder's operator signature");
  const h = await w.health(d);
  assert.deepEqual({ relayKey: h.relayKey, fleetHmac: h.fleetHmac }, { relayKey: true, fleetHmac: "on" });
  assert.deepEqual(h.authorizedBy, { relayKey: 2, operator: 0, fleetHmac: 2, fleetHmacOnly: 1, fleetHmacIgnored: 0 },
                   "the second fleet push had an operator signature that verifies: not fleet-HMAC-only");
  assert.match(d.log(), /push auth: relay key ON; fleet HMAC ON; operator signatures ON/);
  assert.match(d.log(), /authorized by the fleet HMAC ALONE .* FLEET_TXT_HMAC=off would refuse it/);
});

test("FLEET_TXT_HMAC=off: a fleet SECRET holder authorizes NOTHING; the relay key and each box's own operator signature still do", async (t) => {
  const w = await world(t);
  const d = await w.boot({ RELAY_TXT_KEY: RELAY_KEY, FLEET_TXT_HMAC: "off" });
  // every refusal must also have STORED nothing: the live TXT record count is unchanged across it
  const expect = async (pending, status, error, why) => {
    const before = (await w.healthAll(d)).txtRecords;
    const p = await pending();
    assert.equal(p.status, status, `${why}: ${JSON.stringify(p.body)}\n${d.log()}`); if (error) assert.equal(p.body.error, error, why);
    if (status !== 200) assert.equal((await w.healthAll(d)).txtRecords, before, `${why}: a refused push stored a record`);
  };
  // the fleet HMAC alone, for every kind of name it used to reach: another tenant's, a non-deployment label, a box name
  for (const [name, why] of [[w.app(w.GOOD), "a tenant's deployment name"], [`_acme-challenge.www.${APP_ZONE}`, "a non-deployment label"],
                             ["_acme-challenge.e0123456789abcdef.box.test", "a box hostname"], [`_acme-challenge.foo.${w.GOOD.slice(2, 10)}.${APP_ZONE}`, "a deeper name"]])
    for (const method of ["POST", "DELETE"]) await expect(() => w.push(d, name, { fleet: FLEET_KEY, method }), 401, "bad_signature", `${method} ${why}`);
  // what the supervisor sends (fleet HMAC + its operator signature): authorized by the SIGNATURE, for its own lease only
  await expect(() => w.push(d, w.app(w.GOOD), { fleet: FLEET_KEY, op: w.opA, dep: w.GOOD }), 200, null, "the lease holder's operator");
  await expect(() => w.push(d, w.app(w.OTHER), { fleet: FLEET_KEY, op: w.opA, dep: w.OTHER }), 403, "operator_auth_failed", "another operator's tenant");
  await expect(() => w.push(d, w.app(w.OTHER), { op: w.opB, dep: w.OTHER }), 200, null, "that tenant's own holder");
  await expect(() => w.push(d, w.app(w.BAD), { fleet: FLEET_KEY, op: w.opA, dep: w.BAD }), 403, "operator_auth_failed", "an ineligible holder (U7)");
  // the platform certificate service's own key
  await expect(() => w.push(d, w.app(w.GOOD), { relay: RELAY_KEY }), 200, null, "relay key, deployment name");
  await expect(() => w.push(d, w.app(w.GOOD), { relay: RELAY_KEY, fleet: FLEET_KEY }), 200, null, "relay key + the transition co-signature");
  const h = await w.health(d);
  assert.equal(h.fleetHmac, "off");
  assert.deepEqual(h.authorizedBy, { relayKey: 2, operator: 2, fleetHmac: 0, fleetHmacOnly: 0, fleetHmacIgnored: 11 });
  assert.match(d.log(), /fleet HMAC OFF \(authorizes nothing\)/);
  // off, and no relay key either: a push under the fleet HMAC alone meets no accepted shared key
  const bare = await w.boot({ FLEET_TXT_HMAC: "off" });
  const r = await w.push(bare, w.app(w.GOOD), { fleet: FLEET_KEY });
  assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.error, "no_key");
  assert.equal((await w.push(bare, w.app(w.GOOD), { op: w.opA, dep: w.GOOD })).status, 200, "operator signatures need no shared key");
});

test("misconfiguration never widens anything: a relay key equal to the fleet-derived key, or malformed, is disabled; an unknown FLEET_TXT_HMAC word leaves today's behaviour", async (t) => {
  const w = await world(t);
  const same = await w.boot({ RELAY_TXT_KEY: FLEET_KEY, FLEET_TXT_HMAC: "off" });
  assert.match(same.log(), /RELAY_TXT_KEY equals DNS_TXT_KEY, the fleet-derived key: .* DISABLED/);
  assert.equal((await w.health(same)).relayKey, false);
  // a fleet-key holder cannot pass as the relay by putting its HMAC in the relay header
  let r = await w.push(same, w.app(w.GOOD), { relay: FLEET_KEY });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  const malformed = await w.boot({ RELAY_TXT_KEY: "zz" });
  assert.match(malformed.log(), /RELAY_TXT_KEY is not 64 hex characters: the relay-key path is DISABLED/);
  assert.equal((await w.health(malformed)).relayKey, false);
  const typo = await w.boot({ FLEET_TXT_HMAC: "offf" });
  assert.match(typo.log(), /FLEET_TXT_HMAC=offf is neither "on" nor "off": left ON/);
  assert.equal((await w.health(typo)).fleetHmac, "on");
  r = await w.push(typo, w.app(w.GOOD), { fleet: FLEET_KEY });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
