import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const repo=new URL('../nucbox-tls-recovery-20261023/candidate/',import.meta.url);
const {fakeBaseRpc}=await import(new URL('test/helpers/fake-base-rpc.mjs',repo));
const rpc=await fakeBaseRpc();
const dirs=[];
try {
 const {Host}=await import(new URL('windows/node/host.mjs',repo));
 const {appMemoryForShare}=await import(new URL('windows/vbslike/manager/memory-share.mjs',repo));
 const result=[];
 for(const poolGiB of [64,96]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-ram-accounting-'));dirs.push(dir);
  const h=new Host({dir,endpoint:'https://memory-fixture.invalid/',name:'offline-memory-review',appsEnabled:true,engineRetired:true,ramGb:112,appRamGb:poolGiB,appSlots:16,cpuPricePerSec6:12,log:()=>{}});
  const id='0x'+'11'.repeat(32),cpuShare=0.25,minimumMiB=512;
  h.records.set(id,{id,status:'running',cpuShare,gpuShare:0,memMb:minimumMiB,isolationRequired:true});
  const reservation=appMemoryForShare(poolGiB*1024,cpuShare,minimumMiB),cap=h.capacity();
  const managerPoolFreeMiB=poolGiB*1024-reservation.appMiB;
  assert.equal(cap.ramMbFree,poolGiB*1024-minimumMiB);
  assert.ok(cap.ramMbFree>managerPoolFreeMiB);
  result.push({poolGiB,appMinimumMiB:minimumMiB,cpuShare,managerReservedAppMiB:reservation.appMiB,nodeAdvertisedFreeMiB:cap.ramMbFree,managerPoolFreeMiB,overstatementMiB:cap.ramMbFree-managerPoolFreeMiB});
 }
 const out={at:new Date().toISOString(),scope:'Actual Host.capacity and Hyper-V appMemoryForShare code with one synthetic running app. No VM, production, chain or physical-memory measurement performed. Backend floor accounting differs from manager reservation; not proof this caused any particular outage.',result};
 fs.writeFileSync(new URL('./RESULT.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
} finally {rpc.close();for(const d of dirs)fs.rmSync(d,{recursive:true,force:true});}
