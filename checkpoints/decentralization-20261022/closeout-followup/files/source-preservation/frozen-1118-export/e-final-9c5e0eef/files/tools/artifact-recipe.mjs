// Writes exports/source-only/ARTIFACT-RECIPE.json: for every COMPILED fixture artifact and research capture that the
// source-only export omits, its origin, compiler settings, source binding and hashes, so D can preserve the code
// without the binaries and anyone can re-derive them.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { keccak256 } from 'viem';
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const ORIGIN = {
  EnclaveLeaseExecutor: 'work/app-lease-gas/forge/out/EnclaveLeaseExecutor.sol/EnclaveLeaseExecutor.json',
  EnclaveLeaseGasReserve: 'work/app-lease-gas/forge/out/EnclaveLeaseGasReserve.sol/EnclaveLeaseGasReserve.json',
  EnclaveDeployments: 'work/app-lease-gas/forge/out/EnclaveDeployments.sol/EnclaveDeployments.json',
  EnclaveLedgerBandwidth: 'work/app-lease-gas/forge/out/EnclaveDeployments.sol/EnclaveLedgerBandwidth.json',
  EnclaveRegistry: 'work/app-lease-gas/forge/out/EnclaveRegistry.sol/EnclaveRegistry.json',
  MockUSDC: 'work/app-lease-gas/forge/out/MockUSDC.sol/MockUSDC.json',
  MockFeed: 'work/app-lease-gas/forge/out/LeaseGas.t.sol/MockFeed.json',
  SessionVault: 'work/history-checkpoint-transport/tree/contracts/foundry/out/SessionVault.sol/SessionVault.json',
  SessionVaultLib: 'work/history-checkpoint-transport/tree/contracts/foundry/out/SessionVault.sol/SessionVaultLib.json',
  SessionVaultFactory: 'work/history-checkpoint-transport/tree/contracts/foundry/out/SessionVault.sol/SessionVaultFactory.json',
  EnclaveAddressBook: 'work/history-checkpoint-transport/tree/contracts/foundry/out/EnclaveAddressBook.sol/EnclaveAddressBook.json',
  MockUSDC3009: 'work/history-checkpoint-transport/tree/contracts/foundry/out/SessionMocks.sol/MockUSDC3009.json',
  Mock1271Owner: 'work/history-checkpoint-transport/tree/contracts/foundry/out/SessionMocks.sol/Mock1271Owner.json',
};
const artifacts = Object.entries(ORIGIN).map(([name, origin]) => {
  const p = `fixtures/artifacts/${name}.json`, j = JSON.parse(fs.readFileSync(p, 'utf8')), m = j.metadata;
  const sources = Object.fromEntries(Object.entries(m.sources).filter(([k]) => !k.includes('forge-std')).map(([k, v]) => [k, v.keccak256]));
  return { name, file: p, sha256: sha(p), origin, compiler: m.compiler.version, optimizer: m.settings.optimizer, viaIR: m.settings.viaIR ?? false, evmVersion: m.settings.evmVersion,
    compilationTarget: m.settings.compilationTarget, sourceKeccak256: sources, runtimeKeccak256: keccak256(j.deployedBytecode.object), linkReferences: Object.keys(j.bytecode.linkReferences || {}) };
});
const srcs = fs.readdirSync('fixtures/sources').map((f) => ({ file: `fixtures/sources/${f}`, sha256: sha(`fixtures/sources/${f}`), keccak256: keccak256(fs.readFileSync(`fixtures/sources/${f}`)) }));
const captures = ['l1-portal', 'l2-gpo'].map((n) => { const p = `evidence/capture/${n}.json`, c = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { file: p, sha256: sha(p), spec: `evidence/capture/spec-${n}.json`, tool: 'tools/capture-state.mjs (jobs/capture.sh)', block: c.block, providers: c.agreeingProviders, capturedAt: c.capturedAt,
    label: 'research provenance, single provider; re-capture yields a newer block', accounts: Object.fromEntries(Object.entries(c.accounts).map(([a, v]) => [a, v.codeHash])) }; });
fs.mkdirSync('exports/source-only', { recursive: true });
fs.writeFileSync('exports/source-only/ARTIFACT-RECIPE.json', JSON.stringify({ format: 'enclave-artifact-recipe/v1', note: 'compiled fixtures and bytecode captures are omitted from the source-only export; this file pins them', artifacts, sources: srcs, captures }, null, 1) + '\n');
console.log(artifacts.length, 'artifacts', srcs.length, 'sources', captures.length, 'captures');
