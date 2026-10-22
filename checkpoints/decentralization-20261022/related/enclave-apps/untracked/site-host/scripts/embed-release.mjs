#!/usr/bin/env node
// Embed the ONE pinned site release into the component's build input: release/site.car + release/release.json.
//
//   node scripts/embed-release.mjs --release <DIR>/<CID>   a site-release directory (`site/deploy.sh prepare`, or
//                                                         `site/deploy.sh fetch --cid <CID>` from any untrusted source)
//   node scripts/embed-release.mjs --car <FILE>            the release's CAR alone, from any source
//   [--lock release.lock.json] [--out release]
//
// The release is pinned in SOURCE by release.lock.json (CID, CAR sha256 and size). The 45 MB CAR itself is an input,
// never committed. Whatever the input's origin, all of these must agree before anything is written:
//   - the lock;
//   - the CAR's sha256 and size;
//   - the CAR's root;
//   - every block's hash;
//   - in --release mode, also the directory name and its release.json.
// The component re-verifies at serve time anyway (src/car.rs); this step stops a wrong release from being built at
// all. It writes nothing outside --out.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const here = (p) => new URL(p, import.meta.url).pathname;
const releaseDir = flag("--release"), carFile = flag("--car");
const lockFile = path.resolve(flag("--lock") || here("../release.lock.json"));
const out = path.resolve(flag("--out") || here("../release"));
if (!!releaseDir === !!carFile) { console.error("usage: embed-release.mjs (--release <DIR>/<CID> | --car <FILE>) [--lock FILE] [--out DIR]"); process.exit(2); }

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const base32 = (buf) => { let bits = 0, acc = 0, s = ""; for (const b of buf) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; s += B32[(acc >>> bits) & 31]; } acc &= (1 << bits) - 1; } if (bits) s += B32[(acc << (5 - bits)) & 31]; return s; };
const varint = (b, i) => { let v = 0, s = 0, n = 0; for (;;) { const x = b[i + n++]; if (x === undefined || n > 9) throw new Error("bad varint"); v += (x & 0x7f) * 2 ** s; s += 7; if (!(x & 0x80)) return [v, n]; } };
const cidAt = (b, i) => {
  if (b[i] !== 1 || ![0x55, 0x70].includes(b[i + 1]) || b[i + 2] !== 0x12 || b[i + 3] !== 0x20) throw new Error("not a CIDv1 raw/dag-pb sha2-256");
  return b.subarray(i, i + 36);
};

const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
if (lock.schema !== "site-host-release-lock/1" || !/^b[a-z2-7]{58}$/.test(lock.cid) || !/^[0-9a-f]{64}$/.test(lock.car?.sha256 || "") || !Number.isInteger(lock.car?.bytes))
  throw new Error(`${lockFile} is not a site-host-release-lock/1`);

let car, provenance = null;
if (releaseDir) {
  const dir = path.resolve(releaseDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "release.json"), "utf8"));
  car = fs.readFileSync(path.join(dir, "site.car"));
  if (manifest.schema !== "enclave-site-release/1") throw new Error("release.json is not an enclave-site-release/1 manifest");
  if (path.basename(dir) !== manifest.cid) throw new Error(`the release directory is not named by its CID (${manifest.cid})`);
  if (manifest.cid !== lock.cid) throw new Error(`the release ${manifest.cid} is not the locked release ${lock.cid}`);
  if (sha256(car) !== manifest.car?.sha256 || car.length !== manifest.car?.bytes) throw new Error("site.car is not the archive release.json records");
  provenance = { createdAt: manifest.createdAt, source: manifest.source, base: manifest.base };
} else {
  car = fs.readFileSync(path.resolve(carFile));
}
if (car.length !== lock.car.bytes || sha256(car) !== lock.car.sha256) throw new Error(`the CAR is not the locked archive (${lock.car.bytes} bytes, sha256 ${lock.car.sha256})`);

// header: {roots:[CID], version:1} (58 bytes)
const [hlen, hn] = varint(car, 0);
const h = car.subarray(hn, hn + hlen);
if (hlen !== 58 || h[10] !== 0x58 || h[11] !== 37 || h[12] !== 0) throw new Error("unsupported CAR header");
const root = "b" + base32(cidAt(h, 13));
if (root !== lock.cid) throw new Error(`the CAR's root ${root} is not the locked release ${lock.cid}`);
let p = hn + hlen, blocks = 0, sawRoot = false;
const seen = new Set();
while (p < car.length) {
  const [len, n] = varint(car, p);
  if (p + n + len > car.length || len < 36) throw new Error("a CAR section overruns the archive");
  const c = cidAt(car, p + n), body = car.subarray(p + n + 36, p + n + len);
  if (sha256(body) !== Buffer.from(c.subarray(4)).toString("hex")) throw new Error(`block b${base32(c)} does not hash to its CID`);
  const key = Buffer.from(c).toString("hex");
  if (seen.has(key)) throw new Error("the CAR repeats a block");
  seen.add(key); blocks++;
  if ("b" + base32(c) === root) sawRoot = true;
  p += n + len;
}
if (!sawRoot) throw new Error("the CAR lacks its root block");

fs.mkdirSync(out, { recursive: true });
const embed = { schema: "site-host-embed/1", cid: lock.cid, car: { sha256: lock.car.sha256, bytes: car.length, blocks }, release: provenance };
for (const [name, bytes] of [["site.car", car], ["release.json", Buffer.from(JSON.stringify(embed, null, 2) + "\n")]]) {
  const tmp = path.join(out, `.${name}.${process.pid}`);
  fs.writeFileSync(tmp, bytes, { flag: "wx" });
  fs.renameSync(tmp, path.join(out, name));
}
console.log(`embedded ${lock.cid} (${blocks} blocks, ${car.length} bytes, sha256 ${lock.car.sha256}) into ${out}`);
