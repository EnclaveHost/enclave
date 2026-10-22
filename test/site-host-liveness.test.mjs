// The independent dashboard's off-chain host liveness (site/js/core/host-liveness.js): the SHARED rule
// (network/host-liveness.mjs, imported by the site itself) over operator-signed host capacity records verified in the page
// by the COMMITTED same-origin bundle (site/vendor/host-capacity.js = network/host-capacity.mjs and its imports, unmodified,
// with two reviewed shims). Records are signed here by throwaway keys generated for the test. Scripted fetch, no browser.
//   run: node --test test/site-host-liveness.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as NodeCap from "../network/host-capacity.mjs";
import { hostLiveness } from "../network/host-liveness.mjs";
import { canonical } from "../network/canonical.mjs";
import { buildHostCapacityVendor } from "../scripts/build-host-capacity-vendor.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "0x" + "11".repeat(20), OTHER_REGISTRY = "0x" + "12".repeat(20);
const profile = { format: "enclave-browser-profile", version: 1, chainId: 8453, rpcs: ["https://a.example", "https://b.example"], quorum: 2,
  capacityDirectories: ["https://mirror.example"],
  contractPins: { version: 1, chainId: 8453, contracts: { registry: REGISTRY, deployments: "0x" + "22".repeat(20), appCatalog: "0x" + "33".repeat(20),
    proofOfTime: "0x" + "44".repeat(20), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20),
    sessionVaultFactory: "0x" + "00".repeat(20), secretVaultV2: "0x" + "00".repeat(20) } }, usdc: "0x" + "66".repeat(20) };
const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
const text = JSON.stringify(profile);
globalThis.localStorage = mem(new Map([["enclave_independent_profile", text]]));
globalThis.sessionStorage = mem(new Map([["enclave_independent_ack", text]]));
globalThis.location = { hostname: "localhost" };

const HL = await import(pathToFileURL(path.join(REPO, "site/js/core/host-liveness.js")).href);
const IC = await import(pathToFileURL(path.join(REPO, "site/js/core/independent-chain.js")).href);
const V = await import(pathToFileURL(path.join(REPO, "site/vendor/host-capacity.js")).href);   // what the page loads

const NOW = Date.now(), CHAIN_NOW = Math.floor(NOW / 1000), OLD = CHAIN_NOW - 7200;
const key = () => privateKeyToAccount(generatePrivateKey());
const ops = { a: key(), b: key(), c: key(), d: key(), e: key(), f: key(), g: key(), h: key(), i: key(), j: key(), m: key() };
const ep = (n) => `https://${n}.host.test`;
const row = (n, { operator = ops[n].address, active = true, lastSeen = OLD, cpu = 100, gpu = 0, caps } = {}) =>
  ({ endpoint: ep(n), operator: operator.toLowerCase(), active, lastSeen, cpuPricePerSec6: cpu, gpuPricePerSec6: gpu, payoutWallet: "0x" + "00".repeat(20), ...(caps !== undefined ? { caps } : {}) });
