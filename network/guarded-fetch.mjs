import https from 'node:https';
import {SocksHttpsAgent} from './socks-connect.mjs';

// Fetch-compatible bounded HTTPS for chain RPC and discovery. Names are resolved
// by the guard; redirects and implicit direct/host-DNS fallbacks are forbidden.
export function guardedFetch(proxy,{maxBytes=2097152,timeoutMs=15000}={}){
  if(typeof proxy!=='string'||!proxy)throw new Error('explicit SOCKS proxy required');
  return async(input,init={})=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error('guarded HTTPS URL required');
    const agent=new SocksHttpsAgent(proxy);
    try{
      return await new Promise((resolve,reject)=>{
        const headers=Object.fromEntries(new Headers(init.headers||input.headers||{}));
        const req=https.request(url,{method:init.method||input.method||'GET',headers,agent,signal:init.signal,timeout:timeoutMs},res=>{
          const chunks=[];let length=0;
          res.on('data',b=>{length+=b.length;if(length>maxBytes)res.destroy(new Error('guarded response too large'));else chunks.push(b);});
          res.once('error',reject);res.once('end',()=>{
            const responseHeaders=new Headers();for(const[key,value]of Object.entries(res.headers)){if(Array.isArray(value))for(const item of value)responseHeaders.append(key,item);else if(value!==undefined)responseHeaders.set(key,value);}
            resolve(new Response([204,205,304].includes(res.statusCode)?null:Buffer.concat(chunks),{status:res.statusCode,headers:responseHeaders}));
          });
        });
        req.once('error',reject);req.once('timeout',()=>req.destroy(new Error('guarded HTTPS timeout')));
        const timer=setTimeout(()=>req.destroy(new Error('guarded request deadline')),timeoutMs);req.once('close',()=>clearTimeout(timer));
        if(init.body!==undefined&&init.body!==null){if(typeof init.body!=='string'&&!Buffer.isBuffer(init.body)&&!(init.body instanceof Uint8Array)){req.destroy(new Error('bounded request body required'));return;}req.end(init.body);}else req.end();
      });
    }finally{agent.destroy();}
  };
}
