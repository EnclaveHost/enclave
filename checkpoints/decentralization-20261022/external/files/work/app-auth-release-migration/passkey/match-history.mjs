// Which historical contracts/EnclaveCreditVault.sol is the production vault factory (book key vaultFactory)? Compile each
// version from git with the deploy pipeline's settings (scripts/build-contract-artifacts.mjs: solc 0.8.35, optimizer 200,
// no viaIR) and compare to the live runtimes, immutables masked; the CBOR metadata (source hash) must match too. Then
// decode the live immutables by name from the compiler's own immutableReferences + AST - above all origin0/origin1.
// READ-ONLY public RPC (eth_getCode / eth_call at one block, two RPCs agreeing). Writes production-factory.json.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const REPO = '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave';
const solc = createRequire(REPO + '/package.json')('solc');
const FACTORY = '0xa891e4396e3eb11f364554043bc18e86da834e91';
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const rpc = async (u, m, p) => { const j = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }), signal: AbortSignal.timeout(15000) })).json(); if (j.error) throw new Error(j.error.message); return j.result; };
const heads = await Promise.all(RPCS.map((u) => rpc(u, 'eth_blockNumber', [])));
const block = '0x' + (Math.min(...heads.map((h) => parseInt(h, 16))) - 5).toString(16);
const agreed = async (m, p) => { const g = await Promise.all(RPCS.map((u) => rpc(u, m, [...p, block]))); if (new Set(g).size !== 1) throw new Error('RPCs disagree'); return g[0]; };
const liveF = await agreed('eth_getCode', [FACTORY]);
const impl = '0x' + (await agreed('eth_call', [{ to: FACTORY, data: '0x5c60da1b' }])).slice(26);
const liveV = await agreed('eth_getCode', [impl]);

function compile(src) {
  const input = { language: 'Solidity', sources: { 'EnclaveCreditVault.sol': { content: src } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'], '': ['ast'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error'); if (errs.length) throw new Error(errs[0].formattedMessage);
  const c = out.contracts['EnclaveCreditVault.sol'];
  // immutable names from the AST: VariableDeclaration ids with mutability "immutable"
  const names = {};
  (function walk(n) { if (!n || typeof n !== 'object') return; if (n.nodeType === 'VariableDeclaration' && n.mutability === 'immutable') names[n.id] = n.name; for (const v of Object.values(n)) if (typeof v === 'object') walk(v); })(out.sources['EnclaveCreditVault.sol'].ast);
  return { factory: c.EnclaveCreditVaultFactory.evm.deployedBytecode, vault: c.EnclaveCreditVault.evm.deployedBytecode, names };
}
function compare(liveHex, db, names) {
  const live = Buffer.from(liveHex.slice(2), 'hex'), comp = Buffer.from(db.object, 'hex');
  const masked = new Set(), imm = {};
  for (const [id, list] of Object.entries(db.immutableReferences || {})) for (const { start, length } of list) {
    for (let i = start; i < start + length; i++) masked.add(i);
    imm[names[id] || id] = live.subarray(start, start + length).toString('hex');
  }
  let diffs = 0; for (let i = 0; i < Math.max(live.length, comp.length); i++) if (!masked.has(i) && live[i] !== comp[i]) diffs++;
  return { live: live.length, compiled: comp.length, unmaskedDifferences: diffs, full: diffs === 0 && live.length === comp.length, imm };
}
const versions = execFileSync('git', ['log', '--all', '--format=%h', '--', 'contracts/EnclaveCreditVault.sol'], { cwd: REPO, encoding: 'utf8' }).trim().split('\n').reverse();
const results = [];
let winner = null;
for (const commit of versions) {
  const src = execFileSync('git', ['show', `${commit}:contracts/EnclaveCreditVault.sol`], { cwd: REPO, encoding: 'utf8' });
  const sha = (await import('node:crypto')).createHash('sha256').update(src).digest('hex');
  if (results.some((r) => r.sourceSha256 === sha)) continue;
  let c; try { c = compile(src); } catch (e) { results.push({ commit, sourceSha256: sha, error: e.message.slice(0, 200) }); continue; }
  const f = compare(liveF, c.factory, c.names), v = compare(liveV, c.vault, c.names);
  const r = { commit, sourceSha256: sha, factory: { ...f, imm: undefined }, implementation: { ...v, imm: undefined } };
  results.push(r);
  if (f.full && v.full) winner = { commit, sha, imm: v.imm, fimm: f.imm };
}
const word = (h) => '0x' + (h || '').slice(-40);
const text = (w, n) => Buffer.from(w || '', 'hex').subarray(0, parseInt(n || '0', 16)).toString('utf8');
const report = { checkedAt: new Date().toISOString(), block: parseInt(block, 16), rpcs: RPCS.map((u) => new URL(u).host), factory: FACTORY, implementation: impl,
  compileSettings: 'solc-js ' + solc.version() + ', optimizer 200, no viaIR (scripts/build-contract-artifacts.mjs)', versions: results,
  match: winner ? { commit: winner.commit, sourceSha256: winner.sha,
    factoryImplementationImmutable: word(Object.values(winner.fimm)[0]),
    usdc: word(winner.imm.usdc), book: word(winner.imm.book), treasury: word(winner.imm.treasury), factory: word(winner.imm.factory),
    recoveryAdmin: winner.imm.recoveryAdmin !== undefined ? word(winner.imm.recoveryAdmin) : '(no such immutable in this version)',
    origin0: winner.imm.origin0 !== undefined ? text(winner.imm.origin0, winner.imm.origin0Len) : '(NO ORIGIN CHECK in this version)',
    origin1: winner.imm.origin1 !== undefined ? text(winner.imm.origin1, winner.imm.origin1Len) : null } : null };
fs.writeFileSync(new URL('./production-factory.json', import.meta.url), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(report.match, null, 1));
console.log(results.map((r) => `${r.commit} ${r.sourceSha256.slice(0, 12)} factory ${r.factory?.full} impl ${r.implementation?.full} (${r.implementation?.live}/${r.implementation?.compiled}, diffs ${r.implementation?.unmaskedDifferences})${r.error ? ' ' + r.error : ''}`).join('\n'));
