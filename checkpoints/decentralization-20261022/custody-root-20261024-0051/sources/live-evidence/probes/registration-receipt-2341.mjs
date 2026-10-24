import fs from 'node:fs';
import {createPublicClient,http,decodeFunctionData,parseAbi} from 'viem';
const hash='0x12d7a5a4fc67bc49b8035ad8ec41fd808b4e24008df0d05efee2da7f1c7ab880';
const operator='0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab',registry='0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac';
const abi=parseAbi(['function setProofKey(bytes32,address)']);
const rows=[];
for(const url of ['https://mainnet.base.org','https://base-rpc.publicnode.com']){
 const c=createPublicClient({transport:http(url,{timeout:12000,retryCount:0})});
 const [t,r,b,n]=await Promise.all([c.getTransaction({hash}),c.getTransactionReceipt({hash}),c.getBalance({address:operator}),c.getTransactionCount({address:operator})]);
 const d=decodeFunctionData({abi,data:t.input});
 if(t.from.toLowerCase()!==operator||t.to.toLowerCase()!==registry||t.value!==0n||r.status!=='success'||d.functionName!=='setProofKey'||d.args[0]!=='0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be'||d.args[1].toLowerCase()!=='0x0e44e766c1d300e062bce274d12396d797abc8b3')throw Error('Unexpected transaction/receipt');
 rows.push({url,hash,blockHash:r.blockHash,blockNumber:r.blockNumber,status:r.status,from:t.from,to:t.to,nonce:t.nonce,gas:t.gas,gasUsed:r.gasUsed,maxFeePerGas:t.maxFeePerGas,maxPriorityFeePerGas:t.maxPriorityFeePerGas,effectiveGasPrice:r.effectiveGasPrice,functionName:d.functionName,host:d.args[0],registryProofAddress:d.args[1],currentBalanceWei:b,currentNonce:n});
}
if(rows[0].blockHash!==rows[1].blockHash||rows[0].gasUsed!==rows[1].gasUsed)throw Error('Receipt disagreement');
const s=JSON.stringify({at:new Date().toISOString(),readOnly:true,receiptVerified:true,rows},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';fs.writeFileSync(new URL('../evidence/registration-receipt-2341.json',import.meta.url),s);console.log(s);
