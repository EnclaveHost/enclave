// Discovery, capacity and host-owner policy in the default independent dashboard, without a browser or a chain:
//   - js/core/service-discovery.js: the Ad ABI decoder against viem's encoder, endpoint rules against the reference
//     network/service-index.mjs, ad judging, one operator = one participant, mixed-content reachability, provider choices,
//     a pinned code hash that is never weakened;
//   - js/core/host-capacity.js against network/host-capacity.mjs verifyHostCapacity on real signatures;
//   - js/core/host-policy.js against network/host-admission-policy.mjs (hash and refusal), and a veto that removes only
//     the owner's own hosts;
//   - site/vendor/discovery.js equals a fresh build of its recorded entry.
//   node --test test/site-default-discovery.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, keccak256, toBytes } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as REFSI from "../network/service-index.mjs";
import * as REFCAP from "../network/host-capacity.mjs";
import * as REFPOL from "../network/host-admission-policy.mjs";
import * as SD from "../site/js/core/service-discovery.js";
import * as HC from "../site/js/core/host-capacity.js";
import * as HP from "../site/js/core/host-policy.js";
import { keccak256Hex } from "../site/js/core/keccak.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AD = { type: "tuple", components: [{ name: "operator", type: "address" }, { name: "slot", type: "uint8" }, { name: "kind", type: "uint16" }, { name: "version", type: "uint16" },
  { name: "sequence", type: "uint64" }, { name: "expiresAt", type: "uint64" }, { name: "updatedAt", type: "uint64" }, { name: "descriptor", type: "bytes32" }, { name: "endpoints", type: "string[]" }] };
const ad = (o) => ({ operator: o.operator, slot: o.slot ?? 0, kind: o.kind ?? 1, version: o.version ?? 1, sequence: BigInt(o.sequence ?? 1), expiresAt: BigInt(o.expiresAt ?? 2e9),
  updatedAt: BigInt(o.updatedAt ?? 1e9), descriptor: o.descriptor ?? "0x" + "0".repeat(64), endpoints: o.endpoints });
const encPage = (ads, total) => encodeAbiParameters([{ type: "tuple[]", components: AD.components }, { type: "uint256" }], [ads.map(ad), BigInt(total ?? ads.length)]);
const encGet = (a) => encodeAbiParameters([AD], [ad(a)]);
const OP_A = "0x" + "a1".repeat(20), OP_B = "0x" + "b2".repeat(20);

test("the Ad decoder equals viem's ABI encoding, including empty, long and unicode-free endpoint lists", () => {
  const ads = [{ operator: OP_A, endpoints: ["https://dir-1.operator-a.net/", "https://dir-2.operator-a.net/", "http://134.199.235.187:8188/", "https://203.0.114.9/"] },
    { operator: OP_B, slot: 3, kind: 3, sequence: 77, endpoints: ["https://storage.operator-b.org/"] }];
  const p = SD.decodePage(encPage(ads, 9));
  assert.equal(p.total, 9n); assert.equal(p.ads.length, 2);
  assert.equal(p.ads[0].operator, OP_A); assert.deepEqual(p.ads[0].endpoints, ads[0].endpoints);
  assert.equal(p.ads[1].slot, 3); assert.equal(p.ads[1].kind, 3); assert.equal(p.ads[1].sequence, "77");
  assert.deepEqual(SD.decodeGet(encGet(ads[1])).endpoints, ["https://storage.operator-b.org/"]);
  assert.deepEqual(SD.decodePage(encPage([], 0)).ads, []);
  // a truncated or out-of-bounds answer is refused, never half-read
  const enc = encPage(ads, 2);
  assert.throws(() => SD.decodePage(enc.slice(0, enc.length - 64)), /out of bounds/);
  assert.throws(() => SD.decodePage("0x" + "ff".repeat(64)), /out of range|out of bounds/);
});

test("endpoint rules equal network/service-index.mjs validateEndpoint", () => {
  const cases = ["https://dir.operator-a.net/", "http://134.199.235.187:8188/", "https://10.0.0.1/", "https://127.0.0.1/", "https://[::1]/", "https://localhost/",
    "https://dir.example/", "https://a.test/", "https://x/", "ftp://dir.operator-a.net/", "https://u:p@dir.operator-a.net/", "https://dir.operator-a.net/?k=1",
    "https://100.64.1.1/", "https://192.168.1.1/", "https://8.8.8.8/x", "https://dir.operator-a.net:8443/v1", "https://" + "a".repeat(250) + ".net/", "https://dir.local/"];
  for (const c of cases){
    let a, b; try { a = SD.validateEndpoint(c); } catch (e){ a = "refused"; } try { b = REFSI.validateEndpoint(c); } catch (e){ b = "refused"; }
    assert.equal(a, b, c);
  }
});

