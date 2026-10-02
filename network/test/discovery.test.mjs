import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {namingKey,encodeDiscovery,verifyIPNS,verifyBlock,resolveDiscovery} from '../discovery.mjs';
import {DurableState} from '../durable-state.mjs';import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';

test('IPNS signatures and raw CID hashes survive independent verification and reject tampering',async()=>{
 const seed=randomBytes(32),{name}=await namingKey(seed);
 const bundle={authorization:{delegation:{ipns:name}},record:{sequence:1,expiresAt:Date.now()+60000}};
 const encoded=await encodeDiscovery(bundle,seed),pointer=await verifyIPNS(name,encoded.ipns);
 assert.equal(pointer.cid,encoded.cid);assert.deepEqual(await verifyBlock(pointer.cid,encoded.bytes),bundle);
 const altered=Uint8Array.from(encoded.ipns);altered[altered.length-1]^=1;await assert.rejects(verifyIPNS(name,altered));
 await assert.rejects(verifyBlock(encoded.cid,Buffer.from('{}')),/CID mismatch/);
 const other=await namingKey(randomBytes(32));await assert.rejects(verifyIPNS(other.name,encoded.ipns));
});
test('a blocked reader and corrupt block cannot override a verified record or roll back its floor',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'route-discovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const memory=new DurableState(dir),seed=randomBytes(32),{name}=await namingKey(seed);
 const bundle=sequence=>({authorization:{delegation:{ipns:name}},record:{sequence,expiresAt:Date.now()+60000}});
 const old=await encodeDiscovery(bundle(1),seed),fresh=await encodeDiscovery(bundle(2),seed);
 const options={name,memory,readers:[async()=>{throw Error('blocked')},async()=>old.ipns,async()=>fresh.ipns],readBlock:async cid=>cid===fresh.cid?fresh.bytes:old.bytes,verifyBundle:async b=>b.record};
 assert.equal((await resolveDiscovery(options)).sequence,2);
 await assert.rejects(resolveDiscovery({...options,readers:[async()=>old.ipns]}),/no independently verified/);
});
