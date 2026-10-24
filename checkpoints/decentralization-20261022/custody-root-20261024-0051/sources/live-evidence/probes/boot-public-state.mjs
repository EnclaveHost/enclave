import fs from 'node:fs';
const base='https://api.enclave.host/t/metal0';
async function get(p){const r=await fetch(base+p,{signal:AbortSignal.timeout(12000),redirect:'error'});if(!r.ok)throw Error(p+' '+r.status);return r.json();}
const [a,v]=await Promise.all([get('/v1/attestation'),get('/availability')]);
const out={at:new Date().toISOString(),readOnly:true,proofAddress:a.proofKey?.address,keySource:a.proofKey?.keySource,availabilityFields:Object.keys(v),cpuPrice:v.askCpuPricePerSec6,gpuPrice:v.askGpuPricePerSec6,limits:['Relay-routed observation only, not hardware binding.']};
fs.writeFileSync(new URL('../evidence/boot-public-state.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
