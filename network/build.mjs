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
await build({entryPoints:[path.join(root,'circuit-worker.mjs')], outfile:path.join(out,'circuit-worker.mjs'),
  bundle:true, platform:'node', format:'esm', target:'node22',
  banner:{js:'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);'}});
await build({entryPoints:[path.join(root,'privacy-agent.mjs')],outfile:path.join(out,'privacy-agent.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);'}});
await build({entryPoints:[path.join(root,'windows-circuit-worker.mjs')],outfile:path.join(out,'windows-circuit-worker.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);'}});
await build({entryPoints:[path.join(root,'conversion/provider-wallet.mjs')],outfile:path.join(out,'provider-currency-wallet.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);'}});
await build({entryPoints:[path.join(root,'tuna-provider-control.mjs')],outfile:path.join(out,'tuna-provider-control.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);'}});
for (const file of ['Dockerfile.guarded','guarded-entrypoint.sh','public-guard-entrypoint.sh'])fs.copyFileSync(path.join(root,file),path.join(out,file));
for (const [goos, name] of [['linux','enclave-tuna'],['windows','enclave-tuna.exe']])
  execFileSync('go',['build','-trimpath','-o',path.join(out,name),'.'],{
    cwd:path.join(root,'tuna'),stdio:'inherit',env:{...process.env,GOOS:goos,GOARCH:'amd64',CGO_ENABLED:'0'}});
// the pVM phone's host app (Android, arm64): cgo through the NDK's clang, which golang.org/x/mobile/asset needs on Android and
// which gives the adapter Android's own resolver; opt-in, because it needs the NDK (ANDROID_NDK_CC=<ndk>/aarch64-linux-android35-clang)
if (process.env.ANDROID_NDK_CC)
  execFileSync('go',['build','-trimpath','-ldflags=-s -w -buildid=','-o',path.join(out,'enclave-tuna-android-arm64'),'.'],{
    cwd:path.join(root,'tuna'),stdio:'inherit',env:{...process.env,GOOS:'android',GOARCH:'arm64',CGO_ENABLED:'1',CC:process.env.ANDROID_NDK_CC}});
for (const goos of ['linux','windows']) {
  for (const [command,name] of [['route-discovery','enclave-route-discovery'],['provider-inventory','enclave-provider-inventory'],['currency-wallet','enclave-currency-wallet'],['usdc-provider','enclave-usdc-provider']])
    execFileSync('go',['build','-trimpath','-o',path.join(out,name+(goos==='windows'?'.exe':'')),'./cmd/'+command],{cwd:path.join(root,'tuna'),stdio:'inherit',env:{...process.env,GOOS:goos,GOARCH:'amd64',CGO_ENABLED:'0'}});
}
execFileSync('go',['build','-trimpath','-o',path.join(out,'enclave-circuit-firewall.exe'),'.'],{cwd:path.join(root,'windows-firewall'),stdio:'inherit',env:{...process.env,GOOS:'windows',GOARCH:'amd64',CGO_ENABLED:'0'}});
fs.copyFileSync(path.join(root,'Dockerfile'),path.join(out,'Dockerfile'));
console.log(out);
