import {guardedFetch} from './guarded-fetch.mjs';
import {verifyIPNS,verifyBlock} from './discovery.mjs';
const media='application/vnd.ipfs.ipns-record';
export function delegatedIPNS(origin,proxy){
 const base=new URL(origin);if(base.protocol!=='https:'||base.pathname!=='/'||base.username||base.password||base.search||base.hash)throw new Error('HTTPS delegated routing origin required');
 const request=guardedFetch(proxy,{maxBytes:10240,timeoutMs:12000});
 const url=name=>new URL('/routing/v1/ipns/'+encodeURIComponent(name),base);
 return {
  async publish(name,bytes){await verifyIPNS(name,bytes);const res=await request(url(name),{method:'PUT',headers:{'content-type':media,accept:media},body:bytes});if(res.status!==200)throw new Error('IPNS publication HTTP '+res.status);},
  async read(name){const res=await request(url(name),{headers:{accept:media}});if(res.status!==200||res.headers.get('content-type')?.split(';')[0]!==media)throw new Error('IPNS record unavailable');return new Uint8Array(await res.arrayBuffer());}
 };
}
export function rawBlockGateway(origin,proxy){
 const base=new URL(origin);if(base.protocol!=='https:'||base.username||base.password)throw new Error('HTTPS block gateway required');
 const request=guardedFetch(proxy,{maxBytes:32768,timeoutMs:12000});
 return async cid=>{const res=await request(new URL('/ipfs/'+encodeURIComponent(cid)+'?format=raw',base),{headers:{accept:'application/vnd.ipld.raw'}});if(res.status!==200)throw new Error('IPFS block HTTP '+res.status);const bytes=new Uint8Array(await res.arrayBuffer());await verifyBlock(cid,bytes);return bytes;};
}
