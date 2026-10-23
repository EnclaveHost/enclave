// Read-only incident estimate. No keys/signing/submission.
import fs from 'node:fs';
import {createPublicClient,http,parseAbi,encodeFunctionData,keccak256,toHex} from 'viem';
const urls=['https://mainnet.base.org','https://base-rpc.publicnode.com'];
const operator='0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB',registry='0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC',endpoint='https://api.enclave.host/t/metal0';
const abi=parseAbi(['function get(bytes32) view returns ((string endpoint,string repo,bytes32 measurement,address operator,uint64 registeredAt,uint64 lastSeen,bool active,uint64 cpuPricePerSec6,uint64 gpuPricePerSec6,address proofKey,address payoutWallet))','function setProofKey(bytes32,address)']);
const clients=urls.map(url=>createPublicClient({transport:http(url,{timeout:12000,retryCount:0})}));
const rows=[];
for(const c of clients){
 if(await c.getChainId()!==8453)throw Error('chain');
 const block=await c.getBlock(),row=await c.readContract({address:registry,abi,functionName:'get',args:[keccak256(toHex(endpoint))],blockNumber:block.number});
 if(row.operator.toLowerCase()!==operator.toLowerCase())throw Error('operator');
 const data=encodeFunctionData({abi,functionName:'setProofKey',args:[keccak256(toHex(endpoint)),'0x8853f452533E2f05EB4c9289f77dBEAcc316D1Ed']});
 const gas=await c.estimateGas({account:operator,to:registry,data,gasPrice:0n});
 const balance=await c.getBalance({address:operator});
 rows.push({endpoint:c.transport.url,block:block.number,baseFee:block.baseFeePerGas,gas,balance,baseFeeOnlyCost:gas*block.baseFeePerGas,fields:{repo:row.repo,measurement:row.measurement,cpuPrice:row.cpuPricePerSec6,gpuPrice:row.gpuPricePerSec6},limits:['Existing row fields, new boot proof key; estimate only, not a send authorization. GasPrice0 is eth_estimateGas simulation only. Excludes L1/operator fees and gas margin.']});
}
const out={at:new Date().toISOString(),readOnly:true,rows};
const txt=JSON.stringify(out,(_,v)=>typeof v==='bigint'?String(v):v,2);
fs.writeFileSync(new URL('../evidence/proofkey-affordability.json',import.meta.url),txt+'\n');console.log(txt);
