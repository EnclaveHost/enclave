// permit r12 (AUTHORED, NOT RUN). Extension of the root r11 regression evidence/root-r11/root-restart-unknown.test.mjs (which stays unchanged
// as executed evidence: 1 FAIL on the frozen r11 source). Actual chain.mjs serialized sender + actual operator-obligations.mjs durable store
// (a real file in a private temp dir). TEST, labelled: the public TEST account (no signer), inert viem RPC/wallet doubles (nothing signed,
// broadcast or paid). A fresh module instance models loss of module memory at restart; it is NOT an OS crash or a live transaction.
// Every global/env mutation is restored in after-hooks (no leak into other files, even in one process).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

const url = new URL("./repaired/control/windows/node/chain.mjs", import.meta.url);
const state = { writes: [], nonce: 0, mined: 0, writeError: false, receipts: new Map() };
globalThis.__r12DurableSend = state;
const modules = {
  viem: `const s=globalThis.__r12DurableSend;
  export const createPublicClient=()=>({simulateContract:async()=>{},getTransactionCount:async({blockTag})=>blockTag==='latest'?s.mined:s.nonce,
    waitForTransactionReceipt:async()=>({status:'success'}),getTransactionReceipt:async({hash})=>s.receipts.get(hash)??null});
  export const createWalletClient=()=>({writeContract:async(o)=>{s.writes.push([o.functionName,o.nonce]);if(s.writeError)throw Error('TEST broadcast response lost');return '0x'+'ab'.repeat(32);}});
  export const http=()=>null,fallback=()=>null,keccak256=()=>null,toBytes=()=>null,getAddress=x=>x,formatEther=x=>String(x),stringToHex=x=>x,pad=x=>x;`,
  "viem/accounts": "export const privateKeyToAccount=()=>({address:'0x'+'11'.repeat(20),label:'TEST inert account; no signer'});",
  "viem/chains": "export const base={id:8453};",
  "./host-admission.bundle.mjs": "export const loadContractPins=()=>null;",
  "./waf.mjs": "export const parseWaf=()=>({});",
  "./verification-checkpoints.mjs": "export const planCheckpoints=()=>[];",
  "./lease-gas-runtime.bundle.mjs": "export const leaseGasConfigured=()=>false,loadLeaseGasConfig=()=>{throw Error('TEST no sponsored path');},configuredLeaseSender=()=>{throw Error('TEST no sponsored path');},openReleaseJournal=()=>null;",
};
const hooks = registerHooks({ resolve(spec, ctx, next) {
  if (ctx.parentURL?.split("?")[0] !== url.href || !Object.hasOwn(modules, spec)) return next(spec, ctx);
  return { url: "data:text/javascript;base64," + Buffer.from(modules[spec]).toString("base64"), shortCircuit: true };
} });
const dir = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "r12-durable-send-"));
const journal = path.join(dir, "operator-writes.json");
const saved = { key: process.env.NODE_OPERATOR_KEY, j: process.env.ENCLAVE_OPERATOR_WRITE_JOURNAL };
const restoreEnv = () => {
  if (saved.key === undefined) delete process.env.NODE_OPERATOR_KEY; else process.env.NODE_OPERATOR_KEY = saved.key;
  if (saved.j === undefined) delete process.env.ENCLAVE_OPERATOR_WRITE_JOURNAL; else process.env.ENCLAVE_OPERATOR_WRITE_JOURNAL = saved.j;
};
async function instance(tag) {
  process.env.NODE_OPERATOR_KEY = "0x" + "11".repeat(32);
  try { const m = await import(`${url.href}?${tag}`); m.loadOperator(); m.addresses.deployments = "0x" + "44".repeat(20); return m; }
  finally { if (saved.key === undefined) delete process.env.NODE_OPERATOR_KEY; else process.env.NODE_OPERATOR_KEY = saved.key; }
}
const dep = "0x" + "22".repeat(32);
test.after(() => { hooks.deregister(); delete globalThis.__r12DurableSend; restoreEnv(); fs.rmSync(dir, { recursive: true, force: true }); });

test("r12: no durable operator-write journal -> no write is attempted (fail closed, nothing sent)", async () => {
  delete process.env.ENCLAVE_OPERATOR_WRITE_JOURNAL;
  const c = await instance("no-journal");
  Object.assign(state, { writes: [], nonce: 0, mined: 0, writeError: false });
  await assert.rejects(c.renewDeployment(dep, { gate: () => null }), (e) => e.notSent === true && e.code === "NoWriteJournal");
  assert.deepEqual(state.writes, []);
});

