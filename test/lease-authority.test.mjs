// Actual local EVM plus independently addressed RPC proxies. The first proxy can lie about authority; assertions
// observe real signer calls and on-chain zero-ETH claims/renewals, not just helper return values.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import * as viem from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const B = await import(process.env.LEASE_AUTHORITY_CLIENT || new URL("../client/lease-executor-client.mjs", import.meta.url).href);
import { startWorld, haveAnvil } from "./helpers/lease-gas-world.mjs";
import { loadLeaseGasConfig, configuredLeaseSender } from "../network/lease-gas-runtime.mjs";

const T = { skip: !haveAnvil && "needs anvil", timeout: 120_000 };
const ATTACKER = "0x9999999999999999999999999999999999999999";
const reserveGetters = viem.parseAbi(["function executor() view returns(address)", "function ledger() view returns(address)"]);
let W, relay, dep;
let clockOffset = 0;
const proxies = [];
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  dep = { chainId: 8453, ...W.addr };
  const key = generatePrivateKey();
  await W.fund(privateKeyToAccount(key).address);
  relay = await B.startLeaseRelay({ client: W.pc, wallet: W.wc(key), reserve: dep.reserve,
    reserveCodeHash: dep.reserveCodeHash, executorCodeHash: dep.executorCodeHash,
    deployment: dep, allowLoopbackHttp: true, now: () => Date.now() + clockOffset });
});
after(async () => {
  for (const p of proxies) await p.close();
  await relay?.close();
  W?.stop();
});

async function proxy(mode = "honest") {
  const observations = [];
  const state = { mode };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const q = JSON.parse(Buffer.concat(chunks));
      observations.push(q);
      if (state.mode === "down") { res.writeHead(503); return res.end(); }
      // the relay's send seam: it signs once and broadcasts the raw bytes through its RPCs, so hold the broadcast here
      if (state.mode === "hold-send" && q.method === "eth_sendRawTransaction") { state.sends = (state.sends || 0) + 1; await state.gate; }
      let result = await W.rpc(q.method, q.params);
      if (state.mode === "chain" && q.method === "eth_chainId") result = "0x1";
      if (state.mode === "stale" && q.method === "eth_getBlockByNumber")
        result = { ...result, timestamp: viem.toHex(Math.floor(Date.now() / 1000) - 1000) };
      if (state.mode === "height" && q.method === "eth_getBlockByNumber")
        result = { ...result, number: viem.toHex(BigInt(result.number) + 1n) };
      if (state.mode === "receipt" && q.method === "eth_getTransactionReceipt")
        result = { ...result, blockHash: "0x" + "99".repeat(32) };
      if (state.mode === "code" && q.method === "eth_getCode" && q.params[0].toLowerCase() === dep.reserve.toLowerCase())
        result = "0x60006000";
      if (["executor", "ledger"].includes(state.mode) && q.method === "eth_call" &&
          q.params[0].to.toLowerCase() === dep.reserve.toLowerCase() &&
          q.params[0].data === viem.encodeFunctionData({ abi: reserveGetters, functionName: state.mode }))
        result = viem.encodeFunctionResult({ abi: reserveGetters, functionName: state.mode, result: ATTACKER });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: e.message } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = viem.createPublicClient({ chain: W.chain, transport: viem.http(url, { retryCount: 0, timeout: 1500 }) });
  const p = { client, state, observations, close: () => new Promise((resolve) => {
    server.closeAllConnections(); server.close(resolve);
  }) };
  proxies.push(p);
  return p;
}
function spy(account) {
  const calls = { authorization: [], lease: [] };
  return { calls, account: { ...account,
    signAuthorization: (a) => { calls.authorization.push(a); return account.signAuthorization(a); },
    signTypedData: (a) => { calls.lease.push(a); return account.signTypedData(a); },
  } };
}
const opts = (clients, account) => ({ clients, account, reserve: dep.reserve, deployment: dep, relays: [relay.url],
  allowLoopbackHttp: true, confirmations: 0, requestTimeoutMs: 2000, rpcTimeoutMs: 2000 });
