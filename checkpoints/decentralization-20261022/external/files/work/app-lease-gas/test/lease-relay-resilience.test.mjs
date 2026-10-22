// The relay SERVICE (network/lease-relay-service.mjs) with THREE RPC providers and a quorum of TWO: no single provider is
// required - not the first one - and a send whose reply is lost is resolved from the chain by its own hash and
// re-broadcast as the SAME signed bytes, never re-signed at a new nonce (root follow-on 21:31Z). Local anvil behind
// three controllable fixture proxies (loopback, explicit fixture permission); fixture keys only; zero-ETH host.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import * as viem from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";
import { startRelayService } from "../network/lease-relay-service.mjs";
import { startWorld, haveAnvil, ZERO32 } from "./helpers/b-world.mjs";

const T = { skip: !haveAnvil && "needs anvil", timeout: 180_000 };
let W, dir, rec, digest; const P = [], closers = [];
/** A provider in front of anvil. mode: {down, wrongChain, sendRaw: "normal" | "lose-reply" (forwards, then errors) | "blackhole"} */
async function provider() {
  const mode = { down: false, wrongChain: false, sendRaw: "normal", raws: [] };
  const s = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
    if (mode.down) return req.socket.destroy();
    let j = null; try { j = JSON.parse(b); } catch {}
    const answer = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: j?.id, ...o })); };
    if (j?.method === "eth_chainId" && mode.wrongChain) return answer({ result: "0x1" });
    if (j?.method === "eth_sendRawTransaction") {
      mode.raws.push(j.params[0]);
      if (mode.sendRaw === "blackhole") return answer({ error: { code: -32000, message: "upstream timeout" } });
      if (mode.sendRaw === "lose-reply") { await fetch(W.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: b }); return req.socket.destroy(); }
    }
    const r = await fetch(W.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: b });
    res.writeHead(r.status, { "content-type": "application/json" }); res.end(await r.text()); }); });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  closers.push(() => { s.closeAllConnections(); s.close(); });
  return { url: `http://127.0.0.1:${s.address().port}`, mode };
}
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resilience-"));
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, W.addr[k]])) }));
  rec = path.join(dir, "record.json"); fs.writeFileSync(rec, bytes);
  digest = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
  for (let i = 0; i < 3; i++) P.push(await provider());
});
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch {} } W?.stop(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const reset = () => { for (const p of P) Object.assign(p.mode, { down: false, wrongChain: false, sendRaw: "normal", raws: [] }); };
const keyFile = (key) => { const f = path.join(dir, `k-${crypto.randomBytes(4).toString("hex")}`); fs.writeFileSync(f, key + "\n", { mode: 0o600 }); return f; };
async function service(key, o = {}) {
  const svc = await startRelayService({ recordFile: rec, digest, rpcs: P.map((p) => p.url), quorum: 2, keyFile: keyFile(key), allowLoopbackHttp: true,
    maxFloatEth: "0.02", log: () => {}, relayOptions: { requestTimeoutMs: 20_000, receiptTimeoutMs: 4000, ...(o.relayOptions || {}) }, ...o });
  closers.push(() => svc.close());
  return svc;
}
async function relayKey() { const k = generatePrivateKey(); await W.fund(privateKeyToAccount(k).address, 10n ** 16n); return k; }
async function enrolled() { const owner = await W.owner(), id = await W.create(owner); await W.enable(owner, id); return id; }
const hostClient = (op, url) => B.createLeaseClient({ client: W.pc, account: op.account, reserve: W.addr.reserve, deployment: { chainId: 8453, ...W.addr },
  relays: [url], allowLoopbackHttp: true, confirmations: 0, requestTimeoutMs: 20_000 });
async function signedClaim(op, id, payee) {
  const deadline = (await W.pc.getBlock()).timestamp + 300n;
  const lease = { id, kind: 1, enclaveId: op.enclaveId, nonce: 0n, deadline, payee, maxChargeWei: 10n ** 15n };
  const signature = await op.account.signTypedData({ domain: { name: "EnclaveLeaseExecutor", version: "1", chainId: 8453, verifyingContract: op.address },
    types: { Lease: [{ name: "reserve", type: "address" }, { name: "id", type: "bytes32" }, { name: "kind", type: "uint8" }, { name: "enclaveId", type: "bytes32" },
      { name: "nonce", type: "uint64" }, { name: "deadline", type: "uint64" }, { name: "payee", type: "address" }, { name: "maxChargeWei", type: "uint256" }] },
    primaryType: "Lease", message: { reserve: W.addr.reserve, ...lease } });
  const authorization = await op.account.signAuthorization({ contractAddress: W.addr.executor, chainId: 8453, nonce: await W.pc.getTransactionCount({ address: op.address }) });
  return JSON.stringify({ operator: op.address, lease, signature, authorization }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
const post = (url, body) => fetch(`${url}/v1/lease`, { method: "POST", headers: { "content-type": "application/json" }, body }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
/** every transaction the relay key sent, by nonce, read straight from anvil */
async function sentBy(addr, fromBlock) {
  const out = [];
  for (let n = fromBlock; n <= await W.pc.getBlockNumber({ cacheTime: 0 }); n++)
    for (const tx of (await W.pc.getBlock({ blockNumber: n, includeTransactions: true })).transactions) if (viem.getAddress(tx.from) === addr) out.push({ nonce: tx.nonce, hash: tx.hash });
  return out;
}

test("the FIRST provider down at startup and throughout: the service starts on the quorum and lands a zero-ETH host's claim", T, async () => {
  reset(); P[0].mode.down = true;
  const svc = await service(await relayKey());
  const id = await enrolled(), op = await W.operator("https://resilience-a.test");
  const r = await hostClient(op, svc.url).claim(id, op.enclaveId);
  assert.equal(r.receipt.status, "success");
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
});

test("a provider on another chain is outvoted, not obeyed", T, async () => {
  reset(); P[1].mode.wrongChain = true;
  const svc = await service(await relayKey());
  const id = await enrolled(), op = await W.operator("https://resilience-b.test");
  assert.equal((await hostClient(op, svc.url).claim(id, op.enclaveId)).receipt.status, "success");
});

test("the primary accepts the raw transaction then loses its reply (and then every provider does): one transaction, landed, verified by its own hash", T, async () => {
  for (const mode of [["lose-reply", "normal", "normal"], ["lose-reply", "lose-reply", "lose-reply"]]) {
    reset(); mode.forEach((m, i) => (P[i].mode.sendRaw = m));
    const k = await relayKey(), svc = await service(k), payee = privateKeyToAccount(k).address;
    const from = await W.pc.getBlockNumber({ cacheTime: 0 });
    const id = await enrolled(), op = await W.operator(`https://resilience-c-${mode.join("-")}.test`);
    const r = await hostClient(op, svc.url).claim(id, op.enclaveId);
    assert.equal(r.receipt.status, "success", mode.join(","));
    const txs = await sentBy(payee, from);
    assert.equal(txs.length, 1, "exactly one relay transaction");
    assert.equal(new Set(P.flatMap((p) => p.mode.raws)).size, 1, "every provider got the SAME signed bytes");
  }
});

test("an unknown outcome that never landed: the restarted relay re-broadcasts the SAME bytes, signs nothing new at that nonce, then serves again", T, async () => {
  reset(); for (const p of P) p.mode.sendRaw = "blackhole";
  const k = await relayKey(), payee = privateKeyToAccount(k).address, stateFile = path.join(dir, "relay-send.json");
  const from = await W.pc.getBlockNumber({ cacheTime: 0 });
  const svc1 = await service(k, { stateFile });
  const idA = await enrolled(), opA = await W.operator("https://resilience-d.test");
  const a = await post(svc1.url, await signedClaim(opA, idA, payee));
  assert.equal(a.status, 502, JSON.stringify(a.body));
  const record = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(record.raw && record.hash && Number.isInteger(record.nonce), "the signed bytes were durable before any provider had them");
  assert.deepEqual(await sentBy(payee, from), [], "nothing landed");
  await svc1.close();
  // the providers recover; the relay restarts on the same state file
  reset();
  const svc2 = await service(k, { stateFile });
  const idB = await enrolled(), opB = await W.operator("https://resilience-e.test");
  const b = await post(svc2.url, await signedClaim(opB, idB, payee));
  assert.equal(b.status, 422); assert.equal(b.body.error, "RelayBusy");
  assert.deepEqual(new Set(P.flatMap((p) => p.mode.raws)), new Set([record.raw]), "only the recorded bytes were (re-)broadcast");
  // those bytes land (A's claim); then the relay serves B at the NEXT nonce
  for (let i = 0; i < 20 && (await sentBy(payee, from)).length === 0; i++) await new Promise((ok) => setTimeout(ok, 250));
  assert.deepEqual(await sentBy(payee, from), [{ nonce: record.nonce, hash: record.hash }], "the nonce was used by the recorded transaction itself");
  assert.equal((await W.row(idA)).runnerOperator, opA.address);
  const b2 = await post(svc2.url, await signedClaim(opB, idB, payee));
  assert.equal(b2.status, 200, JSON.stringify(b2.body));
  const txs = await sentBy(payee, from);
  assert.deepEqual(txs.map((t) => t.nonce), [record.nonce, record.nonce + 1]);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).raw, undefined, "resolved: no unresolved send left");
});

test("the primary accepts the raw transaction, its reply is lost and it sits UNMINED: nothing else is signed until that nonce resolves", T, async () => {
  reset(); P[0].mode.sendRaw = "lose-reply"; P[1].mode.sendRaw = P[2].mode.sendRaw = "blackhole";
  const k = await relayKey(), payee = privateKeyToAccount(k).address, svc = await service(k);
  const idA = await enrolled(), opA = await W.operator("https://resilience-g.test"), idB = await enrolled(), opB = await W.operator("https://resilience-h.test");
  const bodyA = await signedClaim(opA, idA, payee), bodyB = await signedClaim(opB, idB, payee);
  const n0 = await W.pc.getTransactionCount({ address: payee });
  await W.rpc("evm_setAutomine", [false]);
  try {
    const a = await post(svc.url, bodyA);
    assert.equal(a.status, 502, JSON.stringify(a.body));          // not quorum-confirmed: it is in a mempool, unmined
    const b = await post(svc.url, bodyB);
    assert.equal(b.status, 422, JSON.stringify(b.body)); assert.equal(b.body.error, "RelayBusy");
    assert.equal(new Set(P.flatMap((p) => p.mode.raws)).size, 1, "ONE signature: no second transaction at that nonce or after it while it is unresolved");
  } finally { await W.rpc("evm_setAutomine", [true]); }
  reset();
  await W.rpc("evm_mine", []);
  assert.equal((await W.row(idA)).runnerOperator, opA.address, "the one signed transaction (A's claim) landed");
  const b2 = await post(svc.url, bodyB);
  assert.equal(b2.status, 200, JSON.stringify(b2.body));
  assert.equal(await W.pc.getTransactionCount({ address: payee }), n0 + 2, "A at its nonce, then B at the next");
});

test("a send record signed by ANOTHER key is refused at startup, never re-broadcast", T, async () => {
  reset();
  const other = await relayKey(), mine = await relayKey(), stateFile = path.join(dir, "other-send.json");
  const acct = privateKeyToAccount(other);
  const raw = await acct.signTransaction({ chainId: 8453, type: "eip1559", nonce: 0, to: acct.address, value: 0n, gas: 21_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n });
  fs.writeFileSync(stateFile, JSON.stringify({ nonce: 0, raw, hash: viem.keccak256(raw) }));
  await assert.rejects(service(mine, { stateFile }), /not this relay's send record \(signed by another key\)/);
  assert.deepEqual(P.flatMap((p) => p.mode.raws), [], "nothing was broadcast");
  await assert.rejects(service(other, { stateFile: (fs.writeFileSync(stateFile, JSON.stringify({ nonce: 1, raw, hash: viem.keccak256(raw) })), stateFile) }),
    /not this relay's send record \(chain 8453, nonce 0\)/, "a record whose nonce is not its transaction's");
});

// root review (2026-10-20): the persisted state is EXACTLY {} (nothing unresolved) or this key's {nonce, raw, hash}.
// Anything else - null, an array, a string, a partial or foreign object, non-JSON, an empty, oversized or non-regular
// file - refuses startup: the file is not cleared or overwritten, nothing is signed and nothing is broadcast.
test("a malformed or partial send record refuses startup: never read as empty, never overwritten, nothing signed or broadcast", T, async () => {
  reset();
  const k = await relayKey(), payee = privateKeyToAccount(k).address, acct = privateKeyToAccount(k);
  const raw = await acct.signTransaction({ chainId: 8453, type: "eip1559", nonce: 0, to: acct.address, value: 0n, gas: 21_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n });
  const hash = viem.keccak256(raw);
  const cases = [["null", "null"], ["an array", "[]"], ["a string", '"x"'], ["a number", "0"], ["a nonce only", '{"nonce":123}'], ["an empty raw", '{"raw":""}'],
    ["an arbitrary object", '{"foo":1}'], ["raw without hash", JSON.stringify({ nonce: 0, raw })], ["raw and hash without nonce", JSON.stringify({ raw, hash })],
    ["a nonce as a string", JSON.stringify({ nonce: "0", raw, hash })], ["an extra field", JSON.stringify({ nonce: 0, raw, hash, note: 1 })],
    ["{} with a field", '{"pending":false}'], ["not JSON", "{not json"], ["an empty file", ""], ["over 64 KiB", "{}" + " ".repeat(64 * 1024)]];
  const from = await W.pc.getBlockNumber({ cacheTime: 0 });
  const started = [];
  for (const [what, text] of cases) {
    const stateFile = path.join(dir, `bad-${crypto.randomBytes(4).toString("hex")}.json`);
    fs.writeFileSync(stateFile, text);
    const svc = await service(k, { stateFile }).catch((e) => e);
    if (!(svc instanceof Error)) {   // what a relay that read it as empty then does with a real request
      const id = await enrolled(), op = await W.operator(`https://resilience-bad-${crypto.randomBytes(3).toString("hex")}.test`);
      const r = await post(svc.url, await signedClaim(op, id, payee));
      started.push(`${what}: STARTED, a claim answered ${r.status}, the file became ${JSON.stringify(fs.readFileSync(stateFile, "utf8").slice(0, 60))}`);
      await svc.close();
      continue;
    }
    if (!/send record/.test(svc.message)) started.push(`${what}: refused, but not as a send record: ${svc.message.slice(0, 120)}`);
    if (fs.readFileSync(stateFile, "utf8") !== text) started.push(`${what}: the file was changed`);
  }
  for (const [what, make] of [["a directory", (f) => fs.mkdirSync(f)], ["a symlink to {}", (f) => { fs.writeFileSync(f + ".target", "{}"); fs.symlinkSync(f + ".target", f); }]]) {
    const stateFile = path.join(dir, `bad-${crypto.randomBytes(4).toString("hex")}.json`);
    make(stateFile);
    const svc = await service(k, { stateFile }).catch((e) => e);
    if (!(svc instanceof Error)) { started.push(`${what}: STARTED`); await svc.close(); continue; }
    if (!/send record/.test(svc.message)) started.push(`${what}: refused, but not as a send record: ${svc.message.slice(0, 120)}`);
  }
  assert.deepEqual(started, [], "every malformed record must refuse startup, as a send record, leaving the file as it was");
  assert.deepEqual(await sentBy(payee, from), [], "nothing was signed and sent");
  assert.deepEqual(P.flatMap((p) => p.mode.raws), [], "nothing was broadcast");
});

test("the empty state is exactly {} (or no file yet): the relay starts, serves, and leaves exactly {}", T, async () => {
  reset();
  const k = await relayKey(), payee = privateKeyToAccount(k).address;
  for (const initial of ["{}", null]) {
    const stateFile = path.join(dir, `empty-${crypto.randomBytes(4).toString("hex")}.json`);
    if (initial !== null) fs.writeFileSync(stateFile, initial);
    const svc = await service(k, { stateFile });
    const id = await enrolled(), op = await W.operator(`https://resilience-empty-${crypto.randomBytes(3).toString("hex")}.test`);
    const r = await post(svc.url, await signedClaim(op, id, payee));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(fs.readFileSync(stateFile, "utf8"), "{}", "resolved: exactly {}");
    await svc.close();
  }
});
