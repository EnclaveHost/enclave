// Real custodian challenge/release implementation with synthetic chain state and a disposable test encryption key.
// No live endpoint, wallet, attestation or canary secret is used.
import test from 'node:test';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {probeOldCommittee} from '../driver/probe-old-committee.mjs';import {probeNonce,custodyPost,challenge} from '../driver/probe.mjs';
import {OLD_COMMITTEE_4774,OLD_CUSTODIAN_ENDPOINT,PROTECTED_POLICY_4E62,AGENT_EOA_29479,METAL0_ENDPOINT,ORIGINAL_VAULT_V2} from '../driver/plan.mjs';
const {createCustodianV2}=await import(pathToFileURL('/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/repo-r2/custody/v2/custodian.mjs').href);
const C3='0x'+'c3'.repeat(32),NEW='0x'+'12'.repeat(32);
const response=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
function fixture(){let clock=1000000;const calls=[];const state={blockNumber:20n,blockHash:'0x'+'ab'.repeat(32),blockTimestamp:1000,beneficialOwner:AGENT_EOA_29479,
 policy:{owner:AGENT_EOA_29479,policyRev:2n,secretRev:2n,committeeId:NEW,paused:false},bundle:{committeeId:NEW,secretRev:2n,data:Buffer.from([1])},committee:{epoch:1,machines:[]}};
 const reader={readRelease:async({id,endpoint})=>{assert.equal(id,C3);assert.equal(endpoint,METAL0_ENDPOINT);return structuredClone(state);},readCommittee:async({committeeId})=>{assert.equal(committeeId,OLD_COMMITTEE_4774);return {committee:{epoch:1,Y:new Uint8Array([2,3]),commitments:new Uint8Array([4,5]),machines:[{encKey:'0x'+member.encKeyHex}]}};}};
 let shareReads=0;const member=createCustodianV2({chainId:8453,vault:ORIGINAL_VAULT_V2,encPrivateKey:new Uint8Array(32).fill(7),shares:{get:()=>{shareReads++;return null;}},chain:reader,verifiers:{},now:()=>clock,log:()=>{}});
 state.committee.machines=[{encKey:'0x'+member.encKeyHex}];
 const fetchImpl=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});assert.equal(options.redirect,'error');assert.ok(options.signal);if(url===OLD_CUSTODIAN_ENDPOINT+'/v2/custody/challenge')return response(200,member.challenge());assert.equal(url,OLD_CUSTODIAN_ENDPOINT+'/v2/custody/release');try{return response(200,await member.release(JSON.parse(options.body)));}catch(e){return response(e.status||500,{error:e.code,message:e.message});}};
 const f={id:C3,newCommittee:NEW,reader,fetchImpl,now:()=>clock,calls,state,member};f.tick=n=>clock+=n;f.shareReads=()=>shareReads;f.run=()=>probeOldCommittee(f);return f;
}
test('old-committee probe sends C3 with old committee and current revisions to actual custodian, receiving wrong_committee before share access',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.outcome,'pass');assert.equal(r.evidence.id,C3);assert.equal(f.calls.length,2);assert.equal(f.calls[1].body.committeeId,OLD_COMMITTEE_4774);assert.equal(f.calls[1].body.policyRev,'2');assert.equal(f.calls[1].body.secretRev,'2');assert.equal(f.shareReads(),0);assert.match(r.evidence.scope,/does not prove a fully authorized recipient rejection/);assert.ok(!JSON.stringify(r).includes('nonce'));
});
test('real unprefixed custodian challenges work for nonce replay and expiry probing',async()=>{
 const f=fixture(),cur={id:C3,endpoint:METAL0_ENDPOINT,committeeId:NEW,epoch:1,policyRev:2n,secretRev:2n};
 const r=await probeNonce({base:OLD_CUSTODIAN_ENDPOINT,cur,fetchImpl:f.fetchImpl,sleep:async ms=>f.tick(ms),nowSec:()=>f.now()/1000});assert.equal(r.outcome,'pass');assert.equal(r.evidence.replay.code,'bad_challenge');assert.equal(r.evidence.expired.code,'bad_challenge');
});
test('protected id, wrong owner, unmigrated policy, stale state and wrong old key all refuse',async()=>{
 for(const change of [f=>f.id=PROTECTED_POLICY_4E62,f=>f.newCommittee=OLD_COMMITTEE_4774,f=>f.state.policy.owner='0x'+'ee'.repeat(20),f=>f.state.policy.committeeId=OLD_COMMITTEE_4774,f=>f.state.policy.policyRev=1n,f=>f.state.blockTimestamp=1,f=>{f.reader.readCommittee=async()=>({committee:{epoch:1,machines:[{encKey:'0x'+'ee'.repeat(32)}]}});}]){const f=fixture();change(f);await assert.rejects(f.run,/probe refused/);assert.ok(f.calls.length<=1);}
});
test('wrong response code, successful response and extra/nested plaintext never count or escape the result',async()=>{
 for(const [status,body] of [[403,{error:'bad_challenge'}],[200,{partial:'private peer bytes'}],[409,{error:'wrong_committee',partial:'private peer bytes'}],[409,{error:'wrong_committee',message:{env:'private peer bytes'}}],[409,{error:'private peer bytes'}]]){
  const f=fixture(),original=f.fetchImpl;f.fetchImpl=async(u,o)=>u.endsWith('/release')?response(status,body):original(u,o);await assert.rejects(f.run,e=>e.message.includes('probe refused')&&!e.message.includes('private peer bytes'));
 }
});
test('migration changes and expired collection refuse after the HTTP reply',async()=>{
 for(const change of [f=>f.state.bundle.data=Buffer.from([2]),f=>f.state.policy.secretRev=3n,f=>f.tick(120001)]){const f=fixture(),original=f.fetchImpl;f.fetchImpl=async(u,o)=>{const r=await original(u,o);if(u.endsWith('/release'))change(f);return r;};await assert.rejects(f.run,/probe refused/);}
});
test('bounded JSON reader rejects oversize, redirects, malformed data and absent protocol fields without peer text',async()=>{
 for(const r of [new Response('secret peer text',{headers:{'content-type':'application/json'}}),response(200,{error:'x'.repeat(5000)}),new Response('{}',{headers:{'content-type':'application/json','content-length':'5000'}}),new Response('{}',{headers:{'content-type':'text/plain'}})])await assert.rejects(custodyPost(async()=>r,OLD_CUSTODIAN_ENDPOINT,'/v2/custody/challenge',{}),e=>e.message==='custodian probe response unavailable or malformed');
 const f=fixture();await assert.rejects(challenge(async()=>response(200,{encKey:f.member.encKeyHex,nonce:'bad',expiresAt:1001}),OLD_CUSTODIAN_ENDPOINT),/shape/);
});
