// Local read-only application health through guestd's authenticated original-VM metadata.
// Strict public-hostname TLS on the loopback forwarder. No relay, secret, log or app-data export.
import fs from 'node:fs';
import https from 'node:https';
import {pathToFileURL} from 'node:url';
import {GuestdControl,parseKey} from '../linux-post-adoption-release/stage/metal-deabf8f90/isolation/m4/guestd/control-client.mjs';
import {APPS} from '../custody-maintenance-window-20261024/window.mjs';
const runtime='297b6c2c0aee68c38ed612972afd11b12865e21ee39c01f4336e8721b3ef02f8';
const specs=JSON.parse(fs.readFileSync(new URL('../custody-boot-fee-activation-20261023/apps-health.json',import.meta.url)));
export function healthyBody(spec,status,type,body){
 if(status!==200) return false;
 if(spec.kind==='json-ping'){try{const j=JSON.parse(body);return j.ok===true&&j.pong===true;}catch{return false;}}
 const m=body.toString().match(/<title[^>]*>(.*?)<\/title>/is),title=m?.[1].replace(/\s+/g,' ').trim();
 return spec.kind==='html'&&type.toLowerCase().includes('text/html')&&body.length>=spec.minBytes&&(!spec.title||title===spec.title);
}
function health(spec,port){return new Promise((resolve,reject)=>{
 const u=new URL(spec.url);const timer=setTimeout(()=>{req.destroy(Error('deadline'));},15000);let size=0;const chunks=[];
 const req=https.request({hostname:'127.0.0.1',port,servername:u.hostname,path:u.pathname,method:'GET',headers:{Host:u.hostname,'Cache-Control':'no-cache'},rejectUnauthorized:true},res=>{
  res.on('data',c=>{size+=c.length;if(size>1048576){req.destroy(Error('body bound'));return;}chunks.push(c);});
  res.on('error',()=>{clearTimeout(timer);reject(Error('local app response unavailable'));});
  res.on('end',()=>{clearTimeout(timer);const ok=healthyBody(spec,res.statusCode,String(res.headers['content-type']||''),Buffer.concat(chunks));if(!ok)reject(Error('local app health failed'));else resolve(true);});
 });req.on('error',()=>{clearTimeout(timer);reject(Error('local app strict TLS unavailable'));});req.end();
});}
export async function originalGuestHealth(id){
 if(!Object.hasOwn(APPS,id))throw Error('unpinned app');const pair=parseKey(fs.readFileSync('/home/steven/enclave-prod/guestd-pair.key','utf8'));
 try{
  const client=new GuestdControl('http://127.0.0.1:8095',pair,{requestTimeoutMs:12000,maxResponseBytes:131072});
  const r=await client.request('GET','/vms/'+APPS[id]),g=r.body;
  if(r.status!==200||g?.status!=='running'||g.id!==APPS[id]||g.name!==id||g.runtimeId!==runtime||!Number.isInteger(g.hostPort)||g.hostPort<1024||g.hostPort>65535||!/^[a-f0-9]{64}$/.test(g.recordSha256??''))throw Error('original guest identity mismatch');
  await health(specs[id],g.hostPort);
  const after=await client.request('GET','/vms/'+APPS[id]);
  if(after.status!==200||['id','name','status','runtimeId','recordSha256','hostPort','transportKeySha256'].some(k=>g[k]!==after.body?.[k]))throw Error('guest changed during health check');
  return {id,guest:APPS[id],status:g.status,runtimeId:g.runtimeId,recordSha256:g.recordSha256,healthy:true,strictTls:true};
 }finally{pair.fill(0);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const rows=[];for(const id of Object.keys(APPS)){try{rows.push(await originalGuestHealth(id));}catch(e){rows.push({id,healthy:false,reason:e.message});}}
 const out={at:new Date().toISOString(),readOnly:true,scope:'Original guest identity and application body over hostname-verified loopback TLS; not SNP attestation or public routing proof',rows};
 const text=JSON.stringify(out,null,2);fs.writeFileSync('outputs/decentralization-audit/metal0-local-app-health-20261024.json',text+'\n');console.log(text);if(rows.some(r=>!r.healthy))process.exitCode=1;
}
