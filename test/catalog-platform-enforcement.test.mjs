import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {catalogAdmissionRefusal} from '../site/js/core/catalog-policy.js';
const approved={active:true,yanked:false,approval:1};
const deploySource=fs.readFileSync(new URL('../site/js/pages/deploy.js',import.meta.url),'utf8');
const begin=deploySource.indexOf('  const catalogRef =',deploySource.indexOf('export async function deployOnChain(spec)'));
const end=deploySource.indexOf('  const capMsg =',begin);
assert.ok(begin>0&&end>begin);
function browserGate({app=approved,version=approved,fail=false,isPublic=true}={}){
 const state={reads:[],messages:[]};
 const ctx=vm.createContext({Promise,catalogAdmissionRefusal,parseCatalogRef:()=>({appId:'app',index:0}),
  catGetApp:async()=>{state.reads.push('app');if(fail)throw Error('RPC unavailable');return app;},
  catGetVersion:async()=>{state.reads.push('version');return version;},showToast:s=>{state.messages.push(s);return 'refused';}});
 const fn=vm.runInContext('(async function(spec){'+deploySource.slice(begin,end)+' return "admitted";})',ctx);
 return {state,run:()=>fn({reference:'catalog://app/0',isPublic})};
}
test('actual browser deployment gate reads current moderation and refuses before downstream spending',async()=>{
 for(const status of [{active:false},{yanked:true},{approval:2}])for(const isPublic of [true,false]){
  const x=browserGate({app:{...approved,...status},version:{...approved,...status},isPublic});
  assert.equal(await x.run(),'refused');assert.deepEqual(x.state.reads,['app','version']);
 }
 assert.equal(await browserGate().run(),'admitted');
 assert.equal(await browserGate({fail:true}).run(),'refused');
 assert.equal(await browserGate({version:{...approved,approval:0}}).run(),'refused');
 assert.equal(await browserGate({version:{...approved,approval:0},isPublic:false}).run(),'admitted');
});
// The REAL Windows Host (windows/node/host.mjs) over the REAL host admission (network/host-admission-runtime.mjs
// createHostAdmission): only the chain is a fixture (one agreed block of the host-ownership extension and the app catalog).
// The node derives forPrivate from its ledger record (isPublic === false, nothing else) and the admission enforces
// platform catalog moderation (delisted app, yanked or rejected version) for public AND private records, pending private
// development only for a ledger-private record, the host owner's own denial, and refuses as UNKNOWN when the chain
// cannot be read. (The earlier harness rebuilt walletPolicyRefusal from the source text, which stopped compiling when the
// method moved behind the private #walletPolicyState; the behaviour itself was intact.)
test('actual Windows wallet gate passes only ledger-authoritative private visibility',async()=>{
 const os=await import('node:os'),path=await import('node:path');
 const {Host}=await import('../windows/node/host.mjs');
 const {createHostAdmission}=await import('../network/host-admission-runtime.mjs');
 const {hostAdmissionPolicyHash}=await import('../network/host-admission-policy.mjs');
 const hostId='0x'+'ab'.repeat(32),id='0x'+'cd'.repeat(32),app='0x'+'ef'.repeat(32),appRef=`catalog://${app}/1`;
 const ownership='0x'+'11'.repeat(20),registry='0x'+'22'.repeat(20),catalog='0x'+'33'.repeat(20),owner='0x'+'44'.repeat(20);
 const doc0={version:1,chainId:8453,ownershipContract:ownership,hostId,requireCatalogApproval:false,denyDeployments:[],denyAppRefs:[]};
 const st={now:1_000_000,doc:doc0,revision:1,failure:false,catalog:{active:true,approval:1,yanked:false},reads:0};
 const client={readContract:async q=>{st.reads++;
  if(q.functionName==='registry')return registry;
  if(q.functionName==='authority')return [owner,owner,BigInt(st.revision),hostAdmissionPolicyHash(st.doc)];
  if(q.functionName==='getApp')return {appId:app,versionCount:2,active:st.catalog.active};
  if(q.functionName==='getVersion')return {yanked:st.catalog.yanked,approval:st.catalog.approval};
  throw Error('unexpected read '+q.functionName);}};
 const reader={agreed:async fn=>{if(st.failure)throw Error('chain quorum unavailable');return {timestamp:st.now,...await fn(client,100n)};}};
 const admission=createHostAdmission({hostId,ownershipContract:ownership,registry,catalog,reader,loadPolicy:async()=>st.doc,now:()=>st.now,cacheMs:0});
 const h=new Host({dir:fs.mkdtempSync(path.join(os.tmpdir(),'catalog-gate-')),endpoint:'https://box.example',name:'test',appsEnabled:true,vcpus:8,ramGb:16,cpuPricePerSec6:0,log:()=>{}});
 h.hostAdmission=admission;
 const ask=(isPublic,over={})=>h.walletPolicyRefusal({id,appRef,isPublic,...over});
 // approved, active: admitted whatever the visibility
 for(const v of [false,true,undefined])assert.equal(await ask(v),null);
 // pending catalog approval: ONLY a ledger-private record (isPublic === false) is pending private development
 st.catalog={active:true,approval:0,yanked:false};
 assert.equal(await ask(false),null);
 for(const v of [true,undefined,'false',0,null])assert.match(await ask(v),/PRIVATE/,`isPublic ${String(v)} is not ledger-private`);
 // platform moderation binds private records too: a delisted app, a yanked or a rejected version
 for(const c of [{active:false,approval:1,yanked:false},{active:true,approval:1,yanked:true},{active:true,approval:2,yanked:false}]){
  st.catalog=c;for(const v of [false,true])assert.ok(await ask(v),`refused: ${JSON.stringify(c)} isPublic ${v}`);
 }
 st.catalog={active:true,approval:1,yanked:false};
 // the host owner's own wallet denial
 st.doc={...doc0,denyDeployments:[id]};st.revision++;assert.match(await ask(true),/declines/);
 st.doc=doc0;st.revision++;assert.equal(await ask(true),null);
 // the policy cannot judge a non-catalog reference: refused by the policy itself (definite, not unknown)
 assert.match(await ask(true,{appRef:'docker://x'}),/^host wallet policy: catalog app reference required/);
 // the chain cannot be read: UNKNOWN, never admitted and never a definite refusal
 st.failure=true;assert.match(await ask(false),/^host wallet policy unavailable: .*chain quorum unavailable/);
 // the hold channel asks decision() (same policy, with its chain deadline): same answers
 st.failure=false;h.walletChannel={};st.catalog={active:true,approval:0,yanked:false};
 assert.equal(await ask(false),null);assert.match(await ask(true),/PRIVATE/);
 assert.ok(st.reads>0,'the admission read the chain');
});
