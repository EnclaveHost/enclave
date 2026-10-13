// Enclave-network provider records (a provider's signed opt-in) and qualification results (a checker's signed
// verdict), as providers publish them, the relay stores them and hosts verify them (docs/design/enclave-network.md).
// The relay is only storage: hosts check every signature and binding themselves.
import {createHash} from 'node:crypto';
import {recoverMessageAddress} from 'viem';
import {canonical} from './route-record.mjs';

export const ROLES=['guard','ingress','egress'];
export const CHECKS=['tcp80','tcp443','udpEcho','outboundHttps','payloadIntegrity','blocksPrivateDestinations','blocksOwnAddresses','blocksSmtp','rejectsUnauthorizedProxy'];
export const QUALIFICATION_MAX_MS=10*60000,RECORD_MAX_MS=60*60000;
const ipv4=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,wgKey=/^[A-Za-z0-9+/]{43}=$/,address=/^0x[0-9a-f]{40}$/,app=/^0x[0-9a-f]{64}$/;
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...k].sort().join(',');
const port=p=>Number.isSafeInteger(p)&&p>0&&p<65536;

export function providerIdFor(operator,address){return createHash('sha256').update(`${String(operator).toLowerCase()}|${address}`).digest('hex').slice(0,32);}
export function publicIPv4(a){const m=ipv4.exec(a||'');if(!m)return false;const [x,y]=m.slice(1).map(Number);if(m.slice(1).some(v=>+v>255))return false;
 return !(x===0||x===10||x===127||x>=224||(x===100&&y>=64&&y<=127)||(x===169&&y===254)||(x===172&&y>=16&&y<=31)||(x===192&&y===168)||(x===192&&y===0)||(x===198&&(y===18||y===19)));}

export function validateProviderRecord(r,now=Date.now()){
 if(!exact(r,['version','providerId','operator','address','wgExitKey','wgGuardKey','ports','roles','pricePerGiB6','region','kind','hostId','issuedAt','expiresAt'])||r.version!==1||
    !address.test(r.operator)||!publicIPv4(r.address)||r.providerId!==providerIdFor(r.operator,r.address)||!wgKey.test(r.wgExitKey)||!wgKey.test(r.wgGuardKey)||r.wgExitKey===r.wgGuardKey||
    !exact(r.ports,['exit','guard','control'])||!port(r.ports.exit)||!port(r.ports.guard)||!port(r.ports.control)||new Set(Object.values(r.ports)).size!==3||
    !Array.isArray(r.roles)||r.roles.some(x=>!ROLES.includes(x))||new Set(r.roles).size!==r.roles.length||
    !Number.isSafeInteger(r.pricePerGiB6)||r.pricePerGiB6<0||r.pricePerGiB6>1e12||typeof r.region!=='string'||!/^[a-z0-9-]{1,32}$/.test(r.region)||
    !['enclave','community'].includes(r.kind)||!(r.hostId===null||app.test(r.hostId))||(r.kind==='community')!==(r.hostId!==null)||
    !Number.isSafeInteger(r.issuedAt)||!Number.isSafeInteger(r.expiresAt)||r.issuedAt>now+60000||r.expiresAt-r.issuedAt>RECORD_MAX_MS)throw new Error('invalid provider record');
 return r;
}
export const providerRecordMessage=r=>`enclave-network:provider:v1\n${canonical(r)}`;
export async function signProviderRecord(account,r){validateProviderRecord(r);return {record:r,signature:await account.signMessage({message:providerRecordMessage(r)})};}
// -> the record when its operator signed it and it is current; a community record must also name the operator of its
// registry host (checked by the caller with hostOperator(hostId) -> address|null).
export async function verifyProviderRecord(env,{now=Date.now(),hostOperator}={}){
 const r=validateProviderRecord(env?.record,now);
 if(r.expiresAt<=now)throw new Error('provider record expired');
 const signer=(await recoverMessageAddress({message:providerRecordMessage(r),signature:env.signature})).toLowerCase();
 if(signer!==r.operator)throw new Error('provider record is not signed by its operator');
 if(r.hostId){if(!hostOperator)throw new Error('community provider needs a registry check');const op=await hostOperator(r.hostId);if(!op||op.toLowerCase()!==r.operator)throw new Error('community provider is not its registry host\'s operator');}
 return r;
}

