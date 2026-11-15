// The agent's ingress thread (network/ingress-thread.mjs) as one file that sits beside a bundled agent
// (network/ingress-thread-host.mjs looks for ./ingress-thread.mjs there). The bytes depend only on the sources and the
// pinned esbuild.
import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=process.argv[2];
if(!output)throw Error('usage: node scripts/network/build-ingress-thread.mjs OUTPUT_DIRECTORY');
await mkdir(output,{recursive:true});
const name='ingress-thread.mjs';
const result=await build({absWorkingDir:root,entryPoints:['network/ingress-thread.mjs'],outfile:name,write:false,bundle:true,platform:'node',format:'esm',target:'node20',metafile:true,
  banner:{js:'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);'}});
const bytes=result.outputFiles[0].contents;
await writeFile(path.join(output,name),bytes);execFileSync(process.execPath,['--check',path.join(output,name)]);
console.log(JSON.stringify({output,file:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),inputs:Object.keys(result.metafile.inputs).sort()}));
