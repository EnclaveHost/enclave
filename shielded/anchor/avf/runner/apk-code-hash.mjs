// apk-code-hash.mjs -- the pVM's codeHash for an installed APK, computed on the phone (STANDALONE.md): the APK's fs-verity
// Merkle root as its v4 signature carries it (pins.py fsverity_root, matched against the phone's `vm create-idsig`). The
// standalone host agent registers this as its measurement and holds its own VMs' evidence to it.
import fs from "node:fs";
import crypto from "node:crypto";

const BS = 4096;
const sha = (b) => crypto.createHash("sha256").update(b).digest();

/** sha256 leaves over 4096-byte blocks (the last zero-padded), levels hashed up in 4096-byte chunks, root = sha256 of the
 *  top block zero-padded to 4096. Streams the file: an APK carrying Node is ~100 MB. Returns hex. */
export async function apkCodeHash(file) {
  const leaves = [];
  let carry = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk, off = 0;
    for (; off + BS <= buf.length; off += BS) leaves.push(sha(buf.subarray(off, off + BS)));
    carry = Buffer.from(buf.subarray(off));
  }
  if (carry.length || !leaves.length) leaves.push(sha(Buffer.concat([carry, Buffer.alloc(BS - carry.length)])));
  let level = Buffer.concat(leaves);
  while (level.length > BS) {
    if (level.length % BS) level = Buffer.concat([level, Buffer.alloc(BS - (level.length % BS))]);
    const next = [];
    for (let i = 0; i < level.length; i += BS) next.push(sha(level.subarray(i, i + BS)));
    level = Buffer.concat(next);
  }
  if (level.length < BS) level = Buffer.concat([level, Buffer.alloc(BS - level.length)]);
  return sha(level).toString("hex");
}
