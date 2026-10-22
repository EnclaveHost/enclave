#!/usr/bin/env node
// Embed ONE site release into the component source: release/site.car and release/release.json.
//
//   node scripts/embed-release.mjs --release <DIR>/<CID> [--out release]
//
// The input is a release directory from the enclave repo's site-release tool (`site/deploy.sh prepare`, or `fetch` of
// a CID from any untrusted gateway): site/, site.car, release.json, ...
// The check here is independent of that tool:
//   - the directory name, release.json's cid and the CAR's root must be the same CID;
//   - the CAR's sha256 and size must be what release.json records;
//   - every block must hash to its CID.
// The component re-verifies at serve time anyway (src/car.rs), so this step only stops a wrong release from being
// built at all. It writes nothing outside --out, and nothing until every check has passed.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const releaseDir = flag("--release");
const out = path.resolve(flag("--out") || new URL("../release", import.meta.url).pathname);
if (!releaseDir) { console.error("usage: embed-release.mjs --release <DIR>/<CID> [--out release]"); process.exit(2); }

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const base32 = (buf) => { let bits = 0, acc = 0, s = ""; for (const b of buf) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; s += B32[(acc >>> bits) & 31]; } acc &= (1 << bits) - 1; } if (bits) s += B32[(acc << (5 - bits)) & 31]; return s; };
const varint = (b, i) => { let v = 0, s = 0, n = 0; for (;;) { const x = b[i + n++]; if (x === undefined || n > 9) throw new Error("bad varint"); v += (x & 0x7f) * 2 ** s; s += 7; if (!(x & 0x80)) return [v, n]; } };
const cidAt = (b, i) => {
  if (b[i] !== 1 || ![0x55, 0x70].includes(b[i + 1]) || b[i + 2] !== 0x12 || b[i + 3] !== 0x20) throw new Error("not a CIDv1 raw/dag-pb sha2-256");
  return b.subarray(i, i + 36);
};

const dir = path.resolve(releaseDir);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "release.json"), "utf8"));
const car = fs.readFileSync(path.join(dir, "site.car"));
if (manifest.schema !== "enclave-site-release/1") throw new Error("release.json is not an enclave-site-release/1 manifest");
if (path.basename(dir) !== manifest.cid) throw new Error(`the release directory is not named by its CID (${manifest.cid})`);
if (sha256(car) !== manifest.car?.sha256 || car.length !== manifest.car?.bytes) throw new Error("site.car is not the archive release.json records");

// header: {roots:[CID], version:1} (58 bytes)
const [hlen, hn] = varint(car, 0);
const h = car.subarray(hn, hn + hlen);
if (hlen !== 58 || h[10] !== 0x58 || h[11] !== 37 || h[12] !== 0) throw new Error("unsupported CAR header");
const root = "b" + base32(cidAt(h, 13));
if (root !== manifest.cid) throw new Error(`the CAR's root ${root} is not the release ${manifest.cid}`);
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
const embed = {
  schema: "site-host-embed/1", cid: manifest.cid, car: { sha256: manifest.car.sha256, bytes: car.length, blocks },
  release: { createdAt: manifest.createdAt, source: manifest.source, base: manifest.base },
};
for (const [name, bytes] of [["site.car", car], ["release.json", Buffer.from(JSON.stringify(embed, null, 2) + "\n")]]) {
  const tmp = path.join(out, `.${name}.${process.pid}`);
  fs.writeFileSync(tmp, bytes, { flag: "wx" });
  fs.renameSync(tmp, path.join(out, name));
}
console.log(`embedded ${manifest.cid} (${blocks} blocks, ${car.length} bytes, sha256 ${manifest.car.sha256}) into ${out}`);
