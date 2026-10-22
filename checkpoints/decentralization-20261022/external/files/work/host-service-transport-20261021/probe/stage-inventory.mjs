// The network/ artefacts a Windows stage (windows/installer/stage-bundle.sh) and a provider install take from network/build.mjs,
// built from the TREE with the same esbuild settings, WITHOUT build.mjs's Go steps (enclave-wg comes from go-job2; the
// production enclave-circuit-firewall.exe is unchanged and not rebuilt). Then: the bundled host-service worker runs as a
// LONE file (as the Windows runtime copies it into each circuit directory), and the bundled provider prints --ruleset.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process'; import { createHash } from 'node:crypto'; import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const H = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), N = path.join(H, 'tree/network'), OUT = path.join(H, 'stage/network');
const { build } = await import(path.join(H, 'tree/node_modules/esbuild/lib/main.js'));
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const bundle = (entry, file) => build({ entryPoints: [path.join(N, entry)], outfile: path.join(OUT, file), bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'error',
  banner: { js: 'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);' } });
for (const [e, f] of [['privacy-agent.mjs', 'privacy-agent.mjs'], ['windows-circuit-worker.mjs', 'windows-circuit-worker.mjs'], ['host-service-ingress.mjs', 'host-service-ingress.mjs'], ['wg-provider/main.mjs', 'wg-provider.mjs']]) await bundle(e, f);
for (const f of ['enclave-wg', 'enclave-wg.exe']) if (fs.existsSync(path.join(H, 'probe/bin', f))) fs.copyFileSync(path.join(H, 'probe/bin', f), path.join(OUT, f));
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const inv = fs.readdirSync(OUT).sort().map((f) => `${sha(path.join(OUT, f))}  ${f}  ${fs.statSync(path.join(OUT, f)).size}`);
fs.writeFileSync(path.join(H, 'stage/INVENTORY.sha256'), inv.join('\n') + '\n'); console.log(inv.join('\n'));
// the worker bundle ALONE in a fresh directory (no node_modules, no tree): ready line + one routed request
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lone-worker-')), w = path.join(d, 'worker.mjs'); fs.copyFileSync(path.join(OUT, 'host-service-ingress.mjs'), w);
const free = async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const role = net.createServer((c) => c.once('data', (b) => c.end('role:' + b.toString().split('\r\n')[0]))); await new Promise((r) => role.listen(0, '127.0.0.1', r));
const name = 'dir-' + 'a'.repeat(52) + '.app.enclave.host', tlsPort = await free(), httpPort = await free();
fs.writeFileSync(path.join(d, 'worker.json'), JSON.stringify({ names: { [name]: { http: role.address().port, tls: null } }, tlsPort, httpPort }));
const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', w, path.join(d, 'worker.json')], { cwd: d, stdio: ['pipe', 'pipe', 'pipe'] });
let err = ''; child.stderr.on('data', (b) => { err += b; });
const ready = await new Promise((ok) => { const t = setTimeout(() => ok(null), 8000); createInterface({ input: child.stdout }).once('line', (l) => { clearTimeout(t); ok(JSON.parse(l)); }); });
const got = ready ? await new Promise((ok) => { const c = net.connect(httpPort, '127.0.0.1', () => c.write(`GET /x HTTP/1.1\r\nHost: ${name}\r\n\r\n`)); let o = ''; c.on('data', (b) => { o += b; }); c.on('close', () => ok(o)); c.on('error', () => ok(o)); }) : '';
child.stdin.write('{"type":"stop"}\n'); role.close(); fs.rmSync(d, { recursive: true, force: true });
const loneOk = ready?.type === 'ready' && ready.ingress === tlsPort && got === 'role:GET /x HTTP/1.1';
console.log(loneOk ? 'PASS the bundled host-service worker runs as a lone file and routes its name' : `FAIL lone worker: ${JSON.stringify(ready)} ${got} ${err.slice(0, 300)}`);
// the bundled provider: --ruleset of a DNS config (no kernel, no key read)
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-cfg-')), cfgFile = path.join(cfgDir, 'p.json');
fs.writeFileSync(cfgFile, JSON.stringify({ bootstrap: 'explicit', operatorKeyFile: '/nonexistent', publicAddress: '203.0.113.7', uplink: 'eth0', roles: ['guard', 'ingress', 'egress'], rpc: ['https://a.example', 'https://b.example'],
  directories: ['https://dir.example/'], authorityPins: { deployments: '0x' + '11'.repeat(20), registry: '0x' + '22'.repeat(20), connectivity: '0x' + '0'.repeat(40), sessionVaultFactory: '0x' + '0'.repeat(40) },
  checkers: ['0x' + '33'.repeat(20)], zone: 'app.example', probeZone: 'probe.example', pricePerGiB6: 0, hostServices: { zone: 'app.example', platformHostPolicy: 'production', dns: { hosts: ['0x' + 'a1'.repeat(32)] } } }));
const rs = spawnSync(process.execPath, [path.join(OUT, 'wg-provider.mjs'), '--ruleset', cfgFile], { encoding: 'utf8' }); fs.rmSync(cfgDir, { recursive: true, force: true });
const rulesOk = rs.status === 0 && /dnat ip to udp dport map @dns_dnat/.test(rs.stdout);
console.log(rulesOk ? 'PASS the bundled provider prints the DNS ruleset (--ruleset)' : `FAIL bundled --ruleset: ${rs.status} ${rs.stderr.slice(0, 300)}`);
process.exit(loneOk && rulesOk ? 0 : 1);
