/* ============================================================
   Verified CAR read of a UnixFS file - the browser port of the
   runtime's verifier (wasm/ipfs_fetch.py parse_car / reconstruct /
   verify_car), so a page accepts a dag-pb CID's bytes on exactly the
   proof the enclave accepts them on, whatever the DAG layout (CIDv0
   dag-pb leaves, raw leaves, mixed, any chunk boundaries):
     * every block in the CAR must hash (sha2-256) to the CID it is
       framed with; any other hash refuses the whole CAR;
     * the REQUESTED CID's exact bytes must be one of those blocks;
     * the file is the depth-first walk from it, links in order,
       repeated links emitted every time; raw blocks are bytes, a
       dag-pb node with links is its children, one without is its
       UnixFS Data field 2;
     * work is bounded like the runtime: node visits <= 16 x blocks
       + maxBytes/4096 + 4096 (a diamond of empty nodes cannot spin),
       output <= maxBytes.
   Stricter than the runtime only where the runtime would read past a
   buffer: framing lengths, varints, protobuf fields and CIDs must fit
   exactly, field numbers must be >= 1, sections must be non-empty.
   Nesting deeper than MAX_DEPTH is refused: below the depth where the
   runtime's recursive walk hits Python's 1000-frame limit, so a page
   never offers a config the runtime cannot rebuild (Kubo DAGs for a
   1 MiB config are 1-2 levels deep).
   Runtime semantics kept as they are: the CAR header is skipped (the
   caller's CID, not the header roots, is the root); UnixFS types,
   filesize/blocksizes and link Tsize are not checked; a node that has
   links contributes only its children, never its own Data bytes.
   ============================================================ */
export const MAX_DEPTH = 900;
const RAW = 0x55, DAGPB = 0x70, SHA2_256 = 0x12;

function uvarint(buf, pos, end = buf.length){
  let n = 0, mul = 1;
  for (let i = 0; i < 9; i++){
    if (pos >= end) throw new Error("truncated varint");
    const b = buf[pos++]; n += (b & 0x7f) * mul;
    if (!(b & 0x80)){ if (!Number.isSafeInteger(n)) throw new Error("varint too large"); return [n, pos]; }
    mul *= 128;
  }
  throw new Error("varint too long");
}
// a binary CID at buf[pos..end) -> [key (its exact bytes, as a string), codec, digest, next]
function cidAt(buf, pos, end){
  const start = pos;
  if (end - pos >= 2 && buf[pos] === 0x12 && buf[pos + 1] === 0x20){             // CIDv0: a bare sha2-256 multihash
    if (end - pos < 34) throw new Error("truncated CID");
    return [key(buf, start, pos + 34), DAGPB, SHA2_256, buf.subarray(pos + 2, pos + 34), pos + 34];
  }
  let ver, codec, mh, len;
  [ver, pos] = uvarint(buf, pos, end); if (ver !== 1) throw new Error("unsupported CID version " + ver);
  [codec, pos] = uvarint(buf, pos, end); [mh, pos] = uvarint(buf, pos, end); [len, pos] = uvarint(buf, pos, end);
  if (len > end - pos) throw new Error("truncated CID");
  return [key(buf, start, pos + len), codec, mh, buf.subarray(pos, pos + len), pos + len];
}
const key = (buf, a, b) => { let s = ""; for (let i = a; i < b; i++) s += String.fromCharCode(buf[i]); return s; };
// minimal protobuf reader -> [[field, wireType, value]]; every length must fit
function fields(msg){
  const out = []; let pos = 0;
  while (pos < msg.length){
    let tag, val; [tag, pos] = uvarint(msg, pos);
    const field = Math.floor(tag / 8), wt = tag % 8;
    if (field < 1) throw new Error("bad protobuf field");
    if (wt === 0) [val, pos] = uvarint(msg, pos);
    else if (wt === 2){ let ln; [ln, pos] = uvarint(msg, pos); if (ln > msg.length - pos) throw new Error("truncated protobuf field"); val = msg.subarray(pos, pos + ln); pos += ln; }
    else if (wt === 1 || wt === 5){ const ln = wt === 1 ? 8 : 4; if (ln > msg.length - pos) throw new Error("truncated protobuf field"); val = msg.subarray(pos, pos + ln); pos += ln; }
    else throw new Error("bad protobuf wire type " + wt);
    out.push([field, wt, val]);
  }
  return out;
}
// dag-pb PBNode (1 = Data, 2 = Links; PBLink 1 = Hash) -> [link CID keys in order, Data]
function dagpb(block){
  const links = []; let data = new Uint8Array(0);
  for (const [f, wt, val] of fields(block)){
    if (f === 1 && wt === 2) data = val;
    else if (f === 2 && wt === 2){
      for (const [lf, lwt, lval] of fields(val)) if (lf === 1 && lwt === 2){ links.push(key(lval, 0, lval.length)); break; }
    }
  }
  return [links, data];
}
function unixfsData(data){
  for (const [f, wt, val] of fields(data)) if (f === 2 && wt === 2) return val;
  return new Uint8Array(0);
}

