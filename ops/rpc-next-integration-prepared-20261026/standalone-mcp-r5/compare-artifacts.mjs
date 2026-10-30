#!/usr/bin/env node
// standalone-mcp-authority r5 (= r4 + exact solc library-placeholder validation): STRICT SEMANTIC comparison of two independent Foundry builds (base and candidate clones).
// Root's r3 run (root-mcp-authority-r3-0300, exit 20) compared raw sha256 manifests of out/**.json. Every contract artifact
// was byte-identical; the manifests differed ONLY in the 7 out/build-info/<id>.json files: their NAMES and their `id` field
// (forge's per-compilation build id), plus, outside out/, the cache's `builds`/`build_id` values and per-file
// `lastModificationDate` (the two fresh clones were checked out at different times).
// This tool keeps the FULL raw manifests and hashes, and decides equality on a semantic structure in which ONLY those observed
// nondeterministic values are normalized: build ids (in build-info names/ids, cache.builds, cache build_id refs) are replaced
// by a CONTENT label (canonical {language, source_id_to_path}); cache lastModificationDate is dropped. Nothing else is omitted:
// every artifact's bytes (abi, bytecodes, metadata) must be identical; compiler version, settings and every source keccak256
// in the solc rawMetadata are bound to the pinned version and the ACTUAL source files; every output reference
// (cache -> artifact path, build id, source id) must resolve exactly; any missing, extra or malformed file refuses.
// r5: root's r4 run (root-mcp-authority-r4-0307, exit 20) refused the REAL EnclaveDeployments.json because solc leaves each
// UNLINKED library reference as the 40-char placeholder `__$` + keccak256("<source>:<Library>")[0..34 hex] + `$__` inside the
// bytecode, at exactly the bytes its `linkReferences` list ({start, length: 20}). Only that is accepted (checkCode); every other
// character must still be lowercase hex, and the artifact bytes (placeholders included) are still compared by sha256.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Exact shapes OBSERVED in root's r3 run (forge 1.7.1 4072e487, solc 0.8.35+commit.47b9dedd): 31 artifacts, 7 build-infos.
export const ARTIFACT_KEYS = ['abi', 'bytecode', 'deployedBytecode', 'id', 'metadata', 'methodIdentifiers', 'rawMetadata'];
export const META_KEYS = ['compiler', 'language', 'output', 'settings', 'sources', 'version'];
export const SETTINGS_KEYS = ['compilationTarget', 'evmVersion', 'libraries', 'metadata', 'optimizer', 'remappings', 'viaIR'];
export const BUILD_INFO_KEYS = ['id', 'language', 'source_id_to_path'];
export const CACHE_KEYS = ['_format', 'builds', 'files', 'mocks', 'paths', 'preprocessed', 'profiles'];
export const CACHE_FILE_KEYS = ['artifacts', 'contentHash', 'imports', 'interfaceReprHash', 'lastModificationDate', 'seenByCompiler', 'sourceName', 'versionRequirement'];
export const NORMALIZED = ['build-info file name and its `id` (== the build id)', 'cache.builds (build ids; order)',
  'cache.files[*].artifacts[*][*][*].build_id', 'cache.files[*].lastModificationDate'];

export class Refused extends Error {
  constructor(code, why) { super(`${code}: ${why}`); this.code = code; }
}
const refuse = (code, why) => { throw new Refused(code, why); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const exactKeys = (o, keys) => isObj(o) && canonical(Object.keys(o).sort()) === canonical([...keys].sort());

function readJson(file, what) {
  let st;
  try { st = fs.lstatSync(file); } catch { refuse('missing', `${what} ${file} is missing`); }
  if (!st.isFile()) refuse('layout', `${what} ${file} is not a regular file (symlinks refused)`);
  const b = fs.readFileSync(file);
  try { return [b, JSON.parse(b.toString('utf8'))]; } catch { refuse('malformed', `${what} ${file} is not JSON`); }
}

function walk(dir, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name, st = fs.lstatSync(path.join(dir, r));
    if (st.isDirectory()) out.push(...walk(dir, r));
    else if (st.isFile() && name.endsWith('.json')) out.push(r);
    else refuse('layout', `out/${r} is not a regular .json file or directory`);
  }
  return out;
}

