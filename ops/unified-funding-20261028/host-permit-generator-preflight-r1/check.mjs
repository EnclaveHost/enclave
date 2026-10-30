import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyInsertions} from '../host-registry-repair-root-review-r3/src/tools/insertion-patch.mjs';
import {EDITS,INPUT_SHA256,MARKER} from './generator.mjs';
const p=path.dirname(fileURLToPath(import.meta.url));let failed=0;
for(const [file,edits] of Object.entries(EDITS)){
 try {const r=applyInsertions(fs.readFileSync(path.join(p,'inputs',file),'utf8'),{expectedSha256:INPUT_SHA256[file],edits,marker:MARKER,what:file});fs.writeFileSync(path.join(p,'outputs',file),r.source,{flag:'wx'});console.log(JSON.stringify({file,ok:true,sha256:r.sha256}));}
 catch(e){failed++;console.log(JSON.stringify({file,ok:false,error:e.message}));}
}
console.log(JSON.stringify({total:5,failed}));process.exitCode=failed?1:0;
