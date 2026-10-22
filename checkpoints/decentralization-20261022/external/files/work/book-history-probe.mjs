import fs from 'node:fs/promises';
const peers=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.public.blockpi.network/v1/rpc/public'];
const book='0xab214342d5a490150a4a977063a2f88e21f80907';
const topic='0xb37614c7d254ea8d16eb81fa11dddaeb266aa8ba4917980859c7740aff30c691';
const key='0x'+Buffer.from('deployments').toString('hex').padEnd(64,'0');
async function rpc(url,method,params){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(18000)});if(!r.ok)throw Error('HTTP '+r.status);const b=await r.json();if(b.error)throw Error(JSON.stringify(b.error));return b.result;}
const heads=await Promise.all(peers.map(async url=>{try{return {url,head:await rpc(url,'eth_blockNumber',[])}}catch(e){return{url,error:e.message}}}));
const good=heads.filter(x=>x.head);if(good.length<2)throw Error('No head quorum');
const height=good.reduce((v,x)=>BigInt(x.head)<v?BigInt(x.head):v,BigInt(good[0].head))-2n;const toBlock='0x'+height.toString(16);
const result={at:new Date().toISOString(),book,toBlock,heads,peers:await Promise.all(good.map(async({url})=>{try{const b=await rpc(url,'eth_getBlockByNumber',[toBlock,false]);const logs=await rpc(url,'eth_getLogs',[{address:book,topics:[topic,key],fromBlock:'0x0',toBlock}]);return {url,hash:b.hash,timestamp:b.timestamp,logs}}catch(e){return{url,error:e.message}}}))};
await fs.mkdir('outputs/browser-platform-book-integration',{recursive:true});await fs.writeFile('outputs/browser-platform-book-integration/history-rpc-probe.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({height:height.toString(),results:result.peers.map(x=>({url:x.url,count:x.logs?.length,error:x.error}))}));
