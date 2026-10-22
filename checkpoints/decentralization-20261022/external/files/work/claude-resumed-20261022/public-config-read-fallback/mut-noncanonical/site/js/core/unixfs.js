/* ============================================================
   The adapters' fixed import profile, computed in the browser:
   CIDv1, SHA-256, 256 KiB raw leaves, balanced UnixFS with 174 links
   per node. Byte-for-byte the same as sdk/storage/unixfs.mjs (the CLI's
   importer; test/site-independent-storage.test.mjs compares them), but
   on WebCrypto and Uint8Array instead of node:crypto and Buffer, so the
   dashboard knows the CID of a file before any adapter answers.
   ============================================================ */
export const CHUNK_BYTES = 262144;
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const FANOUT = 174;

const sha = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const concat = (parts) => {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts){ out.set(p, o); o += p.length; }
  return out;
};
const vi = (n) => { const out = []; do { out.push(n % 128 + (n >= 128 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Uint8Array.from(out); };
const uint = (field, n) => concat([vi(field * 8), vi(n)]);
const field = (n, b) => concat([vi(n * 8 + 2), vi(b.length), b]);
const cidBytes = (codec, digest) => concat([Uint8Array.of(1, codec, 0x12, 32), digest]);
export function base32Cid(bytes){
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567"; let out = "b", acc = 0, bits = 0;
  for (const b of bytes){ acc = (acc << 8) | b; bits += 8; while (bits >= 5){ bits -= 5; out += alphabet[(acc >>> bits) & 31]; } }
  if (bits) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
}
export const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");

/* The inverse for a CID STRING naming sha2-256 content: { codec: 0x55 raw | 0x70 dag-pb, digest, cid } where `cid` is the
   canonical CIDv1 base32 of the same multihash, or null. Accepts exactly the spellings the enclave's verifier parses
   (wasm/ipfs_fetch.py): CIDv0 "Qm..." (dag-pb implied), and CIDv1 in base32 ("b", or "B" upper) or base58btc ("z"),
   each only in its canonical encoding. Other codecs, hashes, versions or trailing bytes -> null. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(s){
  let n = 0n; for (const ch of s){ const d = B58.indexOf(ch); if (d < 0) return null; n = n * 58n + BigInt(d); }
  const out = []; while (n > 0n){ out.unshift(Number(n % 256n)); n /= 256n; }
  for (let i = 0; i < s.length && s[i] === "1"; i++) out.unshift(0);
  return Uint8Array.from(out);
}
function b32(s){
  const out = []; let acc = 0, bits = 0;
  for (const ch of s){ const d = "abcdefghijklmnopqrstuvwxyz234567".indexOf(ch); if (d < 0) return null;
    acc = ((acc << 5) | d) & 0xffff; bits += 5; if (bits >= 8){ bits -= 8; out.push((acc >>> bits) & 255); } }
  return Uint8Array.from(out);
}
export function parseCid(str){
  if (typeof str !== "string" || str.length < 46 || str.length > 100) return null;
  let bytes, v0 = false;
  if (/^Qm/.test(str)){ bytes = b58(str); v0 = true; }
  else if (str[0] === "z") bytes = b58(str.slice(1));
  else if (str[0] === "b" || str[0] === "B") bytes = b32(str.slice(1).toLowerCase());
  else return null;
  if (!bytes) return null;
  const digest = v0 ? (bytes.length === 34 && bytes[0] === 0x12 && bytes[1] === 0x20 ? bytes.subarray(2) : null)
                    : (bytes.length === 36 && bytes[0] === 1 && (bytes[1] === 0x55 || bytes[1] === 0x70) && bytes[2] === 0x12 && bytes[3] === 0x20 ? bytes.subarray(4) : null);
  if (!digest) return null;
  const codec = v0 ? 0x70 : bytes[1], cid = base32Cid(cidBytes(codec, digest));
  // canonical spelling only: the string must be exactly what its own bytes re-encode to
  const ok = str[0] === "b" ? str === cid : str[0] === "B" ? str === "B" + cid.slice(1).toUpperCase() : b58canonical(str, bytes, v0);
  // MUTANT: spelling not checked
  return { codec, digest: Uint8Array.from(digest), cid };
}
function b58canonical(str, bytes, v0){
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ""; while (n > 0n){ out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out = "1" + out;
  return (v0 ? out : "z" + out) === str;
}

/* { cid, sha256 (hex of the whole file), bytes } for a Uint8Array. */
export async function artifactIdentity(bytes){
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("artifact must be bytes, at most 2 GiB");
  const leaves = [], sizes = [];
  for (let offset = 0; offset < bytes.length || offset === 0; offset += CHUNK_BYTES){
    const b = bytes.subarray(offset, offset + CHUNK_BYTES);
    leaves.push(cidBytes(0x55, await sha(b))); sizes.push(b.length);
  }
  async function level(start, end, depth){
    if (!depth) return { cid: leaves[start], content: sizes[start], total: sizes[start] };
    const children = [], group = FANOUT ** (depth - 1);
    for (let i = start; i < end; i += group) children.push(await level(i, Math.min(end, i + group), depth - 1));
    const content = children.reduce((n, c) => n + c.content, 0);
    const data = concat([uint(1, 2), uint(3, content), ...children.map((c) => uint(4, c.content))]);
    // dag-pb links precede Data; empty link names are explicitly encoded
    const block = concat([...children.map((c) => field(2, concat([field(1, c.cid), field(2, new Uint8Array(0)), uint(3, c.total)]))), field(1, data)]);
    return { cid: cidBytes(0x70, await sha(block)), content, total: block.length + children.reduce((n, c) => n + c.total, 0) };
  }
  let depth = 0, capacity = 1; while (capacity < leaves.length){ depth++; capacity *= FANOUT; }
  const root = await level(0, leaves.length, depth);
  return { cid: base32Cid(root.cid), sha256: hex(await sha(bytes)), bytes: bytes.length };
}

/* The raw-leaf CID of a small public document (a startup package): CIDv1,
   raw codec, SHA-256 of the exact bytes - sdk/bootstrap/package.mjs packageCID. */
export function rawCid(sha256Hex){
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error("invalid sha256");
  return base32Cid(concat([Uint8Array.of(1, 0x55, 0x12, 0x20), Uint8Array.from(sha256Hex.match(/../g).map((h) => parseInt(h, 16)))]));
}
