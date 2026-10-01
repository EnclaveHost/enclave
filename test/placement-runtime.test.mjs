import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pinnedHost,withPlacementPin} from '../site/js/core/placement-options.js';
const HOST='0x'+'aa'.repeat(32),OTHER='0x'+'bb'.repeat(32);
const source=readFileSync(process.env.SUPERVISOR_PIN_SOURCE || new URL('../supervisor.js',import.meta.url),'utf8');
const method=name=>source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))[0];
test('strict pin edits preserve unrelated settings and Auto or fallback removes only the restriction',()=>{
 const before={configCid:'bafyexample',config:{volumes:['model']},isolation:{cpuTee:false,gpuTee:false},waf:{rps:10}};
 const pin=withPlacementPin(JSON.stringify(before),HOST,false);
 assert.equal(pinnedHost(pin),HOST);
 for(const [host,fallback] of [[HOST,true],['',true],['',false]])
  assert.deepEqual(JSON.parse(withPlacementPin(pin,host,fallback)),before);
 assert.throws(()=>withPlacementPin(pin,OTHER,false,10),/byte limit/);
});
test('Linux renewal reads the current pin and stops before releasing; stop failure never releases or renews',async()=>{
 for(const failStop of [false,true]) {
  const calls=[],rec={id:'app',_onchain:true,status:'running',_leaseUntil:Date.now()/1000+10,_gpu:{}};
  const f=new Function('pinnedHost','calls','rec','failStop',`
   const _enclaveId='${OTHER}',_reach={tripped:false},RENEW_MARGIN_SEC=60;
   const deployments=new Map([['app',rec]]);
   const readLedgerContract=async()=>({configCid:JSON.stringify({placement:{hostId:'${HOST}'}})});
   const stopContainer=async()=>{calls.push('stop');if(failStop)throw Error('stop failed')};
   const proveAndRelease=async()=>calls.push('release');
   const releaseGpu=()=>calls.push('free'),saveStateSoon=()=>{};
   const sendClaimTx=()=>{calls.push('transaction');throw Error('unexpected renewal')};
   const console={log(){},warn(){}};
   ${method('placementRefusal')}
   ${method('retireForPlacement')}
   ${method('renewLeases')}
   return renewLeases();
  `);
  await f(pinnedHost,calls,rec,failStop);
  assert.deepEqual(calls,failStop?['stop']:['stop','release','free']);
  assert.equal(rec.status,failStop?'running':'terminated');
 }
});
test('Linux ledger audit honors a changed pin even outside the renewal window',async()=>{
 const calls=[],rec={id:'app',_onchain:true,status:'running'};
 const f=new Function('pinnedHost','calls','rec',`
  const _enclaveId='${OTHER}',deployments=new Map([['app',rec]]),tenantProvisions=new Set();
  const claimSigner=()=>({account:{address:'operator'}});
  const retireForPlacement=async()=>calls.push('retire');
  ${method('placementRefusal')}
  ${method('auditClaims')}
  return auditClaims(new Map([['app',{configCid:JSON.stringify({placement:{hostId:'${HOST}'}})}]]));
 `);
 await f(pinnedHost,calls,rec);assert.deepEqual(calls,['retire']);
});

test('Linux accepts and validates the placement namespace before admission',()=>{
 const parse=new Function('pinnedHost',`const DEP_OPTIONS_MAX_BYTES=4096,ISOLATION_BACKEND=''; ${method('parseDepOptions')};return parseDepOptions;`)(pinnedHost);
 assert.equal(parse(JSON.stringify({placement:{hostId:HOST}})).pinnedHost,HOST);
 assert.throws(()=>parse('{"placement":{"hostId":"wrong"}}'),/placement pin/);
});
