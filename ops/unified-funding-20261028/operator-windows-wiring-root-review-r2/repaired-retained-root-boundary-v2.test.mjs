// durability r1 (AUTHORED, NOT RUN). The ACTUAL chain.mjs serialized direct sender over the ACTUAL owned operator-effects store
// (Linux backend: genuine /usr/bin/flock owner + owned-durable-state files in a private temp dir). Carries both root r12
// durable-gaps FAILs (evidence/root-r12/root-durable-gaps.test.mjs tests 4 and 5) in meaning; that file stays unchanged executed
// evidence and targets the removed r12 JSON format. TEST, labelled: the public TEST account (no signer), inert viem RPC/wallet doubles
// (nothing signed, broadcast or paid). A fresh module instance after releaseOperatorEffects models a process restart (module memory
// lost, owner released as at process death); it is NOT an OS crash or power loss. Every global/env mutation is restored after the file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { initializeOperatorEffects, openOperatorEffects, canonicalBounded } from "./repaired/control/windows/node/operator-effects.mjs";

const flock = process.platform === "linux" && fs.existsSync("/usr/bin/flock");
const url = new URL("./repaired/control/windows/node/chain.mjs", import.meta.url);
const S = { writes: [], nonce: 0, mined: 0, writeError: false, receipts: new Map() };
globalThis.__odR1Direct = S;
const modules = {
  viem: `const s=globalThis.__odR1Direct;
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
const dir = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "od-r1-direct-"));
const saved = { key: process.env.NODE_OPERATOR_KEY, fx: process.env.ENCLAVE_OPERATOR_EFFECTS };
const live = new Set();
test.after(async () => {
  for (const m of live) await m.releaseOperatorEffects("TEST end").catch(() => {});
  hooks.deregister(); delete globalThis.__odR1Direct;
  if (saved.key === undefined) delete process.env.NODE_OPERATOR_KEY; else process.env.NODE_OPERATOR_KEY = saved.key;
  if (saved.fx === undefined) delete process.env.ENCLAVE_OPERATOR_EFFECTS; else process.env.ENCLAVE_OPERATOR_EFFECTS = saved.fx;
  fs.rmSync(dir, { recursive: true, force: true });
});
const ACCOUNT = "0x" + "11".repeat(20), dep = "0x" + "22".repeat(32);
let serial = 0;
async function instance(file, options = {}) {
  process.env.NODE_OPERATOR_KEY = "0x" + "11".repeat(32);
  try {
    const m = await import(`${url.href}?od-r1-${++serial}`);
    m.loadOperator(); m.addresses.deployments = "0x" + "44".repeat(20);
    if (file) m.setOperatorEffects(file, options);
    live.add(m); return m;
  } finally { if (saved.key === undefined) delete process.env.NODE_OPERATOR_KEY; else process.env.NODE_OPERATOR_KEY = saved.key; }
}
const restart = async (m) => { await m.releaseOperatorEffects("TEST process restart"); live.delete(m); };
async function established(name, account = ACCOUNT) { const file = path.join(dir, name); await initializeOperatorEffects(file, { domain: { account, chainId: 8453 } }); return file; }
const reset = (o) => Object.assign(S, { writes: [], writeError: false, receipts: new Map() }, o);
const opts = { skip: !flock && "needs Linux /usr/bin/flock (genuine owner)" };


// ROOT external boundary regressions; same inert wallet/RPC doubles, genuine owned files/flock. No real signing/transactions.
for (const suffix of ['', '.established']) {
 test(`ROOT final gate removes established${suffix || ' state'}: no inert write`, async () => {
  const file=await established('boundary'+(suffix || '-state')+'.journal');
  reset({nonce:60,mined:60}); const c=await instance(file); let removed=false;
  const gate=()=>{if(!removed && c.operatorEffectsStatus().ownership==='live' && c.ambiguousOperatorWrite()){fs.unlinkSync(file+suffix);removed=true;}return null;};
  const result=await c.renewDeployment(dep,{gate}).then(v=>({value:v}),e=>({error:e.message,pending:e.pending}));
  assert.equal(removed,true,'external loss occurs after the intent was persisted');
  assert.equal(S.writes.length,0,JSON.stringify({writes:S.writes,result}));
  assert.throws(()=>c.ambiguousOperatorWrite(),/failed|missing|lost|unavailable/i,'cached state cannot bypass loss');
 });
}

test('ROOT pending sponsored authorization fences the actual direct sender on the same account/chain', async()=>{
 const file=await established('cross-kind.journal');reset({nonce:70,mined:70});
 const store=await openOperatorEffects(file,{domain:{account:ACCOUNT,chainId:8453}});
 const key=`s:claim:${dep}:${Date.now()}-1`;
 const bindings=canonicalBounded({chainId:8453,ledger:'0x'+'44'.repeat(20),registry:'0x'+'55'.repeat(20)});
 const request=canonicalBounded({chainId:8453,contractAddress:'0x'+'77'.repeat(20),nonce:70});
 const {createHash}=await import('node:crypto');const sha=s=>createHash('sha256').update(s).digest('hex');
 store.put(key,{type:'sponsored',key,account:ACCOUNT,chainId:8453,fn:'claim',id:dep,state:'authorizing',
 bindings:{canonical:bindings,sha256:sha(bindings)},authorizations:[{at:Date.now(),state:'returned',request,sha256:sha(request),signer:ACCOUNT,signature:null}],signings:[],intents:[],posts:0,refused:null,at:Date.now()});
 await store.release('TEST process reconstruction with unresolved authorization');
 const c=await instance(file); const result=await c.renewDeployment(dep,{gate:()=>null}).then(v=>({value:v}),e=>({error:e.message,pending:e.pending}));
 assert.equal(S.writes.length,0,JSON.stringify({writes:S.writes,result}));
});
