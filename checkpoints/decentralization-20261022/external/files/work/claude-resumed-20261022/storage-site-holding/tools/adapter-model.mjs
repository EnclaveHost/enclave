// adapter-model.mjs: a LINE-MAPPED JavaScript model of how s3-ipfs-adapter (work/enclave-apps/s3-ipfs-adapter, HEAD 50f93d7 +
// the uncommitted probe/CAR-404 change; neither touches the code modelled here) turns a bucket listing into its DAG. It exists
// because this package may not build or run Rust; it is NOT the adapter. Every function names the Rust it transcribes:
//   listObjects()   main.rs 701-760   Phase::List: keys ending '/' are directory markers (skipped); <prefix>.enclave-index/* is
//                                     derived state (skipped); the rest is indexed, capped at maxKeys IN LISTING ORDER
//   fileDag()       ipfs.rs 345-417   chunk_sizes / build_file_dag / build_level: 256 KiB raw leaves, one chunk = the raw leaf,
//                                     balanced 174-ary tree, Tsize = leaves + node blocks, blocksizes = content per child
//   commit()        main.rs 393-485   nested UnixFS dirs from rel.split('/') (empty segments dropped), file/dir collisions skipped
//                                     (the dir wins), encode_dir recursion, every dir node kept in snap.nodes
//   buildDir()      ipfs.rs 419-427   links sorted by name BYTES, Tsize = children + own block
//   dagpbEncode()   ipfs.rs 183-195   links (Hash, Name even when empty, Tsize) before Data
// S3 ListObjectsV2 returns keys in UTF-8 byte order; the model sorts the same way before applying maxKeys.
import { createHash } from "node:crypto";

