// The independent dashboard's platform host policy (site/js/core/host-policy.js) over the COMMITTED same-origin bundle
// (site/vendor/host-policy.js = network/platform-host-policy.mjs, host-policy-adapters.mjs, host-policy-mirrors.mjs,
// unmodified) and the site's own quorum reader (site/js/core/quorum.js) in front of three scripted RPCs. Policies are
// signed here by throwaway keys generated for the test; nothing is published or anchored anywhere real.
//   run: node --test test/site-host-policy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeFunctionData, encodeFunctionResult, keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as P from "../network/platform-host-policy.mjs";
import { buildHostPolicyVendor } from "../scripts/build-host-policy-vendor.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const addr = (n) => "0x" + n.toString(16).padStart(40, "0");
const BOOK = addr(0xb00c), REGISTRY = addr(0x1e9), OWN = addr(0x0e1), OTHER_BOOK = addr(0xb00d);
const profile = { format: "enclave-browser-profile", version: 1, chainId: 8453, addressBook: BOOK, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 600,
  rpcs: ["https://a.example", "https://b.example", "https://c.example"],
  hostPolicy: { hostOwnership: OWN, mirrors: ["https://policy-a.example", "https://policy-b.example"] },
  contractPins: { version: 1, chainId: 8453, contracts: { registry: REGISTRY, deployments: addr(0xd1), appCatalog: addr(0xca),
    proofOfTime: addr(0xd1), enclavePay: addr(0), verificationFees: addr(0), sessionVaultFactory: addr(0xf1), secretVaultV2: addr(0) } }, usdc: addr(0x6) };
const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
const text = JSON.stringify(profile);
globalThis.localStorage = mem(new Map([["enclave_independent_profile", text]]));
globalThis.sessionStorage = mem(new Map([["enclave_independent_ack", text]]));
globalThis.location = { hostname: "localhost", origin: "https://dash.example" };

const HP = await import(pathToFileURL(path.join(REPO, "site/js/core/host-policy.js")).href);
const IC = await import(pathToFileURL(path.join(REPO, "site/js/core/independent-chain.js")).href);
const { validateProfile } = await import(pathToFileURL(path.join(REPO, "site/js/core/independent.js")).href);
const { createQuorumReader } = await import(pathToFileURL(path.join(REPO, "site/js/core/quorum.js")).href);
const V = await import(pathToFileURL(path.join(REPO, "site/vendor/host-policy.js")).href);

// ---- hosts and keys ----
const admin = privateKeyToAccount(generatePrivateKey()), admin2 = privateKeyToAccount(generatePrivateKey()), mallory = privateKeyToAccount(generatePrivateKey());
const hostId = (e) => keccak256(toBytes(e));
const H = { good: "https://good.host.test", bad: "https://bad.host.test", fresh: "https://fresh.host.test", off: "https://off.host.test" };
const OP = { good: addr(0xa1), bad: addr(0xa2), fresh: addr(0xa3), off: addr(0xa4) };
const row = (k, o = {}) => ({ endpoint: H[k], operator: OP[k], active: k !== "off", lastSeen: Math.floor(Date.now() / 1000), cpuPricePerSec6: 100, gpuPricePerSec6: 0,
  payoutWallet: addr(0), ...o });
const Z32 = "0x" + "00".repeat(32);
const doc = (o = {}) => ({ format: P.POLICY_FORMAT, chainId: 8453, book: BOOK, registry: REGISTRY, hostOwnership: OWN, sequence: 1,
  issuedAt: Math.floor(Date.now() / 1000) - 60, expiresAt: 0, maxStaleSec: 0, previousDigest: Z32, mode: "denylist",
  deny: [{ kind: "operator", value: OP.bad, reason: "malware distribution" }], admit: [], ...o });
const sign = async (acct, p) => ({ document: JSON.stringify(p), signature: await acct.signTypedData(P.policyTypedData(p)) });

