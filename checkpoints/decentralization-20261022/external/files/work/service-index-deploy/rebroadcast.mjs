import fs from 'node:fs';
import {createPublicClient,http,keccak256} from '../enclave/node_modules/viem/_esm/index.js';
const j=JSON.parse(fs.readFileSync('work/service-index-deploy/journal.json')),op=j.operations.deploy;
if(keccak256(op.serialized)!==op.hash)throw Error('signed bytes changed');
const c=createPublicClient({transport:http('https://base.public.blockpi.network/v1/rpc/public',{timeout:15000,retryCount:0})});
if(await c.getChainId()!==8453)throw Error('wrong chain');
if(await c.getTransactionCount({address:j.deployer,blockTag:'pending'})!==op.nonce)throw Error('nonce changed; inspect outcome');
try {const hash=await c.sendRawTransaction({serializedTransaction:op.serialized});console.log(JSON.stringify({sameSignedTransaction:true,hash}));}catch(e){const r={name:e.name,shortMessage:e.shortMessage,details:e.details,cause:e.cause?.details||e.cause?.shortMessage};fs.writeFileSync('work/service-index-deploy/broadcast-error.json',JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify(r,null,2));process.exitCode=1;}
