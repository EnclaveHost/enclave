// Native echo and L1 transport fixtures; no claim of positive chain derivation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDerivedProvider, startDerivedReader } from '../../network/derived-reader/provider.mjs';
import { openDerivedJournal } from '../../network/derived-reader/journal.mjs';
import { openCoverageStore } from '../../network/derived-reader/coverage-store.mjs';
import { validateCoverage, LEASE_TOPICS, COVERAGE_FORMAT, FILTER_ID, MAX_COVERAGE_BYTES } from '../../network/derived-reader/coverage.mjs';
import { bindNativeV3 } from '../../network/derived-reader/proof.mjs';
import { sha256File } from '../../network/derived-reader/process.mjs';
import { createLifecycleFinalitySnapshot } from '../../network/lifecycle-finality-bridge.mjs';
import { openLifecycleJournal } from '../../network/deployment-lifecycle-journal.mjs';
import { setup, header, anchorOf, nativeResult } from './helpers.mjs';
const A = `0x${'aa'.repeat(20)}`, B = `0x${'bb'.repeat(20)}`, ID = `0x${'cc'.repeat(32)}`;
const binding = 'e'.repeat(64);
function log(h, index=0, address=A, topics=[LEASE_TOPICS[0], ID], data='0x') {
  return { address, blockNumber:Number(BigInt(h.number)), blockHash:h.hash, logIndex:index, topics, data, txHash:`0x${'dd'.repeat(32)}` };
}
function result(ticket, headers, logs=[]) {
  const blocks=headers.map(h=>({...anchorOf(h,{}).base,receiptsRoot:h.receiptsRoot,transactionsRoot:h.transactionsRoot}));
  return {...nativeResult(ticket,headers.at(-1)),format:'enclave-base-derivation-result/v3',
    intermediateRoots:'0x'+blocks.map(b=>b.outputRoot.slice(2)).join(''),
    coverage:{format:COVERAGE_FORMAT,filterId:FILTER_ID,fromBlock:blocks[0].number,toBlock:blocks.at(-1).number,blocks,logs}};
}
async function fixture(t) {
  const f=await setup(t);f.journal=await openDerivedJournal(f.directory,{binding,initialize:true});
  f.store=await openCoverageStore(path.join(f.directory,'coverage'),{binding,initialize:true});
  f.options={l1:f.l1,journal:f.journal,executable:f.native,workDir:f.directory,now:()=>f.now,resultVersion:3,coverageStore:f.store,
    bootstrap:async()=>f.agreed,base:async()=>f.candidate};
  f.reader=await createDerivedProvider(f.options);
  t.after(async()=>{await f.reader.close();f.store.close();f.journal.close();});
  f.h1=header(101,Math.floor(f.now/1000)-2);f.h2=header(102,Math.floor(f.now/1000)-1);
  f.submit=async(headers,logs=[])=>{
    f.candidate=headers.at(-1);
    const ticket=await f.reader.prepare({blockNumber:Number(BigInt(f.candidate.number)),rollupConfigTemplate:{l2_chain_id:8453}});
    return f.reader.submit({ticket:ticket.ticket,witness:Buffer.from(JSON.stringify(result(ticket,headers,logs)))});
  };
  f.query=async(extras={})=>({address:A,topic0s:[...LEASE_TOPICS],topic1:ID,fromBlock:101,toBlock:102,
    anchor:((a)=>({number:a.base.number,hash:a.base.hash}))(await f.reader.readAnchor()),...extras});
  return f;
}
test('v3 complete coverage includes empty blocks and filters all-address, one-topic logs without dropping coverage',async t=>{
  const f=await fixture(t);
  await f.submit([f.h1,f.h2],[log(f.h1),log(f.h1,4,B,[LEASE_TOPICS[0]])]);
  const value=await f.reader.readDerivedLogs(await f.query());
  assert.equal(value.format,'enclave-derived-logs/v1');assert.equal(value.logs.length,1);assert.equal(value.logs[0].logIndex,0);
  assert.deepEqual(value.anchor,await f.reader.readAnchor());
  assert.deepEqual(value.coverage,{format:COVERAGE_FORMAT,filterId:FILTER_ID,fromBlock:101,toBlock:102,complete:true,availableFromBlock:101,availableToBlock:102});
  assert.deepEqual((await f.reader.readDerivedLogs(await f.query({fromBlock:102}))).logs,[]);
  assert.equal(fs.readdirSync(path.join(f.directory,'coverage')).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).length,1);
});
test('logs require exact snapshot identity and covered range; no old bootstrap, unknown filter or cancellation grants',async t=>{
  const f=await fixture(t);await f.submit([f.h1,f.h2]);const query=await f.query();
  for(const bad of [{fromBlock:100},{toBlock:103},{anchor:{number:102,hash:`0x${'ff'.repeat(32)}`}},{topic0s:[ID]},{topic0s:[LEASE_TOPICS[0],LEASE_TOPICS[0]]}])
    await assert.rejects(f.reader.readDerivedLogs({...query,...bad}),/coverage|snapshot|filter/);
  const ac=new AbortController();ac.abort(Error('query cancelled'));
  await assert.rejects(f.reader.readDerivedLogs({...query,signal:ac.signal}),/cancelled/);
  f.now+=1801000;await assert.rejects(f.reader.readDerivedLogs(query),/stale/);
});
test('v3 validation refuses incomplete blocks, wrong roots, duplicated logs, wrong filter and downgraded output',async t=>{
  const f=await fixture(t);f.candidate=f.h2;
  const ticket=await f.reader.prepare({blockNumber:102,rollupConfigTemplate:{l2_chain_id:8453}});
  const good=result(ticket,[f.h1,f.h2],[log(f.h1)]), input={trusted:ticket.trusted,bound:{agreedL2BlockNumber:100}};
  for(const mutate of [r=>r.coverage.blocks.pop(),r=>r.coverage.blocks[0].outputRoot=ID,r=>r.coverage.logs.push({...r.coverage.logs[0]}),
    r=>r.coverage.logs[0].blockHash=ID,r=>r.coverage.filterId='host-filter',r=>r.format='enclave-base-derivation-result/v2']) {
    const bad=structuredClone(good);mutate(bad);assert.throws(()=>bindNativeV3(bad,input,f.h2,f.head));
  }
  assert.equal(bindNativeV3(good,input,f.h2,f.head).coverage.blocks.length,2);
  await assert.rejects(f.reader.submit({ticket:ticket.ticket,witness:Buffer.from(JSON.stringify({...good,format:'enclave-base-derivation-result/v2'}))}),/v3/);
  assert.equal(f.journal.read().floor,null);assert.equal(f.store.status().verifiedFromBlock,null);
});
test('restarted coverage JSON grants nothing; re-derive contiguous segments through the saved floor',async t=>{
  const f=await fixture(t);await f.submit([f.h1,f.h2],[log(f.h1)]);const query=await f.query(),anchor=await f.reader.readAnchor();
  await f.reader.close();f.store.close();
  f.store=await openCoverageStore(path.join(f.directory,'coverage'),{binding});
  await assert.rejects(f.store.read(query,anchor),/outside runtime/);
  f.reader=await createDerivedProvider({...f.options,coverageStore:f.store});
  await assert.rejects(f.reader.readDerivedLogs(query),/no locally derived/);
  assert.equal((await f.submit([f.h1],[log(f.h1)])).status,'recovering');
  await assert.rejects(f.reader.readDerivedLogs(query),/no locally derived/);
  assert.equal((await f.submit([f.h2])).status,'verified');
  assert.equal((await f.reader.readDerivedLogs(query)).logs.length,1);
});
test('changed saved chunks fence both log reads and the prior in-memory anchor',async t=>{
  const f=await fixture(t);await f.submit([f.h1,f.h2],[log(f.h1)]);const query=await f.query();
  const dir=path.join(f.directory,'coverage'),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
  fs.appendFileSync(path.join(dir,manifest.entries[0].chunkHash+'.json'),' ');
  await assert.rejects(f.reader.readDerivedLogs(query),/size changed/);
  await assert.rejects(f.reader.readAnchor(),/coverage store closed or failed/);
});
test('partial durable publication fences the process and coverage cannot be seeded with plain JSON',async t=>{
  const f=await fixture(t);f.candidate=f.h2;
  const ticket=await f.reader.prepare({blockNumber:102,rollupConfigTemplate:{l2_chain_id:8453}}),r=result(ticket,[f.h1,f.h2]);
  const bound=bindNativeV3(r,{trusted:ticket.trusted,bound:{agreedL2BlockNumber:100}},f.h2,f.head);
  assert.throws(()=>f.store.stage(structuredClone(bound.coverage),f.agreed,bound.anchor),/this process/);
  fs.mkdirSync(path.join(f.directory,'derived-state.json.strict.tmp'));
  await assert.rejects(f.reader.submit({ticket:ticket.ticket,witness:Buffer.from(JSON.stringify(r))}),/EISDIR/);
  assert.throws(()=>f.store.status(),/publication pending/);
  await assert.rejects(f.reader.readAnchor(),/closed|failed/);
  // Coverage committed before the anchor-journal failure. Its saved restriction
  // must also be reached on restart; it does not grant reads by itself.
  await f.reader.close();f.store.close();f.journal.close();
  fs.rmdirSync(path.join(f.directory,'derived-state.json.strict.tmp'));
  f.journal=await openDerivedJournal(f.directory,{binding});
  f.store=await openCoverageStore(path.join(f.directory,'coverage'),{binding});
  f.reader=await createDerivedProvider({...f.options,journal:f.journal,coverageStore:f.store});
  assert.equal(f.journal.read().floor,null);
  assert.equal((await f.submit([f.h1])).status,'recovering');
  await assert.rejects(f.reader.readAnchor(),/no locally derived/);
  assert.equal((await f.submit([f.h2])).status,'verified');
});
test('coverage manifest write failure refuses publication and fences the previous anchor',async t=>{
  const f=await fixture(t);await f.submit([f.h1]);
  fs.mkdirSync(path.join(f.directory,'coverage','manifest.json.strict.tmp'));
  await assert.rejects(f.submit([f.h2]),/EISDIR/);
  assert.equal(f.journal.read().floor.base.number,101);
  await assert.rejects(f.reader.readAnchor(),/coverage store closed or failed/);
});
test('coverage manifests have exclusive ownership and reject persisted hash-chain corruption',async t=>{
  const f=await fixture(t);await f.submit([f.h1]);const dir=path.join(f.directory,'coverage');
  await assert.rejects(openCoverageStore(dir,{binding}),/lock|in use/i);
  await f.reader.close();f.store.close();
  const file=path.join(dir,'manifest.json'),m=JSON.parse(fs.readFileSync(file));m.entries[0].agreedRoot=ID;
  fs.writeFileSync(file,JSON.stringify(m));
  await assert.rejects(openCoverageStore(dir,{binding}),/corruption/);
});
test('quota accounts for orphan chunks, refuses overflow and never evicts history',async t=>{
  const f=await fixture(t),dir=path.join(f.directory,'limited');
  let store=await openCoverageStore(dir,{binding,initialize:true,maximumBytes:3*MAX_COVERAGE_BYTES});store.close();
  const orphan=path.join(dir,'0'.repeat(64)+'.json'),fd=fs.openSync(orphan,'wx',0o600);fs.ftruncateSync(fd,MAX_COVERAGE_BYTES);fs.closeSync(fd);
  store=await openCoverageStore(dir,{binding,maximumBytes:3*MAX_COVERAGE_BYTES});t.after(()=>store.close());
  const a=anchorOf(f.h1,f.head,'l1-finalized-derived'),coverage={format:COVERAGE_FORMAT,filterId:FILTER_ID,fromBlock:101,toBlock:101,
    blocks:[{...a.base,receiptsRoot:f.h1.receiptsRoot,transactionsRoot:f.h1.transactionsRoot}],logs:[]};
  const checked=validateCoverage({format:'enclave-base-derivation-result/v3',intermediateRoots:a.base.outputRoot,coverage},
    {trusted:{intermediateBlockInterval:1},bound:{agreedL2BlockNumber:100}},a);
  assert.throws(()=>store.stage(checked,f.agreed,a),/budget exhausted/);
  assert.equal(fs.statSync(orphan).size,MAX_COVERAGE_BYTES);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'))).entries.length,0);
});
test('v3 stdout supports a complete result beyond v2 size without truncating logs or query results',async t=>{
  const f=await fixture(t);const large=log(f.h1,0,A,[LEASE_TOPICS[0],ID],'0x'+'ab'.repeat(600000));
  await f.submit([f.h1],[large]);const query=await f.query({toBlock:101}),anchor=await f.reader.readAnchor();
  assert.equal((await f.reader.readDerivedLogs(query)).logs[0].data,large.data);
  await assert.rejects(f.store.read(query,anchor,{maxBytes:4096}),/response too large/);
  assert.equal((await f.reader.readAnchor()).base.number,101);
});
test('v3 startup requires the explicit format/pin and interval; v2 cannot silently enable history',async()=>{
  await assert.rejects(startDerivedReader({stateDir:'/unused',native:{resultVersion:3,sha256:'f1a6bb0e82be37fddf9e2485c50f78b4cd5eb02d43e903152230c91fd22dcfd9'}}),/native/);
  await assert.rejects(startDerivedReader({stateDir:'/unused',native:{resultVersion:3},intermediateBlockInterval:2}),/interval/);
});
test('full v3 runtime opens private coverage under its ownership and refuses missing history on restart',async t=>{
  const f=await setup(t);await f.l1.close();const sha256=await sha256File(f.native),stateDir=path.join(f.directory,'v3-state');
  const config={stateDir,initializeState:true,native:{path:f.native,sha256,resultVersion:3},l1:f.l1Config,baseUrl:'http://127.0.0.1:1'};
  const options={now:()=>f.now,l1Options:f.l1Options,acceptedDerivationBuilds:{[sha256]:'v3 composition fixture'}};
  const reader=await startDerivedReader(config,options);t.after(()=>reader.close());
  assert.equal(reader.status().resultVersion,3);assert.equal(reader.status().coverage.verifiedFromBlock,null);
  assert.equal(reader.status().coverage.maximumBytes,4*1024**3);
  await reader.close();assert.deepEqual(fs.readdirSync(path.join(stateDir,'runs')),[]);
  fs.unlinkSync(path.join(stateDir,'coverage','manifest.json'));
  await assert.rejects(startDerivedReader({...config,initializeState:false},options),/manifest missing/);
});
test('a real bridge callback can make both coverage queries without a reentrant reader lock',async t=>{
  const f=await fixture(t);await f.submit([f.h1,f.h2],[log(f.h1)]);
  const verifier={request:async(method)=>{
    if(method==='eth_chainId')return '0x2105';
    if(method==='eth_getBlockByNumber')return f.h2;
    if(method==='eth_getBalance')return '0x2a';
    throw Error('unexpected proof transport fixture request');
  }};
  const snapshot=createLifecycleFinalitySnapshot({readAnchor:f.reader.readAnchor,verifier,now:()=>f.now,
    journal:openLifecycleJournal(path.join(f.directory,'consumer-lifecycle.json')),maxAnchorAgeSec:120});
  const value=await snapshot(async(client,number,h)=>{
    assert.equal(f.reader.status().busy,false,'readAnchor released the reader before callback');
    const balance=await client.getBalance({address:A});
    const query={address:A,topic0s:[...LEASE_TOPICS],topic1:ID,fromBlock:Number(number),toBlock:Number(number),anchor:{number:Number(number),hash:h.hash}};
    const bounds=await f.reader.readDerivedLogs(query);
    const history=await f.reader.readDerivedLogs({...query,fromBlock:Math.max(100,bounds.coverage.availableFromBlock)});
    assert.deepEqual(bounds.anchor,history.anchor);
    return {balance,logs:history.logs};
  });
  assert.equal(value.value.balance,42n);assert.equal(value.value.logs.length,1);
  f.now+=121000;
  await assert.rejects(snapshot(()=>null),/age bound/,'the consumer 120-second policy was not relaxed to the reader bound');
});
