// Shared vm fixture for the Linux supervisor wallet-hold suites (see test/supervisor-wallet-unknown-hold.test.mjs):
// the REAL supervisor.js function bodies (sliced), the REAL shipped admission bundle on a scripted agreeing reader, and
// scripted chain/guestd edges. SUPERVISOR_JS picks the supervisor file (controls, mutants).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import net from 'node:net';
import {once} from 'node:events';
export const SUPERVISOR=process.env.SUPERVISOR_JS||new URL('../../supervisor.js',import.meta.url);
export const source=fs.readFileSync(SUPERVISOR,'utf8');
const {createHostAdmission}=await import('../../windows/node/host-admission.bundle.mjs');
const {hostAdmissionPolicyHash}=await import('../../network/host-admission-policy.mjs');
export function between(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`supervisor.js has ${start}`);return source.slice(a,b);}
export const host='0x'+'ab'.repeat(32),dep='0x'+'cd'.repeat(32),app='0x'+'ef'.repeat(32),catalog='0x'+'12'.repeat(20),ref=`catalog://${app}/1`;
export const ownership='0x'+'11'.repeat(20),registry='0x'+'22'.repeat(20),owner='0x'+'44'.repeat(20);
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// the shipped bundle's admission: this host owner's policy document + the platform catalog, through an agreeing reader
export function admission({hostId=host}={}){
 const doc={version:1,chainId:8453,ownershipContract:ownership,hostId,requireCatalogApproval:false,denyDeployments:[],denyAppRefs:[]};
 const w={catalog:{active:true,approval:1,yanked:false},down:false,authorityAge:0,doc};
 const client={readContract:async q=>{
  if(q.functionName==='registry')return registry;
  if(q.functionName==='authority')return [owner,owner,BigInt(w.revision||1),hostAdmissionPolicyHash(w.doc)];
  if(q.functionName==='getApp')return {appId:app,versionCount:2,...w.catalog};
  if(q.functionName==='getVersion')return w.catalog;
  throw Error('unexpected read '+q.functionName);
 }};
 const reader={agreed:async fn=>{if(w.down)throw Error('chain quorum unavailable');const value=await fn(client,100n);
  // an OLD in-flight read: it observed the catalog, then returns only when released (after a newer answer landed)
  if(!value.owner){w.reads=(w.reads||0)+1;if(w.holdNextRead){const hold=w.holdNextRead;w.holdNextRead=null;await hold;}}
  return {timestamp:Date.now()-(value.owner?w.authorityAge:0),...value};}};
 w.admission=createHostAdmission({hostId,ownershipContract:ownership,registry,catalog,reader,loadPolicy:async()=>w.doc,now:()=>Date.now()});
 return w;
}
export function fixture({hostId=host}={}){
 const w=admission({hostId});
 const s={events:[],writes:[],adopted:[],stopOk:true,listOk:true,keepListed:false,deleteGate:null,egressClosed:[],lease:Math.floor(Date.now()/1000)+3600,
   instances:[{id:'vm-1',name:dep,status:'running'}]};
 // guestd's /vms at the edge: DELETE stops the guest (200, gone from the listing) or fails; GET lists what still runs
 const vmReq=async(method,path)=>{
  if(method==='DELETE'){s.events.push('stop');if(s.deleteGate)await s.deleteGate;if(!s.stopOk)return {status:500,body:{}};
   if(!s.keepListed)s.instances=s.instances.filter(v=>v.id!==decodeURIComponent(path.split('/').pop()));return {status:200,body:{}};}
  if(method==='GET'&&path==='/vms')return s.listOk?{status:200,body:{vms:s.instances}}:{status:503,body:{}};
  return {status:200,body:{}};};
 const row=(over={})=>({id:dep,appRef:ref,isPublic:true,active:true,owner,runner:hostId,leaseUntil:BigInt(s.lease),configCid:'',gpuMilli:0,cpuMilli:100,
   spent6:0n,balance6:1000000n,rate:1n,...over});
 const ctx=vm.createContext({console,Date,Number,BigInt,Set,Map,Error,String,Object,Promise,JSON,Math,Array,Infinity,
  HOST_WALLET_POLICY:true,_enclaveId:hostId,RPC_POOL:[],hostAdmissionFromEnv:()=>{throw Error('the test admission is preset');},
  hostCatalogAddress:()=>catalog,CATALOG_REF_RE:/^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d{1,9})$/,ZERO32:'0x'+'00'.repeat(32),CATALOG_ABI:[],
  getAddress:a=>a,catSchemaRev:async()=>7,gpuOptionalOfConfig:()=>false,cpuFallbackOfConfig:()=>null,
  approvalVerdict:()=>{throw Error('wallet mode never consults the global approval');},
  chainClient:{readContract:async q=>{
   if(q.functionName==='getApp')return {appId:app,versionCount:2,active:true,publisher:catalog,slug:'test'};
   if(q.functionName==='getVersion')return {cid:'cid',version:'1',active:true,yanked:false,approval:1,config:'{}'};
   if(q.functionName==='versionFee')return 0n;if(q.functionName==='versionConfigCid')return '';throw Error('unexpected read');},
   // sendOperatorTx's explicit fee/gas reads (5db2be3f port): fixed answers, the write is still the recorded writeContract
   estimateFeesPerGas:async()=>({maxFeePerGas:7_000_000n,maxPriorityFeePerGas:1_000_000n}),estimateContractGas:async()=>50_000n},
  _reach:{tripped:false},RENEW_MARGIN_SEC:900,tenantProvisions:new Map(),_releaseIntents:new Map(),
  HOST_POLICY_GATE:{enabled:false,serviceRefusal:()=>null,status:()=>({})},_stateCorrupt:null,chainActionGate:async()=>{},leaseGasActive:()=>false,leaseGasRenewDue:async()=>true,
  TERMINAL_STATUSES:new Set(['expired','failed','terminated','stopping']),lc:v=>String(v||'').toLowerCase(),
  placementRefusal:()=>null,readLedgerContract:async()=>row(),
reconcileInstancesSoon:()=>{},egress:{closeDeployment:id=>{s.egressClosed.push(id);return 0;}},
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
  // abandonClaims / ledgerMoveSweep / loadState / reconcilePools / the slice ledger
  ledgerMoveVerdict:(r)=>s.ledgerMoved?'teardown':'same',_ledgerMoveBusy:false,cpuPool:{shareFree:1},gpuCards:[],cardVram:c=>80,ctxOverheadGb:()=>0,
  round1:x=>x,round3:x=>x,_statePersistable:true,STATE_FILE:'/state.json',existsSync:()=>!!s.stateJson,readFileSync:()=>s.stateJson,
  leaseGasConfigured:()=>false,releaseJournalProblem:()=>null,_payFromBlock:null,_ownerNominationRecord:null,_seenLogs:new Map(),payRefIndex:new Map(),
  armPayTimer:()=>{},_leaseFloors:new Map(),_evacuated:new Map(),process:{env:{}},
 });
 for(const [a,b] of [['let _hostWalletAdmission = null;','\nconst hostCatalogAddress='],['async function gateAppReference(','// A paid app is servable'],
   ['async function retireForPlacement(','\nfunction parseDepOptions('],['function sendOperatorTx(',"\n// ---- the operator's owner nomination"],
   ['function sendLeaseTx(','\n/** A sponsored renew'],['async function renewLeases()','\nasync function switchTenantVersion('],
   ['async function switchTenantVersion(','\nasync function applyEnvelopeEdit('],['async function auditClaims(','\nasync function fetchLedger('],
   ['async function tryClaim(','\n// On-chain record -> local rec'],['const HOST_POLICY_EXPLICIT','\nasync function reconcileInstances()'],
   ['function stopUnconfirmed(','\n// What app ran'],['async function listBackendInstances()','\n// ---- the heartbeat half'],
   ['// Established upgrade streams','\nfunction depByIdOrPrefix('],['function provisionTenant(rec) {','\n// Spawn the tenant'],
   ['async function abandonClaims(','\n// mirrors EnclaveDeployments.Deployment'],['async function ledgerMoveSweep()','\n// Publisher-yank enforcement (see'],
   ['function loadState() {','\n// ---- pool reconciliation'],['function reconcilePools() {','\nfunction startPoolReconciler()'],
   ['function releaseGpu(h) {','\n// largest slice a single card'],['function allocCpu(share) {','\n// On the per-app isolation tier the share ledger']]){
  // an older supervisor (the 09ff3ed5 control) has no stream registry: inert stand-ins, so its cases fail on behaviour
  if(a==='// Established upgrade streams'&&!source.includes(a)){ctx.trackDeploymentStream=()=>{};ctx.cutDeploymentStreams=()=>0;continue;}
  vm.runInContext(between(a,b),ctx);
 }
 ctx.__adm=w.admission;vm.runInContext('_hostWalletAdmission=__adm',ctx);
 // the REAL slice release, with the event trail kept
 ctx.__ev=e=>s.events.push(e);vm.runInContext('{const real=releaseGpu;releaseGpu=function(h){__ev("freeGpu");return real(h);};}',ctx);
 const rec=(over={})=>({id:dep,status:'running',_onchain:true,_leaseUntil:s.lease,owner,image:{reference:ref},resources:{gpuShare:0,cpuShare:0.1},
   _vmId:'vm-1',_gpu:{cpu:true,share:0.1},...over});
 const audit=(over={})=>ctx.auditClaims(new Map([[dep,row(over)]]));
 const releases=()=>s.events.filter(e=>/release/.test(e));
 return {w,s,ctx,rec,row,audit,releases,serve:(r)=>{ctx.deployments=new Map([[dep,r]]);return r;}};
}

export const blockQueue=f=>{let open;f.ctx._txChain=new Promise(r=>{open=r;});return ()=>open();};
// the sponsored client's documented order (client/lease-executor-client.mjs): relays read and admitted, the lease SIGNED,
// onSigned (a throw = NotPersisted, sent to no relay), then the relay POST - stubbed at exactly that seam
export function appFunded(f,{delayMs=0}={}){
 f.ctx.leaseGasActive=()=>true;f.ctx.leaseGasError=(fn,id,e)=>e;
 const op=kind=>async id=>{await sleep(delayMs);
  try{f.ctx._onLeaseSigned?.({kind,lease:{id}});}catch(e){throw Object.assign(new Error('NotPersisted: '+e.message),{code:'NotPersisted'});}
  f.s.writes.push('relay POST '+kind);return {hash:'0x'+'bb'.repeat(32),receipt:{status:'success',blockNumber:7n}};};
 f.ctx.leaseGasSender=()=>({renew:op('renew'),claim:op('claim')});
}
