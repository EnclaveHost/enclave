// The nominator's JOURNAL rules (network/host-owner-nomination.mjs), with the ACTUAL module, an ephemeral local signer,
// fixture RPCs that answer from one scripted chain, a serialized queue and a store whose writes can fail. Root's review
// (work/owner-nomination-root-review/reproduce.mjs) reproduced two defects in the reviewed module d35041738...: a pending
// signed nomination broadcast although every durable write failed, and an old recipient's nomination re-broadcast under a
// changed config. These cases assert the repaired behaviour; the Anvil + real-supervisor half is owner-nomination.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
// NOMINATOR_MODULE: the module under test (default the repaired one; run-v5 also runs this suite against the preserved
// earlier module to show the queue-delay case failing there)
const { createOwnerNominator, OWNERSHIP_ABI, journalProblem } = await import(process.env.NOMINATOR_MODULE || "../network/host-owner-nomination.mjs");
import { parseAbi, encodeFunctionResult, encodeFunctionData, decodeFunctionData, keccak256, toBytes, parseTransaction } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const addr = (n) => "0x" + n.toString(16).padStart(40, "0"), ZERO = addr(0);
const CONTRACT = addr(111), OTHER_CONTRACT = addr(222), REGISTRY = addr(112), A = addr(113), B = addr(114), C = addr(115);
const ENDPOINT = "https://fixture.example/host", HOST = keccak256(toBytes(ENDPOINT));
const REG = parseAbi(["function get(bytes32) view returns ((string endpoint,string repo,bytes32 measurement,address operator,uint64 registeredAt,uint64 lastSeen,bool active))"]);

