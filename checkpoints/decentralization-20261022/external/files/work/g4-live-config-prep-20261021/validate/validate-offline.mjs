// OFFLINE validation of the G4 LIVE configuration (work/g4-live-config-prep-20261021). No network, no remote, no keys.
// Run: node --import ./register.mjs validate-offline.mjs   (the hook gives the candidate validators Windows path semantics)
// It judges, with the EXACT candidate code (every imported candidate file is pinned to the G4 privacy-agent 7ef4e230
// build inputs, or to the G4 hs2 tree), the final challengeReplica block, the release files, the Shield inputs, the
// admission-policy carriers (no DigitalOcean mirror), the cross-config consistency with the G4 hs2 service-tls challenge
// block, and the composed hs2 config (G4 + route-dns challengeTxtUpstream). Prints one JSON report; exit 0 only if all pass.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const W = '/home/steven/Documents/Codex/2026-10-18/wo/work/';
const HERE = new URL('.', import.meta.url).pathname;
const SRC = W + 'g4-network-composition-20261021/src/';               // the G4 network sources (privacy-agent 7ef4e230 inputs)
const HS2 = W + 'challenge-host-tls-20261021/tree/';                    // the G4 hs2 tree (service-tls 81cef1e8, package d976c794)
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fsha = (p) => sha(fs.readFileSync(p));
const report = { at: new Date().toISOString(), checks: {}, facts: {} };
const check = (name, fn) => { try { const v = fn(); report.checks[name] = v === undefined ? 'PASS' : v; } catch (e) { report.checks[name] = 'FAIL: ' + e.message; } };
const acheck = async (name, fn) => { try { const v = await fn(); report.checks[name] = v === undefined ? 'PASS' : v; } catch (e) { report.checks[name] = 'FAIL: ' + e.message; } };

// ---- pins: the exact candidate validator bytes ----
const inputs = JSON.parse(fs.readFileSync(W + 'g4-network-composition-20261021/out/g4/privacy-agent.mjs.inputs.json', 'utf8'));
const PA = ['network/challenge-replica-host.mjs', 'network/enclave-network-host.mjs', 'network/host-service-names.mjs', 'network/challenge-front-declaration.mjs',
  'network/platform-host-policy-config.mjs', 'network/policy-carriers.mjs', 'network/host-policy-runtime.mjs'];
check('pins.privacyAgentInputs', () => { for (const f of PA) assert.equal(fsha(SRC + f), inputs[f], `${f} is not the built privacy-agent input`); });
const HS2PINS = { 'network/host-services/service-tls.mjs': '81cef1e8d35c8aef3fef268bda017f95abb9d704cc9595f77023803c5cb28bb1' };
check('pins.hs2Tree', () => { for (const [f, h] of Object.entries(HS2PINS)) assert.equal(fsha(HS2 + f), h, f); });
assert.equal(fsha(W + 'g4-network-composition-20261021/out/g4/privacy-agent.mjs'), '7ef4e2303d841e86269d3bbb7ce5f43a5ead5b0d2f2898f9b69774da1ac13147', 'not the G4 privacy-agent build');

// ---- inputs ----
const BLOCK = JSON.parse(fs.readFileSync(process.env.VALIDATE_BLOCK || HERE + '../config/challengeReplica.block.json', 'utf8'));   // VALIDATE_BLOCK: mutant controls only
const HS2CFG_RAW = fs.readFileSync(HERE + '../config/host-services.g4-upstream.json', 'utf8');
const G4CFG = JSON.parse(fs.readFileSync(W + 'challenge-host-tls-20261021/g4/host-services.g4.json', 'utf8'));
const RELEASE_LOCAL = W + 'certificate-release-prep/release/dist';
const PROFILE_LOCAL = W + 'enclave/contracts/deployments/network-profile-base.json';
const SHIELD_POLICY_LOCAL = W + 'enclave/windows/installer/admitted-shield-policy.json';
const RUNNER = '0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a';   // live hs2 service-tls hostId (47f3e1f5)
const DO = ['134.199.235.187', '134.209.248.172', '165.245.191.129', '146.190.246.39'];

