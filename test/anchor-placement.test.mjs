import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const source=join(root,'metal/shielded-overlay/calib/qwen3.5-0.8b-mtp-gguf.calib');
const script=join(root,'shielded/anchor/avf/calib-profile.py');
const run=(cmd,args)=>{
  const result=spawnSync(cmd,args,{encoding:'utf8',timeout:60_000});
  assert.equal(result.status,0,result.stdout+result.stderr); return result;
};
test('placement profiles retain exact calibration data and pin every GPU group member without pinning local families',()=>{
  const dir=mkdtempSync(join(tmpdir(),'anchor-placement-'));
  try {
    const original=readFileSync(source,'utf8');
    const originalSites=original.split('\n').filter(l=>l.startsWith('site '));
    const bin=join(dir,'test');
    run('c++',['-O1','-g','-std=c++17','-fsanitize=address,undefined','-I',join(root,'shielded/anchor/avf/payload'),
      join(root,'test/fixtures/anchor-placement.cpp'),'-o',bin]);
    for(const profile of ['local-output','gpu-ffn']) {
      const output=join(dir,profile+'.calib');
      run('python3',[script,source,output,'--profile',profile]);
      const bytes=readFileSync(output,'utf8');
      const sites=bytes.split('\n').filter(l=>l.startsWith('site '));
      assert.equal(sites.length,profile==='local-output'?48:24);
      assert.deepEqual(sites,originalSites.filter(l=>sites.includes(l)),'original order and outliers retained exactly');
      assert.ok(!bytes.includes('site token_embd.weight'));
      assert.match(run(bin,[output,profile]).stdout,/anchor-placement: ok/);
      run('python3',[script,source,output,'--profile',profile]);
      assert.equal(readFileSync(output,'utf8'),bytes,'profile bytes/digest reproducible');
    }
    assert.equal(readFileSync(source,'utf8'),original);
    const refuses=spawnSync('python3',[script,source,source,'--profile','local-output'],{encoding:'utf8'});
    assert.notEqual(refuses.status,0); assert.equal(readFileSync(source,'utf8'),original);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
