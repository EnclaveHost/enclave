#!/usr/bin/env node
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const outfile=path.resolve(process.argv[2]||path.join(root,'network-runtime.bundle.mjs'));
const result=await build({entryPoints:[path.join(root,'network-runtime.mjs')],outfile,bundle:true,platform:'node',format:'esm',target:'node22',metafile:true,
 banner:{js:'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);'}});
const sha256=createHash('sha256').update(await fs.readFile(outfile)).digest('hex');
await fs.writeFile(outfile+'.manifest.json',JSON.stringify({sha256,inputs:Object.keys(result.metafile.inputs).sort()},null,2)+'\n');
console.log(JSON.stringify({outfile,sha256}));
