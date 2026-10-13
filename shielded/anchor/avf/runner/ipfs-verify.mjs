// ipfs-verify.mjs -- wasm/ipfs_fetch.py in JavaScript, for a host agent that runs where there is no Python (the phone,
// STANDALONE.md): fetch a CID's DAG from an untrusted gateway as a CAR, check every block hashes to its own CID, and
// reassemble the file from the requested root. A gateway that swaps or corrupts bytes fails here. The same rules as the
// Python (test/ipfs-verify.test.mjs holds both to the same answers): CIDv0/CIDv1, sha2-256 only, raw leaves and dag-pb
// UnixFS files, a node-visit budget against hash-valid "diamond" DAGs, a size cap on the CAR and on the file.
import crypto from "node:crypto";

const RAW = 0x55, DAGPB = 0x70, SHA2_256 = 0x12;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();

function uvarint(buf, pos) {
  let shift = 0n, result = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error("truncated varint");
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) {
      if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("varint too large");
      return [Number(result), pos];
    }
    shift += 7n;
    if (shift > 63n) throw new Error("varint too long");
  }
}

function b58decode(s) {
  let num = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) throw new Error("bad base58"); num = num * 58n + BigInt(i); }
  let hex = num ? num.toString(16) : "";
  if (hex.length % 2) hex = "0" + hex;
  const pad = s.length - s.replace(/^1+/, "").length;
  return Buffer.concat([Buffer.alloc(pad), Buffer.from(hex, "hex")]);
}

