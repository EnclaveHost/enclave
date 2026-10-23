// The Linux supervisor's host-wallet decisions on its REAL caller paths: auditClaims, renewLeases, switchTenantVersion,
// tryClaim, gateAppReference and the reaper/vouch set (unresumedOwnLeases), executed from supervisor.js itself with the
// REAL shipped admission bundle (windows/node/host-admission.bundle.mjs createHostAdmission on a scripted agreeing reader,
// as test/host-admission-runtime does) and the REAL operator-queue senders (sendLeaseTx/sendOperatorTx). Only the
// chain/manager I/O at the edges is scripted. An UNKNOWN wallet policy (no RPC quorum) must stop service here and never
// renew, claim or release; a definite refusal (owner policy or platform moderation) retires and releases as before.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const SUPERVISOR=process.env.SUPERVISOR_JS||new URL('../supervisor.js',import.meta.url);
const source=fs.readFileSync(SUPERVISOR,'utf8');
const {createHostAdmission}=await import('../windows/node/host-admission.bundle.mjs');
const {hostAdmissionPolicyHash}=await import('../network/host-admission-policy.mjs');
function between(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`supervisor.js has ${start}`);return source.slice(a,b);}
const host='0x'+'ab'.repeat(32),dep='0x'+'cd'.repeat(32),app='0x'+'ef'.repeat(32),catalog='0x'+'12'.repeat(20),ref=`catalog://${app}/1`;
const ownership='0x'+'11'.repeat(20),registry='0x'+'22'.repeat(20),owner='0x'+'44'.repeat(20);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// the shipped bundle's admission: this host owner's policy document + the platform catalog, through an agreeing reader
function admission(){
 const doc={version:1,chainId:8453,ownershipContract:ownership,hostId:host,requireCatalogApproval:false,denyDeployments:[],denyAppRefs:[]};
 const w={catalog:{active:true,approval:1,yanked:false},down:false,authorityAge:0,doc};
 const client={readContract:async q=>{
  if(q.functionName==='registry')return registry;
  if(q.functionName==='authority')return [owner,owner,BigInt(w.revision||1),hostAdmissionPolicyHash(w.doc)];
  if(q.functionName==='getApp')return {appId:app,versionCount:2,...w.catalog};
  if(q.functionName==='getVersion')return w.catalog;
  throw Error('unexpected read '+q.functionName);
 }};
 const reader={agreed:async fn=>{if(w.down)throw Error('chain quorum unavailable');const value=await fn(client,100n);
  return {timestamp:Date.now()-(value.owner?w.authorityAge:0),...value};}};
 w.admission=createHostAdmission({hostId:host,ownershipContract:ownership,registry,catalog,reader,loadPolicy:async()=>w.doc,now:()=>Date.now()});
 return w;
}
function fixture(){
 const w=admission();
 const s={events:[],writes:[],adopted:[],stopOk:true,lease:Math.floor(Date.now()/1000)+3600};
 const row=(over={})=>({id:dep,appRef:ref,isPublic:true,active:true,owner,runner:host,leaseUntil:BigInt(s.lease),configCid:'',gpuMilli:0,cpuMilli:100,
   spent6:0n,balance6:1000000n,rate:1n,...over});
 const ctx=vm.createContext({console,Date,Number,BigInt,Set,Map,Error,String,Object,Promise,JSON,Math,Array,Infinity,
  HOST_WALLET_POLICY:true,_enclaveId:host,RPC_POOL:[],hostAdmissionFromEnv:()=>{throw Error('the test admission is preset');},
  hostCatalogAddress:()=>catalog,CATALOG_REF_RE:/^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d{1,9})$/,ZERO32:'0x'+'00'.repeat(32),CATALOG_ABI:[],
  getAddress:a=>a,catSchemaRev:async()=>7,gpuOptionalOfConfig:()=>false,cpuFallbackOfConfig:()=>null,
  approvalVerdict:()=>{throw Error('wallet mode never consults the global approval');},
  chainClient:{readContract:async q=>{
   if(q.functionName==='getApp')return {appId:app,versionCount:2,active:true,publisher:catalog,slug:'test'};
   if(q.functionName==='getVersion')return {cid:'cid',version:'1',active:true,yanked:false,approval:1,config:'{}'};
   if(q.functionName==='versionFee')return 0n;if(q.functionName==='versionConfigCid')return '';throw Error('unexpected read');}},
  _reach:{tripped:false},RENEW_MARGIN_SEC:900,tenantProvisions:new Set(),_releaseIntents:new Map(),
  HOST_POLICY_GATE:{enabled:false,serviceRefusal:()=>null,status:()=>({})},_stateCorrupt:null,leaseGasActive:()=>false,leaseGasRenewDue:async()=>true,
  TERMINAL_STATUSES:new Set(['expired','failed','terminated','stopping']),lc:v=>String(v||'').toLowerCase(),
  placementRefusal:()=>null,readLedgerContract:async()=>row(),
  stopContainer:async()=>{s.events.push('stop');return s.stopOk;},releaseGpu:()=>{},
  proveAndRelease:async()=>{s.events.push('prove+release');},releaseLease:async()=>{s.events.push('release');return true;},
  saveStateSoon:()=>{},releaseHold:()=>null,
  // the operator queue's edge: the signer and the receipt
  _txChain:Promise.resolve(),DEPLOYMENTS_ADDRESS:'0x'+'99'.repeat(20),CLAIM_TX_ABI:[],
  claimSigner:()=>({account:{address:owner},wallet:{writeContract:async q=>{s.writes.push(q.functionName);return '0x'+'aa'.repeat(32);}}}),
  awaitReceipt:async()=>({status:'success',blockNumber:7n}),leaseFromReceipt:()=>s.lease+1800,noteLeaseFloor:()=>{},
  // the rest of the audit's healthy pass (nothing to switch, edit or relaunch)
  shareResizeVerdict:()=>s.resize?'resize':'same',needsVersionSwitch:()=>false,envelopeEditVerdict:()=>'skip',instanceAlive:async()=>true,
  provisionTenant:async()=>true,noteProvisionFailure:()=>{},IS_GPU:true,parseDepOptions:()=>({}),bootstrapIntent:()=>false,
  // tryClaim's edges
  claimBondReady:async()=>true,PROVISION_BACKEND:'vm',vmReq:async()=>({status:200,body:{}}),openForUs:async()=>true,
  adopt:async(d,g,f,sl,o)=>{s.adopted.push(o?.resume?'resume':'claim');},_ownLeases:null,
 });
 for(const [a,b] of [['let _hostWalletAdmission = null;','\nconst hostCatalogAddress='],['async function gateAppReference(','// A paid app is servable'],
   ['async function retireForPlacement(','\nfunction parseDepOptions('],['function sendOperatorTx(',"\n// ---- the operator's owner nomination"],
   ['function sendLeaseTx(','\n/** A sponsored renew'],['async function renewLeases()','\nasync function switchTenantVersion('],
   ['async function switchTenantVersion(','\nasync function applyEnvelopeEdit('],['async function auditClaims(','\nasync function fetchLedger('],
   ['async function tryClaim(','\n// On-chain record -> local rec'],['const HOST_POLICY_EXPLICIT','\nasync function reconcileInstances()']])
  vm.runInContext(between(a,b),ctx);
 ctx.__adm=w.admission;vm.runInContext('_hostWalletAdmission=__adm',ctx);
 const rec=(over={})=>({id:dep,status:'running',_onchain:true,_leaseUntil:s.lease,owner,image:{reference:ref},resources:{gpuShare:0,cpuShare:0.1},...over});
 const audit=(over={})=>ctx.auditClaims(new Map([[dep,row(over)]]));
 const releases=()=>s.events.filter(e=>/release/.test(e));
 return {w,s,ctx,rec,row,audit,releases,serve:(r)=>{ctx.deployments=new Map([[dep,r]]);return r;}};
}

