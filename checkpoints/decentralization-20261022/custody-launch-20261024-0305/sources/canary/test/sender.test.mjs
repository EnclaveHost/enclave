// sender.mjs (the reviewed operator-helper pattern for ONE custody update) and budget.mjs against a two-RPC fake Base:
// fees incl. L1 + operator fee, intent before broadcast, never signing twice, resume/rebroadcast/conflict, receipts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSender, receiptCosts, ORACLE, txSizes, assertCoversSigned, ORACLE_SIGNATURE_ALLOWANCE } from "../driver/sender.mjs";
import { allowanceOf, planBudget, spentOf, gate } from "../driver/budget.mjs";

const REPO = process.env.CANARY_CLIENT_REPO || "/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/repo-r2";
const viem = await import(pathToFileURL(path.join(REPO, "node_modules/viem/_esm/index.js")).href);
const accounts = await import(pathToFileURL(path.join(REPO, "node_modules/viem/_esm/accounts/index.js")).href);
const KEY = accounts.generatePrivateKey();
const OWNER = accounts.privateKeyToAccount(KEY).address.toLowerCase();
const VAULT = "0xe48699b8401564aace7a814ae4569b67a3f7eef5";
const VAULT_CODE = "0x6080604052";
const RPCS = ["https://rpc-a.test", "https://rpc-b.test"];
const DATA = "0xe4373411" + "c1".repeat(32) + "00".repeat(64);
const lc = (a) => String(a).toLowerCase();
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canary-send-"))); fs.chmodSync(d, 0o700); return d; };

function fakeBase() {
  const s = { head: 1000, baseFee: 2_000_000n, tip: 1_000_000n, nonce: 5, balance: 6n * 10n ** 13n, estimate: 120_000n, l1: 50_000_000_000n, isthmus: true, opFee: 0n,
    revert: false, oracleFails: false, opFeeFails: false, l1Args: [], pool: [], mined: new Map(), hooks: {}, sent: [] };
  const hashOf = (n) => viem.keccak256(viem.toHex(`block-${n}`));
  const block = (n) => ({ number: viem.toHex(n), hash: hashOf(n), baseFeePerGas: viem.toHex(s.baseFee), timestamp: viem.toHex(Math.floor(Date.now()/1000)) });
  const enc = (t, v) => viem.encodeAbiParameters([{ type: t }], [v]);
  function call({ to, data }) {
    if (lc(to) === VAULT) { if (s.revert) throw new Error("execution reverted: StaleRevision()"); return "0x"; }
    if (lc(to) === ORACLE) {
      if (s.oracleFails) throw new Error("execution reverted");
      if (data.startsWith(viem.toFunctionSelector("getL1FeeUpperBound(uint256)"))) { s.l1Args.push(BigInt("0x" + data.slice(10))); return enc("uint256", s.l1); }
      if (data.startsWith(viem.toFunctionSelector("isIsthmus()"))) return enc("bool", s.isthmus);
      if (data.startsWith(viem.toFunctionSelector("getOperatorFee(uint256)"))) { if (s.opFeeFails) throw new Error("execution reverted"); return enc("uint256", s.opFee); }
    }
    throw new Error(`fake: no contract ${to}`);
  }
  function mine() {
    s.head++;
    for (const tx of s.pool.splice(0)) {
      if (tx.nonce !== s.nonce) continue;
      s.nonce++;
      const price = s.baseFee + s.tip;
      s.balance -= 100_000n * price + 1_000_000_000n;
      s.mined.set(tx.hash, { ...tx, blockNumber: s.head, blockHash: hashOf(s.head), price });
    }
  }
  function answer(url, method, params) {
    switch (method) {
      case "eth_chainId": return viem.toHex(8453);
      case "eth_blockNumber": return viem.toHex(s.head);
      case "eth_getBlockByNumber": return block(params[0] === "latest" ? s.head : Number(params[0]));
      case "eth_getCode": return lc(params[0]) === VAULT ? VAULT_CODE : "0x";
      case "eth_call": return call(params[0]);
      case "eth_getTransactionCount": return viem.toHex(params[1] === "pending" ? s.nonce + s.pool.length : s.nonce);
      case "eth_getBalance": return viem.toHex(s.balance);
      case "eth_estimateGas": call(params[0]); return viem.toHex(s.estimate);
      case "eth_maxPriorityFeePerGas": return viem.toHex(s.tip);
      case "eth_sendRawTransaction": {
        const t = viem.parseTransaction(params[0]);
        const hash = viem.keccak256(params[0]);
        s.sent.push(hash);
        if (!s.pool.some((x) => x.hash === hash) && !s.mined.has(hash)) s.pool.push({ hash, nonce: t.nonce, to: t.to, data: t.data, value: t.value ?? 0n, from: OWNER });
        return hash;
      }
      case "eth_getTransactionReceipt": { const m = s.mined.get(params[0]); return m ? { transactionHash: m.hash, blockNumber: viem.toHex(m.blockNumber), blockHash: m.blockHash, status: "0x1", gasUsed: viem.toHex(100_000n),
        effectiveGasPrice: viem.toHex(m.price), l1Fee: viem.toHex(1_000_000_000n) } : null; }
      case "eth_getTransactionByHash": { const m = s.mined.get(params[0]); return m ? { from: m.from, to: m.to, value: viem.toHex(m.value), input: m.data, nonce: viem.toHex(m.nonce), blockHash: m.blockHash } : null; }
      default: throw new Error(`fake: ${method}`);
    }
  }
  // hooks get the honest answer as a thunk, so a hook that throws prevents any side effect (e.g. a broadcast)
  const rpc = async (url, method, params) => (s.hooks[method] ? s.hooks[method](url, params, () => answer(url, method, params)) : answer(url, method, params));
  return { s, rpc, mine };
}

