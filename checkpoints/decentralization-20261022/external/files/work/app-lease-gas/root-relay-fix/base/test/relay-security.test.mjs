// Round 3, root review items 1-3: the RELAY never spends on anything but a verified lease for its pinned reserve and
// executor, and the HOST never takes a relay's word. Local anvil (test/helpers/b-world.mjs); relays are
// client/lease-executor-client.mjs startLeaseRelay (honest, pinned by code hash) and a programmable LYING relay.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";
import { startWorld, haveAnvil, ZERO32, policy } from "./helpers/b-world.mjs";

const T = { skip: !haveAnvil && "needs anvil", timeout: 300_000 };
let W, honest, honestKey, closers = [];
let clockOffset = 0;
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  const warp = W.warpTo;
  W.warpTo = async (ts) => {
    await warp(ts);
    clockOffset = Number((await W.pc.getBlock()).timestamp) * 1000 - Date.now();
  };
  honestKey = generatePrivateKey();
  await W.fund(privateKeyToAccount(honestKey).address);
  honest = await B.startLeaseRelay({ client: W.pc, wallet: W.wc(honestKey), reserve: W.addr.reserve, reserveCodeHash: W.addr.reserveCodeHash,
                                     executorCodeHash: W.addr.executorCodeHash });
  closers.push(() => honest.close());
});
after(async () => { for (const c of closers) await c(); W?.stop(); });