function sourceFile(root, p, what) {
  if (typeof p !== 'string' || path.isAbsolute(p) || p.split('/').includes('..') || !p.startsWith('contracts/')) refuse('source', `${what}: ${JSON.stringify(p)} is not a plain contracts/ path`);
  let st;
  try { st = fs.lstatSync(path.join(root, p)); } catch { refuse('source', `${what}: ${p} does not exist in the tree`); }
  if (!st.isFile()) refuse('source', `${what}: ${p} is not a regular file`);
  return fs.readFileSync(path.join(root, p));
}

// One bytecode object: lowercase hex, except that each linkReferences slot (byte offsets; length exactly 20, in bounds, no
// overlap; source named in this artifact's metadata) must hold EXACTLY the solc placeholder for its `<source>:<Library>`.
// An uncovered or wrong placeholder, or anything else in a slot, refuses. Returns the number of slots.
export function checkCode(rel, k, code, raw, keccak) {
  if (!isObj(code) || typeof code.object !== 'string' || !isObj(code.linkReferences)) refuse('artifact', `${rel}: ${k} has no string object / linkReferences object`);
  if (!/^0x([0-9a-f$_]{2})*$/.test(code.object)) refuse('artifact', `${rel}: ${k}.object is not hex`);
  let hex = code.object.slice(2);
  const slots = [];
  for (const [file, libs] of Object.entries(code.linkReferences)) {
    if (!isObj(raw.sources[file]) || !isObj(libs) || !Object.keys(libs).length) refuse('link', `${rel}: ${k}.linkReferences source ${JSON.stringify(file)} is not in this artifact's metadata sources, or names no library`);
    for (const [lib, refs] of Object.entries(libs)) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(lib) || !Array.isArray(refs) || !refs.length) refuse('link', `${rel}: ${k}.linkReferences ${file}:${lib} is malformed`);
      const ph = '__$' + Buffer.from(keccak(Buffer.from(`${file}:${lib}`))).toString('hex').slice(0, 34) + '$__';
      for (const r of refs) {
        if (!exactKeys(r, ['length', 'start']) || !Number.isInteger(r.start) || r.start < 0 || r.length !== 20) refuse('link', `${rel}: ${k} ${file}:${lib} reference ${JSON.stringify(r)} is not {start, length: 20}`);
        if (2 * (r.start + 20) > hex.length) refuse('link', `${rel}: ${k} ${file}:${lib} reference at byte ${r.start} is out of bounds (${hex.length / 2} bytes)`);
        slots.push([r.start, ph, `${file}:${lib}`]);
      }
    }
  }
  slots.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < slots.length; i++) if (slots[i][0] < slots[i - 1][0] + 20) refuse('link', `${rel}: ${k} references at bytes ${slots[i - 1][0]} and ${slots[i][0]} overlap`);
  for (const [s, ph, name] of slots) {
    if (hex.slice(2 * s, 2 * s + 40) !== ph) refuse('link', `${rel}: ${k} byte ${s} does not hold the solc placeholder ${ph} for ${name}`);
    hex = hex.slice(0, 2 * s) + '0'.repeat(40) + hex.slice(2 * s + 40);
  }
  if (!/^[0-9a-f]*$/.test(hex)) refuse(hex.includes('__$') ? 'link' : 'artifact', `${rel}: ${k}.object is not hex outside its linkReferences${hex.includes('__$') ? ' (a placeholder no linkReference covers)' : ''}`);
  return slots.length;
}

