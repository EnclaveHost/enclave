// Credential-bearing RPC upstreams stay in this process. No upstream URLs or
// credentials are returned in errors, health responses, or request logs.
import http from 'node:http';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
export const NETWORKS = {
  base: {id:'0x2105', alchemy:'base-mainnet', fallback:['https://base-rpc.publicnode.com','https://base.drpc.org','https://mainnet.base.org']},
  'base-sepolia': {id:'0x14a34', alchemy:'base-sepolia', fallback:['https://sepolia.base.org','https://base-sepolia-rpc.publicnode.com']},
  ethereum: {id:'0x1', alchemy:'eth-mainnet', fallback:['https://ethereum-rpc.publicnode.com','https://eth.drpc.org']},
};
const READS = new Set(['eth_chainId','net_version','eth_blockNumber','eth_call','eth_getBalance','eth_getCode','eth_getStorageAt','eth_getTransactionCount','eth_getBlockByNumber','eth_getBlockByHash','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getLogs','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory','eth_estimateGas','eth_getProof','eth_getBlockTransactionCountByNumber','eth_getBlockTransactionCountByHash']);
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x==='object' ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])) : x;
export function cacheTtl(method, params) {
  if (!READS.has(method) || JSON.stringify(params).includes('"pending"') || method==='eth_estimateGas' || method==='eth_getTransactionCount') return 0;
  if (method==='eth_chainId'||method==='net_version') return 3600000;
  // Even numbered blocks can be reorged; use a short TTL rather than treating
  // numbers/receipts as immutable. Hash-addressed state remains reorg-aware too.
  return 1000;
}
const failure=(code,message)=>({error:{code,message}});
export function createRpcGateway({upstreams,fetchImpl=fetch,now=Date.now,maxEntries=4096,maxBytes=16*1024*1024,timeoutMs=3000,maxInflight=32,maxUpstreamPerSecond=30}={}) {
  const cache=new Map(), pending=new Map(), stats={hits:0,misses:0,coalesced:0,primary:0,fallback:0,errors:0};
  let bytes=0,active=0,tokens=maxUpstreamPerSecond,tokenAt=now();
  function budget(){const at=now();tokens=Math.min(maxUpstreamPerSecond,tokens+(at-tokenAt)*maxUpstreamPerSecond/1000);tokenAt=at;if(tokens<1)return false;tokens--;return true;}
  function drop(k){const c=cache.get(k);if(c)bytes-=c.bytes;cache.delete(k);}
  async function upstream(network,method,params){
    if(active>=maxInflight)return failure(-32005,'RPC busy; retry shortly');
    active++;
    try {
      const urls=upstreams[network];
      for(let i=0;i<urls.length;i++) {
        if(!budget())return failure(-32005,'RPC rate limit; retry shortly');
        stats[i===0?'primary':'fallback']++;
        try {
          const response=await fetchImpl(urls[i],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(timeoutMs)});
          if(!response.ok){await response.body?.cancel();throw Error('upstream unavailable');}
          let raw='',size=0;
          for await(const chunk of response.body){size+=chunk.length;if(size>4*1024*1024)throw Error('response too large');raw+=Buffer.from(chunk).toString();}
          const j=JSON.parse(raw);
          if(j.jsonrpc!=='2.0'||j.id!==1||(!Object.hasOwn(j,'result')&&!j.error))throw Error('invalid response');
          if(j.error){
            if([429,-32005,-32016,-32603].includes(j.error.code)||/rate limit|too many|temporarily|capacity|timeout|unavailable/i.test(j.error.message||''))throw Error('transient RPC error');
            // Preserve machine-readable revert data; redact provider messages
            // because some providers echo URLs and request credentials in them.
            return {error:{code:Number.isInteger(j.error.code)?j.error.code:-32000,message:/revert/i.test(j.error.message||'')?'execution reverted':'RPC request rejected',...(typeof j.error.data==='string'&&/^0x[0-9a-f]*$/i.test(j.error.data)?{data:j.error.data}:{})}};
          }
          if(method==='eth_chainId'&&j.result!==NETWORKS[network].id)throw Error('wrong chain');
          return {result:j.result};
        }catch {
          // Submissions are never cached/coalesced/retried after an ambiguous
          // outcome. A caller must check its transaction hash before retrying.
          if(!READS.has(method))break;
        }
      }
      stats.errors++;return failure(-32002,'RPC upstream unavailable');
    }finally{active--;}
  }
  async function request(network,msg){
    const id=msg?.id??null,wrap=value=>({jsonrpc:'2.0',id,...value});
    if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0'||!['string','number'].includes(typeof msg.id)&&msg.id!==null||typeof msg.method!=='string'||msg.params!==undefined&&!Array.isArray(msg.params))return wrap(failure(-32600,'Invalid Request'));
    if(!upstreams?.[network])return wrap(failure(-32602,'Unsupported network'));
    const {method}=msg,params=msg.params??[];
    if(!READS.has(method)&&method!=='eth_sendRawTransaction')return wrap(failure(-32601,'Method not supported'));
    if(method==='eth_sendRawTransaction'&&(params.length!==1||!/^0x[0-9a-f]+$/i.test(params[0])))return wrap(failure(-32602,'Invalid signed transaction'));
    const ttl=cacheTtl(method,params), key=createHash('sha256').update(JSON.stringify([network,method,canonical(params)])).digest('hex');
    if(ttl){
      const entry=cache.get(key);
      if(entry&&entry.until>now()){stats.hits++;return wrap(entry.value);}
      drop(key);
      if(pending.has(key)){stats.coalesced++;return wrap(await pending.get(key));}
    }
    stats.misses++;
    const task=upstream(network,method,params).then(value=>{
      if(ttl&&!value.error&&value.result!==null&&value.result!==undefined){
        const size=Buffer.byteLength(JSON.stringify(value));
        if(size<=256*1024){while(cache.size&&(cache.size>=maxEntries||bytes+size>maxBytes))drop(cache.keys().next().value);cache.set(key,{value,bytes:size,until:now()+ttl});bytes+=size;}
      }
      return value;
    });
    if(ttl)pending.set(key,task);
    try{return wrap(await task);}finally{if(ttl)pending.delete(key);}
  }
  return {request,stats:()=>({...stats,entries:cache.size,bytes,active})};
}
export function createServer(gateway){
  const buckets=new Map();
  const server=http.createServer({requestTimeout:15000,headersTimeout:10000,maxHeaderSize:8192},async(req,res)=>{
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','content-type');res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
    const send=(status,body)=>{res.writeHead(status);res.end(JSON.stringify(body));};
    if(req.url==='/health'&&req.method==='GET')return send(200,{ok:true,...gateway.stats()});
    const match=req.url?.match(/^\/rpc\/(base|base-sepolia|ethereum)$/);
    if(!match)return send(404,{error:'not_found'});
    if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
    if(req.method!=='POST')return send(405,{error:'POST required'});
    // Bound memory and total upstream spend even if forwarded addresses are spoofed.
    const ip=req.socket.remoteAddress,at=Date.now();
    let b=buckets.get(ip);if(!b||at-b.at>1000){b={at,count:0};buckets.set(ip,b);}
    if(++b.count>200)return send(429,{error:'rate_limited'});
    if(buckets.size>4096)buckets.clear();
    try {
      let size=0,parts=[];
      for await(const chunk of req){size+=chunk.length;if(size>65536){send(413,{error:'body_too_large'});req.resume();return;}parts.push(chunk);}
      const body=JSON.parse(Buffer.concat(parts).toString());
      if(Array.isArray(body)&&(!body.length||body.length>20))return send(400,{error:'batch_limit'});
      const result=Array.isArray(body)?await Promise.all(body.map(x=>gateway.request(match[1],x))):await gateway.request(match[1],body);
      return send(200,result);
    }catch{return send(400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
  });
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const gateway=createRpcGateway(config),server=createServer(gateway);
  server.listen(config.port??8190,'127.0.0.1',()=>console.log('RPC gateway ready; upstream credentials private'));
  for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>server.close(()=>process.exit(0)));
}
