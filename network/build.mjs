import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || path.join(root, 'dist'));
fs.mkdirSync(out, {recursive:true});
await build({entryPoints:[path.join(root,'agent.mjs')], outfile:path.join(out,'agent.mjs'),
  bundle:true, platform:'node', format:'esm', target:'node22',
  banner:{js:'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);'}});
for (const [goos, name] of [['linux','enclave-tuna'],['windows','enclave-tuna.exe']])
  execFileSync('go',['build','-trimpath','-o',path.join(out,name),'.'],{
    cwd:path.join(root,'tuna'),stdio:'inherit',env:{...process.env,GOOS:goos,GOARCH:'amd64',CGO_ENABLED:'0'}});
fs.copyFileSync(path.join(root,'Dockerfile'),path.join(out,'Dockerfile'));
console.log(out);
