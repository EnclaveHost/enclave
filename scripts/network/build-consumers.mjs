// Standalone host/provider artifacts need CommonJS built-ins used by bundled ws.
import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkBundle} from '../../network/bundle-checks.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=process.argv[2];
if(!output)throw Error('usage: node scripts/network/build-consumers.mjs OUTPUT_DIRECTORY');
await mkdir(output,{recursive:true});
const files={};
// the privacy agent and DNS are bundled from their guarded entries (network/main-guard.mjs, host-services/argv-guard.mjs):
// inside one bundle a bundled library's "main script" check fires (dns.mjs ran the host-identity command line and exited)
const guarded=new Set(['privacy-agent.mjs','dns.mjs']);
for(const [name,entry] of Object.entries({'provider.mjs':'network/wg-provider/main.mjs','privacy-agent.mjs':'network/entries/privacy-agent.mjs','checker.mjs':'scripts/network/wg-qualify.mjs','dns.mjs':'network/host-services/entries/route-dns.mjs'})){
 // the banner's names are opaque to esbuild: unique, so no bundled module's own top-level import (relay/network-runtime.bundle.mjs
 // imports createRequire as bundleRequire) can collide with them
 const result=await build({absWorkingDir:root,entryPoints:[entry],outfile:name,write:false,bundle:true,platform:'node',format:'esm',target:'node20',minify:true,metafile:true,
  banner:{js:'import {createRequire as __enclaveConsumerCreateRequire} from "node:module"; const require=__enclaveConsumerCreateRequire(import.meta.url);'}});
 const bytes=result.outputFiles[0].contents;
 await writeFile(path.join(output,name),bytes);checkBundle(path.join(output,name),{guarded:guarded.has(name)});
 files[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),inputs:Object.keys(result.metafile.inputs).sort()};
}
await writeFile(path.join(output,'build-manifest.json'),JSON.stringify({files},null,2)+'\n');
console.log(JSON.stringify({output,files:Object.fromEntries(Object.entries(files).map(([k,v])=>[k,{sha256:v.sha256,bytes:v.bytes}]))}));
