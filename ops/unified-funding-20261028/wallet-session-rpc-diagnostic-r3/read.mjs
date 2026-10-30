import fs from 'node:fs';
import {createPublicClient,http,keccak256,toHex} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-kvm-guest/node_modules/viem/_esm/index.js';
const p=new URL('.',import.meta.url);fs.writeFileSync(new URL('attempt',p),'six bounded read-only probes, no retry',{flag:'wx'});
const urls=['https://mainnet.base.org','https://base.drpc.org','https://1rpc.io/base'];
const addr='0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b';const topic=keccak256(new TextEncoder().encode('DelegateSet(address,address,bool)'));
const qs=[['chain','eth_chainId',[]],['logs','eth_getLogs',[{address:addr,topics:[topic],fromBlock:toHex(52831588),toBlock:toHex(52851587)}]]];
const result=await Promise.all(urls.map(async url=>{const c=createPublicClient({transport:http(url,{timeout:10000,retryCount:0})});const r=[];for(const[name,method,params]of qs){try{const a=await c.request({method,params});r.push({name,ok:true,count:Array.isArray(a)?a.length:null,emptyCode:a==='0x'});}catch(e){let x=e,errors=[];for(let i=0;i<5&&x;i++,x=x.cause)errors.push({name:x.name,code:x.code,short:x.shortMessage,details:x.details,message:String(x.message).slice(0,1800)});r.push({name,ok:false,errors});}}return {url,result:r};}));
fs.writeFileSync(new URL('result.json',p),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
