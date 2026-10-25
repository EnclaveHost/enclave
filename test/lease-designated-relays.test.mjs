// DESIGNATED lease relays on Enclave hosts, found through the pinned EnclaveServiceIndex by a compute host that has NO ETH
// and NO relay of its own (no LOCAL_RELAY, no configured RELAYS), with every DigitalOcean endpoint down. On a real local
// chain (anvil; the reserve/executor/ledger world; the ownerless index compiled from the reviewed source):
//   - two relay operators each run the PACKAGED lease-relay host role (scripts/build-lease-relay-host-package.mjs, pinned
//     manifest) under network/host-services/lease-relay-host.mjs: `init` generates the key on the host, `descriptor` +
//     a `relay` advertisement publish it, `run` supervises the relay; each operator funds its own capped float;
//   - the index also holds a relay ad at a DigitalOcean address (refused at the transport, and excluded by RELAY_EXCLUDE),
//     and an IMPOSTOR ad that points at relay A's endpoint under another operator's descriptor;
//   - main's ACTUAL Windows chain module claims, renews and releases an app-funded deployment through the designated relays:
//     cold (empty caches), relay A lost before the renewal, and with both lost it fails NotRelayed within a bound, sending
//     nothing; an administrator's operator ban removes a relay; package and configuration integrity refuse tampering.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as viem from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startWorld, haveAnvil, DEPLOYER } from "./helpers/lease-gas-world.mjs";
import { compileServiceIndex } from "../scripts/network/service-index.mjs";
import * as si from "../network/service-index.mjs";
import { discoverLeaseRelays } from "../network/lease-relay-discovery.mjs";
import { initRelayKey, writeRelayDescriptor, relayAdvertisement, runHostRelay, planHostRelay, validateHostRelayConfig } from "../network/host-services/lease-relay-host.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostUrl = new URL("../windows/node/chain.mjs", import.meta.url).href;
const fixtureUrl = new URL("./helpers/windows-lease-runtime-fixture.mjs", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(hostUrl) && specifier === "./lease-gas-runtime.bundle.mjs") return { url: fixtureUrl, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const T = { skip: !haveAnvil && "needs anvil", timeout: 300_000 };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const DO = ["134.199.235.187", "134.209.248.172", "165.245.191.129", "146.190.246.39"];
// stand-in PUBLIC addresses for the relay hosts (mapped to their loopback listeners); the fleet's are refused, as in a
// whole-provider outage
const PUBLIC = { a: "9.9.9.9", b: "149.112.112.112", impostor: "1.1.1.1" };
const savedEnv = { ...process.env }, realFetch = globalThis.fetch;
let W, dir, ca, pkgDir, pkgPin, index, indexPin, record, digest, hostRpcs, relayRpcs, relays = {}, ports = {}, op, owner, chain, hostSettings;
const POLICY0 = { banned: [], allow: null, mode: "current" };
let policyState = { ...POLICY0 }, policyCalls = 0;
// an operator decider answering exactly as network/platform-host-policy.mjs judgeHost / host-policy-runtime do: bans, then
// allowlist mode; mode "not-activated" (no anchored policy: the deliberate admit), "throw" (on but unusable), "behind" (this
// node has not loaded the anchored policy), "missing" (no decision returned)
const decideOperators = async (operators) => {
  policyCalls++;
  if (policyState.mode === "throw") throw new Error("platform host policy RPC quorum unavailable");
  return Object.fromEntries(operators.map((o) => [o.toLowerCase(),
    policyState.mode === "missing" ? undefined
      : policyState.mode === "behind" ? { admit: false, status: "behind", reason: "this node has not loaded the policy the book anchors at this block" }
      : policyState.banned.includes(o.toLowerCase()) ? { admit: false, status: "current", reason: "banned by platform policy #1 (operator): test ban" }
      : policyState.allow && !policyState.allow.includes(o.toLowerCase()) ? { admit: false, status: "current", reason: "not admitted by platform allowlist #2" }
      : policyState.mode === "not-activated" ? { admit: true, status: "not-activated", reason: "the platform host policy is not activated (the admin has anchored no policy)" }
      : { admit: true, status: "current", reason: null }]));
};
const fetchLog = [], leasePosts = [];
const servers = [];

async function tlsProxy() {
  const s = https.createServer({ key: fs.readFileSync(path.join(dir, "leaf.key")), cert: fs.readFileSync(path.join(dir, "leaf.pem")) }, (req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
      const up = http.request(W.rpcUrl, { method: "POST", headers: { "content-type": "application/json" } }, (r) => { res.writeHead(r.statusCode, { "content-type": "application/json" }); r.pipe(res); });
      up.on("error", () => { res.writeHead(502); res.end(); }); up.end(Buffer.concat(chunks)); }); });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok)); servers.push(s);
  return `https://127.0.0.1:${s.address().port}`;
}
async function httpProxy() {
  const s = http.createServer((req, res) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", async () => {
    const r = await realFetch(W.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) });
    res.writeHead(r.status, { "content-type": "application/json" }); res.end(await r.text()); }); });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok)); servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const gateOf = (state) => ({ check: async () => {}, start() {}, stop() {}, serviceRefusal: () => state.refusal, status: () => ({ platformHostPolicy: "test", refusal: state.refusal }) });

