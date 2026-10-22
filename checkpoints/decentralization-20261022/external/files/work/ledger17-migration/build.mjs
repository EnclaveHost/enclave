// build: every contract a rev-17 cutover deploys, from VERIFIED source with the pinned compiler, each proven against
// the LIVE chain before it is trusted:
//   ledger17      the frozen candidate (work/lease-generation-candidate, src sha256 checked) - artifacts reused as built
//   proofOfTime / verificationFees / connectivity
//                 the exact live builds of the source-verification manifest (sources read by commit+blob from the full
//                 clone, sha256 checked). Proven: patched with the manifest's immutables the runtime hashes to the LIVE
//                 code hash, and the live deployment tx input = this initcode + constructor args (decoded and kept).
//   pinned        PinnedSessionVaultFactory (+ the PinnedSessionAuthority and SessionVault it creates), EnclaveSecretVaultV2:
//                 main's sources whose sha256 equal independent-authorities-base.json, compiled by main's own
//                 compileIndependentAuthorities. Proven against the live runtimes (immutables masked, links filled).
//   governanceSeal main contracts/GovernanceSeal.sol (not deployed anywhere yet; its source hash is recorded).
// One component per process (`--only NAME`), so each solc job stays inside the memory allocation. Writes build/NAME.json.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { keccak256, decodeAbiParameters } from 'viem';
import { HERE, REPO, CANDIDATE, FULL_CLONE } from './lib/abis.mjs';
import { agree, codeAt, rpc, LIVE } from './lib/live.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO, 'contracts/deployments/source-verification-base.json'), 'utf8'));
const INDEP = JSON.parse(fs.readFileSync(path.join(REPO, 'contracts/deployments/independent-authorities-base.json'), 'utf8'));
export const CANDIDATE_SHA256 = '7e86f7817f4646ddae6d7d4d44052a3897fbc9f9815187f946bc702fca0c1acb';
// the live deployment transactions (located by archive code bisection + receipt contractAddress, 2026-10-20)
export const DEPLOY_TX = {
  proofOfTime: '0xad6e2a3e57377f62774ae7bea3c3ea270607c4f939abe75dc0967209d1353c2e',
  verificationFees: '0xd4b45c5057d88843e7fc0820280de73b9ed7afd7080be2b69b7da1f331d203df',
  connectivity: '0x6013fe424141784d3ca8d33c5b2b70e403b8186e179c03c58c3f68caff9dc83f',
};
const OUT = path.join(HERE, 'build');

function patchImmutables(dep, values) {   // values: name -> 32-byte hex word
  let o = dep.object;
  for (const [id, refs] of Object.entries(dep.immutableReferences || {})) {
    const v = values[id]; if (!v) throw Error('no value for immutable ' + id);
    for (const { start, length } of refs) o = o.slice(0, start * 2) + v.slice(2).padStart(64, '0').slice(-length * 2) + o.slice((start + length) * 2);
  }
  return o;
}
const immutableIdsByName = (ast) => {
  const names = {};
  const walk = (n, contract) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach((x) => walk(x, contract)); return; }
    if (n.nodeType === 'ContractDefinition') contract = n.name;
    if (n.nodeType === 'VariableDeclaration' && n.mutability === 'immutable') names[contract + '.' + n.name] = String(n.id);
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v, contract); };
  walk(ast); return names;
};

