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
import net from 'node:net';
import {once} from 'node:events';
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
 const s={events:[],writes:[],adopted:[],stopOk:true,listOk:true,keepListed:false,deleteGate:null,egressClosed:[],lease:Math.floor(Date.now()/1000)+3600,
   instances:[{id:'vm-1',name:dep,status:'running'}]};
 // guestd's /vms at the edge: DELETE stops the guest (200, gone from the listing) or fails; GET lists what still runs
 const vmReq=async(method,path)=>{
  if(method==='DELETE'){s.events.push('stop');if(s.deleteGate)await s.deleteGate;if(!s.stopOk)return {status:500,body:{}};
   if(!s.keepListed)s.instances=s.instances.filter(v=>v.id!==decodeURIComponent(path.split('/').pop()));return {status:200,body:{}};}
  if(method==='GET'&&path==='/vms')return s.listOk?{status:200,body:{vms:s.instances}}:{status:503,body:{}};
  return {status:200,body:{}};};
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
  _reach:{tripped:false},RENEW_MARGIN_SEC:900,tenantProvisions:new Map(),_releaseIntents:new Map(),
  HOST_POLICY_GATE:{enabled:false,serviceRefusal:()=>null,status:()=>({})},_stateCorrupt:null,leaseGasActive:()=>false,leaseGasRenewDue:async()=>true,
  TERMINAL_STATUSES:new Set(['expired','failed','terminated','stopping']),lc:v=>String(v||'').toLowerCase(),
  placementRefusal:()=>null,readLedgerContract:async()=>row(),
  releaseGpu:()=>{s.events.push('freeGpu');},reconcileInstancesSoon:()=>{},egress:{closeDeployment:id=>{s.egressClosed.push(id);return 0;}},
  performTenantProvision:async rec=>{rec.status='running';return true;},
  proveAndRelease:async()=>{s.events.push('prove+release');},releaseLease:async()=>{s.events.push('release');return true;},
  saveStateSoon:()=>{},releaseHold:()=>null,
  // the operator queue's edge: the signer and the receipt
  _txChain:Promise.resolve(),DEPLOYMENTS_ADDRESS:'0x'+'99'.repeat(20),CLAIM_TX_ABI:[],
  claimSigner:()=>({account:{address:owner},wallet:{writeContract:async q=>{s.writes.push(q.functionName);return '0x'+'aa'.repeat(32);}}}),
  awaitReceipt:async()=>({status:'success',blockNumber:7n}),leaseFromReceipt:()=>s.lease+1800,noteLeaseFloor:()=>{},
  // the rest of the audit's healthy pass (nothing to switch, edit or relaunch)
  shareResizeVerdict:()=>s.resize?'resize':'same',needsVersionSwitch:()=>false,envelopeEditVerdict:()=>'skip',instanceAlive:async()=>true,
  noteProvisionFailure:()=>{},IS_GPU:true,parseDepOptions:()=>({}),bootstrapIntent:()=>false,
  // tryClaim's edges
  claimBondReady:async()=>true,PROVISION_BACKEND:'vm',vmReq,mgrReq:vmReq,openForUs:async()=>true,
  adopt:async(d,g,f,sl,o)=>{s.adopted.push(o?.resume?'resume':'claim');},_ownLeases:null,_onLeaseSigned:null,deployments:new Map(),
 });
 for(const [a,b] of [['let _hostWalletAdmission = null;','\nconst hostCatalogAddress='],['async function gateAppReference(','// A paid app is servable'],
   ['async function retireForPlacement(','\nfunction parseDepOptions('],['function sendOperatorTx(',"\n// ---- the operator's owner nomination"],
   ['function sendLeaseTx(','\n/** A sponsored renew'],['async function renewLeases()','\nasync function switchTenantVersion('],
   ['async function switchTenantVersion(','\nasync function applyEnvelopeEdit('],['async function auditClaims(','\nasync function fetchLedger('],
   ['async function tryClaim(','\n// On-chain record -> local rec'],['const HOST_POLICY_EXPLICIT','\nasync function reconcileInstances()'],
   ['function stopUnconfirmed(','\n// What app ran'],['async function listBackendInstances()','\n// ---- the heartbeat half'],
   ['// Established upgrade streams','\nfunction depByIdOrPrefix('],['function provisionTenant(rec) {','\n// Spawn the tenant']]){
  // an older supervisor (the 09ff3ed5 control) has no stream registry: inert stand-ins, so its cases fail on behaviour
  if(a==='// Established upgrade streams'&&!source.includes(a)){ctx.trackDeploymentStream=()=>{};ctx.cutDeploymentStreams=()=>0;continue;}
  vm.runInContext(between(a,b),ctx);
 }
 ctx.__adm=w.admission;vm.runInContext('_hostWalletAdmission=__adm',ctx);
 const rec=(over={})=>({id:dep,status:'running',_onchain:true,_leaseUntil:s.lease,owner,image:{reference:ref},resources:{gpuShare:0,cpuShare:0.1},
   _vmId:'vm-1',_gpu:{cpu:true,share:0.1},...over});
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
   assert.deepEqual(f.s.events,['stop','prove+release','freeGpu'],`${why}/${action}: freed only after the confirmed stop`);assert.equal(r.status,'terminated');
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
  assert.deepEqual(f.s.events,['stop','freeGpu'],`${action}: stopped (confirmed: slice freed), nothing released`);assert.deepEqual(f.s.writes,[],`${action}: nothing sent`);
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
 assert.deepEqual(g.s.events,['stop','freeGpu','release'],'refused after the hold: released, nothing proven for the held time');
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
 assert.deepEqual(f.s.events,['stop','freeGpu']);assert.deepEqual(f.s.writes,[]);assert.match(r.walletHeld.why,/no decision\(\) \(an older bundle/);
 assert.equal((await f.ctx.gateAppReference(ref,{deploymentId:dep})).error.status,503);
});

