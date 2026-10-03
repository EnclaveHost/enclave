import net from 'node:net';

// Read-only transport for verifying a startup guest before it has outbound
// connectivity. No application request is sent through it. The TLS response is
// independently verified against the expected app and platform by guest-probe.
export function startingShieldTransport(base, expected, {fetchImpl=fetch, connect=net.connect}={}) {
 const u=new URL(base);
 if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('loopback Shield manager required');
 return async id=>{
  const want=expected(id);
  if(!/^0x[0-9a-f]{64}$/.test(id)||want?.requiresConfigSocketServer!==true||want?.requiresSecretsV1!==true)throw Error('configured secret command expectation required');
  const r=await fetchImpl(new URL('/vms',u),{signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error('Shield inventory unavailable');
  const body=await r.text();if(body.length>1048576)throw Error('Shield inventory too large');
  const v=JSON.parse(body).vms?.find(v=>v.name===id&&!v.recovered&&!v.launching&&['starting','running'].includes(v.status));
  if(!v||v.secretDeployment!==id||v.appId!==want.appSha256||v.runtimeId!==want.runtimeId||v.relay?.host!=='127.0.0.1'||!Number.isInteger(v.relay.port)||v.relay.port<1||v.relay.port>65535)throw Error('startup guest identity or loopback relay differs');
  return new Promise((resolve,reject)=>{
   const s=connect({host:'127.0.0.1',port:v.relay.port});
   const timer=setTimeout(()=>s.destroy(Error('startup guest connection timeout')),10000);
   s.once('connect',()=>{clearTimeout(timer);resolve(s);});s.once('error',e=>{clearTimeout(timer);reject(e);});
  });
 };
}
