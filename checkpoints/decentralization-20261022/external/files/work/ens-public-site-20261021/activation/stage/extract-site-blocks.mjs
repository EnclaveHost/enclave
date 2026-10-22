#!/usr/bin/env node
// Materialize the blocks of the site CARs a front already holds, one file per block at <out>/ipfs/<cid>, so the existing
// Caddy can answer trustless-gateway block requests (GET/HEAD /ipfs/<cid>?format=raw) for EVERY block of a published
// site, not only its root (ipfs-trustless-routes.caddy). No new service: plain files under one directory.
//
//   node extract-site-blocks.mjs --sites /opt/enclave-site --out /opt/enclave-site-blocks [--cid <root> ...] [--check]
//
// For each selected <sites>/<root>/site.car (default: every root directory holding one):
//   - the CARv1 header must be exactly the canonical one-root header naming <root> (the directory name);
//   - every block's CID must be CIDv1, codec dag-pb (0x70) or raw (0x55), multihash sha2-256, and its bytes must hash to
//     it; a block that does not is refused and NOTHING of that CAR is written;
//   - the root block must be present;
//   - a block already in <out>/ipfs must be byte-identical (content addressing: it can only be the same bytes);
//   - new files are written to a temporary name in <out>/ipfs and renamed into place (no partial file is ever served).
// --check writes nothing and reports what would be written. Read-only on <sites>; never follows symlinks out of it.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export const cidString = (bytes) => { let bits = 0, val = 0, s = "b"; for (const x of bytes) { val = (val << 8) | x; bits += 8; while (bits >= 5) { s += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) s += B32[(val << (5 - bits)) & 31]; return s; };
export const cidBytes = (str) => { if (!/^b[a-z2-7]+$/.test(str)) throw Error("not a base32 CIDv1: " + str); const out = []; let bits = 0, val = 0; for (const c of str.slice(1)) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const ROOT_RE = /^bafy[a-z2-7]{55}$/;               // a dag-pb CIDv1 sha2-256 directory root, as the release tool mints it
const MAX_VARINT = 5;
function varintAt(b, i) { let v = 0, mul = 1; for (let k = 0; k < MAX_VARINT; k++) { if (i + k >= b.length) throw Error("truncated varint"); const x = b[i + k]; v += (x & 127) * mul;
  if (!(x & 128)) { if (k > 0 && x === 0) throw Error("non-minimal varint"); return [v, i + k + 1]; } mul *= 128; } throw Error("oversized varint"); }
export function carHeaderOf(root) {
  const c = cidBytes(root);
  return Buffer.concat([Buffer.from([0xa2, 0x65]), Buffer.from("roots"), Buffer.from([0x81, 0xd8, 0x2a, 0x58, c.length + 1, 0]), c, Buffer.from([0x67]), Buffer.from("version"), Buffer.from([1])]);
}
/** The verified blocks of one site CAR -> [{cid, bytes}] (throws on anything but a clean CARv1 of `root`). */
export function blocksOf(car, root) {
  const header = carHeaderOf(root), [hlen, h0] = varintAt(car, 0);
  if (hlen !== header.length || !car.subarray(h0, h0 + hlen).equals(header)) throw Error(`the CAR header is not exactly {roots: [${root}], version: 1}`);
  const out = [], seen = new Set(); let i = h0 + hlen;
  while (i < car.length) {
    const [len, at] = varintAt(car, i), end = at + len;
    if (len < 36 || end > car.length) throw Error("truncated CAR block");
    const c = car.subarray(at, at + 36), data = car.subarray(at + 36, end);
    if (c[0] !== 1 || (c[1] !== 0x70 && c[1] !== 0x55) || c[2] !== 0x12 || c[3] !== 0x20) throw Error("a block CID is not CIDv1 dag-pb/raw sha2-256");
    if (!createHash("sha256").update(data).digest().equals(c.subarray(4))) throw Error(`block ${cidString(c)} does not hash to its CID`);
    const k = cidString(c);
    if (!seen.has(k)) { seen.add(k); out.push({ cid: k, bytes: data }); }
    i = end;
  }
  if (!seen.has(root)) throw Error("the CAR lacks its root block");
  return out;
}
export function extract({ sites, out, cids = null, check = false, log = () => {} }) {
  const roots = cids ?? fs.readdirSync(sites).filter((d) => ROOT_RE.test(d) && fs.existsSync(path.join(sites, d, "site.car")));
  const summary = { sites: [], written: 0, present: 0, check };
  const dir = path.join(out, "ipfs");   // <out>/ipfs/<cid>: Caddy's file matcher tries the request path itself
  if (!check) fs.mkdirSync(dir, { recursive: true });
  for (const root of roots) {
    if (!ROOT_RE.test(root)) throw Error("not a site root CID: " + root);
    const file = path.join(sites, root, "site.car"), st = fs.lstatSync(file);
    if (!st.isFile()) throw Error(`${file} is not a regular file`);
    const blocks = blocksOf(fs.readFileSync(file), root);            // all verified before anything of this CAR is written
    let written = 0, present = 0;
    for (const { cid, bytes } of blocks) {
      const dest = path.join(dir, cid);
      if (fs.existsSync(dest)) {
        if (!fs.readFileSync(dest).equals(bytes)) throw Error(`${dest} exists with other bytes than block ${cid}`);
        present++; continue;
      }
      if (!check) { const tmp = path.join(dir, `.${cid}.${process.pid}.tmp`); fs.writeFileSync(tmp, bytes, { mode: 0o644 }); fs.renameSync(tmp, dest); }
      written++;
    }
    summary.sites.push({ root, blocks: blocks.length, written, present }); summary.written += written; summary.present += present;
    log(`${root}: ${blocks.length} blocks (${written} ${check ? "to write" : "written"}, ${present} present)`);
  }
  return summary;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const cids = a.flatMap((x, i) => (a[i - 1] === "--cid" ? [x] : []));
  if (!opt("--sites") || !opt("--out")) { console.error("usage: extract-site-blocks.mjs --sites DIR --out DIR [--cid ROOT ...] [--check]"); process.exit(2); }
  const s = extract({ sites: opt("--sites"), out: opt("--out"), cids: cids.length ? cids : null, check: a.includes("--check"), log: (m) => console.error(m) });
  console.log(JSON.stringify(s));
}