const crh = await import(SRC + 'network/challenge-replica-host.mjs');                 // Windows path semantics (hook)
const crhPosix = await import(SRC + 'network/challenge-replica-host.mjs?posix');      // POSIX: only for the local release files
const phc = await import(SRC + 'network/platform-host-policy-config.mjs');
const { CARRIER_MIRROR } = await import(SRC + 'network/policy-carriers.mjs');
const { hostChallengeName } = await import(SRC + 'network/host-service-names.mjs');
const { keccak256, toBytes } = await import(SRC + 'node_modules/viem/_esm/index.js');   // the candidate tree's own viem

// 1. the block, exactly as enclave-network-host judges it (challengeReplicaConfig + the runner check of lines 75-77)
let cfg = null;
check('block.challengeReplicaConfig', () => { cfg = crh.challengeReplicaConfig(BLOCK); });
check('block.managedFrontIsThisRunner', () => {
  assert.equal(cfg.front.mode, 'managed'); assert.equal(cfg.front.hostId, RUNNER, 'keccak256(hostPolicy.endpoint) is not the runner');
  assert.equal(keccak256(toBytes(BLOCK.hostPolicy.endpoint)).toLowerCase(), RUNNER);
  assert.equal(cfg.front.name, hostChallengeName(RUNNER, 'app.enclave.host'));
  report.facts.challengeOrigin = cfg.front.origin; });
check('block.noLegacyNoPlaceholders', () => {
  const text = JSON.stringify(BLOCK); assert.ok(!/<|\.\.\.|TODO|placeholder/i.test(text), 'placeholder text found'); });
// 2. the child environment (public: no keys exist in it)
check('block.childEnv', () => { const env = crh.challengeReplicaEnv(cfg, { basePath: 'X', systemRoot: 'C:\\Windows' });
  for (const [k, v] of Object.entries({ DNS_READ_ONLY: '1', APP_ZONE: 'app.enclave.host', IP_ZONE: 'ip.enclave.host', APP_CHALLENGE_AUTH: 'attested-lease', APP_CHALLENGE_JUDGE_MODE: 'trusted',
    APP_CHALLENGE_UPSTREAM: '127.0.0.1:31053', ROUTE_MAP_URL: 'http://127.0.0.1:18188/v1/network/routes', DNS_BIND: '127.0.0.1', DNS_PORT: '18353', DNS_API_PORT: '18354' })) assert.equal(env[k], v, k);
  assert.equal(env.APP_CHALLENGE_SHIELD_PROFILE_DIGEST, BLOCK.shield.profileDigest); assert.ok(!('APP_CHALLENGE_MEASUREMENTS' in env), 'SNP is not pinned on this Shield host');
  report.facts.childEnvKeys = Object.keys(env).sort(); });
// 3. admission without the DigitalOcean mirror set, production governance unchanged
check('policy.noDigitalOceanMirror', () => {
  const { env } = crh.hostPolicyGateEnv(cfg.hostPolicy);
  const r = phc.resolveHostPolicyConfig({ env, chainId: 8453 });
  assert.equal(r.on, true); assert.deepEqual(r.config.mirrors, [CARRIER_MIRROR], 'the gate would fetch from other mirrors');
  assert.ok(!DO.some((ip) => JSON.stringify(r.config).includes(ip)), 'a DigitalOcean address remains');
  const prod = phc.resolveHostPolicyConfig({ env: { ENCLAVE_PLATFORM_HOST_POLICY: 'production' }, chainId: 8453 }).config;
  for (const k of ['book', 'hostOwnership', 'activation', 'minAgree']) assert.equal(r.config[k], prod[k], `governance field ${k} differs from production`);
  assert.deepEqual(r.config.rpcs, prod.rpcs, 'the policy RPC quorum differs from production');
  report.facts.policy = { source: r.source, book: r.config.book, hostOwnership: r.config.hostOwnership, activation: r.config.activation, minAgree: r.config.minAgree, mirrors: r.config.mirrors,
    productionMirrorsDropped: prod.mirrors, carriers: cfg.hostPolicy.carriers }; });
