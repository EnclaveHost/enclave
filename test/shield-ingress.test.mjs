import test from 'node:test';import assert from 'node:assert/strict';
import {ShieldIngress} from '../network/shield-ingress.mjs';
const id='0x'+'ab'.repeat(32),app='aa'.repeat(32),runtime='bb'.repeat(32),key='cc'.repeat(32);
const view={id:'hv1',name:id,status:'running',tier:'T0-hv',image:'dd'.repeat(32),appId:app,runtimeId:runtime,transportKeySha256:key};
function fixture(){
 let row={...view},calls=0;
 const ingress=new ShieldIngress({url:'http://127.0.0.1:8091',dataAddr:'127.0.0.1:8092',expected:()=>({appSha256:app,runtimeId:runtime}),key:()=>key,
  fetchFn:async url=>new Response(JSON.stringify(url.pathname==='/vms'?{vms:[row]}:row),{status:200}),
  open:async(addr,route)=>{calls++;return {addr,route};}});
 return {ingress,set:v=>row={...view,...v},calls:()=>calls};
}
test('partition ingress binds to one app, runtime, and verified TLS key without needing a visitor hostname',async()=>{
 const f=fixture(),v=await f.ingress.open(id);assert.equal(v.addr,'127.0.0.1:8092');assert.equal(v.route.appId,app);assert.equal(v.route.key,key);
 for(const [row,error] of [[{name:'0x'+'cd'.repeat(32)},/unique running/],[{status:'stopped'},/unique running/],
  [{appId:'ee'.repeat(32)},/not the app/],[{runtimeId:'ee'.repeat(32)},/identity changed/],[{transportKeySha256:'ee'.repeat(32)},/key changed/],[{image:null},/whole verified identity/]]){
  f.set(row);await assert.rejects(f.ingress.open(id),error);
 }
 assert.equal(f.calls(),1);
 await assert.rejects(f.ingress.open('visitor-supplied-app'),/unknown deployment/);
 await assert.rejects(f.ingress.transport.request('POST','/vms'),/read-only/);
});
test('partition manager and data plane must be literal loopback endpoints',()=>{
 for(const params of [{url:'http://example.com:8091',dataAddr:'127.0.0.1:8092'},
  {url:'http://127.0.0.1:8091',dataAddr:'8.8.8.8:8092'},
  {url:'http://user:pass@127.0.0.1:8091',dataAddr:'127.0.0.1:8092'},
  {url:'http://127.0.0.1:8091/route',dataAddr:'127.0.0.1:8092'}])assert.throws(()=>new ShieldIngress({...params,expected:()=>({})}),/loopback/);
});
