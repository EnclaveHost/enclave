// Host capacity records (network/host-capacity*.mjs, cli/independent-capacity.mjs) over actual HTTP:
//   - hosts serve their own signed /availability at /v1/host/capacity (the producer), over real HTTPS;
//   - independent directories store them (the standalone directory handler, real HTTP);
//   - a reader verifies every record against ONE agreed block of an explicitly pinned, reviewed schema-4 registry, read
//     by the committed quorum reader from two real local JSON-RPC servers (the chain fixture);
//   - refusals: changed operator, stale, expired, replayed, equivocating, fake or inactive hosts, wrong chain/registry;
//   - outages stay visible; each host counts once however many sources carried its record.
// Fixtures, clearly: the registry contract, chain, TLS CA and hosts are synthetic, on loopback. The profile is the
// reviewed live Base profile with ONLY the registry code hash replaced by the fixture's, pinned by its own digest.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { parseProfile } from "../network/authority-profile.mjs";
import { gpuDoc, shieldDoc, chainFixture, hostServer, loopbackFetch, PROFILE_FILE } from "./helpers/host-capacity-fixture.mjs";
import { buildHostCapacityRecord, signHostCapacity, verifyHostCapacity, parseAvailability, CapacityFloors, aggregateCapacity, hostIdOf,
         HOST_CAPACITY_MAX_MS } from "../network/host-capacity.mjs";
import { capacityRegistryBinding, registrySnapshot, publicJsonFetch, directoryJsonFetch, createHostCapacityProducer, createHostCapacityDirectory,
         discoverHostCapacity, HOST_CAPACITY_PATH, DIRECTORY_CAPACITY_PATH } from "../network/host-capacity-http.mjs";
import { main as cli } from "../cli/independent-capacity.mjs";

const PROFILE_DIGEST = "sha256:ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8";
const acct = (b) => privateKeyToAccount("0x" + b.repeat(32));
const opA = acct("a1"), opB = acct("b2"), opNew = acct("c3"), stranger = acct("d4");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "host-capacity-"));

