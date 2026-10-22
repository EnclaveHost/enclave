// Shared resolver (client/lease-executor-client.mjs resolveSigned, used by the Linux supervisor journal and the Windows
// release journal): a journaled signed lease is settled ONLY within the domain RECORDED with it - its chain, reserve,
// executor and ledger (root review P1/P2). A receipt in the CURRENT domain whose lease fields happen to match is NOT
// proof that the recorded operation ran; a record without that identity stays HELD. Local anvil, fixture keys only.
//   R1 = the world's reserve/executor; R2 = a second reserve/executor on the same ledger.
//   1. the operator signs a release under R1 (held by its relay, never landing);
//   2. the SAME operator's operation with IDENTICAL lease fields (id, kind, nonce, deadline, payee, max charge) lands
//      through R2 (sent directly with a fixture key: the executors share the operator's nonce storage);
//   3. a client pinned to R2 must NOT declare the R1 record landed, nor an identity-less record; an R2-recorded entry
//      with those fields IS landed (the positive control); under R1 the record is fenced by the consumed nonce.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as viem from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";
import { startWorld, haveAnvil, ZERO32, DEPLOYER } from "./helpers/b-world.mjs";

const T = { skip: !haveAnvil && "needs anvil", timeout: 180_000 };
let W, R2, relayKey, relay1, front; const closers = [];
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  R2 = await W.newReserve();
  relayKey = generatePrivateKey(); await W.fund(privateKeyToAccount(relayKey).address);
  relay1 = await B.startLeaseRelay({ client: W.pc, wallet: W.wc(relayKey), deployment: { chainId: 8453, ...W.addr }, allowLoopbackHttp: true });
  closers.push(() => relay1.close());
  // a front for relay1 that answers /v1/info but HOLDS every lease POST (never forwards, never answers)
  front = http.createServer(async (req, res) => {
    if (req.method !== "POST") { const x = await fetch(relay1.url + req.url); res.writeHead(x.status, { "content-type": "application/json" }); return res.end(await x.text()); }
    for await (const _ of req);   // held
  });
  await new Promise((ok) => front.listen(0, "127.0.0.1", ok));
  front.url = `http://127.0.0.1:${front.address().port}`;
  closers.push(() => { front.closeAllConnections(); front.close(); });
});
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } W?.stop(); });
const dep1 = () => ({ chainId: 8453, ...W.addr });
const dep2 = () => ({ chainId: 8453, reserve: R2.reserve, executor: R2.executor, ledger: W.addr.ledger, registry: W.addr.registry,
  reserveCodeHash: R2.reserveCodeHash, executorCodeHash: R2.executorCodeHash });
const client = (op, deployment, relays, onSigned) => B.createLeaseClient({ client: W.pc, account: op.account, reserve: deployment.reserve, deployment,
  relays, allowLoopbackHttp: true, confirmations: 0, requestTimeoutMs: 2000, overallTimeoutMs: 20_000, onSigned });

test("a matching-field receipt in ANOTHER domain, or with an unrecorded domain, is not the recorded lease's success", T, async () => {
  const owner = await W.owner(), id = await W.create(owner);
  await W.enable(owner, id);                          // R1
  await W.enable(owner, id, { reserve: R2.reserve });  // R2: the same deployment enrolled in a second reserve
  const op = await W.operator("https://resolve-domain.test");
  await client(op, dep1(), [relay1.url]).claim(id, op.enclaveId);
  // 1. the release signed under R1 (journaled by onSigned), held by its relay
  let s = null;
  const fromBlock = await W.pc.getBlockNumber();
  await assert.rejects(client(op, dep1(), [front.url], (x) => { s = x; }).release(id), (e) => e.code === "NotRelayed");
  assert.ok(s && s.reserve === W.addr.reserve && s.executor === W.addr.executor && s.chainId === 8453 && s.ledger === W.addr.ledger);
  const want = { id, kind: 3, enclaveId: ZERO32, nonce: BigInt(s.nonce), deadline: BigInt(s.deadline), maxChargeWei: BigInt(s.lease.maxChargeWei) };
  const payees = [s.payee];
  // 2. the same operator, IDENTICAL lease fields, landed through R2 (re-delegating the key to R2's executor)
  const lease = { ...want, payee: s.payee };
  const signature = await op.account.signTypedData({ domain: { name: "EnclaveLeaseExecutor", version: "1", chainId: 8453, verifyingContract: op.address },
    types: { Lease: [{ name: "reserve", type: "address" }, { name: "id", type: "bytes32" }, { name: "kind", type: "uint8" }, { name: "enclaveId", type: "bytes32" },
      { name: "nonce", type: "uint64" }, { name: "deadline", type: "uint64" }, { name: "payee", type: "address" }, { name: "maxChargeWei", type: "uint256" }] },
    primaryType: "Lease", message: { reserve: R2.reserve, ...lease } });
  const authorization = await op.account.signAuthorization({ contractAddress: R2.executor, chainId: 8453, nonce: await W.pc.getTransactionCount({ address: op.address }) });
  const sender = W.wc(DEPLOYER);
  const fees = await B.currentFees(W.pc);   // what a relay sends with (base fee + 0.001 gwei): the charge stays under the signed maximum
  const hash = await sender.sendTransaction({ to: op.address, data: B.leaseCalldata(lease, signature), authorizationList: [authorization], gas: 1_000_000n,
    maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.priorityFee });
  const rc = await W.pc.waitForTransactionReceipt({ hash });
  assert.equal(rc.status, "success");
  const paid = await W.pc.getContractEvents({ address: R2.reserve, abi: W.A.reserve.abi, eventName: "LeaseGasPaid", fromBlock });
  assert.equal(paid.length, 1); assert.equal(paid[0].args.payee, s.payee);
  // 3. resolved by a client pinned to R2
  const c2 = client(op, dep2(), [relay1.url]);
  const recordedR1 = { operator: op.address, chainId: 8453, reserve: W.addr.reserve, executor: W.addr.executor, ledger: W.addr.ledger };
  const r1 = await c2.resolveSigned(want, fromBlock, payees, recordedR1);
  assert.notEqual(r1.state, "landed", "an R2 receipt is not the R1 lease's success");
  assert.equal(r1.state, "pending");
  const unknown = await c2.resolveSigned(want, fromBlock, payees, { operator: op.address });
  assert.notEqual(unknown.state, "landed", "an identity-less record is never settled by a current-domain receipt");
  assert.equal(unknown.state, "pending");
  // positive control: the entry RECORDED under R2 with those fields is that receipt
  const recordedR2 = { operator: op.address, chainId: 8453, reserve: R2.reserve, executor: R2.executor, ledger: W.addr.ledger };
  const ok = await c2.resolveSigned(want, fromBlock, payees, recordedR2);
  assert.equal(ok.state, "landed"); assert.equal(ok.verified.hash, hash);
  // under its own domain (R1): never "landed"; the key now runs R2's executor, so R1's lane cannot be read as a fence
  // either - the R1 record stays held until its deadline on the recorded chain
  const c1 = client(op, dep1(), [relay1.url]);
  assert.equal((await c1.resolveSigned(want, fromBlock, payees, recordedR1)).state, "pending");
});