export function validateQualification(q){
 if(!exact(q,['version','providerId','operator','address','wgExitKey','wgGuardKey','roles','checks','issuedAt','expiresAt'])||q.version!==1||
    !/^[0-9a-f]{32}$/.test(q.providerId)||!address.test(q.operator)||!publicIPv4(q.address)||!wgKey.test(q.wgExitKey)||!wgKey.test(q.wgGuardKey)||
    !Array.isArray(q.roles)||q.roles.some(x=>!ROLES.includes(x))||!exact(q.checks,CHECKS)||!CHECKS.every(c=>typeof q.checks[c]==='boolean')||
    !Number.isSafeInteger(q.issuedAt)||!Number.isSafeInteger(q.expiresAt)||q.expiresAt<=q.issuedAt||q.expiresAt-q.issuedAt>QUALIFICATION_MAX_MS)throw new Error('invalid qualification');
 return q;
}
export const qualificationMessage=q=>`enclave-network-qualification:v1\n${canonical(q)}`;
export async function signQualification(account,q){
 validateQualification(q);if(account.address.toLowerCase()===q.operator)throw new Error('a provider cannot qualify itself');
 return {qualification:q,signature:await account.signMessage({message:qualificationMessage(q)})};
}
// A provider is eligible for the roles a trusted checker (never its operator) passed on EVERY check, for exactly the
// address and keys in its current record, until the qualification expires. Anything missing or different: not eligible.
export async function verifyQualification(env,record,{checkers,now=Date.now()}){
 const q=validateQualification(env?.qualification);
 const signer=(await recoverMessageAddress({message:qualificationMessage(q),signature:env.signature})).toLowerCase();
 if(!checkers.map(c=>c.toLowerCase()).includes(signer))throw new Error('qualification is not from a trusted checker');
 if(signer===q.operator)throw new Error('a provider cannot qualify itself');
 if(q.providerId!==record.providerId||q.operator!==record.operator||q.address!==record.address||q.wgExitKey!==record.wgExitKey||q.wgGuardKey!==record.wgGuardKey)throw new Error('qualification does not match the provider record');
 if(q.expiresAt<=now||q.issuedAt>now+60000)throw new Error('qualification expired');
 if(!CHECKS.every(c=>q.checks[c]===true))throw new Error('provider failed a mandatory check');
 return {roles:q.roles.filter(r=>record.roles.includes(r)),until:q.expiresAt,checker:signer};
}

// Several trusted checkers each sign their own verdict. A provider is eligible for a role when at least one current
// verdict passes everything, and NO current verdict that reached it (udpEcho: the tunnel came up) failed a SECURITY
// check - letting private, own-address or SMTP traffic through, or proxying for an unauthorized client - which revokes it
// at once. A reachability or throughput failure seen by one checker (a port or an HTTPS fetch timing out, a 4 MiB
// payload not arriving in time) only means that verdict is not a pass: one checker's congested uplink must not tear
// down every circuit through a provider the other checker just passed (2026-10-13: 4 MiB timeouts from a home uplink
// revoked providers for a round at a time and cut live downloads). A checker that could not reach it at all proves nothing.
export const SECURITY_CHECKS=['blocksPrivateDestinations','blocksOwnAddresses','blocksSmtp','rejectsUnauthorizedProxy'];
const SECURITY=SECURITY_CHECKS;
export async function verifyQualifications(envs,record,{checkers,now=Date.now()}){
 const seen=new Map();
 for(const env of envs||[]){
  let q,signer;try{q=validateQualification(env?.qualification);signer=(await recoverMessageAddress({message:qualificationMessage(q),signature:env.signature})).toLowerCase();}catch{continue;}
  if(!checkers.map(c=>c.toLowerCase()).includes(signer)||signer===q.operator)continue;
  if(q.providerId!==record.providerId||q.operator!==record.operator||q.address!==record.address||q.wgExitKey!==record.wgExitKey||q.wgGuardKey!==record.wgGuardKey)continue;
  if(q.expiresAt<=now||q.issuedAt>now+60000)continue;
  const prev=seen.get(signer);if(!prev||q.issuedAt>prev.issuedAt)seen.set(signer,q);
 }
 const current=[...seen.values()];
 if(current.some(q=>q.checks.udpEcho===true&&SECURITY.some(c=>q.checks[c]!==true)))throw new Error('a trusted checker reached the provider and it failed a mandatory check');
 const pass=current.filter(q=>CHECKS.every(c=>q.checks[c]===true));
 if(!pass.length)throw new Error(current.length?'no current passing verdict (checkers could not reach it)':'not qualified');
 const best=pass.sort((a,b)=>b.expiresAt-a.expiresAt)[0];
 return {roles:best.roles.filter(r=>record.roles.includes(r)),until:best.expiresAt,passing:pass.length};
}

// Eligible providers from directory entries [{record:{record,signature}, qualifications:[...], qualification}].
export async function eligibleProviders(entries,{checkers,now=Date.now(),hostOperator,log=()=>{}}){
 const out=[];
 for(const e of entries||[]){
  try{const r=await verifyProviderRecord(e.record,{now,hostOperator});
   const list=Array.isArray(e.qualifications)?e.qualifications:e.qualification?[e.qualification]:[];
   const q=await verifyQualifications(list,r,{checkers,now});if(q.roles.length)out.push({...r,eligibleRoles:q.roles,qualifiedUntil:q.until});}
  catch(err){log(`provider ${String(e?.record?.record?.providerId||'?').slice(0,8)}: ${err.message}`);}
 }
 return out;
}
