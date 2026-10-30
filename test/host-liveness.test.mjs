// Off-chain host liveness (network/host-liveness.mjs; docs/network/host-liveness.md), on the READ side:
//   - the shared rule: admission (registered, active) first; then a verified unexpired signed capacity record, a reader's
//     own observation, or the operator's own registry write within the window; nothing else;
//   - the relay's verifier (relay/registry-liveness.mjs, what api-relay.js lists by) against real signed records served
//     over real HTTPS: forged, foreign, moved-operator, inactive, expired, replayed and equivocating records refused;
//   - the decentralized reader (discoverHostCapacity --cold): a healthy host whose on-chain lastSeen is two hours old is
//     read and live on its signed record; a dead directory is reported, not fatal; a registry without agreement throws;
//   - the CLI's selection and scripts/enclave-discover.mjs use the same rule;
//   - the REAL api-relay.js in registry mode: it lists the healthy old-lastSeen host (publishing an authenticated
//     lastSeen for older clients), and drops forged, inactive and non-allowlisted hosts.
// Fixtures: the host-capacity fixture's synthetic schema-4 registry behind two local JSON-RPC servers, and HTTPS hosts on
// loopback under its test CA (names resolved to loopback by test/helpers/resolve-example-org.mjs for the relay process).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { hostLiveness, REGISTRY_UPDATE_WINDOW_SEC } from "../network/host-liveness.mjs";
import { chainFixture, hostServer, loopbackFetch, pki, gpuDoc } from "./helpers/host-capacity-fixture.mjs";
import { buildHostCapacityRecord, signHostCapacity, hostIdOf } from "../network/host-capacity.mjs";
import { createHostCapacityProducer, discoverHostCapacity, HOST_CAPACITY_PATH } from "../network/host-capacity-http.mjs";
import { createRegistryLiveness } from "../relay/registry-liveness.mjs";
import * as I from "../cli/independent.mjs";
import { bootDaemon } from "./helpers/daemon.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// the relay under test; a negative-control run points it at the patch's base copy (a file in relay/)
const RELAY_SCRIPT = path.join(REPO, "relay", process.env.HOST_LIVENESS_RELAY_SCRIPT || "api-relay.js");
const acct = (b) => privateKeyToAccount("0x" + b.repeat(32));
const opA = acct("a1"), opB = acct("b2"), opNew = acct("c3"), stranger = acct("d4"), opU = acct("e5");
const REG = "0x" + "ab".repeat(20);
const sign = (signer, endpoint, over = {}) => signHostCapacity(signer, buildHostCapacityRecord({ availability: gpuDoc(over.now ?? Date.now()), chainId: 8453, registry: REG,
  endpoint, operator: over.operator ?? signer.address, ...over }));
const forge = async (claimed, endpoint) => {           // claims `claimed`'s operator, signed by a stranger
  const real = buildHostCapacityRecord({ availability: gpuDoc(Date.now()), chainId: 8453, registry: REG, endpoint, operator: claimed.address });
  return { record: real, signature: (await signHostCapacity(stranger, { ...real, operator: stranger.address.toLowerCase() })).signature };
};
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

