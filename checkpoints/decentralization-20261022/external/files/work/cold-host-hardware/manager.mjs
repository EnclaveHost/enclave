import fs from 'node:fs';
import {GuestdControl,parseKey} from '../enclave/isolation/m4/guestd/control-client.mjs';
const ctl=new GuestdControl('http://127.0.0.1:18096',parseKey(fs.readFileSync(new URL('./pair.key',import.meta.url),'utf8')),{requestTimeoutMs:60000});
const plan=JSON.parse(fs.readFileSync(new URL('./preflight.json',import.meta.url)));
const h=await ctl.request('GET','/health');
if(h.status!==200)throw Error('guest manager unavailable');
const derive={derivation:'enclave-catalog-bundle/2',catalog:{app:plan.session.apps[0],version:Number(plan.app.index)},cid:plan.app.version.cid,policy:{cpuPercent:100,memMiB:plan.app.version.memMb,vcpus:1},runtimeId:h.body.catalog.runtimeId,http:8000};
const image='ipfs://'+derive.cid;
if(process.argv[2]==='launch'){
 const state=JSON.parse(fs.readFileSync(new URL('./chain-state.json',import.meta.url)));
 const r=await ctl.request('POST','/vms',{name:state.id,image,derive,cpuShare:1,gpuShare:0,appPort:8000,ports:[],config:'',configCid:'',egress:'',bootstrap:fs.readFileSync(new URL('./package.json',import.meta.url)).toString('base64')});
 fs.writeFileSync(new URL('./launch-response.json',import.meta.url),JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify(r));
 if(r.status!==201)process.exitCode=1;
}else if(process.argv[2]==='prefetch'){
 const r=await ctl.request('POST','/prefetch',{image,derive},{timeoutMs:60000});
 if(r.status!==200)throw Error(JSON.stringify(r.body));
 fs.writeFileSync(new URL('./derived.json',import.meta.url),JSON.stringify({image,derive,...r.body},null,2)+'\n');
 console.log(JSON.stringify(r.body));
}else console.log(JSON.stringify({health:h.body,vms:(await ctl.request('GET','/vms')).body}));
