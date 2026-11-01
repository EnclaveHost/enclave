import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {verifyPackage,preparePackage} from '../sdk/bootstrap/package.mjs';
const base=JSON.parse(fs.readFileSync(new URL('../isolation/m2/bootstrap/testdata/vectors.json',import.meta.url))).manifest;
const cases=JSON.parse(fs.readFileSync(new URL('../isolation/m2/bootstrap/testdata/rpc-storage-vectors.json',import.meta.url)));
for(const c of cases)test('RPC authority policy: '+c.name,()=>{
 const raw=Buffer.from(base.slice(0,-1)+',"rpcStorage":'+c.raw+'}');
 const intent={version:1,sha256:createHash('sha256').update(raw).digest('hex')};
 if(c.valid){const p=verifyPackage(raw,intent);assert.deepEqual(p.manifest.rpcStorage,JSON.parse(c.raw));}
 else assert.throws(()=>verifyPackage(raw,intent));
});
test('old package bytes unchanged and new policy requires a new owner commitment',()=>{
 assert.equal(preparePackage(JSON.parse(base)).bytes.toString(),base);
 const old={version:1,sha256:createHash('sha256').update(base).digest('hex')};
 const raw=Buffer.from(base.slice(0,-1)+',"rpcStorage":'+cases[0].raw+'}');
 assert.throws(()=>verifyPackage(raw,old),/hash/);
});
