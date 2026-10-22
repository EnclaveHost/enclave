// A PINNED host-local lease relay end to end, on a real local chain (anvil; the reviewed reserve/executor/ledger world):
//   - the relay is the PACKAGED lease-relay host role (scripts/build-lease-relay-host-package.mjs, network/host-services/
//     lease-relay-host.mjs runHostRelay) holding a MOVED key (relay.key + relay.address placed by hand, as the eu-central
//     move does); it listens on the host's loopback;
//   - the compute host is ZERO-ETH and configures only that relay, pinned (origin, payee, registered operator):
//       Linux:   the shared factory exactly as supervisor.js builds it (loadLeaseGasConfig + configuredLeaseSender, policy
//                decider) at http://10.0.2.2:8549 - the control CVM's QEMU user-net view of the host's loopback;
//       Windows: main's ACTUAL Windows chain module (windows/node/chain.mjs over the lease runtime bundle built from this
//                tree) at http://192.168.8.249:8549 - warden's LAN address - with the DigitalOcean relay still configured;
//     both pinned origins are delivered to the relay's loopback listener by the test's fetch router (only the socket
//     address is substituted; the exact URL, method, body and redirect mode the client chose are what it sees);
//   - every DigitalOcean address is UNREACHABLE (refused at the transport, as in a whole-provider outage).
// Claim, renew and release are paid from the app's reserve (LeaseGasPaid to the moved payee), the hosts hold no ETH.
// Refused BEFORE ANY SIGNATURE (no lease signature, no EIP-7702 authorization, nothing POSTed): another payee, a forged,
// stale, other-chain or other-executor statement, a fresh ban, an unreadable or missing policy, policy off, a redirect.
// After signing: a relay's unverifiable receipt is not success (the durable journal entry stays pending), and a lost
// answer is settled from the chain. Fixture keys only. This is NOT a hardware/CVM proof: root's canary is.
// Run directly (node test/lease-pinned-relay.test.mjs): one process, the relay child and anvil.
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
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startWorld, haveAnvil, DEPLOYER } from "./helpers/lease-gas-world.mjs";
import { runHostRelay } from "../network/host-services/lease-relay-host.mjs";
import { loadLeaseGasConfig, configuredLeaseSender } from "../network/lease-gas-runtime.mjs";
import { relayStatementMessage, pinnedRelaysValue, validatePinnedRelay } from "../client/lease-executor-client.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostUrl = new URL("../windows/node/chain.mjs", import.meta.url).href;
const fixtureUrl = new URL("./helpers/windows-lease-runtime-fixture.mjs", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(hostUrl) && specifier === "./lease-gas-runtime.bundle.mjs") return { url: fixtureUrl, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const T = { skip: !haveAnvil && "needs anvil", timeout: 420_000 };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const DO = ["134.199.235.187", "134.209.248.172", "165.245.191.129", "146.190.246.39"];
const LINUX = "http://10.0.2.2:8549", WINDOWS = "http://192.168.8.249:8549";
const FAKE = { otherPayee: "http://10.0.2.10:8549", forged: "http://10.0.2.11:8549", stale: "http://10.0.2.12:8549", chain: "http://10.0.2.13:8549",
  executor: "http://10.0.2.14:8549", redirect: "http://10.0.2.15:8549", bogus: "http://10.0.2.16:8549", lost: "http://10.0.2.17:8549" };
const savedEnv = { ...process.env }, realFetch = globalThis.fetch;
let W, dir, ca, record, digest, hostRpcs, relayRpcs, relay, relayKey, relayAddr, relayOp, op, owner, chain;
const servers = [], fetchLog = [], doAttempts = [], routes = {};
const signs = { typed: 0, auth: 0 };
let policyState = { banned: [], mode: "current" }, policyCalls = 0;
// an operator decider answering as network/platform-host-policy.mjs judgeHost / host-policy-runtime do
const decideOperators = async (operators) => {
  policyCalls++;
  if (policyState.mode === "throw") throw new Error("platform host policy RPC quorum unavailable");
  return Object.fromEntries(operators.map((o) => [o.toLowerCase(), policyState.mode === "missing" ? undefined
    : policyState.banned.includes(o.toLowerCase()) ? { admit: false, status: "current", reason: "banned by platform policy #1 (operator): test ban" }
    : { admit: true, status: "current", reason: null }]));
};

// ---- the fetch router: DigitalOcean unreachable; pinned host-link origins delivered to their handlers; everything recorded
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (DO.includes(u.hostname)) { doAttempts.push(u.href); throw new TypeError("fetch failed (test: the DigitalOcean fleet is unreachable)"); }
  const route = routes[u.origin];
  if (route) {
    fetchLog.push({ origin: u.origin, path: u.pathname, method: init.method || "GET", redirect: init.redirect ?? null, signed: typeof init.body === "string" && /"signature"/.test(init.body), at: Date.now() });
    return route(u, init);
  }
  if (/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(u.hostname)) throw new TypeError(`fetch failed (test: nothing routed at ${u.origin})`);
  return realFetch(input, init);
};
const forward = (target) => (u, init) => realFetch(target + u.pathname + u.search, init);
const relayInfo = async () => (await realFetch(`${relay.url}/v1/info`)).json();
/** the real relay's /v1/info with its statement re-signed over chosen fields (only the relay key's holder could do this) */
const restated = ({ chainId = 8453, executor, issuedAt = Math.floor(Date.now() / 1000), signer = relayKey }) => async (u, init) => {
  if (u.pathname !== "/v1/info") return forward(relay.url)(u, init);
  const i = await relayInfo();
  const message = relayStatementMessage({ chainId, reserve: i.reserve, executor: executor || i.executor, payee: i.payee, issuedAt });
  return new Response(JSON.stringify({ ...i, statement: { message, signature: await privateKeyToAccount(signer).signMessage({ message }) } }), { status: 200, headers: { "content-type": "application/json" } });
};
const spied = (a) => ({ ...a, signTypedData: (x) => { signs.typed++; return a.signTypedData(x); }, signAuthorization: (x) => { signs.auth++; return a.signAuthorization(x); } });

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
async function server(handler) { const s = http.createServer(handler); await new Promise((ok) => s.listen(0, "127.0.0.1", ok)); servers.push(s); return `http://127.0.0.1:${s.address().port}`; }
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const stubGate = () => ({ check: async () => {}, serviceRefusal: () => null, start() {}, stop() {}, status: () => ({ platformHostPolicy: "stub: admitted" }) });

