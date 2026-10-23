// Existing production guest: fresh public attestation only. No secret, signer, guest restart, or chain mutation.
import fs from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {verifyCustodianQuote} from '../../custody-release/canary/verify-custodian-quote.mjs';
const state=JSON.parse(fs.readFileSync(new URL('../evidence/known-state.json',import.meta.url)));
const manifest=JSON.parse(fs.readFileSync('/home/steven/enclave-prod/custodian-v2-9d43e63e8/manifest.json'));
const machine=state.committees[0].machines[0];
if(manifest.measurementSha256.toLowerCase()!==machine.measurement.toLowerCase())throw Error('Manifest does not match chain machine measurement');
const nonce=randomBytes(32).toString('hex');
const res=await fetch('https://api.enclave.host/t/custody-metal0/v2/custody/evidence',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nonce}),signal:AbortSignal.timeout(20000),redirect:'error'});
if(!res.ok)throw Error(`Evidence HTTP ${res.status}`);
const raw=await res.text();if(Buffer.byteLength(raw)>1048576)throw Error('Evidence too large');
const evidence=JSON.parse(raw);
for(const key of ['identity','encKey','endpoint','chipId','registryId','measurement']){const a=String(evidence.machine?.[key]),b=String(machine[key]);if((key==='endpoint'?a:a.toLowerCase())!==(key==='endpoint'?b:b.toLowerCase()))throw Error(`Evidence machine differs from chain: ${key}`);}
const verdict=await verifyCustodianQuote({manifest,evidence,nonce});
const out={at:new Date().toISOString(),scope:'Fresh attestation of existing production custodian only; not a secret release or rollout test',chainBlock:state.block,nonce,evidenceSha256:createHash('sha256').update(raw).digest('hex'),machineMatchesPinnedChain:true,verdict};
fs.writeFileSync(new URL('../evidence/fresh-quote.json',import.meta.url),JSON.stringify(out,null,2)+'\n');
fs.writeFileSync(new URL('../evidence/fresh-quote-raw.json',import.meta.url),raw,{mode:0o600});
console.log(JSON.stringify({at:out.at,ok:verdict.ok,reasons:verdict.reasons,measurement:verdict.observed?.measurement,chipIdSha256:verdict.observed?.chipIdSha256,machineMatchesPinnedChain:true}));
process.exitCode=verdict.ok?0:1;
