// Read-only: derive only the configured custodian submitter's public address; never sign or emit secret material.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {privateKeyToAccount} from 'viem/accounts';
import {parseAbi} from 'viem';
import {pinBlock,agree,readMany} from '../lib/live.mjs';
const pid=execFileSync('systemctl',['--user','show','enclave-custodian-v2.service','-p','MainPID','--value'],{encoding:'utf8',timeout:10000}).trim();assert.ok(/^\d+$/.test(pid)&&Number(pid)>1);
const env=fs.readFileSync(`/proc/${pid}/environ`).toString().split('\0');
const value=env.find(v=>v.startsWith('CUSTODY_SUBMITTER_KEY='));
assert.ok(value,'Expected submitter environment unavailable');
const account=privateKeyToAccount(value.slice(value.indexOf('=')+1));
const addresses=[...new Set([account.address.toLowerCase(),'0x29479bf04ed889d46a7afb7f292b9bb26e12647c','0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab'])];
const block=await pinBlock();const tag='0x'+block.number.toString(16);
const tokens=await readMany(block,addresses.map(a=>({address:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',abi:parseAbi(['function balanceOf(address) view returns(uint256)']),functionName:'balanceOf',args:[a]})));
const views=[];for(let i=0;i<addresses.length;i++)views.push({address:addresses[i],ethWei:BigInt(await agree('eth_getBalance',[addresses[i],tag])).toString(),usdcBaseUnits:tokens[i].value.toString()});
const out={at:new Date().toISOString(),readOnly:true,configuredCustodySubmitter:account.address.toLowerCase(),block,balances:views,limits:['Only public addresses and balances emitted. No signing, transfer or transaction submitted. Existing canary owner address does not establish current key availability.']};
const text=JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';fs.writeFileSync(new URL('../evidence/canary-funding-inventory.json',import.meta.url),text);console.log(text);