function relayHostConfig(name, port) {
  return { format: "enclave-host-relay/v1", host: { endpoint: `https://relay-${name}.placement-test.net`, publicEndpoints: [`http://${PUBLIC[name]}:${port}/`] },
    platformHostPolicy: "production", serviceIndex: indexPin, packagesDir: pkgDir, stateRoot: path.join(dir, `relay-host-${name}`),
    relay: { package: pkgPin, memoryMiB: 192, port, bind: "127.0.0.1", record, digest, rpc: relayRpcs, quorum: 2, maxFloatEth: "0.02", minFloatEth: "0.001", extraCaFile: ca } };
}
/** a designated relay operator: init the host's key, fund its float, write and publish its advertisement, run the role */
async function designatedRelay(name) {
  const port = ports[name] = await freePort();
  const cfg = relayHostConfig(name, port), operatorKey = generatePrivateKey(), operator = privateKeyToAccount(operatorKey);
  const k = await initRelayKey(cfg);
  assert.equal(k.created, true);
  await W.fund(k.address, 10n ** 16n);                     // the relay operator's capped float (fixture money)
  await W.fund(operator.address, 10n ** 16n);              // gas for the operator's own advertisement transaction
  const d = await writeRelayDescriptor(cfg, { operator: operator.address });
  const ad = await relayAdvertisement(cfg, { operator: operator.address, slot: 0, sequence: "1" });
  const m = ad.typedData.message;
  await W.write(operatorKey, index, si.SERVICE_INDEX_ABI, "publish", [m.slot, m.kind, m.version, m.sequence, m.expiresAt, m.descriptor, m.endpoints]);
  const state = { refusal: null }, logs = [];
  const running = await runHostRelay(cfg, { gate: gateOf(state), log: (x) => logs.push(x), intervalMs: 300 });
  const end = Date.now() + 60_000;
  while (!(await realFetch(`http://127.0.0.1:${port}/v1/info`).then((r) => r.ok, () => false))) { if (Date.now() > end) throw new Error(`relay ${name} did not start: ${logs.join("\n")}`); await new Promise((ok) => setTimeout(ok, 200)); }
  return { name, cfg, payee: k.address, operator: operator.address, operatorKey, descriptor: d, running, state, logs };
}
async function loadHost(settings, { setPolicy = true } = {}) {
  for (const key of Object.keys(process.env)) if (/^(ENCLAVE_)?LEASE_GAS_/.test(key)) delete process.env[key];
  Object.assign(process.env, settings, { BASE_RPCS: W.rpcUrl, NODE_OPERATOR_KEY: op.key });
  const c = await import(hostUrl + "?designated=" + Math.random());
  c.loadOperator(); c.setLeaseJournal(path.join(dir, `journal-${Math.random()}.json`));
  c.addresses.deployments = W.addr.ledger; c.addresses.registry = W.addr.registry;
  // the host's platform host policy decides relay operators (test policy: policyState, judged as judgeHost does)
  if (setPolicy) c.setLeaseRelayPolicy(decideOperators);
  return c;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "designated-relays-"));
  pkgDir = path.join(dir, "packages");
  const built = JSON.parse(execFileSync(process.execPath, [path.join(REPO, "scripts/build-lease-relay-host-package.mjs"), pkgDir], { encoding: "utf8", timeout: 120_000 }).trim().split("\n").at(-1));
  pkgPin = built.package;
  if (!haveAnvil) return;
  W = await startWorld();
  await W.write(DEPLOYER, W.addr.ledger, W.A.ledger.abi, "setLeaseSec", [120n]);
  for (const args of [["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "ca.key"), "-out", path.join(dir, "ca.pem"), "-days", "2", "-subj", "/CN=designated-relays-test-ca"],
    ["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "leaf.key"), "-out", path.join(dir, "leaf.csr"), "-subj", "/CN=127.0.0.1"]])
    execFileSync("openssl", args, { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
  execFileSync("openssl", ["x509", "-req", "-in", path.join(dir, "leaf.csr"), "-CA", path.join(dir, "ca.pem"), "-CAkey", path.join(dir, "ca.key"), "-CAcreateserial", "-out", path.join(dir, "leaf.pem"), "-days", "2", "-extfile", path.join(dir, "ext.cnf")], { stdio: "ignore" });
  ca = path.join(dir, "ca.pem");
  relayRpcs = [await tlsProxy(), await tlsProxy(), await tlsProxy()];
  hostRpcs = [await httpProxy(), await httpProxy()];
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, W.addr[k]])) }));
  record = path.join(dir, "deployment.json"); fs.writeFileSync(record, bytes); digest = "sha256:" + sha(bytes);
  const c = compileServiceIndex();
  index = await W.deploy({ abi: c.abi, bytecode: c.bytecode, links: {} });
  indexPin = si.validateIndexPin({ chainId: 8453, address: index, codeHash: c.codeHash });
  // the network as the compute host sees it: fleet addresses refused, stand-in public addresses reach the relay hosts
  globalThis.fetch = (url, opts) => {
    const u = new URL(url); fetchLog.push(u.hostname);
    if (u.pathname === "/v1/lease" && opts?.method === "POST") leasePosts.push(u.hostname);
    if (DO.includes(u.hostname)) return Promise.reject(new TypeError("connect ECONNREFUSED (DigitalOcean down)"));
    if (Object.values(PUBLIC).includes(u.hostname)) { u.hostname = "127.0.0.1"; return realFetch(u, opts); }
    return realFetch(url, opts);
  };
  relays.a = await designatedRelay("a");
  relays.b = await designatedRelay("b");
  // a relay ad at a fleet address, and an impostor: another operator's ad whose endpoint reaches relay A
  const fleetKey = generatePrivateKey(), impostorKey = generatePrivateKey();
  await W.fund(privateKeyToAccount(fleetKey).address, 10n ** 16n); await W.fund(privateKeyToAccount(impostorKey).address, 10n ** 16n);
  const until = (await W.pc.getBlock()).timestamp + 30n * 86400n;
  await W.write(fleetKey, index, si.SERVICE_INDEX_ABI, "publish", [0, si.SERVICE_KINDS.relay, si.AD_VERSION, 1n, until, "0x" + "11".repeat(32), DO.map((ip) => `http://${ip}:8549/`)]);
  await W.write(impostorKey, index, si.SERVICE_INDEX_ABI, "publish", [0, si.SERVICE_KINDS.relay, si.AD_VERSION, 1n, until, "0x" + "22".repeat(32), [`http://${PUBLIC.impostor}:${ports.a}/`]]);
  for (let i = 0; i < 3; i++) await W.rpc("evm_mine", []);           // the index is read two blocks below the head
  op = await W.operator("https://designated-relays.test");
  owner = await W.owner();
  await W.write(owner.key, W.addr.registry, W.A.registry.abi, "setPayoutWallet", [op.enclaveId]);
  // the compute host: no ETH, no relay of its own, no configured relay - only the pinned index and the excluded fleet
  hostSettings = { ENCLAVE_LEASE_GAS_FILE: record, ENCLAVE_LEASE_GAS_DIGEST: digest, ENCLAVE_LEASE_GAS_RPCS: hostRpcs.join(","),
    ENCLAVE_LEASE_GAS_SERVICE_INDEX: `${index}@${indexPin.codeHash}`, ENCLAVE_LEASE_GAS_RELAY_EXCLUDE: DO.join(",") };
  chain = await loadHost(hostSettings);
});
after(async () => {
  for (const r of Object.values(relays)) await r.running?.stop().catch(() => {});
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  W?.stop(); hooks.deregister(); globalThis.fetch = realFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("discovery: two designated relays verified; the fleet's ad excluded, the impostor rejected, an administrator's ban honoured", T, async () => {
  const clients = hostRpcs.map((u) => viem.createPublicClient({ chain: W.chain, transport: viem.http(u, { retryCount: 0, timeout: 4000 }) }));
  const pins = { chainId: 8453, reserve: W.addr.reserve, executor: W.addr.executor };
  const failureDomains = [{ name: "digitalocean", addresses: DO }];
  const decide = decideOperators;
  await W.rpc("evm_mine", []);
  const r = await discoverLeaseRelays({ clients, indexPin, pins, decide, failureDomains, fetch: globalThis.fetch });
  assert.deepEqual(r.relays.map((x) => x.payee), [relays.a.payee, relays.b.payee]);
  assert.deepEqual(r.relays.map((x) => x.origin), [`http://${PUBLIC.a}:${ports.a}`, `http://${PUBLIC.b}:${ports.b}`]);
  assert.equal(r.excluded.length, DO.length); assert.ok(r.excluded.every((e) => e.domain === "digitalocean"));
  assert.equal(r.rejected.length, 1); assert.match(r.rejected[0].reason, /descriptor does not match the advertisement/);
  assert.equal(r.policy, "applied");
  policyState.banned = [relays.b.operator.toLowerCase()];
  try {
    const banned = await discoverLeaseRelays({ clients, indexPin, pins, decide, failureDomains, fetch: globalThis.fetch });
    assert.deepEqual(banned.relays.map((x) => x.payee), [relays.a.payee], "the banned operator's relay is not used");
    assert.equal(banned.refusedByPolicy.length, 1); assert.match(banned.refusedByPolicy[0].reason, /^banned by platform policy/);
  } finally { policyState.banned = []; }
  for (const mode of ["throw", "behind", "missing"]) {
    policyState.mode = mode;
    try {
      const strict = await discoverLeaseRelays({ clients, indexPin, pins, decide, failureDomains, fetch: globalThis.fetch });
      assert.deepEqual(strict.relays, [], `policy ${mode}: no relay is admitted without an explicit admit`);
      assert.equal(strict.policy, mode === "throw" ? "unreadable" : "applied");
      assert.equal(strict.refusedByPolicy.length, 4, "every advertised operator refused (a, b, the fleet's, the impostor's)");
    } finally { policyState.mode = "current"; }
  }
  policyState.mode = "not-activated";
  try { assert.equal((await discoverLeaseRelays({ clients, indexPin, pins, decide, failureDomains, fetch: globalThis.fetch })).relays.length, 2, "not activated is the deliberate admit"); }
  finally { policyState.mode = "current"; }
  const off = await discoverLeaseRelays({ clients, indexPin, pins, failureDomains, fetch: globalThis.fetch });
  assert.equal(off.relays.length, 2); assert.equal(off.policy, "not applied");
  policyState.allow = [relays.a.operator.toLowerCase()];
  try {
    const listed = await discoverLeaseRelays({ clients, indexPin, pins, decide, failureDomains, fetch: globalThis.fetch });
    assert.deepEqual(listed.relays.map((x) => x.payee), [relays.a.payee], "in allowlist mode an unlisted operator serves no relay");
    assert.ok(listed.refusedByPolicy.some((x) => x.candidate.operator.toLowerCase() === relays.b.operator.toLowerCase()));
    assert.ok(listed.refusedByPolicy.every((x) => /^not admitted by platform allowlist/.test(x.reason)));
  } finally { policyState.allow = null; }
  assert.ok(!fetchLog.some((h) => DO.includes(h)), "no fleet address was ever contacted");
});

test("a ZERO-ETH host with no relay of its own: cold claim, relay A LOST, renew and release through relay B - each paid by the app's reserve", T, async () => {
  const id = await W.create(owner, { fund6: 0n });
  await W.enable(owner, id, { p: { claimPolicy: 1, renewWindow: 60, minExtension: 60 } });
  const from = await W.pc.getBlockNumber();
  const floats0 = { a: await W.pc.getBalance({ address: relays.a.payee }), b: await W.pc.getBalance({ address: relays.b.payee }) };
  await chain.claimDeployment(id, op.enclaveId);
  const row = await W.row(id);
  assert.equal(row.runnerOperator, op.address);
  // relay A is lost (its host stops the role); the next operations must go through relay B
  await relays.a.running.stop();
  const waitMs = Number(row.leaseUntil) * 1000 - 55_000 - Date.now();
  if (waitMs > 0) await new Promise((ok) => setTimeout(ok, waitMs));
  await W.rpc("evm_mine", []);                                         // a fresh head for the relay's own authority read
  await chain.renewDeployment(id);
  assert.ok((await W.row(id)).leaseUntil > row.leaseUntil, "renewed");
  await chain.releaseDeployment(id);
  assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/);
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n, "the compute host never held ETH");
  const paid = await W.pc.getContractEvents({ address: W.addr.reserve, abi: W.A.reserve.abi, eventName: "LeaseGasPaid", args: { id }, fromBlock: from });
  assert.deepEqual(paid.map((e) => Number(e.args.kind)), [1, 2, 3]);
  assert.equal(paid[0].args.payee, relays.a.payee, "the cold claim went through the first designated relay");
  assert.ok(paid.slice(1).every((e) => e.args.payee === relays.b.payee), "renew and release through relay B after A was lost");
  for (const e of paid) {
    const rc = await W.pc.getTransactionReceipt({ hash: e.transactionHash });
    assert.equal(rc.status, "success");
    console.log(`# ${["", "claim", "renew", "release"][Number(e.args.kind)]} ${e.transactionHash} block ${rc.blockNumber} paid ${e.args.chargedWei} wei to ${e.args.payee}`);
  }
  const floats1 = { a: await W.pc.getBalance({ address: relays.a.payee }), b: await W.pc.getBalance({ address: relays.b.payee }) };
  console.log(`# relay floats a ${floats0.a} -> ${floats1.a}, b ${floats0.b} -> ${floats1.b} (reimbursed in each transaction)`);
  assert.ok(floats1.a >= floats0.a * 99n / 100n && floats1.b >= floats0.b * 99n / 100n, "the operators' floats are reimbursed, not spent");
  assert.ok(!fetchLog.some((h) => DO.includes(h)), "no fleet address was ever contacted");
});

