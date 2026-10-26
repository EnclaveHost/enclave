import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkBundle} from './bundle-checks.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || path.join(root, 'dist'));
fs.mkdirSync(out, {recursive:true});
// every bundle is checked once written (network/bundle-checks.mjs): it parses, and no bundled library's command line can run
// inside it; GUARDED: bundled from an entry behind network/main-guard.mjs
const GUARDED = new Set(['entries/privacy-agent.mjs']);
const bundle = async (entry, file) => { await build({entryPoints:[path.join(root,entry)], outfile:path.join(out,file), bundle:true, platform:'node', format:'esm', target:'node22',
  banner:{js:'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);'}}); checkBundle(path.join(out,file), {guarded: GUARDED.has(entry)}); };
// the host's privacy agent and its circuits' ingress worker (the SNI gate each Enclave-network circuit runs; the name is
// historical: Linux hosts run the same worker). The agent is bundled from its entry (network/entries/privacy-agent.mjs):
// a challenge replica with policy carriers loads host-services/runner.mjs into it, whose own command line exited the agent.
await bundle('entries/privacy-agent.mjs', 'privacy-agent.mjs');
await bundle('reconcile-apps.mjs', 'reconcile-apps.mjs');
await bundle('windows-circuit-worker.mjs', 'windows-circuit-worker.mjs');
await bundle('host-service-ingress.mjs', 'host-service-ingress.mjs');
// the Enclave network (docs/design/enclave-network.md): the provider daemon and the checker, one file each
await bundle('wg-provider/main.mjs', 'wg-provider.mjs');
await bundle('../scripts/network/wg-qualify.mjs', 'wg-qualify.mjs');
await bundle('directory-server.mjs', 'enclave-directory.mjs');
// enclave-wg: one WireGuard-in-WireGuard circuit, in-process (no OS interface)
for (const goos of ['linux','windows'])
  execFileSync('go',['build','-trimpath','-o',path.join(out,'enclave-wg'+(goos==='windows'?'.exe':'')),'./cmd/enclave-wg'],{cwd:path.join(root,'wg'),stdio:'inherit',env:{...process.env,GOOS:goos,GOARCH:'amd64',CGO_ENABLED:'0'}});
// the Windows circuits' sandbox: AppContainer + exact WFP rules (tunnel mode for enclave-wg)
execFileSync('go',['build','-trimpath','-o',path.join(out,'enclave-circuit-firewall.exe'),'.'],{cwd:path.join(root,'windows-firewall'),stdio:'inherit',env:{...process.env,GOOS:'windows',GOARCH:'amd64',CGO_ENABLED:'0'}});
console.log(out);