export const CHUNK = 262144, FANOUT = 174, RAW = 0x55, DAG_PB = 0x70;
const CACHE_DIR_REL = ".enclave-index/";
const sha = (b) => createHash("sha256").update(b).digest();
const varint = (n) => { const out = []; do { out.push((n % 128) + (n >= 128 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Buffer.from(out); };
const pbBytes = (field, data) => Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
const pbUint = (field, v) => Buffer.concat([varint(field * 8), varint(v)]);
export const cidBytes = (codec, digest) => Buffer.concat([Buffer.from([1, codec, 0x12, 0x20]), digest]);
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export function cidString(bytes) {
  let out = "b", acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += B32[(acc >>> bits) & 31]; } }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

export function dagpbEncode(links, data) {
  return Buffer.concat([...links.map((l) => pbBytes(2, Buffer.concat([pbBytes(1, l.cid), pbBytes(2, Buffer.from(l.name, "utf8")), pbUint(3, l.tsize)]))),
    pbBytes(1, data)]);
}
const unixfsFile = (filesize, blocksizes) => Buffer.concat([pbUint(1, 2), pbUint(3, filesize), ...blocksizes.map((b) => pbUint(4, b))]);
const UNIXFS_DIR = Buffer.from([0x08, 0x01]);

/** ipfs.rs chunk_sizes + the indexer's per-chunk sha256 -> leaf digests. */
export function leavesOf(bytes) {
  if (!bytes.length) return [sha(Buffer.alloc(0))];
  const out = [];
  for (let off = 0; off < bytes.length; off += CHUNK) out.push(sha(bytes.subarray(off, off + CHUNK)));
  return out;
}
const chunkSizes = (size) => { if (!size) return [0]; const n = Math.ceil(size / CHUNK), v = Array(n).fill(CHUNK); v[n - 1] = size - (n - 1) * CHUNK; return v; };

/** build_file_dag -> {cid, dagSize, nodes: [[cidBytes, block]], leaves: [[cidBytes, digest]]}. */
export function fileDag(leaves, size) {
  const sizes = chunkSizes(size), nodes = [];
  if (leaves.length === 1) return { cid: cidBytes(RAW, leaves[0]), dagSize: sizes[0], nodes };
  let depth = 1, cap = FANOUT; while (cap < leaves.length) { depth++; cap *= FANOUT; }
  const level = (ls, ss, d) => {
    if (d === 0) return { cid: cidBytes(RAW, ls[0]), tsize: ss[0], content: ss[0] };
    const group = Math.max(FANOUT ** (d - 1), 1), links = [], blocksizes = [];
    let dagTotal = 0, contentTotal = 0;
    for (let i = 0; i < ls.length; i += group) {
      const c = level(ls.slice(i, i + group), ss.slice(i, i + group), d - 1);
      dagTotal += c.tsize; contentTotal += c.content; blocksizes.push(c.content); links.push({ cid: c.cid, name: "", tsize: c.tsize });
    }
    const block = dagpbEncode(links, unixfsFile(contentTotal, blocksizes)), cid = cidBytes(DAG_PB, sha(block));
    nodes.push([cid, block]);
    return { cid, tsize: dagTotal + block.length, content: contentTotal };
  };
  const top = level(leaves, sizes, depth);
  return { cid: top.cid, dagSize: top.tsize, nodes };
}

/** build_dir */
export function buildDir(entries) {
  const links = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")));
  const block = dagpbEncode(links, UNIXFS_DIR), cid = cidBytes(DAG_PB, sha(block));
  return { cid, tsize: links.reduce((s, l) => s + l.tsize, 0) + block.length, block };
}

/** Phase::List over a bucket {key: Buffer} under `prefix` -> {objects: [{key, rel, bytes}], truncated, log}. */
export function listObjects(bucket, prefix, maxKeys = 50000) {
  const keys = Object.keys(bucket).filter((k) => k.startsWith(prefix)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const acc = [], log = [];
  for (const key of keys) {
    if (key.endsWith("/")) { if (bucket[key].length) log.push(`skipping ${key} (${bucket[key].length} bytes with a trailing slash)`); continue; }
    const rel = key.slice(prefix.length);
    if (rel.startsWith(CACHE_DIR_REL)) continue;
    acc.push({ key, rel, bytes: bucket[key] });
    if (acc.length >= maxKeys) return { objects: acc.slice(0, maxKeys), truncated: true, log };
  }
  return { objects: acc, truncated: false, log };
}

/** commit(): -> {root (cid string), nodes: Map<cidString, block>, files: [{rel, cid, size}], dirs: Map<relDir, cidString>, log}. */
export function commit(objects) {
  const nodes = new Map(), files = [], log = [];
  for (const o of objects) {
    const f = fileDag(leavesOf(o.bytes), o.bytes.length);
    for (const [c, b] of f.nodes) nodes.set(cidString(c), b);
    files.push({ key: o.key, rel: o.rel, size: o.bytes.length, cid: f.cid, dagSize: f.dagSize });
  }
  const root = new Map();
  const insert = (m, segs, fi, key) => {
    if (segs.length === 1) {
      if (m.has(segs[0])) log.push(`key ${key} collides with an existing entry ${segs[0]}; skipped`);
      else m.set(segs[0], { file: fi });
      return;
    }
    if (!m.has(segs[0])) m.set(segs[0], { dir: new Map() });
    const n = m.get(segs[0]);
    if (n.dir) insert(n.dir, segs.slice(1), fi, key); else log.push(`key ${key} collides with a file at ${segs[0]}; skipped`);
  };
  files.forEach((f, fi) => { const segs = f.rel.split("/").filter(Boolean); if (segs.length) insert(root, segs, fi, f.key); });
  const dirs = new Map();
  const encode = (m, rel) => {
    const links = [];
    for (const [name, child] of [...m].sort(([a], [b]) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")))) {   // BTreeMap<String> order = UTF-8 bytes
      const { cid, tsize } = child.dir ? encode(child.dir, rel ? rel + "/" + name : name) : { cid: files[child.file].cid, tsize: files[child.file].dagSize };
      links.push({ cid, name, tsize });
    }
    const d = buildDir(links);
    nodes.set(cidString(d.cid), d.block); dirs.set(rel, cidString(d.cid));
    return d;
  };
  const top = encode(root, "");
  return { root: cidString(top.cid), nodes, files: files.map((f) => ({ rel: f.rel, size: f.size, cid: cidString(f.cid) })), dirs, log };
}

/** The adapter's view of a bucket: listing + commit. */
export function adapterIndex(bucket, prefix = "", maxKeys = 50000) {
  const l = listObjects(bucket, prefix, maxKeys), s = commit(l.objects);
  return { ...s, truncated: l.truncated, log: [...l.log, ...s.log] };
}