test("operator authority is judged at EVERY signature: the cached relay list never carries it; a fresh ban, an unusable or undecided policy refuse at once", T, async () => {
  // relay A is down (lost above); relay B is up. The host's discovery list (cached for minutes) still names both.
  const app = async () => { const id = await W.create(owner, { fund6: 0n }); await W.enable(owner, id, { p: { claimPolicy: 1, renewWindow: 60, minExtension: 60 } }); return id; };
  const refusedClaim = async (label, host = chain) => {
    const id = await app(), from = await W.pc.getBlockNumber(), posts = leasePosts.length, t0 = Date.now();
    await assert.rejects(host.claimDeployment(id, op.enclaveId), (e) => e.code === "NotRelayed" || /NotRelayed|no relay landed/.test(e.message), label);
    assert.ok(Date.now() - t0 < 60_000, `${label}: bounded`);
    assert.equal(leasePosts.length, posts, `${label}: no lease was sent to any relay`);
    assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/, `${label}: not claimed`);
    assert.equal((await W.pc.getContractEvents({ address: W.addr.reserve, abi: W.A.reserve.abi, eventName: "LeaseGasPaid", args: { id }, fromBlock: from })).length, 0, `${label}: nothing paid`);
  };
  const landedVia = async (label) => {
    const id = await app(), from = await W.pc.getBlockNumber();
    await chain.claimDeployment(id, op.enclaveId);
    const paid = await W.pc.getContractEvents({ address: W.addr.reserve, abi: W.A.reserve.abi, eventName: "LeaseGasPaid", args: { id }, fromBlock: from });
    assert.deepEqual(paid.map((e) => e.args.payee), [relays.b.payee], label);
    await chain.releaseDeployment(id);
  };
  try {
    await landedVia("admitted: relay B");                                   // the host's discovery list is now cached
    policyState.banned = [relays.b.operator.toLowerCase()];                  // a NEW ban, minutes before the cache expires
    await refusedClaim("a fresh ban of relay B's operator");
    policyState.banned = []; policyState.mode = "not-activated";              // unban (and no anchored policy): admitted at once
    await landedVia("not activated: the deliberate admit");
    for (const mode of ["throw", "behind", "missing"]) { policyState.mode = mode; await refusedClaim(`policy ${mode}`); }
    // the host's real shape: its policy GATE through the shared operatorDecider adapter, which refreshes once when behind
    const gate = { stale: true, refreshes: 0, refreshFails: true, async refresh() { this.refreshes++; if (this.refreshFails) throw new Error("mirror down"); this.stale = false; },
      async decideOperators(ops) { return Object.fromEntries(ops.map((o) => [o.toLowerCase(), gate.stale ? { admit: false, status: "behind", reason: "behind the anchor" } : { admit: true, status: "current", reason: null }])); } };
    chain.setLeaseRelayPolicy(gate);
    await refusedClaim("gate behind, its refresh failing");
    assert.ok(gate.refreshes >= 1, "the shared adapter attempted a refresh");
    gate.refreshFails = false;
    await landedVia("gate refreshed to the anchored policy");
    assert.equal(gate.stale, false);
    chain.setLeaseRelayPolicy(async () => { throw new Error("the platform host policy is on but unusable: no discovered relay is admitted"); });
    await refusedClaim("policy on but unusable (the hosts' fail-closed decider)");
    // a host module whose platform host policy was never set refuses discovered relays (off must be set explicitly)
    await refusedClaim("policy never set by the host", await loadHost(hostSettings, { setPolicy: false }));
  } finally { policyState = { ...POLICY0 }; chain.setLeaseRelayPolicy(decideOperators); }
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n, "never operator-paid");
});

