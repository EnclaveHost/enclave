import fs from 'node:fs';import {parseAbi,stringToHex} from 'viem';import {pinBlock,readMany} from '../lib/live.mjs';
const block=await pinBlock(),book='0xab214342d5a490150a4a977063a2f88e21f80907',vault='0xe48699b8401564aace7a814ae4569b67a3f7eef5';
const keys=['sessionVaultFactory','sessionFactory','hostRegistry','deploymentLedger','secretVaultV2'];
const rows=await readMany(block,keys.map(k=>({address:book,abi:parseAbi(['function addr(bytes32) view returns(address)']),functionName:'addr',args:[stringToHex(k,{size:32})]})));
const ids=['0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e'];
const owners=await readMany(block,ids.map(id=>({address:vault,abi:parseAbi(['function beneficialOwnerOf(bytes32) view returns(address)']),functionName:'beneficialOwnerOf',args:[id]})));
const out={at:new Date().toISOString(),readOnly:true,block,book,keys:Object.fromEntries(keys.map((k,i)=>[k,rows[i].value])),knownPolicyOwners:ids.map((id,i)=>({id,owner:owners[i].value})),limits:['Known-ID metadata only. No configuration or contract changed.']};const text=JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';fs.writeFileSync(new URL('../evidence/session-factory-state.json',import.meta.url),text);console.log(text);
