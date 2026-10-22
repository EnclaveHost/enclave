import {catalogReader,versionConfigReader} from './measurement-predict.mjs';
import fs from 'node:fs';import vm from 'node:vm';import{createPublicClient,http,stringToHex,padHex}from'viem';import{base}from'viem/chains';
const env=Object.fromEntries(fs.readFileSync('/etc/nan-relay/api-relay.env','utf8').split('\n').filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{let i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).replace(/^['"]|['"]$/g,'')]}));
const src=fs.readFileSync('/opt/nan-relay/api-relay.js','utf8'),start=src.indexOf('const DEP_TUPLE = [')+'const DEP_TUPLE = '.length;
const tuple=vm.runInNewContext('('+src.slice(start,src.indexOf('\n];',start)+2)+')');
for(const url of [...env.SECRETS_RELEASE_CATALOG_RPCS.split(','),'https://base-mainnet.public.blastapi.io']) {
 const host=new URL(url).hostname,c=createPublicClient({chain:base,transport:http(url,{retryCount:0,timeout:6000})});
 try {const addr=env.DEPLOYMENTS_ADDRESS||await c.readContract({address:env.ADDRESS_BOOK_ADDRESS,abi:[{type:'function',name:'addr',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'address'}]}],functionName:'addr',args:[padHex(stringToHex('deployments'),{size:32,dir:'right'})]});
 const d=await c.readContract({address:addr,abi:[{type:'function',name:'get',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'tuple',components:tuple}]}],functionName:'get',args:['0xf19ec75397dc1a691bbbcdc2bb7fc53778deabc7f633a919d6dca4f28a521246']});console.log(host,'row OK',d.id,d.active);
 const cat=await c.readContract({address:env.ADDRESS_BOOK_ADDRESS,abi:[{type:'function',name:'addr',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'address'}]}],functionName:'addr',args:[padHex(stringToHex('appCatalog'),{size:32,dir:'right'})]});
 const ref=/^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d+)$/.exec(d.appRef);
 const got=await catalogReader([c],async()=>cat)(ref[1],Number(ref[2]));console.log(host,'catalog OK',got.version.approval,got.version.memMb);
 const cfg=await versionConfigReader([c],async()=>cat)(ref[1],Number(ref[2]));console.log(host,'config OK',Object.keys(cfg));
 }catch(e){let x=e;for(let i=0;x&&i<5;i++,x=x.cause)console.log(host,x.name,x.code,x.status,String(x.details||x.shortMessage||'').replace(/https?:\/\/\S+/g,'[endpoint]').slice(0,200));}
}