test("both designated relays lost: the operation fails NotRelayed within a bound, nothing is sent, the host still holds no ETH", T, async () => {
  await relays.b.running.stop();
  const id = await W.create(owner, { fund6: 0n });
  await W.enable(owner, id, { p: { claimPolicy: 1, renewWindow: 60, minExtension: 60 } });
  const before = await W.pc.getBlockNumber(), t0 = Date.now();
  await assert.rejects(chain.claimDeployment(id, op.enclaveId), (e) => e.code === "NotRelayed" || /NotRelayed|no relay landed/.test(e.message));
  const took = Date.now() - t0;
  console.log(`# with every designated relay down the claim failed in ${took} ms`);
  assert.ok(took < 60_000, `bounded: ${took} ms`);
  assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/, "not claimed");
  const paid = await W.pc.getContractEvents({ address: W.addr.reserve, abi: W.A.reserve.abi, eventName: "LeaseGasPaid", args: { id }, fromBlock: before });
  assert.equal(paid.length, 0);
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n, "never operator-paid");
});

test("the packaged role: only the pinned bytes run, no key in configuration, the key is created once and never replaced", T, () => {
  const cfg = relays.a.cfg;
  assert.throws(() => planHostRelay({ ...cfg, relay: { ...cfg.relay, package: "sha256:" + "0".repeat(64) } }), /not the pinned/);
  assert.throws(() => validateHostRelayConfig({ ...cfg, relay: { ...cfg.relay, privateKey: "0x01" } }), /unknown field "privateKey" \(the key is generated by init, never configured\)/);
  assert.throws(() => validateHostRelayConfig({ ...cfg, relay: { ...cfg.relay, keyFile: "/tmp/k" } }), /never configured/);
  assert.throws(() => validateHostRelayConfig({ ...cfg, relay: { ...cfg.relay, rpc: [relayRpcs[0]] } }), /2 to 8 https/);
  assert.throws(() => validateHostRelayConfig({ ...cfg, platformHostPolicy: undefined }), /platformHostPolicy is required/);
  const plan = planHostRelay(cfg);
  assert.deepEqual(Object.keys(plan.env).sort(), ["LEASE_RELAY_DESCRIPTOR", "LEASE_RELAY_DIGEST", "LEASE_RELAY_KEY_FILE", "LEASE_RELAY_LISTEN", "LEASE_RELAY_MAX_FLOAT_ETH",
    "LEASE_RELAY_MIN_FLOAT_ETH", "LEASE_RELAY_QUORUM", "LEASE_RELAY_RECORD", "LEASE_RELAY_RPCS", "LEASE_RELAY_STATE", "NODE_EXTRA_CA_CERTS"]);
  const keyFile = plan.env.LEASE_RELAY_KEY_FILE, before = fs.readFileSync(keyFile);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(keyFile)).mode & 0o777, 0o700);
  return initRelayKey(cfg).then((again) => {
    assert.equal(again.created, false); assert.equal(again.address, relays.a.payee);
    assert.ok(fs.readFileSync(keyFile).equals(before), "init never replaces an existing key");
  });
});
