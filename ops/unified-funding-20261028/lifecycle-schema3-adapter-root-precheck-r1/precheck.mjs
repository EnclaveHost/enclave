import fs from 'node:fs';
import { generateSchema3Candidate,R6_ADAPTER_PATH,BUNDLE_PATH } from './src/tools/generate-lifecycle-schema3-adapter-candidate.mjs';
const r = generateSchema3Candidate(fs.readFileSync(R6_ADAPTER_PATH,'utf8'),fs.readFileSync(BUNDLE_PATH));
fs.writeFileSync(new URL('./generated.mjs',import.meta.url),r.source,{flag:'wx'});
console.log(JSON.stringify({sha256:r.sha256,baseline:r.baselineSha256,insertions:r.manifest.length}));
