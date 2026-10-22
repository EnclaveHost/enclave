import fs from 'node:fs';
import tls from 'node:tls';
import {createHash,X509Certificate} from 'node:crypto';
import {GuestdControl,parseKey} from '../enclave/isolation/m4/guestd/control-client.mjs';
const dir=new URL('./',import.meta.url);
const ctl=new GuestdControl('http://127.0.0.1:18095',parseKey(fs.readFileSync(new URL('pair.key',dir),'utf8')),{requestTimeoutMs:60000});
const state=JSON.parse(fs.readFileSync(new URL('chain-state.json',dir)));
const guests=(await ctl.request('GET','/vms')).body.vms;
if(guests.length!==1||guests[0].name!==state.id||!guests[0].id.startsWith('db'))throw Error('lab guest scope mismatch');
const g=guests[0];
if(process.argv[2]==='delete'){
 const r=await ctl.request('DELETE','/vms/'+g.id);console.log(JSON.stringify(r));
 if(![200,202].includes(r.status))throw Error('delete failed');
}else{
 if(g.status!=='running'||g.verdict!=='attested')throw Error('not attested and running');
 const result=await new Promise((resolve,reject)=>{
  let response='';
  const s=tls.connect({host:'127.0.0.1',port:g.hostPort,rejectUnauthorized:false},()=>{
   const pin=createHash('sha256').update(new X509Certificate(s.getPeerCertificate().raw).publicKey.export({type:'spki',format:'der'})).digest('hex');
   if(pin!==g.transportKeySha256){s.destroy();return reject(Error('attested SPKI mismatch'));}
   s.write('GET /ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  });
  s.setTimeout(10000,()=>s.destroy(Error('ping timed out')));
  s.on('error',reject);s.on('data',b=>{response+=b;if(response.length>4096)s.destroy(Error('oversized ping'));});
  s.on('end',()=>resolve(response));
 });
 if(!/^HTTP\/1.[01] 200 /.test(result))throw Error('unexpected ping: '+result);
 console.log(JSON.stringify({checkedAt:new Date().toISOString(),guest:g,attestedSPKIMatched:true,response:result}));
}