test("the rule: admission first, then bounded-fresh authenticated evidence, nothing else", () => {
  const now = 1_800_000_000_000, sec = now / 1000, row = { operator: opA.address, active: true, lastSeen: sec - 7200 };
  let v = hostLiveness(row, { nowMs: now });
  assert.equal(v.live, false); assert.match(v.reason, /no fresh authenticated liveness.*7200 s ago/);
  v = hostLiveness(row, { nowMs: now, signedUntilMs: now + 60_000 });
  assert.deepEqual([v.live, v.evidence, v.untilMs], [true, "signed-record", now + 60_000], "a verified record keeps a host with an old lastSeen live");
  assert.equal(hostLiveness(row, { nowMs: now, signedUntilMs: now }).live, false, "an expired record is not current evidence");
  assert.match(hostLiveness({ ...row, active: false }, { nowMs: now, signedUntilMs: now + 60_000 }).reason, /inactive/, "no evidence makes an inactive row live");
  assert.match(hostLiveness({ ...row, operator: "0x" + "00".repeat(20) }, { nowMs: now, signedUntilMs: now + 60_000 }).reason, /not registered/);
  assert.match(hostLiveness(null, { nowMs: now }).reason, /not registered/);
  v = hostLiveness({ ...row, lastSeen: sec - 600 }, { nowMs: now });
  assert.deepEqual([v.live, v.evidence], [true, "registry-update"], "the operator's own registry write within the window still counts (the transition)");
  assert.equal(hostLiveness({ ...row, lastSeen: sec - REGISTRY_UPDATE_WINDOW_SEC - 1 }, { nowMs: now }).live, false);
  assert.equal(hostLiveness({ ...row, lastSeen: sec - 600 }, { nowMs: now, registryUpdateWindowSec: 0 }).live, false, "a reader may count signed records only");
  assert.equal(hostLiveness({ ...row, lastSeen: sec + 3600 }, { nowMs: now }).live, false, "a lastSeen ahead of the clock is not evidence");
  assert.equal(hostLiveness({ ...row, lastSeen: sec - 3000 }, { nowMs: now, chainNowSec: sec - 7000 }).live, true, "a recent write counts");
  assert.equal(hostLiveness(row, { nowMs: now, chainNowSec: sec - 7000 }).live, false, "a STALE snapshot (block 7000 s old) does not make a 7200 s old write fresh");
  assert.equal(hostLiveness({ ...row, lastSeen: sec + 600 }, { nowMs: now, chainNowSec: sec + 900 }).evidence, "registry-update", "a chain ahead of the reader's clock is used (the later time)");
  assert.equal(hostLiveness(row, { nowMs: now, observedAtMs: now - 1000, observedWindowMs: 5000 }).evidence, "observed");
  assert.equal(hostLiveness(row, { nowMs: now, observedAtMs: now - 6000, observedWindowMs: 5000 }).live, false);
});

test("the shared producer serves its record to any origin, without credentials, on both host platforms", async () => {
  const p = createHostCapacityProducer({ account: opA, hostIdOf, registry: REG, endpoint: "https://host-a.example.org", availability: async () => gpuDoc(Date.now()) });
  for (const f of [await p.frame(), await createHostCapacityProducer({ account: opA, hostIdOf, identity: () => null, availability: async () => ({}) }).frame()]) {
    assert.equal(f.headers["access-control-allow-origin"], "*", "a browser on any origin may read the public signed record (and the refusal)");
    assert.ok(!Object.keys(f.headers).some((k) => /credentials/i.test(k)));
  }
});

test("the relay ships byte-identical copies of the rule and the record code, and deploys them", () => {
  for (const f of ["canonical.mjs", "host-capacity-record.mjs", "host-liveness.mjs"])
    assert.equal(fs.readFileSync(path.join(REPO, "relay", f), "utf8"), fs.readFileSync(path.join(REPO, "network", f), "utf8"), `relay/${f} drifted from network/${f}`);
  const deploy = fs.readFileSync(path.join(REPO, "relay/deploy.sh"), "utf8").split("\n").find((l) => l.startsWith("scp api-relay.js "));
  for (const f of ["registry-liveness.mjs", "host-liveness.mjs", "host-capacity-record.mjs", "canonical.mjs", "fleet-auth.js"]) assert.ok(deploy.split(/\s+/).includes(f), f);
});

