// A circuit's app broker with its bytes off the agent's main thread.
//
// app-broker.mjs runs in the agent's one thread, so every byte a visitor exchanges with an app on this host waited
// whenever the agent computed: measured on the NucBox on 2026-11-15, the main thread ran flat out for 120-310 ms some
// fourteen times a minute (its refresh rounds), and a desktop stream through it stood still on every connection at
// once each time. Here the broker's listener and the splice to the partition manager live on a worker thread
// (ingress-thread.mjs); the main thread still decides every connection (authorize, then the forwarder's own `plan`: the
// verified route it would have opened itself) and only that question waits for it.
//
// Only a forwarder that can plan (ShieldIngress, and the native-desktop forwarder over it) is moved. Anything else, a
// connection the forwarder does not plan (plan answers null), a host without the thread's file, ENCLAVE_INGRESS_THREAD=0
// and a thread that does not start all leave the bytes where they were: on the main thread's broker, which is always
// made and is where the thread hands such connections. If the thread ends, every broker on it is lost: `onLost` lets
// the circuit close so that its manager builds it again (on a new thread).
import {Worker as IngressWorker} from 'node:worker_threads';
import ingressFs from 'node:fs';
import {fileURLToPath as ingressFileURL} from 'node:url';
import {createAppBroker} from './app-broker.mjs';

// beside this module, or beside the bundle this module is part of
export function ingressThreadFile(){
  try{const f=ingressFileURL(new URL('./ingress-thread.mjs',import.meta.url));return ingressFs.existsSync(f)?f:null;}catch{return null;}
}
let sharedIngressThread=null;
function ingressThread(file,log){
  if(sharedIngressThread&&!sharedIngressThread.dead&&sharedIngressThread.file===file)return sharedIngressThread;
  const worker=new IngressWorker(file,{workerData:{enclaveIngressThread:1}});
  const t={worker,file,dead:false,brokers:new Map(),next:1};
  const lost=why=>{if(t.dead)return;t.dead=true;log('ingress thread ended: '+why);const all=[...t.brokers.values()];t.brokers.clear();for(const b of all)b.lost(why);};
  worker.on('error',e=>lost(e.message));worker.on('exit',code=>lost('exit '+code));
  worker.on('message',m=>{if(m?.t==='log')return log(String(m.message).slice(0,300));t.brokers.get(m?.id)?.message(m);});
  worker.unref();   // (after the listeners: the thread never keeps the agent from ending)
  return sharedIngressThread=t;
}
export async function createIngressBroker({tcpPort,token,deploymentId,authorize,forward,log=()=>{},onLost=()=>{},file=ingressThreadFile(),env=process.env}){
  const main=await createAppBroker({tcpPort,token,deploymentId,authorize,forward,log});
  if(typeof forward?.plan!=='function'||!file||env.ENCLAVE_INGRESS_THREAD==='0'||!Number.isInteger(main.port))return main;
  let t,id,port;
  try{
    t=ingressThread(file,log);id=t.next++;
    port=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('it did not answer')),10000);
      t.brokers.set(id,{lost:why=>{clearTimeout(timer);reject(new Error(why));},message:m=>{clearTimeout(timer);if(m.t==='listening'&&Number.isInteger(m.port))resolve(m.port);else reject(new Error(m.message||'refused'));}});
      t.worker.postMessage({t:'create',id,token,legacyPort:main.port});
    });
  }catch(e){
    if(t){t.brokers.delete(id);if(!t.dead)t.worker.postMessage({t:'close',id});}
    log('ingress thread not used ('+e.message+'): this circuit\'s ingress stays on the main thread');return main;
  }
  let closed=false;
  const answer=async()=>{
    if(closed||!authorize(deploymentId))return {};
    const plan=await forward.plan(deploymentId);
    return plan?{plan}:{legacy:true};
  };
  t.brokers.set(id,{lost:why=>{if(!closed)onLost(why);},message:m=>{
    if(m.t!=='open')return;
    answer().catch(e=>{log('app broker: '+e.message);return {};}).then(a=>{if(!t.dead)t.worker.postMessage({t:'answer',req:m.req,...a});});
  }});
  return {port,
    revoke(){main.revoke();if(!t.dead)t.worker.postMessage({t:'revoke',id});},
    async close(){closed=true;t.brokers.delete(id);if(!t.dead)t.worker.postMessage({t:'close',id});await main.close();}};
}
