import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const P=path.dirname(fileURLToPath(import.meta.url));const tree=path.resolve(P,'../../g4-network-composition-20261021/src');const {build}=await import(path.join(tree,'node_modules/esbuild/lib/main.js'));
const out=path.join(P,'check.bundle.mjs');const r=await build({entryPoints:[path.join(P,'check.mjs')],outfile:out,absWorkingDir:P,bundle:true,platform:'node',format:'esm',target:'node22',metafile:true,banner:{js:'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);'}});
execFileSync(process.execPath,['--check',out]);
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const inputs=Object.fromEntries(Object.keys(r.metafile.inputs).sort().map(p=>[p,sha(path.resolve(P,p))]));
fs.writeFileSync(path.join(P,'inputs.json'),JSON.stringify(inputs,null,2)+'\n');console.log(JSON.stringify({sha256:sha(out),inputs:Object.keys(inputs).length}));
