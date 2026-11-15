import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createIngressBroker,ingressThreadFile} from '../network/ingress-thread-host.mjs';
import {spliceAppBroker} from '../network/broker-client.mjs';
import {ShieldIngress} from '../network/shield-ingress.mjs';
import {nativeStartupForwarder} from '../network/native-startup-overlay.mjs';

const ID='0x'+'ab'.repeat(32),ROUTE={id:'hv-1',appId:'11'.repeat(32),image:'22'.repeat(32),runtimeId:'33'.repeat(32),key:'44'.repeat(32)};
// the partition manager's data plane: admits one exact splice line, then echoes with a mark
async function dataPlane(mark='T'){
  const lines=[],server=net.createServer(s=>{let buf=Buffer.alloc(0),ok=false;s.on('error',()=>{});s.on('data',c=>{
    if(ok)return s.write(Buffer.concat([Buffer.from(mark),c]));
    buf=Buffer.concat([buf,c]);const nl=buf.indexOf(10);if(nl<0)return;lines.push(buf.subarray(0,nl).toString());ok=true;s.write('OK\n');
  });});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {addr:'127.0.0.1:'+server.address().port,lines,close:()=>new Promise(r=>{server.close(r);server.closeAllConnections?.();})};
}
// a visitor's connection as the circuit's worker hands it on: a socket pair whose far end is spliced to the broker
async function visitor(broker,token){
  const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const near=net.connect(server.address().port,'127.0.0.1');const [far]=await once(server,'connection');server.close();
  far.on('error',()=>{});near.on('error',()=>{});
  spliceAppBroker(far,{port:broker.port,token}).catch(()=>far.destroy());
  return near;
}
const reply=async s=>(await once(s,'data'))[0].toString();
const closed=s=>s.destroyed?Promise.resolve():once(s,'close');
const plannable=(plane,over={})=>Object.assign(async()=>{throw new Error('the main thread was asked to carry a planned connection');},{plan:async()=>({dataAddr:plane.addr,route:ROUTE}),...over});

test('the thread\'s file is found beside the module',()=>{assert.match(ingressThreadFile(),/ingress-thread\.mjs$/);});

test('a planned connection is spliced on the thread, to the planned route alone',async()=>{
  const plane=await dataPlane(),token=randomBytes(32).toString('hex');let allowed=true;const logs=[];
  const broker=await createIngressBroker({tcpPort:0,token,deploymentId:ID,authorize:id=>allowed&&id===ID,forward:plannable(plane),log:m=>logs.push(m)});
  try{
    const v=await visitor(broker,token);v.write('hello');assert.equal(await reply(v),'Thello');
    assert.deepEqual(plane.lines,[`ENCLAVE-SPLICE/1 id=${ROUTE.id} app=${ROUTE.appId} image=${ROUTE.image} runtime=${ROUTE.runtimeId} key=${ROUTE.key}`]);
    // a wrong token is refused before the main thread is asked
    const w=await visitor(broker,randomBytes(32).toString('hex'));await closed(w);assert.equal(plane.lines.length,1);
    // revoke closes what is open; an app no longer admitted gets nothing new
    broker.revoke();await closed(v);
    allowed=false;const x=await visitor(broker,token);await closed(x);assert.equal(plane.lines.length,1);
  }finally{await broker.close();await plane.close();}
  assert.deepEqual(logs,[]);
});

test('a connection the forwarder does not plan, or cannot, goes to the main thread\'s broker as it came',async()=>{
  const plane=await dataPlane(),token=randomBytes(32).toString('hex');let planned=null,carried=0;
  const forward=Object.assign(async(stream,id)=>{carried++;assert.equal(id,ID);stream.on('data',c=>stream.write(Buffer.concat([Buffer.from('M'),c])));stream.on('error',()=>{});},{plan:async()=>planned});
  const broker=await createIngressBroker({tcpPort:0,token,deploymentId:ID,authorize:()=>true,forward});
  try{
    const v=await visitor(broker,token);v.write('one');assert.equal(await reply(v),'Mone');assert.equal(carried,1);
    planned={dataAddr:plane.addr,route:ROUTE};
    const w=await visitor(broker,token);w.write('two');assert.equal(await reply(w),'Ttwo');assert.equal(carried,1);
    v.destroy();w.destroy();
  }finally{await broker.close();await plane.close();}
  // no plan function, or the switch off: the main thread's broker itself
  const off=await createIngressBroker({tcpPort:0,token,deploymentId:ID,authorize:()=>true,forward:plannable(plane),env:{ENCLAVE_INGRESS_THREAD:'0'}});
  const plain=await createIngressBroker({tcpPort:0,token,deploymentId:ID,authorize:()=>true,forward:async()=>{}});
  assert.equal(typeof off.port,'number');assert.equal(typeof plain.port,'number');await off.close();await plain.close();
});

test('a plan that fails refuses the connection and says why',async()=>{
  const token=randomBytes(32).toString('hex'),logs=[];
  const broker=await createIngressBroker({tcpPort:0,token,deploymentId:ID,authorize:()=>true,forward:Object.assign(async()=>{},{plan:async()=>{throw new Error('deployment has no unique running partition');}}),log:m=>logs.push(m)});
  try{const v=await visitor(broker,token);await closed(v);assert.deepEqual(logs,['app broker: deployment has no unique running partition']);}finally{await broker.close();}
});

