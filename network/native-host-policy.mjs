// The platform host policy for the native client (network/native-client.mjs): the administrator's anchored, signed
// platform-wide host ban/admission, enforced with the SAME shared pieces the CLI uses - the activation rule
// (platform-host-policy-config.mjs resolveHostPolicyConfig), the runtime over the frozen core
// (host-policy-runtime.mjs createHostPolicyRuntime -> platform-host-policy.mjs) and the lease decision
// (host-policy-adapters.mjs leaseHostAdmission). Nothing here parses, verifies or judges a policy itself.
//
// Which policy applies is decided by the network the profile is pinned to, never by a profile field: a profile pinned
// to the production ledger or registry on Base is judged by the production authority (EnclaveAddressBook owner), as
// the CLI is. The operator's existing ENCLAVE_PLATFORM_HOST_POLICY configuration keeps its shared meaning (production,
// off, or an explicit test/private platform). Under enabled enforcement anything but an explicit admit refuses: an
// unreadable chain, a missing/forged/older policy, a torn anchor. While the admin has anchored no policy, activation
// "anchor" admits as today ("not-activated"); "required" refuses.
import fs from 'node:fs';
import path from 'node:path';
import {resolveHostPolicyConfig,PRODUCTION_BOOK} from './platform-host-policy-config.mjs';
import {createHostPolicyRuntime,fileStore} from './host-policy-runtime.mjs';
import {leaseHostAdmission} from './host-policy-adapters.mjs';
import {MAX_POLICY_RESPONSE} from './host-policy-mirrors.mjs';

const lc=s=>String(s||'').toLowerCase();
const PINS=JSON.parse(fs.readFileSync(new URL('../contracts/deployments/contract-pins-base.json',import.meta.url),'utf8')).contracts;

/** The production AddressBook when the profile is pinned to the Enclave platform network on Base, else null. */
export function platformBookFor(profile){
  const pins=profile?.authorityPins||{};
  return (profile?.chainId??8453)===8453&&(lc(pins.deployments)===lc(PINS.deployments)||lc(pins.registry)===lc(PINS.registry))?PRODUCTION_BOOK:null;
}

/**
 * A fetch for the shared mirror transport (host-policy-mirrors.mjs httpPolicyMirrors) that never buffers more than
 * maxBytes: a declared oversize length is refused unread, and a body is read incrementally and cancelled at the bound.
 * No credentials, no redirects. Anything refused here reaches the mirror as a non-OK status (no candidate).
 */
export function boundedPolicyFetch(fetchImpl=globalThis.fetch,maxBytes=MAX_POLICY_RESPONSE){
  return async(url,init={})=>{
    const r=await fetchImpl(url,{...init,redirect:'error',credentials:'omit'});
    const refuse=async status=>{try{await r.body?.cancel();}catch{}return new Response(null,{status});};
    if(!r.ok)return refuse(r.status);
    const declared=Number(r.headers.get('content-length'));
    if(Number.isFinite(declared)&&declared>maxBytes)return refuse(413);
    const chunks=[];let size=0;
    if(r.body){
      const reader=r.body.getReader();
      for(;;){
        const {done,value}=await reader.read();
        if(done)break;
        size+=value.byteLength;
        if(size>maxBytes){try{await reader.cancel();}catch{}return new Response(null,{status:413});}
        chunks.push(value);
      }
    }
    return new Response(Buffer.concat(chunks),{status:200,headers:{'content-type':'application/json'}});
  };
}

/**
 * -> {off:true, reason} when the shared resolution says the policy is off for this profile, else
 *    {off:false, source, activation, runtime, admission(lease) -> {admit, status, reason}}.
 * admission never throws: an unreadable policy is a refusal (status "unreadable"), exactly as the CLI treats it.
 */
export function nativeHostPolicy(profile,{env=process.env,fetch=globalThis.fetch,log=()=>{}}={}){
  const resolved=resolveHostPolicyConfig({env,chainId:profile?.chainId??8453,book:platformBookFor(profile)});
  if(!resolved.on)return {off:true,reason:resolved.reason};
  // The accepted policy is the loader's rollback floor across restarts; it is re-verified on load, never trusted.
  const store=typeof profile?.stateDir==='string'&&path.isAbsolute(profile.stateDir)?fileStore(path.join(profile.stateDir,'platform-host-policy',lc(resolved.config.book)+'.json')):null;
  const runtime=createHostPolicyRuntime(resolved,{fetch:boundedPolicyFetch(fetch),store,log});
  const decide=leaseHostAdmission(runtime.gate);
  return {off:false,source:resolved.source,activation:runtime.activation,runtime,
    admission:async lease=>{
      try{return await decide(lease);}
      catch(e){return {admit:false,status:'unreadable',reason:'platform host policy unreadable: '+String(e?.message).slice(0,200)};}
    }};
}
