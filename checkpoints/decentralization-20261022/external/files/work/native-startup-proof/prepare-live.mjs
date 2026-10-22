import fs from 'node:fs/promises';
import {LeaseReader} from '../enclave/network/lease-reader.mjs';
import {prepareNativeProfile} from '../enclave/scripts/network/native-profile.mjs';
const profile=JSON.parse(await fs.readFile(new URL('./base-profile.json',import.meta.url)));
const reader=new LeaseReader({rpc:profile.rpc,addressBook:'0x'+'0'.repeat(40),authorityPins:profile.authorityPins});
const events=[],original=reader.refresh.bind(reader);reader.refresh=async ids=>{
 try{const result=await original(ids);events.push({at:new Date().toISOString(),block:result[0]?.blockNumber,phase:'chain-read'});return result;}
 catch(e){events.push({at:new Date().toISOString(),error:e.message,details:reader.failures});throw e;}
};
try{
 const result=await prepareNativeProfile(profile,{reader,releaseDir:new URL('../direct-bootstrap-hardware-release-v3',import.meta.url).pathname,releaseId:'5ef70f6a950b1deadcf21119a0e02ba2f75dea029d870ef25a0e6d7940ac9aad',bundleFile:new URL('../bootstrap-hardware/guests/store/bundles/167f4fae8da1a13916df314f64534ed698b1807f12042e84b52b36b678ebb773.bundle',import.meta.url).pathname,vcpus:1});
 await fs.writeFile(new URL('./client-profile.json',import.meta.url),JSON.stringify(result.profile,null,2)+'\n',{flag:'wx',mode:0o600});
 await fs.writeFile(new URL('./profile-result.json',import.meta.url),JSON.stringify({...result.evidence,verifiedAt:new Date().toISOString()},null,2)+'\n');
 console.log(JSON.stringify(result.evidence));
}catch(e){console.error(e.message);process.exitCode=1;}
finally{await fs.writeFile(new URL('./profile-events.json',import.meta.url),JSON.stringify(events,null,2)+'\n');}
