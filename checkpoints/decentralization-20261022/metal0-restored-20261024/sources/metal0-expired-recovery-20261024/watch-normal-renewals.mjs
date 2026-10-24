// Read-only, bounded verification of normal-control renewals after this incident.
// No key use, no claims, no renew calls, no service changes. Never prints raw transactions.
import fs from 'node:fs';import {execFileSync} from 'node:child_process';import {deps} from './deps.mjs';import {APPS} from './reclaim.mjs';
const outFile='outputs/decentralization-audit/metal0-normal-renewals-20261024.json';
const baseline=JSON.parse(fs.readFileSync('outputs/decentralization-audit/metal0-approved-claims-20261024.json'));
const start=Date.now(),end=start+20*60*1000,done={},errors={};
const persist=status=>{const v={at:new Date().toISOString(),startedAt:new Date(start).toISOString(),status,readOnly:true,source:'enclave-metal.service journal since original control restart, independently verified renewal receipts',apps:done,errors};fs.writeFileSync(outFile,JSON.stringify(v,null,2)+'\n');return v;};
while(Date.now()<end){
 const state=execFileSync('systemctl',['--user','show','enclave-metal.service','-p','ActiveState','--value'],{encoding:'utf8',timeout:10000}).trim();if(state!=='active'){persist('control-not-active');throw Error('control stopped during renewal observation');}
 const lines=execFileSync('journalctl',['--user','-u','enclave-metal.service','--since','2026-10-23 21:26:26','--no-pager','-o','cat'],{encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024}).split('\n');
 for(const id of Object.keys(APPS)){
  if(done[id])continue;
  const prefix='[lease-gas] renew '+id+' landed in ',line=lines.findLast(l=>l.startsWith(prefix)),hash=line?.slice(prefix.length).match(/^0x[a-f0-9]{64}/)?.[0];if(!hash)continue;
  try{
   const r=await deps.confirmedPrior(id,{lastHash:hash});if(r.leaseUntil<=baseline.apps[id].leaseUntil)throw Error('normal renewal did not extend recovered lease');
   const health=await deps.health(id);if(!health.healthy||health.guest!==APPS[id])throw Error('original guest health differs');
   done[id]={...r,guest:APPS[id],originalGuestHealthy:true,previousClaimExpiry:baseline.apps[id].leaseUntil};delete errors[id];console.log(JSON.stringify({event:'normal-renewal-verified',id,hash,leaseUntil:r.leaseUntil}));
  }catch(e){errors[id]={at:new Date().toISOString(),type:e.name,reason:'Receipt or original-guest verification unavailable; not counted as success'};}
 }
 if(Object.keys(done).length===Object.keys(APPS).length){console.log(JSON.stringify(persist('verified-both-normal-renewals')));process.exit(0);}
 persist('awaiting-normal-renewals');await new Promise(r=>setTimeout(r,30000));
}
persist('observation-deadline-reached');process.exitCode=2;
