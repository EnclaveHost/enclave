// Pure generator and syntax checks only. No chain, authority, signing or deployed-code qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {generateAdapterCandidate,R6_ADAPTER_SHA256} from '../src/tools/generate-lifecycle-adapter-candidate.mjs';
import {sha256} from '../src/tools/insertion-patch.mjs';
const baseline=fs.readFileSync(new URL('../../../lifecycle-chain-adapter-stage/r6/network/deployment-chain-adapter.mjs',import.meta.url),'utf8');
test('actual r6 adapter generator preserves every source byte and produces valid JavaScript',t=>{
 const r=generateAdapterCandidate(baseline);
 assert.equal(sha256(baseline),R6_ADAPTER_SHA256);
 let restored='',from=0;
 for(const m of r.manifest){restored+=r.source.slice(from,m.candidateOffset);from=m.candidateOffset+m.length;}
 restored+=r.source.slice(from);assert.equal(restored,baseline);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'root-r3-adapter-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'adapter.mjs');fs.writeFileSync(file,r.source);
 const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);
});
test('actual r6 adapter generator rejects changed input and reapplication',()=>{
 assert.throws(()=>generateAdapterCandidate(baseline+'\n'),/hash/);
 const r=generateAdapterCandidate(baseline);
 assert.throws(()=>generateAdapterCandidate(r.source),/hash|already/);
});
