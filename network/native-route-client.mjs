import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import https from 'node:https';import {createHash} from 'node:crypto';
import {resolveDiscovery} from './discovery.mjs';
import {verifyRoute} from './route-record.mjs';
import {probeGuest} from './guest-probe.mjs';
import {SocksHttpsAgent} from './socks-connect.mjs';
const execute=promisify(execFile);
export async function resolveNknRoutes({deploymentId,binary,configFile,leaseReader,policy,memory}){
 const [{stdout}]=await Promise.all([execute(binary,['--config',configFile,'--deployment',deploymentId,'--mode','lookup'],{timeout:60000,maxBuffer:4*1024*1024}),leaseReader.refresh([deploymentId])]);
 const copies=stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(v=>v.type==='record').map(v=>v.record);
 if(!copies.length)throw new Error('no NKN route records returned');
 // A signed inline copy carries both the IPNS record and its CID-addressed
 // block. No DNS name, HTTP gateway, Nan API or trusted resolver is involved.
 return resolveDiscovery({backupReaders:copies.slice(0,8).map(copy=>async()=>copy),memory,
  verifyBundle:bundle=>verifyRoute(bundle,{deploymentId,policy,lease:leaseReader.get(deploymentId),memory})});
}
export async function requestAttestedRoute({route,proxy,hostname,expected,linux,shield,hostSession,verifySnp,path='/',maxBytes=2097152}){
 if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||/[\r\n\\]/.test(path))throw new Error('app-relative request path required');
 let lastError;
 for(const endpoint of route.routes){
  let agent;
  try{
   if(route.expiresAt<=Date.now())throw new Error('route expired');
   // Before any application request, hardware evidence authenticates the
   // endpoint and its TLS key. CA issuance and SNI are unnecessary here.
   const proof=await probeGuest({deploymentId:route.deploymentId,hostname,address:endpoint.address,proxy,expected,linux,shield,hostSession,verifySnp,domainIndependent:true});
   if(route.expiresAt<=Date.now())throw new Error('route expired during attestation');
   agent=new SocksHttpsAgent(proxy,{tlsOptions:{rejectUnauthorized:false,servername:''},verifyPeer:socket=>{
    const key=socket.getPeerX509Certificate()?.publicKey.export({format:'der',type:'spki'});
    if(!key||createHash('sha256').update(key).digest('hex')!==proof.spkiSha256)throw new Error('attested app TLS key changed');
   }});
   return await new Promise((resolve,reject)=>{
    const request=https.get({host:endpoint.address,port:endpoint.port,servername:'',path,headers:{host:hostname},agent,timeout:15000},response=>{
     const chunks=[];let length=0;response.on('data',b=>{length+=b.length;if(length>maxBytes)response.destroy(new Error('app response too large'));else chunks.push(b);});
     response.once('error',reject);response.once('end',()=>resolve({address:endpoint.address,status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks),proof}));
    });request.once('error',reject);request.once('timeout',()=>request.destroy(new Error('app request timeout')));
   });
  }catch(e){lastError=e;}finally{agent?.destroy();}
 }
 throw lastError||new Error('app has no current routes');
}