test('known allow: the audit keeps serving and the due renewal is sent once, under its decision deadline',{timeout:20_000},async()=>{
 const f=fixture();const r=f.serve(f.rec());
 await f.audit();assert.deepEqual(f.s.events,[]);assert.equal(r.status,'running');assert.equal(r.walletHeld,undefined);
 r._leaseUntil=Math.floor(Date.now()/1000)+60;f.s.lease=r._leaseUntil;
 await f.ctx.renewLeases();
 assert.deepEqual(f.s.writes,['renew']);assert.equal(r._leaseUntil,f.s.lease+1800);assert.deepEqual(f.releases(),[]);
});

test('explicit refusal - the platform administrator yanks the version, or the host owner denies the deployment: retired and released as before',{timeout:20_000},async()=>{
 for(const [why,set] of [['yank',w=>{w.catalog={...w.catalog,yanked:true};}],['owner',w=>{w.doc={...w.doc,denyDeployments:[dep]};w.revision=2;}]]){
  for(const action of ['audit','renew']){
   const f=fixture();set(f.w);const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
   if(action==='audit')await f.audit();else await f.ctx.renewLeases();
   assert.deepEqual(f.s.events,['stop','prove+release'],`${why}/${action}`);assert.equal(r.status,'terminated');
   assert.equal(r.walletHeld,undefined,'a definite refusal is no hold');assert.deepEqual(f.s.writes,[],'never renewed');
  }
 }
 const f=fixture();f.w.catalog={...f.w.catalog,yanked:true};
 const g=await f.ctx.gateAppReference(ref,{deploymentId:dep});assert.equal(g.error.status,403);assert.equal(g.error.code,'not_approved');
});

