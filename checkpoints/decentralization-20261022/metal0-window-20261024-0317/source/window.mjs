// SOURCE ONLY until root has explicit human approval. One additional renewal per pinned app; original keeper untouched.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const APPS=Object.freeze({'0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9':'gd9d4a391d','0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c':'gdd0646f2c'});
export const LIMIT=Object.freeze({operator:'0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab',runner:'0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be',maxChargeWei:'4000000000000',expiresAt:Date.parse('2026-10-24T03:30:00Z')/1000,reserve:'0x12a3f873041dec436daa0085b766a399a6fa3639',executor:'0x8900baca2167873ba2f8a8bae8b4876e6396d343',ledger:'0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b'});
const need=(x,m)=>{if(!x)throw Error('maintenance window refused: '+m);};
const lower=x=>String(x??'').toLowerCase();
export const digest=b=>createHash('sha256').update(b).digest('hex');
function directory(p){const s=fs.lstatSync(p);need(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o700&&fs.realpathSync(p)===p,'private canonical directory required');}
function read(file){const s=fs.lstatSync(file);need(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o600&&s.size<65536,'bounded private record required');return JSON.parse(fs.readFileSync(file,'utf8'));}
function write(file,obj){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(obj,(_k,v)=>typeof v==='bigint'?String(v):v)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
export function validateApproval(a,now){need(a?.operation==='one-paired-metal0-renewal-window-20261024'&&a.humanApproved===true&&typeof a.humanMessage==='string'&&a.humanMessage.trim().length>=8&&Number.isSafeInteger(a.approvedAt)&&a.approvedAt<=now&&a.approvedAt>now-3600&&a.expiresAt===LIMIT.expiresAt&&now<LIMIT.expiresAt&&a.maxPerApp===1&&a.maxChargeWei===LIMIT.maxChargeWei&&JSON.stringify(a.apps)===JSON.stringify(APPS),'explicit current approval and exact finite scope required');}
export function priorInventory(oldDir){
 directory(oldDir);need(fs.existsSync(path.join(oldDir,'STOP')),'old keeper STOP marker required');const rows={};
 for(const id of Object.keys(APPS)){
  const d=path.join(oldDir,id);directory(d);const names=fs.readdirSync(d);const intents=names.filter(n=>/^\d{3}\.intent\.json$/.test(n)).sort(),results=names.filter(n=>/^\d{3}\.result\.json$/.test(n)).sort();
  const expected=Array.from({length:8},(_,i)=>String(i+1).padStart(3,'0'));
  need(JSON.stringify(intents)===JSON.stringify(expected.map(n=>n+'.intent.json'))&&JSON.stringify(results)===JSON.stringify(expected.map(n=>n+'.result.json')),'old keeper must have exactly eight reconciled attempts per app');
  const last=read(path.join(d,'008.result.json'));need(last.id===id&&last.guest===APPS[id]&&last.receiptVerified===true&&last.operatorEthSpent===false&&/^0x[0-9a-fA-F]{64}$/.test(last.hash)&&Number.isSafeInteger(last.leaseUntilAfter),'old final result invalid');
  // No old intent contents are opened, copied, overwritten or deleted.
  rows[id]={lastHash:last.hash,leaseUntil:last.leaseUntilAfter};
 }
 return rows;
}
export async function extendWindow({oldDir,dir,approval,approvalHash,deps,stopped,health,now=()=>Math.floor(Date.now()/1000)}){
 validateApproval(approval,now());need(digest(JSON.stringify(approval))===approvalHash,'approval digest differs');directory(dir);await stopped();await health();
 const prior=priorInventory(oldDir),receipt=path.join(dir,'approval.json');
 if(fs.existsSync(receipt))need(read(receipt).approvalHash===approvalHash,'a different extension already owns this journal');
 else write(receipt,{approvalHash,approval,prior});
 for(const id of Object.keys(APPS))need(fs.existsSync(path.join(dir,id+'.intent.json'))===fs.existsSync(path.join(dir,id+'.result.json')),'ambiguous or incomplete extension attempt; reconcile, never re-sign');
 const out={at:now(),apps:{}};
 for(const [id,guest] of Object.entries(APPS)){
  const result=path.join(dir,id+'.result.json'),intent=path.join(dir,id+'.intent.json');
  if(fs.existsSync(result)){out.apps[id]=read(result);continue;}
  validateApproval(approval,now());await stopped();
  const lease=await deps.lease(id);need(lease.active===true&&lower(lease.runner)===LIMIT.runner&&lower(lease.runnerOperator)===LIMIT.operator&&Number(lease.leaseUntil)>=prior[id].leaseUntil&&Number(lease.leaseUntil)>now()+60,'original live lease required');
  const g=await deps.guest(id,guest);need(g.status==='running'&&g.name===id&&g.vm===guest,'original guest required');
  // The control endpoint is unavailable while its unit is stopped; the actual stopped-unit guard owns exclusion.
  const policy=await deps.policy(id,lease);if(policy.status!=='Ready'){out.apps[id]={status:'waiting',reason:String(policy.status).slice(0,60),leaseUntil:Number(lease.leaseUntil)};continue;}
  let signed=false;
  const onSigned=async r=>{
   validateApproval(approval,now());await stopped();need(!signed&&r.kind==='renew'&&lower(r.operator)===LIMIT.operator&&Number(r.chainId)===8453&&lower(r.reserve)===LIMIT.reserve&&lower(r.executor)===LIMIT.executor&&lower(r.ledger)===LIMIT.ledger
    &&r.lease?.id===id&&Number(r.lease.kind)===2&&r.lease.enclaveId==='0x'+'0'.repeat(64)&&BigInt(r.lease.maxChargeWei)>0n&&BigInt(r.lease.maxChargeWei)<=BigInt(LIMIT.maxChargeWei)
    &&BigInt(r.lease.deadline)>BigInt(now())&&BigInt(r.lease.deadline)<=BigInt(now()+310),'signed lease exceeds extension scope');
   write(intent,r);signed=true;
  };
  try{
   const r=await deps.renew(id,onSigned);need(signed&&/^0x[0-9a-fA-F]{64}$/.test(r.hash)&&BigInt(r.chargedWei)>=0n&&BigInt(r.chargedWei)<=BigInt(LIMIT.maxChargeWei),'verified renewal result invalid');
   const after=await deps.lease(id);need(after.active===true&&lower(after.runner)===LIMIT.runner&&lower(after.runnerOperator)===LIMIT.operator&&Number(after.leaseUntil)>Number(lease.leaseUntil),'lease did not extend under original operator');
   const publicResult={status:'renewed',id,guest,hash:r.hash,chargedWei:String(r.chargedWei),leaseUntil:Number(after.leaseUntil),operatorEthSpent:false};write(result,publicResult);out.apps[id]=publicResult;
  }catch{throw Error('maintenance window refused: renewal outcome needs reconciliation; no automatic re-sign');}
 }
 await health();out.complete=Object.keys(APPS).every(id=>fs.existsSync(path.join(dir,id+'.result.json')));return out;
}
