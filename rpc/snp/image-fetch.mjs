// Fetch a whole-VM image by content address, for a host's instance pool (rpc/snp/vm-manager.mjs).
//
// A catalog version that wants to run on hosts whose operators never copied its image names the image's manifest:
//   config.image.manifest = { cid, sha256, bytes }
// The manifest is the image's IMAGE.json (what rpc/snp/build_image.py writes and launch.py checks before every launch),
// with a "cid" beside each artifact's "bytes" and "sha256". Every byte is fetched from a gateway this host's operator
// chose and is accepted only if its length and SHA-256 are the ones named: the manifest's by the version, each
// artifact's by the manifest. A gateway can refuse or stall; it cannot substitute.
//
// What this does not decide: whether the image is the version's. The launch check does (root hash and command line
// against the version, launchConfigFor) and then SEV-SNP's launch measurement and dm-verity do. A wrong manifest is
// refused here only so that gigabytes are not fetched for an image that would never launch.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ARTIFACTS = ["vmlinuz", "initrd.img", "root.img", "root.verity"];   // what launch.py opens, no other name
export const MANIFEST_MAX_BYTES = 256 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
// CIDv1 base32 or CIDv0 base58: letters and digits only, so it is safe inside a URL path
const CID = /^(?:b[a-z2-7]{20,120}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;
const size = (v) => Number.isSafeInteger(v) && v > 0;

/** { cid, sha256, bytes } as a catalog version or a manifest row names content. Throws on anything else. */
export function contentRef(v, what) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} must be {cid, sha256, bytes}`);
  if (!CID.test(String(v.cid))) throw new Error(`${what}.cid is not a CID`);
  if (!HEX64.test(String(v.sha256))) throw new Error(`${what}.sha256 must be 32-byte lowercase hex`);
  if (!size(v.bytes)) throw new Error(`${what}.bytes must be a positive whole number`);
  return { cid: v.cid, sha256: v.sha256, bytes: v.bytes };
}

/** The image a plan names for fetching: { rootHash, cmdlineSha256, manifest }. */
export function fetchableImage(image) {
  if (!image || !HEX64.test(String(image.rootHash)) || !HEX64.test(String(image.cmdlineSha256))) throw new Error("the image names no root hash and command line");
  const manifest = contentRef(image.manifest, "image.manifest");
  if (manifest.bytes > MANIFEST_MAX_BYTES) throw new Error("the image manifest is larger than a manifest is");
  return { rootHash: image.rootHash, cmdlineSha256: image.cmdlineSha256, manifest };
}

/** The manifest's bytes, read against the image the version names. -> { meta, rows, total } */
export function readManifest(buf, image, { maxBytes }) {
  let meta; try { meta = JSON.parse(buf.toString("utf8")); } catch { throw new Error("the image manifest is not JSON"); }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("the image manifest is not an object");
  if (meta.rootHash !== image.rootHash) throw new Error("the manifest is for another root hash");
  if (typeof meta.cmdline !== "string" || createHash("sha256").update(meta.cmdline).digest("hex") !== image.cmdlineSha256)
    throw new Error("the manifest's command line is not the version's");
  const a = meta.artifacts, names = a && typeof a === "object" && !Array.isArray(a) ? Object.keys(a).sort() : [];
  if (names.join() !== [...ARTIFACTS].sort().join()) throw new Error(`the manifest must list exactly ${ARTIFACTS.join(", ")}`);
  const rows = ARTIFACTS.map((name) => ({ name, ...contentRef(a[name], `artifacts.${name}`) }));
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  if (!(total <= maxBytes)) throw new Error(`the image is ${total} bytes, more than this host fetches (${maxBytes})`);
  return { meta, rows, total };
}

/** One content reference into a file, from the first gateway that serves exactly it. The file exists only if it matched. */
export async function fetchContent(ref, dest, { gateways, fetch = globalThis.fetch, timeoutMs = 6 * 3600_000 }) {
  const reasons = [];
  for (const gw of gateways) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let fd = null;
    try {
      const r = await fetch(gw + ref.cid, { signal: ctrl.signal, redirect: "follow" });
      if (!r.ok || !r.body) throw new Error(`answered ${r.status}`);
      const hash = createHash("sha256"); let got = 0;
      fd = fs.openSync(dest, "w", 0o600);
      for await (const chunk of r.body) {
        got += chunk.length;
        if (got > ref.bytes) throw new Error("served more bytes than named");
        hash.update(chunk); fs.writeSync(fd, chunk);
      }
      if (got !== ref.bytes) throw new Error(`served ${got} of ${ref.bytes} bytes`);
      if (hash.digest("hex") !== ref.sha256) throw new Error("served other bytes than named");
      fs.fsyncSync(fd); fs.closeSync(fd);
      return;
    } catch (e) {
      ctrl.abort();
      if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
      fs.rmSync(dest, { force: true });
      reasons.push(`${new URL(gw).host}: ${e.name === "AbortError" ? "timed out" : e.message}`);
    } finally { clearTimeout(timer); }
  }
  throw new Error(`no gateway served ${ref.cid.slice(0, 16)}… (${reasons.join("; ")})`);
}

/** Fetch `image` into <dir>/<rootHash>/. The directory appears, complete, by one rename; a failure leaves nothing. */
export async function fetchImage(image, dir, { gateways, maxBytes, fetch = globalThis.fetch, freeBytes = (d) => { const s = fs.statfsSync(d); return s.bavail * s.bsize; } }) {
  image = fetchableImage(image);
  const final = path.join(dir, image.rootHash), tmp = path.join(dir, ".fetch-" + image.rootHash);
  if (fs.existsSync(path.join(final, "IMAGE.json"))) return { rootHash: image.rootHash, held: true };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { mode: 0o700 });
  try {
    const mf = path.join(tmp, "IMAGE.json");
    await fetchContent(image.manifest, mf, { gateways, fetch, timeoutMs: 60_000 });
    const { rows, total } = readManifest(fs.readFileSync(mf), image, { maxBytes });
    const free = freeBytes(dir);
    if (!(free >= total * 1.1)) throw new Error(`the image needs ${total} bytes and a tenth to spare; ${free} are free`);
    for (const row of rows) await fetchContent(row, path.join(tmp, row.name), { gateways, fetch });
    fs.rmSync(final, { recursive: true, force: true });   // a directory without IMAGE.json is not an image
    fs.renameSync(tmp, final);
    return { rootHash: image.rootHash, held: true, bytes: total };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}