test("r12 ROOT extension: an ambiguous write is durable BEFORE the effect; a FRESH module refuses a second write; mined nonce fences; positive resumes", async () => {
  process.env.ENCLAVE_OPERATOR_WRITE_JOURNAL = journal;
  Object.assign(state, { writes: [], nonce: 0, mined: 0, writeError: true });
  const first = await instance("first");
  await assert.rejects(first.renewDeployment(dep, { gate: () => null }), (e) => e.unknownOutcome === true && e.nonce === 0);
  assert.deepEqual(state.writes, [["renew", 0]]);
  const rec = JSON.parse(fs.readFileSync(journal, "utf8"));
  assert.equal(rec.schema, "enclave-operator-writes/1");
  const r0 = Object.values(rec.records)[0];
  assert.equal(r0.nonce, 0); assert.equal(r0.functionName, "renew"); assert.equal(r0.account.toLowerCase(), "0x" + "11".repeat(20)); assert.equal(r0.chainId, 8453);
  // same module: refused
  await assert.rejects(first.renewDeployment(dep, { gate: () => null }), (e) => e.code === "AmbiguousPriorWrite");
  // FRESH module (module memory lost), same TEST identity, unchanged pending count: refused before any write
  state.writeError = false;
  const restarted = await instance("restart");
  await assert.rejects(restarted.renewDeployment(dep, { gate: () => null }), (e) => e.code === "AmbiguousPriorWrite" && e.notSent === true);
  assert.deepEqual(state.writes, [["renew", 0]], "the restarted sender sent nothing");
  assert.equal(restarted.ambiguousOperatorWrite().nonce, 0, "the obligation is visible after restart");
  // the chain mines nonce 0 (ours or another's: a FENCE, not proof of success): the record is settled and a NEW nonce is used
  state.mined = 1; state.nonce = 1;
  await restarted.renewDeployment(dep, { gate: () => null });
  assert.deepEqual(state.writes, [["renew", 0], ["renew", 1]], "never the recorded nonce again, never a replacement");
  assert.equal(restarted.ambiguousOperatorWrite(), null);
});

test("r12: a crash between broadcast and result (record 'sending', hash unknown) is UNKNOWN after restart; a corrupt journal refuses", async () => {
  process.env.ENCLAVE_OPERATOR_WRITE_JOURNAL = journal;
  Object.assign(state, { writes: [], nonce: 5, mined: 5, writeError: false });
  fs.writeFileSync(journal, JSON.stringify({ schema: "enclave-operator-writes/1", records: { ["0x" + "11".repeat(20) + ":5"]: {
    account: "0x" + "11".repeat(20), chainId: 8453, address: "0x" + "44".repeat(20), functionName: "renew", args: "[]", nonce: 5, hash: null, state: "sending", at: 1 } } }));
  const c = await instance("crash");
  await assert.rejects(c.renewDeployment(dep, { gate: () => null }), (e) => e.code === "AmbiguousPriorWrite");
  assert.deepEqual(state.writes, []);
  fs.writeFileSync(journal, "{not json");
  await assert.rejects(c.renewDeployment(dep, { gate: () => null }), (e) => e.notSent === true && /malformed/.test(e.message));
  assert.equal(fs.readFileSync(journal, "utf8"), "{not json", "a corrupt journal is kept for diagnosis, never overwritten");
  assert.deepEqual(state.writes, []);
  fs.rmSync(journal);
});

// ROOT additional actual sender regressions. TEST inert wallet only; deletion is limited to this test's owned temporary journal.
test("ROOT established unresolved journal deleted: a fresh module must refuse instead of treating absence as genesis",async()=>{
 process.env.ENCLAVE_OPERATOR_WRITE_JOURNAL=journal;
 Object.assign(state,{writes:[],nonce:12,mined:12,writeError:true});
 const first=await instance('root-before-delete');
 await assert.rejects(first.renewDeployment(dep,{gate:()=>null}),e=>e.unknownOutcome===true);
 assert.equal(state.writes.length,1);
 fs.unlinkSync(journal); state.writeError=false;
 const cold=await instance('root-after-delete');
 const outcome=await cold.renewDeployment(dep,{gate:()=>null}).then(()=>null,e=>e);
 assert.equal(state.writes.length,1,'missing established obligations cannot authorize a second inert write');
 assert.ok(outcome?.notSent);
});
test("ROOT final post-persist refusal is provably unsent and must not become an unknown-broadcast quarantine",async()=>{
 const file=path.join(dir,'root-unsent.json');process.env.ENCLAVE_OPERATOR_WRITE_JOURNAL=file;
 Object.assign(state,{writes:[],nonce:15,mined:15,writeError:false});
 const c=await instance('root-unsent');
 const gate=()=>fs.existsSync(file)&&Object.keys(JSON.parse(fs.readFileSync(file)).records).length?'TEST refusal after intent persisted':null;
 await assert.rejects(c.renewDeployment(dep,{gate}),e=>e.notSent===true);
 assert.deepEqual(state.writes,[]);
 assert.equal(Object.keys(JSON.parse(fs.readFileSync(file)).records).length,0,'exact unsent intent must not wait for a nonce it never broadcast');
 await c.renewDeployment(dep,{gate:()=>null});assert.deepEqual(state.writes,[["renew",15]]);
});