const relayAddr = () => privateKeyToAccount(honestKey).address;
const post = (url, body, raw = false) => fetch(`${url}/v1/lease`, { method: "POST", headers: { "content-type": "application/json" },
  body: raw ? body : JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

/** A signed lease request as a host would send it (optionally tampered). */
async function signedRequest(op, id, kind, { enclaveId = ZERO32, payee = relayAddr(), maxChargeWei = 10n ** 15n, reserve = W.addr.reserve,
                                              executor = W.addr.executor, withAuth = null } = {}) {
  const code = ((await W.pc.getCode({ address: op.address })) || "0x").toLowerCase();
  const delegated = code === B.designator(executor);
  const nonce = delegated ? await W.pc.readContract({ address: op.address, abi: B.EXECUTOR_ABI, functionName: "nonceOf", args: [id] }) : 0n;
  const deadline = (await W.pc.getBlock()).timestamp + 300n;
  const lease = { id, kind: B.KIND[kind], enclaveId, nonce: BigInt(nonce), deadline, payee, maxChargeWei };
  const signature = await op.account.signTypedData({ domain: { name: "EnclaveLeaseExecutor", version: "1", chainId: 8453, verifyingContract: op.address },
    types: { Lease: [{ name: "reserve", type: "address" }, { name: "id", type: "bytes32" }, { name: "kind", type: "uint8" }, { name: "enclaveId", type: "bytes32" },
      { name: "nonce", type: "uint64" }, { name: "deadline", type: "uint64" }, { name: "payee", type: "address" }, { name: "maxChargeWei", type: "uint256" }] },
    primaryType: "Lease", message: { reserve, ...lease } });
  const authorization = (withAuth ?? !delegated) ? await op.account.signAuthorization({ contractAddress: executor, chainId: 8453,
    nonce: await W.pc.getTransactionCount({ address: op.address }) }) : null;
  return { operator: op.address, lease, signature, authorization };
}
const relayTxCount = () => W.pc.getTransactionCount({ address: relayAddr() });

// ---- RELAY -----------------------------------------------------------------------------------------------------------

test("relay refuses, BEFORE spending: arbitrary contract, wrong executor, other reserve, bad signature, wrong payee, underpayment, bad bodies", T, async () => {
  const o = await W.owner(); const id = await W.create(o); await W.enable(o, id);
  const op = await W.operator("https://sec-a.test");
  const n0 = await relayTxCount();
  // 1. an arbitrary contract posing as the operator (it would accept the call and emit a spoofed LeaseGasPaid)
  const spoof = await W.deploy(W.A.spoof);
  await W.write("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", spoof, W.A.spoof.abi, "arm", [id, relayAddr(), 1, spoof]);
  const fake = await signedRequest(op, id, "claim", { enclaveId: op.enclaveId });
  let r = await post(honest.url, { ...fake, operator: spoof });
  assert.equal(r.status, 422); assert.equal(r.body.error, "NotAnOperatorKey");
  // 2. an authorization delegating to ANOTHER executor (one bound to a different reserve)
  const other = await W.newReserve();
  r = await post(honest.url, await signedRequest(op, id, "claim", { enclaveId: op.enclaveId, executor: other.executor }));
  assert.equal(r.status, 422); assert.equal(r.body.error, "WrongExecutor");
  // 3. a lease signed for another reserve
  r = await post(honest.url, await signedRequest(op, id, "claim", { enclaveId: op.enclaveId, reserve: other.reserve }));
  assert.equal(r.status, 422); assert.equal(r.body.error, "BadSignature");
  // 4. a tampered signature
  const t = await signedRequest(op, id, "claim", { enclaveId: op.enclaveId });
  r = await post(honest.url, { ...t, lease: { ...t.lease, maxChargeWei: t.lease.maxChargeWei + 1n } });
  assert.equal(r.status, 422); assert.equal(r.body.error, "BadSignature");
  // 5. a payee that is not this relay
  r = await post(honest.url, await signedRequest(op, id, "claim", { enclaveId: op.enclaveId, payee: privateKeyToAccount(generatePrivateKey()).address }));
  assert.equal(r.status, 422); assert.equal(r.body.error, "WrongPayee");
  // 6. underpayment: a signed maximum below the expected charge; an owner's gas price cap below the current fee
  r = await post(honest.url, await signedRequest(op, id, "claim", { enclaveId: op.enclaveId, maxChargeWei: 1000n }));
  assert.equal(r.status, 422); assert.equal(r.body.error, "OverSignedMax");
  await W.write(o.key, W.addr.reserve, W.A.reserve.abi, "configure", [id, policy({ maxGasPrice: 1_000_000n })]);   // 0.001 gwei < base fee
  r = await post(honest.url, await signedRequest(op, id, "claim", { enclaveId: op.enclaveId }));
  assert.equal(r.status, 422); assert.equal(r.body.error, "UnderpaidGasPrice");
  await W.write(o.key, W.addr.reserve, W.A.reserve.abi, "configure", [id, policy()]);
  // 7. bodies: oversized, malformed
  r = await post(honest.url, JSON.stringify({ pad: "x".repeat(5000) }), true);
  assert.equal(r.status, 413);
  r = await post(honest.url, "{not json", true);
  assert.equal(r.status, 400);
  r = await post(honest.url, { operator: op.address, lease: { id: "0x12" }, signature: "0x00" });
  assert.equal(r.status, 400); assert.equal(r.body.error, "BadRequest");
  assert.equal(await relayTxCount(), n0, "the relay sent NOTHING for any of these");
  // and the honest case lands, paying this relay (checked from the receipt's event of the pinned reserve)
  r = await post(honest.url, await signedRequest(op, id, "claim", { enclaveId: op.enclaveId }));
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, "success");
  assert.equal(viem.getAddress(r.body.paid.payee), relayAddr());
});

test("relay: parallel requests for three deployments sharing ONE 7702 authorization all land, sent one at a time", T, async () => {
  const o = await W.owner(); const op = await W.operator("https://sec-par.test");
  const ids = [];
  for (let i = 0; i < 3; i++) { const id = await W.create(o); await W.enable(o, id); ids.push(id); }
  // all three carry the same authorization (the key's current account nonce): whichever lands first delegates the key
  const auth = await op.account.signAuthorization({ contractAddress: W.addr.executor, chainId: 8453, nonce: await W.pc.getTransactionCount({ address: op.address }) });
  const reqs = await Promise.all(ids.map(async (id) => ({ ...(await signedRequest(op, id, "claim", { enclaveId: op.enclaveId, withAuth: false })), authorization: auth })));
  const res = await Promise.all(reqs.map((q) => post(honest.url, q)));
  assert.deepEqual(res.map((x) => x.status), [200, 200, 200], JSON.stringify(res.map((x) => x.body)));
  for (const id of ids) assert.equal((await W.row(id)).runnerOperator, op.address);
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
});

// ---- HOST ------------------------------------------------------------------------------------------------------------

/** A relay that answers /v1/info honestly (so the host binds the lease to ITS payee) and then lies as told. */
async function lyingRelay(mode) {
  const key = generatePrivateKey(); const acct = privateKeyToAccount(key);
  await W.fund(acct.address);
  const pinned = await B.pinRelayContracts({ client: W.pc, reserve: W.addr.reserve, reserveCodeHash: W.addr.reserveCodeHash, executorCodeHash: W.addr.executorCodeHash });
  const hits = { info: 0, lease: 0 };
  hits.gate = new Promise((ok) => { hits.open = ok; });   // "hold" answers only when the test opens the gate
  const server = http.createServer(async (req, res) => {
    const reply = (s, b) => { if (!res.writableEnded) { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? v.toString() : v))); } };
    if (req.url === "/v1/info") { hits.info++; return reply(200, { chainId: 8453, reserve: W.addr.reserve, executor: W.addr.executor, payee: acct.address }); }
    hits.lease++;
    const c = []; for await (const x of req) c.push(x);
    const signed = B.parseRelayRequest(JSON.parse(Buffer.concat(c).toString()));
    const wallet = W.wc(key);
    if (mode === "refuse") return reply(422, { error: "Disabled", message: "lying" });
    if (mode === "hang") return;                                                     // never answers
    if (mode === "unrelated") { const h = await wallet.sendTransaction({ to: acct.address, value: 1n }); await W.pc.waitForTransactionReceipt({ hash: h }); return reply(200, { hash: h, status: "success" }); }
    if (mode === "reverted") { const target = await W.deploy(W.A.reverts); const h = await wallet.sendTransaction({ to: target, gas: 100_000n });
      await W.pc.waitForTransactionReceipt({ hash: h }); return reply(200, { hash: h, status: "success" }); }
    if (mode === "spoof") { const s = await W.deploy(W.A.spoof);
      await W.write(key, s, W.A.spoof.abi, "arm", [signed.lease.id, acct.address, signed.lease.kind, signed.operator]);
      const h = await wallet.sendTransaction({ to: s, data: B.leaseCalldata(signed.lease, signed.signature), gas: 300_000n });
      await W.pc.waitForTransactionReceipt({ hash: h }); return reply(200, { hash: h, status: "success" }); }
    if (mode === "lost" || mode === "delayed") {
      const r = await B.relayLease({ client: W.pc, wallet, pinned, signed });
      if (mode === "lost") return reply(500, { error: "oops" });
      await new Promise((ok) => setTimeout(ok, 6000)); return reply(200, { hash: r.hash, status: "success" });
    }
    if (mode === "hold") { hits.held = signed; await hits.gate; return reply(500, { error: "held" }); }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  closers.push(() => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, payee: acct.address };
}
const hostClient = (op, relays, extra = {}) => B.createLeaseClient({ client: W.pc, account: op.account, reserve: W.addr.reserve, relays,
  deployment: { chainId: 8453, ...W.addr }, now: () => Date.now() + clockOffset,
  allowLoopbackHttp: true, requestTimeoutMs: 3000, ...extra });

