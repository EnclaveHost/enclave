import fs from 'node:fs';
import {chainClient} from '../wallet-release-reader-repair-r4/shipped-sessions.mjs';
import {viemReader} from '../wallet-release-reader-repair-r4/candidate/enclave/site/js/core/wallet-release-chain.js';
import {BIRTH_HINTS} from '../wallet-release-reader-repair-r4/candidate/enclave/site/js/core/wallet-release-census.js';
import {keccak256Hex} from '../wallet-release-reader-repair-r4/candidate/enclave/site/js/core/keccak.js';
const results=[];
for(const url of ['https://api.enclave.host/rpc/base','https://rpc.baseazul.dev']){
 const pc=chainClient(8453,url),r=viemReader(pc),o={url};results.push(o);
 try{const t=await r.tx(BIRTH_HINTS.ledger.txHash);if(!t||t.hash!==BIRTH_HINTS.ledger.txHash||t.blockHash!==BIRTH_HINTS.ledger.blockHash||BigInt(t.blockNumber)!==BIRTH_HINTS.ledger.block)throw Error('witness mismatch');o.tx={hash:t.hash,blockHash:t.blockHash,blockNumber:String(t.blockNumber),inputHash:keccak256Hex(t.input),inputBytes:(t.input.length-2)/2};o.ok=true;}catch(e){o.error=String(e.shortMessage||e.message).slice(0,300);process.exitCode=1;}
}
const out={at:new Date().toISOString(),readOnly:true,actualShippedSdk:true,results};fs.writeFileSync(new URL('./result.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