test("the relay's verifier: only an unexpired record signed by the row's own operator for exactly that row counts", { timeout: 60000 }, async (t) => {
  let served = null, clock = Date.now();
  const epA = await hostServer(t, "host-a.example.org", (req, res) => (served ? json(res, 200, served) : json(res, 503, { error: "no record" })));
  const epB = await hostServer(t, "host-b.example.org", (req, res) => json(res, 503, {}));
  const fetchJson = async (u) => { const r = await loopbackFetch()(u); return r.status === 200 ? r.json : null; };
  const judge = (row) => createRegistryLiveness({ chainId: 8453, registry: REG, fetchJson, now: () => clock }).judge(row);
  const old = Math.floor(clock / 1000) - 7200, row = { endpoint: epA, operator: opA.address.toLowerCase(), active: true, lastSeen: old };
  assert.equal((await judge(row)).live, false, "no record and a two-hour-old lastSeen: not listed");
  served = await sign(opA, epA);
  let v = await judge(row);
  assert.deepEqual([v.live, v.evidence], [true, "signed-record"]);
  assert.ok(v.seenSec >= Math.floor(served.record.issuedAt / 1000) && v.seenSec > old, "the published lastSeen is the record's authenticated time");
  for (const [why, env, r] of [
    ["forged (a stranger's signature claiming the operator)", await forge(opA, epA), row],
    ["a record for another endpoint", await sign(opA, epB), row],
    ["a record for another registry", await sign(opA, epA, { registry: "0x" + "77".repeat(20) }), row],
    ["another chain", await sign(opA, epA, { chainId: 1 }), row],
    ["the row's operator moved", await sign(opA, epA), { ...row, operator: opNew.address.toLowerCase() }],
    ["an inactive row", await sign(opA, epA), { ...row, active: false }]]) {
    served = env;
    assert.equal((await judge(r)).live, false, why);
  }
  // expiry: the same valid record, read after it died
  served = await sign(opA, epA, { lifetimeMs: 60_000 });
  const L = createRegistryLiveness({ chainId: 8453, registry: REG, fetchJson, now: () => clock });
  assert.equal((await L.judge(row)).live, true);
  clock += 61_000;
  assert.equal((await L.judge(row)).live, false, "an expired record is never current evidence, cached or re-fetched");
  // replay: once a newer record was seen, an older sequence (even unexpired) is refused
  clock = Date.now();
  const newer = await sign(opA, epA, { lifetimeMs: 60_000, now: clock }), older = await sign(opA, epA, { sequence: newer.record.sequence - 1, now: clock + 30_000, lifetimeMs: 15 * 60_000 });
  const rsaid = [], R = createRegistryLiveness({ chainId: 8453, registry: REG, fetchJson, now: () => clock, log: (m) => rsaid.push(m) });
  served = newer; assert.equal((await R.judge(row)).live, true);
  clock += 61_000; served = older;
  assert.equal((await R.judge(row)).live, false, "a replayed older record does not revive the host");
  assert.match(rsaid.join("\n"), /replay/);
  // equivocation: two different records with one sequence WITHDRAW the host's signed evidence (the earlier record too)
  // until it signs a strictly newer one; its operator's own registry write is separate evidence and still counts
  clock = Date.now();
  const e1 = await sign(opA, epA, { lifetimeMs: 60_000, now: clock }), e2 = await signHostCapacity(opA, { ...e1.record, availabilityJson: JSON.stringify({ ...gpuDoc(clock), vcpusFree: 1 }) });
  const said = [], E = createRegistryLiveness({ chainId: 8453, registry: REG, fetchJson, now: () => clock, log: (m) => said.push(m) });
  served = e1; assert.equal((await E.judge(row)).live, true);
  clock += 45_000; served = e2;
  assert.equal((await E.judge(row)).live, false, "after the twin, the earlier record is no longer evidence either");
  assert.match(said.join("\n"), /equivocation/, "the twin was read and refused");
  served = e1;
  assert.equal((await E.judge(row)).live, false, "re-serving the first record does not restore it");
  const fresh = Math.floor(clock / 1000) - 120;
  assert.deepEqual([(await E.judge({ ...row, lastSeen: fresh })).evidence], ["registry-update"], "the operator's own registry write still counts, not the record");
  served = await sign(opA, epA, { sequence: e1.record.sequence + 1, now: clock, lifetimeMs: 60_000 });
  assert.equal((await E.judge(row)).evidence, "signed-record", "a strictly newer record restores signed evidence");
  // the address book repoints the registry (same endpoint, same operator): a record held for the OLD registry stops
  // counting at once, cached or not, and a re-fetched one for the old registry is refused
  let current = REG;
  clock = Date.now(); served = await sign(opA, epA, { now: clock, lifetimeMs: 15 * 60_000 });
  const B = createRegistryLiveness({ chainId: 8453, registry: () => current, fetchJson, now: () => clock });
  assert.equal((await B.judge(row)).evidence, "signed-record");
  current = "0x" + "99".repeat(20);
  assert.equal((await B.judge(row)).live, false, "the old registry's record is not evidence for the new one");
  served = await signHostCapacity(opA, buildHostCapacityRecord({ availability: gpuDoc(clock), chainId: 8453, registry: current, endpoint: epA, operator: opA.address, now: clock }));
  assert.equal((await B.judge(row)).evidence, "signed-record", "a record for the current registry counts");
  // the transition: no record, but the operator's own registry write 10 minutes ago
  served = null; clock = Date.now();
  v = await judge({ ...row, lastSeen: Math.floor(clock / 1000) - 600 });
  assert.deepEqual([v.live, v.evidence], [true, "registry-update"]);
});

