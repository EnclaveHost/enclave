import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {build} from '../enclave/node_modules/esbuild/lib/main.js';
const root=path.resolve('work/logo-site-hotfix/current'), src=path.resolve('work/logo-site-hotfix/production-current'), site=path.join(root,'site');
if(fs.existsSync(site)) throw Error('candidate already exists');
fs.cpSync(src,site,{recursive:true});
const changed=[];
for(const name of fs.readdirSync(path.join(site,'js/chunks'))){
 if(!name.endsWith('.js'))continue;
 const p=path.join(site,'js/chunks',name),s=fs.readFileSync(p,'utf8');
 if(s.includes('?filename=i.svg')){changed.push(name);fs.writeFileSync(p,s.replaceAll('?filename=i.svg','?filename=enclave-logo.svg'));}
}
if(changed.length===0) throw Error('logo URL absent');
const result=await build({entryPoints:[path.join(site,'js/boot.js')],bundle:true,splitting:true,format:'esm',target:['es2022'],minify:true,sourcemap:true,outdir:site,outbase:site,chunkNames:'js/chunks/[name]-[hash]',external:['https://*','/vendor/*'],write:false,metafile:true});
// Retain every old hashed chunk with its exact original bytes for open older tabs.
for(const name of changed)fs.copyFileSync(path.join(src,'js/chunks',name),path.join(site,'js/chunks',name));
for(const x of result.outputFiles){fs.mkdirSync(path.dirname(x.path),{recursive:true});fs.writeFileSync(x.path,x.contents);}
const oldManifest=JSON.parse(fs.readFileSync('work/control-vm/website-manifest.json'));
const report={builtAt:new Date().toISOString(),patchCommit:'7b89d6b2',sourceSite:'us-west:/opt/enclave-site/site-166bf9d33/site',sourceBootSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(src,'js/boot.js'))).digest('hex'),method:'Rebundle verified production JS with only SVG filename cache-key replacement; preserve old hashed chunks and all non-JS assets.',newOutputs:result.outputFiles.map(x=>({path:path.relative(site,x.path),sha256:crypto.createHash('sha256').update(x.contents).digest('hex')}))};
fs.writeFileSync(path.join(root,'build.json'),JSON.stringify(report,null,2)+'\n');
fs.writeFileSync(path.join(root,'metafile.json'),JSON.stringify(result.metafile,null,2)+'\n');
console.log(JSON.stringify({changedInputs:changed.length,newOutputs:result.outputFiles.length,site}));