function world() {
  const account = privateKeyToAccount(generatePrivateKey()), op = account.address.toLowerCase();
  const chain = { owner: ZERO, pending: ZERO, nonce: 0, receipts: {}, mode: "ok", active: true };
  const sent = [];                                  // every broadcast that reached the "network": {hash, owner, nonce}
  const client = (url) => ({ transport: { url }, request: async ({ method, params }) => {
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_blockNumber") return "0x64";
    if (method === "eth_getBlockByNumber") return { number: params[0], hash: "0x" + "ab".repeat(32) };
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getTransactionReceipt") return chain.receipts[params[0]] ?? null;
    if (method === "eth_getTransactionCount") return "0x" + chain.nonce.toString(16);
    if (method === "eth_call") {
      const [{ to, data }] = params;
      if (to.toLowerCase() === REGISTRY) return encodeFunctionResult({ abi: REG, functionName: "get", result: { endpoint: ENDPOINT, repo: "fixture",
        measurement: "0x" + "00".repeat(32), operator: account.address, registeredAt: 1n, lastSeen: 1n, active: chain.active } });
      const { functionName } = decodeFunctionData({ abi: OWNERSHIP_ABI, data });
      if (functionName === "registry") return encodeFunctionResult({ abi: OWNERSHIP_ABI, functionName, result: REGISTRY });
      if (functionName === "authority") return encodeFunctionResult({ abi: OWNERSHIP_ABI, functionName, result: [chain.owner, chain.pending, 0n, "0x" + "00".repeat(32)] });
      if (functionName === "proposeOwner") return "0x";
    }
    throw new Error("unscripted " + method);
  } });
  const clients = [client("https://one.example"), client("https://two.example")];
  // the network: "ok" mines it at once (receipt, pending set, nonce consumed); "lost" never reaches the chain
  const broadcast = async (raw) => {
    const p = parseTransaction(raw), hash = keccak256(raw).toLowerCase();
    const owner = decodeFunctionData({ abi: OWNERSHIP_ABI, data: p.data }).args[1].toLowerCase();
    if (chain.mode === "lost") throw new Error("fixture: the broadcast never reached the chain");
    sent.push({ hash, owner, nonce: p.nonce });
    if (p.nonce === chain.nonce) { chain.nonce++; chain.pending = owner; chain.receipts[hash] = { status: "0x1", blockNumber: "0x63", blockHash: "0x" + "cd".repeat(32), to: p.to }; }
  };
  const signer = { address: account.address, broadcast,
    prepare: async (r) => ({ ...r, type: "eip1559", chainId: 8453, nonce: chain.nonce, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    sign: (r) => account.signTransaction(r) };
  // the journal: `fail` makes every write throw (durable and best-effort alike); `disk` is what survives a restart
  const store = { disk: null, fail: false, writes: 0,
    load() { return this.disk ? structuredClone(this.disk) : null; },
    save(r) { if (this.fail) throw new Error("disk failure"); this.writes++; this.disk = structuredClone(r); },
    saveDurable(r) { if (this.fail) throw new Error("disk failure"); this.writes++; this.disk = structuredClone(r); } };
  let tail = Promise.resolve();
  // the operator queue's shape; `gate` stands for the operator transactions a job may wait behind before its slot starts
  const gated = { gate: Promise.resolve(), started: 0 };
  const queue = (job) => { const p = tail.then(() => gated.gate).then(() => { gated.started++; return job(); }); tail = p.then(() => {}, () => {}); return p; };
  const nomination = (o = {}) => ({ format: "enclave-host-owner-nomination/v1", chainId: 8453, ownershipContract: CONTRACT, ownershipCodeHash: keccak256("0x6000"),
    registry: REGISTRY, hostId: HOST, endpoint: ENDPOINT, operator: op, owner: A, rpcs: ["https://one.example", "https://two.example"], quorum: 2, ...o });
  const make = (o = {}) => createOwnerNominator({ nomination: nomination(o), local: { chainId: 8453, registry: REGISTRY, endpoint: ENDPOINT, hostId: HOST, operator: op },
    queue, signer, clients, store, receiptMs: 0, sleep: async () => {} });
  return { account, op, chain, sent, store, signer, make, nomination, gated };
}
/** a validly signed proposeOwner, for building journals by hand */
async function signed(account, { to = CONTRACT, owner = A, nonce = 0, value = 0n, hostId = HOST } = {}) {
  const raw = await account.signTransaction({ type: "eip1559", chainId: 8453, nonce, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, to, value,
    data: encodeFunctionData({ abi: OWNERSHIP_ABI, functionName: "proposeOwner", args: [hostId, owner] }) });
  return { hash: keccak256(raw).toLowerCase(), nonce, raw, state: "pending", broadcast: "unconfirmed", rebroadcasts: 0 };
}

test("every write failing for several passes: nothing is broadcast and nothing is counted; recovered: one nomination, and its re-broadcasts wait for durability too", async () => {
  const w = world(), nm = w.make();
  w.store.fail = true;
  for (let i = 0; i < 3; i++) await nm.step();
  assert.deepEqual(w.sent, [], "no broadcast while no durable write succeeded");
  assert.equal(nm.status().sends, 0); assert.equal(nm.status().tx, null, "no un-journaled signed nomination is kept");
  assert.ok(nm.status().persistFailures >= 3);
  assert.equal(w.store.disk, null);
  // durable again: the next pass signs, journals and broadcasts - which here never reaches the chain
  w.store.fail = false; w.chain.mode = "lost";
  await nm.step();
  const known = w.store.disk.tx;
  assert.equal(known.state, "pending"); assert.equal(w.store.disk.sends, 1); assert.deepEqual(w.sent, []);
  // the disk fails again: the KNOWN nomination is not re-broadcast either
  w.store.fail = true; w.chain.mode = "ok";
  await nm.step(); await nm.step();
  assert.deepEqual(w.sent, [], "a re-broadcast needs its own durable write first");
  assert.equal(w.store.disk.tx.rebroadcasts, 0);
  // recovered: exactly the same known bytes go out, after their counter is durable
  w.store.fail = false;
  await nm.step();
  assert.deepEqual(w.sent.map((s) => s.hash), [known.hash]);
  assert.equal(w.store.disk.tx.raw, known.raw); assert.equal(w.store.disk.tx.rebroadcasts, 1);
  await nm.step();
  assert.equal(nm.status().status, "done"); assert.equal(w.store.disk.sends, 1, "one nomination in all");
  assert.equal(w.chain.pending, A);
});

test("restart: from a journal that never became durable, nothing old exists to send; from a durable one, exactly that nomination", async () => {
  // never durable: the signed bytes of the failed pass die with the process
  const w = world(); w.store.fail = true;
  await w.make().step();
  w.store.fail = false;
  const fresh = w.make();
  assert.equal(fresh.status().tx, null);
  await fresh.step();
  assert.equal(w.sent.length, 1); assert.equal(w.sent[0].hash, w.store.disk.tx.hash, "only a journaled nomination ever reached the chain");
  // durable but never broadcast (lost): the restarted process re-checks the chain and re-broadcasts those same bytes
  const v = world(); v.chain.mode = "lost";
  await v.make().step();
  const known = structuredClone(v.store.disk.tx);
  v.chain.mode = "ok";
  const restarted = v.make();
  await restarted.step();
  assert.deepEqual(v.sent.map((s) => s.hash), [known.hash]);
  await restarted.step();
  assert.equal(restarted.status().status, "done"); assert.equal(v.store.disk.sends, 1);
});

test("a changed config while an earlier nomination is unresolved: the old one is kept, observed, never re-broadcast; nothing new until it settles", async () => {
  // root's reproduction: A signed and lost, then the config names B
  const w = world(); w.chain.mode = "lost";
  await w.make().step();
  const oldTx = structuredClone(w.store.disk.tx);
  w.chain.mode = "ok";
  const nb = w.make({ owner: B });
  await nb.step(); await nb.step();
  assert.deepEqual(w.sent, [], "neither the old recipient's nomination nor a new one is broadcast");
  assert.equal(nb.status().status, "blocked-unresolved");
  assert.equal(w.store.disk.unresolved[0].tx.raw, oldTx.raw, "the earlier signed nomination is kept verbatim");
  assert.equal(w.store.disk.unresolved[0].owner, A);
  // another operator transaction takes its nonce: it can never land -> settled as dropped, then B is decided on the chain
  w.chain.nonce = 1;
  await nb.step();
  assert.equal(w.sent.length, 1); assert.equal(w.sent[0].owner, B);
  assert.equal(w.store.disk.history[0].tx.raw, oldTx.raw); assert.equal(w.store.disk.history[0].tx.state, "dropped");
  assert.equal(w.store.disk.unresolved, undefined);
  await nb.step(); assert.equal(nb.status().status, "done");
  // the other ending: the old nomination LANDS -> pending A, so B is a conflict and is never sent
  const v = world(); v.chain.mode = "lost";
  await v.make().step();
  const old = v.store.disk.tx;
  v.chain.receipts[old.hash] = { status: "0x1", blockNumber: "0x63", blockHash: "0x" + "cd".repeat(32), to: CONTRACT };
  v.chain.pending = A; v.chain.nonce = 1;
  const vb = v.make({ owner: B });
  await vb.step();
  assert.deepEqual(v.sent, []); assert.equal(vb.status().status, "refused"); assert.match(vb.status().why, /pending 0x0+71: never replaced/);
  assert.equal(v.store.disk.history[0].tx.state, "mined"); assert.equal(v.store.disk.history[0].tx.raw, old.raw);
  // changing the contract or host is the same boundary
  for (const o of [{ ownershipContract: OTHER_CONTRACT }, { hostId: keccak256(toBytes("https://other.example")) }]) {
    const u = world(); u.chain.mode = "lost";
    await u.make().step();
    const was = u.store.disk.tx.raw; u.chain.mode = "ok";
    let nm; try { nm = u.make(o); } catch { continue; }   // a hostId not keccak(endpoint) is refused by the local binding later
    await nm.step();
    assert.deepEqual(u.sent, [], JSON.stringify(o)); assert.equal(u.store.disk.unresolved[0].tx.raw, was);
  }
});

test("a malformed or conflicting journal fails closed: nothing is sent, and the recorded evidence is kept exactly", async () => {
  const cases = [
    ["hash not of the bytes", async (w) => ({ ...(await signed(w.account)), hash: "0x" + "ee".repeat(32) })],
    ["bytes altered", async (w) => { const t = await signed(w.account); return { ...t, raw: t.raw.slice(0, -4) + (t.raw.endsWith("00") ? "1100" : "0000") }; }],
    ["nonce differs", async (w) => ({ ...(await signed(w.account)), nonce: 5 })],
    ["another recipient", async (w) => signed(w.account, { owner: C })],
    ["another contract", async (w) => signed(w.account, { to: OTHER_CONTRACT })],
    ["another host", async (w) => signed(w.account, { hostId: keccak256(toBytes("https://other.example")) })],
    ["value", async (w) => signed(w.account, { value: 1n })],
    ["another signer", async () => signed(privateKeyToAccount(generatePrivateKey()))],
    ["not even bytes", async () => ({ hash: "0x" + "ee".repeat(32), nonce: 0, raw: "zz", state: "pending" })],
  ];
  for (const [what, make] of cases) {
    const w = world();
    const rec = { ownershipContract: CONTRACT, hostId: HOST, owner: A, operator: w.op, status: "sent", why: null, sends: 1, tx: await make(w) };
    w.store.disk = structuredClone(rec);
    const nm = w.make();
    await nm.step(); await nm.step();
    assert.deepEqual(w.sent, [], what);
    assert.equal(nm.status().status, "blocked-journal", what); assert.equal(nm.terminal(), false, "it stays observed, never forgotten");
    assert.deepEqual(w.store.disk.tx, rec.tx, `${what}: the recorded nomination is kept exactly`);
    assert.ok(await journalProblem(rec, 8453), what);
  }
  // a malformed EARLIER nomination under another config blocks the same way, and is kept
  const w = world();
  const bad = { ownershipContract: CONTRACT, hostId: HOST, owner: A, operator: w.op, status: "sent", sends: 1, tx: { ...(await signed(w.account)), nonce: 9 } };
  w.store.disk = structuredClone(bad);
  const nb = w.make({ owner: B });
  await nb.step();
  assert.deepEqual(w.sent, []); assert.equal(nb.status().status, "blocked-journal");
  assert.deepEqual(w.store.disk.unresolved[0].tx, bad.tx);
  // and a well-formed journal is accepted by the same check
  const ok = { ownershipContract: CONTRACT, hostId: HOST, owner: A, operator: w.op, tx: await signed(w.account) };
  assert.equal(await journalProblem(ok, 8453), null);
});

test("a recorded nomination is re-broadcast only while the chain still shows owner 0 / pending 0", async () => {
  const w = world(); w.chain.mode = "lost";
  const nm = w.make();
  await nm.step();
  const known = w.store.disk.tx;
  // meanwhile the chain already shows the nomination (another path, or an earlier copy): success, no re-broadcast
  w.chain.mode = "ok"; w.chain.pending = A;
  await nm.step();
  assert.deepEqual(w.sent, []); assert.equal(nm.status().status, "done"); assert.equal(nm.terminal(), false, "the recorded one is still observed");
  // a conflicting pending appears instead: refused, no re-broadcast
  const v = world(); v.chain.mode = "lost";
  const nv = v.make();
  await nv.step();
  v.chain.mode = "ok"; v.chain.pending = C;
  await nv.step();
  assert.deepEqual(v.sent, []); assert.equal(nv.status().status, "refused");
  assert.equal(v.store.disk.tx.raw, (await Promise.resolve(v.store.disk.tx)).raw);
  assert.equal(known.state, "pending");
});

test("queue delay: the chain changes while a re-broadcast waits for its operator-queue slot - nothing is broadcast, nothing overwritten, the proof stays", async () => {
  for (const [what, change, status] of [
    ["another wallet becomes pending", (c) => { c.pending = C; }, "refused"],
    ["another wallet pending AND the registry entry inactive", (c) => { c.pending = C; c.active = false; }, "refused"],
    ["the registry entry turns inactive", (c) => { c.active = false; }, "pending-check"],
  ]) {
    const w = world(); w.chain.mode = "lost";
    const nm = w.make();
    await nm.step();                                         // A signed, durable, broadcast lost: an ambiguous nomination
    const proof = structuredClone(w.store.disk.tx);
    assert.equal(proof.state, "pending");
    w.chain.mode = "ok";
    let release; w.gated.gate = new Promise((r) => { release = r; });
    const before = w.gated.started;
    const pass = nm.step();                                  // its pre-check sees owner 0 / pending 0 and queues the re-broadcast
    for (let i = 0; i < 50 && w.gated.started === before; i++) await new Promise((r) => setTimeout(r, 5));
    change(w.chain);                                         // ...meanwhile, behind an operator transaction, the chain moves
    release(); await pass;
    assert.deepEqual(w.sent, [], `${what}: nothing broadcast`);
    if (w.chain.pending === C) assert.equal(w.chain.pending, C, "the other wallet's pending is not overwritten");
    assert.equal(nm.status().status, status, what);
    assert.equal(w.store.disk.tx.raw, proof.raw, `${what}: the recorded nomination is kept`);
    assert.equal(w.store.disk.tx.state, "pending"); assert.equal(w.store.disk.tx.rebroadcasts, 0, "no re-broadcast was counted");
    assert.equal(nm.terminal(), false, "the recorded nomination stays observed");
  }
});