async function buildManifestDependent(key, { solc, readBuildSources }) {
  const c = MANIFEST.contracts[key], b = MANIFEST.builds[c.build];
  const sources = await readBuildSources(b, [FULL_CLONE]);   // verifies blob + sha256 per unit
  const sel = ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences',
    'evm.deployedBytecode.linkReferences', 'metadata'];
  const input = { language: 'Solidity', sources: Object.fromEntries(Object.entries(sources).map(([u, content]) => [u, { content }])),
    settings: { ...b.settings, outputSelection: { '*': { '': ['ast'], [c.contract]: sel } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: (p) => ({ error: 'unpinned import ' + p }) }));
  const errs = (out.errors || []).filter((e) => e.severity === 'error'); if (errs.length) throw Error(errs[0].formattedMessage);
  const art = out.contracts[c.unit][c.contract];
  const ids = {}; for (const s of Object.values(out.sources)) Object.assign(ids, immutableIdsByName(s.ast));
  // 1. the live code hash, from the manifest's immutables
  const byId = Object.fromEntries(Object.entries(c.immutables).map(([name, v]) => [ids[name], v]));
  const liveHash = keccak256('0x' + patchImmutables(art.evm.deployedBytecode, byId));
  if (liveHash !== c.codeHash) throw Error(`${key}: rebuilt runtime hashes to ${liveHash}, live is ${c.codeHash}`);
  // 2. the live deployment: this initcode + constructor args (agreed tx read)
  const tx = await agree('eth_getTransactionByHash', [DEPLOY_TX[key]]);
  const init = art.evm.bytecode.object;
  if (!tx.input.slice(2).startsWith(init)) throw Error(`${key}: the live deployment transaction does not start with the rebuilt initcode`);
  const ctor = art.abi.find((x) => x.type === 'constructor');
  const args = decodeAbiParameters(ctor.inputs, '0x' + tx.input.slice(2 + init.length));
  return { key, build: c.build, commit: b.commit, unit: c.unit, contract: c.contract, settings: b.settings,
    sources: Object.fromEntries(Object.entries(b.sources).map(([u, s]) => [u, { sha256: s.sha256, gitBlob: s.gitBlob }])),
    abi: art.abi, bytecode: art.evm.bytecode, deployedBytecode: art.evm.deployedBytecode, immutableNames: Object.fromEntries(Object.entries(ids).map(([n, id]) => [id, n])),
    proof: { liveAddress: c.address, liveCodeHash: c.codeHash, rebuiltWithLiveImmutables: liveHash, deployTx: DEPLOY_TX[key], deployer: tx.from,
      initcodeEqualsLive: true, liveConstructorArgs: args.map((a) => (typeof a === 'bigint' ? a.toString() : a)) },
    runtimeBytes: art.evm.deployedBytecode.object.length / 2, initcodeBytes: init.length / 2 };
}

async function buildPinned() {
  for (const [name, digest] of Object.entries(INDEP.sourceSha256)) {
    const got = sha(fs.readFileSync(path.join(REPO, 'contracts', name)));
    if (got !== digest) throw Error(`main contracts/${name} is ${got}, not the verified ${digest}`);
  }
  const { compileIndependentAuthorities, verifyAuthorityRuntime } = await import(path.join(REPO, 'scripts/independent-authorities.mjs'));
  const a = compileIndependentAuthorities();
  const block = { number: BigInt(process.env.L17_BLOCK || (await rpc(LIVE.state[0], 'eth_blockNumber', []))) };
  const addrs = INDEP.addresses, libs = { 'SessionVault.sol:SessionVaultLib': addrs.SessionVaultLib };
  const proof = {};
  for (const name of ['SessionVaultLib', 'PinnedSessionVaultFactory', 'PinnedSessionAuthority', 'SessionVault', 'EnclaveSecretVaultV2', 'EnclaveHostOwnership']) {
    const code = await codeAt(block, addrs[name]);
    proof[name] = { address: addrs[name], ...verifyAuthorityRuntime({ artifact: a.contracts[name], code, address: addrs[name], libraries: libs }) };
  }
  const keep = (n) => ({ abi: a.contracts[n].abi, bytecode: a.contracts[n].evm.bytecode, deployedBytecode: a.contracts[n].evm.deployedBytecode, runtimeBytes: a.contracts[n].evm.deployedBytecode.object.length / 2 });
  return { key: 'pinned', compiler: a.compiler, settings: a.settings, sourceSha256: a.sourceSha256, sourceCommitOfLiveSet: INDEP.sourceCommit,
    contracts: Object.fromEntries(['SessionVaultLib', 'PinnedSessionVaultFactory', 'PinnedSessionAuthority', 'SessionVault', 'EnclaveSecretVaultV2', 'EnclaveHostOwnership'].map((n) => [n, keep(n)])),
    proof: { block: String(block.number), liveRuntimesMatch: proof } };
}

