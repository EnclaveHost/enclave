// Read only: exact deployed committee's code-admission delay and corrected r2 measurement status.
import fs from 'node:fs';
import {parseAbi} from 'viem';
import {pinBlock,readMany} from '../lib/live.mjs';
const vault='0xe48699b8401564aace7a814ae4569b67a3f7eef5',committee='0x47742ae8c544ff66a4ad91cfbf5cecdd389013da362813ba3b55c4e247b0f7a3',measurement='0xfbe2f581cd8da409856adcff75a149c3797111cb0c7030b824f015867b9cb8d7';
const abi=parseAbi(['function CODE_DELAY() view returns(uint64)','function codeActiveAt(bytes32,bytes32) view returns(uint64)']);
const block=await pinBlock();const r=await readMany(block,[{address:vault,abi,functionName:'CODE_DELAY'},{address:vault,abi,functionName:'codeActiveAt',args:[committee,measurement]}]);
const out={at:new Date().toISOString(),readOnly:true,block,vault,committee,measurement,delaySeconds:r[0].value,correctedCodeActiveAt:r[1].value,limits:['Existing committee code-admission state only. No code proposal, new committee, machine handover or policy migration was submitted. A new committee does not upgrade or migrate existing policies.']};
fs.writeFileSync(new URL('../evidence/custody-code-delay.json',import.meta.url),JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');console.log(JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v));