async function directoryServer(t, d) {
  const server = http.createServer(async (req, res) => { if (!(await d.handle(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function world(t) {
  const c = await chainFixture(t);
  const now = Date.now();
  const producers = {};
  const eps = {};
  // host B is registered the way a Windows node is, at a path under its origin (https://<host>/t/<name>)
  for (const [name, op, doc, prefix] of [["host-a.example.org", opA, gpuDoc, ""], ["host-b.example.org", opB, shieldDoc, "/t/box-b"]]) {
    let producer;
    eps[name] = await hostServer(t, name, (req, res) => producer.handle(req, res), prefix);
    producer = producers[name] = createHostCapacityProducer({ account: op, hostIdOf, registry: c.binding.address, endpoint: eps[name], availability: async () => doc(Date.now()) });
  }
  c.state.hosts.push({ endpoint: eps["host-a.example.org"], operator: opA.address, active: true, lastSeen: Math.floor(c.blockTime / 1000) - 60, cpu: 200, gpu: 1500 },
                     { endpoint: eps["host-b.example.org"], operator: opB.address, active: true, lastSeen: Math.floor(c.blockTime / 1000) - 60, cpu: 120, gpu: 0 });
  return { ...c, producers, eps, now };
}

test("signed records travel over real HTTPS and HTTP; each host counts once across host, directory and cold sources", { timeout: 60000 }, async (t) => {
  const w = await world(t);
  const D = [], dirs = [];
  for (let i = 0; i < 2; i++) { const d = createHostCapacityDirectory({ reader: w.reader, binding: w.binding }); D.push(d); dirs.push(await directoryServer(t, d)); }
  // host A publishes to both directories (the producer's publish), host B to none
  const pub = await w.producers["host-a.example.org"].publish(dirs);
  assert.deepEqual(pub.map((p) => p.ok), [true, true], JSON.stringify(pub));
  const r = await discoverHostCapacity({ reader: w.reader, binding: w.binding, directories: dirs, hosts: [w.eps["host-a.example.org"]], cold: true, fetchHost: loopbackFetch() });
  assert.equal(r.hosts.length, 2);
  const a = r.hosts.find((h) => h.endpoint === w.eps["host-a.example.org"]), b = r.hosts.find((h) => h.endpoint === w.eps["host-b.example.org"]);
  assert.equal(a.capacity.status, "verified"); assert.equal(b.capacity.status, "verified");
  assert.equal(a.capacity.sources.length, 3, "A's one record came from its endpoint and two directories");
  // full document semantics preserved byte for byte (CPU, GPU, flags, ledger passthroughs, claim state, timestamps)
  for (const k of ["gpuShareFree", "vramFreeGb", "smFree", "claimEnabled", "askGpuPricePerSec6", "instanceSweep", "ramFreeMb", "teeCpu", "updatedAt"]) assert.ok(k in a.capacity.availability, k);
  assert.equal(b.capacity.availability.tier, "hv-node"); assert.equal(b.capacity.availability.shielded.vramGb, 24);
  // registry facts are beside, not inside: posted prices are not capacity
  assert.deepEqual({ cpu: a.registry.cpuPricePerSec6, gpu: a.registry.gpuPricePerSec6, note: a.registry.postedPricesAreNotCapacity }, { cpu: "200", gpu: "1500", note: true });
  // the aggregate: the relay's rules, each host once (A's three copies did not triple its free vCPUs)
  const g = r.aggregate;
  assert.equal(g.enclaves, 2); assert.equal(g.claiming, 2); assert.equal(g.unknown, 0); assert.equal(g.selfReported, true);
  assert.equal(g.gpu, true); assert.equal(g.gpuShareFree, 0.625); assert.equal(g.gpuEnclaveCpuShareFree, 0.4); assert.equal(g.vramFreeGb, 50);
  assert.equal(g.cpuShareFree, 0.5, "best node pool is B's, a different box (the two-pool model)");
  assert.deepEqual(g.totals, { vcpusFree: 20.8, ramGbFree: 63.2, vramFreeGb: 50 });
  assert.equal(g.shielded.gpuShareFree, 0.3); assert.equal(g.shielded.hostExcluded, false);
  assert.equal(r.quorum.registry, w.binding.address);
  assert.equal(D[0].records().length, 1);
});

test("changed operator, fake, inactive and foreign records are refused by readers and directories alike", { timeout: 60000 }, async (t) => {
  const w = await world(t);
  const d = createHostCapacityDirectory({ reader: w.reader, binding: w.binding }), dir = await directoryServer(t, d);
  const post = (env) => directoryJsonFetch()(dir + DIRECTORY_CAPACITY_PATH, { method: "POST", body: JSON.stringify(env) });
  const A = w.eps["host-a.example.org"];
  const mk = (over = {}, signer = opA) => signHostCapacity(signer, buildHostCapacityRecord({ availability: gpuDoc(Date.now()), chainId: 8453, registry: w.binding.address,
    endpoint: A, operator: signer.address, ...over }));
  const old = await mk();
  assert.equal((await post(old)).status, 200);
  // the registry moves host A to a new operator: the former operator's record is refused everywhere
  w.state.hosts[0].operator = opNew.address;
  const refusedRead = await discoverHostCapacity({ reader: w.reader, binding: w.binding, directories: [dir], fetchHost: loopbackFetch() });
  const a = refusedRead.hosts.find((h) => h.hostId === hostIdOf(A));
  assert.equal(a.capacity.status, "refused"); assert.match(a.capacity.reasons.join(" "), /not the host's current registry operator/);
  assert.equal(refusedRead.aggregate.enclaves, 0, "nothing verified is nothing counted");
  assert.equal((await post(await mk({ sequence: old.record.sequence + 1 }))).status, 400);
  // the NEW operator's record is accepted even with a LOWER sequence: a former operator's floor never vetoes the current one
  const fresh = await signHostCapacity(opNew, buildHostCapacityRecord({ availability: gpuDoc(Date.now()), chainId: 8453, registry: w.binding.address, endpoint: A,
    operator: opNew.address, sequence: old.record.sequence - 1000, now: Date.now() }));
  assert.equal((await post(fresh)).status, 200);
  // fake host: a record for an endpoint the registry does not list; a stranger's signature; an inactive host; another registry / chain
  const fake = await signHostCapacity(stranger, buildHostCapacityRecord({ availability: gpuDoc(Date.now()), chainId: 8453, registry: w.binding.address,
    endpoint: "https://fake.example.org", operator: stranger.address }));
  assert.match((await post(fake)).json.error, /not in the pinned registry/);
  const forged = { record: (await mk()).record, signature: (await stranger.signMessage({ message: "x" })) };
  assert.match((await post(forged)).json.error, /not signed by its operator|signature/);
  w.state.hosts[1].active = false;
  const b = await w.producers["host-b.example.org"].current();
  assert.match((await post(b)).json.error, /not active/);
  const other = await signHostCapacity(opNew, buildHostCapacityRecord({ availability: gpuDoc(Date.now()), chainId: 8453, registry: "0x" + "77".repeat(20), endpoint: A, operator: opNew.address }));
  assert.match((await post(other)).json.error, /another chain or registry/);
  const otherChain = await signHostCapacity(opNew, buildHostCapacityRecord({ availability: gpuDoc(Date.now()), chainId: 1, registry: w.binding.address, endpoint: A, operator: opNew.address }));
  assert.match((await post(otherChain)).json.error, /another chain or registry/);
  // a record whose hostId is not keccak(endpoint) is malformed before any signature
  await assert.rejects(verifyHostCapacity({ record: { ...fresh.record, hostId: "0x" + "11".repeat(32) }, signature: fresh.signature },
    { pins: { chainId: 8453, registry: w.binding.address }, entry: null }), /hostId/);
});

test("stale, expired, replayed and equivocating records never count; floors survive a restart", { timeout: 60000 }, async (t) => {
  const w = await world(t);
  const A = w.eps["host-a.example.org"], t0 = Date.now();
  const at = (now, sequence, doc = gpuDoc(now)) => signHostCapacity(opA, buildHostCapacityRecord({ availability: doc, chainId: 8453, registry: w.binding.address, endpoint: A, operator: opA.address, sequence, now, lifetimeMs: 120_000 }));
  // a document whose own updatedAt is older than a record's lifetime cannot be re-signed as fresh
  assert.throws(() => buildHostCapacityRecord({ availability: gpuDoc(t0 - HOST_CAPACITY_MAX_MS - 120_000), chainId: 8453, registry: w.binding.address, endpoint: A, operator: opA.address }), /outside the record's lifetime/);
  // expired
  const expired = await at(t0 - 200_000, t0 - 200_000);
  const serve = (envs) => { const s = http.createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ records: envs })); }); return new Promise((ok) => s.listen(0, "127.0.0.1", () => { t.after(() => new Promise((c) => s.close(c))); ok(`http://127.0.0.1:${s.address().port}`); })); };
  let r = await discoverHostCapacity({ reader: w.reader, binding: w.binding, directories: [await serve([expired])] });
  assert.equal(r.hosts[0].capacity.status, "expired");
  // replay: a reader that has seen sequence N refuses an older (still unexpired) record, across a restart via its state file
  const older = await at(t0 - 10_000, t0 - 10_000), newer = await at(t0, t0);
  const state = path.join(w.dir, "floors.json");
  const run = (dirOrigin) => cli(["availability", "--profile", w.profileFile, "--profile-digest", w.digest, "--directory", dirOrigin, "--state", state, "--json"],
    { reader: w.reader, stdout: () => {} });
  r = await run(await serve([newer]));
  assert.equal(r.hosts[0].capacity.status, "verified");
  r = await run(await serve([older]));
  assert.equal(r.hosts[0].capacity.status, "stale"); assert.match(r.hosts[0].capacity.reasons[0], /replay/);
  // equivocation: one sequence, two different documents -> the host is excluded, not averaged
  const x = await at(t0 + 1, t0 + 1, { ...gpuDoc(t0), gpuShareFree: 0.1 }), y = await at(t0 + 1, t0 + 1, { ...gpuDoc(t0), gpuShareFree: 0.9 });
  r = await discoverHostCapacity({ reader: w.reader, binding: w.binding, directories: [await serve([x]), await serve([y])] });
  assert.equal(r.hosts[0].capacity.status, "equivocation"); assert.equal(r.aggregate.enclaves, 0);
  // the directory refuses an older record than it holds, and the same bytes twice are no change
  const d = createHostCapacityDirectory({ reader: w.reader, binding: w.binding }), dir = await directoryServer(t, d);
  const post = (env) => directoryJsonFetch()(dir + DIRECTORY_CAPACITY_PATH, { method: "POST", body: JSON.stringify(env) });
  assert.deepEqual((await post(newer)).json, { ok: true, changed: true });
  assert.deepEqual((await post(newer)).json, { ok: true, changed: false });
  assert.equal((await post(older)).status, 409);
});

test("outages are reported, not turned into zero capacity; a registry without a quorum or with other code verifies nothing", { timeout: 60000 }, async (t) => {
  const w = await world(t);
  // host B is down; the cold read still verifies A and names B unknown
  w.state.hosts[1].endpoint = "https://host-c.example.org:1";
  let r = await discoverHostCapacity({ reader: w.reader, binding: w.binding, cold: true, fetchHost: loopbackFetch() });
  const c = r.hosts.find((h) => h.endpoint === "https://host-c.example.org:1");
  assert.equal(c.capacity.status, "unreachable"); assert.equal(r.aggregate.unknown, 1); assert.equal(r.aggregate.enclaves, 1);
  assert.ok(r.sources.some((s) => s.kind === "host" && !s.ok));
  // a dead directory is a source error, not a failure of the read
  r = await discoverHostCapacity({ reader: w.reader, binding: w.binding, directories: ["http://127.0.0.1:9"], hosts: [w.eps["host-a.example.org"]], fetchHost: loopbackFetch() });
  assert.equal(r.aggregate.enclaves, 1); assert.equal(r.sources.find((s) => s.kind === "directory").ok, false);
  // one RPC down and the other lying: no quorum -> nothing can be verified, and the reader says so
  w.state.down[0] = true;
  await assert.rejects(discoverHostCapacity({ reader: w.reader, binding: w.binding, cold: true, fetchHost: loopbackFetch() }), /quorum|agree/);
  w.state.down[0] = false;
  w.state.lie[1] = w.state.hosts.map((h) => ({ ...h, operator: stranger.address }));
  await assert.rejects(discoverHostCapacity({ reader: w.reader, binding: w.binding, cold: true, fetchHost: loopbackFetch() }), /quorum|agree/);
  w.state.lie[1] = null;
  // both RPCs agree the registry carries other code, or another schema: refused, not decoded
  const code = w.state.code;
  w.state.code = "0x" + randomBytes(5892).toString("hex");
  await assert.rejects(registrySnapshot(w.reader, w.binding), (e) => e.refused && /reviewed code/.test(e.message));
  w.state.code = code; w.state.schema = 5n;
  await assert.rejects(registrySnapshot(w.reader, w.binding), (e) => e.refused && /schema 5/.test(e.message));
  // the live reviewed profile's registry pin is what readers bind to by default
  const live = capacityRegistryBinding(parseProfile(fs.readFileSync(PROFILE_FILE), { expectedDigest: PROFILE_DIGEST }).profile);
  assert.deepEqual({ ...live }, { chainId: 8453, address: "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac", codeHash: "0x39911d6f53959c610b9108bb906fc36ea8f57016c4b2571b5cd52c9c32a6f518", runtimeBytes: 5892, schema: "4" });
});

test("host endpoint fetches are SSRF-guarded: non-public resolution, redirects, plain http and oversized replies are refused", async (t) => {
  const real = (lookup) => publicJsonFetch({ lookup, timeoutMs: 2000 });
  for (const addrs of [[{ address: "127.0.0.1", family: 4 }], [{ address: "10.1.2.3", family: 4 }], [{ address: "8.8.8.8", family: 4 }, { address: "192.168.1.5", family: 4 }],
                       [{ address: "::1", family: 6 }], [{ address: "169.254.169.254", family: 4 }]])
    await assert.rejects(real(async () => addrs)("https://capacity.example.org/v1/host/capacity"), /non-public/);
  for (const url of ["http://capacity.example.org/v1/host/capacity", "https://u:p@capacity.example.org/x", "https://capacity.example.org/x?y=1"])
    await assert.rejects(real(async () => [{ address: "8.8.8.8", family: 4 }])(url), /https without credentials/);
  await assert.rejects(real(async () => [])("https://127.0.0.1/x"), /non-public/);
  const redirect = await hostServer(t, "host-a.example.org", (q, r) => { r.writeHead(302, { location: "https://169.254.169.254/" }); r.end(); });
  await assert.rejects(loopbackFetch()(redirect + HOST_CAPACITY_PATH), /redirects/);
  const big = await hostServer(t, "host-b.example.org", (q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ x: "y".repeat(70_000) })); });
  await assert.rejects(loopbackFetch()(big + HOST_CAPACITY_PATH), /too large/);
});