test("judging and grouping: expired/unknown ads drop with reasons; one operator is one participant however many endpoints", () => {
  const ts = 1_800_000_000;
  assert.equal(SD.judge(ad({ operator: OP_A, endpoints: ["https://d.operator-a.net/"], expiresAt: ts }), ts).state, "expired");
  assert.equal(SD.judge(ad({ operator: OP_A, endpoints: ["https://d.operator-a.net/"], version: 2 }), ts).state, "rejected");
  assert.equal(SD.judge(ad({ operator: OP_A, endpoints: ["https://d.operator-a.net/"], kind: 9 }), ts).state, "rejected");
  assert.equal(SD.judge(ad({ operator: OP_A, endpoints: ["https://127.0.0.1/"] }), ts).state, "rejected");
  const cA = SD.judge(ad({ operator: OP_A, endpoints: ["https://d1.operator-a.net/", "https://d2.operator-a.net/", "https://d3.operator-a.net/", "http://134.199.235.187:8188/"] }), ts).candidate;
  const cB = SD.judge(ad({ operator: OP_B, kind: 3, endpoints: ["https://s.operator-b.org/"] }), ts).candidate;
  // same parity with the reference judge for the listed ad
  const ops = SD.operatorsOf([cA, cB], "https:");
  assert.equal(ops.length, 2, "two operators, not five endpoints");
  const a = ops.find((o) => o.operator === OP_A);
  assert.equal(a.endpoints.length, 4);
  assert.equal(a.endpoints.find((e) => e.url.startsWith("http:")).reachable, false, "plain HTTP from an HTTPS page");
  assert.equal(SD.reachability("http://134.199.235.187:8188/", "http:").reachable, true);
  // page directories: only CHOSEN operators, one participant each
  const profile = { directories: ["https://own-dir.example.org"], serviceIndex: { address: "0x" + "54".repeat(20), codeHash: "0x" + "69".repeat(32) }, contracts: {}, rpcs: [] };
  const disc = { candidates: [cA, cB], lookups: [] };
  const none = SD.pageDirectories(profile, disc, { pageProtocol: "https:", choices: { directoryOperators: [] } });
  assert.deepEqual(none.map((d) => d.origin), ["https://own-dir.example.org"], "unchosen candidates are never used");
  const chosen = SD.pageDirectories(profile, disc, { pageProtocol: "https:", choices: { directoryOperators: [OP_A] } });
  assert.equal(chosen.length, 5);
  assert.equal(SD.participantsOf(chosen), 2, "a profile directory + ONE operator, though it lists four endpoints");
  assert.equal(chosen.filter((d) => !d.reachable).length, 1);
});

test("readServiceIndex: the pinned code hash is never weakened; windows, lookups and freshness at the agreed block", async () => {
  const code = "0x6080604052";
  const pin = { chainId: 8453, address: "0x" + "54".repeat(20), codeHash: keccak256Hex(code) };
  const now = 1_800_000_000;
  const dirAds = [{ operator: OP_A, endpoints: ["https://d.operator-a.net/"] }, { operator: OP_B, endpoints: ["https://d.operator-b.org/"], expiresAt: now - 1 }];
  const reader = (codeAt = code) => ({ snapshot: async () => ({ number: 7, hash: "0x" + "b".repeat(64), timestamp: now, rpcs: ["x", "y"] }),
    code: async () => codeAt,
    call: async (_s, _to, data) => {
      const selPage = "0x" + keccak256(toBytes("page(uint16,uint256,uint256)")).slice(2, 10), selGet = "0x" + keccak256(toBytes("get(address,uint8)")).slice(2, 10);
      if (data.startsWith(selPage)){ const kind = Number(BigInt("0x" + data.slice(10, 74))); return encPage(kind === 1 ? dirAds : [], kind === 1 ? 2 : 0); }
      if (data.startsWith(selGet)){ const op = "0x" + data.slice(10 + 24, 74); const slot = Number(BigInt("0x" + data.slice(74, 138)));
        return encGet(op === OP_A && slot === 0 ? dirAds[0] : { operator: "0x" + "0".repeat(40), endpoints: [] }); }
      throw new Error("unexpected call");
    } });
  const r = await SD.readServiceIndex({ reader: reader(), pin, kinds: ["directory", "storage"], lookups: [{ operator: OP_A, slot: 0 }, { operator: OP_B, slot: 0 }] });
  assert.equal(r.status, "complete"); assert.equal(r.block, 7);
  assert.equal(r.candidates.length, 1); assert.equal(r.expired, 1);
  assert.equal(r.lookups.find((l) => l.operator === OP_A).state, "listed");
  assert.equal(r.lookups.find((l) => l.operator === OP_B).state, "absent");
  await assert.rejects(SD.readServiceIndex({ reader: reader("0x6001"), pin }), /not the pinned/);
  await assert.rejects(SD.readServiceIndex({ reader: reader("0x"), pin }), /absent, not the pinned/);
});