async function coldWorld(t) {
  const c = await chainFixture(t), bt = Math.floor(c.blockTime / 1000), eps = {};
  const producer = (op, name) => createHostCapacityProducer({ account: op, hostIdOf, registry: c.binding.address, endpoint: () => eps[name], availability: async () => gpuDoc(Date.now()) });
  const pA = producer(opA, "a"), pC = producer(opNew, "c");
  eps.a = await hostServer(t, "host-a.example.org", (req, res) => pA.handle(req, res));
  eps.b = await hostServer(t, "host-b.example.org", (req, res) => json(res, 503, { error: "down" }));
  eps.c = await hostServer(t, "host-c.example.org", (req, res) => pC.handle(req, res));
  eps.d = await hostServer(t, "fake.example.org", (req, res) => json(res, 404, {}));
  let forged = null;
  eps.e = await hostServer(t, "host-a.example.org", (req, res) => json(res, 200, forged), "/t/forged");
  forged = await (async () => { const r = buildHostCapacityRecord({ availability: gpuDoc(Date.now()), chainId: 8453, registry: c.binding.address, endpoint: eps.e, operator: opB.address });
    return { record: r, signature: (await signHostCapacity(stranger, { ...r, operator: stranger.address.toLowerCase() })).signature }; })();
  c.state.hosts.push(
    { endpoint: eps.a, operator: opA.address, active: true, lastSeen: bt - 7200 },        // healthy, no heartbeat for two hours
    { endpoint: eps.b, operator: opB.address, active: true, lastSeen: bt - 7200 },        // dead: no record, old write
    { endpoint: eps.c, operator: opNew.address, active: false, lastSeen: bt - 60 },       // deregistered, still serving records
    { endpoint: eps.d, operator: stranger.address, active: true, lastSeen: bt - 300 },    // a pre-record host that wrote recently
    { endpoint: eps.e, operator: opB.address, active: true, lastSeen: bt - 7200 });       // forged record
  return { ...c, eps };
}

test("cold discovery reads every ACTIVE host and judges each on evidence, not on lastSeen", { timeout: 60000 }, async (t) => {
  const w = await coldWorld(t);
  const r = await discoverHostCapacity({ reader: w.reader, binding: w.binding, cold: true, directories: ["http://127.0.0.1:1"], fetchHost: loopbackFetch() });
  const by = (ep) => r.hosts.find((h) => h.endpoint === ep);
  assert.deepEqual([by(w.eps.a).capacity.status, by(w.eps.a).liveness.live, by(w.eps.a).liveness.evidence], ["verified", true, "signed-record"],
    "the healthy host with a two-hour-old lastSeen is read and live (it was never fetched before)");
  assert.equal(by(w.eps.a).registry.lastSeen, Math.floor(w.blockTime / 1000) - 7200);
  assert.deepEqual([by(w.eps.b).liveness.live, by(w.eps.b).capacity.status], [false, "unreachable"]);
  assert.equal(by(w.eps.c), undefined, "an inactive host is not admitted, whatever it serves");
  assert.deepEqual([by(w.eps.d).liveness.live, by(w.eps.d).liveness.evidence], [true, "registry-update"]);
  assert.deepEqual([by(w.eps.e).capacity.status, by(w.eps.e).liveness.live], ["refused", false], "a forged record is refused and proves nothing");
  assert.equal(r.aggregate.enclaves, 1, "capacity counts verified records only"); assert.equal(r.aggregate.unknown, 3);
  assert.ok(r.sources.some((s) => s.kind === "directory" && s.ok === false), "the dead directory is reported, and nothing depended on it");
  // registry-write evidence can be switched off: then only signed records keep a host live
  const strict = await discoverHostCapacity({ reader: w.reader, binding: w.binding, cold: true, registryUpdateWindowSec: 0, fetchHost: loopbackFetch() });
  assert.deepEqual(strict.hosts.filter((h) => h.liveness.live).map((h) => h.endpoint), [w.eps.a]);
  // an RPC peer that disagrees about the registry: nothing is verified, nothing is live (it throws, never fails open)
  w.state.lie[1] = w.state.hosts.map((h) => ({ ...h, active: true }));
  await assert.rejects(discoverHostCapacity({ reader: w.reader, binding: w.binding, cold: true, fetchHost: loopbackFetch() }));
});

