// The standalone GameStream gateway (network/wg-provider/gamestream-gateway-main.mjs) as one file a box runs with node
// alone. The bytes depend only on the sources and the pinned esbuild, so an installer can hold the build to a sha256.
import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkBundle} from '../../network/bundle-checks.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=process.argv[2];
if(!output)throw Error('usage: node scripts/network/build-gamestream-gateway.mjs OUTPUT_DIRECTORY');
await mkdir(output,{recursive:true});
const name='gamestream-gateway.mjs';
const result=await build({absWorkingDir:root,entryPoints:['network/wg-provider/gamestream-gateway-main.mjs'],outfile:name,write:false,bundle:true,platform:'node',format:'esm',target:'node20',minify:true,metafile:true});
const bytes=result.outputFiles[0].contents;
await writeFile(path.join(output,name),bytes);checkBundle(path.join(output,name));
console.log(JSON.stringify({output,file:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),inputs:Object.keys(result.metafile.inputs).sort()}));
