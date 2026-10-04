// NKN mainnet transactions have no EVM chain ID. Pin the configured genesis,
// require independent RPC agreement, and inspect signatures with the offline
// Go helper before accepting native funds. RPC agreement is a wallet trust
// policy, not an atomic cross-chain bridge proof.
import {decimalUnits} from './policy.mjs';
export function exactParse(text){return JSON.parse(text,(_k,v,c)=>{if(typeof v==='number'&&Number.isInteger(v)&&!Number.isSafeInteger(v)){if(!c?.source||!/^\d+$/.test(c.source))throw Error('unsafe RPC integer');return BigInt(c.source);}return v;});}
export function exactJSON(v){
 if(typeof v==='bigint')return String(v);
 if(Array.isArray(v))return '['+v.map(exactJSON).join(',')+']';
 if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+exactJSON(v[k])).join(',')+'}';
 return JSON.stringify(v);
}
export class NativeNknRPC {
 constructor({endpoints,genesisHash,confirmations=12,fetchFn=fetch,now=Date.now}){
  if(!Array.isArray(endpoints)||endpoints.length<2||new Set(endpoints.map(u=>new URL(u).hostname)).size!==endpoints.length||endpoints.some(u=>new URL(u).protocol!=='https:'||new URL(u).username||new URL(u).password)||!/^([0-9a-f]{64})$/.test(genesisHash||'')||!Number.isInteger(confirmations)||confirmations<3||confirmations>120)throw Error('pinned native chain and independent HTTPS RPCs required');
  Object.assign(this,{endpoints,genesisHash,confirmations,fetchFn,now});
 }
 async call(endpoint,method,params={}){
  const response=await this.fetchFn(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:exactJSON({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok)throw Error('native RPC HTTP failure');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
   if(size>8*1024*1024)throw Error('native RPC response too large');chunks.push(value);
  }}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  const body=Buffer.concat(chunks).toString('utf8');
  const value=exactParse(body);if(value.error||value.result===undefined)throw Error('native RPC result unavailable');return value.result;
 }
 async quorum(method,params={}){
  const results=await Promise.all(this.endpoints.map(e=>this.call(e,method,params).catch(()=>undefined)));
  for(const r of results)if(r!==undefined&&results.filter(v=>v!==undefined&&exactJSON(v)===exactJSON(r)).length>=2)return r;
  throw Error('native RPC quorum unavailable');
 }
 async pinned(){
  const b=await this.quorum('getblock',{height:0});if(b.hash!==this.genesisHash||b.header?.height!==0)throw Error('native genesis mismatch');
 }
 async anchor(){
  await this.pinned();
  const results=await Promise.all(this.endpoints.map(e=>this.call(e,'getlatestblockhash').catch(()=>null)));
  const heads=results.filter(h=>Number.isSafeInteger(h?.height)&&h.height>=this.confirmations).map(h=>h.height).sort((a,b)=>b-a);
  if(heads.length<2)throw Error('native chain heads unavailable');
  const recent=await this.block(heads[1]);
  if(recent.timestamp>this.now()+10000||recent.timestamp<this.now()-180000)throw Error('native chain is stale');
  return this.block(heads[1]-this.confirmations);
 }
 async block(height){
  const b=await this.quorum('getblock',{height});
  if(!/^([0-9a-f]{64})$/.test(b.hash||'')||b.header?.height!==height||!Number.isSafeInteger(b.header.timestamp)||!Array.isArray(b.transactions))throw Error('invalid native block');
  return {height,hash:b.hash,previous:b.header.prevBlockHash,timestamp:b.header.timestamp*1000,transactions:b.transactions};
 }
 async balance(address){await this.pinned();return String(decimalUnits((await this.quorum('getbalancebyaddr',{address})).amount,8));}
 async nonce(address){
  const n=await this.quorum('getnoncebyaddr',{address});
  const values=[n.nonce,n.nonceInTxPool].map(x=>{if(typeof x!=='bigint'&&!Number.isSafeInteger(x))throw Error('invalid native nonce');return BigInt(x);});
  if(values.some(n=>n<0n||n>=1n<<64n))throw Error('native nonce out of range');return String(values[0]>values[1]?values[0]:values[1]);
 }
 async broadcast(raw,expectedHash){
  // An uncertain response is reconciled by scanning the chain. Every retry
  // uses the same signed raw bytes, never a replacement transfer.
  for(const endpoint of this.endpoints){try{const hash=await this.call(endpoint,'sendrawtransaction',{tx:raw});if(hash===expectedHash)return hash;}catch{}}
  throw Error('native broadcast outcome unknown; reconcile the same signed transaction');
 }
}
