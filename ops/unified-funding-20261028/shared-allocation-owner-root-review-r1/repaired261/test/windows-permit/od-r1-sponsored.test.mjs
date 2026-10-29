// durability r1 (AUTHORED, NOT RUN). ACTUAL chain.mjs sponsored leaseSend + gated account/fetch + the ACTUAL owned operator-effects
// store (Linux backend, genuine flock, private temp dir). The lease client is a TEST EMULATOR (labelled; NOT the shipped
// lease-gas-runtime.bundle.mjs and NOT exact-client qualification): per relay it follows the shipped bundle's call order and shapes as
// read at lease-gas-runtime.bundle.mjs line 43 (signAuthorization -> signTypedData({domain:{name:"EnclaveLeaseExecutor",version:"1",
// chainId,verifyingContract:account.address},primaryType:"Lease",message:{reserve,...}}) -> onSigned({nonce,deadline,payee,kind,lease,
// fromBlock,operator,reserve,executor,chainId,ledger}) -> POST), and moves to the next relay after a failed one. The legacy release
// journal is a TEST in-memory double of lease-release-journal.mjs's interface. TEST account/RPC/HTTP only: nothing is signed with a real
// key, relayed, broadcast or paid. Exact-client claims remain for root: rerun these cases against the shipped bundle.
// durability r2 FIXTURE-INPUT ADAPTATION (assertions unchanged): r2 settles a record's EIP-7702 authorization only when the chain's
// MINED account nonce passes it. This emulator signs a constant authorization at account nonce 3 while its TEST RPC answered a
// mined count of 0 for every account (r1 never read it), an inconsistent chain for a lease that "landed". The TEST RPC now answers
// S.mined (rig default 4: the emulator's constant authorization already consumed), so each r1 case keeps its original meaning. The
// authorization-holding semantics themselves are asserted in od-r2-*.test.mjs (actual sender + shipped client).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { initializeOperatorEffects } from "../../control/windows/node/operator-effects.mjs";

