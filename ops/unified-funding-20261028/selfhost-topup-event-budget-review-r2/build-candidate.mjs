import {build} from '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules/esbuild/lib/main.js';
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const p=path.dirname(new URL(import.meta.url).pathname),origin=path.join(p,'../selfhost-topup-r1-20261029'),site=path.join(origin,'reconstructed/enclave/site');
const sha=b=>createHash('sha256').update(b).digest('hex');
const baseline=JSON.parse(fs.readFileSync(origin+'/reconstructed-sources.json'));
for(const [name,pin]of Object.entries(baseline)){if(sha(fs.readFileSync(origin+'/reconstructed/'+name))!==pin)throw Error('baseline source changed '+name);}
const candidate=fs.readFileSync(p+'/reviewed/deployments.js','utf8');
const helper=fs.readFileSync(p+'/reviewed/selfhost-gas-topup.js','utf8');
const plugin={name:'only-reviewed-topup',setup(b){
 b.onLoad({filter:/components\/deployments\/deployments\.js$/},()=>({contents:candidate,loader:'js'}));
 b.onResolve({filter:/selfhost-gas-topup\.js$/},()=>({path:'selfhost-gas-topup.js',namespace:'topup'}));
 b.onLoad({filter:/.*/,namespace:'topup'},()=>({contents:helper,loader:'js',resolveDir:site+'/js/core'}));
}};
const r=await build({entryPoints:[site+'/js/boot.js'],bundle:true,splitting:true,format:'esm',target:['es2022'],minify:true,sourcemap:true,outdir:p+'/candidate-build',outbase:site,entryNames:'[dir]/[name]-selfhost-event-budget-r2',chunkNames:'js/chunks/[name]-[hash]',external:['https://*','/vendor/*'],nodePaths:['/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules'],plugins:[plugin],metafile:true});
fs.writeFileSync(p+'/candidate-metafile.json',JSON.stringify(r.metafile,null,2));
fs.writeFileSync(p+'/candidate-build/js/boot.js','export { navigate } from "./boot-selfhost-event-budget-r2.js";\n');
console.log('PASS candidate build',Object.keys(r.metafile.inputs).length,Object.keys(r.metafile.outputs).length);
