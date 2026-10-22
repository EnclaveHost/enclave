#!/usr/bin/env node
// Build the rev-17 lease-generation candidate and the authoritative live rev 16d with the PINNED solc-js (the
// source-verification manifest's soljson, sha256 checked), at the live build settings (runs 1, viaIR), and report:
//   - baseline: the rev-16d runtime, patched with the manifest's immutables and library link, hashes to the LIVE
//     codeHash (and the library to its live codeHash) - proof this pipeline reproduces the deployed bytes;
//   - sizes (runtime / initcode) of the candidate ledger and both libraries against EIP-170 / EIP-3860;
//   - storage layout: every rev-16d variable keeps its slot and offset; new ones are appended;
//   - ABI: every rev-16d function/event is present with the same signature and mutability; the additions listed;
//   - EnclaveLedgerBandwidth: executable bytes (CBOR metadata excluded) equal live rev 16d's, so the deployed
//     library could be linked as-is.
// Writes out/build-report.json and out/<name>.json artifacts. Read-only towards everything outside this directory.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {keccak256} from 'viem';

const here = path.dirname(fileURLToPath(import.meta.url)), C = path.resolve(here, '..');
const REPO = path.resolve(C, '../enclave');
const {loadCompiler, cborMetadata} = await import(path.join(REPO, 'scripts/network/verify-deployed-sources.mjs'));
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'contracts/deployments/source-verification-base.json'), 'utf8'));
const solc = loadCompiler(manifest);                       // refuses any other soljson / version
const build = manifest.builds['ledger-rev16d'];
const UNIT = 'EnclaveDeployments.sol';                     // the live build's unit name
const sha = (b) => createHash('sha256').update(b).digest('hex');

function compile(file) {
  const content = fs.readFileSync(file, 'utf8');
  const sel = ['abi', 'metadata', 'storageLayout', 'evm.bytecode.object', 'evm.bytecode.linkReferences',
    'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'evm.deployedBytecode.linkReferences', 'evm.methodIdentifiers'];
  const input = { language: 'Solidity', sources: { [UNIT]: { content } },
    settings: { ...build.settings, outputSelection: { [UNIT]: { '*': sel } } } };
  const t = Date.now();
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: (p) => ({ error: 'no imports: ' + p }) }));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw Error(errors.map((e) => e.formattedMessage).join('\n'));
  return { contracts: out.contracts[UNIT], sha256: sha(content), ms: Date.now() - t,
    warnings: (out.errors || []).filter((e) => e.severity !== 'error').map((e) => e.formattedMessage.split('\n')[0]) };
}
// patch immutables / links with given values (hex without 0x, 32-byte words for immutables, 20-byte addresses for links)
function patch(dep, { immutables = {}, links = {}, names = {} }) {
  let o = dep.object;
  for (const [id, refs] of Object.entries(dep.immutableReferences || {})) {
    const v = immutables[names[id] ?? id]; if (!v) throw Error('no value for immutable ' + (names[id] ?? id));
    for (const { start, length } of refs) o = o.slice(0, start * 2) + v.slice(2).slice(-length * 2) + o.slice((start + length) * 2);
  }
  for (const [unit, libs] of Object.entries(dep.linkReferences || {})) for (const [lib, refs] of Object.entries(libs)) {
    const v = links[unit + ':' + lib]; if (!v) throw Error('no link for ' + lib);
    for (const { start, length } of refs) o = o.slice(0, start * 2) + v.slice(2) + o.slice((start + length) * 2);
  }
  return o;
}
const executable = (hex) => { const m = cborMetadata(hex); return m ? hex.slice(0, m.start * 2) : hex; };
const sigOf = (e) => `${e.type} ${e.name}(${(e.inputs || []).map((i) => i.type + (i.indexed ? ' indexed' : '')).join(',')})`
  + (e.type === 'function' ? ` ${e.stateMutability} -> (${(e.outputs || []).map((o) => o.type).join(',')})` : '');

const live = compile(path.join(C, 'authoritative/EnclaveDeployments.rev16d.sol'));
const cand = compile(path.join(C, 'src/EnclaveDeployments.sol'));
const report = { compiler: manifest.compiler, settings: build.settings, unit: UNIT,
  sources: { rev16d: { sha256: live.sha256, expected: build.sources[UNIT].sha256 }, candidate: { sha256: cand.sha256 } } };
if (live.sha256 !== build.sources[UNIT].sha256) throw Error('authoritative source is not the manifest blob');