test('unknown (RPC quorum unavailable): stopped here, never renewed or released, on the audit AND the renewal path; the gate answers 503',{timeout:20_000},async()=>{
 for(const action of ['audit','renew']){
  const f=fixture();f.w.down=true;const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
  if(action==='audit')await f.audit();else await f.ctx.renewLeases();
  assert.deepEqual(f.s.events,['stop'],`${action}: stopped, nothing released`);assert.deepEqual(f.s.writes,[],`${action}: nothing sent`);
  assert.equal(r.status,'terminated');assert.match(r.walletHeld.why,/chain quorum unavailable/);assert.equal(r.walletHeld.stopConfirmed,true);
  assert.match(r.error,/lease is kept \(not renewed or released\)/);
 }
 const f=fixture();f.w.down=true;
 const g=await f.ctx.gateAppReference(ref,{deploymentId:dep});
 assert.equal(g.error.status,503,'unknown is the try-again answer, not a refusal');assert.equal(g.error.code,'wallet_policy_unavailable');
});

test('unknown never releases through the share-resize eviction or claims/resumes in tryClaim',{timeout:20_000},async()=>{
 const f=fixture();f.w.down=true;f.s.resize=true;const r=f.serve(f.rec());
 await f.ctx.switchTenantVersion(r,f.row({cpuMilli:200}));
 assert.deepEqual(f.s.events,[],'the resize is deferred (transient), not evicted with a release');assert.match(r.versionChange.error,/unavailable/);
 for(const resume of [false,true]){
  const t=fixture();t.w.down=true;
  const why=await t.ctx.tryClaim(t.row(),{wasmRef:'catalog'},[],{},{hinted:true,resume});
  assert.match(why,/host wallet policy unavailable/);assert.deepEqual(t.s.writes,[]);assert.deepEqual(t.s.adopted,[],`resume=${resume}: nothing adopted`);
 }
 const t=fixture();
 assert.equal(await t.ctx.tryClaim(t.row({leaseUntil:0n,runner:'0x'+'00'.repeat(32)}),{wasmRef:'catalog'},[],{},{hinted:true}),undefined);
 assert.deepEqual(t.s.writes,['claim'],'allowed: one claim');assert.deepEqual(t.s.adopted,['claim']);
});

test('no unsolicited release on unknown across repeated passes; the held id is not vouched for (its guest is not kept alive)',{timeout:20_000},async()=>{
 const f=fixture();f.w.down=true;f.s.stopOk=false;const r=f.serve(f.rec());
 f.ctx._ownLeases=new Map([[dep,f.s.lease]]);
 await f.audit();assert.equal(r.walletHeld.stopConfirmed,false,'an unconfirmed stop');
 assert.deepEqual([...f.ctx.unresumedOwnLeases()],[],'held: never vouched for as an unresumed lease, so the reconciler ends that guest');
 for(let i=0;i<5;i++){await f.audit();await f.ctx.renewLeases();}
 assert.deepEqual(f.releases(),[]);assert.deepEqual(f.s.writes,[]);
 assert.equal(f.s.events.filter(e=>e==='stop').length,6,'the unconfirmed stop is retried every pass');
});

test('expiry: a decision that passes its chain deadline in the operator queue is not sent; a held lease that lapses is simply let go',{timeout:20_000},async()=>{
 const f=fixture();f.w.authorityAge=89_800;   // the decision lives ~200 ms
 const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
 let open;f.ctx._txChain=new Promise(res=>{open=res;});   // an earlier operator transaction still in flight
 const pass=f.ctx.renewLeases();await sleep(500);open();await pass;
 assert.deepEqual(f.s.writes,[],'superseded at the send: nothing signed');assert.deepEqual(f.releases(),[]);
 assert.equal(r.status,'running');assert.ok(!(r._renewBackoffUntil>Date.now()),'no failure backoff: the next round decides afresh');
 const h=fixture();h.w.down=true;const held=h.serve(h.rec());await h.audit();
 h.s.lease=Math.floor(Date.now()/1000)-5;await h.audit({leaseUntil:BigInt(h.s.lease)});
 assert.equal(held.walletHeld,undefined,'nothing left to hold');assert.equal(held.status,'terminated');
 await h.ctx.renewLeases();assert.deepEqual(h.s.writes,[],'never re-claimed by the renewal path');assert.deepEqual(h.releases(),[]);
});