export function loadTree(root, { keccak, solcVersion, spec }) {
  const F = path.join(root, 'contracts/foundry'), outDir = path.join(F, 'out'), cacheFile = path.join(F, 'cache/solidity-files-cache.json');
  let st;
  try { st = fs.lstatSync(outDir); } catch { refuse('missing', `${outDir} is missing`); }
  if (!st.isDirectory()) refuse('layout', 'out/ is not a directory');
  const rels = walk(outDir), manifest = [], builds = {}, labels = new Set(), artifacts = {};
  for (const rel of rels) manifest.push(`${sha256(fs.readFileSync(path.join(outDir, rel)))}  out/${rel}`);
  // ---- build-info: exactly {id, language, source_id_to_path}; id == file name; contiguous source ids -> real sources
  for (const rel of rels.filter((r) => r.startsWith('build-info/'))) {
    const [b, j] = readJson(path.join(outDir, rel), 'build-info');
    if (rel.split('/').length !== 2 || !exactKeys(j, BUILD_INFO_KEYS)) refuse('build_info', `${rel}: keys must be exactly ${BUILD_INFO_KEYS}`);
    if (!/^[0-9a-f]{16}$/.test(String(j.id)) || rel !== `build-info/${j.id}.json`) refuse('build_info', `${rel}: id ${JSON.stringify(j.id)} is not its file name`);
    if (j.language !== 'Solidity') refuse('build_info', `${rel}: language ${JSON.stringify(j.language)}`);
    const m = j.source_id_to_path, ks = isObj(m) ? Object.keys(m) : [];
    if (!ks.length || canonical([...ks].sort()) !== canonical(ks.map((_, i) => String(i)).sort())) refuse('build_info', `${rel}: source ids must be exactly 0..n-1`);
    for (const k of ks) sourceFile(root, m[k], `${rel} source ${k}`);
    const label = canonical({ language: j.language, source_id_to_path: m });
    if (labels.has(label)) refuse('build_info', `${rel}: two builds with the same source map are ambiguous`);
    labels.add(label); builds[j.id] = { label, map: m, sha256: sha256(b) };
  }
  // ---- contract artifacts: exact key set; solc rawMetadata binds the pinned compiler, settings, target and source keccaks
  for (const rel of rels.filter((r) => !r.startsWith('build-info/'))) {
    const parts = rel.split('/');
    if (parts.length !== 2 || !parts[0].endsWith('.sol')) refuse('layout', `out/${rel} is not <File>.sol/<Contract>.json`);
    const [b, j] = readJson(path.join(outDir, rel), 'artifact');
    if (!exactKeys(j, ARTIFACT_KEYS)) refuse('artifact', `${rel}: keys must be exactly ${ARTIFACT_KEYS}`);
    if (!Number.isInteger(j.id) || j.id < 0) refuse('artifact', `${rel}: source id ${JSON.stringify(j.id)}`);
    if (typeof j.rawMetadata !== 'string') refuse('artifact', `${rel}: rawMetadata is not the solc metadata string`);
    let raw;
    try { raw = JSON.parse(j.rawMetadata); } catch { refuse('malformed', `${rel}: rawMetadata is not JSON`); }
    if (!exactKeys(raw, META_KEYS) || !exactKeys(raw.settings, SETTINGS_KEYS)) refuse('metadata', `${rel}: metadata/settings keys differ from the observed solc shape`);
    if (raw.compiler?.version !== solcVersion || raw.language !== 'Solidity' || raw.version !== 1) refuse('compiler', `${rel}: compiled by ${raw.compiler?.version}, not ${solcVersion}`);
    const tgt = Object.entries(raw.settings.compilationTarget || {});
    if (tgt.length !== 1 || path.basename(tgt[0][0]) !== parts[0] || tgt[0][1] !== parts[1].slice(0, -5)) refuse('artifact', `${rel}: compilationTarget ${JSON.stringify(raw.settings.compilationTarget)} does not name this output`);
    if (!isObj(raw.sources) || !Object.keys(raw.sources).length) refuse('metadata', `${rel}: no sources`);
    for (const [p, s] of Object.entries(raw.sources)) {
      const want = '0x' + Buffer.from(keccak(sourceFile(root, p, `${rel} metadata source`))).toString('hex');
      if (!isObj(s) || s.keccak256 !== want) refuse('source', `${rel}: ${p} keccak256 ${s?.keccak256} is not the tree's file ${want}`);
    }
    const links = ['bytecode', 'deployedBytecode'].map((k) => checkCode(rel, k, j[k], raw, keccak));
    // forge's parsed `metadata` must agree with the raw solc metadata on every binding field (it is a lossy rendering:
    // observed to drop empty `outputs`/some doc fields and the leading ':' of remappings - those are NOT treated as equal-bytes)
    const m = j.metadata, rs = raw.settings;
    if (!isObj(m) || canonical(m.compiler) !== canonical(raw.compiler) || m.language !== raw.language || canonical(m.sources) !== canonical(raw.sources)
        || !isObj(m.settings) || ['compilationTarget', 'evmVersion', 'libraries', 'metadata', 'optimizer', 'viaIR'].some((k) => canonical(m.settings[k]) !== canonical(rs[k]))
        || canonical(m.settings.remappings) !== canonical((rs.remappings || []).map((r) => (r.startsWith(':') ? r.slice(1) : r))))
      refuse('metadata', `${rel}: forge metadata disagrees with the raw solc metadata`);
    artifacts[rel] = { sha256: sha256(b), id: j.id, src: tgt[0][0], bytecode: j.bytecode.object, links, referenced: 0 };
  }
  // ---- cache: exact shape; every reference resolves (artifact path, build id, source id); nothing orphaned
  const [cb, c] = readJson(cacheFile, 'cache');
  if (!exactKeys(c, CACHE_KEYS) || c._format !== '' || !Array.isArray(c.builds) || !isObj(c.files)) refuse('cache', 'cache keys/format differ from the observed shape');
  if (new Set(c.builds).size !== c.builds.length || canonical([...c.builds].sort()) !== canonical(Object.keys(builds).sort())) refuse('cache', 'cache.builds is not exactly the set of build-info files');
  const used = new Set(), norm = JSON.parse(JSON.stringify(c)), stamps = {};
  for (const [src, e] of Object.entries(c.files)) {
    if (!exactKeys(e, CACHE_FILE_KEYS) || e.sourceName !== src || typeof e.lastModificationDate !== 'number' || !isObj(e.artifacts)) refuse('cache', `cache entry ${src}: shape`);
    sourceFile(root, src, `cache entry ${src}`); stamps[src] = e.lastModificationDate; delete norm.files[src].lastModificationDate;
    for (const [name, vers] of Object.entries(e.artifacts)) for (const [ver, profs] of Object.entries(vers || {})) for (const [prof, ref] of Object.entries(profs || {})) {
      if (!exactKeys(ref, ['build_id', 'path'])) refuse('cache', `cache ${src} ${name}: reference shape`);
      const a = artifacts[ref.path], bi = builds[ref.build_id];
      if (!a) refuse('reference', `cache ${src} ${name} names a missing artifact ${ref.path}`);
      if (!bi) refuse('reference', `cache ${src} ${name} names a missing build ${ref.build_id}`);
      if (a.src !== src || bi.map[String(a.id)] !== src || ref.path !== `${path.basename(src)}/${name}.json`) refuse('reference', `${ref.path}: source id ${a.id} in build ${ref.build_id} is not ${src}`);
      a.referenced++; used.add(ref.build_id); norm.files[src].artifacts[name][ver][prof].build_id = bi.label;
    }
  }
  for (const [rel, a] of Object.entries(artifacts)) if (a.referenced !== 1) refuse('reference', `out/${rel} is referenced ${a.referenced} times by the cache (extra or orphaned output)`);
  for (const id of Object.keys(builds)) if (!used.has(id)) refuse('reference', `build-info ${id} is referenced by no artifact (extra)`);
  norm.builds = Object.keys(builds).map((id) => builds[id].label).sort();
  // ---- the rigs' required artifacts and sources
  for (const a of spec.artifacts) if (!artifacts[a] || artifacts[a].bytecode.length <= 2) refuse('required', `required artifact ${a} is missing or has no bytecode`);
  for (const s of spec.sources) if (!c.files[s]) refuse('required', `required source ${s} was not compiled`);
  const semantic = { artifacts: Object.keys(artifacts).sort().map((r) => [r, artifacts[r].sha256]), buildInfos: [...labels].sort(), cache: norm };
  return { raw: { manifest, manifestSha256: sha256(manifest.join('\n') + '\n'), cacheSha256: sha256(cb), buildInfoSha256: Object.fromEntries(Object.entries(builds).map(([k, v]) => [k, v.sha256])) },
           normalizedValues: { buildIds: Object.keys(builds).sort(), lastModificationDate: stamps }, semantic, semanticSha256: sha256(canonical(semantic)),
           links: Object.fromEntries(Object.entries(artifacts).filter(([, a]) => a.links.some(Boolean)).map(([r, a]) => [r, a.links])) };
}