/* CARv1 bytes -> Map(CID key -> { codec, block }), every block hash-verified. */
export async function parseCar(car){
  if (!(car instanceof Uint8Array)) throw new Error("CAR must be bytes");
  const blocks = new Map();
  let [hlen, pos] = uvarint(car, 0);
  if (hlen > car.length - pos) throw new Error("truncated CAR header");
  pos += hlen;
  while (pos < car.length){
    let blen; [blen, pos] = uvarint(car, pos);
    if (blen < 1 || blen > car.length - pos) throw new Error("truncated CAR section");
    const end = pos + blen;
    const [k, codec, mh, digest, at] = cidAt(car, pos, end);
    if (mh !== SHA2_256 || digest.length !== 32) throw new Error("unsupported hash in block (sha2-256 only)");
    const block = car.subarray(at, end);
    const got = new Uint8Array(await crypto.subtle.digest("SHA-256", block));
    for (let i = 0; i < 32; i++) if (got[i] !== digest[i]) throw new Error("block hash mismatch");
    blocks.set(k, { codec, block });
    pos = end;
  }
  return blocks;
}

/* The file rooted at the CID whose exact binary form is `rootBytes`, from a verified block map. */
export function reconstruct(rootBytes, blocks, maxBytes){
  const budget = 16 * blocks.size + Math.floor(maxBytes / 4096) + 4096;
  const parts = []; let size = 0, visits = 0;
  const stack = [[key(rootBytes, 0, rootBytes.length), 0]];
  while (stack.length){
    const [k, depth] = stack.pop();
    ++visits;   // MUTANT: no visit budget
    if (depth > MAX_DEPTH) throw new Error("DAG deeper than " + MAX_DEPTH);
    const b = blocks.get(k); if (!b) throw new Error("CAR is missing a block");
    if (b.codec === RAW){ parts.push(b.block); size += b.block.length; }
    else if (b.codec === DAGPB){
      const [links, data] = dagpb(b.block);
      if (links.length) for (let i = links.length - 1; i >= 0; i--) stack.push([links[i], depth + 1]);
      else { const d = unixfsData(data); parts.push(d); size += d.length; }
    } else throw new Error("unsupported CID codec 0x" + b.codec.toString(16));
    if (size > maxBytes) throw new Error("reconstructed file exceeds " + maxBytes + " bytes");
  }
  const out = new Uint8Array(size); let o = 0; for (const p of parts){ out.set(p, o); o += p.length; }
  return out;
}

/* verify_car: the requested root must be in the CAR; returns its verified file bytes (throws on anything else). */
export async function verifyCar(rootBytes, car, maxBytes){
  const blocks = await parseCar(car);
  if (!blocks.has(key(rootBytes, 0, rootBytes.length))) throw new Error("CAR does not contain the requested CID");
  return reconstruct(rootBytes, blocks, maxBytes);
}
// the runtime's CAR transfer cap for a file of at most maxBytes
export const carCap = (maxBytes) => maxBytes + Math.floor(maxBytes / 2) + (1 << 20);
