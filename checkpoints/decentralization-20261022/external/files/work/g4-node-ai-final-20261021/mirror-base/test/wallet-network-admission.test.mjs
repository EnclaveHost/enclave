import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {WalletAllowWriter,WalletAllowFile,withWalletAdmission,walletHoldAcknowledged} from '../network/wallet-admission.mjs';
import {AdmissionGate} from '../network/lease-reader.mjs';
import {EnclaveNetworkManager} from '../network/wg-manager.mjs';
import {EgressMap} from '../network/egress-map.mjs';
import {PrivacyAgent} from '../network/privacy-agent.mjs';
import {defaultNetworkPolicy} from '../network/network-policy-core.mjs';
import {HostEgress} from '../network/host-egress.mjs';

const runner='0x'+'1'.repeat(64),id='0x'+'2'.repeat(64),ref='catalog://0x'+'3'.repeat(64)+'/1';
const expected={appRef:ref,configCid:'bafy-config',appSha256:'4'.repeat(64),runtimeId:'runtime'};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wallet-admission-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let time=1000000;const now=()=>time,file=path.join(dir,'allows.json');
 const writer=new WalletAllowWriter({file,runner,now}),reader=new WalletAllowFile({file,runner,now});
 const binding={appRef:ref,configCid:expected.configCid,validUntil:time+60000};
 const lease={id,runner,owner:'0x'+'5'.repeat(40),...expected,active:true,isPublic:true,validUntil:time+90000,leaseUntil:time+90000};
 const gate=withWalletAdmission(new AdmissionGate({runner,expected:()=>expected,now}),reader);
 gate.observeLease(lease);gate.proofs.set(id,{deploymentId:id,appSha256:expected.appSha256,runtimeId:expected.runtimeId,validUntil:time+60000});
 return {dir,file,writer,reader,gate,lease,binding,now,setTime:v=>{time=v;},raw:()=>fs.readFileSync(file,'utf8')};
}
test('cold reader and empty-on-start writer never grant; allow remains bound to lease and measured proof',t=>{
 const f=fixture(t);assert.equal(f.gate.allows(id),false);f.reader.refresh();assert.equal(f.gate.allows(id),false);
 f.writer.allow(id,f.binding);f.reader.refresh();assert.equal(f.gate.allows(id),true);
 assert.equal(f.gate.walletUntil(id),f.now()+30000);
 f.gate.proofs.delete(id);assert.equal(f.gate.allows(id),false,'wallet alone never grants');
 f.gate.proofs.set(id,{appSha256:expected.appSha256,runtimeId:expected.runtimeId,validUntil:f.now()+60000});
 f.gate.observeLease({...f.lease,configCid:'another-config'});assert.equal(f.gate.allows(id),false);
});
test('hold removes permission and a fresh allow restores it; heartbeat cannot extend policy lifetime',t=>{
 const f=fixture(t);f.writer.allow(id,f.binding);f.reader.refresh();assert.ok(f.gate.allows(id));
 const held=f.writer.hold(id);f.reader.refresh();assert.equal(f.gate.allows(id),false);assert.equal(f.reader.status().revision,held.revision);
 f.writer.allow(id,f.binding);f.reader.refresh();assert.ok(f.gate.allows(id));
 f.setTime(1050000);f.writer.heartbeat();f.reader.refresh();assert.equal(f.gate.walletUntil(id),1060000);
 f.setTime(1060000);assert.equal(f.gate.allows(id),false);f.writer.heartbeat();f.reader.refresh();assert.deepEqual(f.reader.status().allows,[]);
});
test('missing, torn, oversized, wrong-runner and expired documents fail closed without retaining a prior allow',t=>{
 const f=fixture(t);f.writer.allow(id,f.binding);const good=f.raw();
 for(const change of [()=>fs.unlinkSync(f.file),()=>fs.writeFileSync(f.file,'{'),()=>fs.writeFileSync(f.file,'x'.repeat(262145)),()=>{const d=JSON.parse(good);d.runner=id;fs.writeFileSync(f.file,JSON.stringify(d));}]){
  fs.writeFileSync(f.file,good);f.reader.refresh();assert.ok(f.gate.allows(id));change();f.reader.refresh();assert.equal(f.gate.allows(id),false);assert.equal(f.reader.status().fresh,false);
 }
 fs.writeFileSync(f.file,good);f.reader.refresh();f.setTime(1030000);assert.equal(f.gate.allows(id),false);assert.deepEqual(f.reader.status().allows,[]);
});
test('same-generation rollback/equivocation and a replayed retired generation cannot resurrect permission',t=>{
 const f=fixture(t);f.writer.allow(id,f.binding);const allowed=f.raw();f.reader.refresh();f.writer.hold(id);f.reader.refresh();
 fs.writeFileSync(f.file,allowed);f.reader.refresh();assert.equal(f.gate.allows(id),false);assert.match(f.reader.status().error,/rollback/);
 f.writer.heartbeat();f.reader.refresh();const changed=JSON.parse(f.raw());changed.allows[id]=f.binding;fs.writeFileSync(f.file,JSON.stringify(changed));f.reader.refresh();assert.equal(f.gate.allows(id),false);
 const second=new WalletAllowWriter({file:f.file,runner,now:f.now});f.reader.refresh();assert.equal(f.gate.allows(id),false);assert.equal(f.reader.status().generation,second.generation);
 fs.writeFileSync(f.file,allowed);f.reader.refresh();assert.equal(f.gate.allows(id),false);assert.match(f.reader.status().error,/retired/);
});
test('writer restart atomically clears old grants; an unavailable destination never falls back to in-place writing',t=>{
 const f=fixture(t);f.writer.allow(id,f.binding);f.reader.refresh();assert.ok(f.gate.allows(id));
 new WalletAllowWriter({file:f.file,runner,now:f.now});f.reader.refresh();assert.equal(f.gate.allows(id),false);
 assert.deepEqual(fs.readdirSync(f.dir),['allows.json']);
 assert.throws(()=>new WalletAllowWriter({file:f.dir,runner,now:f.now}));assert.equal(fs.statSync(f.dir).isDirectory(),true);
});
test('network manager revokes every circuit and egress map immediately on hold; lease expiry still refuses',async t=>{
 const f=fixture(t);f.writer.allow(id,f.binding);f.reader.refresh();const admissions=[],closed=[],published=[];
 const manager=new EnclaveNetworkManager({admission:f.gate,now:f.now,publish:async(i,r)=>published.push({id:i,routes:r})});
 const circuit={id:'c1',healthy:true,closed:false,egress:'http://127.0.0.1:1234',ingress:true,address:'198.51.100.1',kind:'network',
  admit:n=>admissions.push(n),close:async()=>{closed.push('c1');circuit.closed=true;}};
 manager.apps.set(id,{id,circuits:[circuit]});const egress=new EgressMap({directory:path.join(f.dir,'egress'),manager,dns:['1.1.1.1'],now:f.now});
 assert.ok((await egress.write()).apps[id]);assert.ok(manager.authorizationUntil(id)>f.now());
 f.writer.hold(id);f.reader.refresh();manager.enforceAdmission();
 assert.equal(manager.authorizationUntil(id),0);assert.ok(admissions.includes(0));assert.deepEqual((await egress.write()).apps,{});
 await new Promise(r=>setImmediate(r));assert.deepEqual(closed,['c1']);assert.deepEqual(published.at(-1).routes,[]);
 f.writer.allow(id,f.binding);f.reader.refresh();f.gate.observeLease({...f.lease,leaseUntil:f.now()});assert.equal(manager.authorizationUntil(id),0);
});
test('configuration and writer refuse inferred or excessive permission deadlines',t=>{
 const f=fixture(t);
 assert.throws(()=>new WalletAllowFile({file:'relative.json',runner}));assert.throws(()=>new WalletAllowFile({file:f.file,runner:'wrong'}));
 for(const validUntil of [undefined,NaN,Infinity,1000000,1090001])assert.throws(()=>f.writer.allow(id,{...f.binding,validUntil}));
 assert.throws(()=>f.writer.allow(id,{...f.binding,extra:true}));
});

