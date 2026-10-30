import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createLeaseExpiryReader, leaseExpiryVerdict} from '../network/lease-expiry-reconcile.mjs';

const id='0x'+'11'.repeat(32), runner='0x'+'22'.repeat(32), operator='0x'+'33'.repeat(20), ledger='0x'+'44'.repeat(20);
const NOW=1793205543000, OLD=1793205451, NEW=1793207033;
const row=(over={})=>({id,runner,runnerOperator:operator,active:true,leaseUntil:BigInt(NEW),...over});
const snap=d=>({d,blockNumber:53207943n,blockHash:'0x'+'ab'.repeat(32),timestamp:NOW-4000});
const source=fs.readFileSync(process.env.SUPERVISOR_JS||new URL('../supervisor.js',import.meta.url),'utf8');
const slice=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i+a.length);assert.ok(i>=0&&j>i);return source.slice(i,j);};
function fixture() {
  const state={stops:0,proofs:0,sends:0,reads:0,now:NOW,snapshot:snap(row())};
  class Clock extends Date { static now(){return state.now;} }
  const rec={id,status:'running',_onchain:true,_leaseUntil:OLD,rate:0};
  const ctx=vm.createContext({Date:Clock,console:{log(){},warn(){}},setTimeout,clearTimeout,
    createLeaseExpiryReader:()=>async()=>{state.reads++;return state.read?state.read():state.snapshot;},leaseExpiryVerdict:(s,o)=>leaseExpiryVerdict(s,{...o,now:state.now}),
    DEPLOYMENTS_ADDRESS:ledger,RPC_POOL:[],_enclaveId:runner,depsAbi:async()=>({abi:[]}),claimSigner:()=>({account:{address:operator}}),
    deployments:new Map([[id,rec]]),saveStateSoon(){},saveStateNow(){},_stateDirty:false,
    setInterval:fn=>{state.tick=fn;return {unref(){}};},BILL_TICK_SEC:15,GRACE_SEC:90,FORWARDER_ADDRESS:'',
    backendHealthy:async()=>false,proveFinalPeriod:async()=>{state.proofs++;await state.proof?.();},
    stopContainer:async r=>{r._expiryEpoch=(r._expiryEpoch||0)+1;state.stops++;},releaseGpu(){},
    tearDown:async r=>{r._expiryEpoch=(r._expiryEpoch||0)+1;state.stops++;r.status='expired';},
    _reach:{tripped:false},RENEW_MARGIN_SEC:300,_stateCorrupt:false,HOST_POLICY_GATE:{serviceRefusal:()=>null},
    _releaseIntents:new Map(),leaseGasActive:()=>false,readLedgerContract:async()=>row({configCid:''}),placementRefusal:()=>null,
    leasePermit:()=>({}),hostWalletDecision:async()=>({}),hostWalletRefusal:async()=>null,walletSendGate:()=>()=>null,
    sendClaimTx:()=>{state.sends++;throw Error('502 relay timeout');},sendLeaseTx:()=>{state.sends++;throw Error('502 relay timeout');},
  });
  vm.runInContext(slice('let _expiryReader = null;','\napp.get("/v1/deployments",'),ctx);
  vm.runInContext(slice('async function renewLeases()','\nasync function switchTenantVersion('),ctx);
  ctx.startBillingTicker();
  return {state,ctx,rec};
}
test('actual reaper preserves EyesOff after canonical renewal landed following relay 502',async()=>{
  const {state,rec}=fixture();await state.tick();assert.equal(state.stops,0);assert.equal(state.proofs,0);
  assert.equal(rec._leaseUntil,NEW);assert.equal(rec.status,'running');
});
test('actual renewal error marks uncertain outcome; next attempt reconciles without duplicate send',async()=>{
  const {state,ctx,rec}=fixture();state.now=OLD*1000-20000;
  await ctx.renewLeases();assert.equal(state.sends,1);assert.equal(rec._renewNeedsReconcile,true);
  state.now+=61000;state.snapshot.timestamp=state.now-4000;
  await ctx.renewLeases();assert.equal(state.sends,1);assert.equal(rec._leaseUntil,NEW);
});
test('genuine canonical expiry is stopped after the existing grace',async()=>{
  const {state,rec}=fixture();state.snapshot=snap(row({leaseUntil:BigInt(OLD)}));
  await state.tick();assert.equal(state.stops,1);assert.equal(rec.status,'expired');
});
test('unavailable quorum never invents an extension or indefinite grace',async()=>{
  const {state,rec}=fixture();state.read=()=>{throw Error('429');};await state.tick();
  assert.equal(rec._leaseUntil,OLD);assert.equal(state.stops,1);
});
test('explicit owner/admin stop while read is pending is never undone',async()=>{
  const {state,ctx,rec}=fixture();let resolve;state.read=()=>new Promise(r=>resolve=r);
  const pending=state.tick();await new Promise(r=>setImmediate(r));
  await ctx.stopContainer(rec);rec.status='terminated';resolve(snap(row()));await pending;
  assert.equal(rec.status,'terminated');assert.equal(rec._leaseUntil,OLD);assert.equal(state.stops,1);
});
test('record replacement or ledger change while reading cannot revive old record',async()=>{
  for(const change of [(f)=>f.ctx.deployments.set(id,{...f.rec}),(f)=>f.ctx.DEPLOYMENTS_ADDRESS='0x'+'55'.repeat(20)]){
    const f=fixture();let resolve;f.state.read=()=>new Promise(r=>resolve=r);
    const pending=f.state.tick();await new Promise(r=>setImmediate(r));change(f);resolve(snap(row()));await pending;
    assert.equal(f.state.stops,0);assert.equal(f.rec._leaseUntil,OLD);
  }
});
test('overlapping ticker callbacks share one expiry decision',async()=>{
  const {state}=fixture();let resolve;state.read=()=>new Promise(r=>resolve=r);
  const first=state.tick();await new Promise(r=>setImmediate(r));await state.tick();
  resolve(snap(row({leaseUntil:BigInt(OLD)})));await first;assert.equal(state.stops,1);assert.equal(state.reads,1);
});
test('new receipt during final proof cancels stale teardown',async()=>{
  const {state,rec}=fixture();state.snapshot=snap(row({leaseUntil:BigInt(OLD)}));state.proof=async()=>{rec._leaseUntil=NEW;};
  await state.tick();assert.equal(state.stops,0);assert.equal(rec._expiryTeardown,false);
});
test('receipt arriving during canonical read prevents stale expiry teardown',async()=>{
  const {state,rec}=fixture();state.read=async()=>{rec._leaseUntil=NEW;return snap(row({leaseUntil:BigInt(OLD)}));};
  await state.tick();assert.equal(state.stops,0);assert.equal(state.proofs,0);
});
test('expiry knowledge never restores a wallet-held record to another status',async()=>{
  const {state,rec}=fixture();rec.walletHeld=true;await state.tick();
  assert.equal(rec.walletHeld,true);assert.equal(rec.status,'running');assert.equal(state.stops,0);
});
test('inactive owner or another runner cannot authorize continuation',()=>{
  for(const over of [{active:false},{runner:'0x'+'99'.repeat(32)},{runnerOperator:'0x'+'99'.repeat(20)}])
    assert.equal(leaseExpiryVerdict(snap(row(over)),{id,runner,operator,now:NOW}).kind,'revoked');
});

