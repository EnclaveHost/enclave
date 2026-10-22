// An app-funded claim whose OWN transaction landed must not be reported "consumed by another operation" because the host's
// RPCs could not confirm its receipt in time (2026-10-21: rate-limited public providers; "quorum did not agree"). The host
// re-checks its relays' reported hashes and the reserve's log a bounded few times; success is still ONLY a quorum-verified
// receipt of exactly the signed intent - when none verifies, it stays NonceConsumed. Local anvil, fixture keys only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as viem from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";
import { startWorld, haveAnvil } from "./helpers/lease-gas-world.mjs";

const T = { skip: !haveAnvil && "needs anvil", timeout: 180_000 };
let W, relay, dep; const closers = [];
/** an RPC origin in front of anvil that answers 429 to receipt/transaction/log reads while `state.until` is in the future */
async function flaky() {
  const state = { until: 0, refused: 0 };
  const s = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
    let j = null; try { j = JSON.parse(b); } catch {}
    if (j && Date.now() < state.until && ["eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getLogs"].includes(j.method)) {
      state.refused++;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, error: { code: 429, message: "Too Many Requests" } }));
    }
    const r = await fetch(W.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: b });
    res.writeHead(r.status, { "content-type": "application/json" }); res.end(await r.text()); }); });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  closers.push(() => { s.closeAllConnections(); s.close(); });
  return { state, client: viem.createPublicClient({ chain: W.chain, transport: viem.http(`http://127.0.0.1:${s.address().port}`, { retryCount: 0, timeout: 3000 }) }) };
}
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  dep = { chainId: 8453, ...W.addr };
  const k = generatePrivateKey(); await W.fund(privateKeyToAccount(k).address);
  relay = await B.startLeaseRelay({ client: W.pc, wallet: W.wc(k), deployment: dep, allowLoopbackHttp: true });   // the relay's own RPC is healthy
  closers.push(() => relay.close());
});
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } W?.stop(); });

async function enrolledOperator(tag) {
  const owner = await W.owner(), id = await W.create(owner); await W.enable(owner, id);
  return { id, op: await W.operator(`https://consumed-${tag}.test`) };
}
const hostClient = (op, ps, o = {}) => B.createLeaseClient({ clients: ps.map((p) => p.client), account: op.account, reserve: dep.reserve, deployment: dep,
  relays: [relay.url], allowLoopbackHttp: true, confirmations: 0, requestTimeoutMs: 1500, consumedRecheckMs: [1000, 1000, 2000, 2000], ...o });

test("the host's RPCs cannot confirm its OWN landed claim for a while: re-checked, verified by the quorum, NOT 'another operation'", T, async () => {
  const { id, op } = await enrolledOperator("heals");
  const ps = [await flaky(), await flaky()];
  for (const p of ps) p.state.until = Date.now() + 4500;     // longer than the inner wait and the log search; shorter than the re-checks
  const r = await hostClient(op, ps).claim(id, op.enclaveId);
  assert.ok(ps.every((p) => p.state.refused > 0), "the receipt reads really were refused first");
  assert.equal(r.receipt.status, "success");
  assert.equal((await W.row(id)).runnerOperator, op.address);
  const paid = await W.pc.getContractEvents({ address: dep.reserve, abi: W.A.reserve.abi, eventName: "LeaseGasPaid", args: { id }, fromBlock: 0n });
  assert.equal(paid.length, 1); assert.equal(paid[0].transactionHash, r.hash, "the verified hash is the one transaction that landed");
});

test("when its receipt never verifies, a consumed nonce is still NonceConsumed - never a blind success", T, async () => {
  const { id, op } = await enrolledOperator("never");
  const ps = [await flaky(), await flaky()];
  for (const p of ps) p.state.until = Date.now() + 10 * 60_000;
  await assert.rejects(hostClient(op, ps).claim(id, op.enclaveId),
    (e) => e.code === "NonceConsumed" && /no receipt of this signed lease verified \(re-checked 4 times\)/.test(e.message));
  assert.equal((await W.row(id)).runnerOperator, op.address, "it did land: the host only declines to call it success without a verified receipt");
});
