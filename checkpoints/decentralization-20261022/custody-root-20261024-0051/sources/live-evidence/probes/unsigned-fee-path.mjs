// Public, READ-ONLY diagnostic of the production SDK preparation path. Cannot sign or broadcast.
import fs from 'node:fs';
import {createWalletClient,custom,encodeFunctionData,parseAbi} from 'viem';
import {toAccount} from 'viem/accounts';
import {base} from 'viem/chains';
const address='0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab';
const deny=()=>{throw Error('Signing prohibited in read-only fee probe')};
const account=toAccount({address,signMessage:deny,signTransaction:deny,signTypedData:deny});
const allowed=new Set(['eth_chainId','eth_getBlockByNumber','eth_fillTransaction','eth_estimateGas','eth_getTransactionCount','eth_getCode','eth_maxPriorityFeePerGas','eth_gasPrice','eth_feeHistory','eth_getBalance']);
const calls=[],fills=[];let count=0;
async function request({method,params}){
 if(!allowed.has(method)||++count>30)throw Error('Read-only method or request budget refusal');calls.push(method);
 const r=await fetch('https://mainnet.base.org',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:count,method,params}),redirect:'error',signal:AbortSignal.timeout(12000)});
 const j=await r.json();if(j.error){const e=Error('RPC read refused');e.code=j.error.code;throw e;}
 if(method==='eth_fillTransaction'){const t=j.result?.tx||j.result?.transaction||{};fills.push(Object.fromEntries(['gas','maxFeePerGas','maxPriorityFeePerGas'].filter(k=>k in t).map(k=>[k,String(BigInt(t[k]))])));}
 return j.result;
}
const wallet=createWalletClient({account,chain:base,transport:custom({request},{retryCount:0})});
const abi=parseAbi(['function setProofKey(bytes32,address)']);
const data=encodeFunctionData({abi,functionName:'setProofKey',args:['0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be','0xffffffffffffffffffffffffffffffffffffffff']});
const balance=BigInt(await request({method:'eth_getBalance',params:[address,'latest']}));
let prepared=null,error=null;
try{const t=await wallet.prepareTransactionRequest({to:'0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac',data});prepared={gas:String(t.gas),maxFeePerGas:String(t.maxFeePerGas),maxPriorityFeePerGas:String(t.maxPriorityFeePerGas),l2BoundWei:String(t.gas*t.maxFeePerGas)};}catch(e){error={name:e.name,code:e.code||null};}
const out={at:new Date().toISOString(),readOnly:true,signingDisabled:true,broadcastMethodsDisabled:true,address,balanceWei:String(balance),methods:calls,filled:fills,prepared,error};fs.writeFileSync(new URL('../evidence/unsigned-fee-path.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
