// Additive site release r6: the exact live tree (r5, bafybeigmmbo…slyaq) plus the dashboard graph rebuilt from the r5
// source (the r4 reconstructed source with r5's whole-VM row note) with ONE source file changed (deployments.js: a
// whole-VM app whose version declares endpoints.web gets its address and Open link, the backport of main 154f4f458 in
// backport.py). Same esbuild options and layout as r4's and r5's build.mjs, so every chunk the change does not reach
// comes out byte-identical to the one already served. Only js/boot.js is replaced. No network, no activation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {build, stop} from '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules/esbuild/lib/main.js';
import {loadSiteRelease} from '../production-composite-release-r1/build-composite.mjs';
const p=path.dirname(new URL(import.meta.url).pathname);
const sha=b=>createHash('sha256').update(b).digest('hex');
const R4_SOURCE='/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source/ops/unified-funding-20261028/wallet-release-reader-site-r4/source/enclave';
const CHANGED={'site/components/deployments/deployments.js':'9f31970627016b7de30d1065e100992ffc03e8e26dff423c43663fe74b4ca6f8'};
const BASE_CID='bafybeigmmbopfwmsafgquzaravml6xv66syrrp6hovtegubd5loi7slyaq';
const base='/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/whole-vm-row-site-r5/composite/site';
const before=JSON.parse(fs.readFileSync(p+'/base-files.json'));
function inventory(root){let out={};function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const a=path.join(d,e.name);if(e.isSymbolicLink())throw Error('symlink');if(e.isDirectory())walk(a);else if(e.isFile())out[path.relative(root,a)]=sha(fs.readFileSync(a));else throw Error('special file');}}walk(root);return out;}
function equal(a,b){return Object.keys(a).length===Object.keys(b).length&&Object.entries(a).every(([k,v])=>b[k]===v);}
// the source is the tracked r4 snapshot except the pinned change
const src=inventory(p+'/source/enclave'),ref=inventory(R4_SOURCE);
if(Object.keys(src).length!==Object.keys(ref).length)throw Error('source file set differs from r4');
for(const [n,h] of Object.entries(src)){if(!(n in ref))throw Error('source file not in r4 '+n);if(n in CHANGED){if(h!==CHANGED[n]||ref[n]===h)throw Error('changed source pin '+n);}else if(ref[n]!==h)throw Error('source drift '+n);}
if(!equal(inventory(base),before))throw Error('base changed');
if(fs.existsSync(p+'/build')||fs.existsSync(p+'/composite'))throw Error('new output required');
const site=p+'/source/enclave/site';
const r=await build({entryPoints:[site+'/js/boot.js'],bundle:true,splitting:true,format:'esm',target:['es2022'],minify:true,sourcemap:true,outdir:p+'/build',outbase:site,entryNames:'[dir]/[name]-whole-vm-address-r6',chunkNames:'js/chunks/[name]-[hash]',external:['https://*','/vendor/*'],nodePaths:['/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules'],metafile:true,logLevel:'error'});
if(!Object.keys(r.metafile.inputs).some(n=>n.endsWith('wallet-release-controller.js')))throw Error('migration controller disconnected');
fs.writeFileSync(p+'/build/js/boot.js','export { navigate } from "./boot-whole-vm-address-r6.js";\nimport "./deployment-search-clear-54a35db6e1f0.js";\n');
fs.writeFileSync(p+'/metafile.json',JSON.stringify(r.metafile,null,2)+'\n');
await stop(); // Release the esbuild service before importing the full content-addressed tree.
fs.cpSync(site+'/wallet-release',p+'/build/wallet-release',{recursive:true});
const output=inventory(p+'/build');
const delta=Object.fromEntries(Object.entries(output).filter(([n,h])=>!(n in before)||n==='js/boot.js'||before[n]!==h));
for(const n of Object.keys(delta))if(n in before&&n!=='js/boot.js'&&delta[n]!==before[n])throw Error('unexpected replacement '+n);
fs.mkdirSync(p+'/composite');fs.cpSync(base,p+'/composite/site',{recursive:true});
fs.cpSync(p+'/build',p+'/composite/site',{recursive:true});
const after=inventory(p+'/composite/site');
for(const [n,h]of Object.entries(before))if(n!=='js/boot.js'&&after[n]!==h)throw Error('preservation '+n);
const lib=await loadSiteRelease('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/scripts/site-release');
let imp=lib.importDirectory(p+'/composite/site');
const cid=imp.cid,rows=JSON.stringify(imp.files),car=lib.writeCar(p+'/composite/site.car',cid,imp.blocks);
fs.writeFileSync(p+'/composite/site-root.block',imp.root);imp=null;
const rt=lib.readCar(fs.readFileSync(p+'/composite/site.car'),{expectRoot:cid});
if(JSON.stringify(rt.files)!==rows)throw Error('CAR roundtrip');
if(!equal(inventory(base),before))throw Error('base changed after build');
const result={schema:'enclave-wallet-release-site/1',status:'BUILT_NOT_ACTIVATED',baseCid:BASE_CID,cid,files:after,delta,changedExisting:['js/boot.js'],preservedExisting:Object.keys(before).length-1,car,changedSource:CHANGED,sourceBase:'ops/unified-funding-20261028/wallet-release-reader-site-r4/source/enclave',statement:'Exact live base (r5) plus the r4 reconstructed graph rebuilt with one source file changed from r4: a whole-VM app row shows its address and Open link when its catalog version declares endpoints.web, and the r5 note when it declares none. Only the boot entry is replaced; all other files retained. No contract, grant, wallet, payment or lifecycle change.'};
fs.writeFileSync(p+'/release.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({cid,files:Object.keys(after).length,preserved:result.preservedExisting,delta:Object.keys(delta).length,car}));
