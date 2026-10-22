// Which deployable bundles a source change reaches (work/challenge-host-tls-20261021). esbuild with write:false and a
// metafile, from THIS tree, for every entry of the existing recipes: network/build.mjs (privacy agent, circuit/ingress
// workers, wg-provider, directory), build-stage-g3.mjs (hs2 runner + stage-tool bins), build-host-service-packages.mjs
// (one per host role) and build-challenge-replica-release.mjs (dns.mjs, challenge-host.mjs). No artifact is written.
//   node analyze-bundles.mjs
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const TREE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tree');
const {build} = await import(pathToFileURL(path.join(TREE, 'node_modules/esbuild/lib/main.js')).href);
const {ROLES} = await import(pathToFileURL(path.join(TREE, 'network/host-services/roles.mjs')).href);
const CHANGED = ['network/host-service-names.mjs', 'network/challenge-front-declaration.mjs', 'network/challenge-replica-host.mjs', 'network/enclave-network-host.mjs',
  'network/host-services/service-tls.mjs', 'network/host-service-transport.mjs', 'network/wg-provider/provider.mjs', 'network/wg-provider/host-services-config.mjs',
  'network/host-services/stage-tool.mjs'];
const entries = [
  ['network bundle: privacy-agent.mjs (605 network package)', 'network/privacy-agent.mjs'],
  ['network bundle: reconcile-apps.mjs', 'network/reconcile-apps.mjs'],
  ['network bundle: windows-circuit-worker.mjs', 'network/windows-circuit-worker.mjs'],
  ['network bundle: host-service-ingress.mjs (service circuit worker)', 'network/host-service-ingress.mjs'],
  ['network bundle: wg-provider.mjs (fronts)', 'network/wg-provider/main.mjs'],
  ['network bundle: enclave-directory.mjs', 'network/directory-server.mjs'],
  ['hs2 bin: host-services-runner.mjs', 'network/host-services/runner.mjs'],
  ['hs2 bin: stage-tool.mjs', 'network/host-services/entries/stage-tool.mjs'],
  ...Object.entries(ROLES).map(([role, r]) => [`hs2 package: ${role}`, r.bundleEntry || r.entry]),
  ['challenge release: dns.mjs (pinned dnsSha256)', 'relay/dns-relay.js'],
  ['challenge release: challenge-host.mjs (CLI, not pinned by the config)', 'network/challenge-replica-cli.mjs'],
];
const external = {name: 'ext', setup(b) { b.onResolve({filter: /network-runtime\.bundle\.mjs$/}, (a) => ({path: a.path, external: true})); }};
for (const [what, entry] of entries) {
  try {
    const r = await build({absWorkingDir: TREE, entryPoints: [entry], write: false, metafile: true, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [external]});
    const hit = CHANGED.filter((f) => Object.hasOwn(r.metafile.inputs, f));
    console.log(`${hit.length ? 'REBUILD' : 'unchanged'}  ${what}${hit.length ? '  <- ' + hit.map((f) => path.basename(f)).join(', ') : ''}`);
  } catch (e) { console.log(`ERROR  ${what}: ${String(e.message).split('\n')[0]}`); }
}
