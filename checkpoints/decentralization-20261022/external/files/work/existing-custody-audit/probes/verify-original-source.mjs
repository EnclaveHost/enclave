// Compile the ORIGINAL EnclaveSecretVaultV2 (git blob 7a385bbc, commit e4e045941 / deployed by 5b3969d09) with the pinned
// solc-js 0.8.35 (soljson sha256 checked against the repository's source-verification manifest), viaIR, runs 200, and
// compare it with the live runtime read through agreeing RPCs. Only the two immutables (book, enclaveOwner) may differ.
import fs from 'node:fs';
import { keccak256 } from 'viem';
import { pinBlock, codeAt } from '../../ledger17-migration/lib/live.mjs';
const REPO = new URL('../../enclave/', import.meta.url).pathname;
const { loadCompiler, compareRuntime } = await import(REPO + 'scripts/network/verify-deployed-sources.mjs');
const manifest = JSON.parse(fs.readFileSync(REPO + 'contracts/deployments/source-verification-base.json', 'utf8'));
const solc = loadCompiler(manifest);
const src = fs.readFileSync(new URL('../src/EnclaveSecretVaultV2.5b3969d09.sol', import.meta.url), 'utf8');
const unit = 'EnclaveSecretVaultV2.sol';
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [unit]: { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { '*': { '': ['ast'], EnclaveSecretVaultV2: ['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'evm.deployedBytecode.linkReferences', 'metadata'] } } } })));
const errs = (out.errors || []).filter((e) => e.severity === 'error'); if (errs.length) throw Error(errs[0].formattedMessage);
const c = out.contracts[unit].EnclaveSecretVaultV2;
const names = {}; const walk = (n, k) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach((x) => walk(x, k)); if (n.nodeType === 'ContractDefinition') k = n.name;
  if (n.nodeType === 'VariableDeclaration' && n.mutability === 'immutable') names[String(n.id)] = k + '.' + n.name; for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v, k); };
walk(out.sources[unit].ast);
const block = await pinBlock();
const live = await codeAt(block, '0xE48699B8401564aaCe7A814AE4569b67a3F7eEF5');
const r = compareRuntime({ compiled: { ...c.evm.deployedBytecode, metadata: c.metadata, slotNames: names }, liveCode: live, address: '0xe48699b8401564aace7a814ae4569b67a3f7eef5', kind: 'contract',
  expectedImmutables: { 'EnclaveSecretVaultV2.book': '0x000000000000000000000000ab214342d5a490150a4a977063a2f88e21f80907', 'EnclaveSecretVaultV2.enclaveOwner': '0x0000000000000000000000000b2d009c0c9af05b12100d77f3c815fea822ee61' }, expectedLinks: {} });
const res = { block: String(block.number), sourceSha256: (await import('node:crypto')).createHash('sha256').update(src).digest('hex'), liveCodeHash: keccak256(live), runtimeBytes: (live.length - 2) / 2, compare: r };
fs.writeFileSync(new URL('../evidence/original-source-verification.json', import.meta.url), JSON.stringify(res, null, 1) + '\n');
console.log(JSON.stringify({ status: r.status, reason: r.reason, block: res.block, liveCodeHash: res.liveCodeHash, sourceSha256: res.sourceSha256, immutables: r.immutables, metadata: r.metadata }));
