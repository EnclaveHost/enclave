import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const P=path.dirname(fileURLToPath(import.meta.url)), W=path.dirname(P);
const base=path.join(W,'g4-network-composition-20261021/src');
const {build}=await import(path.join(base,'node_modules/esbuild/lib/main.js'));
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const live=JSON.parse(fs.readFileSync(path.join(W,'g4-network-composition-20261021/out/build-manifest.json'))).g4;
const report={};
for(const name of ['privacy-agent.mjs','windows-circuit-worker.mjs','host-service-ingress.mjs']) {
  let baselineInputs;
  for(const mode of ['baseline','candidate']) {
    const tree=mode==='baseline'?base:path.join(P,'src');
    const out=path.join(P,mode,name);fs.mkdirSync(path.dirname(out),{recursive:true});
    const r=await build({entryPoints:[path.join(tree,'network',name)],outfile:out,absWorkingDir:tree,bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'error',metafile:true,
      banner:{js:'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);'}});
    const inputs=Object.fromEntries(Object.keys(r.metafile.inputs).sort().map(i=>[i,sha(path.resolve(tree,i))]));
    execFileSync(process.execPath,['--check',out]);
    if(mode==='baseline') {
      assert.equal(sha(out),live[name].sha256,'must reproduce live '+name);
      assert.deepEqual(inputs,JSON.parse(fs.readFileSync(path.join(W,'g4-network-composition-20261021/out/g4',name+'.inputs.json'))));
      baselineInputs=inputs;
    } else {
      const changes=[...new Set([...Object.keys(inputs),...Object.keys(baselineInputs)])].sort().filter(k=>inputs[k]!==baselineInputs[k]);
      assert.deepEqual(changes,name==='privacy-agent.mjs'?['network/challenge-replica-host.mjs','network/enclave-network-host.mjs']:[]);
      if(name!=='privacy-agent.mjs')assert.equal(sha(out),live[name].sha256);
      fs.writeFileSync(out+'.inputs.json',JSON.stringify(inputs,null,2)+'\n');
      report[name]={baselineSha256:live[name].sha256,candidateSha256:sha(out),bytes:fs.statSync(out).size,inputCount:Object.keys(inputs).length,changedInputs:changes};
      console.log(JSON.stringify({name,...report[name]}));
    }
  }
}
fs.writeFileSync(path.join(P,'build-result.json'),JSON.stringify(report,null,2)+'\n');
