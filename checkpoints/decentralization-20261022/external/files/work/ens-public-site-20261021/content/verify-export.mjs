// Independent verification + block export of the enclavehost.eth site DAG (IPNS seq 1026 target) from an EXISTING local
// CAR. Writes ONLY under this directory. No network, no publication, no content change.
//   node verify-export.mjs <car> <outDir>
// Verifies, trusting nothing the CAR says about itself:
//   - the CARv1 header names exactly ROOT (main's scripts/site-release/car.mjs readCar);
//   - EVERY block re-hashes (sha2-256) to its CID (readCar, and again here, independently);
//   - no duplicate block, no block unreachable from ROOT, no reachable block missing (readCar + a second walk here);
//   - every UnixFS file reassembles to its declared filesize (walkFiles), sha256 per file;
//   - index.html and every local JS/CSS/module it references resolve to files of the DAG with complete bytes;
//   - the 2026-10-19 manifest (work/control-vm/missing-pin-package/.../manifest.json) agrees file by file.
// Exports <outDir>/ipfs/<cid> (raw block bytes; names are canonical base32 CIDv1 only) for EVERY block, written to a
// temporary name and renamed, then re-read and re-hashed; plus <outDir>/blocks-manifest.json.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const SR = '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/scripts/site-release/';
const { readCar, blockOrder, walkFiles } = await import(SR + 'car.mjs');
const { cidParse, cidString, decodePb, decodeUnixfs } = await import(SR + 'unixfs.mjs');

const ROOT = 'bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou';
const PRIOR = '/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/missing-pin-package/sites/' + ROOT + '/manifest.json';
const [carFile, outDir] = process.argv.slice(2);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const R = { root: ROOT, car: { path: carFile }, checks: {}, at: new Date().toISOString() };
const ok = (k, v, detail) => { R.checks[k] = { ok: !!v, ...(detail !== undefined ? { detail } : {}) }; if (!v) R.failed = (R.failed || 0) + 1; };

const bytes = fs.readFileSync(carFile);
R.car.bytes = bytes.length; R.car.sha256 = sha(bytes);

// 1. the repo verifier (throws on any header/hash/duplicate/missing/unreachable/filesize problem)
let car; try { car = readCar(bytes, { expectRoot: ROOT }); ok('readCar (header root, every block hash, no duplicate, complete + no unreachable, files reassemble)', true); }
catch (e) { ok('readCar', false, String(e.message)); console.log(JSON.stringify(R, null, 1)); process.exit(2); }

// 2. independent pass over the raw CAR frames: count frames, duplicates, re-hash, codec census
let i = 0; const rd = () => { let n = 0, mul = 1, x; do { x = bytes[i++]; n += (x & 127) * mul; mul *= 128; } while (x & 128); return n; };
const hlen = rd(); i += hlen;
let frames = 0, dup = 0, badHash = 0, rawN = 0, pbN = 0, blockBytes = 0; const seen = new Set();
while (i < bytes.length) { const len = rd(), c = bytes.subarray(i, i + 36), d = bytes.subarray(i + 36, i + len), k = cidString(c); i += len; frames++;
  if (seen.has(k)) dup++; seen.add(k); if (sha(d) !== c.subarray(4).toString('hex')) badHash++; if (c[1] === 0x55) rawN++; else pbN++; blockBytes += d.length; }
ok('independent frame pass: no duplicate, every block re-hashes, frames == readCar blocks', dup === 0 && badHash === 0 && frames === car.blocks.size,
  { frames, unique: seen.size, duplicates: dup, badHash, raw: rawN, dagPb: pbN, blockBytes, headerBytes: hlen });

// 3. independent reachability walk (dag-pb links), separate from blockOrder
const reach = new Set(); const missing = []; const stack = [ROOT];
while (stack.length) { const k = stack.pop(); if (reach.has(k)) continue; reach.add(k); const b = car.blocks.get(k); if (!b) { missing.push(k); continue; }
  if (cidParse(k)[1] === 0x70) for (const l of decodePb(b).links) stack.push(cidString(l.cid)); }
ok('independent reachability: every reachable block present, every block reachable', missing.length === 0 && reach.size === car.blocks.size,
  { reachable: reach.size, missing, unreachable: [...car.blocks.keys()].filter((k) => !reach.has(k)) });
const rootNode = decodeUnixfs(decodePb(car.blocks.get(ROOT)).data);
ok('root is a basic UnixFS directory (type 1, not a HAMT shard)', rootNode.type === 1, { type: rootNode.type, rootBlockBytes: car.blocks.get(ROOT).length, rootBlockSha256: sha(car.blocks.get(ROOT)) });

