// Deterministic local UnixFS/CAR fixtures, built byte-by-byte here (independently of site/js/core/ipfs-car.js):
// dag-pb PBNode = Links (field 2) then Data (field 1); PBLink = Hash 1, Name 2, Tsize 3; UnixFS Data = Type 1 (2 = file),
// Data 2, filesize 3, blocksizes 4; CIDv0 = sha2-256 multihash, CIDv1 = 0x01 codec 0x12 0x20 digest; CARv1 = varint-framed
// dag-cbor header {roots, version: 1} then varint(len(cid)+len(block)) cid block sections.
import { createHash } from "node:crypto";
export const sha = (b) => new Uint8Array(createHash("sha256").update(b).digest());
export const cat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n); let i = 0; for (const p of parts){ o.set(p, i); i += p.length; } return o; };
export const vi = (n) => { const o = []; do { o.push((n % 128) | (n >= 128 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Uint8Array.from(o); };
const fld = (n, b) => cat(vi(n * 8 + 2), vi(b.length), b), num = (n, v) => cat(vi(n * 8), vi(v));
export const ufsFile = ({ data = null, filesize = 0, blocksizes = [] } = {}) => cat(num(1, 2), ...(data ? [fld(2, data)] : []), num(3, filesize), ...blocksizes.map((s) => num(4, s)));
export const pbNode = (links, data) => cat(...links.map((l) => fld(2, cat(fld(1, l.cid), fld(2, new Uint8Array(0)), num(3, l.tsize || 0)))), ...(data ? [fld(1, data)] : []));
export const v0 = (block) => cat(Uint8Array.of(0x12, 0x20), sha(block));
export const v1 = (codec, block) => cat(Uint8Array.of(1, codec, 0x12, 0x20), sha(block));
// dag-cbor {"roots": [CID(root)], "version": 1}
const cborHeader = (root) => { const c = cat(Uint8Array.of(0), root);
  return cat(Uint8Array.of(0xa2, 0x65), new TextEncoder().encode("roots"), Uint8Array.of(0x81, 0xd8, 0x2a, 0x58, c.length), c,
             Uint8Array.of(0x67), new TextEncoder().encode("version"), Uint8Array.of(0x01)); };
export function car(root, blocks){            // blocks: [[cidBytes, blockBytes]]
  const h = cborHeader(root);
  return cat(vi(h.length), h, ...blocks.map(([c, b]) => cat(vi(c.length + b.length), c, b)));
}
export const bytesOf = (s) => new TextEncoder().encode(s);
// a file -> one Kubo-v0-default dag-pb leaf (data inline)
export const pbLeaf = (data) => pbNode([], ufsFile({ data, filesize: data.length }));
// a root over children [{cid, block, size}] (size = file bytes under it)
export const pbRoot = (kids) => pbNode(kids.map((k) => ({ cid: k.cid, tsize: k.block.length })), ufsFile({ filesize: kids.reduce((a, k) => a + k.size, 0), blocksizes: kids.map((k) => k.size) }));
export const leaf = (kind, data) => { const block = kind === "raw" ? data : pbLeaf(data);
  return { cid: kind === "raw" ? v1(0x55, block) : kind === "v1pb" ? v1(0x70, block) : v0(block), block, size: data.length, data }; };
export const node = (kids, ver = "v1") => { const block = pbRoot(kids); return { cid: ver === "v0" ? v0(block) : v1(0x70, block), block, size: kids.reduce((a, k) => a + k.size, 0), kids }; };
export const flatten = (n) => n.kids ? n.kids.flatMap(flatten) : [n];
export const fileOf = (n) => cat(...flatten(n).map((l) => l.data));
export const blocksOf = (n, seen = new Map()) => { const h = Buffer.from(n.cid).toString("hex"); if (!seen.has(h)){ seen.set(h, [n.cid, n.block]); for (const k of n.kids || []) blocksOf(k, seen); } return [...seen.values()]; };
export const configText = (seed, pad = 0) => JSON.stringify({ tools: { seed }, models: { primary: "m" + seed }, pad: "p".repeat(pad) });
