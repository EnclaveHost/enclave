// Public routing metadata only. Application traffic never crosses this process.
import http from 'node:http';
import net from 'node:net';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {X509Certificate,createHash} from 'node:crypto';
export const ROOT='enclavehost.eth';
const CONTROL=new Set(['api','mcp'].map(s=>s+'.'+ROOT));
// Control names carry no fixed fleet address. A native-CA certificate proves only that a key may serve the name, not which
// operator or registry host serves it, so a service-index advertisement cannot be admitted by its advertiser: an unbanned
// operator could republish a banned host's endpoint. Until a route source binds the serving endpoint to an admitted host,
// none is configured and control names answer unavailable (docs/design/nan-retirement.md, "Direct-IP recovery ingress").
const NON_PUBLIC=new net.BlockList();
for(const [a,p] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],
 ['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])NON_PUBLIC.addSubnet(a,p,'ipv4');
const publicIPv4=a=>typeof a==='string'&&net.isIPv4(a)&&!NON_PUBLIC.check(a,'ipv4');
export function routeFor(name, map, now=Date.now()) {
 if(typeof name!=='string'||name!==name.toLowerCase()||name.length>253)return null;
 if(CONTROL.has(name)){
  const row=map?.routes?.[name];
  if(!row||!(row.expiresAt>now)||!Array.isArray(row.addresses)||!row.addresses.length||!row.addresses.every(publicIPv4))return null;
  return {name,addresses:[...row.addresses],port:443,kind:'control',expiresAt:row.expiresAt};
 }
 const m=name.match(/^([0-9a-f]{8})\.app\.enclavehost\.eth$/);
 if(!m)return null;
 const row=map?.labels?.[m[1]];
 if(!row||!(row.expiresAt>now)||!row.addresses?.length)return null;
 return {name,addresses:row.addresses,port:443,kind:'application',expiresAt:row.expiresAt};
}
const bounded=(p,ms)=>{let t;return Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(Error('route source timed out')),ms);t.unref?.();})]).finally(()=>clearTimeout(t));};
// getControlRoutes: an AUTHENTICATED route source, () -> { routes: { [name]: { addresses, expiresAt } } }, or null (none
// exists yet: control names answer 503). Every route source is bounded by timeoutMs.
export function createDiscovery({getRoutes,getControlRoutes=null,caPem,timeoutMs=15000}){
 const fingerprint=createHash('sha256').update(new X509Certificate(caPem).raw).digest('hex');
 return http.createServer(async(req,res)=>{
  const json=(status,obj,extra={})=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...extra});res.end(JSON.stringify(obj));};
  let u; try { u=new URL(req.url,'http://localhost'); } catch { return json(400,{error:'invalid_url'}); }
  if(req.method!=='GET')return json(405,{error:'method_not_allowed'});
  if(u.pathname==='/native/ca.pem') {res.writeHead(200,{'content-type':'application/x-pem-file','cache-control':'public,max-age=3600'});return res.end(caPem);}
  if(u.pathname==='/native/status')return json(200,{service:'enclave-native-discovery',root:ROOT,caSha256:fingerprint});
  if(u.pathname!=='/native/resolve')return json(404,{error:'not_found'});
  try {
   const name=u.searchParams.get('name');
   const control=CONTROL.has(name);
   if(control&&!getControlRoutes)return json(503,{error:'control_route_unavailable'},{'retry-after':'300'});
   const map=control?await bounded(getControlRoutes(),timeoutMs):name?.endsWith('.app.'+ROOT)?await bounded(getRoutes(),timeoutMs):null;
   const route=routeFor(name,map);
   if(!route&&control)return json(503,{error:'control_route_unavailable'},{'retry-after':'30'});
   if(!route)return json(404,{error:'no_current_route'});
   return json(200,{...route,caSha256:fingerprint});
  }catch{return json(503,{error:'route_discovery_unavailable'});}
 });
}
/** The deployed service's options: the local relay's verified application route map, and no control route source. */
export function deployedOptions(caPem,{routeMapUrl='http://127.0.0.1:8100/v1/network/routes'}={}){
 return {caPem,getRoutes:async()=>{
  const r=await fetch(routeMapUrl,{signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw new Error('route map unavailable');return r.json();
 }};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const caPem=await readFile(process.env.NATIVE_CA_CERT||'/var/lib/enclave-native-ca/ca.pem','utf8');
 createDiscovery(deployedOptions(caPem)).listen(8187,'127.0.0.1');
}