// ---- root review 1: a queued permission never outlives a withdrawal ------------------------------------------------
const blockQueue=f=>{let open;f.ctx._txChain=new Promise(r=>{open=r;});return ()=>open();};
// the sponsored client's documented order (client/lease-executor-client.mjs): relays read and admitted, the lease SIGNED,
// onSigned (a throw = NotPersisted, sent to no relay), then the relay POST - stubbed at exactly that seam
function appFunded(f,{delayMs=0}={}){
 f.ctx.leaseGasActive=()=>true;f.ctx.leaseGasError=(fn,id,e)=>e;
 f.ctx.leaseGasSender=()=>({renew:async id=>{await sleep(delayMs);
  try{f.ctx._onLeaseSigned?.({kind:'renew',lease:{id}});}catch(e){throw Object.assign(new Error('NotPersisted: '+e.message),{code:'NotPersisted'});}
  f.s.writes.push('relay POST renew');return {hash:'0x'+'bb'.repeat(32),receipt:{status:'success',blockNumber:7n}};}});
}
test('review 1: a VERIFIED refusal voids a renewal already queued under an earlier allow (operator-paid and app-funded)',{timeout:20_000},async()=>{
 for(const sponsored of [false,true]){
  const f=fixture();if(sponsored)appFunded(f);const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
  const open=blockQueue(f);const pass=f.ctx.renewLeases();await sleep(50);   // allowed and queued
  f.w.catalog={...f.w.catalog,yanked:true};await f.audit({leaseUntil:BigInt(r._leaseUntil)});   // the administrator's yank: retired
  open();await pass;
  assert.deepEqual(f.s.writes,[],`sponsored=${sponsored}: the old permission sends nothing and spends no reserve gas`);
  assert.ok(f.s.events.includes('prove+release'),'the refusal itself is enforced (released)');assert.equal(r.walletHeld,undefined);
 }
});
test('review 1: hold -> fresh allow cannot resurrect an earlier permission, even when the SAME record object serves again',{timeout:20_000},async()=>{
 for(const sponsored of [false,true]){
  const f=fixture();if(sponsored)appFunded(f);const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
  const open=blockQueue(f);const pass=f.ctx.renewLeases();await sleep(50);
  f.w.down=true;await f.audit({leaseUntil:BigInt(r._leaseUntil)});assert.ok(r.walletHeld);
  f.w.down=false;await f.audit({leaseUntil:BigInt(r._leaseUntil)});assert.equal(r.walletHeld,undefined,'allowed again: hold cleared');
  r.status='running';   // as if the resume reused this very object (walletHeld cleared, status back): the boolean alone would pass
  open();await pass;
  assert.deepEqual(f.s.writes,[],`sponsored=${sponsored}: superseded by the epoch, not by a flag`);
  r._renewing=false;await f.ctx.renewLeases();   // control: a renewal DECIDED after the recovery goes out
  assert.equal(f.s.writes.length,1,'a fresh decision renews');
 }
});
test('review 1: owner stop, a restart (re-provision) and a replaced record each void a queued renewal',{timeout:20_000},async()=>{
 for(const change of ['owner-stop','restart','replace']){
  const f=fixture();const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
  const open=blockQueue(f);const pass=f.ctx.renewLeases();await sleep(50);
  if(change==='owner-stop')await f.audit({leaseUntil:BigInt(r._leaseUntil),active:false});
  if(change==='restart'){await f.ctx.provisionTenant(r);assert.equal(r.status,'running','serving again after the restart');}
  if(change==='replace')f.ctx.deployments.set(dep,{...r});
  open();await pass;assert.deepEqual(f.s.writes,[],`${change}: nothing sent`);
 }
});
test('review 1: a renewal that reaches the queue WHILE an owner stop is still waiting for its DELETE is not sent (revoked before the await)',{timeout:20_000},async()=>{
 for(const sponsored of [false,true]){
  const f=fixture();if(sponsored)appFunded(f);const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
  const open=blockQueue(f);const pass=f.ctx.renewLeases();await sleep(50);
  let answer;f.s.deleteGate=new Promise(res=>{answer=res;});
  const stopping=f.audit({leaseUntil:BigInt(r._leaseUntil),active:false});await sleep(30);
  assert.equal(r.status,'running','the owner-stop path still reads running while its DELETE is outstanding');
  open();await pass;   // the queued renewal runs NOW, mid-stop
  assert.deepEqual(f.s.writes,[],`sponsored=${sponsored}: stopContainer revoked it synchronously`);
  answer();await stopping;
 }
});
test('review 1: app-funded - a hold that lands while the sponsored client is still admitting relays stops the SIGNED lease before any relay',{timeout:20_000},async()=>{
 const f=fixture();appFunded(f,{delayMs:300});const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
 const pass=f.ctx.renewLeases();await sleep(60);   // the queue's gate already passed; the client is inside its relay work
 f.w.down=true;await f.audit({leaseUntil:BigInt(r._leaseUntil)});assert.ok(r.walletHeld);
 await pass;
 assert.deepEqual(f.s.writes,[],'signed, given to no relay: the reserve pays nothing');
 assert.ok(!(r._renewBackoffUntil>Date.now()),'superseded, not a relay failure');
});
test('review 1: a claim decided ALLOWED is voided by a later refusal for that deployment from any caller (no local record to revoke)',{timeout:20_000},async()=>{
 const t=fixture();const open=blockQueue(t);
 const p=t.ctx.tryClaim(t.row({leaseUntil:0n,runner:'0x'+'00'.repeat(32)}),{wasmRef:'catalog'},[],{},{hinted:true});await sleep(50);
 t.w.catalog={...t.w.catalog,yanked:true};assert.ok((await t.ctx.hostWalletDecision(dep,ref,false)).refusal);
 open();await p;assert.deepEqual(t.s.writes,[]);assert.deepEqual(t.s.adopted,[]);
});