function b32decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0; const out = [];
  for (const ch of s.toUpperCase()) {
    const i = A.indexOf(ch); if (i < 0) throw new Error("bad base32");
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A multibase CID string -> its binary form (the CAR key form). */
export function cidBytes(cid) {
  if (cid.startsWith("Qm")) return b58decode(cid);
  const mb = cid[0], body = cid.slice(1);
  if (mb === "b" || mb === "B") return b32decode(body);
  if (mb === "z") return b58decode(body);
  throw new Error(`unsupported CID multibase ${JSON.stringify(mb)}`);
}

function cidInfo(buf, pos) {
  const start = pos;
  if (buf[pos] === 0x12 && buf[pos + 1] === 0x20) {
    const c = Buffer.from(buf.subarray(pos, pos + 34));
    if (c.length !== 34) throw new Error("truncated CIDv0");
    return [c, { codec: DAGPB, mh: SHA2_256, digest: c.subarray(2, 34) }, pos + 34];
  }
  let ver, codec, mh, len;
  [ver, pos] = uvarint(buf, pos);
  if (ver !== 1) throw new Error(`unsupported CID version ${ver}`);
  [codec, pos] = uvarint(buf, pos); [mh, pos] = uvarint(buf, pos); [len, pos] = uvarint(buf, pos);
  if (pos + len > buf.length) throw new Error("truncated CID");
  const digest = Buffer.from(buf.subarray(pos, pos + len)); pos += len;
  return [Buffer.from(buf.subarray(start, pos)), { codec, mh, digest }, pos];
}

function fields(msg) {
  const out = []; let pos = 0;
  while (pos < msg.length) {
    let tag, val; [tag, pos] = uvarint(msg, pos);
    const field = tag >> 3, wt = tag & 7;
    if (wt === 0) [val, pos] = uvarint(msg, pos);
    else if (wt === 2) { let ln; [ln, pos] = uvarint(msg, pos); if (pos + ln > msg.length) throw new Error("truncated protobuf"); val = msg.subarray(pos, pos + ln); pos += ln; }
    else if (wt === 1) { val = msg.subarray(pos, pos + 8); pos += 8; }
    else if (wt === 5) { val = msg.subarray(pos, pos + 4); pos += 4; }
    else throw new Error(`bad protobuf wire type ${wt}`);
    out.push([field, wt, val]);
  }
  return out;
}

function parseDagPb(block) {
  const links = []; let data = Buffer.alloc(0);
  for (const [f, wt, v] of fields(block)) {
    if (f === 1 && wt === 2) data = v;
    else if (f === 2 && wt === 2) for (const [lf, lwt, lv] of fields(v)) if (lf === 1 && lwt === 2) { links.push(Buffer.from(lv)); break; }
  }
  return [links, data];
}
const unixfsData = (data) => { for (const [f, wt, v] of fields(data)) if (f === 2 && wt === 2) return v; return Buffer.alloc(0); };

/** CARv1 -> Map(cid hex -> block), every block checked against its CID. The header's roots are not trusted. */
export function parseCar(car) {
  const blocks = new Map();
  let [hlen, pos] = uvarint(car, 0); pos += hlen;
  while (pos < car.length) {
    let blen; [blen, pos] = uvarint(car, pos);
    const end = pos + blen;
    if (end > car.length) throw new Error("truncated CAR block");
    let cid, info; [cid, info, pos] = cidInfo(car, pos);
    const block = car.subarray(pos, end); pos = end;
    if (info.mh !== SHA2_256) throw new Error("unsupported hash in block (sha2-256 only)");
    if (!sha256(block).equals(info.digest)) throw new Error("block hash mismatch: the gateway served tampered or corrupt data");
    blocks.set(cid.toString("hex"), block);
  }
  return blocks;
}

/** The file rooted at `root` from verified blocks, within max bytes and a node-visit budget (ipfs_fetch.py reconstruct). */
export function reconstruct(root, blocks, maxBytes) {
  const out = []; let size = 0, visits = 0;
  const budget = 16 * blocks.size + Math.floor(maxBytes / 4096) + 4096;
  const walk = (c) => {
    if (++visits > budget) throw new Error(`DAG walk exceeded node-visit budget (${budget}): possible fan-out/diamond expansion attack`);
    const block = blocks.get(c.toString("hex"));
    if (!block) throw new Error(`CAR is missing block ${c.toString("hex")}`);
    const [, info] = cidInfo(c, 0);
    if (info.codec === RAW) { out.push(block); size += block.length; }
    else if (info.codec === DAGPB) {
      const [links, data] = parseDagPb(block);
      if (links.length) for (const l of links) walk(l);
      else { const d = unixfsData(data); out.push(d); size += d.length; }
    } else throw new Error(`unsupported CID codec 0x${info.codec.toString(16)}`);
    if (size > maxBytes) throw new Error(`reconstructed file exceeds max ${maxBytes} bytes`);
  };
  walk(root);
  return Buffer.concat(out);
}

export function verifyCar(cid, car, maxBytes) {
  const root = cidBytes(cid), blocks = parseCar(car);
  if (!blocks.has(root.toString("hex"))) throw new Error(`CAR does not contain the requested CID ${cid}`);
  return reconstruct(root, blocks, maxBytes);
}

async function readCapped(res, cap) {
  const chunks = []; let n = 0;
  for await (const c of res.body) { n += c.length; if (n > cap) throw new Error(`response larger than allowed (${cap} bytes cap)`); chunks.push(Buffer.from(c)); }
  return Buffer.concat(chunks);
}

/** Fetch cid from gateway and return its verified bytes. */
export async function fetchVerified(cid, gateway, maxBytes, timeoutMs = 120000, fetchImpl = fetch) {
  const root = cidBytes(cid);
  const [, info, end] = cidInfo(root, 0);
  if (end !== root.length) throw new Error("trailing CID bytes");
  const base = gateway.replace(/\/+$/, "");
  const signal = AbortSignal.timeout(timeoutMs);
  if (info.codec === RAW) {
    if (info.mh !== SHA2_256 || info.digest.length !== 32) throw new Error("raw CID requires sha2-256");
    const r = await fetchImpl(`${base}/ipfs/${cid}`, { headers: { accept: "application/vnd.ipld.raw" }, signal });
    if (!r.ok) throw new Error(`gateway answered ${r.status}`);
    const data = await readCapped(r, maxBytes);
    if (!sha256(data).equals(info.digest)) throw new Error("raw block does not match requested CID");
    return data;
  }
  const r = await fetchImpl(`${base}/ipfs/${cid}?format=car&dag-scope=all`, { headers: { accept: "application/vnd.ipld.car" }, signal });
  if (!r.ok) throw new Error(`gateway answered ${r.status}`);
  const car = await readCapped(r, maxBytes + Math.floor(maxBytes / 2) + (1 << 20));
  return verifyCar(cid, car, maxBytes);
}