const avail = JSON.stringify({ gpu: false, maxShare: 0.5, cpuShareFree: 0.5, claimEnabled: true });
async function signed(n, { by = ops[n], endpoint = ep(n), registry = REGISTRY, chainId = 8453, operator = ops[n].address, sequence, issuedAt = NOW - 1000, lifetimeMs = 5 * 60_000 } = {}){
  const record = NodeCap.buildHostCapacityRecord({ availability: avail, chainId, registry, endpoint, operator, sequence: sequence ?? issuedAt, now: issuedAt, lifetimeMs });
  // sign with `by` (a forger signs with its own key over a record naming the real operator)
  return { record, signature: await by.signMessage({ message: NodeCap.hostCapacityMessage(record) }) };
}
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
/* a scripted network: url -> body | Error | "hang" */
function net(map){
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push(url);
    const v = map[url];
    if (v === "hang") return new Promise((_, no) => init.signal.addEventListener("abort", () => no(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    if (v instanceof Error) throw v;
    if (v === undefined) throw new TypeError("Failed to fetch");
    return typeof v === "function" ? v() : ok(v);
  };
  return { fetchImpl, asked };
}
const snap = { number: 100, timestamp: CHAIN_NOW };
const capUrl = (n) => ep(n) + "/v1/host/capacity";
const MIRROR = "https://mirror.example/v1/host-capacity";

test("the committed bundle is a fresh build of the unmodified reader sources; its shims equal Node", async () => {
  const { js, manifest } = await buildHostCapacityVendor();
  assert.equal(Buffer.compare(fs.readFileSync(path.join(REPO, "site/vendor/host-capacity.js")), js), 0, "site/vendor/host-capacity.js is stale: run node scripts/build-host-capacity-vendor.mjs");
  const committed = JSON.parse(fs.readFileSync(path.join(REPO, "site/vendor/host-capacity.MANIFEST.json"), "utf8"));
  assert.equal(committed.sha256, manifest.sha256);
  for (const [p, v] of Object.entries(manifest.sources)) assert.equal(committed.sources[p]?.sha256, v.sha256, p);
  assert.deepEqual(Object.keys(manifest.sources).sort(), ["network/canonical.mjs", "network/host-capacity-record.mjs",
    "network/host-capacity.mjs", "scripts/host-capacity-vendor/buffer-shim.mjs", "scripts/host-capacity-vendor/node-crypto-shim.mjs"]);
  // the request paths are the producer's own
  const P = await import("../network/host-capacity-producer.mjs");
  assert.equal(HL.HOST_CAPACITY_PATH, P.HOST_CAPACITY_PATH);
  assert.equal(HL.DIRECTORY_CAPACITY_PATH, P.DIRECTORY_CAPACITY_PATH);
  // sha256 floors hash: the bundle's equals Node's, including non-ASCII text
  const env = await signed("a");
  const r2 = { ...env.record, availabilityJson: JSON.stringify({ note: "ünïcode ☃ ✓", gpu: false }) };
  for (const r of [env.record, r2]) assert.equal(V.hostCapacityHash(r), NodeCap.hostCapacityHash(r));
  for (const r of [env.record, r2]) assert.equal(V.hostCapacityHash(r), createHash("sha256").update(canonical(r), "utf8").digest("hex"));
  // the 32 KiB bound counts UTF-8 bytes in the bundle exactly as Buffer.byteLength does: 11000 snowmen = 33000 bytes
  const big = { ...env.record, availabilityJson: JSON.stringify({ note: "☃".repeat(11000) }) };
  assert.throws(() => NodeCap.validateHostCapacityRecord(big, NOW), /at most 32768 bytes/);
  assert.throws(() => V.validateHostCapacityRecord(big, NOW), /at most 32768 bytes/);
  // and the site imports the shared rule itself, not a copy
  assert.match(fs.readFileSync(path.join(REPO, "site/js/core/host-liveness.js"), "utf8"), /from "\.\.\/\.\.\/\.\.\/network\/host-liveness\.mjs"/);
  assert.doesNotMatch(fs.readFileSync(path.join(REPO, "site/js/core/host-liveness.js"), "utf8"), /node:crypto|from "crypto"/);
});

test("a healthy host with an OLD registry lastSeen and a fresh verified record is live and quotable; HTTP 200 alone is not", async () => {
  const hosts = [row("a"), row("g")];
  const n = net({ [capUrl("a")]: await signed("a"), [capUrl("g")]: { gpu: false, maxShare: 1 }, [MIRROR]: { records: [] } });
  HL._setForTests({ vendorModule: V, fetchImpl: n.fetchImpl });
  const ev = await HL.capacityEvidence(snap, hosts, { registry: REGISTRY, chainId: 8453 });
  const idA = NodeCap.hostIdOf(ep("a")), idG = NodeCap.hostIdOf(ep("g"));
  assert.equal(ev.byHost.get(idA).status, "verified");
  assert.match(ev.byHost.get(idG).reason, /exactly \{ record, signature \}/, "an unsigned availability answer is refused");
  const q = IC.quoteHosts(hosts, { chainNow: CHAIN_NOW, gpuMilli: 0, cpuMilli: 100, rev: 16, evidence: ev });
  const a = q.hosts.find((h) => h.endpoint === ep("a")), g = q.hosts.find((h) => h.endpoint === ep("g"));
  assert.equal(a.eligible, true);
  assert.equal(a.liveness.evidence, "signed-record");
  assert.equal(a.registryLastSeen, OLD);
  assert.equal(a.lastSeen, Math.floor((NOW - 1000) / 1000), "lastSeen is when liveness was last authenticated");
  assert.equal(g.eligible, false);
  assert.match(g.reason, /no fresh authenticated liveness.*signed capacity record refused/);
  // without the evidence only the (old) registry write counts: not live
  assert.equal(IC.quoteHosts(hosts, { chainNow: CHAIN_NOW, gpuMilli: 0, cpuMilli: 100, rev: 16 }).eligibleCount, 0);
  // the browser's liveHosts is the shared rule
  assert.deepEqual(IC.liveHosts(hosts, CHAIN_NOW, { evidence: ev }).map((h) => h.endpoint), [ep("a")]);
  assert.equal(hostLiveness({ operator: a.operator, active: true, lastSeen: OLD }, { nowMs: Date.now(), chainNowSec: CHAIN_NOW, signedUntilMs: ev.signedUntil.get(idA) }).evidence, "signed-record");
});

test("forged, wrong-operator, wrong-endpoint, stale, other-chain and other-registry records are refused; inactive rows never become eligible", async () => {
  const hosts = [row("b"), row("c", { operator: ops.h.address }), row("d"), row("e"), row("f", { active: false }), row("i"), row("j")];
  const n = net({
    [capUrl("b")]: await signed("b", { by: ops.m }),                                          // forged: signed by another key
    [capUrl("c")]: await signed("c"),                                                         // the registry names another operator
    [capUrl("d")]: await signed("d", { endpoint: "https://elsewhere.host.test" }),            // a record for another endpoint
    [capUrl("e")]: await signed("e", { issuedAt: NOW - 20 * 60_000, lifetimeMs: 10 * 60_000 }),   // expired
    [capUrl("f")]: await signed("f"),                                                         // valid, but the row is inactive
    [capUrl("i")]: await signed("i", { chainId: 1 }),
    [capUrl("j")]: await signed("j", { registry: OTHER_REGISTRY }),
    [MIRROR]: { records: [await signed("f")] },
  });
  HL._setForTests({ vendorModule: V, fetchImpl: n.fetchImpl });
  const ev = await HL.capacityEvidence(snap, hosts, { registry: REGISTRY, chainId: 8453 });
  const why = (k) => ev.byHost.get(NodeCap.hostIdOf(ep(k)))?.reason || "";
  assert.match(why("b"), /not signed by its operator/);
  assert.match(why("c"), /not the host's current registry operator/);
  assert.match(why("d"), /another endpoint|hostId/);
  assert.match(why("e"), /expired/);
  assert.match(why("i"), /another chain or registry/);
  assert.match(why("j"), /another chain or registry/);
  assert.equal(ev.byHost.has(NodeCap.hostIdOf(ep("f"))), false, "an inactive row is not even read");
  assert.ok(!n.asked.includes(capUrl("f")));
  assert.equal(ev.signedUntil.size, 0);
  const q = IC.quoteHosts(hosts, { chainNow: CHAIN_NOW, gpuMilli: 0, cpuMilli: 100, rev: 16, evidence: ev });
  assert.equal(q.eligibleCount, 0);
  assert.ok(!q.hosts.some((h) => h.endpoint === ep("f")), "inactive registrations are not offered");
  // admission is never relaxed by evidence: an inactive row with a recent registry write AND a verified record stays out
  const fake = { signedUntil: new Map([[NodeCap.hostIdOf(ep("f")), NOW + 60_000]]), byHost: new Map() };
  assert.equal(IC.liveHosts([row("f", { active: false, lastSeen: CHAIN_NOW })], CHAIN_NOW, { evidence: fake }).length, 0);
  assert.equal(IC.liveHosts([row("f", { caps: 2, lastSeen: CHAIN_NOW })], CHAIN_NOW, { evidence: fake }).length, 0, "the capability filter stays");
});

test("an address-book repoint or a re-registration under another operator invalidates a cached record at the next snapshot", async () => {
  const env = await signed("a", { issuedAt: NOW - 500 });
  const n = net({ [capUrl("a")]: env, [MIRROR]: { records: [] } });
  HL._setForTests({ vendorModule: V, fetchImpl: n.fetchImpl });
  const id = NodeCap.hostIdOf(ep("a"));
  assert.equal((await HL.capacityEvidence(snap, [row("a")], { registry: REGISTRY, chainId: 8453 })).byHost.get(id).status, "verified");
  // the book now names another registry: the same (cached) record is for the old binding
  const moved = await HL.capacityEvidence({ ...snap, number: 101 }, [row("a")], { registry: OTHER_REGISTRY, chainId: 8453 });
  assert.match(moved.byHost.get(id).reason, /another chain or registry/);
  assert.equal(moved.signedUntil.size, 0);
  // the host re-registered under another operator
  const reop = await HL.capacityEvidence({ ...snap, number: 102 }, [row("a", { operator: ops.h.address })], { registry: REGISTRY, chainId: 8453 });
  assert.match(reop.byHost.get(id).reason, /not the host's current registry operator/);
  // and deactivated: not read, not live
  const off = await HL.capacityEvidence({ ...snap, number: 103 }, [row("a", { active: false })], { registry: REGISTRY, chainId: 8453 });
  assert.equal(off.byHost.size, 0);
  assert.equal(IC.liveHosts([row("a", { active: false })], CHAIN_NOW, { evidence: off }).length, 0);
});

test("replay of an older record and equivocation (two records, one sequence) are refused per host and operator", async () => {
  const newer = await signed("a", { sequence: NOW - 100, issuedAt: NOW - 100 }), older = await signed("a", { sequence: NOW - 2000, issuedAt: NOW - 2000 });
  let serve = newer;
  const n = net({ [capUrl("a")]: () => ok(serve), [MIRROR]: { records: [] } });
  HL._setForTests({ vendorModule: V, fetchImpl: n.fetchImpl, limits: { REFRESH_MS: 0 } });
  const id = NodeCap.hostIdOf(ep("a"));
  assert.equal((await HL.capacityEvidence(snap, [row("a")])).byHost.get(id).status, "verified");
  serve = older;
  const replay = await HL.capacityEvidence(snap, [row("a")]);
  assert.match(replay.byHost.get(id).reason, /older host capacity record than one already seen \(replay\)/);
  // equivocation: the host and a mirror present different records with one sequence
  const s = NOW - 50;
  const one = await signed("a", { sequence: s, issuedAt: s }), two = { ...(await signed("a", { sequence: s, issuedAt: s })) };
  const twoRec = NodeCap.buildHostCapacityRecord({ availability: JSON.stringify({ gpu: false, maxShare: 0.1, claimEnabled: true }), chainId: 8453, registry: REGISTRY,
    endpoint: ep("a"), operator: ops.a.address, sequence: s, now: s });
  two.record = twoRec; two.signature = await ops.a.signMessage({ message: NodeCap.hostCapacityMessage(twoRec) });
  const n2 = net({ [capUrl("a")]: one, [MIRROR]: { records: [two] } });
  HL._setForTests({ vendorModule: V, fetchImpl: n2.fetchImpl, limits: { REFRESH_MS: 0 } });
  const eq = await HL.capacityEvidence(snap, [row("a")]);
  assert.equal(eq.byHost.get(id).status, "equivocation");
  assert.equal(eq.signedUntil.size, 0);
});

test("independent sources: a host outage is reported (not 'no capacity'); a mirror's verified copy keeps the host live; no mirror is required", async () => {
  const id = NodeCap.hostIdOf(ep("a")), idB = NodeCap.hostIdOf(ep("b"));
  // host a is down, the mirror has its record; host b is down with no record anywhere but a recent registry write
  const n = net({ [capUrl("a")]: new TypeError("Failed to fetch"), [capUrl("b")]: new TypeError("Failed to fetch"),
    [MIRROR]: { records: [await signed("a"), await signed("f")] } });
  HL._setForTests({ vendorModule: V, fetchImpl: n.fetchImpl });
  const hosts = [row("a"), row("b", { lastSeen: CHAIN_NOW - 60 })];
  const ev = await HL.capacityEvidence(snap, hosts);
  assert.equal(ev.byHost.get(id).status, "verified");
  assert.equal(ev.byHost.get(id).from, "https://mirror.example");
  assert.equal(ev.byHost.get(idB).status, "unreachable");
  assert.match(HL.evidenceNote(ev), /1 host endpoint\(s\) did not answer/);
  const q = IC.quoteHosts(hosts, { chainNow: CHAIN_NOW, gpuMilli: 0, cpuMilli: 100, rev: 16, evidence: ev });
  assert.deepEqual(q.hosts.filter((h) => h.eligible).map((h) => [h.endpoint, h.liveness.evidence]).sort(),
    [[ep("a"), "signed-record"], [ep("b"), "registry-update"]], "the registry write still counts while records are unreachable");
  // the mirror down too: hosts with records only from the mirror lose signed evidence, and it says so
  const n2 = net({ [capUrl("a")]: new TypeError("Failed to fetch"), [MIRROR]: new TypeError("Failed to fetch") });
  HL._setForTests({ vendorModule: V, fetchImpl: n2.fetchImpl });
  const ev2 = await HL.capacityEvidence(snap, [row("a")]);
  assert.equal(ev2.byHost.get(id).status, "unreachable");
  assert.match(HL.evidenceNote(ev2), /mirror\.example.*Failed to fetch/);
  const q2 = IC.quoteHosts([row("a")], { chainNow: CHAIN_NOW, gpuMilli: 0, cpuMilli: 100, rev: 16, evidence: ev2 });
  assert.match(q2.hosts[0].reason, /capacity record unavailable: Failed to fetch/);
});

test("bounded: a hanging host times out, the call ends within its total budget, overflow beyond MAX_HOSTS is reported", async () => {
  const names = Array.from({ length: 12 }, (_, i) => "h" + i);
  for (const nm of names) ops[nm] = key();
  const map = { [MIRROR]: "hang" };
  for (const nm of names) map[capUrl(nm)] = "hang";
  const n = net(map);
  HL._setForTests({ vendorModule: V, fetchImpl: n.fetchImpl, limits: { MAX_HOSTS: 8, CONCURRENCY: 3, REQUEST_TIMEOUT_MS: 200, TOTAL_MS: 500 } });
  const t0 = Date.now();
  const ev = await HL.capacityEvidence(snap, names.map((nm) => row(nm)));
  const took = Date.now() - t0;
  assert.ok(took < 1500, "finished in " + took + " ms");
  assert.equal(ev.limited, 4);
  assert.equal(ev.complete, false);
  assert.ok(n.asked.filter((u) => u.endsWith("/v1/host/capacity")).length <= 8, "at most MAX_HOSTS host reads");
  const st = [...ev.byHost.values()].map((b) => b.status);
  assert.ok(st.every((s) => s === "unreachable" || s === "unchecked"), JSON.stringify(st));
  assert.ok(st.includes("unchecked"), "the budget, not each request's timeout, ended the call");
  assert.match(HL.evidenceNote(ev), /beyond 8 were not read/);
});

test("the profile names capacity mirrors as bare origins (at most 8); none is required", async () => {
  const { validateProfile } = await import(pathToFileURL(path.join(REPO, "site/js/core/independent.js")).href);
  assert.deepEqual([...validateProfile(profile).capacityDirectories], ["https://mirror.example"]);
  assert.deepEqual([...validateProfile({ ...profile, capacityDirectories: undefined }).capacityDirectories], []);
  for (const bad of [["http://mirror.example"], ["https://mirror.example/v1"], ["https://u:p@mirror.example"], "https://mirror.example",
    Array.from({ length: 9 }, (_, i) => "https://m" + i + ".example")])
    assert.throws(() => validateProfile({ ...profile, capacityDirectories: bad }), /capacity ?director/i, JSON.stringify(bad));
});

test("an oversized answer is refused without reading it all", async () => {
  const huge = "x".repeat(70 * 1024);
  const n = net({ [capUrl("a")]: () => new Response(huge, { status: 200 }), [MIRROR]: { records: [] } });
  HL._setForTests({ vendorModule: V, fetchImpl: n.fetchImpl });
  const ev = await HL.capacityEvidence(snap, [row("a")]);
  assert.match(ev.byHost.get(NodeCap.hostIdOf(ep("a"))).reason, /larger than 65536 bytes/);
});
