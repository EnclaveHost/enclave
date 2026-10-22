import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
const target = new URL('../host-relay-placement/tree/network/lease-relay-discovery.mjs', import.meta.url).href;
const fixture = new URL('./index-fixture.mjs', import.meta.url).href;
const hooks=registerHooks({resolve(s,c,next){if(c.parentURL === target && s === './service-index.mjs')return {url:fixture,shortCircuit:true};return next(s,c)}});
const {discoverLeaseRelays,relayDescriptor,cachedRelayDiscovery}=await import(target);
const {relayStatementMessage}=await import('../host-relay-placement/tree/client/lease-executor-client.mjs');
const account=privateKeyToAccount(generatePrivateKey()); // ephemeral test key, no production credentials
const pins={chainId:8453,reserve:'0x'+'11'.repeat(20),executor:'0x'+'22'.repeat(20)};
const bytes=relayDescriptor({operator:account.address,payee:account.address,...pins});
const message=relayStatementMessage({...pins,payee:account.address,issuedAt:Math.floor(Date.now()/1000)});
const info={...pins,payee:account.address,statement:{message,signature:await account.signMessage({message})}};
globalThis.__relayReviewIndex={status:'complete',blockNumber:1n,blockHash:'0x'+'33'.repeat(32),candidates:[{operator:account.address,kindName:'relay',endpoints:['https://relay.example/'],descriptor:'0x'+createHash('sha256').update(bytes).digest('hex')}]};
const fetch=async url=>new Response(url.endsWith('/v1/descriptor')?bytes:JSON.stringify(info));
const results=[];
for (const [name,decide] of [['throws',async()=>{throw Error('policy on but unusable')}],['unknown',async()=>({[account.address.toLowerCase()]:{admit:false,status:'behind',reason:'policy behind anchor'}})]]) {
 const r=await discoverLeaseRelays({pins,decide,fetch,resolve:async()=>['192.0.2.1']});
 results.push({case:name,acceptedRelays:r.relays.length,refused:r.refusedByPolicy.length,policy:r.policy});
}
let now=1000,banned=false,calls=0;
const get=cachedRelayDiscovery(async()=>{calls++; return {relays:banned?[]:[{origin:'https://relay.example',operator:account.address}],index:{blockNumber:1},excluded:[],rejected:[],policy:'applied'}},{now:()=>now});
await get(); banned=true; now+=31000;
const afterBan=await get();results.push({case:'cached-admit-after-ban',calls,acceptedRelays:afterBan.length,elapsedMs:31000});
console.log(JSON.stringify(results,null,2)); hooks.deregister();