test('bytes keep moving while the main thread computes',async()=>{
  // the data plane and the client are another process (this one's main thread is about to be busy): the client sends a
  // byte every 5 ms for 1.2 s and reports the longest wait between replies
  const token=randomBytes(32).toString('hex');let addr=null;
  const broker=await createIngressBroker({tcpPort:0,token,deploymentId:ID,authorize:()=>true,forward:Object.assign(async()=>{},{plan:async()=>({dataAddr:addr,route:ROUTE})})});
  const client=spawn(process.execPath,['--input-type=module','-e',`
    import {spliceAppBroker} from ${JSON.stringify(new URL('../network/broker-client.mjs',import.meta.url).href)};
    import net from 'node:net';import {once} from 'node:events';
    const plane=net.createServer(s=>{let ok=false;s.on('error',()=>{});s.on('data',c=>{if(ok)return s.write(c);if(c.includes(10)){ok=true;s.write('OK\\n');}});});
    plane.listen(0,'127.0.0.1');await once(plane,'listening');console.log('plane '+plane.address().port);
    const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
    const near=net.connect(server.address().port,'127.0.0.1');const [far]=await once(server,'connection');server.close();
    await new Promise(r=>setTimeout(r,200));
    await spliceAppBroker(far,{port:${broker.port},token:${JSON.stringify(token)}});
    let last=0,worst=0,n=0;near.on('data',()=>{const t=performance.now();if(last)worst=Math.max(worst,t-last);last=t;n++;});
    near.write('x');await once(near,'data');console.log('started');
    const timer=setInterval(()=>near.write('x'),5);setTimeout(()=>{clearInterval(timer);console.log(JSON.stringify({worst,n}));process.exit(0);},1200);
  `],{stdio:['ignore','pipe','inherit']});
  try{
    let out='';client.stdout.on('data',c=>out+=c);
    while(!/plane \d+\n/.test(out))await once(client.stdout,'data');
    addr='127.0.0.1:'+out.match(/plane (\d+)/)[1];
    while(!out.includes('started'))await once(client.stdout,'data');
    await new Promise(r=>setTimeout(r,200));
    const until=performance.now()+500;while(performance.now()<until);   // the main thread, busy for half a second
    await once(client,'exit');
    const {worst,n}=JSON.parse(out.split('\n').filter(Boolean).pop());
    assert.ok(n>50,`replies ${n}`);assert.ok(worst<200,`the longest wait between replies was ${worst.toFixed(0)} ms`);
  }finally{client.kill();await broker.close();}
});

test('ShieldIngress plans the route it would open; the native forwarder plans only what it would hand on',async()=>{
  const expected={appSha256:ROUTE.appId,runtimeId:ROUTE.runtimeId};
  const fetchFn=async url=>{const p=new URL(url).pathname;const body=p==='/vms'?{vms:[{name:ID,id:ROUTE.id,status:'running'}]}:{id:ROUTE.id,status:'running',tier:'T0-hv',appId:ROUTE.appId,image:ROUTE.image,runtimeId:ROUTE.runtimeId,transportKeySha256:ROUTE.key};return {status:200,text:async()=>JSON.stringify(body)};};
  const opened=[],shield=new ShieldIngress({url:'http://127.0.0.1:1/',dataAddr:'127.0.0.1:2',expected:id=>id===ID?expected:null,key:()=>ROUTE.key,fetchFn,open:async(a,r)=>{opened.push([a,r]);return new net.Socket();}});
  assert.deepEqual(await shield.forward.plan(ID),{dataAddr:'127.0.0.1:2',route:ROUTE});
  (await shield.open(ID)).destroy();assert.deepEqual(opened,[['127.0.0.1:2',ROUTE]]);
  await assert.rejects(shield.plan('0x'+'cd'.repeat(32)),/unknown deployment/);
  const want={...expected,requiresDesktop:true,requiresConfigSocketServer:true,requiresSecretsV1:true};
  const proof={verified:true,deploymentId:ID,appSha256:ROUTE.appId,runtimeId:ROUTE.runtimeId,spkiSha256:'55'.repeat(32),validUntil:Date.now()+60000,ready:true};
  let admitted=true;
  const native=nativeStartupForwarder({expected:id=>id===ID?want:{...expected},proof:()=>proof,authorize:()=>admitted,open:async()=>{throw new Error('not here');},normal:shield.forward});
  assert.deepEqual(await native.plan(ID),{dataAddr:'127.0.0.1:2',route:ROUTE});
  proof.ready=false;assert.equal(await native.plan(ID),null);proof.ready=true;
  admitted=false;await assert.rejects(native.plan(ID),/current admitted proof/);admitted=true;
  proof.validUntil=Date.now()-1;await assert.rejects(native.plan(ID),/current admitted proof/);
  assert.equal(await nativeStartupForwarder({expected:()=>want,proof:()=>({...proof,validUntil:Date.now()+60000}),authorize:()=>true,open:async()=>{},normal:async()=>{}}).plan(ID),null);
});

test('when the thread ends, its brokers say so',async()=>{
  const plane=await dataPlane(),token=randomBytes(32).toString('hex');let lost=null;
  const file=fileURLToPath(new URL('./fixtures/ingress-thread-exits.mjs',import.meta.url));
  const broker=await createIngressBroker({tcpPort:0,token,deploymentId:ID,authorize:()=>true,forward:plannable(plane),onLost:why=>{lost=why;},file});
  try{const v=await visitor(broker,token);await closed(v);for(let i=0;i<100&&lost===null;i++)await new Promise(r=>setTimeout(r,20));assert.match(String(lost),/exit 3/);}
  finally{await broker.close();await plane.close();}
});
