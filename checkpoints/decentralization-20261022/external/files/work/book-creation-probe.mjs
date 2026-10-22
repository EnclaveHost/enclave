import fs from 'node:fs/promises';
const book='0xab214342d5a490150a4a977063a2f88e21f80907';
const peers=['https://base.public.blockpi.network/v1/rpc/public','https://mainnet.base.org','https://base-rpc.publicnode.com'];
const result={at:new Date().toISOString(),book,authoritativeHistoryComplete:false,observations:[]};
let calls=0;
async function rpc(url,method,params){if(++calls>70)throw Error('request budget exceeded'); const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:calls,method,params}),signal:AbortSignal.timeout(12000)});if(!res.ok)throw Error('HTTP '+res.status);const d=await res.json();if(d.error)throw Error(d.error.message);await new Promise(r=>setTimeout(r,400));return d.result;}
const hex=n=>'0x'+n.toString(16);
try{
 let selected;
 for(const url of peers){try{const head=BigInt(await rpc(url,'eth_blockNumber',[]));const code=await rpc(url,'eth_getCode',[book,hex(head-6n)]);if(code!=='0x'){const genesis=await rpc(url,'eth_getCode',[book,'0x0']);if(genesis!=='0x')throw Error('nonempty genesis code');selected={url,head:head-6n};break;}}catch(e){result.observations.push({url,error:e.message});}}
 if(!selected)throw Error('no usable RPC');
 let lo=0n,hi=selected.head;
 while(hi-lo>1n){const mid=(hi+lo)/2n;const code=await rpc(selected.url,'eth_getCode',[book,hex(mid)]);if(code==='0x')lo=mid;else hi=mid;}
 result.candidateCreationBlock=hi.toString();
 for(const url of peers){try{const before=await rpc(url,'eth_getCode',[book,hex(hi-1n)]);const at=await rpc(url,'eth_getCode',[book,hex(hi)]);const block=await rpc(url,'eth_getBlockByNumber',[hex(hi),false]);result.observations.push({url,beforeEmpty:before==='0x',atNonempty:at!=='0x',code:at,blockHash:block.hash});}catch(e){result.observations.push({url,error:e.message});}}
 const valid=result.observations.filter(x=>x.beforeEmpty&&x.atNonempty);result.creationBoundaryAgrees=valid.length>=2 && new Set(valid.map(x=>x.code+':'+x.blockHash)).size===1;
 console.log(JSON.stringify({creationBlock:result.candidateCreationBlock,boundaryAgrees:result.creationBoundaryAgrees,providers:result.observations.map(({url,error,beforeEmpty,atNonempty})=>({url,error,beforeEmpty,atNonempty}))}));
}catch(e){result.error=e.message;console.log(JSON.stringify({error:e.message}));}
result.requests=calls;await fs.writeFile('outputs/browser-platform-book-integration/book-creation-probe.json',JSON.stringify(result,null,2)+'\n');