test("the CLI prices only against admitted hosts that are live on evidence", () => {
  const now = Date.now(), bt = now, sec = Math.floor(now / 1000);
  const h = (id, o) => ({ id: "0x" + id.repeat(64), operator: "0x" + "aa".repeat(20), active: true, cpuPricePerSec6: 1000n, gpuPricePerSec6: 0n, lastSeen: sec - 7200, ...o });
  const hosts = [h("1", { cpuPricePerSec6: 500n }), h("2"), h("3", { active: false, cpuPricePerSec6: 100n }), h("4", { cpuPricePerSec6: 0n, lastSeen: sec }), h("5", { lastSeen: sec - 60, cpuPricePerSec6: 900n })];
  const signedUntil = new Map([[hosts[0].id, now + 60_000], [hosts[2].id, now + 60_000]]);
  assert.deepEqual(I.admittedHosts(hosts).map((x) => x.id[2]), ["1", "2", "5"]);
  const live = I.liveHosts(hosts, bt, { signedUntil, nowMs: now });
  assert.deepEqual(live.map((x) => [x.id[2], x.liveness.evidence]), [["1", "signed-record"], ["5", "registry-update"]]);
  assert.equal(I.cheapestPrices(live).cpu6, 500n, "the cheapest LIVE host, not the cheapest registered one (host 3 is inactive)");
  assert.deepEqual(I.liveHosts(hosts, bt, { nowMs: now }).map((x) => x.id[2]), ["5"], "without signed records, only a recent registry write counts");
  assert.equal(I.withLiveness(hosts, bt, { signedUntil, nowMs: now })[2].liveness.reason, "inactive in the registry");
});

test("scripts/enclave-discover.mjs keeps a host on its verified record and drops a forged one", async (t) => {
  const D = await import("../scripts/enclave-discover.mjs"), registry = "0xCB65f487eba6564D57FfB860cF9aE701584cB4a2";
  const ep = "https://host-a.example.org", row = { endpoint: ep, operator: opA.address, active: true, lastSeen: BigInt(Math.floor(Date.now() / 1000) - 7200) };
  let served = null; const real = globalThis.fetch;
  globalThis.fetch = async (u) => { assert.equal(String(u), ep + HOST_CAPACITY_PATH); return new Response(JSON.stringify(served), { status: served ? 200 : 404 }); };
  t.after(() => { globalThis.fetch = real; });
  const mk = (signer, over = {}) => signHostCapacity(signer, buildHostCapacityRecord({ availability: gpuDoc(Date.now()), chainId: 8453, registry, endpoint: ep, operator: signer.address, ...over }));
  assert.equal((await D.hostLivenessOf(row, registry)).live, false);
  served = await mk(opA);
  assert.equal((await D.hostLivenessOf(row, registry)).evidence, "signed-record");
  served = await mk(stranger); assert.equal((await D.hostLivenessOf(row, registry)).live, false, "a stranger's record");
  served = await mk(opA, { registry: REG }); assert.equal((await D.hostLivenessOf(row, registry)).live, false, "another registry's record");
  served = await mk(opA); assert.equal((await D.hostLivenessOf({ ...row, active: false }, registry)).live, false, "an inactive row");
});