test("provider choices persist per profile and never leak across profiles", () => {
  const m = new Map(), ls = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
  const p1 = { serviceIndex: { address: "0x1" }, contracts: { deployments: "0xa" }, rpcs: ["https://a"] }, p2 = { ...p1, rpcs: ["https://b"] };
  SD.saveChoices(p1, { directoryOperators: [OP_A, "not-an-address"] }, ls);
  assert.deepEqual(SD.loadChoices(p1, ls).directoryOperators, [OP_A]);
  assert.deepEqual(SD.loadChoices(p2, ls).directoryOperators, []);
});

test("host capacity: the page's verifier agrees with network/host-capacity.mjs on real signatures", async () => {
  HC._setRecoverForTests((await import("viem")).recoverMessageAddress);
  const op = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
  const endpoint = "https://host-a.operator-a.net", registry = "0x" + "86".repeat(20);
  const now = Date.now();
  const rec = REFCAP.buildHostCapacityRecord({ availability: { gpu: false, cpuShareFree: 0.4, claimEnabled: true }, chainId: 8453, registry, endpoint, operator: op.address, now });
  const env = await REFCAP.signHostCapacity(op, rec);
  const entry = { endpoint, operator: op.address.toLowerCase(), active: true };
  const pins = { chainId: 8453, registry };
  const both = async (e, en = entry, at = now) => {
    let a, b; try { await HC.verifyHostCapacity(e, { pins, entry: en, now: at }); a = "ok"; } catch (x){ a = "refused"; }
    try { await REFCAP.verifyHostCapacity(e, { pins, entry: en, now: at }); b = "ok"; } catch (x){ b = "refused"; }
    return [a, b];
  };
  assert.deepEqual(await both(env), ["ok", "ok"]);
  assert.deepEqual(await both(env, { ...entry, operator: other.address.toLowerCase() }), ["refused", "refused"], "not the current registry operator");
  assert.deepEqual(await both(env, { ...entry, active: false }), ["refused", "refused"]);
  assert.deepEqual(await both(env, entry, now + 16 * 60_000), ["refused", "refused"], "expired");
  assert.deepEqual(await both({ ...env, signature: (await other.signMessage({ message: REFCAP.hostCapacityMessage(rec) })) }), ["refused", "refused"], "signed by someone else");
  assert.deepEqual(await both({ record: { ...rec, hostId: "0x" + "1".repeat(64) }, signature: env.signature }), ["refused", "refused"], "hostId is not keccak(endpoint)");
  assert.equal(HC.hostIdOf(endpoint), REFCAP.hostIdOf(endpoint));
  assert.equal(HC.hostCapacityHash(rec), REFCAP.hostCapacityHash(rec));
  // readHostCapacity: host endpoint + a directory; an equivocating host shows nothing
  const rec2 = { ...rec, availabilityJson: JSON.stringify({ gpu: false, cpuShareFree: 0.1 }) };
  const env2 = await REFCAP.signHostCapacity(op, rec2);
  const fetchImpl = async (url) => {
    const body = url.startsWith(endpoint) ? JSON.stringify(env) : url.startsWith("https://dir.operator-b.org") ? JSON.stringify({ records: [env2] }) : null;
    if (!body) return new Response("no", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  const res = await HC.readHostCapacity({ hosts: [entry], directories: [{ origin: "https://dir.operator-b.org", operator: OP_B, reachable: true }], pins, fetchImpl, now: () => now });
  assert.equal(res.capacity.get(HC.hostIdOf(endpoint)).equivocation, true);
  const res1 = await HC.readHostCapacity({ hosts: [entry], directories: [], pins, fetchImpl, now: () => now });
  assert.match(HC.capacityLine(res1.capacity.get(HC.hostIdOf(endpoint))), /host-reported, signed by its operator, expires in \d+ min: CPU share free 40%/);
  const res2 = await HC.readHostCapacity({ hosts: [{ ...entry, endpoint: "https://quiet-host.operator-c.net" }], directories: [], pins, fetchImpl, now: () => now });
  assert.match(HC.capacityLine(res2.capacity.values().next().value), /^no capacity report/);
});

test("host-owner policy: same hash and refusal as the host; a veto removes only that owner's host; an unreadable policy blocks only its host", async () => {
  const own = "0x" + "f5".repeat(20), h1 = keccak256(toBytes("https://h1.enclave-operated.net")), h2 = keccak256(toBytes("https://h2.independent.net")), h3 = keccak256(toBytes("https://h3.other.net"));
  const app = "catalog://0x" + "11".repeat(32) + "/0";
  const deny = { version: 1, chainId: 8453, ownershipContract: own, hostId: h1, requireCatalogApproval: false, denyDeployments: [], denyAppRefs: [app] };
  assert.equal(HP.hostAdmissionPolicyHash(deny), REFPOL.hostAdmissionPolicyHash(deny));
  for (const args of [{ hostId: h1, deploymentId: "0x" + "22".repeat(32), appRef: app }, { hostId: h1, deploymentId: "0x" + "22".repeat(32), appRef: "catalog://0x" + "33".repeat(32) + "/1" }])
    assert.equal(HP.hostAdmissionRefusal(deny, args), REFPOL.hostAdmissionRefusal(deny, { ...args, version: null }));
  const approval = { ...deny, hostId: h3, requireCatalogApproval: true, denyAppRefs: [] };
  for (const version of [null, { active: true, yanked: false, approval: 1 }, { active: true, yanked: true, approval: 1 }, { active: true, yanked: false, approval: 0 }])
    assert.equal(HP.hostAdmissionRefusal(approval, { hostId: h3, deploymentId: "0x" + "22".repeat(32), appRef: app, version }),
      REFPOL.hostAdmissionRefusal(approval, { hostId: h3, deploymentId: "0x" + "22".repeat(32), appRef: app, version }));
  // authority(hostId): h1 owned with the deny policy, h2 owned with no policy, h3 owned with an unfetchable policy
  const word = (h) => h.replace(/^0x/, "").padStart(64, "0");
  const hash1 = HP.hostAdmissionPolicyHash(deny), hash3 = "0x" + "99".repeat(32);
  const reader = { call: async (_s, to, data) => {
    assert.equal(to, own);
    const id = "0x" + data.slice(10);
    const owner = "0x" + "0b".repeat(20), z = "0x" + "0".repeat(64);
    const ph = id === h1 ? hash1 : id === h3 ? hash3 : z;
    return "0x" + word(owner) + word("0x0") + word("0x1") + word(ph);
  } };
  const fetchImpl = async (url) => url.endsWith(hash1.slice(0) + ".json") ? new Response(JSON.stringify(deny), { status: 200 }) : new Response("gone", { status: 404 });
  const pol = await HP.readHostPolicies({ reader, snap: {}, ownership: own, hostIds: [h1, h2, h3], mirrors: ["https://mirror.operator-a.net"], fetchImpl });
  assert.equal(pol.get(h1).state, "policy"); assert.equal(pol.get(h2).state, "open"); assert.equal(pol.get(h3).state, "unavailable");
  const v1 = HP.ownerVerdict(pol.get(h1), { hostId: h1, appRef: app }), v2 = HP.ownerVerdict(pol.get(h2), { hostId: h2, appRef: app }), v3 = HP.ownerVerdict(pol.get(h3), { hostId: h3, appRef: app });
  assert.equal(v1.eligible, false); assert.match(v1.reason, /declines this deployment/);
  assert.equal(v2.eligible, true, "another owner's host is unaffected");
  assert.equal(v3.eligible, false); assert.match(v3.reason, /policy is unavailable/);
  // the quote list: only h1 and h3 leave it; the ceiling suggestion is recomputed from what is left
  const IC = await import("../site/js/core/independent-chain.js");
  const q = { hosts: [h1, h2, h3].map((hostId, i) => ({ hostId, endpoint: "e" + i, eligible: true, free: false, rate6: BigInt(10 - i) })), defaultCap6: 8n, eligibleCount: 3 };
  IC.applyOwnerVerdicts(q, { byHost: new Map([[h1, v1], [h2, v2], [h3, v3]]), note: "" });
  assert.deepEqual(q.hosts.filter((h) => h.eligible).map((h) => h.hostId), [h2]);
  assert.equal(q.defaultCap6, 9n); assert.equal(q.eligibleCount, 1);
  assert.ok(q.hosts.find((h) => h.hostId === h1).ownerDeclines);
});

test("site/vendor/discovery.js is a fresh build of its recorded entry", async () => {
  const { buildDiscoveryVendor, OUT, MANIFEST } = await import("../scripts/build-discovery-vendor.mjs");
  const { js, manifest } = await buildDiscoveryVendor();
  assert.ok(Buffer.compare(fs.readFileSync(OUT), js) === 0, "site/vendor/discovery.js differs from a fresh build");
  assert.deepEqual(JSON.parse(fs.readFileSync(MANIFEST, "utf8")), manifest);
  assert.ok(fs.existsSync(path.join(ROOT, manifest.entry)));
});
