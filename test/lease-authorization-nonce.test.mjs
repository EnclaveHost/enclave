// The sponsored release right after the host's own final proof (proveAndRelease), metal0 2026-10-21: the operator key had
// never been delegated (its lease was claimed operator-paid, lease nonce 0), so the release carries an EIP-7702
// authorization at the account's nonce. The host's client reads that nonce at its verified block, two confirmations
// behind; the relay checks it at the head, where the proof transaction already counts - "StaleAuthorization 23591 is not
// the account's 23592" - and the signed release is held to its deadline. Local anvil, the real contracts, the real relay
// service, fixture keys only. LEASE_CLIENT_UNDER_TEST names the client module (default ../client/lease-executor-client.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startRelayService } from "../network/lease-relay-service.mjs";
import { startWorld, haveAnvil } from "./helpers/lease-gas-world.mjs";
const B = await import(process.env.LEASE_CLIENT_UNDER_TEST || "../client/lease-executor-client.mjs");

const T = { skip: !haveAnvil && "needs anvil", timeout: 180_000 };
let W, dir, rec, digest, svc; const closers = [];
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-nonce-"));
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, W.addr[k]])) }));
  rec = path.join(dir, "record.json"); fs.writeFileSync(rec, bytes);
  digest = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
  const k = generatePrivateKey(); await W.fund(privateKeyToAccount(k).address, 10n ** 16n);
  const keyFile = path.join(dir, "relay.key"); fs.writeFileSync(keyFile, k + "\n", { mode: 0o600 });
  // the relay checks at the head (its default: confirmations 0), as the production relays do
  svc = await startRelayService({ recordFile: rec, digest, rpcs: [W.rpcUrl], quorum: 1, keyFile, allowLoopbackHttp: true, maxFloatEth: "0.02",
    log: () => {}, relayOptions: { requestTimeoutMs: 20_000, receiptTimeoutMs: 4000 } });
  closers.push(() => svc.close());
});
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } W?.stop(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

/** an undelegated runner (claimed operator-paid, like the production lease) whose last act is its own final proof */
async function runnerAfterOwnTx(endpoint) {
  const owner = await W.owner(), id = await W.create(owner); await W.enable(owner, id);
  const op = await W.operator(endpoint);
  await W.fund(op.address, 10n ** 17n);
  await W.write(op.key, W.addr.ledger, W.A.ledger.abi, "claim", [id, op.enclaveId]);
  await W.rpc("anvil_mine", ["0x4"]);
  await W.send(op.key, { to: op.address, value: 0n, label: "the final proof (an operator transaction)" });   // receipt awaited
  await W.fund(op.address, 0n);
  return { id, op, nonceAfterProof: await W.pc.getTransactionCount({ address: op.address }) };
}
const client = (op, rpc, o = {}) => B.createLeaseClient({ clients: [rpc], account: op.account, reserve: W.addr.reserve,
  deployment: { chainId: 8453, ...W.addr }, relays: [svc.url], allowLoopbackHttp: true, confirmations: 2, requestTimeoutMs: 20_000,
  consumedRecheckMs: [500], ...o });
/** the chain keeps producing blocks while the host works (Base: every 2 s) */
function miner(t) { const m = setInterval(() => W.rpc("evm_mine", []).catch(() => {}), 300); t.after(() => clearInterval(m)); }

test("a sponsored release right after the host's own transaction: the authorization names the account's CURRENT nonce and lands", T, async (t) => {
  const { id, op, nonceAfterProof } = await runnerAfterOwnTx("https://auth-nonce-a.test");
  const signed = [];
  miner(t);
  const r = await client(op, W.pc, { onSigned: (s) => { signed.push(s); } }).release(id);
  assert.equal(r.receipt.status, "success");
  assert.equal((await W.row(id)).runnerOperator.toLowerCase(), "0x0000000000000000000000000000000000000000", "the lease is released");
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n, "the app's reserve paid, never the host");
  assert.equal(signed.length, 1, "exactly one signed lease, the one that landed");
  const tx = await W.pc.getTransaction({ hash: r.hash });
  assert.equal(tx.authorizationList?.[0]?.nonce, nonceAfterProof, "authorized at the nonce after the proof");
});

test("a key transaction that never reaches a verified block: nothing is signed, nothing is sent, the refusal says why", T, async (t) => {
  const { id, op } = await runnerAfterOwnTx("https://auth-nonce-b.test");
  // a provider whose head keeps counting one more transaction of this key than any block holds (a stuck/pending send)
  const s = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
    const j = JSON.parse(b);
    const r = await fetch(W.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: b }).then((x) => x.json());
    if (j.method === "eth_getTransactionCount" && j.params[1] === "latest") r.result = "0x" + (BigInt(r.result) + 1n).toString(16);
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r)); }); });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok)); t.after(() => { s.closeAllConnections(); s.close(); });
  const { createPublicClient, http: viemHttp } = await import("viem");
  const rpc = createPublicClient({ chain: W.chain, transport: viemHttp(`http://127.0.0.1:${s.address().port}`) });
  const signed = [], posted = [];
  const fetchImpl = (u, i) => { if (String(u).endsWith("/v1/lease")) posted.push(u); return fetch(u, i); };
  miner(t);
  await assert.rejects(client(op, rpc, { onSigned: (x) => { signed.push(x); }, fetchImpl, nonceSettleMs: 3000, nonceSettlePollMs: 300 }).release(id),
    (e) => e.code === "NonceUnsettled" && /nothing was signed/.test(e.message));
  assert.deepEqual(signed, []); assert.deepEqual(posted, []);
  assert.equal((await W.row(id)).runnerOperator, op.address, "the lease is untouched");
});
