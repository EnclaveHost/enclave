// A narrowly scoped bridge for an installed agent bundle. Legacy probes and
// lease/admission readers remain in that bundle; native proofs use this release.
import {probeGuest} from './guest-probe.mjs';
export {startingShieldTransport} from './shield-starting-transport.mjs';

export function probeNativeGuest(options) {
  if(options?.expected?.requiresDesktop!==true)
    throw new Error('native probe requires an explicit desktop expectation');
  // Circuit ingress is shared on the provider's port 443. Keep SNI so it
  // reaches this guest; the locally attested key still authenticates the peer.
  return probeGuest({...options,...(options.pinnedSpkiSha256?{domainIndependent:false}:{}),
    startupRoute:!!options.pinnedSpkiSha256});
}

// The regular manager splice admits only ready partitions. Before readiness,
// forward encrypted TLS only for an explicitly enrolled native guest whose
// local proof and lease are still admitted. Recheck after opening the socket.
const canonical = value => JSON.stringify(value, function(key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])) : item;
});
export function nativeStartupForwarder({expected,proof,authorize,open,normal,now=Date.now}) {
  return async (socket,id)=>{
    let guest,timer,expiry,closed=false;
    const close=()=>{closed=true;clearInterval(timer);clearTimeout(expiry);socket.destroy();guest?.destroy();};
    try {
      const want=expected(id);
      if(want?.requiresDesktop!==true)return await normal(socket,id);
      const identity=canonical(want),pin=proof(id)?.spkiSha256;
      const appSha256=want.appSha256,runtimeId=want.runtimeId;
      const valid=()=>{
        const current=expected(id),p=proof(id);
        return authorize(id)&&canonical(current)===identity&&p?.verified===true&&p.deploymentId===id&&
          p.appSha256===appSha256&&p.runtimeId===runtimeId&&
          /^[0-9a-f]{64}$/.test(p.spkiSha256||'')&&p.spkiSha256===pin&&Number.isFinite(p.validUntil)&&p.validUntil>now()&&
          current.requiresConfigSocketServer===true&&current.requiresSecretsV1===true;
      };
      if(!valid())throw new Error('native ingress needs a current admitted proof');
      if(proof(id).ready!==false)return await normal(socket,id);
      socket.on('error',close);socket.once('close',close);
      guest=await open(id);
      if(closed||socket.destroyed||!valid()){close();return;}
      guest.on('error',close);guest.once('close',close);
      const check=()=>{try {if(!valid())close();}catch{close();}};
      timer=setInterval(check,500);timer.unref?.();
      // Never outlive the proof that admitted this stream, even if refreshed.
      expiry=setTimeout(close,Math.min(2147483647,Math.max(1,proof(id).validUntil-now())));expiry.unref?.();
      socket.pipe(guest).pipe(socket);socket.resume();
    } catch(error) {close();throw error;}
  };
}