function configuredHost(clients, account, prefix) {
  const record = { format: "enclave-lease-gas-deployment/v1", chainId: dep.chainId,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, dep[k]])) };
  const bytes = Buffer.from(JSON.stringify(record));
  const values = { FILE: "reviewed.json", DIGEST: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
    RPCS: clients.map((c) => c.transport.url).join(","), RELAYS: relay.url };
  const env = Object.fromEntries(Object.entries(values).map(([k, v]) => [prefix + k, v]));
  const bindings = { chain: W.chain, ledger: dep.ledger, registry: dep.registry };
  const config = loadLeaseGasConfig({ env, ...bindings, readFile: () => bytes, allowLoopbackHttp: true, rpcTimeoutMs: 2000 });
  return configuredLeaseSender({ config, account, getBindings: () => bindings, confirmations: 0,
    requestTimeoutMs: 2000, now: () => Date.now() + clockOffset });
}
async function requestFor(op, id, payee) {
  const code = await W.pc.getCode({ address: op.address });
  const delegated = code?.toLowerCase() === B.designator(dep.executor);
  const nonce = delegated ? await W.pc.readContract({ address: op.address, abi: B.EXECUTOR_ABI, functionName: "nonceOf", args: [id] }) : 0n;
  const lease = { id, kind: 1, enclaveId: op.enclaveId, nonce, deadline: (await W.pc.getBlock()).timestamp + 300n,
    payee, maxChargeWei: 10n ** 15n };
  const signature = await op.account.sign({ hash: B.leaseDigest({ chainId: 8453, operator: op.address, reserve: dep.reserve, lease }) });
  const authorization = delegated ? null : await op.account.signAuthorization({ contractAddress: dep.executor, chainId: 8453,
    nonce: await W.pc.getTransactionCount({ address: op.address }) });
  return { operator: op.address, lease, signature, authorization };
}
const postLease = async (url, body) => {
  const r = await fetch(url + "/v1/lease", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_k, v) => typeof v === "bigint" ? String(v) : v), signal: AbortSignal.timeout(15_000) });
  return { status: r.status, body: await r.json() };
};

test("relay revalidates authority after startup and spends nothing without an honest quorum", T, async () => {
  const [a, b] = await Promise.all([proxy(), proxy()]);
  const key = generatePrivateKey(), wallet = W.wc(key);
  await W.fund(wallet.account.address);
  // the relay signs once and broadcasts the raw bytes through its RPCs: count what actually reached them
  const sends = () => [a, b].flatMap((p) => p.observations).filter((q) => q.method === "eth_sendRawTransaction").length;
  const r = await B.startLeaseRelay({ ...opts([a.client, b.client], null), wallet });
  try {
    const o = await W.owner(), op = await W.operator("https://relay-revalidate.test");
    const id = await W.create(o); await W.enable(o, id);
    const body = await requestFor(op, id, wallet.account.address);
    const balance = await W.pc.getBalance({ address: wallet.account.address });
    for (const mode of ["executor", "ledger", "code", "chain"]) {
      a.state.mode = mode;
      const answer = await postLease(r.url, body);
      assert.equal(answer.status, 502, JSON.stringify(answer));
      assert.equal(sends(), 0, mode);
      assert.equal(await W.pc.getBalance({ address: wallet.account.address }), balance);
    }
  } finally { await r.close(); }
});

test("a funded relay works through one lying or down RPC and confirms payment through the honest quorum", T, async () => {
  const [a, b, c] = await Promise.all([proxy("executor"), proxy(), proxy()]);
  const key = generatePrivateKey(), wallet = W.wc(key);
  await W.fund(wallet.account.address);
  const r = await B.startLeaseRelay({ ...opts([a.client, b.client, c.client], null), wallet });
  try {
    for (const mode of ["executor", "down"]) {
      a.state.mode = mode;
      const o = await W.owner(), op = await W.operator(`https://relay-majority-${mode}.test`);
      const id = await W.create(o); await W.enable(o, id);
      const answer = await postLease(r.url, await requestFor(op, id, wallet.account.address));
      assert.equal(answer.status, 200, JSON.stringify(answer));
      assert.equal(answer.body.status, "success");
      assert.equal(viem.getAddress(answer.body.paid.payee), wallet.account.address);
      assert.equal((await W.row(id)).runnerOperator, op.address);
      assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
    }
  } finally { await r.close(); }
});

