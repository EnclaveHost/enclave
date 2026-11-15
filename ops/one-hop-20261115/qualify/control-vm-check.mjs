// One hop, the control VM's three files: runs the installed and the patched code on one owner policy with a guard and
// one without. Nothing is contacted; run it without a network (unshare -r -n).
//
//   node control-vm-check.mjs <work dir holding installed/ and payload/>
//
// relay   createNetworkApi from the bundle the relay imports: an owner's POST of the policy, and what it answers after
// bridge  publicPolicies: what one round would copy to the public directories
// pull    mirrorRoutePass: which public route publications it would hand to the relay
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {signNetworkPolicy} from '../../../network/network-policy.mjs';
import {JsonStore} from '../../../relay/store.js';
const WO=process.argv[2];if(!WO){console.error('usage: control-vm-check.mjs <work dir>');process.exit(2);}
const owner=privateKeyToAccount(generatePrivateKey());
const idA='0x'+'a1'.repeat(32),idB='0x'+'b2'.repeat(32);
const policy=(id,guard,nonce=1)=>({version:5,deploymentId:id,nonce,issuedAt:Date.now(),mode:'enclave-network',fallback:'none',enclaveNetwork:{routes:1,guard,maxPricePerGiB6:0,budget6:0}});
const a=await signNetworkPolicy(owner,policy(idA,true)),b=await signNetworkPolicy(owner,policy(idB,false));
let bad=0;const say=(ok,t)=>{if(!ok)bad++;console.log((ok?'ok   ':'NOT  ')+t);};

for(const [label,file,accepts] of [['installed relay',WO+'/installed/relay-network-runtime-55544ec1.mjs',false],['patched relay',WO+'/payload/3bbc6bf0/network-runtime.bundle.mjs',true]]){
  const {createNetworkApi}=await import(file);
  const store=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'one-hop-relay-')),'network.json');
  const api=createNetworkApi({checkers:[],file:store,JsonStore,secretsKey:'aa'.repeat(32),clients:async()=>[]});
  const rows=[idA,idB].map(id=>({id,owner:owner.address,runner:'0x'+'11'.repeat(32),runnerOperator:owner.address,leaseUntil:Math.floor(Date.now()/1000)+3600,isPublic:true}));
  const ctx={json:(res,status,body)=>{res.status=status;res.body=body;},readBody:async req=>Buffer.from(JSON.stringify(req.body||{})),ledgerRows:async()=>rows};
  const call=async(method,p,body)=>{const res={};await api.handle({method,body},res,new URL('http://x'+p),ctx);return res;};
  const first=await call('GET','/v1/network/policy/'+idB);
  say(first.body?.policy?.enclaveNetwork?.guard===true,`${label}: before any owner setting the app's policy has a guard`);
  say((await call('POST','/v1/network/policy/'+idA,{envelope:a})).status===200,`${label}: an owner's policy with a guard is stored`);
  const r=await call('POST','/v1/network/policy/'+idB,{envelope:b});
  if(accepts){
    say(r.status===200,`${label}: an owner's policy without a guard is stored (${r.status})`);
    const got=await call('GET','/v1/network/policy/'+idB),st=await call('GET','/v1/network/status/'+idB);
    say(got.body?.policy?.enclaveNetwork?.guard===false&&got.body?.envelope?.signature===b.signature&&got.body?.envelope?.policy?.enclaveNetwork?.guard===false,`${label}: it is served back as signed`);
    say(st.body?.policy?.enclaveNetwork?.guard===false&&st.body?.policySet===true,`${label}: the Network tab's status shows it`);
    const forged=await signNetworkPolicy(privateKeyToAccount(generatePrivateKey()),policy(idA,false,2));
    say((await call('POST','/v1/network/policy/'+idA,{envelope:forged})).status!==200,`${label}: the same policy signed by someone else is refused`);
    const odd={...policy(idA,false,2)};odd.enclaveNetwork={...odd.enclaveNetwork,guard:'no'};
    let s=null;try{s=(await call('POST','/v1/network/policy/'+idA,{envelope:{policy:odd,signature:a.signature}})).status;}catch(e){s=e.message;}
    say(s!==200,`${label}: a guard that is neither true nor false is refused (${s})`);
    api.noteStatus(idB,{oneHop:true,modes:['enclave-network']});
    say((await call('GET','/v1/network/status/'+idB)).body?.host?.oneHop===true,`${label}: a host's report that it allows one hop reaches the Network tab`);
  }else{
    say(r.status!==200,`${label}: an owner's policy without a guard is refused (${r.status}: ${r.body?.error})`);
    say((await call('GET','/v1/network/policy/'+idB)).body?.policy?.enclaveNetwork?.guard===true,`${label}: the app keeps its guard`);
  }
}

const state={policies:{[idA]:a,[idB]:b}};
for(const [label,file,passes] of [['installed bridge',WO+'/installed/bridge-mirror-a219f492.mjs',false],['patched bridge',WO+'/payload/3c778817/mirror.mjs',true]]){
  const m=await import(file);
  let out=null,err=null;try{out=m.publicPolicies(state);}catch(e){err=e.message;}
  if(passes)say(out?.length===2&&out[0].policy.enclaveNetwork.guard===true&&out[1].policy.enclaveNetwork.guard===false&&out[1].signature===b.signature,`${label}: both policies are copied, each as signed`);
  else say(!out&&!!err,`${label}: one stored policy without a guard stops the whole round, every owner's policies with it (${err})`);
  let only=null;try{only=m.publicPolicies({policies:{[idA]:a}});}catch(e){only=e.message;}
  say(Array.isArray(only)&&only.length===1,`${label}: a policy with a guard is copied`);
  let wrong=null;try{m.publicPolicies({policies:{[idA]:{...a,policy:{...a.policy,enclaveNetwork:{...a.policy.enclaveNetwork,guard:'no'}}}}});}catch(e){wrong=e.message;}
  say(!!wrong,`${label}: a guard that is neither true nor false is refused`);
}

const pub=(env,id)=>({version:2,endpoint:'x',policy:env.policy,status:{note:'not public'},bundle:{authorization:{delegation:{version:1,deploymentId:id},signature:'0x00'},
  record:{version:1,deploymentId:id,expiresAt:Date.now()+60000,routes:[]},signature:'0x00'}});
for(const [label,file,want] of [['installed route pull',WO+'/installed/route-pull-mirror-934b511e.mjs',[1,1]],['patched route pull',WO+'/payload/69b16600/mirror-public-providers.mjs',[2,0]]]){
  const m=await import(file);const posted=[];
  const r=await m.mirrorRoutePass({sources:{read:async()=>[{value:{publications:[pub(a,idA),pub(b,idB)]}}]},destination:'http://127.0.0.1:9',
    fetch:async(u,o)=>{posted.push(JSON.parse(o.body));return new Response('{"ok":true}',{status:200,headers:{'content-type':'application/json'}});}});
  say(r.accepted===want[0]&&r.rejected===want[1],`${label}: of two route publications (an app with a guard, an app without) ${r.accepted} handed on, ${r.rejected} dropped`);
  say(posted.every(p=>p.publication.status===undefined),`${label}: no host status handed on`);
}
console.log(bad?`FAILED: ${bad}`:'all as expected');process.exit(bad?1:0);