// ---- baseline: rebuild the live bytes from the manifest pins ----
const L = manifest.contracts.deployments, LIB = manifest.contracts.ledgerBandwidthLibrary;
const immNames = { 'EnclaveDeployments.usdc': L.immutables['EnclaveDeployments.usdc'], 'EnclaveDeployments.registry': L.immutables['EnclaveDeployments.registry'] };
// immutable ids -> values: try both assignments of the two address immutables and accept only one that reproduces the
// live hash (a wrong assignment cannot collide with keccak)
function liveMatch(dep, values, links, codeHash) {
  const ids = Object.keys(dep.immutableReferences || {});
  const perms = ids.length === 2 ? [[0, 1], [1, 0]] : [[0]];
  const vals = Object.values(values);
  for (const p of perms) {
    const imm = Object.fromEntries(ids.map((id, i) => [id, vals[p[i]]]));
    const o = patch(dep, { immutables: imm, links });
    if (keccak256('0x' + o) === codeHash) return { match: true, bytes: o.length / 2 };
  }
  return { match: false };
}
const linkKey = `${UNIT}:EnclaveLedgerBandwidth`;
const b16 = liveMatch(live.contracts.EnclaveDeployments.evm.deployedBytecode, immNames, { [linkKey]: L.links['EnclaveDeployments.sol:EnclaveLedgerBandwidth'] }, L.codeHash);
const lib16 = liveMatch(live.contracts.EnclaveLedgerBandwidth.evm.deployedBytecode, { a: LIB.immutables.library_deploy_address }, {}, LIB.codeHash);
report.baseline = { ledger: { ...b16, liveCodeHash: L.codeHash, liveRuntimeBytes: L.runtimeBytes },
  library: { ...lib16, liveCodeHash: LIB.codeHash, liveRuntimeBytes: LIB.runtimeBytes } };
if (!b16.match || !lib16.match) throw Error('baseline does not reproduce the live code: ' + JSON.stringify(report.baseline));

// ---- sizes ----
const size = (c) => ({ runtime: c.evm.deployedBytecode.object.length / 2, initcode: c.evm.bytecode.object.length / 2 });
report.sizes = {};
for (const [tag, r] of [['rev16d', live], ['candidate', cand]]) for (const [n, c] of Object.entries(r.contracts))
  if (c.evm.deployedBytecode.object.length) report.sizes[`${tag}:${n}`] = size(c);
const cs = report.sizes['candidate:EnclaveDeployments'];
report.eip170 = { limit: 24576, candidateRuntime: cs.runtime, headroom: 24576 - cs.runtime, rev16dRuntime: report.sizes['rev16d:EnclaveDeployments'].runtime,
  initcodeLimit: 49152, candidateInitcode: cs.initcode, ok: cs.runtime <= 24576 && cs.initcode <= 49152 };

// ---- storage layout ----
const layout = (r) => r.contracts.EnclaveDeployments.storageLayout.storage.map((v) => ({ label: v.label, slot: v.slot, offset: v.offset, type: v.type.replace(/\d+_storage/g, 'S').replace(/t_struct\([^)]*\)\d*/g, (m) => m.replace(/\d+$/, '')) }));
const l16 = layout(live), l17 = layout(cand), moved = [];
for (const v of l16) { const w = l17.find((x) => x.label === v.label); if (!w || w.slot !== v.slot || w.offset !== v.offset) moved.push({ v, w }); }
report.storage = { rev16dVars: l16.length, candidateVars: l17.length, moved, appended: l17.filter((v) => !l16.some((x) => x.label === v.label)),
  isDelegateSlot: l17.find((v) => v.label === 'isDelegate')?.slot };
if (moved.length || report.storage.isDelegateSlot !== '23') throw Error('storage layout moved: ' + JSON.stringify(moved));
// the extension library's explicit slots must be exactly the ledger's
const srcText = fs.readFileSync(path.join(C, 'src/EnclaveDeployments.sol'), 'utf8');
const want = { DEPLOYMENTS_SLOT: '_deployments', EXISTS_SLOT: '_exists', EARN_SLOT: '_earn', EARNED_SLOT: 'earned6',
  PROVEN_SLOT: 'provenUntil', GENERATION_SLOT: '_leaseGen', GUARDED_SLOT: '_guardedReleaseOnly' };
report.storage.explicitSlots = {};
for (const [k, label] of Object.entries(want)) {
  const m = new RegExp(`uint256 internal constant ${k} = (\\d+);`).exec(srcText), v = l17.find((x) => x.label === label);
  if (!m || !v || m[1] !== v.slot || v.offset !== 0) throw Error(`explicit slot ${k}=${m?.[1]} but ${label} is at ${v?.slot}/${v?.offset}`);
  report.storage.explicitSlots[k] = { slot: Number(m[1]), label, type: v.type };
}