for (const mode of ["refuse", "hang", "unrelated", "reverted", "spoof"]) {
  test(`host: a '${mode}' relay first never yields a false success; the honest relay behind it lands the claim`, T, async () => {
    const o = await W.owner(); const id = await W.create(o); await W.enable(o, id);
    const op = await W.operator(`https://host-${mode}.test`);
    const liar = await lyingRelay(mode);
    const r = await hostClient(op, [liar.url, honest.url]).claim(id, op.enclaveId);
    assert.equal(liar.hits.lease, 1, "the liar was asked first");
    const tx = await W.pc.getTransaction({ hash: r.hash });
    assert.equal(viem.getAddress(tx.to), op.address, "the verified landing is a call to the operator itself");
    assert.equal((await W.row(id)).runnerOperator, op.address);
    assert.equal(r.receipt.status, "success");
  });
}

test("host: a relay that lands the lease but loses (500) or delays its answer: the host finds it on chain, nothing lands twice", T, async () => {
  for (const mode of ["lost", "delayed"]) {
    const o = await W.owner(); const id = await W.create(o); await W.enable(o, id);
    const op = await W.operator(`https://host-${mode}.test`);
    const liar = await lyingRelay(mode);
    const r = await hostClient(op, [liar.url, honest.url]).claim(id, op.enclaveId);
    const tx = await W.pc.getTransaction({ hash: r.hash });
    assert.equal(viem.getAddress(tx.from), viem.getAddress(liar.payee), `${mode}: the liar's own landing was found and verified`);
    const paid = await W.pc.getContractEvents({ address: W.addr.reserve, abi: W.A.reserve.abi, eventName: "LeaseGasPaid", args: { id }, fromBlock: 0n });
    assert.equal(paid.length, 1, `${mode}: exactly one charge`);
  }
});

test("host: a refusal the HOST verifies stops at once (no relay asked); a nonce consumed by ANOTHER operation is not this one's success", T, async () => {
  const o = await W.owner(); const id = await W.create(o);
  const op = await W.operator("https://host-terminal.test");
  const liar = await lyingRelay("refuse");
  await assert.rejects(hostClient(op, [liar.url, honest.url]).claim(id, op.enclaveId), (e) => e.code === "Disabled");
  assert.equal(liar.hits.lease + liar.hits.info, 0, "a verified terminal refusal asks no relay");
  // nonce consumed by a different operation: a release is held by a relay; meanwhile this key's renew (same nonce) lands
  await W.enable(o, id);
  await hostClient(op, [honest.url]).claim(id, op.enclaveId);
  await W.warpTo((await W.row(id)).leaseUntil - 200n);
  const holder = await lyingRelay("hold");
  const renew = await signedRequest(op, id, "renew");
  const releaseP = hostClient(op, [holder.url], { requestTimeoutMs: 20_000 }).release(id);
  releaseP.catch(() => {});
  // land the renew (same nonce lane value) through the honest relay while the release is held
  for (let i = 0; i < 50 && !holder.hits.held; i++) await new Promise((ok) => setTimeout(ok, 100));
  const r = await post(honest.url, renew);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  holder.hits.open();                                    // only now does the held relay answer (500, nothing sent)
  await assert.rejects(releaseP, (e) => e.code === "NonceConsumed" || e.code === "NotRelayed");
  assert.equal((await W.row(id)).runnerOperator, op.address, "the release did NOT happen, and the host does not believe it did");
});