function client({d=row(),time=NOW-4000,hash='0x'+'ab'.repeat(32),network=8453,reorg=false,hang=false}={}){
  let blocks=0;
  return {getChainId:async()=>network,getBlockNumber:async()=>hang?new Promise(()=>{}):53207945n,
    getBlock:async()=>({number:53207943n,timestamp:BigInt(Math.floor(time/1000)),hash:reorg&&++blocks>1?'0x'+'cd'.repeat(32):hash}),
    readContract:async q=>{assert.equal(q.address,ledger);assert.equal(q.functionName,'get');assert.deepEqual(q.args,[id]);assert.equal(q.blockNumber,53207943n);return d;}};
}
test('reader requires two matching rows, same canonical block, correct chain and fresh time',async()=>{
  const read=createLeaseExpiryReader({clients:[client(),client(),client({network:1})],now:()=>NOW});
  const s=await read({id,ledger,abi:[]});assert.equal(s.d.leaseUntil,BigInt(NEW));
  for(const bad of [{d:row({active:false})},{hash:'different'},{network:1},{time:NOW-16000},{time:NOW+6000},{reorg:true}]){
    const r=createLeaseExpiryReader({clients:[client(),client(bad)],now:()=>NOW});
    await assert.rejects(r({id,ledger,abi:[]}),/quorum/);
  }
});
test('reader respects observed block floor',async()=>{
  const read=createLeaseExpiryReader({clients:[client(),client()],now:()=>NOW});
  await assert.rejects(read({id,ledger,abi:[],minBlock:53207946}),/floor/);
});
test('coalescing cannot weaken a later caller\'s stricter block floor',async()=>{
  const read=createLeaseExpiryReader({clients:[client(),client()],now:()=>NOW});
  const first=read({id,ledger,abi:[]});
  const stricter=read({id,ledger,abi:[],minBlock:53207944});
  assert.equal((await first).blockNumber,53207943n);
  await assert.rejects(stricter,/floor/);
});
test('two healthy providers can answer despite a hung third provider',async()=>{
  const read=createLeaseExpiryReader({clients:[client(),client(),client({hang:true})],now:()=>NOW,timeoutMs:500});
  assert.equal((await read({id,ledger,abi:[]})).d.leaseUntil,BigInt(NEW));
});
test('hung reads time out, retain their slot and never authorize a lease',async()=>{
  const read=createLeaseExpiryReader({clients:[client({hang:true}),client()],now:()=>NOW,timeoutMs:10});
  const a=read({id,ledger,abi:[]});assert.equal(read({id,ledger,abi:[]}),a);
  await assert.rejects(a,/deadline/);assert.equal(read({id,ledger,abi:[]}),a);
});
test('repeated successful decisions cannot accumulate requests on a hung third peer',async()=>{
  for (const phase of ['head','header','row','recheck']) {
    const stuck=client(), counts={head:0,header:0,row:0}, good=[client(),client()];
    let outstanding=0, peak=0, release;
    const hang=()=>{outstanding++;peak=Math.max(peak,outstanding);return new Promise(r=>release=()=>{outstanding--;r();});};
    stuck.getBlockNumber=async()=>{counts.head++;if(phase==='head'&&counts.head===1)await hang();return 53207945n;};
    const header=stuck.getBlock;
    stuck.getBlock=async q=>{counts.header++;if((phase==='header'&&counts.header===1)||(phase==='recheck'&&counts.header===2))await hang();return header(q);};
    const rowRead=stuck.readContract;
    stuck.readContract=async q=>{counts.row++;if(phase==='row'&&counts.row===1)await hang();return rowRead(q);};
    const read=createLeaseExpiryReader({clients:[...good,stuck],now:()=>NOW,timeoutMs:500});
    for(let i=0;i<25;i++)assert.equal((await read({id,ledger,abi:[]})).blockNumber,53207943n);
    assert.equal(counts.head,1,phase);assert.equal(peak,1,phase);assert.equal(outstanding,1,phase);
    release();await new Promise(r=>setImmediate(r));
    assert.equal(outstanding,0,phase);
    await read({id,ledger,abi:[]});assert.equal(counts.head,2,phase);
  }
});
test('both providers returning identical malformed header metadata cannot form a quorum',async()=>{
  const mutations=[
    h=>delete h.hash,h=>h.hash=undefined,h=>h.hash=null,h=>h.hash='0x'+'00'.repeat(32),
    h=>h.hash='0x1234',h=>h.hash='0x'+'zz'.repeat(32),
    h=>delete h.number,h=>h.number=null,h=>h.number='53207943',h=>h.number=53207942n,h=>h.number=53207944n,
    h=>delete h.timestamp,h=>h.timestamp=null,h=>h.timestamp=Number(h.timestamp),
  ];
  for(const mutate of mutations)for(const phase of ['first','recheck']){
    const peers=[client(),client()].map(c=>{const get=c.getBlock;let calls=0;c.getBlock=async q=>{
      const h=await get(q);calls++;if(phase==='first'||calls===2)mutate(h);return h;};return c;});
    const read=createLeaseExpiryReader({clients:peers,now:()=>NOW});
    await assert.rejects(read({id,ledger,abi:[]}),/quorum/);
  }
});
test('matching block hashes cannot conceal changed canonical timestamps',async()=>{
  const peers=[client(),client()].map(c=>{const get=c.getBlock;let calls=0;c.getBlock=async q=>{
    const h=await get(q);if(++calls===2)h.timestamp+=1n;return h;};return c;});
  await assert.rejects(createLeaseExpiryReader({clients:peers,now:()=>NOW})({id,ledger,abi:[]}),/quorum/);
});
test('verdict rejects malformed canonical snapshot identities and stale evidence',()=>{
  for(const over of [{blockNumber:undefined},{blockNumber:53207943},{blockNumber:-1n},
    {blockHash:undefined},{blockHash:'0x'+'00'.repeat(32)},{timestamp:undefined},
    {timestamp:NOW-15000},{timestamp:NOW+6000}])
    assert.throws(()=>leaseExpiryVerdict({...snap(row()),...over},{id,runner,operator,now:NOW}),/snapshot/);
});