test("an HTTP timeout does not release the relay queue or its capacity while a send remains pending", T, async () => {
  const key = generatePrivateKey(), wallet = W.wc(key);
  await W.fund(wallet.account.address);
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  // the held broadcast is forwarded once the gate opens, even after the relay stopped waiting for that answer
  const held = await proxy("hold-send"); held.state.gate = gate;
  const r = await B.startLeaseRelay({ client: held.client, deployment: dep, allowLoopbackHttp: true, wallet,
    requestTimeoutMs: 500, maxConcurrent: 1 });
  const sendsOf = () => held.state.sends || 0;
  let id, op;
  try {
    const o = await W.owner(); op = await W.operator("https://relay-timeout-queue.test");
    id = await W.create(o); await W.enable(o, id);
    const body = await requestFor(op, id, wallet.account.address);
    const first = await postLease(r.url, body);
    assert.equal(first.status, 502, JSON.stringify(first));
    assert.equal(sendsOf(), 1);
    const second = await postLease(r.url, body);
    assert.equal(second.status, 503, "the timed-out job still occupies the queue");
    assert.equal(sendsOf(), 1, "no overlapping send from the same funded key");
  } finally {
    open();
    await r.close();
  }
  assert.equal((await W.row(id)).runnerOperator, op.address, "the original send is allowed to finish once");
  const events = await W.pc.getContractEvents({ address: dep.reserve, abi: W.A.reserve.abi, eventName: "LeaseGasPaid", args: { id }, fromBlock: 0n });
  assert.equal(events.length, 1);
});

test("reviewed pins and distinct RPC identities are required before signing", T, async () => {
  const s = spy(privateKeyToAccount(generatePrivateKey()));
  assert.throws(() => B.createLeaseClient({ client: W.pc, account: s.account, reserve: dep.reserve,
    relays: [relay.url], allowLoopbackHttp: true }), /reviewed deployment/);
  const clients = ["/one", "/two"].map((suffix) => viem.createPublicClient({
    chain: W.chain, transport: viem.http("https://rpc.example" + suffix),
  }));
  assert.throws(() => B.createLeaseClient(opts(clients, s.account)), /repeat a provider/);
  assert.throws(() => B.createLeaseClient(opts([clients[0]], s.account)), /at least two/);
  assert.equal(s.calls.authorization.length + s.calls.lease.length, 0);
});

for (const mode of ["executor", "ledger", "code", "chain", "height"]) {
  test(`a lying first RPC (${mode}) cannot obtain an authorization without an honest quorum, including preflight`, T, async () => {
    const [bad, good] = await Promise.all([proxy(mode), proxy()]);
    const owner = await W.owner(), op = await W.operator(`https://bad-authority-${mode}.test`);
    const id = await W.create(owner);
    await W.enable(owner, id);
    const s = spy(op.account);
    const o = opts([bad.client, good.client], s.account);
    let leaked = false;
    o.fetchImpl = () => { leaked = true; throw new Error("must not reach a relay"); };
    const host = B.createLeaseClient(o);
    const claimError = await host.claim(id, op.enclaveId).then(() => null, (e) => e);
    assert.equal(s.calls.authorization.length, 0, "the first RPC obtained a 7702 authorization for an eligible real app");
    assert.match(String(claimError?.message), /quorum/);
    const preflightError = await B.preflight({ ...o, id, kind: "claim", enclaveId: op.enclaveId, from: ATTACKER })
      .then(() => null, (e) => e);
    assert.equal(s.calls.authorization.length, 0, "no 7702 capability was signed");
    assert.match(String(preflightError?.message), /quorum/);
    assert.equal(s.calls.lease.length, 0, "no lease intent was signed");
    assert.equal(leaked, false);
  });
}

test("authority is rechecked at a fresh block on every call; stale unanimous answers are refused", T, async () => {
  const [a, b] = await Promise.all([proxy(), proxy()]);
  const s = spy(privateKeyToAccount(generatePrivateKey()));
  const host = B.createLeaseClient(opts([a.client, b.client], s.account));
  assert.equal(await host.executor(), viem.getAddress(dep.executor));
  a.state.mode = b.state.mode = "code";
  await assert.rejects(host.executor(), /quorum/);
  a.state.mode = b.state.mode = "stale";
  await assert.rejects(host.executor(), /stale/);
  assert.equal(s.calls.authorization.length, 0);
});

