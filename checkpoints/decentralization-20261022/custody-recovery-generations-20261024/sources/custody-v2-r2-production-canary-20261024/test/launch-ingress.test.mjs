import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {inspectIngress,rawTlsRefusal,checkPublicRefusals,REFUSAL_PROBES,tunnelArgs,readControlIngress,controlSshArgs} from '../driver/launch-ingress.mjs';
function fixture(){
 const pins={runLabel:'20261024T030000Z'},c={endpoint:'https://canary.example',node:'/fixture/node',ssh:'/usr/bin/ssh',sourceFile:'/fixture/forwarder.mjs',configFile:'/fixture/config.json',reverseForward:'127.0.0.1:18972:127.0.0.1:18973',tunnelPort:18972,forwarder:{listen:{host:'127.0.0.1',port:18973}}};
 const units={},procs={},cgroups={},args={};let clock=1000000;
 for(const [kind,pid,exe,a,cap] of [['ingress',101,c.node,[c.sourceFile,c.configFile],256],['tunnel',102,c.ssh,tunnelArgs(c.reverseForward),128]]){
  const name=`enclave-custody-r2-${kind}-${pins.runLabel}.service`,group='/user.slice/test/'+name;
  units[name]={LoadState:'loaded',ActiveState:'active',SubState:'running',MainPID:String(pid),InvocationID:String(pid%10).repeat(32),ControlGroup:group,MemoryMax:String(cap*1024*1024),MemorySwapMax:'0',KillMode:'control-group',Restart:'no'};
  procs[pid]={pid,ppid:1,startTicks:'10',exe,cgroup:'0::'+group,uid:process.getuid(),argsHash:'f'.repeat(64)};args[pid]=[exe,...a];
  cgroups[group]={memoryMax:String(cap*1024*1024),swapMax:'0',pids:[pid],events:{oom:'0',oom_kill:'0'}};
 }
 const listeners=[{kind:'tcp',port:18973,addr:'0100007F',inode:'123'}];
 const f={pins,c,units,procs,cgroups,args,listeners,io:{now:()=>clock,unit:n=>structuredClone(units[n]),process:p=>structuredClone(procs[p]),args:p=>args[p],env:()=>['PATH=/usr/bin:/bin'],cgroup:g=>structuredClone(cgroups[g]),listeners:()=>structuredClone(listeners),sockets:()=>new Set(['123'])},compile:async()=>c,remote:async()=>({routeSha256:'a'.repeat(64)}),probe:async(_e,method,target)=>({method,target,status:404})};
 f.tick=n=>{clock+=n;};f.run=()=>inspectIngress(f);return f;
}
test('ingress evidence collects exact processes and all refusal routes, rechecking after probes',async()=>{
 const f=fixture();let reads=0;f.remote=async()=>{reads++;return {routeSha256:'a'.repeat(64)};};
 const r=await f.run();assert.equal(reads,2);assert.equal(r.refusals.length,REFUSAL_PROBES.length);assert.match(r.bindingDigest,/^[a-f0-9]{64}$/);assert.match(r.scope,/centralized availability dependency remains/);
});
test('wrong unit, kernel limits, inherited environment, sockets and process args all refuse',async()=>{
 const changes=[f=>{Object.values(f.units)[0].Restart='always';},f=>{Object.values(f.units)[0].KillMode='process';},f=>{Object.values(f.cgroups)[0].memoryMax='max';},f=>{Object.values(f.cgroups)[0].events.oom='1';},f=>{Object.values(f.cgroups)[0].pids.push(999);},f=>{f.io.env=()=>['PATH=/usr/bin:/bin','UNEXPECTED=value'];},f=>{f.listeners[0].addr='00000000';},f=>{f.listeners.push({...f.listeners[0]});},f=>{f.io.sockets=()=>new Set();},f=>{f.args[102].push('-o','StrictHostKeyChecking=no');},f=>{f.procs[101].uid=process.getuid()+1;}];
 for(const change of changes){const f=fixture();change(f);await assert.rejects(f.run,/ingress refused/);}
});
test('changes during collection and stale collection refuse',async()=>{
 const changes=[f=>{f.procs[101].startTicks='11';},f=>{Object.values(f.units)[0].InvocationID='b'.repeat(32);},f=>{Object.values(f.cgroups)[0].swapMax='100';},f=>{f.listeners[0].inode='124';},f=>{f.tick(120001);}];
 for(const change of changes){const f=fixture();let done=false;f.probe=async(_e,method,target)=>{if(!done){done=true;change(f);}return {method,target,status:404};};await assert.rejects(f.run,/ingress refused/);}
 const f=fixture();let n=0;f.remote=async()=>({routeSha256:(++n===1?'a':'b').repeat(64)});await assert.rejects(f.run,/route changed/);
});
test('every forbidden target must return exact 404 with exact method and unnormalized target',async()=>{
 for(const bad of [200,400,401,403,500,502])await assert.rejects(checkPublicRefusals('https://canary.example',async(_e,method,target)=>({method,target,status:bad})),/did not return404/);
 await assert.rejects(checkPublicRefusals('https://canary.example',async(_e,method,target)=>({method:'POST',target:target.toLowerCase(),status:404})),/did not return404/);
});
test('raw TLS probes preserve dot/percent targets, enforce certificate validation and discard bodies',async()=>{
 for(const [method,target] of REFUSAL_PROBES){let options,destroyed=0,body;
  const request=(o,cb)=>{options=o;const q=new EventEmitter();q.destroy=()=>{destroyed++;};q.end=b=>{body=b;cb({statusCode:404,destroy:()=>{destroyed++;}});};return q;};
  const r=await rawTlsRefusal('https://canary.example',method,target,{request});assert.equal(r.target,target);assert.equal(options.path,target);assert.equal(options.rejectUnauthorized,true);assert.equal(options.servername,'canary.example');assert.equal(body,method==='GET'?undefined:'{}');assert.equal(destroyed,2);
 }
 await assert.rejects(rawTlsRefusal('https://canary.example','GET','/',{request:()=>{throw Error('private implementation detail');}}),e=>!e.message.includes('private implementation'));
 const immediate=(_o,cb)=>{cb({statusCode:404,destroy(){}});return {destroy(){}};};assert.equal((await rawTlsRefusal('https://canary.example','GET','/',{request:immediate})).status,404);
});
test('SSH route proof requires exact endpoint, host-key checking, fresh time and positive listener inspection',()=>{
 const c=fixture().c;const good={ok:true,hostname:'canary.example',tunnelPort:18972,loopbackListener:true,routeSha256:'a'.repeat(64),at:1000000};
 const exec=(bin,args,opts)=>{assert.equal(bin,'/usr/bin/ssh');assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('python3 -'));assert.ok(opts.input.includes('validate_live'));return JSON.stringify(good);};
 assert.equal(readControlIngress(c,{exec,now:()=>1000000}).ok,true);
 for(const changed of [{ok:false},{at:969999},{at:1005001},{hostname:'api.enclave.host'},{tunnelPort:80},{loopbackListener:false},{routeSha256:'bad'}])assert.throws(()=>readControlIngress(c,{exec:()=>JSON.stringify({...good,...changed}),now:()=>1000000}),/expired|differs/);
 assert.ok(controlSshArgs().includes('/dev/null'));
});
