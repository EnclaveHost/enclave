import {createVerifiedSnapshot} from './verified-chain.mjs';
import fs from 'node:fs';
const hash='0x'+'11'.repeat(32),stateRoot='0x'+'22'.repeat(32);
let n=100n,headers=0,delay=true;
const verifier={request:async m=>{
 if(m==='eth_chainId')return '0x2105';if(m==='eth_blockNumber')return '0x'+n.toString(16);
 if(m==='eth_getBlockByNumber'){
  const number=n;headers++;
  if(delay&&headers===2)await new Promise(r=>setTimeout(r,180));
  return {number:'0x'+number.toString(16),hash,stateRoot,timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)};
 }throw Error('unexpected');
}};
const snapshot=createVerifiedSnapshot({verifier,chainId:8453,confirmations:0,deadlineMs:100});
let first,second;
try{await snapshot(async()=>true);first='success';}catch(e){first=e.code;}
await new Promise(r=>setTimeout(r,200));n=99n;delay=false;
try{await snapshot(async()=>true);second='success';}catch(e){second=e.code;}
const out={at:new Date().toISOString(),first,second,scope:'Immutable2efc4a83 actual createVerifiedSnapshot; scripted in-process endpoint delays final header past timeout. No real Helios/network.'};
fs.writeFileSync(new URL('RESULT.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