test('recovery: the policy becomes known again - allowed: the hold clears and the lease is resumable; refused: released as a retire (no final proof)',{timeout:20_000},async()=>{
 const f=fixture();f.w.down=true;const r=f.serve(f.rec());f.ctx._ownLeases=new Map([[dep,f.s.lease]]);
 await f.audit();assert.ok(r.walletHeld);
 f.w.down=false;await f.audit();
 assert.equal(r.walletHeld,undefined);assert.deepEqual(f.releases(),[]);assert.deepEqual(f.s.writes,[]);
 assert.deepEqual([...f.ctx.unresumedOwnLeases()],[dep],'vouched again: the claim sweep resumes it');
 assert.equal((await f.ctx.gateAppReference(ref,{deploymentId:dep})).error,undefined,'the resume gate passes');
 assert.equal(await f.ctx.tryClaim(f.row(),{wasmRef:'catalog'},[],{},{hinted:true,resume:true}),undefined);
 assert.deepEqual(f.s.adopted,['resume'],'resumed without a transaction');assert.deepEqual(f.s.writes,[]);
 const g=fixture();g.w.down=true;const h=g.serve(g.rec());await g.audit();
 g.w.down=false;g.w.catalog={...g.w.catalog,yanked:true};await g.audit();
 assert.deepEqual(g.s.events,['stop','release'],'refused after the hold: released, nothing proven for the held time');
 const refusal=(await g.w.admission.decision({deploymentId:dep,appRef:ref,forPrivate:false})).refusal;assert.ok(refusal);
 assert.equal(h.walletHeld,undefined);assert.equal(h.error,refusal,'the platform moderation refusal, verbatim');
});

test('in-flight race: a renewal decided ALLOWED waits in the operator queue, an audit meanwhile finds the policy unknown: nothing is sent (app-funded and operator-paid senders)',{timeout:20_000},async()=>{
 for(const appFunded of [true,false]){
  const f=fixture();const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
  if(appFunded){f.ctx.leaseGasActive=()=>true;f.ctx.leaseGasError=(fn,id,e)=>e;
   f.ctx.leaseGasSender=()=>({renew:async()=>{f.s.writes.push('sponsored renew');return {hash:'0x'+'bb'.repeat(32),receipt:{status:'success',blockNumber:7n}};}});}
  let open;f.ctx._txChain=new Promise(res=>{open=res;});
  const pass=f.ctx.renewLeases();await sleep(50);   // decided (allowed) and queued
  f.w.down=true;await f.audit({leaseUntil:BigInt(r._leaseUntil)});assert.ok(r.walletHeld);
  open();await pass;
  assert.deepEqual(f.s.writes,[],`appFunded=${appFunded}: the queued renewal is superseded by the hold`);
  assert.deepEqual(f.releases(),[]);assert.equal(r.status,'terminated');
  if(appFunded){   // control: the same sponsored sender does renew when nothing intervenes
   const c=fixture();c.ctx.leaseGasActive=()=>true;c.ctx.leaseGasError=(fn,id,e)=>e;
   c.ctx.leaseGasSender=()=>({renew:async()=>{c.s.writes.push('sponsored renew');return {hash:'0x'+'bb'.repeat(32),receipt:{status:'success',blockNumber:7n}};}});
   c.serve(c.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));await c.ctx.renewLeases();assert.deepEqual(c.s.writes,['sponsored renew']);
  }
 }
});

test('an older admission bundle (refusal() only, no decision()) is held as unknown, loudly - never read as allowed, never released',{timeout:20_000},async()=>{
 const f=fixture();const old=f.w.admission;f.ctx.__old={hostId:old.hostId,refusal:q=>old.refusal(q)};
 vm.runInContext('_hostWalletAdmission=__old',f.ctx);const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
 await f.audit();await f.ctx.renewLeases();
 assert.deepEqual(f.s.events,['stop']);assert.deepEqual(f.s.writes,[]);assert.match(r.walletHeld.why,/no decision\(\) \(an older bundle/);
 assert.equal((await f.ctx.gateAppReference(ref,{deploymentId:dep})).error.status,503);
});

test('source: every Linux lease send on a wallet decision carries its gate, and no caller folds unknown into a refusal',()=>{
 assert.equal(source.includes('hostWalletRefusal'),false);
 for(const s of ['sendLeaseTx("renew", [rec.id], { gate })','sendLeaseTx("claim", [rec.id, _enclaveId], { gate })',
                 'sendLeaseTx("claim", [rec.id, _enclaveId], { gate: walletSendGate(rec, w.validUntil) })',
                 'sendLeaseTx("claim", [d.id, _enclaveId], { gate: walletSendGate(null, wallet.validUntil) })'])
  assert.ok(source.includes(s),s);
 assert.equal((source.match(/sendLeaseTx\("(claim|renew)"/g)||[]).length,4,'no other claim/renew send');
 assert.equal((source.match(/hostWalletDecision\(/g)||[]).length,6,'definition + gate + renew + audit + held review + tryClaim');
});
