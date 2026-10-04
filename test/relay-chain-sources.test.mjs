import test from 'node:test';
import assert from 'node:assert/strict';
const {createLeaseSource,createRegistryOperator}=await import(process.env.ENCLAVE_TEST_RELAY_BUNDLE||'../relay/chain-sources.mjs');
const id='0x'+'ab'.repeat(32),other='0x'+'cd'.repeat(32),registry='0x'+'03'.repeat(20),op='0x'+'09'.repeat(20);
const never=()=>new Promise(()=>{});

test('a still-valid lease answers a publication at once while one snapshot renews every routed app',async()=>{
 let clock=1_000_000;const rows=new Map(),asked=[];let refresh=async ids=>{asked.push(ids);};
 const reader={get:i=>{const r=rows.get(i);return r&&r.validUntil>clock?r:null;},refresh:ids=>refresh(ids)};
 const leaseOf=createLeaseSource({reader,now:()=>clock});
 // Nothing cached: the publication waits for the read, which covers it.
 refresh=async ids=>{asked.push(ids);for(const i of ids)rows.set(i,{id:i,blockTime:clock,validUntil:clock+90000});};
 assert.equal((await leaseOf(id)).id,id);assert.deepEqual(asked,[[id]]);
 // Fresh: no read at all.
 clock+=5000;assert.equal((await leaseOf(id)).id,id);assert.equal(asked.length,1);
 // Stale but valid: served now, renewed in the background with every routed app.
 assert.equal((await leaseOf(other)).id,other);
 clock+=20000;refresh=ids=>{asked.push(ids);return never();};const before=asked.length;
 assert.equal((await Promise.race([leaseOf(id),new Promise(r=>setTimeout(()=>r('waited'),50))])).id,id);
 assert.equal(asked.length,before+1);assert.deepEqual(asked.at(-1),[id,other]);
 // Expired: the publication waits, and a failed read is its answer.
 clock+=90000;refresh=async()=>{throw Error('no fresh agreeing chain quorum');};
 await assert.rejects(leaseOf(id),/agreeing chain quorum/);
 // A deployment the chain no longer has is not kept in later snapshots.
 refresh=async ids=>{asked.push(ids);};await leaseOf(id);assert.equal(await leaseOf(other),null);
 refresh=async ids=>{asked.push(ids);};clock+=1;await leaseOf(id);assert.deepEqual(asked.at(-1),[id]);
});

test('an operator answer is fresh 15 s, served to 60 s while one read renews it, then must be read again',async()=>{
 let clock=0,reads=0,answer=async()=>[{active:true,operator:op}];
 const reader={registryEntries:async(r,ids)=>{reads++;assert.equal(r,registry);assert.deepEqual(ids,[id]);return answer();}};
 const operatorOf=createRegistryOperator({reader,registry:()=>registry,now:()=>clock});
 assert.equal(await operatorOf(id),op);assert.equal(reads,1);
 clock=10000;assert.equal(await operatorOf(id),op);assert.equal(reads,1);
 // Stale: answered now; concurrent asks share one background read.
 clock=20000;let release;answer=()=>new Promise(r=>release=()=>r([{active:false,operator:op}]));
 assert.deepEqual(await Promise.all([operatorOf(id),operatorOf(id)]),[op,op]);assert.equal(reads,2);
 release();await new Promise(r=>setTimeout(r,0));
 assert.equal(await operatorOf(id),null); // the renewed answer: the entry went inactive
 // A failed renewal keeps the old answer only until it ages out, then throws.
 clock=40000;answer=async()=>{throw Error('chain quorum unavailable');};
 assert.equal(await operatorOf(id),null);await new Promise(r=>setTimeout(r,0));
 clock=50000;assert.equal(await operatorOf(id),null);await new Promise(r=>setTimeout(r,0));
 clock=81000;await assert.rejects(operatorOf(id),/quorum unavailable/);
 // No registry configured: nobody.
 assert.equal(await createRegistryOperator({reader,registry:()=>''})(id),null);
});
