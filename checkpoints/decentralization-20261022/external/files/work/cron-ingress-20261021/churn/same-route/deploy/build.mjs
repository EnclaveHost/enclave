// Rebuild the public-directory runtime bundle exactly as work/directory-runtime-activation/build.mjs did (same esbuild
// 0.28.1, same options, same entry), from a source tree given on the command line, and record every input.
//   node build.mjs <sourceRoot> <outDir>
// sourceRoot: a git-archive of commit abe86262 (base/) or that archive plus ONE patched file (patched/), with
// node_modules -> work/enclave/node_modules (all 1198 module inputs checked byte-identical to the live build's record).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {build} from '../../../../enclave/node_modules/esbuild/lib/main.js';
const [root,out]=process.argv.slice(2).map(p=>path.resolve(p));
if(!root||!out)throw Error('usage: node build.mjs <sourceRoot> <outDir>');
const sha=b=>createHash('sha256').update(b).digest('hex');
const r=await build({absWorkingDir:root,entryPoints:['network/directory-server.mjs'],bundle:true,platform:'node',format:'esm',target:'node22',minify:true,write:false,metafile:true,banner:{js:'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);'}});
const inputs=Object.keys(r.metafile.inputs).map(f=>{const b=fs.readFileSync(path.resolve(root,f));return {path:f,sha256:sha(b),bytes:b.length};});
const bytes=r.outputFiles[0].contents;
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'enclave-directory.mjs'),bytes);
const result={sourceRoot:path.relative(process.cwd(),root),bundleSha256:sha(bytes),bundleBytes:bytes.length,inputs,
  esbuild:JSON.parse(fs.readFileSync(path.join(root,'node_modules/esbuild/package.json'))).version};
fs.writeFileSync(path.join(out,'build.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({sha256:result.bundleSha256,bytes:bytes.length,inputs:inputs.length,esbuild:result.esbuild}));
