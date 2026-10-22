import fs from 'node:fs';
import {LeaseReader} from './enclave/network/lease-reader.mjs';
import {createHostAdmission} from './enclave/network/host-admission-runtime.mjs';
import {LEDGER_ABI} from './ledger17-migration/lib/abis.mjs';
const p=JSON.parse(fs.readFileSync('work/enclave/contracts/deployments/network-profile-base.json'));
const reader=new LeaseReader({addressBook:"0xab214342d5A490150A4A977063A2f88E21F80907",rpc:['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.public.blockpi.network/v1/rpc/public']});
const gate=createHostAdmission({hostId:'0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a',ownershipContract:'0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7',registry:p.contracts.registry.address.toLowerCase(),catalog:p.contracts.appCatalog.address.toLowerCase(),reader,policyDirectory:'outputs/windows-host-enrollment'});
const vms=JSON.parse(fs.readFileSync('outputs/admin-control-audit/windows-before.json')).vms;
const results=[];
for(const vm of vms.filter(v=>/^0x[0-9a-f]{64}$/.test(v.name))){
 const d=await reader.agreed(async(client,blockNumber)=>{
  const x=await client.readContract({address:p.contracts.deployments.address,abi:LEDGER_ABI,functionName:'get',args:[vm.name],blockNumber});
  return {id:vm.name,appRef:x.appRef,isPublic:x.isPublic,active:x.active};
 });
 const reason=await gate.refusal({deploymentId:d.id,appRef:d.appRef,forPrivate:d.isPublic===false});
 results.push({id:d.id,isPublic:d.isPublic,active:d.active,refusal:reason});
 console.log(JSON.stringify(results.at(-1)));
}
fs.writeFileSync('outputs/admin-control-audit/runtime-preflight.json',JSON.stringify({at:new Date().toISOString(),results},null,2)+'\n');
if(results.length<8||results.some(x=>x.refusal))throw Error('production admission preflight requires review');
