// TEST ONLY: public fixture signer, owned Anvil and exclusive IndexedDB. No production wallet or endpoints.
import * as F from '/sdk.mjs';
const log = document.querySelector('#log');
const note = s => { log.textContent += s + '\n'; };
const ok = (v,s) => { if (!v) throw Error(s); note('PASS '+s); };
const rpc = F.jsonRpc(location.origin+'/rpc');
const relay = F.relayClient(location.origin);
const db = 'TEST-expired-unused-20261029-root-r1';
const store = new F.IndexedDbV2Store(db);
const call = async (p,b) => {
  const r = await fetch(p,b===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
  const j=await r.json(); if(!r.ok)throw Error(j.error);return j;
};
const now = async () => BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp);
const tick = () => call('/test/fixture/tick',{});
const state = () => call('/test/fixture/status');
const balance = async sid => BigInt((await call('/test/fixture/gas-session/'+sid)).balance6);
const verify = async fx => F.verifyRuntime({pins:fx.pins,rpc,relay,owner:fx.owner,now:await now()});
const quote = async (fx,runtime,record) => {
  const deps=fx.deployments.filter(d=>fx.partition.nucbox.includes(d.app)).map(d=>d.id);
  const scope=await F.freshRecoveryScope({rpc,book:fx.book,owner:fx.owner,legacyVault:fx.legacyVault,deploymentIds:deps,now:await now()});
  return F.quoteGasFund({runtime,record,relay,scope,deployment:deps[0],ethOut:BigInt(fx.ethOut),feeTier:fx.feeTier,now:await now(),journalEntries:await store.listJournal()});
};
const run = fn => async () => { try { await fn(); } catch(e) { note('FAIL '+e.stack); log.dataset.result='FAIL'; } };
document.querySelector('#start').onclick=run(async()=>{
  ok((await store.listKeys()).length===0,'exclusive TEST DB initially empty');
  const fx=await call('/test/fixture/config');await tick();const runtime=await verify(fx);
  const provider={async request({method,params}){ok(method==='eth_signTypedData_v4','public fixture typed request');return(await call('/test/owner-sign',{address:params[0],payload:params[1]})).sig;}};
  const t=await now();
  const p=await F.prepareGasOpen({runtime,store,relayBase:location.origin,appIds:fx.partition.nucbox,legacyExpiresAt:t+604800n,expiresAt:t+604800n,now:t,label:'TEST expiry recovery',part:{budget6:800000n,opsPerPeriod:16n}});
  const body=await F.signGasOpen({runtime,provider,rpc,review:p.review,approval:{rootReviewed:true,digest:p.review.digest},now:await now()});
  const opened=await F.submitGasOpen({runtime,store,relay,rpc,record:p.record,review:p.review,body,now:await now()});ok(!opened.pending,'native P256 grant opened');
  const record=await store.loadKey(p.record.id);ok(record.privateKey.extractable===false,'nonextractable browser key');
  const review=await quote(fx,runtime,record);const before=await balance(record.sid);const s0=await state();
  const preSend503=async(method,path,b)=>{if(method==='POST'&&path==='/funding/execute')throw new F.RelayError('quote_policy_failed','TEST pre-send gas cap refusal',503);return relay(method,path,b);};
  try{await F.confirmGasFund({runtime,store,record,review,relay:preSend503,relayBase:location.origin,rpc,now:await now()});throw Error('expected refusal');}catch(e){ok(e.code==='quote_policy_failed','pre-send failure observed');}
  const j=await store.listJournal();const entry=j.find(e=>e.kind==='gas-execute');ok(entry?.status==='unknown','UNKNOWN durable entry');
  ok(await balance(record.sid)===before,'no debit before expiry');
  ok((await state()).hits['POST /v1/sessions/funding/execute']===s0.hits['POST /v1/sessions/funding/execute'],'no actual execute POST');
  log.dataset.result='READY_RELOAD';note('READY: reload this TEST page, then Recover.');
});
document.querySelector('#recover').onclick=run(async()=>{
  const fx=await call('/test/fixture/config');const keys=await store.listKeys();ok(keys.length===1,'key survived reload');
  const record=keys[0];ok(record.privateKey.extractable===false,'reloaded key remains nonextractable');
  const old=(await store.listJournal()).find(e=>e.kind==='gas-execute');ok(old?.status==='unknown','UNKNOWN survived reload');
  const before=await balance(record.sid),s0=await state();
  await call('/test/fixture/expire-owned-call',{});await tick();const runtime=await verify(fx);
  const rec=await F.reconcileGasExecution({runtime,store,rpc,relay,relayBase:location.origin,id:old.id});
  ok(rec.status==='expired_unused','native finalized expired-unused proof');
  ok(await balance(record.sid)===before,'expiry reconciliation did not debit');
  const s1=await state();ok(s1.prompts.length===s0.prompts.length,'no owner signature on reconciliation');
  ok(s1.hits['POST /v1/sessions/funding/execute']===s0.hits['POST /v1/sessions/funding/execute'],'reconciliation never resends');
  const review=await quote(fx,runtime,record);ok(String(review.call.execute.nonce)===old.nonce,'same unused nonce');ok(review.call.digest!==old.call.digest,'fresh signed digest');
  const args={runtime,store,record,review,relay,relayBase:location.origin,rpc,now:await now()};
  const race=await Promise.allSettled([F.confirmGasFund(args),F.confirmGasFund(args)]);
  ok(race.filter(r=>r.status==='fulfilled').length===1,'IndexedDB CAS admits only one fresh payment');
  for(let i=0;i<6;i++){await tick();const r=await F.reconcileGasExecution({runtime,store,rpc,relay,relayBase:location.origin,id:old.id});if(r.status==='settled')break;}
  const final=await store.getJournal(old.id);ok(final.status==='settled','fresh payment settled on native chain');
  ok(final.predecessors.length===1&&final.predecessors[0].intentHash===old.intentHash,'complete original public intent preserved');
  const debit=BigInt(final.evidence.actual.totalDebit6);ok(before-await balance(record.sid)===debit&&debit>0n,'exactly one mock debit');
  const s2=await state();ok((s2.hits['POST /v1/sessions/funding/execute']??0)-(s0.hits['POST /v1/sessions/funding/execute']??0)===1,'one HTTP execute despite concurrent clicks');
  ok(s2.prompts.length===s0.prompts.length,'no further owner prompts');
  log.dataset.result='PASS';note('ALL TEST PHASES PASS');
});
note('TEST ready. Explicit buttons only.');
