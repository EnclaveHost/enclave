import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {build} from '../enclave/node_modules/esbuild/lib/main.js';
const root=path.resolve('work/enclave'), out=path.resolve('work/directory-runtime-activation');
const sha=b=>createHash('sha256').update(b).digest('hex');
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const r=await build({absWorkingDir:root,entryPoints:['network/directory-server.mjs'],bundle:true,platform:'node',format:'esm',target:'node22',minify:true,write:false,metafile:true,banner:{js:'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);'}});
const inputs=[];
for(const [f,m] of Object.entries(r.metafile.inputs)){
 const abs=path.resolve(root,f), b=fs.readFileSync(abs);
 let committed=null;
 if(!f.includes('node_modules/')){
  const committedBytes=execFileSync('git',['show',head+':'+f],{cwd:root});
  if(!b.equals(committedBytes))throw Error('uncommitted source dependency: '+f);
  committed=true;
 }
 inputs.push({path:f,sha256:sha(b),bytes:b.length,committed});
}
const bytes=r.outputFiles[0].contents;
fs.writeFileSync(path.join(out,'enclave-directory.mjs'),bytes);
const result={sourceCommit:head,bundleSha256:sha(bytes),bundleBytes:bytes.length,inputs,esbuild:JSON.parse(fs.readFileSync(path.join(root,'node_modules/esbuild/package.json'))).version,builtAt:new Date().toISOString()};
fs.writeFileSync(path.join(out,'build.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({sourceCommit:head,sha256:result.bundleSha256,bytes:bytes.length,sourceFiles:inputs.filter(x=>x.committed).length,totalInputs:inputs.length}));
