// Read-only preparation for a human wallet top-up. No credentials, signer or transaction sender.
import fs from 'node:fs';
import {pinBlock,agree} from '../lib/live.mjs';
const address='0x29479bf04ed889d46a7afb7f292b9bb26e12647c';
const block=await pinBlock(); const tag='0x'+block.number.toString(16);
const code=await agree('eth_getCode',[address,tag]);
if(code!=='0x')throw Error('Canary submitter is not an ordinary EOA; do not prepare a plain transfer');
const balance=BigInt(await agree('eth_getBalance',[address,tag]));
const out={at:new Date().toISOString(),readOnly:true,chainId:8453,address,code,balanceWei:String(balance),proposedTopupWei:'100000000000000',purpose:'Dedicated custody canary test transactions and new-committee submission; no production user secrets',signed:false,submitted:false};
fs.writeFileSync(new URL('../evidence/canary-topup-preflight.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
