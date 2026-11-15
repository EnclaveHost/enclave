// How far each ingress provider is from this host: the time one TCP handshake with its public web port takes
// (docs/design/enclave-network.md, "Near routes"). On a host whose operator turned enclaveNetwork.nearRoutes on, the
// manager puts the nearest provider in front of the host as the guard and the next nearest behind it as the exit.
//
// The handshake is all there is: no TLS, no name, no request - what a visitor's or a scanner's connection to that port
// begins with. It is still a connection from this host's own address to a provider that may not be its guard, which
// nothing else in the agent makes: that is why it is off unless the operator asks, and why a provider is measured once
// per agent run, not on a timer.
import net from 'node:net';
const PORT=443,SAMPLES=3,TIMEOUT_MS=2000,RETRY_MS=10*60000,PARALLEL=8;

// -> milliseconds until the connection is established, or null (refused, unreachable, no answer in time)
export function handshakeMs(address,{port=PORT,timeoutMs=TIMEOUT_MS}={}){
 return new Promise(resolve=>{
  const t0=performance.now(),s=net.connect({host:address,port});let done=false;
  const end=v=>{if(done)return;done=true;s.destroy();resolve(v);};
  s.setTimeout(timeoutMs,()=>end(null));s.once('connect',()=>end(performance.now()-t0));s.once('error',()=>end(null));
 });
}

// -> async providers => Map(providerId -> ms). A provider is in the map only while a measurement of its current address
// exists: the shortest of `samples` handshakes (the path's delay, not a queue's). One that did not answer is asked again
// after retryMs; one whose address changed, at once. Only address literals are measured (no name is ever resolved here),
// and only providers that offer ingress: the web port is theirs to serve.
export function createProviderDistance({measure=handshakeMs,now=Date.now,samples=SAMPLES,retryMs=RETRY_MS,log=()=>{}}={}){
 const known=new Map();   // providerId -> {address, ms (null: no answer), at}
 const one=async p=>{
  let ms=null;
  for(let i=0;i<samples;i++){const v=await measure(p.address);if(v===null){if(ms===null)break;continue;}ms=ms===null?v:Math.min(ms,v);}
  known.set(p.providerId,{address:p.address,ms:ms===null?null:Math.round(ms*10)/10,at:now()});
 };
 return async providers=>{
  const due=providers.filter(p=>net.isIP(p.address)&&p.eligibleRoles?.includes('ingress')).filter(p=>{
   const k=known.get(p.providerId);return !k||k.address!==p.address||(k.ms===null&&now()-k.at>=retryMs);});
  for(let i=0;i<due.length;i+=PARALLEL)await Promise.all(due.slice(i,i+PARALLEL).map(one));
  const out=new Map(providers.flatMap(p=>{const k=known.get(p.providerId);return k&&k.address===p.address&&k.ms!==null?[[p.providerId,k.ms]]:[];}));
  if(due.length)log(`near routes: measured ${due.length} provider(s): `+due.map(p=>`${p.region||p.providerId.slice(0,8)} ${out.has(p.providerId)?out.get(p.providerId)+' ms':'no answer'}`).join(', '));
  return out;
 };
}
