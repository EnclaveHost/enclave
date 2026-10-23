// cpio-entries.mjs: stream a newc initramfs.cpio.gz and return the named entries' bytes (others are skipped, never held).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
export async function cpioEntries(file, wanted) {
  const want = new Set(wanted), out = {};
  const it = fs.createReadStream(file).pipe(zlib.createGunzip())[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  const fill = async (n) => { while (buf.length < n) { const { value, done } = await it.next(); if (done) throw new Error("truncated cpio"); buf = buf.length ? Buffer.concat([buf, value]) : value; } };
  const take = async (n) => { await fill(n); const o = buf.subarray(0, n); buf = buf.subarray(n); return o; };
  const skip = async (n) => { while (n > 0) { if (!buf.length) { const { value, done } = await it.next(); if (done) throw new Error("truncated cpio"); buf = value; } const k = Math.min(n, buf.length); buf = buf.subarray(k); n -= k; } };
  for (;;) {
    const h = await take(110);
    if (h.subarray(0, 6).toString() !== "070701") throw new Error("not newc cpio");
    const size = parseInt(h.subarray(54, 62).toString(), 16), ns = parseInt(h.subarray(94, 102).toString(), 16);
    const name = (await take(ns + ((4 - ((110 + ns) % 4)) % 4))).subarray(0, ns - 1).toString().replace(/^\.\//, "");
    if (name === "TRAILER!!!") break;
    const pad = (4 - (size % 4)) % 4;
    if (want.has(name)) { out[name] = Buffer.from(await take(size)); await skip(pad); } else await skip(size + pad);
  }
  return out;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2]) {
  const e = await cpioEntries(process.argv[2], ["opt/custodian/custodian.mjs"]);
  const js = e["opt/custodian/custodian.mjs"].toString();
  const i = js.indexOf("0xe48699b8401564aace7a814ae4569b67a3f7eef5");
  console.log(js.length, i, JSON.stringify(js.slice(Math.max(0, i - 300), i + 1500)));
}