test("all authority calls bind the same canonical block hash", T, async () => {
  const [a, b] = await Promise.all([proxy(), proxy()]);
  const v = await B.verifiedLeaseAuthority({ ...opts([a.client, b.client], privateKeyToAccount(generatePrivateKey())) });
  for (const p of [a, b]) {
    const calls = p.observations.filter((q) => ["eth_getCode", "eth_call"].includes(q.method));
    assert.ok(calls.length >= 7);
    for (const q of calls) assert.deepEqual(q.params[1], { blockHash: v.block.hash, requireCanonical: true });
  }
});

test("preflight accepts a covered lease and refuses a one-wei reserve, without applying its delegation", T, async () => {
  const [a, b] = await Promise.all([proxy(), proxy()]);
  const owner = await W.owner(), op = await W.operator("https://preflight-authority.test");
  const info = await fetch(relay.url + "/v1/info").then((r) => r.json());
  for (const [deposit, expected] of [[10n ** 16n, true], [1n, false]]) {
    const id = await W.create(owner);
    await W.enable(owner, id, { deposit });
    const result = await B.preflight({ ...opts([a.client, b.client], op.account), id, kind: "claim",
      enclaveId: op.enclaveId, from: info.payee });
    assert.equal(result.ok, expected, JSON.stringify(result, (_k, v) => typeof v === "bigint" ? String(v) : v));
    assert.equal((await W.reserveOf(id, owner.address)).balanceWei, deposit);
    assert.ok([undefined, "0x"].includes(await W.pc.getCode({ address: op.address })), "eth_call must not persist the delegation");
    assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
  }
});

test("two honest RPCs tolerate a liar or outage; a zero-ETH self-hosted app claims and renews from its reserve", T, async () => {
  const [a, b, c] = await Promise.all([proxy("executor"), proxy(), proxy()]);
  const owner = await W.owner();
  const op = await W.operator("https://authority-zero-eth.test");
  await W.write(owner.key, dep.registry, W.A.registry.abi, "setPayoutWallet", [op.enclaveId]);
  const id = await W.create(owner, { fund6: 0n });
  await W.enable(owner, id, { p: { claimPolicy: 1 } });
  const s = spy(op.account);
  const host = configuredHost([a.client, b.client, c.client], s.account, "LEASE_GAS_");
  const before = (await W.reserveOf(id, owner.address)).balanceWei;
  const claim = await host.claim(id, op.enclaveId);
  assert.equal(claim.receipt.status, "success");
  let d = await W.row(id);
  assert.equal(d.rate, 0n);
  assert.equal(d.runnerOperator, op.address);
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
  assert.ok((await W.reserveOf(id, owner.address)).balanceWei < before);
  assert.equal(s.calls.authorization.length, 1);
  assert.equal(viem.getAddress(s.calls.authorization[0].contractAddress), viem.getAddress(dep.executor));
  assert.equal(s.calls.authorization[0].chainId, 8453);
  const lease = s.calls.lease[0].message;
  for (const field of ["deadline", "maxChargeWei"]) {
    await assert.rejects(host.verifyLanded(claim.hash, { ...lease, [field]: lease[field] + 1n }, [lease.payee]), /quorum/);
  }
  a.state.mode = "receipt";
  const split = B.createLeaseClient(opts([a.client, b.client], s.account));
  await assert.rejects(split.verifyLanded(claim.hash, lease, [lease.payee]), /quorum/,
    "a receipt on another block cannot count as confirmation");
  await W.warpTo(d.leaseUntil - 200n);
  clockOffset = Number((await W.pc.getBlock()).timestamp) * 1000 - Date.now();
  a.state.mode = "down";
  const windows = configuredHost([a.client, b.client, c.client], s.account, "ENCLAVE_LEASE_GAS_");
  const renew = await windows.renew(id);
  assert.equal(renew.receipt.status, "success");
  assert.ok((await W.row(id)).leaseUntil > d.leaseUntil);
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
  assert.equal(s.calls.authorization.length, 1, "existing delegation needs no second authorization");
});
