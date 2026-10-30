import { build } from '../../../source/node_modules/esbuild/lib/main.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../full-site-build');
const result=await build({absWorkingDir:root,entryPoints:['site/js/boot.js'],bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2022',external:['https://*','/vendor/*'],outdir:'router-smoke',write:false,metafile:true});
if(!Object.keys(result.metafile.inputs).some(x=>x==='site/js/pages/funding.js')) throw new Error('Funding page absent from router graph');
console.log(JSON.stringify({outputs:result.outputFiles.length,inputs:Object.keys(result.metafile.inputs).length,fundingPage:true,scope:'router module graph only; not full production site build'}));
