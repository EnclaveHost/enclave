import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {ControlServer} from './candidate/control/windows/vbslike/manager/control.mjs';
import {GuestdControl,GuestdControlError} from './candidate/control/isolation/m4/guestd/control-client.mjs';
import {ProtectedIsolationClient} from './candidate/control/windows/node/protected-isolation.mjs';
// Actual guestd-control handshake/request/response MACs. TEST transport holds one exact signed
// request; TEST handler counts accepted stages, not a VM. Mutable time is shared with server/client.
test('ROOT lost stage remains owned while exact authenticated request can still arrive',async()=>{
 let now=1000000,held,stages=0;
 const deployment='0x'+'11'.repeat(32),key=crypto.randomBytes(32);
 const server=new ControlServer({key,now:()=>now,handle:async({method,path})=>{
  if(method==='GET')return {status:200,body:{schema:'enclave-protected-inventory/1',deployment,complete:true,managerEpoch:server.instance,instances:[]}};
  stages++;return {status:202,body:{testStageAccepted:true}};
 }});
 const control=new GuestdControl('http://127.0.0.1:1',key);
 control._fetch=async(url,init)=>{
  const path=new URL(url).pathname;let out;
  if(path==='/control/hello')out=server.hello();
  else if(path==='/control/session')out=server.session(JSON.parse(init.body));
  else {
   const req={method:init.method,path,headers:init.headers,body:init.body};
   if(path==='/protected/vms'&&!held){held=req;throw new GuestdControlError('transport','TEST request held before server');}
   out=await server.call(req);
  }
  return {res:{status:out.status,headers:new Headers(out.headers)},raw:Buffer.from(JSON.stringify(out.body))};
 };
 const client=new ProtectedIsolationClient({control,now:()=>now});
 await assert.rejects(client.stage({deployment,stagingMs:30000,spawn:{}}),e=>e.mayHaveExecuted===true);
 assert.ok(held);assert.equal(client.unknownStages.has(deployment),true);
 now+=150001;await client.resolveUnknown();
 const stillOwned=client.unknownStages.has(deployment);
 const late=await server.call(held);
 assert.equal(late.status,202,'same signed request remains protocol-valid beyond invented horizon');
 assert.equal(stages,1,'only the delayed original request was accepted');
 assert.equal(stillOwned,true,'client forgot request while actual server could still accept it');
});
