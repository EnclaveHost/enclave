#!/usr/bin/env node
// Isolated candidate build. Does not update the address book, site artifacts,
// production releases, or deploy/sign/broadcast anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { keccak256, toFunctionSelector, toEventSelector } from 'viem';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiler = process.argv[2];
if (!compiler || process.argv.length !== 3) throw Error('Usage: node scripts/build-lifecycle-artifacts.mjs /absolute/path/to/solc-0.8.35');
function run(args, input) {
  const p = spawnSync(compiler, args, { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (p.error || p.status !== 0) throw Error(p.error?.message || p.stderr || 'compiler failed');
  return p.stdout;
}
const version = run(['--version']).match(/Version: ([^\s]+)/)?.[1];
if (version !== '0.8.35+commit.47b9dedd.Linux.g++') throw Error(`unqualified compiler: ${version}`);
const settings = { optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: 'prague',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } } };
const definitions = [
  ['EnclaveDeployments', 'deploy/lifecycle/EnclaveDeployments.sol'],
  ['EnclaveDeploymentLifecycle', 'contracts/EnclaveDeploymentLifecycle.sol'],
  ['EnclaveSelfHostingIdentity', 'contracts/EnclaveSelfHostingIdentity.sol'],
];
const outputs = new Map();
const manifest = { schema: 1, qualification: 'candidate; not enabled for production', compiler: version,
  settings, contracts: {}, rolloutBlocks: [
    'Authenticated safe/finalized block age does not satisfy the current 20-second authority bound.',
    'Witness service and host, ingress, storage and secret-release fencing adapters are not wired.',
    'Live migration, paid-service settlement and Base receipt fee bounds are not qualified.',
  ] };
for (const [name, source] of definitions) {
  const content = fs.readFileSync(path.join(root, source), 'utf8');
  const result = JSON.parse(run(['--standard-json'], JSON.stringify({ language: 'Solidity', sources: { [source]: { content } }, settings })));
  const errors = (result.errors || []).filter(x => x.severity === 'error');
  if (errors.length) throw Error(errors.map(x => x.formattedMessage).join('\n'));
  const c = result.contracts[source][name];
  const creation = `0x${c.evm.bytecode.object}`, runtime = `0x${c.evm.deployedBytecode.object}`;
  const runtimeBytes = (runtime.length - 2) / 2;
  if (!/^0x[0-9a-f]+$/i.test(creation) || runtimeBytes > 24576) throw Error(`${name}: unlinked or oversized bytecode`);
  const selectors = Object.fromEntries(c.abi.filter(x => x.type === 'function').map(x => [x.name, toFunctionSelector(x)]));
  const events = Object.fromEntries(c.abi.filter(x => x.type === 'event').map(x => [x.name, toEventSelector(x)]));
  const artifact = { abi: c.abi, bytecode: creation, deployedBytecodeTemplate: runtime,
    immutableReferences: c.evm.deployedBytecode.immutableReferences, metadata: JSON.parse(c.metadata) };
  outputs.set(`${name}.json`, JSON.stringify(artifact, null, 2) + '\n');
  manifest.contracts[name] = { source, sourceSha256: createHash('sha256').update(content).digest('hex'),
    runtimeBytes, creationKeccak256: keccak256(creation), runtimeTemplateKeccak256: keccak256(runtime),
    // Immutable constructor bindings change actual deployed code. This hash is
    // NOT a deployed-code pin; a rollout must resolve and verify immutables.
    selectors, events };
  console.log(`${name}: ${runtimeBytes} runtime bytes; ${24576 - runtimeBytes} bytes free`);
}
const out = path.join(root, 'deploy/lifecycle/artifacts');
fs.mkdirSync(out, { recursive: true });
for (const [name, body] of outputs) fs.writeFileSync(path.join(out, name), body);
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
