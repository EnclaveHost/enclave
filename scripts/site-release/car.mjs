// CARv1 for a site release: written from an imported DAG (root block first, then depth-first in link order, each
// block once, as `ipfs dag export` orders them), and verified from the bytes alone. Verification trusts nothing the
// CAR says about itself: one root equal to the expected CID, every block hashing to its CID, every block reachable
// from the root present and nothing extra, and every file reassembled and compared with the manifest's sha256.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { cidString, cidParse, decodePb, decodeUnixfs } from "./unixfs.mjs";

const varint = (n) => { const out = []; do { out.push((n % 128) + (n >= 128 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Buffer.from(out); };
// dag-cbor {roots: [CID], version: 1}: keys length-first ("roots" before "version"), the CID as tag 42 over 0x00 ++ bytes
function header(root) {
  const c = Buffer.concat([Buffer.from([0x00]), root]);
  return Buffer.concat([Buffer.from([0xa2, 0x65]), Buffer.from("roots"), Buffer.from([0x81, 0xd8, 0x2a, 0x58, c.length]), c,
    Buffer.from([0x67]), Buffer.from("version"), Buffer.from([0x01])]);
}

/** Depth-first block order from the root (each CID once). */
export function blockOrder(cid, blocks) {
  const order = [], seen = new Set();
  const visit = (k) => {
    if (seen.has(k)) return; seen.add(k);
    const b = blocks.get(k); if (!b) throw new Error(`block ${k} is missing from the DAG`);
    order.push(k);
    if (cidParse(k)[1] === 0x70) for (const l of decodePb(b).links) visit(cidString(l.cid));
  };
  visit(cid);
  return order;
}

/** Write the CAR to `file` -> {sha256, bytes}. */
export function writeCar(file, cid, blocks) {
  const fd = fs.openSync(file, "wx", 0o644), hash = createHash("sha256");
  let bytes = 0;
  const put = (b) => { fs.writeSync(fd, b); hash.update(b); bytes += b.length; };
  try {
    const h = header(cidParse(cid)); put(varint(h.length)); put(h);
    for (const k of blockOrder(cid, blocks)) { const c = cidParse(k), b = blocks.get(k); put(varint(c.length + b.length)); put(c); put(b); }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return { sha256: hash.digest("hex"), bytes };
}

/** Parse and verify a CAR. -> {root, blocks: Map, files: [{path, bytes, sha256, cid}]} or throws. */
export function readCar(bytes, { expectRoot } = {}) {
  let i = 0;
  const read = () => { let n = 0, mul = 1, b; do { if (i >= bytes.length) throw new Error("truncated CAR"); b = bytes[i++]; n += (b & 127) * mul; mul *= 128; } while (b & 128); return n; };
  const hlen = read(), h = bytes.subarray(i, i + hlen); i += hlen;
  // exactly the one header shape we write (and kubo writes): one dag-pb root, version 1
  if (h.length !== 58 || h[0] !== 0xa2 || h[1] !== 0x65 || h.subarray(2, 7).toString() !== "roots" || h[7] !== 0x81 || h[8] !== 0xd8 || h[9] !== 0x2a
      || h[10] !== 0x58 || h[11] !== 37 || h[12] !== 0 || h[49] !== 0x67 || h.subarray(50, 57).toString() !== "version" || h[57] !== 0x01)
    throw new Error("unsupported CAR header (one root, CARv1)");
  const root = cidString(h.subarray(13, 49));
  if (expectRoot && root !== expectRoot) throw new Error(`the CAR's root is ${root}, not ${expectRoot}`);
  const blocks = new Map();
  while (i < bytes.length) {
    const len = read(), end = i + len;
    if (end > bytes.length || len < 36) throw new Error("truncated CAR block");
    const c = bytes.subarray(i, i + 36), data = bytes.subarray(i + 36, end), k = cidString(c);
    cidParse(k);
    if (!createHash("sha256").update(data).digest().equals(c.subarray(4))) throw new Error(`CAR block ${k} does not hash to its CID`);
    if (blocks.has(k)) throw new Error(`CAR block ${k} appears twice`);
    blocks.set(k, data); i = end;
  }
  const reachable = new Set(blockOrder(root, blocks));
  for (const k of blocks.keys()) if (!reachable.has(k)) throw new Error(`CAR carries a block not reachable from the root: ${k}`);
  return { root, blocks, files: walkFiles(root, blocks) };
}

/** Every file of the DAG, reassembled from its blocks (a UnixFS directory tree of raw or balanced files). */
export function walkFiles(root, blocks, { onFile } = {}) {
  const files = [];
  const fileBytes = (k) => {
    const c = cidParse(k), b = blocks.get(k);
    if (c[1] === 0x55) return [b];
    const n = decodePb(b), u = decodeUnixfs(n.data);
    if (u.type !== 2) throw new Error(`${k} is not a UnixFS file`);
    const parts = n.links.flatMap((l) => fileBytes(cidString(l.cid)));
    const size = parts.reduce((s, p) => s + p.length, 0);
    if (u.filesize !== null && u.filesize !== size) throw new Error(`${k}: file size does not match its blocks`);
    return parts;
  };
  const dir = (k, rel) => {
    const c = cidParse(k);
    if (c[1] !== 0x70) throw new Error(`${rel || "root"} is not a directory`);
    const n = decodePb(blocks.get(k)), u = decodeUnixfs(n.data);
    if (u.type !== 1) throw new Error(`${rel || "root"} is not a basic UnixFS directory`);
    for (const l of n.links) {
      const p = rel ? rel + "/" + l.name : l.name, ck = cidString(l.cid);
      if (!l.name || /[\/\0]/.test(l.name) || l.name === "." || l.name === "..") throw new Error(`unsafe name in the DAG: ${JSON.stringify(l.name)}`);
      const isDir = cidParse(ck)[1] === 0x70 && decodeUnixfs(decodePb(blocks.get(ck)).data).type === 1;
      if (isDir) { dir(ck, p); continue; }
      const parts = fileBytes(ck), hash = createHash("sha256");
      for (const x of parts) hash.update(x);
      const bytes = parts.reduce((s, x) => s + x.length, 0);
      files.push({ path: p, bytes, sha256: hash.digest("hex"), cid: ck });
      if (onFile) onFile(p, parts);
    }
  };
  dir(root, "");
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Write a verified CAR's tree under `out` (a new directory). Every path is checked to stay inside it. */
export function extractCar(car, out) {
  fs.mkdirSync(out, { recursive: false });
  walkFiles(car.root, car.blocks, { onFile: (p, parts) => {
    const abs = path.join(out, p);
    if (!abs.startsWith(path.resolve(out) + path.sep)) throw new Error(`refusing a path outside the tree: ${p}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.concat(parts), { flag: "wx", mode: 0o644 });
  } });
}