const CAPS = { gas: "250000", maxFeePerGas: "10000000", l1FeeWei: "300000000000", operatorFeeWei: "100000000000" };
const BUDGET = { remainingWei: "40000000000000", reserveWei: "3000000000000" };
function rig({ pollsMine = true } = {}) {
  const dir = tmp(), f = fakeBase();
  const sender = createSender({ viem, accounts, rpcs: RPCS, rpc: f.rpc, dir, vault: VAULT, vaultCodeHash: viem.keccak256(VAULT_CODE),
    sleep: async () => { if (pollsMine) f.mine(); }, cfg: { receiptPolls: 6, confirmations: 2 } });
  return { dir, f, sender, done: () => fs.rmSync(dir, { recursive: true }) };
}
const prep = (r, extra = {}) => r.sender.prepare({ stepId: "C1.create", stepHash: "s".repeat(64), from: OWNER, data: DATA, caps: CAPS, budget: BUDGET, ...extra });

test("prepare: worst case = gas x maxFee + L1 upper bound + operator fee; every bound pinned and checked", async () => {
  const r = rig();
  try {
    const p = await prep(r);
    assert.equal(p.tx.gas, String(150_000n));                              // 120k x 1.25
    assert.equal(p.tx.maxFeePerGas, String(2n * 2_000_000n + 1_000_000n));
    assert.equal(p.observed.totalAtBlockWei, String(150_000n * 5_000_000n + 50_000_000_000n + 0n));
    assert.match(p.observed.feeNote, /agreed block's oracle parameters.*Not a guarantee/);
    r.f.s.opFee = 7_000_000_000n;
    assert.equal((await prep(r)).observed.totalAtBlockWei, String(150_000n * 5_000_000n + 50_000_000_000n + 7_000_000_000n));
    for (const [mut, code] of [
      [(s) => { s.oracleFails = true; }, "fee_unbounded"], [(s) => { s.opFee = 200_000_000_000n; }, "fee_unbounded"], [(s) => { s.l1 = 400_000_000_000n; }, "fee_unbounded"],
      [(s) => { s.isthmus = false; }, "operator_fee"], [(s) => { s.opFeeFails = true; }, "operator_fee"],
      [(s) => { s.estimate = 300_000n; }, "gas"], [(s) => { s.baseFee = 6_000_000n; }, "fees"], [(s) => { s.revert = true; }, undefined],
      [(s) => { s.balance = 1_000_000_000_000n; }, "balance"],
    ]) {
      const q = rig(); mut(q.f.s);
      await assert.rejects(prep(q), (e) => (code ? e.code === code : /StaleRevision/.test(e.message)), String(mut)); q.done();
    }
    await assert.rejects(prep(r, { budget: { remainingWei: "1000", reserveWei: "0" } }), (e) => e.code === "aggregate_budget");
    r.f.s.hooks.eth_getBalance = (url, p, a) => (url === RPCS[1] ? viem.toHex(1n) : a());
    await assert.rejects(prep(r), (e) => e.code === "rpc_disagree");
  } finally { r.done(); }
});

test("prepare refuses another vault code, an unsettled nonce, or non-Base", async () => {
  for (const [hook, code] of [["eth_getCode", "vault_code"], ["eth_getTransactionCount", "nonce"], ["eth_chainId", "chain"]]) {
    const r = rig();
    r.f.s.hooks[hook] = (url, p, a) => (hook === "eth_getCode" ? "0x60806040" : hook === "eth_chainId" ? viem.toHex(1) : (p[1] === "pending" ? viem.toHex(99) : a()));
    await assert.rejects(prep(r), (e) => e.code === code, hook); r.done();
  }
});

test("send: intent file (0600) is durable BEFORE broadcast; verified with cost = gas x price + l1Fee + operator bound; never signs twice", async () => {
  const r = rig();
  try {
    const p = await prep(r);
    let intentAtBroadcast = null;
    r.f.s.hooks.eth_sendRawTransaction = (url, params, a) => { intentAtBroadcast ??= fs.existsSync(path.join(r.dir, "tx-C1.create.json")); return a(); };
    await assert.rejects(r.sender.send({ prepared: p, data: DATA, confirm: "0xwrong", readKey: async () => KEY, caps: CAPS, budget: BUDGET }), (e) => e.code === "confirm");
    await assert.rejects(r.sender.send({ prepared: p, data: DATA.slice(0, -2) + "01", confirm: p.preparedHash, readKey: async () => KEY, caps: CAPS, budget: BUDGET }), (e) => e.code === "prepared");
    await assert.rejects(r.sender.send({ prepared: { ...p, tx: { ...p.tx, gas: "1" } }, data: DATA, confirm: p.preparedHash, readKey: async () => KEY, caps: CAPS, budget: BUDGET }), (e) => e.code === "prepared");
    await assert.rejects(r.sender.send({ prepared: p, data: DATA, confirm: p.preparedHash, readKey: async () => accounts.generatePrivateKey(), caps: CAPS, budget: BUDGET }), (e) => e.code === "key");
    assert.equal(fs.existsSync(path.join(r.dir, "tx-C1.create.json")), false, "a refused send leaves no intent");
    const res = await r.sender.send({ prepared: p, data: DATA, confirm: p.preparedHash, readKey: async () => KEY, caps: CAPS, budget: BUDGET });
    assert.equal(intentAtBroadcast, true);
    assert.equal(res.status, "verified");
    assert.equal(fs.statSync(path.join(r.dir, "tx-C1.create.json")).mode & 0o777, 0o600);
    assert.equal(res.costWei, String(100_000n * 3_000_000n + 1_000_000_000n + 0n));
    assert.equal(r.f.s.sent.length, 2);                                       // one broadcast per RPC
    await assert.rejects(r.sender.send({ prepared: p, data: DATA, confirm: p.preparedHash, readKey: async () => KEY, caps: CAPS, budget: BUDGET }), (e) => e.code === "intent");
    await assert.rejects(prep(r), (e) => e.code === "intent");
    assert.equal((await r.sender.resume({ stepId: "C1.create", data: DATA })).status, "verified");
  } finally { r.done(); }
});

test("a failed intent write broadcasts nothing", async () => {
  const r = rig();
  try {
    const p = await prep(r);
    const sender = createSender({ viem, accounts, rpcs: RPCS, rpc: r.f.rpc, dir: path.join(r.dir, "missing-dir"), vault: VAULT, vaultCodeHash: viem.keccak256(VAULT_CODE) });
    await assert.rejects(sender.send({ prepared: p, data: DATA, confirm: p.preparedHash, readKey: async () => KEY, caps: CAPS, budget: BUDGET }), /ENOENT/);
    assert.equal(r.f.s.sent.length, 0);
  } finally { r.done(); }
});

test("unknown outcome: resume never signs; --rebroadcast re-sends the SAME bytes only while the nonce is unused; a consumed nonce is a final conflict", async () => {
  const r = rig({ pollsMine: false });
  try {
    r.f.s.hooks.eth_sendRawTransaction = () => { throw new Error("rpc down"); };        // nothing reaches the pool
    const p = await prep(r);
    const res = await r.sender.send({ prepared: p, data: DATA, confirm: p.preparedHash, readKey: async () => KEY, caps: CAPS, budget: BUDGET });
    assert.equal(res.status, "unknown");
    const intent = JSON.parse(fs.readFileSync(path.join(r.dir, "tx-C1.create.json"), "utf8"));
    delete r.f.s.hooks.eth_sendRawTransaction;
    assert.equal((await r.sender.resume({ stepId: "C1.create", data: DATA })).status, "pending");
    assert.equal(r.f.s.sent.length, 0, "resume without --rebroadcast sends nothing");
    const again = await r.sender.resume({ stepId: "C1.create", data: DATA, rebroadcast: true });
    assert.deepEqual(r.f.s.sent, [intent.txHash, intent.txHash], "the same bytes, to both RPCs");
    assert.equal(again.status, "unknown");
    r.f.mine(); r.f.mine(); r.f.mine();
    assert.equal((await r.sender.resume({ stepId: "C1.create", data: DATA })).status, "verified");
    // conflict: another transaction consumed the nonce
    const q = rig({ pollsMine: false });
    q.f.s.hooks.eth_sendRawTransaction = () => { throw new Error("rpc down"); };
    const p2 = await prep(q);
    await q.sender.send({ prepared: p2, data: DATA, confirm: p2.preparedHash, readKey: async () => KEY, caps: CAPS, budget: BUDGET });
    q.f.s.nonce++; q.f.s.head += 3;
    assert.equal((await q.sender.resume({ stepId: "C1.create", data: DATA })).status, "conflict");
    await assert.rejects(q.sender.resume({ stepId: "C1.create", data: DATA, rebroadcast: true }).then((x) => { if (x.status === "conflict") throw new Error("final conflict"); }), /final conflict/);
    assert.equal(q.f.s.sent.length, 0, "a conflict is final: nothing is re-sent or re-signed");
    q.done();
  } finally { r.done(); }
});

test("receiptCosts: CLI transactions are costed from both RPCs (value + l1Fee + operator allowance); foreign or unmined refuse", async () => {
  const f = fakeBase();
  const sign = async (nonce, value = 0n) => { const raw = await accounts.privateKeyToAccount(KEY).signTransaction({ type: "eip1559", chainId: 8453, nonce, to: VAULT, value, data: "0x", gas: 21000n, maxFeePerGas: 10n ** 7n, maxPriorityFeePerGas: 1n }); return f.rpc(RPCS[0], "eth_sendRawTransaction", [raw]); };
  const h1 = await sign(5, 7n), h2 = await sign(6);
  f.mine(); f.mine(); f.mine();
  const c = await receiptCosts({ rpc: f.rpc, rpcs: RPCS, txHashes: [h1], from: OWNER, operatorFeeWei: "5" });
  assert.equal(c.costWei, String(100_000n * 3_000_000n + 1_000_000_000n + 7n + 5n));
  await assert.rejects(receiptCosts({ rpc: f.rpc, rpcs: RPCS, txHashes: [h1], from: "0x" + "99".repeat(20), operatorFeeWei: "0" }), /not sent by the canary owner/);
  await assert.rejects(receiptCosts({ rpc: f.rpc, rpcs: RPCS, txHashes: ["0x" + "ab".repeat(32)], from: OWNER, operatorFeeWei: "0" }), /not mined/);
  assert.ok(h2);
});

const pinsB = { fees: { maxFeePerGasWei: "10000000", l1FeeWei: "300000000000", operatorFeeWei: "100000000000" },
  budget: { totalWei: "20000000000000", usdcUnits: "189740", usdcFundUnits: "90000", leaseDepositWei: "8000000000000", cliWei: { create: "7000000000000", stop: "1500000000000", leaseConfigure: "2000000000000", leaseDeposit: "1500000000000" } } };
const steps = [
  { id: "M1", status: "ready", mutation: { gasCap: "250000" } },
  { id: "D1", status: "ready", spend: { txs: ["create"], usdc: true } },
  { id: "L1", status: "ready", spend: { txs: ["leaseConfigure", "leaseDeposit"], depositWei: true } },
  { id: "S1", status: "ready", spend: { txs: ["stop"], cleanup: true } },
  { id: "X", status: "skipped", mutation: { gasCap: "900000" } },
  { id: "R", status: "ready" },
];

test("budget: per-step allowances, aggregate fit, cleanup reserve owed, spent from receipts (or the full allowance)", () => {
  assert.equal(allowanceOf(steps[0], pinsB), 250_000n * 10_000_000n + 300_000_000_000n + 100_000_000_000n);
  assert.equal(allowanceOf(steps[2], pinsB), 2_000_000_000_000n + 1_500_000_000_000n + 8_000_000_000_000n);
  const pb = planBudget(steps, pinsB);
  assert.equal(pb.worstCaseWei, String(2_900_000_000_000n + 7_000_000_000_000n + 11_500_000_000_000n + 1_500_000_000_000n));
  assert.equal(pb.cleanupReserveWei, "1500000000000"); assert.equal(pb.usdcUnits, "90000");
  assert.equal(pb.fits, false); assert.match(pb.reasons[0], /aggregate worst case/);
  assert.equal(planBudget(steps, { ...pinsB, budget: { ...pinsB.budget, totalWei: "30000000000000" } }).fits, true);
  const done = new Map();
  // nothing spent: D1 fits only while the cleanup stop stays reserved
  let g = gate({ steps, pins: pinsB, entries: [], done, step: steps[1] });
  assert.equal(g.ok, true); assert.equal(g.cleanupOwedWei, "1500000000000");
  const entries = [{ stepId: "M1", evidence: { costWei: "12000000000000" } }, { stepId: "D1", evidence: {} }];   // D1 without a cost counts its full allowance
  assert.equal(spentOf(entries, steps, pinsB), 12_000_000_000_000n + 7_000_000_000_000n);
  g = gate({ steps, pins: pinsB, entries, done, step: steps[2] });
  assert.equal(g.ok, false); assert.match(g.reasons[0], /remaining/);
  g = gate({ steps, pins: pinsB, entries: entries.slice(0, 1), done, step: steps[3] });              // the cleanup step itself owes no reserve
  assert.equal(g.ok, true); assert.equal(g.cleanupOwedWei, "0");
  assert.equal(gate({ steps, pins: pinsB, entries: [], done, step: steps[1], balanceWei: 1n }).ok, false);
  assert.equal(gate({ steps, pins: pinsB, entries: [], done, step: steps[5] }).ok, true);
});

test("L1 size: from the EXACT transaction (real nonce) and its maximum signed encoding; nonce-0 sizing undercounts and is refused", async () => {
  const r = rig();
  try {
    r.f.s.nonce = 23759;                                   // a real nonce needing 2 RLP bytes more than 0
    const p = await prep(r);
    const tx = { type: "eip1559", chainId: 8453, nonce: 23759, to: VAULT, value: 0n, data: DATA, gas: BigInt(p.tx.gas), maxFeePerGas: BigInt(p.tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.tx.maxPriorityFeePerGas) };
    const exact = txSizes(viem, tx);
    assert.deepEqual(p.observed.encodedBytes, { unsigned: exact.unsigned, signedMax: exact.signedMax, oracleArgument: exact.argument, oracleSignatureAllowance: 68 });
    assert.equal(r.f.s.l1Args.at(-1), BigInt(exact.argument), "the oracle got the exact-transaction argument");
    assert.ok(exact.argument + ORACLE_SIGNATURE_ALLOWANCE >= exact.signedMax);
    // the old sizing (nonce 0) gives a smaller argument that no longer covers this transaction's signed maximum
    const zero = txSizes(viem, { ...tx, nonce: 0 });
    assert.ok(zero.argument < exact.argument);
    assert.throws(() => assertCoversSigned({ argument: zero.argument, signedMax: exact.signedMax }), (e) => e.code === "l1_size");
    assert.throws(() => assertCoversSigned({ argument: exact.signedMax - 69, signedMax: exact.signedMax }), (e) => e.code === "l1_size");
    assert.doesNotThrow(() => assertCoversSigned({ argument: exact.signedMax - 68, signedMax: exact.signedMax }));
    // send re-sizes with the nonce at send time, and an operator fee that became undetermined refuses before the key is read
    let keyReads = 0;
    r.f.s.isthmus = false;
    await assert.rejects(r.sender.send({ prepared: p, data: DATA, confirm: p.preparedHash, readKey: async () => { keyReads++; return KEY; }, caps: CAPS, budget: BUDGET }), (e) => e.code === "operator_fee");
    assert.equal(keyReads, 0); assert.equal(r.f.s.sent.length, 0);
  } finally { r.done(); }
});


test("two-provider receipt status, fee and canonical inclusion must agree before verification or accounting",async()=>{
 for(const [field,changed] of [['status','0x0'],['gasUsed','0x1'],['effectiveGasPrice','0x1'],['l1Fee','0x1'],['transactionHash','0x'+'aa'.repeat(32)]]){
  const r=rig();try{
   r.f.s.hooks.eth_getTransactionReceipt=(url,p,a)=>{const x=a();return x&&url===RPCS[1]?{...x,[field]:changed}:x;};
   const p=await prep(r),v=await r.sender.send({prepared:p,data:DATA,confirm:p.preparedHash,readKey:async()=>KEY,caps:CAPS,budget:BUDGET});
   assert.equal(v.status,'unknown',field);
   await assert.rejects(receiptCosts({rpc:r.f.rpc,rpcs:RPCS,txHashes:[v.txHash],from:OWNER,operatorFeeWei:'0'}),/do not agree/);
   delete r.f.s.hooks.eth_getTransactionReceipt;
   assert.equal((await r.sender.resume({stepId:'C1.create',data:DATA})).status,'verified',field);
  }finally{r.done();}
 }
 const r=rig();try{
  const p=await prep(r),v=await r.sender.send({prepared:p,data:DATA,confirm:p.preparedHash,readKey:async()=>KEY,caps:CAPS,budget:BUDGET});
  r.f.s.hooks.eth_getBlockByNumber=(url,p,a)=>({...a(),hash:'0x'+'ab'.repeat(32)});
  await assert.rejects(receiptCosts({rpc:r.f.rpc,rpcs:RPCS,txHashes:[v.txHash],from:OWNER,operatorFeeWei:'0'}),/not canonical/);
 }finally{r.done();}
});
test("unknown broadcast errors do not leak raw signed bytes in public status",async()=>{
 const r=rig({pollsMine:false});try{
  let raw;
  r.f.s.hooks.eth_sendRawTransaction=(url,p)=>{raw=p[0];throw Error('bad '+raw);};
  const p=await prep(r),v=await r.sender.send({prepared:p,data:DATA,confirm:p.preparedHash,readKey:async()=>KEY,caps:CAPS,budget:BUDGET});
  assert.equal(v.status,'unknown');assert.ok(!JSON.stringify(v).includes(raw));assert.match(v.broadcasts[0].error,/withheld/);
 }finally{r.done();}
});


test("stale, future, malformed and wrong-height chain views refuse before signing", async()=>{
 for(const change of [b=>({...b,timestamp:viem.toHex(Math.floor(Date.now()/1000)-121)}),b=>({...b,timestamp:viem.toHex(Math.floor(Date.now()/1000)+11)}),b=>({...b,timestamp:undefined}),b=>({...b,number:"0x1"})]){
  const r=rig();try{
   r.f.s.hooks.eth_getBlockByNumber=(u,p,a)=>change(a());
   await assert.rejects(prep(r),e=>e.code==="stale_chain");
   assert.equal(r.f.s.sent.length,0);
  }finally{r.done();}
 }
});

test("signed gas, fees and recovered signer must equal prepared fields before intent or broadcast",async()=>{
 for(const mutate of [t=>({...t,gas:t.gas+1n}),t=>({...t,maxFeePerGas:t.maxFeePerGas+1n}),t=>({...t,maxPriorityFeePerGas:t.maxPriorityFeePerGas+1n}),t=>t]){
  const r=rig();try{
   const p=await prep(r), alternate=accounts.privateKeyToAccount(accounts.generatePrivateKey());
   const signer=accounts.privateKeyToAccount(KEY);
   const badAccounts={privateKeyToAccount:()=>({address:signer.address,signTransaction:t=>{
    const changed=mutate(t);return changed===t?alternate.signTransaction(t):signer.signTransaction(changed);
   }})};
   const sender=createSender({viem,accounts:badAccounts,rpcs:RPCS,rpc:r.f.rpc,dir:r.dir,vault:VAULT,vaultCodeHash:viem.keccak256(VAULT_CODE),sleep:async()=>r.f.mine(),cfg:{receiptPolls:6,confirmations:2}});
   await assert.rejects(sender.send({prepared:p,data:DATA,confirm:p.preparedHash,readKey:async()=>KEY,caps:CAPS,budget:BUDGET}),e=>e.code==="sign");
   assert.equal(r.f.s.sent.length,0);assert.equal(fs.existsSync(path.join(r.dir,"tx-C1.create.json")),false);
  }finally{r.done();}
 }
});

test("malicious broadcast success payload is not exposed as a returned hash",async()=>{
 const r=rig({pollsMine:false});try{
  r.f.s.hooks.eth_sendRawTransaction=(u,p)=>p[0];
  const p=await prep(r),res=await r.sender.send({prepared:p,data:DATA,confirm:p.preparedHash,readKey:async()=>KEY,caps:CAPS,budget:BUDGET});
  const record=JSON.parse(fs.readFileSync(path.join(r.dir,"tx-C1.create.json")));
  assert.equal(JSON.stringify(res).includes(record.raw),false);
  assert.ok(res.broadcasts.every(x=>x.result===undefined&&x.error==="broadcast response did not match transaction hash"));
 }finally{r.done();}
});


test("resume rechecks terminal inclusion and never rebroadcasts a formerly confirmed orphan",async()=>{
 const r=rig();try{
  const p=await prep(r),res=await r.sender.send({prepared:p,data:DATA,confirm:p.preparedHash,readKey:async()=>KEY,caps:CAPS,budget:BUDGET});
  assert.equal(res.status,"verified");const before=r.f.s.sent.length;
  r.f.s.hooks.eth_getBlockByNumber=(u,p,a)=>({...a(),hash:"0x"+"fe".repeat(32)});
  const checked=await r.sender.resume({stepId:"C1.create",data:DATA,rebroadcast:true});
  assert.equal(checked.status,"unknown");assert.equal(checked.receipt,null);assert.equal(checked.costWei,null);assert.equal(r.f.s.sent.length,before);
 }finally{r.done();}
});
