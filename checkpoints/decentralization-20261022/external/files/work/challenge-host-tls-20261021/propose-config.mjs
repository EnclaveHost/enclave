// REVIEWABLE production configuration for the challenge origin (work/challenge-host-tls-20261021). Writes nothing outside
// --out; edits no live or other worker's file. From the LIVE G3 hs2 config (47f3e1f5, orders "held") it derives:
//   1. host-services.json: the same bytes' content + service-tls.challenge (orders stay exactly as they are: "held");
//   2. agent-fragment.json: what 605's network package must add (enclaveNetwork.hostServices.tls.challengePort and the
//      managed challengeReplica.front) - a fragment for review, not an edit of that package;
//   3. provider-fragment.json: hostServices.challenge on each exit that carries this host;
//   4. names.json: the derived names (three roles unchanged + the challenge origin).
// Every output is validated with THIS tree's own validators (runner binding, G1 transport, provider config, the managed
// front's derivation). The challenge replica release does not exist yet: --release-manifest must be the
// dns.mjs.manifest.json of a reviewed scripts/build-challenge-replica-release.mjs build; without it the run refuses.
//   node propose-config.mjs --base <host-services.json> --release-manifest <dns.mjs.manifest.json> --out <dir>
//     [--tls-port 18291] [--front-port 18292] [--declaration C:\ProgramData\Enclave\network\challenge\challenge-front.json]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const TREE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tree');
const imp = (p) => import(path.join(TREE, p));
const {validateHostServicesConfig} = await imp('network/host-services/runner.mjs');
const {ingressPorts} = await imp('network/host-services/service-tls.mjs');
const {validateHostServicesTransport} = await imp('network/host-service-transport.mjs');
const {hostServiceNames, hostChallengeName} = await imp('network/host-service-names.mjs');
const {providerHostServices} = await imp('network/wg-provider/host-services-config.mjs');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('--base'), manifest = arg('--release-manifest'), out = arg('--out');
if (!base || !out) { console.error('usage: propose-config.mjs --base <host-services.json> --release-manifest <dns.mjs.manifest.json> --out <dir>'); process.exit(2); }
if (!manifest) { console.error('REFUSED: --release-manifest is required (no reviewed challenge replica release exists yet; its pins cannot be invented)'); process.exit(3); }
const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
const release = {dnsSha256: String(m.sha256), runtimeBundleSha256: String(m.runtimeBundleSha256)};
const tlsPort = Number(arg('--tls-port', 18291)), frontPort = Number(arg('--front-port', 18292));
const declarationFile = arg('--declaration', 'C:\\ProgramData\\Enclave\\network\\challenge\\challenge-front.json');

const raw = fs.readFileSync(base, 'utf8'), cfg = JSON.parse(raw);
const st = cfg.services.find((s) => s.role === 'service-tls');
if (!st) { console.error('REFUSED: the base has no service-tls role (G3 first)'); process.exit(3); }
const proposed = structuredClone(cfg);
proposed.services.find((s) => s.role === 'service-tls').config.challenge = {tlsPort, frontPort, declarationFile, release};
// the runner's own binding (ports against every role, policy not "off", host id = keccak256(endpoint)); orders unchanged.
// Off Windows, Windows absolute paths are mapped to POSIX form for THIS structural check only (C:\\a\\b -> /C/a/b); the
// written file keeps the Windows paths, and the runner on the host validates them itself when it binds the config.
const posix = (v) => (typeof v === 'string' && /^[A-Za-z]:\\/.test(v) ? '/' + v[0] + '/' + v.slice(3).replace(/\\/g, '/') : Array.isArray(v) ? v.map(posix)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, posix(x)])) : v);
const checkable = process.platform === 'win32' ? proposed : posix(proposed);
const bound = validateHostServicesConfig(checkable).services.find((s) => s.role === 'service-tls').config;
if (bound.orders !== st.config.orders) throw new Error('orders changed');
const ip = ingressPorts(bound);
const zone = bound.zone, hostId = bound.hostId;
const names = {...hostServiceNames(hostId, zone), 'app-zone-replica (challenge origin)': hostChallengeName(hostId, zone)};
// 605's agent: G1 hostServices gains tls.challengePort (validated as G1 does); the managed front listens on frontPort
const agentTls = {...ip.tls};
validateHostServicesTransport({zone, exits: ['0'.repeat(16)], ports: ip.ports, tls: agentTls});
const agent = {enclaveNetwork: {hostServices: {'...': 'unchanged (zone, exits, ports, dns)', tls: agentTls},
  challengeReplica: {'...': 'the full app-zone-replica block (release, zones, ns, listen, routeMap, chain, shield, upstream, hostPolicy) - FINAL-DNS-TRANSITION.txt M1',
    front: {listen: `127.0.0.1:${frontPort}`, managed: {zone, declarationFile}}, release: {dir: '<the reviewed release dir>', ...release},
    hostPolicy: {policy: 'production', endpoint: cfg.host.endpoint, stateDir: '<network state>\\challenge-host-policy'}}}};
const provider = {hostServices: {'...': 'unchanged (zone, platformHostPolicy, mirrors, rpcs, maxHosts, dns)', challenge: true}};
providerHostServices({zone, platformHostPolicy: 'production', challenge: true}, {roles: ['ingress']});
fs.mkdirSync(out, {recursive: true});
const w = (f, o) => fs.writeFileSync(path.join(out, f), JSON.stringify(o, null, 2) + '\n');
w('host-services.json', proposed); w('agent-fragment.json', agent); w('provider-fragment.json', provider); w('names.json', {hostId, zone, names});
console.log(JSON.stringify({ok: true, pathCheck: process.platform === 'win32' ? 'native' : 'structural (Windows paths mapped; the host runner re-validates)', orders: bound.orders, challenge: proposed.services.find((s) => s.role === 'service-tls').config.challenge, g1Tls: agentTls, challengeOrigin: `https://${names['app-zone-replica (challenge origin)']}`}, null, 1));
