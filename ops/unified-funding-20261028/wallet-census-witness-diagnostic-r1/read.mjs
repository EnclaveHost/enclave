import fs from 'node:fs';
import {createPublicClient,http,keccak256} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-kvm-guest/node_modules/viem/_esm/index.js';
import {BIRTH_HINTS,CENSUS_PINS} from '../wallet-release-prod-root-repaired-r3/candidate/enclave/site/js/core/wallet-release-census.js';
import {PINS} from '../wallet-release-prod-root-repaired-r3/candidate/enclave/site/js/core/wallet-release-chain.js';
const urls=['https://api.enclave.host/rpc/base','https://base-mainnet.public.blastapi.io','https://rpc.baseazul.dev'];
const out={at:new Date().toISOString(),readOnly:true,limit:'No history scan, no retries, no signing; two exact known creation witnesses and factory boundary only.',providers:[]};
const brief=e=>String(e.shortMessage||e.message).replace(/https?:\/\/[^\s)]+/g,'[RPC]').slice(0,220);
for(const url of urls){
 const c=createPublicClient({transport:http(url,{timeout:8000,retryCount:0})});const p={url,witnesses:[],boundary:[]};out.providers.push(p);
 try {p.chain=await c.getChainId();if(p.chain!==8453)throw Error('wrong chain');}catch(e){p.error=brief(e);continue;}
 for(const [name,h] of Object.entries({ledger:BIRTH_HINTS.ledger,vault:BIRTH_HINTS.vaults['0xb794c4dd0e1c5e6b72281799f282bfde7654345d']})){
  const a={name};p.witnesses.push(a);
  for(const kind of ['tx','receipt','block'])try{
   if(kind==='tx'){const t=await c.getTransaction({hash:h.txHash});a.tx={hash:t.hash,blockHash:t.blockHash,blockNumber:t.blockNumber,to:t.to};}
   if(kind==='receipt'){const r=await c.getTransactionReceipt({hash:h.txHash});a.receipt={transactionHash:r.transactionHash,blockHash:r.blockHash,blockNumber:r.blockNumber,status:r.status,contractAddress:r.contractAddress};}
   if(kind==='block'){const b=await c.getBlock({blockNumber:h.block});a.block={hash:b.hash,number:b.number,membership:b.transactions.includes(h.txHash)};}
  }catch(e){a[kind]={error:brief(e)};}
  a.expected=h;
 }
 for(const at of [CENSUS_PINS.factoryCreationBlock-1n,CENSUS_PINS.factoryCreationBlock])try{const code=await c.getCode({address:PINS.factory,blockNumber:at});p.boundary.push({at,hash:keccak256(code||'0x'),bytes:((code||'0x').length-2)/2});}catch(e){p.boundary.push({at,error:brief(e)});}
 try{const b=await c.getBlock({blockTag:'finalized'});p.finalized={number:b.number,hash:b.hash};}catch(e){p.finalized={error:brief(e)};}
}
const json=JSON.stringify(out,(_,v)=>typeof v==='bigint'?String(v):v,2);fs.writeFileSync(new URL('./result.json',import.meta.url),json+'\n');console.log(json);