const flock = process.platform === "linux" && fs.existsSync("/usr/bin/flock");
const url = new URL("../../control/windows/node/chain.mjs", import.meta.url);
const S = globalThis.__odR1Sp = { sponsored: true, relays: [], signs: 0, duringSign: null, posts: [], postOk: undefined, journal: null, settled: [], head: 0n, deadline: 1000n, resolveState: "pending" };
const modules = {
  viem: `const s=globalThis.__odR1Sp;
 export const createPublicClient=()=>({simulateContract:async()=>{},getTransactionCount:async()=>s.mined??0,waitForTransactionReceipt:async()=>({status:'success'}),getBlock:async()=>({timestamp:s.head})});
 export const createWalletClient=()=>({writeContract:async()=>{throw Error('TEST: the operator-paid sender must never be used on the sponsored path');}});
 export const http=()=>null,fallback=()=>null,keccak256=()=>null,toBytes=()=>null,getAddress=x=>x,formatEther=x=>String(x),stringToHex=x=>x,pad=x=>x;`,
  "viem/accounts": `export const privateKeyToAccount=()=>({address:'0x'+'11'.repeat(20),label:'TEST inert account',
 signTypedData:async()=>{const s=globalThis.__odR1Sp;s.signs++;if(s.duringSign)s.duringSign();return '0x'+'ee'.repeat(64)+s.signs.toString(16).padStart(2,'0');},
 signAuthorization:async()=>({TEST:'authorization'})});`,
  "viem/chains": "export const base={id:8453};",
  "./host-admission.bundle.mjs": "export const loadContractPins=()=>null;",
  "./waf.mjs": "export const parseWaf=()=>({});",
  "./verification-checkpoints.mjs": "export const planCheckpoints=()=>[];",
  "./lease-gas-runtime.bundle.mjs": `const s=globalThis.__odR1Sp;
 export const leaseGasConfigured=()=>s.sponsored,loadLeaseGasConfig=()=>({TEST:true});
 export const openReleaseJournal=()=>s.journal;
 export const configuredLeaseSender=({account,fetchImpl,onSigned})=>{
  const run=async(kind,id)=>{const errors=[];
   for(const relay of s.relays){try{
     await account.signAuthorization({chainId:8453,contractAddress:'0x'+'77'.repeat(20),nonce:3});
     const message={reserve:'0x'+'55'.repeat(20),id,kind,enclaveId:'0x'+'33'.repeat(32),nonce:1n,deadline:s.deadline,maxChargeWei:5n,payee:relay};
     const signature=await account.signTypedData({domain:{name:'EnclaveLeaseExecutor',version:'1',chainId:8453,verifyingContract:account.address},
       types:{Lease:[{name:'id',type:'bytes32'}]},primaryType:'Lease',message});
     if(onSigned)await onSigned({nonce:1n,deadline:s.deadline,payee:relay,kind,lease:{...message},fromBlock:1n,operator:account.address,reserve:message.reserve,
       executor:'0x'+'66'.repeat(20),chainId:8453,ledger:'0x'+'44'.repeat(20)});
     const ans=await fetchImpl(relay+'/v1/lease',{method:'POST',body:JSON.stringify({signature})});
     if(ans&&ans.ok)return {hash:'0x'+'cd'.repeat(32),receipt:{status:'success'}};
     errors.push(relay);
   }catch(e){errors.push(String(e.message));}}
   const e=Error('NotRelayed: '+errors.join('; '));e.code='NotRelayed';throw e;};
  return {claim:(id)=>run('claim',id),renew:(id)=>run('renew',id),release:(id)=>run('release',id),renewLeadMs:async(i,f)=>f,resolveSigned:async()=>({state:s.resolveState})};};`,
};
const hooks = registerHooks({ resolve(spec, ctx, next) {
  if (ctx.parentURL?.split("?")[0] !== url.href || !Object.hasOwn(modules, spec)) return next(spec, ctx);
  return { url: "data:text/javascript;base64," + Buffer.from(modules[spec]).toString("base64"), shortCircuit: true };
} });
const dir = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "od-r1-sponsored-"));
const saved = { key: process.env.NODE_OPERATOR_KEY, fetch: globalThis.fetch };
const live = new Set();
test.after(async () => {
  for (const m of live) await m.releaseOperatorEffects("TEST end").catch(() => {});
  hooks.deregister(); delete globalThis.__odR1Sp; globalThis.fetch = saved.fetch;
  if (saved.key === undefined) delete process.env.NODE_OPERATOR_KEY; else process.env.NODE_OPERATOR_KEY = saved.key;
  fs.rmSync(dir, { recursive: true, force: true });
});
const ACCOUNT = "0x" + "11".repeat(20), DEP = "0x" + "22".repeat(32), HOST = "0x" + "33".repeat(32);
function journal() {   // TEST double of lease-release-journal.mjs's interface (in memory)
  const rows = new Map();
  return { rows, corrupt: () => false, hold: (id) => (rows.has(id) ? "TEST legacy release pending" : null),
    begin: (id) => rows.set(id, { id, intents: [], settled: null }), signed: (id, s) => rows.get(id).intents.push(s),
    settle: (id, outcome) => { S.settled.push([id, outcome]); rows.delete(id); }, pending: () => [...rows.values()].map((e) => ({ ...e, intents: [...e.intents] })) };
}
let serial = 0;
async function instance(file) {
  process.env.NODE_OPERATOR_KEY = "0x" + "11".repeat(32);
  try {
    const m = await import(`${url.href}?od-r1-sp-${++serial}`);
    m.loadOperator(); m.addresses.deployments = "0x" + "44".repeat(20);
    m.setOperatorEffects(file); m.setLeaseJournal("/TEST/unused"); m.setLeaseRelayPolicy(null);
    live.add(m); return m;
  } finally { if (saved.key === undefined) delete process.env.NODE_OPERATOR_KEY; else process.env.NODE_OPERATOR_KEY = saved.key; }
}
async function rig(name, { init = true } = {}) {
  const file = path.join(dir, name);
  if (init) await initializeOperatorEffects(file, { domain: { account: ACCOUNT, chainId: 8453 } });
  Object.assign(S, { sponsored: true, relays: ["https://relay-a.TEST", "https://relay-b.TEST"], signs: 0, duringSign: null, posts: [], postOk: undefined,
    journal: journal(), settled: [], head: 0n, deadline: 1000n, resolveState: "pending", mined: 4 });
  globalThis.fetch = async (u) => { S.posts.push(u); return { ok: S.postOk ?? true, status: S.postOk === false ? 502 : 200, json: async () => ({}) }; };
  return { file, c: await instance(file) };
}
const restart = async (m) => { await m.releaseOperatorEffects("TEST process restart"); live.delete(m); };
const opts = { skip: !flock && "needs Linux /usr/bin/flock (genuine owner)" };

