// Local only: verify the ca-east provider record and its signed qualifications in a probe's providers.json.
// usage: node verify-quals.mjs <providers.json> <probeStampUTC e.g. 20261021T201341Z>
import fs from 'node:fs';
import {verifyProviderRecord,verifyQualification,CHECKS} from '../../../enclave/network/provider-directory.mjs';
const TRUSTED=['0x57144c9008cff0b3ed94f6e40964a321fbee848a','0x033bc2b92bb1bb97c7dadf2879d3048748e2257b'];
const PID='c4c7888e4741dcbe2c092dd81e888bf7',ADDR='146.190.246.39';
const PINNED={operator:'0x3b0497d24b3fc8ef776a194b065118d52fb4248c',wgExitKey:'5yJS0uYW178RxnvOBa5N1uIGD1Z8iN+rbV88A5MU9Cs=',wgGuardKey:'tBHkbI2h+Qs6fwYw8OTlVPM862m+Yb3jOwxvL37U9nc='};
const ACTIVATED=Date.parse('2026-10-21T20:11:17Z');
const [file,stamp]=process.argv.slice(2);
const now=Date.parse(stamp.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/,'$1-$2-$3T$4:$5:$6Z'));
const d=JSON.parse(fs.readFileSync(file,'utf8'));
const out={file,now:new Date(now).toISOString(),activatedAt:new Date(ACTIVATED).toISOString(),trusted:TRUSTED,
 directoryCheckers:(d.checkers||[]).map(c=>String(c).toLowerCase()),errors:[]};
out.directoryCheckersMatchPinned=JSON.stringify([...out.directoryCheckers].sort())===JSON.stringify([...TRUSTED].sort());
const ents=(d.providers||[]).filter(p=>p?.record?.record?.providerId===PID);
out.matching=ents.length;
if(ents.length!==1)out.errors.push(`expected exactly 1 ca-east entry, got ${ents.length}`);
const perChecker={};
for(const e of ents){
 const r=e.record.record;
 try{await verifyProviderRecord(e.record,{now});out.record={ok:true,address:r.address,issuedAt:new Date(r.issuedAt).toISOString(),expiresAt:new Date(r.expiresAt).toISOString()};}
 catch(x){out.record={ok:false,error:x.message};out.errors.push('record: '+x.message);}
 for(const k of Object.keys(PINNED))if(r[k]!==PINNED[k])out.errors.push(`record ${k} differs from pinned`);
 if(r.address!==ADDR)out.errors.push('record address differs');
 out.qualifications=[];
 for(const qe of e.qualifications||[]){
  const q=qe.qualification,row={issuedAt:new Date(q.issuedAt).toISOString(),expiresAt:new Date(q.expiresAt).toISOString(),
   postActivation:q.issuedAt>ACTIVATED,allChecks:CHECKS.every(c=>q.checks?.[c]===true),checkKeys:Object.keys(q.checks||{}).length};
  try{const v=await verifyQualification(qe,r,{checkers:TRUSTED,now});row.ok=true;row.checker=v.checker;row.roles=v.roles;}
  catch(x){row.ok=false;row.error=x.message;}
  out.qualifications.push(row);
  if(row.ok&&row.allChecks&&row.postActivation){const p=perChecker[row.checker];if(!p||p.issuedAt<row.issuedAt)perChecker[row.checker]=row;}
 }
 if(!(e.qualifications||[]).length)out.errors.push('no qualifications');
 for(const q of out.qualifications)if(!q.ok||!q.allChecks)out.errors.push(`qualification ${q.issuedAt} ok=${q.ok} allChecks=${q.allChecks}${q.error?' '+q.error:''}`);
}
out.freshPostActivationByChecker=Object.fromEntries(TRUSTED.map(c=>[c,perChecker[c]?perChecker[c].issuedAt:null]));
out.allCheckersFresh=TRUSTED.every(c=>perChecker[c]);
if(!out.directoryCheckersMatchPinned)out.errors.push('directory checkers differ from pinned');
out.ok=out.errors.length===0;
console.log(JSON.stringify(out,null,1));