// ---- ABI ----
// the ledger's EXTERNAL surface = its own ABI + the extension's (reached through fallback()); no selector may collide
const ext = cand.contracts.EnclaveLeaseGeneration, ledgerSel = cand.contracts.EnclaveDeployments.evm.methodIdentifiers;
const extSel = ext.evm.methodIdentifiers, iface = cand.contracts.IEnclaveDeploymentsLeases.abi;
// release(bytes32) is the one declared forwarder (ledger -> library, same selector); any other shared selector would
// shadow the extension and is refused
const FORWARDED = ['release(bytes32)'];
for (const f of FORWARDED) if (!ledgerSel[f] || ledgerSel[f] !== extSel[f]) throw Error('forwarder missing: ' + f);
const collisions = Object.entries(extSel).filter(([sig, x]) => !FORWARDED.includes(sig) && Object.values(ledgerSel).includes(x)).map(([sig]) => sig);
if (collisions.length) throw Error('extension selector collides with a ledger selector: ' + collisions);
// solc lists only a library's view functions in its ABI JSON; the dispatcher is compared by selector instead
const ifaceSel = cand.contracts.IEnclaveDeploymentsLeases.evm.methodIdentifiers;
if (JSON.stringify(Object.entries(ifaceSel).sort()) !== JSON.stringify(Object.entries(extSel).sort()))
  throw Error('IEnclaveDeploymentsLeases selectors != EnclaveLeaseGeneration selectors: ' + JSON.stringify({ ifaceSel, extSel }));
const libEventSigs = ext.abi.filter((e) => e.type === 'event').map(sigOf).sort(), ifaceEventSigs = iface.filter((e) => e.type === 'event').map(sigOf).sort();
if (JSON.stringify(libEventSigs) !== JSON.stringify(ifaceEventSigs)) throw Error('extension events differ from the interface');
const extSigs = iface.map(sigOf);
const abi16 = live.contracts.EnclaveDeployments.abi.map(sigOf);
const abi17 = [...cand.contracts.EnclaveDeployments.abi.map(sigOf), ...extSigs];
report.abi = { missing: abi16.filter((x) => !abi17.includes(x)), added: abi17.filter((x) => !abi16.includes(x)),
  viaFallback: Object.keys(extSel), changedConstant: 'deploymentsSchema 16 -> 17 (same signature)' };
if (report.abi.missing.length) throw Error('rev-16d ABI entries missing: ' + report.abi.missing);
report.links = Object.fromEntries(['EnclaveDeployments', 'EnclaveLeaseGeneration', 'EnclaveLedgerBandwidth']
  .map((n) => [n, Object.values(cand.contracts[n].evm.deployedBytecode.linkReferences || {}).flatMap((l) => Object.keys(l))]));

// ---- library identity ----
const ex = (r) => executable(r.contracts.EnclaveLedgerBandwidth.evm.deployedBytecode.object);
report.ledgerBandwidthLibrary = { executableEqualToLive: ex(live) === ex(cand),
  note: 'CBOR metadata differs only because the unit source changed; the deployed library at ' + LIB.address + ' can be linked unchanged' };

// ---- artifacts ----
fs.mkdirSync(path.join(C, 'out'), { recursive: true });
for (const n of ['EnclaveDeployments', 'EnclaveLedgerBandwidth', 'EnclaveLeaseGeneration', 'IEnclaveDeploymentsLeases']) {
  const c = cand.contracts[n];
  fs.writeFileSync(path.join(C, 'out', n + '.json'), JSON.stringify({ contractName: n, unit: UNIT, sourceSha256: cand.sha256, abi: c.abi,
    bytecode: c.evm.bytecode, deployedBytecode: c.evm.deployedBytecode, metadata: c.metadata, storageLayout: c.storageLayout }, null, 1));
}
// the ledger's whole external ABI for clients: its own + the fallback surface (IEnclaveDeploymentsLeases), deduplicated
const ext17 = [...cand.contracts.EnclaveDeployments.abi.filter((e) => e.type !== 'fallback')];
for (const e of cand.contracts.IEnclaveDeploymentsLeases.abi) if (!ext17.some((x) => sigOf(x) === sigOf(e))) ext17.push(e);
fs.writeFileSync(path.join(C, 'out/EnclaveDeployments.external-abi.json'), JSON.stringify(ext17, null, 1) + '\n');
report.externalAbiEntries = ext17.length;
report.compileMs = { rev16d: live.ms, candidate: cand.ms };
report.warnings = [...new Set(cand.warnings)].slice(0, 10);
fs.writeFileSync(path.join(C, 'out/build-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ baseline: { ledger: b16.match, library: lib16.match }, eip170: report.eip170, sizes: report.sizes,
  storageMoved: moved.length, appended: report.storage.appended.map((v) => `${v.label}@${v.slot}`), isDelegateSlot: report.storage.isDelegateSlot,
  abiMissing: report.abi.missing, abiAdded: report.abi.added, viaFallback: report.abi.viaFallback, links: report.links, explicitSlots: report.storage.explicitSlots, libExecEqual: report.ledgerBandwidthLibrary.executableEqualToLive, compileMs: report.compileMs }, null, 1));