test("document bounds and the producer's lifecycle", async () => {
  const t0 = Date.now(), reg = "0x" + "86".repeat(20), ep = "https://host-a.example.org";
  for (const [doc, re] of [[{ gpuShareFree: 1.5 }, /share/], [{ cpuShareFree: -0.1 }, /share/], [{ vcpusFree: -1 }, /non-negative/], [{ askCpuPricePerSec6: 1.5 }, /integer/],
                           [{ claimEnabled: "yes" }, /boolean/], [{ type: "tpu" }, /gpu or cpu/], [{ x: "y".repeat(5000) }, /too long/], [{ big: 2 ** 60 }, /out of range/]])
    assert.throws(() => parseAvailability(JSON.stringify(doc)), re, JSON.stringify(doc).slice(0, 60));
  assert.throws(() => parseAvailability('{"a":' + "[".repeat(10) + "]".repeat(10) + "}"), /deeper/);
  assert.throws(() => parseAvailability('{"a":{"__proto__":{"claimEnabled":true}}}'), /key not allowed/);
  // the supervisor's manager and ledger passthroughs are carried as they are, whatever their values: no reader decides on them
  const full = { ...gpuDoc(t0), nn: { model: "llama", resident: true }, nnProbe: "ok", ramFreeMb: -512, ramCommittedMb: 130000, vramDivergenceGb: -1.5,
    volumes: [{ name: "weights/llama-70b", cid: "bafy" + "a".repeat(55), sizeGb: 140 }], guestPool: { heard: true, host: { floorMiB: 16384, admitsSmallestGuest: true },
    basis: "allocated = the reservations of the guests guestd holds" }, ledgerSync: { lastError: "x".repeat(3000) }, tenantVouch: {}, isolation: "snp-guest-per-app" };
  assert.deepEqual(parseAvailability(JSON.stringify(full)), full);
  assert.throws(() => parseAvailability(JSON.stringify({ blob: "x".repeat(33_000) })), /at most/);
  assert.throws(() => parseAvailability(JSON.stringify(Object.fromEntries(Array.from({ length: 300 }, (_, i) => ["k" + i, i])))), /too wide/);
  assert.throws(() => buildHostCapacityRecord({ availability: {}, chainId: 8453, registry: reg, endpoint: ep, operator: opA.address, lifetimeMs: HOST_CAPACITY_MAX_MS + 1 }), /at most/);
  assert.throws(() => buildHostCapacityRecord({ availability: {}, chainId: 8453, registry: reg, endpoint: "http://plain.example", operator: opA.address }), /https/);
  for (const endpoint of ["https://u@host.example", "https://host.example/t/x?y=1", "https://host.example/#f", "https://host .example"])
    assert.throws(() => buildHostCapacityRecord({ availability: {}, chainId: 8453, registry: reg, endpoint, operator: opA.address }), /https/, endpoint);
  await assert.rejects(signHostCapacity(opB, buildHostCapacityRecord({ availability: {}, chainId: 8453, registry: reg, endpoint: ep, operator: opA.address })), /only the record's operator/);
  // the producer: not registered yet -> 503; re-signs at half its lifetime with a forward-only sequence; a clock moving back -> 503
  let now = t0, endpoint = null;
  const p = createHostCapacityProducer({ account: opA, hostIdOf, registry: reg, endpoint: () => endpoint, availability: async () => ({ cpuShareFree: 0.5, updatedAt: new Date(now).toISOString() }), lifetimeMs: 60_000, now: () => now });
  assert.equal((await p.frame()).status, 503);
  endpoint = ep;
  const a = await p.current(); now += 10_000;
  assert.equal(await p.current(), a, "cached within half its lifetime");
  now += 25_000;
  const b = await p.current();
  assert.ok(b.record.sequence > a.record.sequence); assert.notEqual(b, a);
  now = t0 - 100_000;
  const back = await p.frame(); assert.equal(back.status, 503); assert.match(back.body, /clock moved backwards/);
  assert.throws(() => createHostCapacityProducer({ account: opA, hostIdOf, registry: reg, endpoint: ep, availability: async () => ({}), lifetimeMs: 1000 }), /lifetimeMs/);
  assert.throws(() => createHostCapacityProducer({ account: opA, registry: reg, endpoint: ep, availability: async () => ({}) }), /hostIdOf/);
  // a producer handed a wrong hostIdOf signs a record no reader accepts
  const wrong = createHostCapacityProducer({ account: opA, hostIdOf: () => "0x" + "11".repeat(32), registry: reg, endpoint: ep, availability: async () => ({}) });
  await assert.rejects(verifyHostCapacity(await wrong.current(), { pins: { chainId: 8453, registry: reg }, entry: { endpoint: ep, operator: opA.address, active: true } }), /hostId/);
  // identity(): ONE gate, read on every request and after signing
  assert.throws(() => createHostCapacityProducer({ account: opA, hostIdOf, identity: () => null, endpoint: ep, availability: async () => ({}) }), /not both/);
  let id = { endpoint: ep, registry: reg }, release, clock = Date.now();
  const gated = createHostCapacityProducer({ account: opA, hostIdOf, identity: () => id, availability: () => new Promise((r) => { release = r; }), now: () => (clock += 1000) });
  const pending = gated.frame();
  await new Promise((r) => setImmediate(r));
  id = null; release({ cpuShareFree: 0.5 });            // registration lost while the document was being read
  assert.equal((await pending).status, 503, "a record signed for an identity lost meanwhile is not served");
  id = { endpoint: ep, registry: reg };
  const fresh = gated.frame(); await new Promise((r) => setImmediate(r)); release({ cpuShareFree: 0.5 });
  assert.equal((await fresh).status, 200);
  id = null;                                             // lost while the cached record is still within its half lifetime
  const after = await gated.frame(); assert.equal(after.status, 503); assert.match(after.body, /not registered yet/);
  id = { endpoint: ep, registry: "0x" + "77".repeat(20) };   // registered elsewhere now: the cached record is not reused
  const moved = gated.frame(); await new Promise((r) => setImmediate(r)); release({ cpuShareFree: 0.5 });
  assert.equal(JSON.parse((await moved).body).record.registry, "0x" + "77".repeat(20));
});

test("the CLI: availability, record, publish and serve-directory without any Enclave endpoint", { timeout: 60000 }, async (t) => {
  const w = await world(t);
  const lines = [], out = (s) => lines.push(s);
  // a standalone directory from the CLI, then a record signed by the CLI and published by the CLI
  const server = await cli(["serve-directory", "--port", "0", "--profile", w.profileFile, "--profile-digest", w.digest], { reader: w.reader, stdout: out });
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  const dir = `http://127.0.0.1:${server.address().port}`;
  const key = path.join(w.dir, "op.key"); fs.writeFileSync(key, "0x" + "b2".repeat(32), { mode: 0o600 });
  const avail = path.join(w.dir, "avail.json"); fs.writeFileSync(avail, JSON.stringify(shieldDoc(Date.now())));
  const env = await cli(["record", "--key-file", key, "--endpoint", w.eps["host-b.example.org"], "--availability", avail, "--profile", w.profileFile, "--profile-digest", w.digest], { stdout: out });
  const file = path.join(w.dir, "env.json"); fs.writeFileSync(file, JSON.stringify(env));
  const pub = await cli(["publish", "--file", file, "--directory", dir], { stdout: out });
  assert.equal(pub[0].ok, true, JSON.stringify(pub));
  // availability from the directory plus host A's endpoint, rendered for a person
  lines.length = 0;
  const r = await cli(["availability", "--profile", w.profileFile, "--profile-digest", w.digest, "--directory", dir, "--host", w.eps["host-a.example.org"]],
    { reader: w.reader, stdout: out, fetchHost: loopbackFetch() });
  assert.equal(r.aggregate.enclaves, 2);
  const text = lines.join("\n");
  assert.match(text, /best gpu slice\s+63% of a card \(50 GB vram, 82 SMs\)/);
  assert.match(text, /enclave shield\s+30% of a card \(T0-hv: the host is not excluded\)/);
  assert.match(text, /self-reported by each host's registry operator/);
  assert.match(text, /posted cpu 200\/s/);
  // no trust, no read: the profile and two RPCs are required, and an unregistered --host is named as such
  await assert.rejects(cli(["availability", "--directory", dir]), /explicit reviewed authority profile/);
  await assert.rejects(cli(["availability", "--profile", w.profileFile, "--profile-digest", w.digest, "--rpc", "https://a.example", "--directory", dir]), /two or more RPCs/);
  await assert.rejects(cli(["availability", "--profile", w.profileFile, "--profile-digest", "sha256:" + "00".repeat(32), "--directory", dir], { reader: w.reader }), /digest mismatch/);
  const nr = await cli(["availability", "--profile", w.profileFile, "--profile-digest", w.digest, "--host", "https://fake.example.org", "--json"], { reader: w.reader, stdout: () => {}, fetchHost: loopbackFetch() });
  assert.match(nr.hosts[0].capacity.reasons.join(" "), /not a registered host/);
});

test("bounded reads: directory-listed hosts beyond --max-hosts are reported, not read; the CLI process refuses without trust", { timeout: 60000 }, async (t) => {
  const w = await world(t);
  const a = await w.producers["host-a.example.org"].current(), b = await w.producers["host-b.example.org"].current();
  const s = http.createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ records: [a, b] })); });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok)); t.after(() => new Promise((c) => s.close(c)));
  const r = await discoverHostCapacity({ reader: w.reader, binding: w.binding, directories: [`http://127.0.0.1:${s.address().port}`], maxHosts: 1 });
  assert.equal(r.hosts.length, 1); assert.equal(r.aggregate.enclaves, 1);
  assert.match(r.sources.find((x) => x.kind === "limit").error, /1 directory-listed host\(s\) beyond --max-hosts 1/);
  // the real executable: no profile, fewer than two RPCs, unknown flags -> exit 1 with the reason, nothing read
  const bin = new URL("../cli/independent-capacity.mjs", import.meta.url).pathname;
  const run = (args) => { try { execFileSync(process.execPath, [bin, ...args], { stdio: "pipe", timeout: 20000 }); return null; } catch (e) { return { status: e.status, err: String(e.stderr) }; } };
  let e = run(["availability", "--cold"]);
  assert.equal(e.status, 1); assert.match(e.err, /explicit reviewed authority profile is required/);
  e = run(["availability", "--cold", "--profile", w.profileFile, "--profile-digest", w.digest, "--rpc", "https://one.example"]);
  assert.equal(e.status, 1); assert.match(e.err, /two or more RPCs/);
  e = run(["availability", "--relay", "https://api.enclave.host"]);
  assert.equal(e.status, 1); assert.match(e.err, /unknown flag --relay/);
});

test("the lean producer module keeps directory-client's origin rules (it ships without that closure)", async () => {
  const { capacityDirectoryOrigins } = await import("../network/host-capacity-producer.mjs");
  const { directoryOrigins } = await import("../network/directory-client.mjs");
  const cases = [["https://d.example"], ["http://127.0.0.1:8080/"], ["https://d.example/x"], ["https://u:p@d.example"], ["https://d.example?x=1"], ["ftp://d.example"],
    ["https://d.example#f"], [], Array.from({ length: 9 }, (_, i) => `https://d${i}.example`), ["https://a.example", "https://a.example/"], ["not a url"]];
  const outcome = (f, v) => { try { return f(v); } catch { return "refused"; } };
  for (const c of cases) assert.deepEqual(outcome(capacityDirectoryOrigins, c), outcome(directoryOrigins, c), JSON.stringify(c));
});