// ---- a scripted chain behind the site's quorum reader ----
const ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "authority", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }, { type: "address" }, { type: "uint64" }, { type: "bytes32" }] },
  { type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [{ type: "bytes4" }] },
  { type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [{ name: "endpoint", type: "string" }, { name: "repo", type: "string" },
    { name: "measurement", type: "bytes32" }, { name: "operator", type: "address" }, { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" }, { name: "active", type: "bool" }] }] }];
const REG_KEY = "0x" + Buffer.from("registry").toString("hex").padEnd(64, "0");
const chain = { block: 100, ageSec: 0, owner: admin.address.toLowerCase(), ownerCode: "0x", valid1271: new Set(), hi: addr(0), lo: addr(0), registry: REGISTRY,
  hosts: Object.fromEntries(Object.keys(H).map((k) => [hostId(H[k]), { endpoint: H[k], operator: OP[k], active: k !== "off" }])), down: new Set(), poison: null, calls: 0 };
function answer(url, method, params){
  if (chain.down.has(url)) throw new Error("connection refused");
  const st = url === "https://c.example" && chain.poison ? { ...chain, ...chain.poison } : chain;
  if (method === "eth_chainId") return "0x2105";
  if (method === "eth_blockNumber") return "0x" + st.block.toString(16);
  if (method === "eth_getBlockByNumber") return { number: params[0], hash: "0x" + Number(params[0]).toString(16).padStart(64, "0"), timestamp: "0x" + (Math.floor(Date.now() / 1000) - st.ageSec).toString(16) };
  if (method === "eth_getCode") return params[0].toLowerCase() === st.owner ? st.ownerCode : "0x";
  if (method !== "eth_call") throw new Error("unexpected " + method);
  chain.calls++;
  const { to, data } = params[0], T = to.toLowerCase(), { functionName, args } = decodeFunctionData({ abi: ABI, data });
  let r;
  if (T === BOOK && functionName === "owner") r = st.owner;
  else if (T === BOOK && functionName === "addr") r = args[0] === P.ANCHOR_KEYS.hi ? st.hi : args[0] === P.ANCHOR_KEYS.lo ? st.lo : args[0] === REG_KEY ? st.registry : addr(0);
  else if (T === st.registry.toLowerCase() && functionName === "get"){
    // historical per block (the reader asks by block hash = the block number here): `off` = [[from, to)] inactive ranges
    const h = st.hosts[args[0]], bn = parseInt(params[1].blockHash, 16);
    const active = !!h?.active && !(h?.off || []).some(([f, t]) => bn >= f && bn < t);
    r = { endpoint: h?.endpoint || "", repo: "", measurement: Z32, operator: h?.operator || addr(0), registeredAt: 1n, lastSeen: 1n, active }; }
  else if (functionName === "authority") r = [addr(0), addr(0), 0n, Z32];          // the ownership extension: no accepted owners
  else if (T === st.owner && functionName === "isValidSignature") r = st.valid1271.has(args[0] + ":" + args[1]) ? "0x1626ba7e" : "0xffffffff";
  else throw new Error("unexpected " + T + " " + functionName);
  return encodeFunctionResult({ abi: ABI, functionName, result: r });
}
const rpc = async (url, method, params) => answer(url, method, params);
const newReader = () => createQuorumReader({ rpcs: profile.rpcs, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 600, chainId: 8453, rpc });
// mirrors: url -> body (object) | Error | "hang"
const mirrors = new Map();
const mirrorFetch = async (url, init) => {
  const v = mirrors.get(url);
  if (v === "hang") return new Promise((_, no) => init.signal.addEventListener("abort", () => no(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  if (v instanceof Error) throw v;
  if (v === undefined) return new Response("", { status: 404 });
  return new Response(typeof v === "string" ? v : JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
};
const publish = (base, signed) => mirrors.set(base + "/" + P.policyDigest(JSON.parse(signed.document)) + ".json", signed);
const anchor = (signed) => { const a = P.encodeAnchor(P.policyDigest(JSON.parse(signed.document))); chain.hi = a.hi; chain.lo = a.lo; chain.block++; };
const reg = async (reader, hosts = Object.keys(H).map((k) => row(k))) => ({ snap: await reader.snapshot(), hosts, registry: REGISTRY });
const fresh = (o = {}) => { mirrors.clear(); HP._setForTests({ vendorModule: V, fetchImpl: mirrorFetch, store: null, ...o }); return newReader(); };
const decision = (p, k) => p.byId.get(hostId(H[k]).toLowerCase());

test("the committed bundle is a fresh build of the unmodified shared modules; the page imports no Node built-ins", async () => {
  const { js, manifest } = await buildHostPolicyVendor();
  assert.equal(Buffer.compare(fs.readFileSync(path.join(REPO, "site/vendor/host-policy.js")), js), 0, "rebuild: node scripts/build-host-policy-vendor.mjs");
  const committed = JSON.parse(fs.readFileSync(path.join(REPO, "site/vendor/host-policy.MANIFEST.json"), "utf8"));
  assert.equal(committed.sha256, manifest.sha256);
  for (const [p, v] of Object.entries(manifest.sources)) assert.equal(committed.sources[p]?.sha256, v.sha256, p);
  assert.deepEqual(Object.keys(manifest.sources).sort(), ["network/host-policy-mirrors.mjs", "network/platform-host-policy.mjs"], "the frozen core only");
  const src = fs.readFileSync(path.join(REPO, "site/js/core/host-policy.js"), "utf8");
  assert.doesNotMatch(src, /node:|from "crypto"/);
  assert.equal(HP.PLATFORM_REGISTRY, JSON.parse(fs.readFileSync(path.join(REPO, "contracts/deployments/contract-pins-base.json"), "utf8")).contracts.registry.toLowerCase());
});

test("core v3: 'authority' is a confirmed refusal (sticky here), 'authority-unread' and other undecided states are not", async () => {
  assert.ok(HP.STICKY_STATUSES.includes("authority"));
  for (const s of ["authority-unread", "behind", "anchor", "unavailable", "unchecked", "not-activated"]) assert.ok(!HP.STICKY_STATUSES.includes(s), s);
  // the committed bundle is v3: facts without the current owner are UNREAD authority, not a confirmed invalidation
  const r = fresh(), s = await sign(admin, doc({ sequence: 50 })); publish("https://policy-a.example", s); anchor(s);
  await HP.policyDecisions(r, await reg(r));                     // accept it once through the page
  // a gate over the same scripted chain that has ACCEPTED the policy (refresh), judging facts that omit the owner
  const snapshot = async (fn) => { const snap = await r.snapshot(); return fn({ block: snap.number,
    call: async (address, abi, functionName, args = []) => V.decodeFunctionResult({ abi, functionName, data: await r.call(snap, address, V.encodeFunctionData({ abi, functionName, args })) }),
    code: (x) => r.code(snap, x) }); };
  const g = V.createPlatformHostGate({ book: BOOK, hostOwnership: OWN, snapshot, mirrors: [async () => [s]] });
  await g.refresh();
  const a = P.encodeAnchor(P.policyDigest(JSON.parse(s.document))), host = { registryId: hostId(H.good), operator: OP.good, active: true };
  assert.equal(g.decideHost(host, { anchorHi: a.hi, anchorLo: a.lo }).status, "authority-unread", "unread authority is undecided");
  assert.equal(g.decideHost(host, { anchorHi: a.hi, anchorLo: a.lo, owner: admin2.address.toLowerCase(), ownerIsContract: false }).status, "authority", "a confirmed other owner");
  assert.equal(g.decideHost(host, { anchorHi: a.hi, anchorLo: a.lo, owner: admin.address.toLowerCase(), ownerIsContract: false }).admit, true);
  assert.match(fs.readFileSync(path.join(REPO, "site/vendor/host-policy.js"), "utf8"), /authority-unread/);
});

test("modes: the platform network enforces by default (production constants), a profile field configures any book, others are off", async () => {
  const bare = { ...profile, hostPolicy: undefined };
  assert.deepEqual(HP.hostPolicyMode(validateProfile(profile)), { mode: "enforce", source: "profile", book: BOOK, hostOwnership: OWN,
    mirrors: profile.hostPolicy.mirrors, activation: "anchor" });
  assert.equal(HP.hostPolicyMode(validateProfile(bare)).mode, "off");
  const prod = HP.hostPolicyMode(validateProfile({ ...bare, addressBook: HP.PLATFORM_BOOK }));
  assert.deepEqual(prod, { mode: "enforce", source: "production default", book: HP.PLATFORM_BOOK, hostOwnership: HP.PLATFORM_HOST_OWNERSHIP, mirrors: [], activation: "anchor" });
  assert.equal(HP.hostPolicyMode(validateProfile({ ...bare, addressBook: undefined, contractPins: { ...profile.contractPins,
    contracts: { ...profile.contractPins.contracts, registry: HP.PLATFORM_REGISTRY } } })).source, "production default", "a fixed production profile too");
  // the production constants are network/platform-host-policy-config.mjs's (the site does not import that module)
  const cfgPath = [path.join(REPO, "network/platform-host-policy-config.mjs"), path.join(REPO, "../testref/platform-host-policy-config.mjs")].find((f) => fs.existsSync(f));
  assert.ok(cfgPath, "the production policy config module is available to compare with");
  const C = await import(pathToFileURL(cfgPath).href);
  assert.equal(HP.PLATFORM_BOOK, C.PRODUCTION_BOOK); assert.equal(HP.PLATFORM_HOST_OWNERSHIP, C.PRODUCTION_HOST_OWNERSHIP);
  assert.deepEqual([...HP.PLATFORM_MIRRORS], [...C.PRODUCTION_MIRRORS]);
  const G = await import(pathToFileURL(path.join(REPO, "scripts/network/browser-profile.mjs")).href);
  assert.equal(G.PLATFORM_BOOK, C.PRODUCTION_BOOK); assert.equal(G.PLATFORM_HOST_OWNERSHIP, C.PRODUCTION_HOST_OWNERSHIP);
  // the profile field binds the policy to the profile's own book; mirrors follow the shared rules; activation anchor|required
  assert.equal(validateProfile(profile).hostPolicy.book, BOOK);
  assert.equal(validateProfile({ ...profile, hostPolicy: { ...profile.hostPolicy, activation: "required" } }).hostPolicy.activation, "required");
  assert.throws(() => validateProfile({ ...profile, hostPolicy: { ...profile.hostPolicy, activation: "never" } }), /activation/);
  assert.throws(() => validateProfile({ ...profile, hostPolicy: { ...profile.hostPolicy, book: OTHER_BOOK } }), /own address book/);
  assert.throws(() => validateProfile({ ...profile, hostPolicy: { ...profile.hostPolicy, mirrors: [] } }), /hostPolicy\.host policy mirrors/);
  assert.throws(() => validateProfile({ ...profile, hostPolicy: { ...profile.hostPolicy, mirrors: ["http://policy.example"] } }), /hostPolicy\./);
  assert.throws(() => validateProfile({ ...profile, hostPolicy: { mirrors: profile.hostPolicy.mirrors } }), /hostOwnership/);
  assert.throws(() => validateProfile({ ...profile, addressBook: undefined }), /hostPolicy needs an address book/);
});
test("anchored policy: an admitted host is admitted, a banned one refused even when live, at the registry read's own block", async () => {
  const r = fresh();
  const s = await sign(admin, doc());
  publish("https://policy-a.example", s); anchor(s);
  const p = await HP.policyDecisions(r, await reg(r));
  assert.equal(p.mode, "enforce"); assert.equal(p.unavailable, null); assert.equal(p.sequence, 1);
  assert.equal(decision(p, "good").admit, true);
  assert.equal(decision(p, "bad").admit, false); assert.match(decision(p, "bad").reason, /banned by platform policy #1 \(operator\): malware distribution/);
  assert.equal(decision(p, "off"), undefined, "an inactive registration is not judged (nor offered)");
  // liveness never grants admission: the banned host is live (fresh registry write and a signed record) and still refused
  const evidence = { signedUntil: new Map([[hostId(H.bad), Date.now() + 60_000]]), byHost: new Map() };
  const q = IC.quoteHosts(Object.keys(H).map((k) => row(k)), { chainNow: Math.floor(Date.now() / 1000), gpuMilli: 0, cpuMilli: 100, evidence, policy: p });
  const by = Object.fromEntries(q.hosts.map((h) => [h.endpoint, h]));
  assert.equal(by[H.good].eligible, true);
  assert.equal(by[H.bad].eligible, false); assert.match(by[H.bad].reason, /refused by the platform host policy: banned/);
  assert.deepEqual(IC.liveHosts(Object.keys(H).map((k) => row(k)), Math.floor(Date.now() / 1000), { evidence, policy: p }).map((h) => h.endpoint).sort(), [H.fresh, H.good].sort());
  // the decision is bound to the book's registry at that block
  chain.registry = addr(0x777);
  try {
    const moved = await HP.policyDecisions(r, await reg(r));
    assert.match(moved.unavailable, /names registry 0x0000000000000000000000000000000000000777/);
    assert.equal(decision(moved, "good").admit, false);
  } finally { chain.registry = REGISTRY; }
});

test("a cold client refuses a withheld older policy, a torn anchor, a bad signature, a wrong book and a stale block; unanchored = not activated", async () => {
  const older = await sign(admin, doc({ sequence: 1, deny: [] })), newer = await sign(admin, doc({ sequence: 2, previousDigest: P.policyDigest(JSON.parse(older.document)) }));
  let r = fresh();
  publish("https://policy-a.example", older); anchor(newer);                        // the mirror withholds the anchored policy
  let p = await HP.policyDecisions(r, await reg(r));
  assert.match(p.unavailable, /anchored policy is not available from any mirror/); assert.equal(decision(p, "good").admit, false);
  r = fresh(); chain.hi = addr(0); chain.block++;                                    // torn: one half
  p = await HP.policyDecisions(r, await reg(r)); assert.match(p.unavailable, /torn/);
  r = fresh(); const forged = await sign(mallory, doc()); publish("https://policy-a.example", forged); anchor(forged);
  p = await HP.policyDecisions(r, await reg(r)); assert.match(p.unavailable, /not available from any mirror, or does not verify/);
  r = fresh(); const wrongBook = await sign(admin, doc({ book: OTHER_BOOK })); publish("https://policy-a.example", wrongBook); anchor(wrongBook);
  p = await HP.policyDecisions(r, await reg(r)); assert.match(p.unavailable, /does not verify/);
  r = fresh(); const ok = await sign(admin, doc()); publish("https://policy-a.example", ok); anchor(ok); chain.ageSec = 300;   // within the reader's 600 s, beyond the policy's 120 s
  p = await HP.policyDecisions(r, await reg(r)); assert.match(p.unavailable, /only agree on an old block/); chain.ageSec = 0;
  // activation: an unanchored book is "not activated" (admit as today, said so); with activation "required" it refuses
  r = fresh(); chain.hi = addr(0); chain.lo = addr(0); chain.block++;
  p = await HP.policyDecisions(r, await reg(r));
  assert.equal(p.notActivated, true); assert.equal(decision(p, "good").admit, true); assert.equal(decision(p, "good").status, "not-activated");
  assert.equal(decision(p, "bad").admit, true, "no policy is in force before the admin anchors one");
  assert.match(HP.policyNote(p), /not activated yet/);
  r = fresh({ profile: validateProfile({ ...profile, hostPolicy: { ...profile.hostPolicy, activation: "required" } }) });
  p = await HP.policyDecisions(r, await reg(r)); assert.equal(decision(p, "good").admit, false); assert.match(p.unavailable, /no policy is anchored/);
});

test("ban takes effect for an open view; an RPC or mirror failure afterwards never re-admits; an anchored unban resumes", async () => {
  const r = fresh();
  const v1 = await sign(admin, doc({ deny: [] })); publish("https://policy-a.example", v1); anchor(v1);
  const id = hostId(H.good);
  assert.equal((await HP.assertHostAdmitted(r, id)).admit, true);
  // the admin bans `good` (sequence 2), and the page that admitted it acts again
  const v2 = await sign(admin, doc({ sequence: 2, previousDigest: P.policyDigest(JSON.parse(v1.document)), deny: [{ kind: "registryId", value: id, reason: "phishing" }] }));
  publish("https://policy-a.example", v2); anchor(v2);
  await assert.rejects(HP.assertHostAdmitted(r, id), /banned by platform policy #2 \(registryId\): phishing/);
  // now every RPC and mirror fails: still refused, with the known ban named
  chain.down = new Set(profile.rpcs); mirrors.clear();
  await assert.rejects(HP.assertHostAdmitted(r, id), /phishing \(still refused: platform host policy unavailable/);
  chain.down = new Set();
  // a majority-disagreeing poisoned RPC cannot lift it either
  chain.poison = { hi: addr(0), lo: addr(0) };
  await assert.rejects(HP.assertHostAdmitted(r, id), /phishing/);
  chain.poison = null;
  // the anchored unban (sequence 3) resumes
  const v3 = await sign(admin, doc({ sequence: 3, previousDigest: P.policyDigest(JSON.parse(v2.document)), deny: [] }));
  publish("https://policy-b.example", v3); anchor(v3);
  assert.equal((await HP.assertHostAdmitted(r, id)).admit, true);
  // and the persisted floor refuses a book that later anchors an older policy (rollback)
  const st = mem(); HP._setForTests({ vendorModule: V, fetchImpl: mirrorFetch, store: { load: () => st.getItem("p"), save: (v) => st.setItem("p", v) } });
  publish("https://policy-b.example", v3); publish("https://policy-a.example", v1);
  const r2 = newReader();
  assert.equal(decision(await HP.policyDecisions(r2, await reg(r2)), "good").admit, true);
  anchor(v1);
  assert.match((await HP.policyDecisions(r2, await reg(r2))).unavailable, /older policy/);
});

test("authority: an owner rotation retires the old key's documents; an ERC-1271 owner is asked at the same block", async () => {
  let r = fresh();
  const s1 = await sign(admin, doc()); publish("https://policy-a.example", s1); anchor(s1);
  assert.equal(decision(await HP.policyDecisions(r, await reg(r)), "good").admit, true);
  chain.owner = admin2.address.toLowerCase(); chain.block++;                 // the two-step handoff completed
  r = fresh(); publish("https://policy-a.example", s1);
  assert.match((await HP.policyDecisions(r, await reg(r))).unavailable, /does not verify/);
  const s2 = await sign(admin2, doc({ sequence: 2 })); publish("https://policy-a.example", s2); anchor(s2);
  assert.equal(decision(await HP.policyDecisions(r, await reg(r)), "good").admit, true);
  // a contract owner: whatever it answers at the agreed block
  const wallet = addr(0x5afe), s3 = await sign(admin2, doc({ sequence: 3 }));
  chain.owner = wallet; chain.ownerCode = "0x6080"; chain.valid1271 = new Set([P.policyDigest(JSON.parse(s3.document)) + ":" + s3.signature]);
  r = fresh(); publish("https://policy-a.example", s3); anchor(s3);
  assert.equal(decision(await HP.policyDecisions(r, await reg(r)), "good").admit, true);
  chain.valid1271 = new Set(); r = fresh(); publish("https://policy-a.example", s3); chain.block++;
  assert.match((await HP.policyDecisions(r, await reg(r))).unavailable, /does not verify/);
  chain.owner = admin.address.toLowerCase(); chain.ownerCode = "0x";
});

test("same-block authority on a CACHED acceptance: rotation / ERC-1271 withdrawal refuse, an RPC failure keeps it refused, a valid re-signature resumes", async () => {
  const r = fresh(), id = hostId(H.good).toLowerCase();
  const d20 = doc({ sequence: 20 }), s = await sign(admin, d20); publish("https://policy-a.example", s); anchor(s);
  assert.equal(decision(await HP.policyDecisions(r, await reg(r)), "good").admit, true);
  // the book's two-step handoff completes; the anchor and this tab's accepted policy are unchanged
  chain.owner = admin2.address.toLowerCase(); chain.block++;
  let p = await HP.policyDecisions(r, await reg(r));
  assert.match(p.unavailable, /not signed by the address book's current owner at this block/);
  assert.equal(decision(p, "good").admit, false); assert.equal(decision(p, "good").status, "authority");
  await assert.rejects(HP.assertHostAdmitted(r, id), /not signed by the address book's current owner/);
  // RPC loss after the CONFIRMED authority failure: still refused, the confirmed reason kept
  chain.down = new Set(profile.rpcs);
  await assert.rejects(HP.assertHostAdmitted(r, id), /current owner.*\(still refused: platform host policy unavailable/);
  chain.down = new Set();
  // the current owner re-signs the SAME document (same digest, no anchor write): admission resumes
  publish("https://policy-a.example", await sign(admin2, d20)); chain.block++;
  assert.equal((await HP.assertHostAdmitted(r, id)).admit, true);
  assert.equal(decision(await HP.policyDecisions(r, await reg(r)), "good").admit, true);
  // a contract owner that approves the signature, then withdraws the approval without touching the anchor
  const wallet = addr(0x5afe), d21 = doc({ sequence: 21 }), s2 = await sign(admin2, d21), key = P.policyDigest(d21) + ":" + s2.signature;
  chain.owner = wallet; chain.ownerCode = "0x6080"; chain.valid1271 = new Set([key]);
  publish("https://policy-a.example", s2); anchor(s2);
  assert.equal(decision(await HP.policyDecisions(r, await reg(r)), "good").admit, true);
  chain.valid1271 = new Set(); chain.block++;
  p = await HP.policyDecisions(r, await reg(r));
  assert.equal(decision(p, "good").admit, false); assert.equal(decision(p, "good").status, "authority");
  chain.down = new Set(profile.rpcs);
  await assert.rejects(HP.assertHostAdmitted(r, id), /still refused/);
  chain.down = new Set();
  chain.valid1271 = new Set([key]); chain.block++;                       // the contract approves it again
  assert.equal((await HP.assertHostAdmitted(r, id)).admit, true);
  chain.owner = admin.address.toLowerCase(); chain.ownerCode = "0x"; chain.valid1271 = new Set();
});
test("a delayed admit judged at an OLDER block never lifts a newer refusal; a newer authenticated admit does", async () => {
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  let slowBlock = -1;
  const r = fresh({ delay: async (snap) => { if (Number(snap.number) === slowBlock) await sleep(400); } });
  const s = await sign(admin, doc({ sequence: 30, deny: [] })); publish("https://policy-a.example", s); anchor(s);
  const id = hostId(H.good).toLowerCase();
  assert.equal(decision(await HP.policyDecisions(r, await reg(r)), "good").admit, true);
  const old = await reg(r); slowBlock = Number(old.snap.number);
  try {
    const slow = HP.policyDecisions(r, old);                     // at the older block the host is active and admitted...
    chain.hosts[id].off = [[chain.block + 1, Infinity]]; chain.block++;   // ...but it is deactivated at a newer block
    await assert.rejects(HP.assertHostAdmitted(r, id), /host registry entry is not active/);
    const late = await slow;
    assert.equal(decision(late, "good").admit, false, "the slow, older admit does not resurrect the host");
    assert.match(decision(late, "good").reason, /refused at block \d+; an admit judged at block \d+ does not lift it/);
    await assert.rejects(HP.assertHostAdmitted(r, id), /not active/);
    chain.hosts[id].off[0][1] = chain.block + 1; chain.block++;   // re-activated at a newer block: a newer authenticated admit
    assert.equal((await HP.assertHostAdmitted(r, id)).admit, true);
  } finally { delete chain.hosts[id].off; }
});

test("mirrors: one failing leaves another usable; malformed, oversized or hanging answers end in a bounded unavailable state", async () => {
  let r = fresh();
  const s = await sign(admin, doc({ sequence: 9 })); anchor(s);
  const name = "/" + P.policyDigest(JSON.parse(s.document)) + ".json";
  mirrors.set("https://policy-a.example" + name, new TypeError("Failed to fetch")); mirrors.set("https://policy-b.example" + name, s);
  assert.equal(decision(await HP.policyDecisions(r, await reg(r)), "good").admit, true);
  r = fresh(); mirrors.set("https://policy-a.example" + name, "{not json"); mirrors.set("https://policy-b.example" + name, "x".repeat(300 * 1024));
  assert.match((await HP.policyDecisions(r, await reg(r))).unavailable, /not available from any mirror/);
  r = fresh({ limits: { MIRROR_TIMEOUT_MS: 150, REFRESH_BUDGET_MS: 400, DECIDE_BUDGET_MS: 2000 } });
  mirrors.set("https://policy-a.example" + name, "hang"); mirrors.set("https://policy-b.example" + name, "hang");
  const t0 = Date.now(), p = await HP.policyDecisions(r, await reg(r));
  assert.ok(Date.now() - t0 < 2500, "ended in " + (Date.now() - t0) + " ms");
  assert.ok(p.unavailable); assert.equal(decision(p, "good").admit, false);
  assert.match(HP.policyNote(p), /No host can be selected or managed until it is/);
});

test("the platform network without a profile field: production default - not activated while unanchored, refusing an anchored policy no mirror carries", async () => {
  // the scripted chain serves the platform book from BOOK's state; the policy binds the production book and extension
  const remap = (fn) => async (u, m, p) => { if (m === "eth_call" && p[0].to.toLowerCase() === HP.PLATFORM_BOOK) p = [{ ...p[0], to: BOOK }, p[1]]; return fn(u, m, p); };
  const platformReader = () => createQuorumReader({ rpcs: profile.rpcs, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 600, chainId: 8453, rpc: remap(rpc) });
  const legacy = validateProfile({ ...profile, hostPolicy: undefined, addressBook: HP.PLATFORM_BOOK });
  fresh({ profile: legacy });
  let r = platformReader();
  chain.hi = addr(0); chain.lo = addr(0); chain.block++;
  let p = await HP.policyDecisions(r, await reg(r));
  assert.equal(p.source, "production default"); assert.equal(p.notActivated, true); assert.equal(decision(p, "good").admit, true);
  const prod = { book: HP.PLATFORM_BOOK, hostOwnership: HP.PLATFORM_HOST_OWNERSHIP };
  const d = doc({ ...prod, sequence: 40 }), signed = await sign(admin, d); anchor(signed);
  p = await HP.policyDecisions(r, await reg(r));            // the production mirrors are not published yet: nothing can load it
  assert.equal(decision(p, "good").admit, false); assert.match(p.unavailable, /not available from any mirror/);
  await assert.rejects(HP.assertHostAdmitted(r, hostId(H.good)), /not available from any mirror/);
  // a profile that adds a mirror for the platform book loads it, against the production book and extension
  fresh({ profile: validateProfile({ ...profile, addressBook: HP.PLATFORM_BOOK, hostPolicy: { ...profile.hostPolicy, hostOwnership: HP.PLATFORM_HOST_OWNERSHIP } }) });
  r = platformReader(); publish("https://policy-a.example", signed);
  p = await HP.policyDecisions(r, await reg(r));
  assert.equal(decision(p, "good").admit, true); assert.equal(decision(p, "bad").admit, false);
  // another network's profile without the field: off, every call admits and says so
  HP._setForTests({ vendorModule: V, profile: validateProfile({ ...profile, hostPolicy: undefined }) });
  assert.equal((await HP.policyDecisions(r, await reg(r))).mode, "off");
  assert.equal((await HP.assertHostAdmitted(r, hostId(H.bad))).status, "off");
});
test("management: a lease whose runner the policy refuses is never contacted (nothing fetched, nothing signed)", async () => {
  const M = await import(pathToFileURL(path.join(REPO, "site/js/core/independent-management.js")).href);
  const fetched = [];
  const runner = hostId(H.bad).toLowerCase(), wallet = addr(0xabc), vault = addr(0xdef);
  M._useForTests({ deps: { agreedLease: async () => ({ current: true, lease: { id: "0x" + "11".repeat(32), owner: wallet, runner, runnerOperator: OP.bad,
      active: true, leaseUntil: Date.now() + 600_000, blockNumber: "100" } }),
    session: async () => ({ owner: wallet, session: { handle: { vault } } }), sdk: async () => ({}), wallet: () => wallet, owner: () => wallet,
    origin: () => "https://dash.example", fetch: async (u) => { fetched.push(u); throw new Error("must not be called"); },
    leaseHostPolicy: async (lease) => ({ admit: false, status: "current", reason: "banned by platform policy #4 (operator): malware distribution" }) } });
  await assert.rejects(M.resolveEndpoint("0x" + "11".repeat(32), "status"), (e) => /platform host policy refuses this deployment's host: banned by platform policy #4/.test(e.message) && /Nothing was sent/.test(e.message) && e.kind === "policy");
  assert.deepEqual(fetched, []);
});
