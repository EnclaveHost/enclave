// Unit tests of compare-artifacts.mjs over SYNTHETIC Foundry trees shaped exactly like root's r3 output (root runs these;
// the worker did not). NOBLE = path of the pinned @noble/hashes/sha3.js (the runner passes the source checkout's copy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', 'compare-artifacts.mjs');
const C = await import(pathToFileURL(TOOL).href);
const { keccak_256 } = await import(pathToFileURL(process.env.NOBLE).href);
const SOLC = '0.8.35+commit.47b9dedd';
const SPEC = { sources: ['contracts/A.sol', 'contracts/B.sol'], artifacts: ['A.sol/A.json', 'B.sol/B.json'] };
const OPTS = { keccak: keccak_256, solcVersion: SOLC, spec: SPEC };
const k = (s) => '0x' + Buffer.from(keccak_256(Buffer.from(s))).toString('hex');
const rid = () => crypto.randomBytes(8).toString('hex');

// one in-memory model -> a tree on disk; `mut(model)` edits the model before it is written
function model(ids) {
  const src = { 'contracts/A.sol': 'contract A {}\n', 'contracts/B.sol': 'contract B { uint x; }\n' };
  const art = (file, name, bid, code) => {
    const raw = { compiler: { version: SOLC }, language: 'Solidity', output: { abi: [{ inputs: [], name: 'f', outputs: [], type: 'function' }], devdoc: { kind: 'dev', methods: {}, version: 1 } },
      settings: { compilationTarget: { [file]: name }, evmVersion: 'osaka', libraries: {}, metadata: { bytecodeHash: 'ipfs' }, optimizer: { enabled: true, runs: 200 },
                  remappings: [':forge-std/=contracts/foundry/lib/forge-std/src/'], viaIR: true },
      sources: { [file]: { keccak256: k(src[file]), license: 'MIT', urls: [] } }, version: 1 };
    const meta = JSON.parse(JSON.stringify(raw)); meta.settings.remappings = ['forge-std/=contracts/foundry/lib/forge-std/src/']; meta.output.abi[0] = { inputs: [], name: 'f', type: 'function' };
    return { abi: [{ type: 'function', name: 'f', inputs: [], outputs: [] }], bytecode: { object: code, sourceMap: '', linkReferences: {} },
             deployedBytecode: { object: code, sourceMap: '', linkReferences: {}, immutableReferences: {} }, methodIdentifiers: { 'f()': '26121ff0' },
             rawMetadata: JSON.stringify(raw), metadata: meta, id: 0 };
  };
  const m = { src, ids, ts: Date.now() + Math.floor(Math.random() * 1000),
    buildInfo: { [ids.a]: { id: ids.a, source_id_to_path: { 0: 'contracts/A.sol' }, language: 'Solidity' },
                 [ids.b]: { id: ids.b, source_id_to_path: { 0: 'contracts/B.sol' }, language: 'Solidity' } },
    artifacts: { 'A.sol/A.json': art('contracts/A.sol', 'A', ids.a, '0x6080'), 'B.sol/B.json': art('contracts/B.sol', 'B', ids.b, '0x6081') },
    extra: {} };
  const entry = (file, name, bid) => ({ lastModificationDate: m.ts, contentHash: 'c0ffee', interfaceReprHash: null, sourceName: file, imports: [], versionRequirement: '^0.8.20',
                                        artifacts: { [name]: { '0.8.35': { default: { path: `${path.basename(file)}/${name}.json`, build_id: bid } } } }, seenByCompiler: true });
  m.cache = { _format: '', paths: { artifacts: 'contracts/foundry/out', build_infos: 'contracts/foundry/out/build-info', sources: 'contracts' },
              files: { 'contracts/A.sol': entry('contracts/A.sol', 'A', ids.a), 'contracts/B.sol': entry('contracts/B.sol', 'B', ids.b) },
              builds: Math.random() < 0.5 ? [ids.a, ids.b] : [ids.b, ids.a], profiles: { default: { solc: { optimizer: { enabled: true, runs: 200 } } } }, preprocessed: false, mocks: [] };
  return m;
}
function write(root, m) {
  for (const [p, s] of Object.entries(m.src)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); }
  const out = path.join(root, 'contracts/foundry/out'); fs.mkdirSync(path.join(out, 'build-info'), { recursive: true });
  for (const [id, j] of Object.entries(m.buildInfo)) fs.writeFileSync(path.join(out, 'build-info', `${id}.json`), JSON.stringify(j));
  for (const [rel, j] of Object.entries(m.artifacts)) { fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true }); fs.writeFileSync(path.join(out, rel), JSON.stringify(j)); }
  for (const [rel, b] of Object.entries(m.extra)) { fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true }); fs.writeFileSync(path.join(out, rel), b); }
  fs.mkdirSync(path.join(root, 'contracts/foundry/cache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'contracts/foundry/cache/solidity-files-cache.json'), JSON.stringify(m.cache));
  return root;
}
function tree(mut) {
  const m = model({ a: rid(), b: rid() }); if (mut) mut(m);
  return write(fs.mkdtempSync(path.join(os.tmpdir(), 'cmpart-')), m);
}
const refused = (fn, code) => assert.throws(fn, (e) => e instanceof C.Refused && e.code === code, `expected Refused ${code}`);
const reid = (m, from, to) => {             // rename one build id everywhere it is referenced (still a consistent tree)
  m.buildInfo[to] = { ...m.buildInfo[from], id: to }; delete m.buildInfo[from];
  m.cache.builds = m.cache.builds.map((x) => (x === from ? to : x));
  for (const e of Object.values(m.cache.files)) for (const v of Object.values(e.artifacts)) for (const p of Object.values(v)) for (const r of Object.values(p)) if (r.build_id === from) r.build_id = to;
};

test('equal when ONLY the observed nondeterministic values differ (build ids, their order, cache timestamps)', () => {
  const a = tree(), b = tree();
  const r = C.compare(a, b, OPTS);
  assert.equal(r.equal, true, r.differences.join(' '));
  assert.equal(r.a.semanticSha256, r.b.semanticSha256);
  assert.notEqual(r.a.raw.manifestSha256, r.b.raw.manifestSha256, 'the raw manifests DO differ (kept in full)');
  assert.notDeepEqual(r.a.normalizedValues.buildIds, r.b.normalizedValues.buildIds);
  assert.equal(r.a.raw.manifest.length, 4);
});

for (const [why, mut] of [
  ['bytecode', (m) => { m.artifacts['A.sol/A.json'].bytecode.object = '0x6090'; }],
  ['deployed bytecode', (m) => { m.artifacts['B.sol/B.json'].deployedBytecode.object = '0x6091'; }],
  ['abi', (m) => { m.artifacts['A.sol/A.json'].abi[0].name = 'g'; }],
  ['optimizer settings (in both metadata forms)', (m) => {
    const a = m.artifacts['A.sol/A.json'], raw = JSON.parse(a.rawMetadata); raw.settings.optimizer.runs = 1; a.rawMetadata = JSON.stringify(raw); a.metadata.settings.optimizer.runs = 1; }],
  ['source ids / build composition', (m) => { m.buildInfo[m.ids.a].source_id_to_path = { 0: 'contracts/A.sol', 1: 'contracts/B.sol' }; }],
  ['cache contentHash', (m) => { m.cache.files['contracts/B.sol'].contentHash = 'deadbeef'; }],
  ['cache profile settings', (m) => { m.cache.profiles.default.solc.optimizer.runs = 1; }],
]) test(`a semantic difference is NOT equal: ${why}`, () => {
  const r = C.compare(tree(), tree(mut), OPTS);
  assert.equal(r.equal, false); assert.ok(r.differences.length > 0);
});

test('the compiler version is bound to the pin', () => {
  refused(() => C.loadTree(tree((m) => { for (const a of Object.values(m.artifacts)) { const raw = JSON.parse(a.rawMetadata); raw.compiler.version = '0.8.34+commit.x'; a.rawMetadata = JSON.stringify(raw); a.metadata.compiler.version = raw.compiler.version; } }), OPTS), 'compiler');
});

test('every metadata source keccak256 is bound to the ACTUAL source file', () => {
  refused(() => C.loadTree(tree((m) => { m.src['contracts/A.sol'] += '// edited after the build\n'; }), OPTS), 'source');
  refused(() => C.loadTree(tree((m) => { const a = m.artifacts['A.sol/A.json'], raw = JSON.parse(a.rawMetadata); raw.sources['contracts/Gone.sol'] = { keccak256: '0x00' }; a.rawMetadata = JSON.stringify(raw); a.metadata.sources = raw.sources; }), OPTS), 'source');
});

test('forge metadata must agree with the raw solc metadata on every binding field', () => {
  refused(() => C.loadTree(tree((m) => { m.artifacts['A.sol/A.json'].metadata.settings.viaIR = false; }), OPTS), 'metadata');
  refused(() => C.loadTree(tree((m) => { m.artifacts['A.sol/A.json'].metadata.settings.remappings = [':forge-std/=elsewhere/']; }), OPTS), 'metadata');
});

test('malformed build-info: extra key, id != file name, gap in source ids, duplicate source map', () => {
  refused(() => C.loadTree(tree((m) => { m.buildInfo[m.ids.a].input = {}; }), OPTS), 'build_info');
  refused(() => C.loadTree(tree((m) => { m.buildInfo[m.ids.a].id = 'ffffffffffffffff'; }), OPTS), 'build_info');
  refused(() => C.loadTree(tree((m) => { m.buildInfo[m.ids.a].source_id_to_path = { 1: 'contracts/A.sol' }; }), OPTS), 'build_info');
  refused(() => C.loadTree(tree((m) => { m.buildInfo[m.ids.b].source_id_to_path = { 0: 'contracts/A.sol' }; }), OPTS), 'build_info');
});

test('missing, extra or orphaned outputs and dangling references refuse', () => {
  refused(() => C.loadTree(tree((m) => { delete m.artifacts['B.sol/B.json']; }), OPTS), 'reference');                     // cache names a missing artifact
  refused(() => C.loadTree(tree((m) => { m.artifacts['B.sol/Extra.json'] = JSON.parse(JSON.stringify(m.artifacts['B.sol/B.json'])); }), OPTS), 'artifact');  // extra output (wrong target)
  refused(() => C.loadTree(tree((m) => { const x = rid(); m.buildInfo[x] = { id: x, source_id_to_path: { 0: 'contracts/B.sol', 1: 'contracts/A.sol' }, language: 'Solidity' }; }), OPTS), 'cache');   // extra build-info
  refused(() => C.loadTree(tree((m) => { m.cache.files['contracts/A.sol'].artifacts.A['0.8.35'].default.build_id = m.ids.b; }), OPTS), 'reference');  // wrong build for the source id
  refused(() => C.loadTree(tree((m) => { m.artifacts['A.sol/A.json'].id = 3; }), OPTS), 'reference');                       // source id not in its build
  refused(() => C.loadTree(tree((m) => { delete m.cache.files['contracts/B.sol']; m.cache.builds = [m.ids.a, m.ids.b]; }), OPTS), 'reference');   // orphaned artifact
});

test('required artifacts need bytecode; required sources must be compiled', () => {
  refused(() => C.loadTree(tree((m) => { m.artifacts['B.sol/B.json'].bytecode.object = '0x'; }), OPTS), 'required');
  refused(() => C.loadTree(tree(), { ...OPTS, spec: { sources: ['contracts/C.sol'], artifacts: [] } }), 'required');
});

test('malformed or unsafe files refuse: non-JSON artifact, bad rawMetadata, non-json file, symlink, cache shape', () => {
  refused(() => C.loadTree(tree((m) => { m.extra['A.sol/Bad.json'] = '{not json'; }), OPTS), 'malformed');
  refused(() => C.loadTree(tree((m) => { m.artifacts['A.sol/A.json'].rawMetadata = '{broken'; }), OPTS), 'malformed');
  refused(() => C.loadTree(tree((m) => { m.extra['A.sol/notes.txt'] = 'x'; }), OPTS), 'layout');
  const t = tree(); fs.symlinkSync(path.join(t, 'contracts/foundry/out/A.sol/A.json'), path.join(t, 'contracts/foundry/out/A.sol/Link.json'));
  refused(() => C.loadTree(t, OPTS), 'layout');
  refused(() => C.loadTree(tree((m) => { delete m.cache.files['contracts/A.sol'].lastModificationDate; }), OPTS), 'cache');      // only a PRESENT timestamp is normalized
  refused(() => C.loadTree(tree((m) => { m.cache.extraField = 1; }), OPTS), 'cache');
  refused(() => C.loadTree(tree((m) => { m.artifacts['A.sol/A.json'].storageLayout = {}; }), OPTS), 'artifact');
});

test('renaming build ids is the ONLY normalization: a consistent rename stays equal, the raw build-info bytes are still kept', () => {
  const a = tree(), b = tree((m) => reid(m, m.ids.a, '0000000000000001'));
  const r = C.compare(a, b, OPTS);
  assert.equal(r.equal, true, r.differences.join(' '));
  assert.ok(Object.keys(r.b.raw.buildInfoSha256).includes('0000000000000001'));
  assert.deepEqual(C.NORMALIZED.length, 4);
});

test('CLI: exit 0 + exclusive report when equal, exit 1 when different, exit 2 on usage', () => {
  const spec = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-')), 'spec.txt');
  fs.writeFileSync(spec, 'source contracts/A.sol\nsource contracts/B.sol\nartifact A.sol/A.json\nartifact B.sol/B.json\n');
  const rep = path.join(path.dirname(spec), 'report.json'), run = (a, b, r) => spawnSync(process.execPath, [TOOL, process.env.NOBLE, spec, SOLC, a, b, r], { encoding: 'utf8' });
  const ok = run(tree(), tree(), rep); assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(JSON.parse(fs.readFileSync(rep)).equal, true);
  assert.notEqual(run(tree(), tree(), rep).status, 0, 'the report is never overwritten');
  const bad = run(tree(), tree((m) => { m.artifacts['A.sol/A.json'].abi = []; }), rep + '2'); assert.equal(bad.status, 1, bad.stdout);
  assert.equal(spawnSync(process.execPath, [TOOL], { encoding: 'utf8' }).status, 2);
});