test("od-r1 sponsored (root r12 fixtureclosure FAIL, intended behaviour): release signature-time refusal -> pending from the OWNED record; legacy entry kept, not settled unsent; deadline fence settles both", opts, async () => {
  const { c } = await rig("release-withheld.journal");
  let allowed = true; S.duringSign = () => { allowed = false; };
  await assert.rejects(c.releaseDeployment(DEP, { gate: () => (allowed ? null : "TEST policy corrupt during signing") }),
    (e) => e.pending === true && e.notSent === true && e.signedWithheld === true && e.superseded === true);
  assert.equal(S.signs, 1, "no next-relay signature after the refusal"); assert.deepEqual(S.posts, []);
  const [rec] = c.sponsoredObligations();
  assert.equal(rec.fn, "release"); assert.equal(rec.state, "withheld");
  const signed = JSON.parse(rec.signings[0].request);
  assert.equal(signed.domain.chainId, 8453); assert.equal(signed.domain.verifyingContract, ACCOUNT, "the exact signing domain is recorded, not current config");
  assert.equal(rec.signings[0].signer, ACCOUNT); assert.match(rec.signings[0].signature, /^0x(ee){64}01$/, "the returned signature is preserved");
  assert.equal(c.withheldLeaseSignatures().length, 1);
  // explicit old/new reconciliation: NO fabricated legacy intent; the legacy entry stays open (hold) instead of being settled unsent
  const row = S.journal.rows.get(DEP);
  assert.ok(row && row.intents.length === 0 && row.settled === null); assert.deepEqual(S.settled, []);
  assert.ok(c.releaseHold(DEP));
  await c.resolvePendingReleases();
  assert.ok(S.journal.rows.has(DEP), "the legacy resolver does not settle it while the owned record is unresolved");
  assert.equal(c.sponsoredObligations().length, 1, "before the recorded deadline the withheld signature still holds");
  S.head = S.deadline + 1n;   // TEST chain head past the RECORDED message deadline
  await c.resolvePendingReleases();
  assert.equal(c.sponsoredObligations().length, 0);
  await c.resolvePendingReleases();
  assert.deepEqual(S.settled, [[DEP, "unsent"]], "only after the owned record is fenced does the legacy entry settle");
  await restart(c);
});

test("od-r1 sponsored: supersession is LATCHED - a restored Boolean permission does not revive the operation", opts, async () => {
  const { c } = await rig("latched.journal");
  let flipped = false;
  const gate = () => (S.signs === 1 && !flipped ? ((flipped = true), "TEST revoked once, then restored") : null);
  await assert.rejects(c.renewDeployment(DEP, { gate }), (e) => e.signedWithheld === true && e.pending === true);
  assert.equal(S.signs, 1); assert.deepEqual(S.posts, [], "no relay contacted after the latched refusal");
  assert.equal(c.sponsoredObligations()[0].state, "withheld");
  assert.match(c.releaseHold(DEP), /unresolved/, "the owned record holds the id");
  await restart(c);
});

test("od-r1 sponsored: refusal after an earlier POST is an unknown outcome; the posted record survives restart and holds the id", opts, async () => {
  const { file, c } = await rig("posted.journal");
  let allowed = true;
  globalThis.fetch = async (u) => { S.posts.push(u); allowed = false; return { ok: false, status: 502, json: async () => ({}) }; };
  await assert.rejects(c.renewDeployment(DEP, { gate: () => (allowed ? null : "TEST withdrawn after relay A") }),
    (e) => e.unknownOutcome === true && e.pending === true && e.notSent === false);
  assert.equal(S.posts.length, 1, "relay B is never signed for or contacted"); assert.equal(S.signs, 1);
  assert.equal(c.sponsoredObligations()[0].state, "posted");
  await restart(c);
  const cold = await instance(file);
  await assert.rejects(cold.renewDeployment(DEP, { gate: () => null }), (e) => e.code === "SponsoredPending" && e.pending === true && e.notSent === true);
  assert.equal(S.signs, 1, "the restarted process signs nothing for the held id");
  assert.match(cold.releaseHold(DEP), /posted/);
  S.resolveState = "landed";   // TEST read-only resolver: exact receipt by the RECORDED intent identity
  await cold.resolvePendingReleases();
  assert.equal(cold.sponsoredObligations().length, 0); assert.equal(cold.releaseHold(DEP), null);
  await restart(cold);
});

test("od-r1 sponsored: queue-entry refusal signs nothing; positive renew settles its record; an uninitialized store refuses before signing", opts, async () => {
  const { c } = await rig("positive.journal");
  await assert.rejects(c.claimDeployment(DEP, HOST, { gate: () => "TEST unknown policy" }), (e) => e.notSent === true);
  assert.equal(S.signs, 0); assert.deepEqual(S.posts, []);
  const hash = await c.renewDeployment(DEP, { gate: () => null });
  assert.equal(hash, "0x" + "cd".repeat(32)); assert.equal(S.signs, 1); assert.equal(S.posts.length, 1);
  assert.deepEqual(c.sponsoredObligations(), [], "a verified receipt settles exactly this record");
  await restart(c);
  const { c: bare } = await rig("never-initialized.journal", { init: false });
  await assert.rejects(bare.renewDeployment(DEP, { gate: () => null }), (e) => e.notSent === true && e.pending === true);
  assert.equal(S.signs, 0); assert.deepEqual(S.posts, []);
  assert.ok(bare.releaseHold(DEP), "an owner that is not open/live holds sponsored ids");
});
