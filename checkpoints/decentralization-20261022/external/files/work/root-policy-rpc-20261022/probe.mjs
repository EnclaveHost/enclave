(async()=>{
const urls=['https://base-rpc.publicnode.com','https://base.gateway.tenderly.co','https://base-public.nodies.app','https://base.drpc.org','https://mainnet.base.org','https://public.1rpc.io/base'];
const out={at:new Date().toISOString(),scope:'Native minipc, read-only Base RPC diagnostics; no signing/configuration change',calls:[],results:[]};
async function rpc(url,method,params){const at=Date.now();let r,j;try{r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(8000)});j=await r.json();if(!r.ok||j.error||j.result==null)throw Error(JSON.stringify(j.error||{http:r.status}));out.calls.push({url,method,http:r.status,ms:Date.now()-at});return j.result;}catch(e){out.calls.push({url,method,http:r?.status??null,ms:Date.now()-at,error:String(e.message).slice(0,180)});throw e;}}
const ready=await Promise.all(urls.map(async url=>{try{if(BigInt(await rpc(url,'eth_chainId',[]))!==8453n)throw Error('wrong chain');return {url,head:await rpc(url,'eth_blockNumber',[])};}catch{return null;}}));
const live=ready.filter(Boolean);
if(live.length){const b=live.map(x=>BigInt(x.head)).reduce((a,x)=>a<x?a:x)-2n;const block='0x'+b.toString(16);out.block=block;
await Promise.all(live.map(async x=>{try{const v=await rpc(x.url,'eth_getBlockByNumber',[block,false]);const c=await rpc(x.url,'eth_call',[{to:'0xcA11bde05977b3631167028862bE2a173976CA11',data:'0x42cbb15c'},block]);out.results.push({...x,block:v.number,hash:v.hash,timestamp:v.timestamp,call:c,valid:v.number===block&&BigInt(c)===b});}catch{out.results.push({...x,valid:false});}}));}
console.log(JSON.stringify(out));})().catch(e=>{console.log(JSON.stringify({fatal:String(e.message)}));process.exitCode=1;});
