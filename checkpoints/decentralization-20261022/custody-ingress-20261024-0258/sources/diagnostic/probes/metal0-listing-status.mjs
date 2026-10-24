// Read only public incident diagnosis; no signing or keys.
import fs from 'node:fs';
import {createPublicClient,http,parseAbi,keccak256,toHex} from 'viem';
const endpoint='https://api.enclave.host/t/metal0',address='0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC',operator='0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB';
const abi=parseAbi(['function get(bytes32) view returns ((string endpoint,string repo,bytes32 measurement,address operator,uint64 registeredAt,uint64 lastSeen,bool active,uint64 cpuPricePerSec6,uint64 gpuPricePerSec6,address proofKey,address payoutWallet))']);
const r=await fetch(endpoint+'/v1/attestation',{signal:AbortSignal.timeout(12000),redirect:'error'});if(!r.ok)throw Error('attestation HTTP '+r.status);const currentProof=(await r.json()).proofKey.address;
const rows=await Promise.all(['https://mainnet.base.org','https://base-rpc.publicnode.com'].map(async url=>{
 const c=createPublicClient({transport:http(url,{timeout:12000,retryCount:0})});if(await c.getChainId()!==8453)throw Error('chain');
 const block=await c.getBlock();const [host,balance,code,nonce]=await Promise.all([c.readContract({address,abi,functionName:'get',args:[keccak256(toHex(endpoint))],blockNumber:block.number}),c.getBalance({address:operator,blockNumber:block.number}),c.getCode({address:operator,blockNumber:block.number}),c.getTransactionCount({address:operator,blockNumber:block.number})]);
 return {provider:url,block:block.number,active:host.active,lastSeen:host.lastSeen,proofKey:host.proofKey,currentProofMatches:host.proofKey.toLowerCase()===currentProof.toLowerCase(),balanceWei:balance,operatorCode:code,nonce};
}));
const out={at:new Date().toISOString(),readOnly:true,endpoint,currentProof,rows};const txt=JSON.stringify(out,(_,v)=>typeof v==='bigint'?String(v):v,2);fs.writeFileSync('outputs/decentralization-audit/metal0-listing-status-20261024.json',txt+'\n');console.log(txt);
