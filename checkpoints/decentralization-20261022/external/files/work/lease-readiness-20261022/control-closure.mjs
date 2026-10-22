import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {build} from '../enclave/node_modules/esbuild/lib/main.js';
const dir=path.dirname(fileURLToPath(import.meta.url)), root=path.join(dir,'tree');
const entries=fs.readFileSync(path.resolve(dir,'../g4-control-merged-20261021/tools/entries.txt'),'utf8').trim().split(/\s+/);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const inputs=new Set(),results=[];
for(const entry of entries){
 const r=await build({absWorkingDir:root,entryPoints:[entry],bundle:true,write:false,preserveSymlinks:true,platform:'node',format:'esm',target:'node20',packages:'external',metafile:true,logLevel:'silent',outdir:'/nonexistent-never-written'});
 const files=Object.keys(r.metafile.inputs);results.push({entry,inputs:files.length,warnings:r.warnings.map(x=>x.text)});
 for(const f of files){if(path.isAbsolute(f)||f.startsWith('../'))throw Error('source escapes package: '+f); inputs.add(f);}
}
const baseline=path.resolve(dir,'../g4-control-merged-20261021/live-ref/live/control');
const manifest=[];
for(const name of [...inputs].sort()){
 const source=path.join(root,name), bytes=fs.readFileSync(source), live=path.join(baseline,name);
 const old=fs.existsSync(live)?sha(fs.readFileSync(live)):'absent',current=sha(bytes);
 manifest.push({name,sha256:current,recordedLiveSha256:old,changed:old!==current});
}
fs.writeFileSync(path.join(dir,'control-closure.json'),JSON.stringify({entries:results,files:manifest,scope:'Static named-export/relative-import closure over candidate source; npm dependencies external; recorded live snapshot requires refresh before activation.'},null,2)+'\n');
console.log(JSON.stringify({entries:results.length,sourceFiles:manifest.length,changed:manifest.filter(x=>x.changed).map(x=>x.name)}));
