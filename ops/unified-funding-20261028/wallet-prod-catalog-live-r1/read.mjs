import fs from 'node:fs';
import * as sdk from '../wallet-release-prod-root-repaired-r3/shipped-sessions.mjs';
import {viemReader,readSnapshot,readCatalog} from '../wallet-release-prod-root-repaired-r3/candidate/enclave/site/js/core/wallet-release-chain.js';
const urls=['https://api.enclave.host/rpc/base','https://rpc.baseazul.dev'];
const out={readOnly:true,purpose:'Diagnose absent production promotion offer; no signature, wallet or mutation',at:new Date().toISOString()};
try{
 const readers=urls.map(u=>viemReader(sdk.chainClient(8453,u)));
 const snap=await readSnapshot(readers[0],{wallet:'0x0b2d009c0c9af05b12100d77f3c815fea822ee61',vault:'0xb794c4dd0e1c5e6b72281799f282bfde7654345d',id:'0xcab8fb59882d976bf4005448701149d734b0dab536d9bf46f2b5159b0b0819e9'},Math.floor(Date.now()/1000));
 out.block=snap.block;out.catalog=await Promise.all(readers.map(async(r,i)=>({origin:urls[i],result:await readCatalog(r,snap)})));
}catch(e){out.error=String(e.shortMessage||e.message).slice(0,800);process.exitCode=1;}
fs.writeFileSync(new URL('./result.json',import.meta.url),JSON.stringify(out,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n');
console.log(JSON.stringify(out,(_,v)=>typeof v==='bigint'?String(v):v));