test("the REAL api-relay in registry mode lists a healthy host with an old lastSeen and drops forged, inactive and unvetted ones", { timeout: 120000 }, async (t) => {
  const c = await chainFixture(t), bt = Math.floor(c.blockTime / 1000), P = pki(), served = {};
  const box = async (name, prefix = "") => {
    const s = https.createServer({ key: P.key, cert: P.cert }, (req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      if (p === prefix + "/availability") return json(res, 200, gpuDoc(Date.now()));
      if (p === prefix + HOST_CAPACITY_PATH) return served[`${name}${prefix}`] ? json(res, 200, served[`${name}${prefix}`]) : json(res, 404, {});
      res.writeHead(404); res.end();
    });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    t.after(() => { s.closeAllConnections(); return new Promise((r) => s.close(r)); });
    return `https://${name}:${s.address().port}${prefix}`;
  };
  const ep = { a: await box("host-a.example.org"), b: await box("host-b.example.org"), c: await box("host-c.example.org"), d: await box("fake.example.org"), u: await box("host-a.example.org", "/t/unvetted") };
  const rec = (signer, endpoint) => signHostCapacity(signer, buildHostCapacityRecord({ availability: gpuDoc(Date.now()), chainId: 8453, registry: c.binding.address, endpoint, operator: signer.address }));
  served["host-a.example.org"] = await rec(opA, ep.a);
  served["host-b.example.org"] = await (async () => { const r = buildHostCapacityRecord({ availability: gpuDoc(Date.now()), chainId: 8453, registry: c.binding.address, endpoint: ep.b, operator: opB.address });
    return { record: r, signature: (await signHostCapacity(stranger, { ...r, operator: stranger.address.toLowerCase() })).signature }; })();
  served["host-c.example.org"] = await rec(opNew, ep.c);
  served["host-a.example.org/t/unvetted"] = await rec(opU, ep.u);
  c.state.hosts.push(
    { endpoint: ep.a, operator: opA.address, active: true, lastSeen: bt - 7200 },
    { endpoint: ep.b, operator: opB.address, active: true, lastSeen: bt - 7200 },
    { endpoint: ep.c, operator: opNew.address, active: false, lastSeen: bt - 60 },
    { endpoint: ep.d, operator: stranger.address, active: true, lastSeen: bt - 300 },
    { endpoint: ep.u, operator: opU.address, active: true, lastSeen: bt - 60 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-liveness-relay-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const trusted = [opA, opB, opNew, stranger].map((a) => a.address.toLowerCase()).join(",");
  let out = "";
  const { child, port } = await bootDaemon({
    start: (port) => { const ch = spawn(process.execPath, ["--import", path.join(REPO, "test/helpers/resolve-example-org.mjs"), RELAY_SCRIPT], {
      env: { PATH: process.env.PATH, HOME: dir, API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1", BASE_RPC: c.rpcOrigins[0], RPC_FALLBACKS: "0",
        REGISTRY_ADDRESS: c.binding.address, ADDRESS_BOOK_ADDRESS: "", TRUSTED_OPERATORS: trusted, DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20),
        FEATURED_VIEWS_FILE: path.join(dir, "views.json"), AVAIL_POLL_SEC: "1", REGISTRY_POLL_SEC: "3", NODE_EXTRA_CA_CERTS: path.join(P.dir, "ca.pem") },
      stdio: ["ignore", "pipe", "pipe"] });
      ch.stdout.on("data", (d) => { out = (out + d).slice(-200000); }); ch.stderr.on("data", (d) => { out = (out + d).slice(-200000); }); return ch; },
    claimed: (log, port) => log.includes(`[api-relay] :${port}`),
    ready: async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).ok,
  });
  t.after(() => child.kill("SIGKILL"));
  let rows = [];
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/enclaves`).then((x) => x.json()).catch(() => null);
    rows = r?.enclaves || [];
    if (rows.some((e) => e.endpoint === ep.a) && rows.some((e) => e.endpoint === ep.d)) break;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const listed = rows.map((e) => e.endpoint).sort();
  assert.deepEqual(listed, [ep.a, ep.d].sort(), "listed: " + JSON.stringify(listed) + "\n" + out.slice(-3000));
  const a = rows.find((e) => e.endpoint === ep.a), d = rows.find((e) => e.endpoint === ep.d);
  assert.equal(a.liveness.evidence, "signed-record"); assert.equal(a.registryLastSeen, bt - 7200);
  assert.ok(Date.now() / 1000 - a.lastSeen < 120, "older clients filtering lastSeen < 1h see the authenticated time, not the two-hour-old write");
  assert.equal(d.liveness.evidence, "registry-update");
  assert.ok(!("registryRow" in a), "the internal row is not published");
  assert.match(out, /not listed: no fresh authenticated liveness/, "the forged host's refusal is logged");
});