function diffPaths(a, b, p = '', out = []) {
  if (canonical(a) === canonical(b)) return out;
  if (isObj(a) && isObj(b)) { for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) diffPaths(a[k], b[k], `${p}/${k}`, out); }
  else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) a.forEach((x, i) => diffPaths(x, b[i], `${p}[${i}]`, out));
  else out.push(p || '/');
  return out;
}

export function compare(rootA, rootB, opts) {
  const a = loadTree(rootA, opts), b = loadTree(rootB, opts), differences = diffPaths(a.semantic, b.semantic);
  return { equal: differences.length === 0, differences, normalized: NORMALIZED, a, b };
}

export function parseSpec(text) {
  const spec = { sources: [], artifacts: [] };
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const m = /^(source|artifact) (\S+)$/.exec(line);
    if (!m) refuse('spec', `bad CONTRACT-ARTIFACTS line ${JSON.stringify(line)}`);
    (m[1] === 'source' ? spec.sources : spec.artifacts).push(m[1] === 'source' ? m[2] : m[2]);
  }
  if (!spec.sources.length || !spec.artifacts.length) refuse('spec', 'no sources/artifacts');
  return spec;
}

async function main(argv) {
  const [noble, specFile, solcVersion, rootA, rootB, report] = argv;
  if (argv.length !== 6) { console.error('usage: compare-artifacts.mjs <noble sha3.js> <CONTRACT-ARTIFACTS.txt> <solc version> <treeA> <treeB> <report.json>'); return 2; }
  const { keccak_256 } = await import(pathToFileURL(noble).href);
  try {
    const r = compare(rootA, rootB, { keccak: keccak_256, solcVersion, spec: parseSpec(fs.readFileSync(specFile, 'utf8')) });
    fs.writeFileSync(report, JSON.stringify({ format: 'mcp-artifact-comparison/v2', solcVersion, ...r }, null, 1), { flag: 'wx' });
    console.log(r.equal ? `EQUAL semantic ${r.a.semanticSha256} (raw manifests ${r.a.raw.manifestSha256.slice(0, 16)} / ${r.b.raw.manifestSha256.slice(0, 16)}; normalized: build ids, cache timestamps)`
                        : `DIFFERENT: ${r.differences.slice(0, 20).join(' ')}`);
    return r.equal ? 0 : 1;
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    fs.writeFileSync(report, JSON.stringify({ format: 'mcp-artifact-comparison/v2', refused: e.message }, null, 1), { flag: 'wx' });
    console.log(`REFUSED ${e.message}`); return 1;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