// ---- root review 2: a failed stop is not isolation ---------------------------------------------------------------
test('review 2: on a FAILED stop service is withdrawn at once (routes, open streams, egress, permits), the slice stays reserved and nothing resumes or replaces it until the backend confirms the guest gone',{timeout:30_000},async()=>{
 const f=fixture();const r=f.serve(f.rec());f.ctx._ownLeases=new Map([[dep,f.s.lease]]);
 // a REAL established stream into the deployment (an upgrade socket the data path handed over)
 const srv=net.createServer(sock=>{f.ctx.trackDeploymentStream(dep,sock);});srv.listen(0,'127.0.0.1');await once(srv,'listening');
 const client=net.connect(srv.address().port,'127.0.0.1');client.on('error',()=>{});await once(client,'connect');await sleep(30);
 let release;f.s.deleteGate=new Promise(res=>{release=res;});f.s.stopOk=false;f.w.down=true;
 const closed=once(client,'close');const pass=f.audit();await sleep(50);   // the guest's DELETE has not answered yet
 assert.equal(r.status,'terminated','withdrawn BEFORE the stop answers: every ingress admits only running records');
 await Promise.race([closed,sleep(2000).then(()=>{throw Error('the established stream was NOT cut');})]);
 assert.deepEqual(f.s.egressClosed,[dep],'its egress connections were closed');assert.ok(r._leaseEpoch>=1,'its lease permissions revoked');
 release();await pass;srv.close();
 assert.deepEqual(f.s.events,['stop'],'no slice freed on a failed stop');assert.ok(r._gpu,'the slice stays reserved');
 assert.ok(r._stopPending);assert.equal(r.walletHeld.stopConfirmed,false);assert.match(r.error,/NOT confirmed stopped/);
 assert.match(await f.ctx.tryClaim(f.row(),{wasmRef:'catalog'},[],{},{hinted:true,resume:true}),/not confirmed stopped/);
 assert.deepEqual(f.s.adopted,[],'no resume onto hardware the old guest may still hold');
 f.w.down=false;await f.audit();assert.ok(r.walletHeld,'allowed again, but the hold stays until the stop is confirmed');
 assert.deepEqual([...f.ctx.unresumedOwnLeases()],[],'still not vouched for');
 f.s.stopOk=true;f.s.keepListed=true;await f.audit();
 assert.ok(r.walletHeld&&r._stopPending,'DELETE answered 200 but the listing still shows the guest: not confirmed');
 assert.equal(f.s.events.filter(e=>e==='freeGpu').length,0);
 f.s.instances=[];f.ctx.settlePendingStops(f.s.instances);   // the reconciler's listing no longer names it
 assert.deepEqual(f.s.events.filter(e=>e==='freeGpu'),['freeGpu'],'freed exactly once, on confirmation');
 assert.equal(r._stopPending,undefined);assert.equal(r.walletHeld.stopConfirmed,true);
 await f.audit();assert.equal(r.walletHeld,undefined,'confirmed and allowed: the hold clears');
 assert.equal(await f.ctx.tryClaim(f.row(),{wasmRef:'catalog'},[],{},{hinted:true,resume:true}),undefined);assert.deepEqual(f.s.adopted,['resume']);
 assert.deepEqual(f.releases(),[],'and through all of it the lease was never released');
});
test('review 2: an administrator refusal with a FAILED stop still releases the lease, but the slice waits for the confirmed stop',{timeout:20_000},async()=>{
 const f=fixture();const r=f.serve(f.rec());f.s.stopOk=false;f.w.catalog={...f.w.catalog,yanked:true};
 await f.audit();
 assert.deepEqual(f.s.events,['stop','prove+release'],'the ban is enforced; no slice freed');assert.ok(r._gpu&&r._stopPending);assert.equal(r.status,'terminated');
 f.w.catalog={...f.w.catalog,yanked:false};   // even once the version is admitted again, nothing reclaims this id onto its slice
 assert.match(await f.ctx.tryClaim(f.row({leaseUntil:0n,runner:'0x'+'00'.repeat(32)}),{wasmRef:'catalog'},[],{},{hinted:true}),/not confirmed stopped/);
 assert.deepEqual(f.s.writes,[]);assert.deepEqual(f.s.adopted,[]);
 f.s.listOk=false;f.ctx.settlePendingStops(null);assert.ok(r._stopPending,'an unreadable listing confirms nothing');
 f.ctx.settlePendingStops([]);assert.ok(f.s.events.includes('freeGpu'));assert.equal(r._stopPending,undefined);
});

