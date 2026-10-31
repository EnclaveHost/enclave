// One bounded authenticated local-manager observation. Never sends a VM command.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
let key;
const timer=setTimeout(()=>process.exit(2),1200);
const integer=x=>Number.isSafeInteger(x)&&x>=0;
function file(path,limit,privateMode=false){
  const s=fs.lstatSync(path);
  if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o022)||(privateMode&&(s.mode&0o077))||s.size>limit||fs.realpathSync(path)!==path)throw Error('file-policy');
  const value=fs.readFileSync(path);if(value.length>limit)throw Error('file-growth');return value;
}
try{
  const config=JSON.parse(file(process.argv[2],16384,true));
  if(config.url!=='http://127.0.0.1:8095')throw Error('local-manager-required');
  const source=file(config.controlClient,65536);
  if(crypto.createHash('sha256').update(source).digest('hex')!==config.controlClientSha256)throw Error('control-client-pin');
  const {GuestdControl,parseKey}=await import(pathToFileURL(config.controlClient));
  key=parseKey(file(config.keyFile,65,true).toString('utf8'));
  const client=new GuestdControl(config.url,key,{handshakeTimeoutMs:500,requestTimeoutMs:250,maxResponseBytes:262144,maxHandshakeBytes:16384});
  async function read(){
    const r=await client.request('GET','/health',undefined,{timeoutMs:250});
    if(r.status!==200||r.body?.ok!==true)throw Error('health');
    const h=r.body.pool?.host;
    if(!h||!['floorMiB','memAvailableMiB','pendingMiB','unreadUnits'].every(k=>integer(h[k]))||h.floorMiB===0)throw Error('resource-schema');
    return h;
  }
  const a=await read(),b=await read();
  console.log(JSON.stringify({authenticated:true,availableMiB:Math.min(a.memAvailableMiB,b.memAvailableMiB),pendingMiB:Math.max(a.pendingMiB,b.pendingMiB),floorMiB:Math.max(a.floorMiB,b.floorMiB),unreadUnits:Math.max(a.unreadUnits,b.unreadUnits)}));
}catch{
  console.log(JSON.stringify({authenticated:false}));process.exitCode=2;
}finally{
  key?.fill(0);clearTimeout(timer);
}