// 4. the release, from the locally held reviewed bytes (the same verifier the network runtime runs at start)
check('release.verifyReplicaRelease', () => {
  const v = crhPosix.verifyReplicaRelease({ dir: RELEASE_LOCAL, dnsSha256: BLOCK.release.dnsSha256, runtimeBundleSha256: BLOCK.release.runtimeBundleSha256 });
  assert.equal(fsha(RELEASE_LOCAL + '/dns.mjs.manifest.json'), 'aa1ebdb591e15866d30061ae41704c6532ff6ec03a882f920c99058a3bd41bbf');
  report.facts.release = { dnsSha256: v.dnsSha256, runtimeBundleSha256: v.runtimeBundleSha256, manifest: 'aa1ebdb5' }; });
// 5. the Shield inputs, parsed as dns-relay parses them (release runtime bundle's own parseProfile)
await acheck('shield.profileAndPolicy', async () => {
  const rt = await import(RELEASE_LOCAL + '/network-runtime.bundle.mjs');
  const ap = await import(W + 'enclave/network/authority-profile.mjs');
  const { profile, digest } = ap.parseProfile(fs.readFileSync(PROFILE_LOCAL), { expectedDigest: BLOCK.shield.profileDigest });
  const binding = rt.shieldRegistryBinding(profile);
  assert.equal(binding.address, BLOCK.chain.pins.registry, 'the profile binds another registry than chain.pins.registry');
  assert.equal(profile.contracts.deployments.address, BLOCK.chain.pins.deployments); assert.equal(profile.contracts.appCatalog.address, BLOCK.chain.pins.catalog);
  const pol = JSON.parse(fs.readFileSync(SHIELD_POLICY_LOCAL, 'utf8'));
  assert.equal(pol.schema, 'enclave-shield-app-policy/1');
  report.facts.shield = { profileDigest: digest, registry: binding.address, profileFileSha256: fsha(PROFILE_LOCAL), canonicalPolicySha256: fsha(SHIELD_POLICY_LOCAL),
    note: 'the LIVE C:\\Program Files\\Enclave\\network\\admitted-shield-policy.json sha is a required root read (must equal this or be reviewed)' }; });
// 6. consistency with the G4 hs2 service-tls challenge block (the other side of the managed front)
check('consistency.g4ServiceTls', () => {
  const st = G4CFG.services.find((s) => s.role === 'service-tls').config;
  assert.equal(st.hostId, RUNNER); assert.equal(st.orders, 'held');
  assert.equal(st.challenge.frontPort, cfg.front.listen.port, 'front port'); assert.equal(st.challenge.declarationFile, cfg.front.declarationFile, 'declaration file');
  assert.deepEqual(st.challenge.release, { dnsSha256: cfg.release.dnsSha256, runtimeBundleSha256: cfg.release.runtimeBundleSha256 }, 'release pins');
  const used = [st.httpPort, ...Object.values(st.tlsPorts), st.challenge.tlsPort, 18153, 18154, 18188, 18189, 18190, 31053];
  for (const p of [cfg.listen.dns.port, cfg.listen.api.port]) assert.ok(!used.includes(p), `port ${p} collides with an hs2/tunnel port`); });
// 7. the composed hs2 config (G4 + challengeTxtUpstream) through the G4 hs2 runner's own validator and roles
await acheck('hs2.validateHostServicesConfig', async () => {
  const runner = await import(HS2 + 'network/host-services/runner.mjs');
  const { ROLES } = await import(HS2 + 'network/host-services/roles.mjs');
  const c = runner.validateHostServicesConfig(JSON.parse(HS2CFG_RAW));
  const rd = c.services.find((s) => s.role === 'route-dns');
  assert.equal(ROLES['route-dns'].launch(ROLES['route-dns'].validate(rd.config)).env.CHALLENGE_TXT_UPSTREAM, '127.0.0.1:31053');
  const st = c.services.find((s) => s.role === 'service-tls'); assert.equal(st.config.orders, 'held'); assert.ok(st.config.challenge);
  report.facts.hs2 = { sha256: sha(HS2CFG_RAW), roles: c.services.map((s) => s.role), baseG4: 'a02e9ecd', note: 'CAS base = the SUCCESSFUL G4 receipt (unknown until G4 runs); never 3db1205d' }; });

const failed = Object.entries(report.checks).filter(([, v]) => String(v).startsWith('FAIL'));
report.result = failed.length ? 'FAIL' : 'PASS';
console.log(JSON.stringify(report, null, 1));
process.exit(failed.length ? 1 : 0);