test('source: every Linux lease send on a wallet decision carries its gate, and no caller folds unknown into a refusal',()=>{
 assert.equal(source.includes('hostWalletRefusal'),false);
 for(const s of ['sendLeaseTx("renew", [rec.id], { gate })','sendLeaseTx("claim", [rec.id, _enclaveId], { gate })',
                 'sendLeaseTx("claim", [rec.id, _enclaveId], { gate: walletSendGate(rec, w.validUntil) })',
                 'sendLeaseTx("claim", [d.id, _enclaveId], { gate: walletSendGate(null, wallet.validUntil, d.id) })'])
  assert.ok(source.includes(s),s);
 assert.equal((source.match(/sendLeaseTx\("(claim|renew)"/g)||[]).length,4,'no other claim/renew send');
 assert.equal((source.match(/hostWalletDecision\(/g)||[]).length,6,'definition + gate + renew + audit + held review + tryClaim');
 for(const pin of ['async function stopContainer(rec) {\n  // every teardown and relaunch comes here first: lease permissions and established streams end NOW, before any await\n  revokeLeasePermits(rec); cutDeploymentStreams(rec.id);',
   'revokeLeasePermits(rec);   // a (re)launch starts a new serving life',
   'settlePendingStops(instances);   // unconfirmed stops',
   'if (r._gpu && TERMINAL_STATUSES.has(r.status) && !r._stopPending) r._gpu = null;',
   'if (ex && ex._stopPending) return "its previous instance here is not confirmed stopped yet',
   'if (xr) trackDeploymentStream(xr.id, socket);'])
  assert.ok(source.includes(pin),pin.slice(0,80));
 const rec=source.slice(source.indexOf('async function reconcileInstances()'));
 assert.ok(rec.indexOf('settlePendingStops(instances)')<rec.indexOf('orphanInstancePlan('),'settled from the same listing, before reaping');
});
