#!/usr/bin/env bash
# Rebuild enclave-directory.mjs with the EXACT recipe that produced the deployed runtime-cb9ff18
# (work/directory-runtime-activation/build.mjs: absWorkingDir repo root, minify, __cr banner), for:
#   deployed     = git abe86262 (source of cb9ff18): must reproduce cb9ff183...
#   deployedfix  = deployed + the writer's route-record patch (rebased, offset -6)
#   mainfix      = main + the writer's route-record.mjs (9ba9f6d3)
# Also compares every bundle input's sha256 with the deployed build.json (dependency drift).
set -uo pipefail
B=/home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-review-20261021/build
J=/home/steven/Documents/Codex/2026-10-18/wo/work/directory-runtime-activation/build.json
for v in deployed deployedfix mainfix; do
  cd "$B/$v" && node --input-type=module -e "
import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto';
import {build} from './node_modules/esbuild/lib/main.js';
const root=process.cwd(), sha=b=>createHash('sha256').update(b).digest('hex');
const r=await build({absWorkingDir:root,entryPoints:['network/directory-server.mjs'],bundle:true,platform:'node',format:'esm',target:'node22',minify:true,write:false,metafile:true,banner:{js:'import { createRequire as __cr } from \"node:module\"; const require = __cr(import.meta.url);'}});
const bytes=r.outputFiles[0].contents; fs.mkdirSync('out',{recursive:true}); fs.writeFileSync('out/enclave-directory.mjs',bytes);
const dep=JSON.parse(fs.readFileSync('$J','utf8')), depIn=new Map(dep.inputs.map(i=>[i.path,i.sha256]));
const mine=Object.keys(r.metafile.inputs).map(f=>[f,sha(fs.readFileSync(path.resolve(root,f)))]);
const changed=mine.filter(([f,h])=>depIn.get(f)!==h).map(([f])=>f), gone=[...depIn.keys()].filter(f=>!r.metafile.inputs[f]);
fs.writeFileSync('out/inputs-vs-deployed.json',JSON.stringify({changed,gone},null,1));
console.log('$v', sha(bytes), bytes.length, 'inputs', mine.length, 'differ-from-deployed', changed.length, JSON.stringify(changed.slice(0,8)), 'missing', gone.length);
" || echo "$v BUILD FAILED"
done
