// Fresh SNP evidence for the corrected custodian. Production callers supply the hash-checked r2 verifier modules.
// The returned machine is PRIVATE handoff data (contains a chip identifier); only publicEvidence may be journaled.
import {createHash,randomBytes} from 'node:crypto';
import {R2,METAL0_REGISTRY_ID,ORIGINAL_VAULT_V2} from './plan.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const H=/^0x[0-9a-f]{64}$/,A=/^0x[0-9a-f]{40}$/;
const LOCAL=Symbol('local-attestation-error');
const need=(ok,why)=>{if(!ok)throw Object.assign(Error(`custodian attestation refused: ${why}`),{[LOCAL]:true});};
const fields=['chipId','encKey','endpoint','identity','measurement','registryId'];
const MIN_TCB=Object.freeze({Genoa:Object.freeze({bootloader:10,tee:0,snp:23,microcode:84}),Turin:Object.freeze({fmc:1,bootloader:3,tee:2,snp:5,microcode:117})});
export const MAX_EVIDENCE_BYTES=256*1024;
export const MAX_QUOTE_AGE_MS=120000;

export function checkR2Manifest(bytes) {
 need(Buffer.isBuffer(bytes)&&sha(bytes)===R2.manifestSha256,'release manifest is not the reviewed r2 bytes');
 const m=JSON.parse(bytes.toString('utf8'));
 need(m.role==='enclave-custodian-v2'&&m.commit===R2.commit&&m.vault===ORIGINAL_VAULT_V2&&m.hostOwnership===R2.hostOwnership
  &&m.transport==='direct'&&m.measurement===R2.measurement&&m.measurementSha256===R2.measurementSha256,'release manifest fields differ');
 return m;
}
function base64(s,max) {
 need(typeof s==='string'&&s.length>0&&s.length<=Math.ceil(max/3)*4&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s),'malformed evidence encoding');
 const b=Buffer.from(s,'base64');need(b.length<=max&&b.toString('base64')===s,'noncanonical evidence encoding');return b;
}
export async function attestR2Custodian({endpoint,manifestBytes,verifier,bindingOf,fetchImpl=fetch,rng=randomBytes,now=()=>Date.now()}) {
 try {
  checkR2Manifest(manifestBytes);
  const u=new URL(endpoint);
  need(u.protocol==='https:'&&u.origin===endpoint&&!u.username&&!u.password,'exact HTTPS origin required');
  need(['verifyQuote','parseSnpReport','provenSnpChip'].every(k=>typeof verifier?.[k]==='function')&&typeof bindingOf==='function','reviewed verifier dependencies required');
  const nonce=rng(32);need(Buffer.isBuffer(nonce)&&nonce.length===32,'32-byte random challenge required');
  const started=now();need(Number.isSafeInteger(started),'invalid local clock');
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),20000);
  let ev;
  try {
   const r=await fetchImpl(endpoint+'/v2/custody/evidence',{method:'POST',headers:{'content-type':'application/json','cache-control':'no-store'},
    body:JSON.stringify({nonce:nonce.toString('hex')}),redirect:'error',cache:'no-store',signal:ctrl.signal});
   need(r.status===200&&!r.redirected,'evidence endpoint did not return direct success');
   need(/^application\/json(?:\s*;|$)/i.test(r.headers.get('content-type')||''),'evidence response is not JSON');
   const length=r.headers.get('content-length');
   need(length===null||(/^\d+$/.test(length)&&Number(length)<=MAX_EVIDENCE_BYTES),'evidence response exceeds size limit');
   let n=0;const chunks=[];
   for await(const chunk of r.body??[]){n+=chunk.length;need(n<=MAX_EVIDENCE_BYTES,'evidence response exceeds size limit');chunks.push(Buffer.from(chunk));}
   ev=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }finally{clearTimeout(timer);ctrl.abort();}
  const m=ev?.machine;
  need(m&&typeof m==='object'&&!Array.isArray(m)&&Object.keys(m).sort().join(',')===fields.join(','),'exact machine record required');
  need(A.test(m.identity)&&!/^0x0{40}$/.test(m.identity)&&['encKey','chipId','registryId','measurement'].every(k=>H.test(m[k])&&!/^0x0{64}$/.test(m[k])),'invalid machine fields');
  need(m.endpoint===endpoint&&m.registryId===METAL0_REGISTRY_ID&&m.measurement===R2.measurementSha256,'wrong custodian endpoint, host or release');
  const report=base64(ev.report,1184);need(report.length===1184,'SNP report size differs');
  const auxblob=ev.auxblob===null||ev.auxblob===undefined?null:base64(ev.auxblob,128*1024);
  const binding=Buffer.from(bindingOf(m,nonce));need(binding.length===32,'machine challenge binding size differs');
  const v=await verifier.verifyQuote(report,{expectedBinding:binding,allowedMeasurements:[R2.measurement],auxblob,
   requireVcek:true,minTcb:structuredClone(MIN_TCB),expectedVmpl:0});
  need(v?.ok===true&&v.vcekVerified===true&&v.tcb?.checked===true&&v.vmpl===0&&v.measurement===R2.measurement,'AMD signature, firmware floor, privilege or measurement verification failed');
  const p=verifier.parseSnpReport(report),chip=verifier.provenSnpChip(report,v);
  need(p.vmpl===0&&(p.policy&((1n<<19n)|(1n<<18n)))===0n,'guest policy or privilege differs');
  need(p.measurement.toString('hex')===R2.measurement&&'0x'+sha(p.measurement)===m.measurement,'quoted measurement differs from machine');
  need(typeof chip==='string'&&/^[0-9a-f]{128}$/.test(chip)&&'0x'+sha(Buffer.from(chip,'hex'))===m.chipId,'proven physical chip differs from machine');
  need(p.reportData.subarray(0,32).equals(binding),'quote does not bind this fresh machine challenge');
  const finished=now();need(Number.isSafeInteger(finished)&&finished>=started&&finished-started<=MAX_QUOTE_AGE_MS,'quote verification exceeded freshness window');
  return {machine:Object.freeze({...m}),requestedAt:started,verifiedAt:finished,publicEvidence:{
   requestedAt:new Date(started).toISOString(),verifiedAt:new Date(finished).toISOString(),endpoint,identity:m.identity,encKey:m.encKey,
   measurement:R2.measurement,measurementSha256:R2.measurementSha256,manifestSha256:R2.manifestSha256,challengeSha256:sha(nonce),quoteSha256:sha(report),
   vcekVerified:true,minimumTcbChecked:true,vmpl:0,debugAllowed:false,migrationAgentAllowed:false,
   scope:'Fresh AMD-rooted SNP machine evidence; does not itself establish committee membership or decentralized custody.'}};
 }catch(e){if(e?.[LOCAL])throw e;throw Error('custodian attestation refused: evidence transport or verifier failed');}
}
