// One finite pair of app-funded claims. No runtime is invoked by importing this module.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {APPS,priorInventory} from '../custody-maintenance-window-20261024/window.mjs';
export {APPS};
export const LIMIT=Object.freeze({operator:'0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab',runner:'0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be',owner:'0x0b2d009c0c9af05b12100d77f3c815fea822ee61',maxChargeWei:'6000000000000',expiresAt:1792816200,reserve:'0x12a3f873041dec436daa0085b766a399a6fa3639',executor:'0x8900baca2167873ba2f8a8bae8b4876e6396d343',ledger:'0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b'});
export const RECORDS=Object.freeze({[Object.keys(APPS)[0]]:'507be9a521c8e856c4a456ec79babaa32363fde930d5faa763dcc43f4033b7e9',[Object.keys(APPS)[1]]:'4c6a3075a5b41248c23b3f14a1c3c39fec5f9841952faf3ab2a9d37ce3fb29c8'});
const need=(v,m)=>{if(!v)throw Error('expired-lease recovery refused: '+m);},lower=v=>String(v??'').toLowerCase();
export const digest=v=>createHash('sha256').update(v).digest('hex');
function directory(p){const s=fs.lstatSync(p);need(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o700&&fs.realpathSync(p)===p,'private canonical directory required');}
function read(p){const s=fs.lstatSync(p);need(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o600&&s.size<65536,'bounded private record required');return JSON.parse(fs.readFileSync(p,'utf8'));}
function write(p,v){const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(v,(_k,x)=>typeof x==='bigint'?String(x):x)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const d=fs.openSync(path.dirname(p),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
export function validateApproval(a,now){need(a?.operation==='paired-metal0-expired-claims-20261024'&&a.humanApproved===true&&typeof a.humanMessage==='string'&&a.humanMessage.trim().length>=8&&Number.isSafeInteger(a.approvedAt)&&a.approvedAt<=now&&a.approvedAt>now-3600&&a.expiresAt===LIMIT.expiresAt&&now<LIMIT.expiresAt&&a.maxPerApp===1&&a.maxChargeWei===LIMIT.maxChargeWei&&a.acceptsExpiredLeaseRecovery===true&&JSON.stringify(a.apps)===JSON.stringify(APPS),'explicit current approval and exact finite scope required');}
export async function reclaimPair({oldDir,dir,approval,approvalHash,deps,stopped,now=()=>Math.floor(Date.now()/1000)}){
 validateApproval(approval,now());need(digest(JSON.stringify(approval))===approvalHash,'approval digest differs');directory(dir);await stopped();
 const prior=priorInventory(oldDir),approvalFile=path.join(dir,'approval.json');
 if(fs.existsSync(approvalFile))need(read(approvalFile).approvalHash===approvalHash,'different approval owns this journal');else write(approvalFile,{approvalHash,approval,prior});
 for(const id of Object.keys(APPS))need(fs.existsSync(path.join(dir,id+'.intent.json'))===fs.existsSync(path.join(dir,id+'.result.json')),'incomplete attempt; reconcile, never re-sign');
 // The old keeper's immediate post-send read can lag its verified receipt.
 // Derive the exact original expiry at that receipt block; never accept an arbitrary newer lease.
 const confirmed={};for(const id of Object.keys(APPS)){
  const p=await deps.confirmedPrior(id,prior[id]);
  need(p.receiptVerified===true&&p.hash===prior[id].lastHash&&Number.isSafeInteger(p.leaseUntil)&&p.leaseUntil>=prior[id].leaseUntil,'original renewal receipt expiry required');confirmed[id]=p;
 }
 const original=async id=>{const g=await deps.health(id);need(g.id===id&&g.guest===APPS[id]&&g.healthy===true&&g.strictTls===true&&g.recordSha256===RECORDS[id],'original app health/record required');return g;};
 const lease=async(id,expired=true)=>{
  const r=await deps.lease(id),ts=Number(r.blockTs);need(Number.isSafeInteger(ts)&&Math.abs(now()-ts)<=30&&r.active===true&&lower(r.owner)===LIMIT.owner&&lower(r.runner)===LIMIT.runner&&lower(r.runnerOperator)===LIMIT.operator,'fresh original owner/runner required');
  if(expired)need(Number(r.leaseUntil)===confirmed[id].leaseUntil&&Number(r.leaseUntil)<ts,'original expired lease required; another claim may have occurred');return r;
 };
 // All apps must still be the originals before spending on either.
 for(const id of Object.keys(APPS)){await original(id);if(!fs.existsSync(path.join(dir,id+'.result.json')))await lease(id);}
 const out={at:now(),apps:{}};
 for(const [id,guest] of Object.entries(APPS)){
  const resultFile=path.join(dir,id+'.result.json'),intentFile=path.join(dir,id+'.intent.json');
  if(fs.existsSync(resultFile)){const r=read(resultFile);need(r.status==='claimed'&&r.id===id&&r.guest===guest&&/^0x[a-fA-F0-9]{64}$/.test(r.hash),'invalid completed result');out.apps[id]=r;continue;}
  validateApproval(approval,now());await stopped();await original(id);await lease(id);
  const policy=await deps.policy(id);need(policy.status==='Ready','claim policy is not ready');
  let signed=false;
  const onSigned=async r=>{
   validateApproval(approval,now());await stopped();await original(id);await lease(id);
   need(!signed&&r.kind==='claim'&&Number(r.chainId)===8453&&lower(r.operator)===LIMIT.operator&&lower(r.reserve)===LIMIT.reserve&&lower(r.executor)===LIMIT.executor&&lower(r.ledger)===LIMIT.ledger&&r.lease?.id===id&&Number(r.lease.kind)===1&&lower(r.lease.enclaveId)===LIMIT.runner&&BigInt(r.lease.maxChargeWei)>0n&&BigInt(r.lease.maxChargeWei)<=BigInt(LIMIT.maxChargeWei)&&BigInt(r.lease.deadline)>BigInt(now())&&BigInt(r.lease.deadline)<=BigInt(now()+310),'signed claim exceeds exact scope');
   write(intentFile,r);signed=true;
  };
  try{
   const r=await deps.claim(id,onSigned);need(signed&&/^0x[a-fA-F0-9]{64}$/.test(r.hash)&&r.receiptVerified===true&&BigInt(r.chargedWei)>=0n&&BigInt(r.chargedWei)<=BigInt(LIMIT.maxChargeWei),'verified claim result required');
   const after=await lease(id,false);need(Number(after.leaseUntil)>now()&&Number(after.leaseUntil)>confirmed[id].leaseUntil,'claim lease effect missing');
   const pub={status:'claimed',id,guest,hash:r.hash,chargedWei:String(r.chargedWei),leaseUntil:Number(after.leaseUntil),operatorEthSpent:false};write(resultFile,pub);out.apps[id]=pub;
  }catch{throw Error('expired-lease recovery refused: claim outcome needs reconciliation; no automatic re-sign');}
 }
 for(const id of Object.keys(APPS)){await original(id);const current=await lease(id,false);need(Number(current.leaseUntil)===out.apps[id].leaseUntil,'lease changed after verified claim');}
 out.complete=true;out.minimumLeaseRemainingSec=Math.min(...Object.values(out.apps).map(r=>r.leaseUntil-now()));
 out.maintenanceWindowPossible=out.minimumLeaseRemainingSec>=1620; // Separate funding approval, 300+60 quiescence and fresh >=1200s gate remain mandatory.
 return out;
}
