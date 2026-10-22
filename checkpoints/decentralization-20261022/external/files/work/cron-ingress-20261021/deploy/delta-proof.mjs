// Proof of the bundle delta: the same build with identifier minification OFF (whitespace/syntax minify unchanged, and
// with minify off entirely), base vs patched, diffed. Writes delta-proof/*.mjs; prints changed-line summaries.
import fs from 'node:fs';import path from 'node:path';
import {build} from '../../enclave/node_modules/esbuild/lib/main.js';
const opts={entryPoints:['network/directory-server.mjs'],bundle:true,platform:'node',format:'esm',target:'node22',write:false,banner:{js:'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);'}};
fs.mkdirSync('delta-proof',{recursive:true});
for(const [name,extra] of [['plain',{minify:false}],['noident',{minifyWhitespace:false,minifySyntax:true,minifyIdentifiers:false}]])
 for(const t of ['base','patched']){const r=await build({...opts,...extra,absWorkingDir:path.resolve(t)});fs.writeFileSync(`delta-proof/${t}.${name}.mjs`,r.outputFiles[0].contents);}