/** the Linux control CVM's supervisor: the shared factory over the conduit's names (supervisor.js leaseGasSender) */
const journal = [];
function linuxSender({ origin = LINUX, payee = relayAddr, operator = relayOp.address, relays = null, policy = decideOperators } = {}) {
  const env = { ENCLAVE_LEASE_GAS_FILE: record, ENCLAVE_LEASE_GAS_DIGEST: digest, ENCLAVE_LEASE_GAS_RPCS: hostRpcs.join(","),
    ENCLAVE_LEASE_GAS_PINNED_RELAYS: pinnedRelaysValue([validatePinnedRelay({ origin, payee, operator })]), ...(relays ? { ENCLAVE_LEASE_GAS_RELAYS: relays } : {}) };
  const bind = { chain: { id: 8453 }, ledger: W.addr.ledger, registry: W.addr.registry };
  const config = loadLeaseGasConfig({ env, ...bind, allowLoopbackHttp: true, rpcTimeoutMs: 3000 });
  return configuredLeaseSender({ config, account: spied(op.account), getBindings: () => bind, relayPolicy: policy, confirmations: 0, requestTimeoutMs: 4000,
    consumedRecheckMs: [500], onSigned: (s) => { journal.push({ ...s, at: Date.now() }); } });
}
async function loadWindows(settings, { setPolicy = true } = {}) {
  for (const key of Object.keys(process.env)) if (/^(ENCLAVE_)?LEASE_GAS_/.test(key)) delete process.env[key];
  Object.assign(process.env, settings, { BASE_RPCS: W.rpcUrl, NODE_OPERATOR_KEY: op.key });
  const c = await import(hostUrl + "?pinned=" + Math.random());
  c.loadOperator(); c.setLeaseJournal(path.join(dir, `journal-${Math.random()}.json`));
  c.addresses.deployments = W.addr.ledger; c.addresses.registry = W.addr.registry;
  if (setPolicy) c.setLeaseRelayPolicy(decideOperators);
  return c;
}
const app = async () => { const id = await W.create(owner, { fund6: 0n }); await W.enable(owner, id, { p: { claimPolicy: 1, renewWindow: 60, minExtension: 60 } }); return id; };
const paidFor = async (id, from) => W.pc.getContractEvents({ address: W.addr.reserve, abi: W.A.reserve.abi, eventName: "LeaseGasPaid", args: { id }, fromBlock: from });