async function agentFixture(t){
 const f=fixture(t),directory=path.join(f.dir,'agent');
 const agent=new PrivacyAgent({apps:[{deploymentId:id,expected}],runner,wallet:f.reader,directory,dns:['1.1.1.1'],now:f.now,
  leaseReader:{get:()=>null},network:{localRoutes:false,runtime:{},providers:async()=>[]}});
 agent.admission.observeLease(f.lease);agent.admission.proofs.set(id,f.gate.proofs.get(id));
 await agent.manager.configure([{deploymentId:id,names:['22222222.app.enclave.host'],policy:defaultNetworkPolicy(id)}]);
 const status=()=>JSON.parse(fs.readFileSync(path.join(directory,'status.json'),'utf8'));
 const egress=()=>JSON.parse(fs.readFileSync(path.join(directory,'egress-routes.json'),'utf8'));
 return {...f,agent,status,egress};
}
test('a hold is acknowledged only after connection closure and egress persistence, even with route publication hung',async t=>{
 const f=await agentFixture(t);f.writer.allow(id,f.binding);await f.agent.snapshot();
 let finishClose,finishPublish;
 const close=new Promise(r=>{finishClose=r;}),publication=new Promise(r=>{finishPublish=r;});
 f.agent.manager.publish=()=>publication;
 const c={id:'closing',healthy:true,egress:'127.0.0.1:1234',providers:{},admit(){},close:()=>close};
 f.agent.manager.apps.get(id).circuits.push(c);
 const hold=f.writer.hold(id);await f.agent.admit();
 assert.equal(f.status().walletAdmission.revision,hold.revision);
 assert.equal(f.status().walletAdmission.applied,false,'an empty circuits array is not evidence of termination');
 assert.deepEqual(f.egress().apps,{});
 finishClose();await new Promise(r=>setImmediate(r));await f.agent.snapshot();
 assert.equal(f.status().walletAdmission.applied,true,'local revocation does not wait on an external distributor');
 finishPublish();
});
test('a failed circuit close or allocation still in flight cannot acknowledge a hold',async t=>{
 const f=await agentFixture(t);f.writer.allow(id,f.binding);await f.agent.snapshot();
 f.agent.manager.reconciling.set(id,Promise.resolve());f.writer.hold(id);await f.agent.snapshot();
 assert.equal(f.status().walletAdmission.applied,false);
 f.agent.manager.reconciling.delete(id);
 f.agent.manager.apps.get(id).circuits.push({id:'failed-close',providers:{},admit(){},close:async()=>{throw Error('child still alive');}});
 await f.agent.snapshot();await new Promise(r=>setImmediate(r));await f.agent.snapshot();
 assert.equal(f.status().walletAdmission.applied,false,'a rejected close must remain tracked');
 assert.equal(f.agent.manager.retiring.size,1);
});
test('failed egress persistence cannot acknowledge a new hold revision',async t=>{
 const f=await agentFixture(t);f.writer.allow(id,f.binding);await f.agent.snapshot();
 const previous=f.status().walletAdmission.revision;f.writer.hold(id);
 const write=f.agent.egress.write.bind(f.agent.egress);f.agent.egress.write=async()=>{throw Error('disk unavailable');};
 await assert.rejects(f.agent.snapshot(),/disk unavailable/);assert.equal(f.status().walletAdmission.revision,previous);
 f.agent.egress.write=write;await f.agent.snapshot();assert.equal(f.status().walletAdmission.applied,true);
 assert.ok(f.status().walletAdmission.revision>previous);assert.deepEqual(f.egress().apps,{});
});
test('concurrent snapshots cannot acknowledge a newer wallet revision with an older egress map',async t=>{
 const f=await agentFixture(t);f.writer.allow(id,f.binding);await f.agent.snapshot();
 let entered,release;const began=new Promise(r=>{entered=r;}),wait=new Promise(r=>{release=r;});
 const write=f.agent.egress.write.bind(f.agent.egress);let first=true;
 f.agent.egress.write=async()=>{const result=await write();if(first){first=false;entered();await wait;}return result;};
 const old=f.agent.snapshot();await began;
 const hold=f.writer.hold(id),next=f.agent.snapshot();
 assert.notEqual(f.reader.status().revision,hold.revision,'refresh of next snapshot is serialized');
 release();await Promise.all([old,next]);
 assert.equal(f.status().walletAdmission.revision,hold.revision);assert.equal(f.status().walletAdmission.applied,true);assert.deepEqual(f.egress().apps,{});
});
test('host hold acknowledgement rejects stale, wrong-generation, old-runtime and reallowed states',async t=>{
 const f=await agentFixture(t);const hold=f.writer.hold(id);await f.agent.snapshot();
 const good=f.status(),check=status=>walletHoldAcknowledged({status,runner,id,hold,now:f.now()});
 assert.equal(check(good),true);
 for(const mutate of [
  s=>{s.updatedAt=f.now()-5000;},s=>{s.updatedAt=f.now()+1001;},s=>{s.walletAdmission.runner=id;},
  s=>{s.walletAdmission.generation='a'.repeat(32);},s=>{s.walletAdmission.revision=hold.revision-1;},
  s=>{delete s.walletAdmission.applied;},s=>{s.walletAdmission.applied=false;},s=>{s.walletAdmission.allows=[id];},
  s=>{s.walletAdmission.expiresAt=f.now();},s=>{s.walletAdmission.fresh=false;},s=>{s.walletAdmission.error='read failed';}
 ]){const changed=structuredClone(good);mutate(changed);assert.equal(check(changed),false);}
 f.writer.allow(id,f.binding);await f.agent.snapshot();assert.equal(check(f.status()),false,'newer revision may reallow; revision alone is insufficient');
});
test('wallet hold terminates a real established host-egress stream before acknowledgement', {timeout:5000}, async t=>{
 const f=await agentFixture(t);f.writer.allow(id,f.binding);await f.agent.snapshot();
 const sockets=new Set(),echo=net.createServer(s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));s.pipe(s);});
 echo.listen(0,'127.0.0.1');await once(echo,'listening');
 // Only the destination connector is redirected to loopback. The real SOCKS server, authorization checks and
 // established stream splice run unchanged; no public destination or DNS service is contacted.
 const egress=new HostEgress({authorize:i=>f.agent.admission.allows(i),connect:()=>net.connect({host:'127.0.0.1',port:echo.address().port})});
 let client;t.after(async()=>{client?.destroy();await egress.close();for(const s of sockets)s.destroy();await new Promise(r=>echo.close(r));});
 const c=await egress.start({deploymentId:id});c.healthy=true;f.agent.manager.apps.get(id).circuits.push(c);
 const port=Number(c.egress.split(':').at(-1));client=net.connect({host:'127.0.0.1',port});client.on('error',()=>{});await once(client,'connect');
 let reply=once(client,'data');client.write(Buffer.from([5,1,0]));assert.deepEqual((await reply)[0],Buffer.from([5,0]));
 reply=once(client,'data');client.write(Buffer.from([5,1,0,1,8,8,8,8,0,80]));assert.equal((await reply)[0][1],0);
 reply=once(client,'data');client.write('before-hold');assert.equal((await reply)[0].toString(),'before-hold');
 const closed=once(client,'close'),hold=f.writer.hold(id);await f.agent.admit();await closed;
 await new Promise(r=>setImmediate(r));await f.agent.snapshot();
 assert.equal(c.closed,true);assert.equal(egress.active.size,0);
 assert.equal(walletHoldAcknowledged({status:f.status(),runner,id,hold,now:f.now()}),true);
 assert.deepEqual(f.egress().apps,{});
 const refused=net.connect({host:'127.0.0.1',port});const [error]=await once(refused,'error');assert.equal(error.code,'ECONNREFUSED');
});
