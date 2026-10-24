// Focused tests: the two stages on the in-memory Base model served by two loopback providers, the reviewed transport
// end to end over loopback HTTP (memory journals), restarts, lost responses, refusals, and static safety properties.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FakeBase, providers, fixtureTrust, memoryJournal, ZERO, OWN_CODE } from "./fake-base.mjs";
import { clientsFor, rpcClient, checkUrl, pair } from "../rpc.mjs";
import { frozen, proposalCall, prepareFund, prepareAccept, verifyFund, verifyAccept, checkFrozen } from "../stages.mjs";
import { stageApp, recoverInterruptedPreparation } from "../stage-app.mjs";
import { assetsFor } from "../page.mjs";
import { PRODUCTION } from "../trust.mjs";
import { preflight } from "../preflight.mjs";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, "..");
const sha = (f) => createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex");
const evidence = JSON.parse(fs.readFileSync(path.join(root, "evidence/metal0-enrollment-unsigned-20261023.json"), "utf8"));
const T = { timeout: 30000 };

async function world(t, { trust: over = {} } = {}) {
  const base = new FakeBase(PRODUCTION), net = await providers(base);
  const trust = fixtureTrust(net.urls, over), clients = clientsFor(net.urls, { timeoutMs: trust.rpcTimeoutMs, allowLoopback: true });
  const journals = { fund: memoryJournal(), accept: memoryJournal() };
  t.after(() => net.close());
  return { base, net, trust, clients, journals };
}
// root's separate operator proposal (after the optional funding gave the operator enough ETH)
const propose = (w, to = w.trust.admin, depth = 3) => (w.base.edit((s) => { s.balance[PRODUCTION.operator] += 5_000_000_000_000n; }), w.base.send({ ...proposalCall(w.trust), data: proposalCall({ ...w.trust, admin: to }).data, gas: 120000 }, depth));
async function serve(t, w, stage, journals = w.journals) {
  const app = stageApp({ stage, trust: w.trust, clients: w.clients, journals, assets: assetsFor(stage) });
  await app.listen(); t.after(() => app.close());
  const { token } = await (await fetch(app.origin + "/request")).json();
  const post = async (url, data = {}) => { const r = await fetch(app.origin + url, { method: "POST", headers: { Origin: app.origin, "X-Signing-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(data) }); return { status: r.status, body: await r.json() }; };
  return { app, post };
}

test("frozen targets/calldata/values equal the public evidence; no stage can target the book or vault; transport unchanged", () => {
  assert.equal(sha("evidence/metal0-enrollment-unsigned-20261023.json"), "9f6eba17c9c479e9006849316f1708f37ee6680f37a990e57e07c421b86e6b82");
  assert.equal(sha("handoff-server.mjs"), "fb189e4610c8579739fb59fe385b91b461bc5bfb06d95780e94ec92e53d95b75", "the reviewed transport is byte-identical");
  const p = evidence.preconditions, [tx1, tx2] = evidence.unsigned;
  assert.deepEqual([p.ownershipContract, p.ownershipCodeHash, p.ownershipRegistry, p.hostId, p.hostEndpoint, p.hostOperator, p.payoutWallet],
    [PRODUCTION.ownership, PRODUCTION.codeHashes.ownership, PRODUCTION.registry, PRODUCTION.hostId, PRODUCTION.hostEndpoint, PRODUCTION.operator, PRODUCTION.admin]);
  const accept = frozen(PRODUCTION, "accept");
  assert.deepEqual([accept.from, accept.to, accept.data, accept.value, accept.chainId], [tx2.from, tx2.to, tx2.data, "0x0", "0x2105"]);
  const prop = proposalCall(PRODUCTION);
  assert.deepEqual([prop.from, prop.to, prop.data], [tx1.from, tx1.to, tx1.data], "the proposal root will send is the evidence's tx1");
  const fund = frozen(PRODUCTION, "fund");
  assert.deepEqual(fund, { from: PRODUCTION.admin, to: PRODUCTION.operator, chainId: "0x2105", value: "0x48c27395000", data: "0x" });
  assert.equal(BigInt(fund.value), 5_000_000_000_000n);
  for (const s of ["fund", "accept"]) {
    const f = frozen(PRODUCTION, s);
    assert.ok(!Object.values(PRODUCTION.excluded).includes(f.to), `${s} targets an excluded contract`);
    assert.ok(!f.data.startsWith("0xba44593c"), `${s} carries the address-book set selector`);
  }
  assert.throws(() => frozen(PRODUCTION, "book"), /stage must be/);
  assert.throws(() => checkFrozen({ stage: "accept", transaction: { ...accept, to: PRODUCTION.excluded.book } }, PRODUCTION), /destination changed/);
  assert.throws(() => checkFrozen({ stage: "fund", transaction: { ...fund, value: "0x48c27395001" } }, PRODUCTION), /value changed/);
});

test("the RPC layer only reads, only https in production, bounded, and needs two different hosts", async () => {
  const c = rpcClient("https://mainnet.base.org", { timeoutMs: 1000 });
  for (const m of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "personal_sign", "eth_signTypedData_v4", "wallet_switchEthereumChain"])
    await assert.rejects(c.request(m, []), /this process only reads/);
  assert.throws(() => checkUrl("http://mainnet.base.org"), /https only/);
  assert.throws(() => checkUrl("https://user:pw@mainnet.base.org"), /no credentials/);
  assert.throws(() => checkUrl("https://mainnet.base.org/?key=1"), /no credentials/);
  assert.throws(() => checkUrl("http://127.0.0.1:1"), /https only/, "loopback only when a test asks for it");
  assert.throws(() => clientsFor(["https://mainnet.base.org", "https://mainnet.base.org/x"], { timeoutMs: 1 }), /duplicate RPC host/);
  assert.throws(() => pair([c]), /two independently operated/);
  for (const f of ["rpc.mjs", "stages.mjs", "stage-app.mjs", "serve.mjs", "preflight.mjs", "page.mjs", "trust.mjs"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    for (const bad of ["eth_sendRawTransaction", "privateKey", "registryKey", "config.json", "signTransaction", "mnemonic"]) assert.ok(!src.includes(bad), `${f} mentions ${bad}`);
    if (f !== "rpc.mjs") assert.ok(!src.includes("eth_sendTransaction"), `${f} mentions eth_sendTransaction`);
  }
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  assert.equal(app.match(/eth_sendTransaction/g).length, 1);
  const sign = app.indexOf("el('sign').onclick"), end = app.indexOf("\n};", sign), send = app.indexOf("eth_sendTransaction");
  assert.ok(sign > 0 && send > sign && send < end, "MetaMask is asked to send only inside the Review click handler");
  const connect = app.indexOf("el('connect').onclick"), connectEnd = app.indexOf("\n};", connect);
  assert.equal(app.match(/eth_requestAccounts/g).length, 1);
  assert.ok(app.indexOf("eth_requestAccounts") > connect && app.indexOf("eth_requestAccounts") < connectEnd, "accounts are requested only inside the Connect click handler");
  const handlers = [[connect, connectEnd], [sign, end], [app.indexOf("el('check').onclick"), app.length]];
  for (const m of app.matchAll(/provider\.request\(/g)) assert.ok(handlers.some(([a, b]) => m.index > a && m.index < b), "every MetaMask request is inside a click handler");
});

test("fund: prepares exactly the fixed transfer from fresh two-provider state", T, async (t) => {
  const w = await world(t);
  const r = await prepareFund(w);
  assert.equal(r.stage, "fund");
  assert.deepEqual(r.transaction, { from: PRODUCTION.admin, to: PRODUCTION.operator, chainId: "0x2105", type: "0x2", nonce: "0x475", data: "0x", value: "0x48c27395000",
    gas: "0x5208", maxFeePerGas: "0xa7d8c0", maxPriorityFeePerGas: "0xf4240" });
  assert.equal(r.anchor.blockNumber, String(w.base.head - 2n));
  assert.equal(r.operatorProposal.gasEstimate, "94321");
  assert.equal(r.operatorProposal.operatorBalanceAfterWei, String(376_132_087_579n + 5_000_000_000_000n));
  assert.equal(r.estimatedFeeLimitWei, String(21000n * 11_000_000n + w.base.l1));
});

test("fund: refused on every state that makes it unnecessary, duplicate, unsafe or unverifiable", T, async (t) => {
  const w = await world(t), b = w.base, s = b.state, settle = () => b.mine(3);
  const cases = [
    ["operator already holds the amount", () => { s.balance[PRODUCTION.operator] = 5_000_000_000_000n; }, /not funded twice/],
    ["operator can already pay", () => { s.balance[PRODUCTION.operator] = 4_000_000_000_000n; }, /can already pay/],
    ["proposal exists", () => { s.authority.pendingOwner = PRODUCTION.admin; }, /proposal already exists/],
    ["administrator already owns", () => { s.authority.owner = PRODUCTION.admin; }, /already owns metal0/],
    ["another owner", () => { s.authority.owner = "0x" + "77".repeat(20); }, /another owner/],
    ["operator has code (7702)", () => { s.code[PRODUCTION.operator] = "0xef0100" + "11".repeat(20); }, /has code/],
    ["registry operator changed", () => { s.entry.operator = "0x" + "66".repeat(20); }, /operator changed/],
    ["host inactive", () => { s.entry.active = false; }, /not active/],
    ["payout changed", () => { s.entry.payoutWallet = "0x" + "55".repeat(20); }, /payout wallet/],
    ["endpoint changed", () => { s.entry.endpoint = "https://evil.example/t/metal0"; }, /endpoint changed/],
    ["ownership code changed", () => { s.code[PRODUCTION.ownership] = OWN_CODE + "00"; }, /not the reviewed code/],
    ["ownership reads another registry", () => { s.ownershipRegistry = "0x" + "44".repeat(20); }, /another registry/],
    ["fee above cap", () => { b.baseFee = 60_000_000n; }, /above the reviewed cap/],
    ["administrator cannot pay", () => { s.balance[PRODUCTION.admin] = 5_000_000_000_000n; }, /does not cover/],
  ];
  for (const [name, edit, re] of cases) {
    const saved = structuredClone(s), fee = b.baseFee;
    edit(); settle();
    await assert.rejects(prepareFund(w), re, name);
    b.edit((x) => Object.assign(x, structuredClone(saved))); b.baseFee = fee; settle();
  }
  await prepareFund(w);   // and the restored state prepares again
  b.submit({ from: PRODUCTION.admin, to: "0x" + "12".repeat(20), value: 1 });
  await assert.rejects(prepareFund(w), /administrator transaction is pending/, "a pending administrator transaction (e.g. a lost-response funding) blocks preparation");
  b.mine(1);
  await assert.rejects(prepareFund(w), /administrator transaction is pending or was mined in the last two blocks/);
  b.mine(2); await prepareFund(w);
  b.submit({ from: PRODUCTION.operator, to: "0x" + "12".repeat(20), value: 1, gas: 21000, maxFeePerGas: 11_000_000 });
  await assert.rejects(prepareFund(w), /operator transaction is pending/);
  b.mine(3);
  w.journals.accept.write({ status: "awaiting-wallet" });
  await assert.rejects(prepareFund(w), /acceptance stage has already started/);
});

test("fund: provider disagreement, wrong chain and a hanging provider are refused within the bound", T, async (t) => {
  const w = await world(t), [p0, p1] = w.net.list;
  p1.override.eth_getBalance = (params, base) => (String(params[0]).toLowerCase() === PRODUCTION.operator ? "0x1" : base.answer("eth_getBalance", params));
  await assert.rejects(prepareFund(w), /disagree/);
  delete p1.override.eth_getBalance;
  p1.override.eth_getBlockByNumber = (params, base) => ({ ...base.answer("eth_getBlockByNumber", params), hash: "0x" + "ab".repeat(32) });
  await assert.rejects(prepareFund(w), /disagree on block/);
  delete p1.override.eth_getBlockByNumber;
  w.base.chainId = 1;
  await assert.rejects(prepareFund(w), /wrong chain/);
  w.base.chainId = 8453;
  p0.hang = true;
  const started = Date.now();
  await assert.rejects(prepareFund(w), /no answer within 800 ms/);
  assert.ok(Date.now() - started < 4000, "bounded by the per-request timeout and one retry");
});

test("accept: NOT READY until the operator's proposal of exactly this administrator is two blocks deep", T, async (t) => {
  const w = await world(t);
  await assert.rejects(prepareAccept(w), /NOT READY: the metal0 operator has not proposed/);
  propose(w, PRODUCTION.admin, 1);
  await assert.rejects(prepareAccept(w), /NOT READY/, "a proposal in the newest block is not accepted");
  w.base.mine(1);
  await assert.rejects(prepareAccept(w), /NOT READY/, "nor with one later block");
  w.base.mine(1);
  w.journals.fund.write({ status: "submitted", hash: "0x" + "12".repeat(32) });
  await assert.rejects(prepareAccept(w), /funding attempt is unresolved \(submitted\)/);
  w.journals.fund.write({ status: "ready" });
  const r = await prepareAccept(w);
  assert.deepEqual(r.transaction, { from: PRODUCTION.admin, to: PRODUCTION.ownership, chainId: "0x2105", type: "0x2", nonce: "0x475",
    data: evidence.unsigned[1].data, value: "0x0", gas: "0xf3c0", maxFeePerGas: "0xa7d8c0", maxPriorityFeePerGas: "0xf4240" });
  assert.equal(r.observed.authority.pendingOwner, PRODUCTION.admin);
  const other = "0x" + "99".repeat(20);
  w.base.edit((st) => { st.authority.pendingOwner = other; }); w.base.mine(3);
  await assert.rejects(prepareAccept(w), /names another wallet/);
  w.base.edit((st) => { st.authority.pendingOwner = PRODUCTION.admin; }); w.base.mine(3);
  w.base.send({ from: PRODUCTION.admin, ...frozen(w.trust, "accept"), value: 0, gas: 70000 });
  await assert.rejects(prepareAccept(w), /already owns metal0 \(revision 1\)/);
});

test("fund end to end on the reviewed transport: journal before wallet, exact hash recording, two-deep verification, no second funding after restart or lost journal", T, async (t) => {
  const w = await world(t);
  let { app, post } = await serve(t, w, "fund");
  const prep = await post("/prepare");
  assert.equal(prep.status, 200);
  assert.equal(w.journals.fund.read().status, "awaiting-wallet", "journaled before the browser saw it");
  assert.deepEqual(w.journals.fund.read().request.transaction, prep.body.transaction);
  assert.equal((await post("/prepare")).status, 409, "one attempt");
  const unknown = await post("/result", { hash: "0x" + "34".repeat(32) });
  assert.equal(unknown.status, 400); assert.match(unknown.body.error, /neither provider returns this transaction/);
  assert.equal(w.journals.fund.read().hash, undefined, "an unknown hash is not recorded");
  // a wallet-altered transaction (value) is refused before it is recorded
  const altered = w.base.submit({ ...prep.body.transaction, value: "0x48c27395001", nonce: "0x476" });
  const bad = await post("/result", { hash: altered });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /wrong value/); assert.equal(w.journals.fund.read().hash, undefined);
  w.base.pool = w.base.pool.filter((x) => x.hash !== altered); w.base.txs.delete(altered);
  // the wallet sends the exact transaction; it is pending
  const hash = w.base.submit(prep.body.transaction);
  const pending = await post("/result", { hash });
  assert.equal(pending.status, 400); assert.match(pending.body.error, /no receipt|pending/);
  assert.equal(w.journals.fund.read().status, "submitted"); assert.equal(w.journals.fund.read().hash, hash);
  w.base.mine(1);
  assert.match((await post("/result", { hash })).body.error, /lacks two later blocks/);
  assert.equal((await post("/result", { hash: "0x" + "56".repeat(32) })).status, 409, "a different hash never replaces the recorded one");
  w.base.mine(2);
  const done = await post("/result", { hash });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.amountWei, "5000000000000"); assert.equal(done.body.operatorBalanceAfterWei, String(376_132_087_579n + 5_000_000_000_000n));
  assert.equal(w.journals.fund.read().status, "confirmed");
  await app.close();
  ({ app, post } = await serve(t, w, "fund"));           // restart on the same journal
  assert.equal(app.state.status, "confirmed"); assert.equal((await post("/prepare")).status, 409);
  const lost = { fund: memoryJournal(), accept: w.journals.accept };   // even with the journal lost, chain state refuses
  await assert.rejects(prepareFund({ ...w, journals: lost }), /not funded twice/);
});

test("lost wallet response and restarts never duplicate: open attempt kept, interrupted preparation recovered, pending tx blocks a fresh journal", T, async (t) => {
  const w = await world(t);
  let { app, post } = await serve(t, w, "fund");
  const prep = await post("/prepare");
  w.base.submit(prep.body.transaction);                 // the wallet sent it, but the page never reported the hash
  await app.close();
  ({ app, post } = await serve(t, w, "fund"));
  assert.equal(app.state.status, "awaiting-wallet"); assert.equal((await post("/prepare")).status, 409);
  assert.equal((await post("/rejected", { code: 4001 })).status, 200, "only the page's own explicit 4001 resets an open attempt (transport rule)");
  await assert.rejects(prepareFund(w), /administrator transaction is pending/, "the in-flight transfer still blocks a new preparation");
  w.base.mine(3);
  await assert.rejects(prepareFund(w), /not funded twice/, "and once mined, the operator's balance does");
  const j = memoryJournal({ status: "preparing" });
  assert.equal(recoverInterruptedPreparation(j), true); assert.equal(j.read().status, "ready");
  const open = memoryJournal({ status: "awaiting-wallet", request: prep.body });
  assert.equal(recoverInterruptedPreparation(open), false); assert.equal(open.read().status, "awaiting-wallet");
});

test("accept end to end: refused early, exact acceptOwner verified with one OwnerAccepted at revision 1; the other stage's hash is refused", T, async (t) => {
  const w = await world(t);
  w.journals.fund.write({ status: "confirmed", hash: "0x" + "78".repeat(32) });
  const { post } = await serve(t, w, "accept");
  const early = await post("/prepare");
  assert.equal(early.status, 400); assert.match(early.body.error, /NOT READY/); assert.equal(w.journals.accept.read().status, "ready", "nothing journaled or handed out");
  propose(w);
  const prep = await post("/prepare");
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  assert.equal(prep.body.transaction.data, evidence.unsigned[1].data); assert.equal(prep.body.transaction.value, "0x0");
  assert.match((await post("/result", { hash: "0x" + "78".repeat(32) })).body.error, /belongs to the other stage/);
  const hash = w.base.submit(prep.body.transaction); w.base.mine(3);
  const done = await post("/result", { hash });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.owner, done.body.revision, done.body.policyHash, done.body.ownerNow], [PRODUCTION.admin, "1", "0x" + "0".repeat(64), PRODUCTION.admin]);
  assert.equal(w.journals.accept.read().status, "confirmed");
});

test("verification rejects a reverted, re-gassed, fee-raised or wrong-nonce transaction and a non-canonical receipt", T, async (t) => {
  const w = await world(t);
  propose(w);
  const request = await prepareAccept(w), tx = request.transaction;
  const land = (over) => { const h = w.base.submit({ ...tx, ...over }); w.base.mine(3); return h; };
  await assert.rejects(verifyAccept({ ...w, request, hash: land({ gas: "0xf3c1" }) }), /gas limit was changed/);
  w.base.edit((s) => { s.authority.pendingOwner = PRODUCTION.admin; s.authority.owner = ZERO; s.authority.revision = 0n; });
  w.base.mine(3);
  const req2 = await prepareAccept(w);
  await assert.rejects(verifyAccept({ ...w, request: req2, hash: land({ ...req2.transaction, maxFeePerGas: "0xa7d8c1" }) }), /raised the fee cap/);
  w.base.edit((s) => { s.authority.pendingOwner = ZERO; s.authority.owner = ZERO; s.authority.revision = 0n; });
  w.base.mine(3);
  const req3 = { ...req2, transaction: { ...req2.transaction, nonce: "0x" + w.base.pendingNonce(PRODUCTION.admin).toString(16) } };
  await assert.rejects(verifyAccept({ ...w, request: req3, hash: land(req3.transaction) }), /reverted/);
  await assert.rejects(verifyAccept({ ...w, request: req2, hash: land({ ...req2.transaction, nonce: "0x" + w.base.pendingNonce(PRODUCTION.admin).toString(16) }) }), /wrong nonce/);
  // fund: canonical check and exact amount
  const w2 = await world(t), freq = await prepareFund(w2), fh = w2.base.submit(freq.transaction); w2.base.mine(4);
  const mined = w2.base.txs.get(fh).receipt.blockNumber;
  w2.net.list[1].override.eth_getBlockByNumber = (params, base) => { const b = base.answer("eth_getBlockByNumber", params); return params[0] === mined ? { ...b, hash: "0x" + "cd".repeat(32) } : b; };
  await assert.rejects(verifyFund({ ...w2, request: freq, hash: fh }), /not canonical/);
  delete w2.net.list[1].override.eth_getBlockByNumber;
  assert.equal((await verifyFund({ ...w2, request: freq, hash: fh })).amountWei, "5000000000000");
  await assert.rejects(verifyFund({ ...w2, request: { ...freq, transaction: { ...freq.transaction, to: PRODUCTION.excluded.book } }, hash: fh }), /destination changed/, "a tampered journal cannot redirect verification");
});

test("read-only preflight reports both stages without writing a journal; serve.mjs refuses to start without the explicit stage", T, async (t) => {
  const w = await world(t);
  const ro = { read: () => ({ status: "ready" }), write: () => { throw Error("journal written"); } };
  const out = await preflight({ trust: w.trust, clients: w.clients, journals: { fund: ro, accept: ro } });
  assert.equal(out.notSent, true); assert.equal(out.observed.ready, true); assert.equal(out.observed.request.authority.pendingOwner, ZERO);
  assert.equal(out.fund.ready, true); assert.equal(out.fund.request.transaction.value, "0x48c27395000");
  assert.equal(out.accept.ready, false); assert.match(out.accept.reason, /NOT READY/);
  assert.doesNotThrow(() => JSON.stringify(out));
  for (const args of [[], ["--stage", "fund"], ["--stage", "book", "--serve"], ["--stage", "fund", "--serve", "x"]]) {
    const r = spawnSync(process.execPath, [path.join(root, "serve.mjs"), ...args], { encoding: "utf8", timeout: 10000 });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /usage: node serve\.mjs --stage fund\|accept --serve/);
  }
  for (const s of ["fund", "accept"]) { const html = assetsFor(s)["/"].body; assert.doesNotMatch(html, /\{\{|<script>|style=/); assert.match(html, /not recurring app lease gas/); }
});