before(async () => {
  if (!haveAnvil) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-relay-"));
  W = await startWorld();
  await W.write(DEPLOYER, W.addr.ledger, W.A.ledger.abi, "setLeaseSec", [120n]);   // a renewal window reached on the real clock
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "ca.key"), "-out", path.join(dir, "ca.pem"), "-days", "2", "-subj", "/CN=pinned-relay-test-ca"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "leaf.key"), "-out", path.join(dir, "leaf.csr"), "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
  execFileSync("openssl", ["x509", "-req", "-in", path.join(dir, "leaf.csr"), "-CA", path.join(dir, "ca.pem"), "-CAkey", path.join(dir, "ca.key"), "-CAcreateserial", "-out", path.join(dir, "leaf.pem"), "-days", "2", "-extfile", path.join(dir, "ext.cnf")], { stdio: "ignore" });
  ca = path.join(dir, "ca.pem");
  relayRpcs = [await tlsProxy(), await tlsProxy()]; hostRpcs = [W.rpcUrl, await httpProxy()];
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, W.addr[k]])) }));
  record = path.join(dir, "deployment.json"); fs.writeFileSync(record, bytes); digest = "sha256:" + sha(bytes);
  // the relay host (warden): a registered operator, and the PACKAGED role holding a MOVED key (placed, not generated)
  relayOp = await W.operator("https://api.enclave.host/t/metal0");
  const pkgDir = path.join(dir, "packages");
  const built = JSON.parse(execFileSync(process.execPath, [path.join(REPO, "scripts/build-lease-relay-host-package.mjs"), pkgDir], { encoding: "utf8", timeout: 120_000 }).trim().split("\n").at(-1));
  const port = await freePort(), stateRoot = path.join(dir, "warden");
  fs.mkdirSync(path.join(stateRoot, "lease-relay"), { recursive: true, mode: 0o700 });
  relayKey = generatePrivateKey(); relayAddr = privateKeyToAccount(relayKey).address;
  fs.writeFileSync(path.join(stateRoot, "lease-relay/relay.key"), relayKey.slice(2) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(stateRoot, "lease-relay/relay.address"), relayAddr + "\n");
  fs.writeFileSync(path.join(stateRoot, "lease-relay/relay-send.json"), "{}", { mode: 0o600 });
  await W.fund(relayAddr, 10n ** 16n);
  const cfg = { format: "enclave-host-relay/v1", host: { endpoint: "https://api.enclave.host/t/metal0", publicEndpoints: [] }, platformHostPolicy: "production",
    packagesDir: pkgDir, stateRoot, relay: { package: built.package, heapMiB: 128, port, bind: "127.0.0.1", record, digest, rpc: relayRpcs, quorum: 2, maxFloatEth: "0.02", minFloatEth: "0.001", extraCaFile: ca } };
  const logs = [];
  const running = await runHostRelay(cfg, { gate: stubGate(), log: (x) => logs.push(x), intervalMs: 1000 });
  relay = { url: `http://127.0.0.1:${port}`, running, logs };
  const end = Date.now() + 60_000;
  while (!(await realFetch(`${relay.url}/v1/info`).then((r) => r.ok, () => false))) { if (Date.now() > end) throw new Error(`relay did not start: ${logs.join("\n")}`); await new Promise((ok) => setTimeout(ok, 200)); }
  for (const o of [LINUX, WINDOWS, FAKE.otherPayee]) routes[o] = forward(relay.url);
  routes[FAKE.forged] = restated({ signer: generatePrivateKey() });
  routes[FAKE.stale] = restated({ issuedAt: Math.floor(Date.now() / 1000) - 3600 });
  routes[FAKE.chain] = restated({ chainId: 1 });
  routes[FAKE.executor] = restated({ executor: privateKeyToAccount(generatePrivateKey()).address });
  // a redirect to a tracking server: a pinned relay must never follow it
  relay.redirectHits = 0;
  const track = await server((q, r) => { relay.redirectHits++; r.writeHead(200, { "content-type": "application/json" }); r.end("{}"); });
  const redirector = await server((q, r) => { r.writeHead(302, { location: track + q.url }); r.end(); });
  routes[FAKE.redirect] = forward(redirector);
  // a relay that answers success with a hash it never sent (the signed lease is then held, not dropped)
  routes[FAKE.bogus] = (u, init) => u.pathname === "/v1/lease" ? new Response(JSON.stringify({ hash: "0x" + "5e".repeat(32) }), { status: 200, headers: { "content-type": "application/json" } }) : forward(relay.url)(u, init);
  // a relay whose answer is lost after it relayed
  routes[FAKE.lost] = async (u, init) => { const r = await forward(relay.url)(u, init); if (u.pathname === "/v1/lease") { await r.text(); throw new TypeError("fetch failed (test: the answer was lost)"); } return r; };
  op = await W.operator("https://pinned-host.test"); owner = await W.owner();
  await W.write(owner.key, W.addr.registry, W.A.registry.abi, "setPayoutWallet", [op.enclaveId]);
});
after(async () => {
  await relay?.running.stop();
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  W?.stop(); hooks.deregister(); globalThis.fetch = realFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("the relay is the packaged host role serving the MOVED key's payee, with its signed statement", T, async () => {
  const i = await relayInfo();
  assert.equal(i.payee, relayAddr); assert.deepEqual([i.chainId, i.reserve, i.executor], [8453, W.addr.reserve, W.addr.executor]);
  assert.ok(i.statement?.message && i.statement.signature, "a signed statement");
  assert.ok(relay.logs.some((l) => /\[lease-relay\] \[relay\] serving reserve/.test(l)));
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n, "the compute host holds no ETH");
});

test("Linux and Windows factories: claim, renew and release through ONLY the pinned relay, app-paid, zero host ETH, DigitalOcean unreachable", T, async () => {
  const linux = linuxSender();
  const windows = await loadWindows({ ENCLAVE_LEASE_GAS_FILE: record, ENCLAVE_LEASE_GAS_DIGEST: digest, ENCLAVE_LEASE_GAS_RPCS: hostRpcs.join(","),
    ENCLAVE_LEASE_GAS_PINNED_RELAYS: `${WINDOWS},${relayAddr},${relayOp.address}`, ENCLAVE_LEASE_GAS_RELAYS: "https://134.209.248.172" });
  const a = await app(), b = await app(), from = await W.pc.getBlockNumber(), calls0 = policyCalls, float0 = await W.pc.getBalance({ address: relayAddr });
  await linux.claim(a, op.enclaveId);
  await windows.claimDeployment(b, op.enclaveId);
  for (const id of [a, b]) assert.equal((await W.row(id)).runnerOperator, op.address);
  // into the renew window on the REAL clock (the relay's freshness guard runs on the wall clock)
  const row = await W.row(a), rowB = await W.row(b);
  const waitMs = Number(rowB.leaseUntil > row.leaseUntil ? rowB.leaseUntil : row.leaseUntil) * 1000 - 55_000 - Date.now();
  if (waitMs > 0) await new Promise((ok) => setTimeout(ok, waitMs));
  await W.rpc("evm_mine", []);
  await linux.renew(a); await windows.renewDeployment(b);
  assert.ok((await W.row(a)).leaseUntil > row.leaseUntil && (await W.row(b)).leaseUntil > rowB.leaseUntil, "both renewed");
  await linux.release(a); await windows.releaseDeployment(b);
  for (const id of [a, b]) {
    assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/, "released");
    const paid = await paidFor(id, from);
    assert.deepEqual(paid.map((e) => Number(e.args.kind)), [1, 2, 3], "claim, renew, release - each paid by the app's reserve");
    assert.ok(paid.every((e) => e.args.payee === relayAddr && e.args.operator === op.address), "to the MOVED payee, for this host");
  }
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n, "never operator-paid");
  assert.ok(policyCalls - calls0 >= 6, "the relay operator was judged by the platform policy for every operation");
  const signedPosts = fetchLog.filter((f) => f.signed);
  assert.ok(signedPosts.length >= 6 && signedPosts.every((f) => [LINUX, WINDOWS].includes(f.origin) && f.path === "/v1/lease" && f.redirect === "error"),
    "every signed authorization went to exactly a pinned origin, redirects refused");
  assert.equal(doAttempts.length, 0, "the pinned relay comes first: the DigitalOcean relay was never needed");
  assert.ok(await W.pc.getBalance({ address: relayAddr }) >= float0 * 99n / 100n, "the relay float is reimbursed (within 1%)");
});