// 4. files: index.html and its local JS/CSS references
const files = car.files, byPath = new Map(files.map((f) => [f.path, f]));
R.files = { count: files.length, totalBytes: files.reduce((s, f) => s + f.bytes, 0), distinctFileCids: new Set(files.map((f) => f.cid)).size };
const idx = byPath.get('index.html');
ok('index.html present', !!idx, idx);
const content = {}; walkFiles(ROOT, car.blocks, { onFile: (p, parts) => { if (p.endsWith('.html')) content[p] = Buffer.concat(parts).toString('utf8'); } });
const refs = new Set();
const html = content['index.html'] || '';
for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"'#?]+)(?:[?#][^"']*)?["']/gi)) { const u = m[1]; if (/^(https?:|data:|mailto:|\/\/|javascript:)/i.test(u)) continue; if (/\.(m?js|css)$/i.test(u)) refs.add(u.replace(/^\.?\//, '')); }
const refRows = [...refs].sort().map((p) => { const f = byPath.get(p); return { path: p, inDag: !!f, bytes: f?.bytes, sha256: f?.sha256, cid: f?.cid }; });
// one level deeper: static imports inside the referenced JS modules (relative ./ ../ paths)
const deeper = new Set();
walkFiles(ROOT, car.blocks, { onFile: (p, parts) => { if (!refs.has(p) || !p.endsWith('.js')) return; const js = Buffer.concat(parts).toString('utf8');
  for (const m of js.matchAll(/(?:import|from)\s*\(?\s*["'](\.{1,2}\/[^"']+\.m?js)["']/g)) deeper.add(path.posix.normalize(path.posix.join(path.posix.dirname(p), m[1]))); } });
const deepRows = [...deeper].filter((p) => !refs.has(p)).sort().map((p) => { const f = byPath.get(p); return { path: p, inDag: !!f, bytes: f?.bytes, sha256: f?.sha256 }; });
ok('index.html: every referenced local JS/CSS is a complete file of the DAG', refRows.length > 0 && refRows.every((r) => r.inDag && r.bytes > 0), refRows);
ok('static imports of those modules (one level): every target is in the DAG', deepRows.every((r) => r.inDag), { count: deepRows.length, missing: deepRows.filter((r) => !r.inDag) });

// 5. the 2026-10-19 manifest, file by file
if (fs.existsSync(PRIOR)) { const m = JSON.parse(fs.readFileSync(PRIOR, 'utf8')); const diffs = [];
  const mm = new Map(m.fileManifest.map((f) => [f.path, f]));
  for (const f of files) { const p = mm.get(f.path); if (!p || p.sha256 !== f.sha256 || p.bytes !== f.bytes) diffs.push(f.path); }
  for (const p of mm.keys()) if (!byPath.has(p)) diffs.push('missing ' + p);
  ok('agrees with the 2026-10-19 manifest (car sha256, block count, every file path/bytes/sha256)', diffs.length === 0 && m.carSHA256 === R.car.sha256 && m.verifiedBlocks === car.blocks.size && m.files === files.length,
    { priorBlocks: m.verifiedBlocks, priorFiles: m.files, priorBytes: m.bytes, diffs: diffs.slice(0, 20) }); }

// 6. export every block as <outDir>/ipfs/<cid>, atomically, then re-read and re-hash
if (outDir && !R.failed) {
  const dir = path.join(outDir, 'ipfs'); fs.mkdirSync(dir, { recursive: true });
  const rows = []; let written = 0, kept = 0;
  for (const k of blockOrder(ROOT, car.blocks)) {
    if (!/^b[a-z2-7]{58}$/.test(k) || cidString(cidParse(k)) !== k) throw new Error('unsafe CID name ' + k);
    const b = car.blocks.get(k), f = path.join(dir, k);
    if (fs.existsSync(f)) { if (!fs.readFileSync(f).equals(b)) throw new Error('existing differing block file ' + k); kept++; }
    else { fs.writeFileSync(f + '.tmp', b, { flag: 'wx', mode: 0o644 }); fs.renameSync(f + '.tmp', f); written++; }
    rows.push({ cid: k, codec: cidParse(k)[1] === 0x55 ? 'raw' : 'dag-pb', bytes: b.length, sha256: sha(b) });
  }
  let reBad = 0; for (const r of rows) if (sha(fs.readFileSync(path.join(dir, r.cid))) !== r.sha256 || r.sha256 !== cidParse(r.cid).subarray(4).toString('hex')) reBad++;
  const extra = fs.readdirSync(dir).filter((n) => !car.blocks.has(n));
  ok('export: one file per block, every file re-read re-hashes to its CID, nothing extra', reBad === 0 && extra.length === 0 && rows.length === car.blocks.size, { written, alreadyIdentical: kept, reHashFailures: reBad, extraFiles: extra });
  fs.writeFileSync(path.join(outDir, 'blocks-manifest.json'), JSON.stringify({ root: ROOT, carSha256: R.car.sha256, order: 'depth-first from the root (car.mjs blockOrder)', blocks: rows }, null, 1));
  fs.writeFileSync(path.join(outDir, 'files-manifest.json'), JSON.stringify({ root: ROOT, files }, null, 1));
  R.export = { dir, blocks: rows.length, blockBytes: rows.reduce((s, r) => s + r.bytes, 0) };
}
R.verified = !R.failed;
console.log(JSON.stringify(R, null, 1));
process.exit(R.failed ? 1 : 0);
