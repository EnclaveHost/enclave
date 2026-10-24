// Public protocol check only: creates one expiring challenge, no deployment or release request; never emits its nonce.
import fs from 'node:fs';import {createHash} from 'node:crypto';import {parseAbi} from 'viem';
import {pinBlock,readMany} from '../lib/live.mjs';
import {challenge} from '../../custody-v2-r2-production-canary-20261024/driver/probe.mjs';
const vault='0xE48699B8401564aaCe7A814AE4569b67a3F7eEF5',cid='0x47742ae8c544ff66a4ad91cfbf5cecdd389013da362813ba3b55c4e247b0f7a3',base='https://api.enclave.host/t/custody-metal0';
const abi=parseAbi(['function committeeOf(bytes32) view returns(bytes Y,uint32 epoch,uint8 t,uint8 W,uint64 activatedAt)','function machinesOf(bytes32,uint32) view returns((address identity,bytes32 encKey,string endpoint,bytes32 chipId,bytes32 registryId,bytes32 measurement)[] machines,bool[] enclave)']);
const block=await pinBlock();const c=(await readMany(block,[{address:vault,abi,functionName:'committeeOf',args:[cid]}]))[0].value;
if(Number(c[1])!==1)throw Error('old committee epoch changed');const m=(await readMany(block,[{address:vault,abi,functionName:'machinesOf',args:[cid,1]}]))[0].value[0];if(m.length!==1)throw Error('old committee size differs');
const r=await challenge(fetch,base),now=Math.floor(Date.now()/1000);if(r.encKey.toLowerCase()!==m[0].encKey.toLowerCase()||r.expiresAt<=now||r.expiresAt>now+125)throw Error('challenge key or freshness differs');
const out={at:new Date().toISOString(),endpoint:base,block:String(block.number),committee:cid,epoch:1,encKey:r.encKey,challengeSha256:createHash('sha256').update(r.nonce).digest('hex'),expiresAt:r.expiresAt,scope:'Live challenge shape and public committee-key match only. One challenge expires unused; no deployment named, no secret release requested, no AMD hardware or lifecycle claim.'};fs.writeFileSync('outputs/decentralization-audit/custody-legacy-challenge-20261024.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