test("refused BEFORE ANY SIGNATURE: another payee, forged/stale/other-chain/other-executor statements, a fresh ban, an unreadable or missing policy, policy off, a redirect", T, async () => {
  const refused = async (label, sender, re) => {
    const id = await app(), s0 = { ...signs }, posts = fetchLog.filter((f) => f.method === "POST").length, j0 = journal.length;
    await assert.rejects(sender.claim(id, op.enclaveId), (e) => e.code === "NotRelayed" && re.test(e.message), label);
    assert.deepEqual(signs, s0, `${label}: no lease signature and no authorization were made`);
    assert.equal(fetchLog.filter((f) => f.method === "POST").length, posts, `${label}: nothing was POSTed`);
    assert.equal(journal.length, j0, `${label}: nothing journaled`);
    assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/, `${label}: not claimed`);
  };
  await refused("another pinned payee", linuxSender({ origin: FAKE.otherPayee, payee: privateKeyToAccount(generatePrivateKey()).address }), /names another payee/);
  await refused("a forged statement", linuxSender({ origin: FAKE.forged }), /not signed by the advertised relay key/);
  await refused("a stale statement", linuxSender({ origin: FAKE.stale }), /stale or from the future/);
  await refused("a statement for another chain", linuxSender({ origin: FAKE.chain }), /another chain, reserve or executor/);
  await refused("a statement for another executor", linuxSender({ origin: FAKE.executor }), /another chain, reserve or executor/);
  await refused("a redirect", linuxSender({ origin: FAKE.redirect }), /fetch failed|redirect/i);
  assert.equal(relay.redirectHits, 0, "the redirect target was never contacted");
  policyState.banned = [relayOp.address.toLowerCase()];
  await refused("a fresh ban of the relay's operator", linuxSender(), /refused by the platform host policy \(banned by platform policy #1/);
  // the ban also holds with the DigitalOcean relay configured: it is unreachable, so nothing is sent anywhere
  const d0 = doAttempts.length;
  await refused("a ban with the DigitalOcean relay configured", linuxSender({ relays: "https://134.209.248.172" }), /banned by platform policy/);
  assert.ok(doAttempts.length > d0, "the DigitalOcean relay was tried and unreachable");
  policyState.banned = [];
  for (const mode of ["throw", "missing"]) { policyState.mode = mode; await refused(`policy ${mode}`, linuxSender(), /refused by the platform host policy/); }
  policyState.mode = "current";
  await refused("policy OFF (relayPolicy null): no pinned relay without admission", linuxSender({ policy: null }), /platform host policy is off/);
  // the Windows node whose host never set its platform policy refuses too (RELAY_POLICY_UNSET)
  const unset = await loadWindows({ ENCLAVE_LEASE_GAS_FILE: record, ENCLAVE_LEASE_GAS_DIGEST: digest, ENCLAVE_LEASE_GAS_RPCS: hostRpcs.join(","),
    ENCLAVE_LEASE_GAS_PINNED_RELAYS: `${WINDOWS},${relayAddr},${relayOp.address}` }, { setPolicy: false });
  const id = await app(), s0 = { ...signs };
  await assert.rejects(unset.claimDeployment(id, op.enclaveId), /not set its platform host policy|NotRelayed|no relay landed/);
  assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/);
  // unbanned and admitted: the same sender works at once (authority is judged fresh, never cached)
  const ok = await app();
  await linuxSender().claim(ok, op.enclaveId); await linuxSender().release(ok);
  assert.ok(signs.typed > s0.typed);
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
});