function buildLedger17() {
  const src = fs.readFileSync(path.join(CANDIDATE, 'src/EnclaveDeployments.sol'));
  if (sha(src) !== CANDIDATE_SHA256) throw Error('the frozen candidate source changed: ' + sha(src));
  const art = (n) => JSON.parse(fs.readFileSync(path.join(CANDIDATE, 'out', n + '.json'), 'utf8'));
  const L = art('EnclaveDeployments'), G = art('EnclaveLeaseGeneration'), B = art('EnclaveLedgerBandwidth');
  for (const a of [L, G, B]) if (a.sourceSha256 !== CANDIDATE_SHA256) throw Error(a.contractName + ' artifact was not built from the frozen source');
  const report = JSON.parse(fs.readFileSync(path.join(CANDIDATE, 'out/build-report.json'), 'utf8'));
  if (!report.baseline.ledger.match || !report.ledgerBandwidthLibrary.executableEqualToLive || report.storage.moved.length) throw Error('candidate build report not clean');
  return { key: 'ledger17', sourceSha256: CANDIDATE_SHA256, settings: report.settings, compiler: report.compiler,
    externalAbi: JSON.parse(fs.readFileSync(path.join(CANDIDATE, 'out/EnclaveDeployments.external-abi.json'), 'utf8')),
    contracts: { EnclaveDeployments: { abi: L.abi, bytecode: L.bytecode, deployedBytecode: L.deployedBytecode },
      EnclaveLeaseGeneration: { abi: G.abi, bytecode: G.bytecode, deployedBytecode: G.deployedBytecode },
      EnclaveLedgerBandwidth: { abi: B.abi, bytecode: B.bytecode, deployedBytecode: B.deployedBytecode } },
    reuseLiveBandwidthLibrary: { address: MANIFEST.contracts.ledgerBandwidthLibrary.address, executableEqualToLive: true },
    sizes: report.sizes, eip170: report.eip170 };
}

async function buildSeal(solc) {
  const content = fs.readFileSync(path.join(REPO, 'contracts/GovernanceSeal.sol'), 'utf8');
  const settings = { optimizer: { enabled: true, runs: 200 }, viaIR: true };
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'GovernanceSeal.sol': { content } },
    settings: { ...settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error'); if (errs.length) throw Error(errs[0].formattedMessage);
  const c = out.contracts['GovernanceSeal.sol'].GovernanceSeal;
  return { key: 'governanceSeal', sourceSha256: sha(content), source: 'main contracts/GovernanceSeal.sol (not deployed)', settings,
    abi: c.abi, bytecode: c.evm.bytecode, deployedBytecode: c.evm.deployedBytecode, runtimeBytes: c.evm.deployedBytecode.object.length / 2 };
}

export async function build(only) {
  fs.mkdirSync(OUT, { recursive: true });
  let r;
  if (only === 'ledger17') r = buildLedger17();
  else if (only === 'pinned') r = await buildPinned();
  else {
    const V = await import(path.join(REPO, 'scripts/network/verify-deployed-sources.mjs'));
    const solc = V.loadCompiler(MANIFEST);
    if (only === 'governanceSeal') r = await buildSeal(solc);
    else if (['proofOfTime', 'verificationFees', 'connectivity'].includes(only)) r = await buildManifestDependent(only, { solc, readBuildSources: V.readBuildSources });
    else throw Error('unknown component ' + only);
  }
  const text = JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n';
  fs.writeFileSync(path.join(OUT, only + '.json'), text);
  return { only, file: path.join(OUT, only + '.json'), sha256: sha(text), proof: r.proof ? Object.keys(r.proof) : null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const i = process.argv.indexOf('--only');
  build(process.argv[i + 1]).then((r) => console.log(JSON.stringify(r)), (e) => { console.error('build failed: ' + e.message); process.exitCode = 1; });
}