test("after signing: an unverifiable relay receipt is not success and its durable journal entry is held; a lost answer is settled from the chain", T, async () => {
  const id = await app(), from = await W.pc.getBlockNumber(), j0 = journal.length;
  const bogus = linuxSender({ origin: FAKE.bogus });
  await assert.rejects(bogus.claim(id, op.enclaveId), (e) => e.code === "NotRelayed" && /did not verify/.test(e.message));
  assert.equal(journal.length, j0 + 1, "the signed lease was journaled BEFORE the relay saw it");
  const entry = journal.at(-1);
  const post = fetchLog.filter((f) => f.origin === FAKE.bogus && f.method === "POST").at(-1);
  assert.ok(entry.at <= post.at, "journaled first");
  const want = { id, kind: 1, enclaveId: op.enclaveId, nonce: entry.nonce, deadline: entry.deadline, maxChargeWei: entry.lease.maxChargeWei };
  const r = await bogus.resolveSigned(want, entry.fromBlock, [entry.payee], { operator: entry.operator, chainId: entry.chainId, reserve: entry.reserve, executor: entry.executor, ledger: entry.ledger });
  assert.equal(r.state, "pending", "never landed, not expired: HELD, never dropped or called success");
  assert.equal((await paidFor(id, from)).length, 0);
  // a lost answer after the relay sent it: the client finds the landed lease on its own RPC quorum
  const lost = linuxSender({ origin: FAKE.lost });
  const done = await lost.claim(id, op.enclaveId);
  assert.equal((await W.row(id)).runnerOperator, op.address);
  const paid = await paidFor(id, from);
  assert.equal(paid.length, 1); assert.equal(paid[0].transactionHash, done.hash); assert.equal(paid[0].args.payee, relayAddr);
  const settled = await lost.resolveSigned({ ...want, nonce: journal.at(-1).nonce, deadline: journal.at(-1).deadline, maxChargeWei: journal.at(-1).lease.maxChargeWei },
    journal.at(-1).fromBlock, [relayAddr], { operator: op.address, chainId: 8453, reserve: W.addr.reserve, executor: W.addr.executor, ledger: W.addr.ledger });
  assert.equal(settled.state, "landed");
  await linuxSender().release(id);
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
});
