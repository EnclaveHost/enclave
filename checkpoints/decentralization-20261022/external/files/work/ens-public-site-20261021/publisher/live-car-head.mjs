// ONE bounded public GET: does the front serve the publisher's enumerate URL (?format=car&dag-scope=all) for the live
// root? Reads at most 64 KiB (status, headers, CAR header root), then aborts. No auth, no write.
const ROOT = 'bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou';
const url = `https://ipfs.enclave.host/ipfs/${ROOT}?format=car&dag-scope=all`;
const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 30000);
const out = { url, at: new Date().toISOString() };
try {
  const r = await fetch(url, { headers: { accept: 'application/vnd.ipld.car' }, signal: ac.signal });
  out.status = r.status; out.contentType = r.headers.get('content-type'); out.contentLength = r.headers.get('content-length'); out.server = r.headers.get('server');
  const rd = r.body.getReader(); let buf = Buffer.alloc(0);
  while (buf.length < 65536) { const { done, value } = await rd.read(); if (done) break; buf = Buffer.concat([buf, Buffer.from(value)]); }
  ac.abort();
  // CARv1 header: varint length, dag-cbor {roots:[CID], version:1}; the root CID follows the 0xd8 0x2a tag + 0x58 len + 0x00
  const i = buf.indexOf(Buffer.from([0xd8, 0x2a, 0x58])); const len = buf[i + 3]; const cid = buf.subarray(i + 5, i + 4 + len);
  const B = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, v = 0, s = 'b'; for (const x of cid) { v = (v << 8) | x; bits += 8; while (bits >= 5) { s += B[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) s += B[(v << (5 - bits)) & 31];
  out.carHeaderRoot = s; out.rootMatches = s === ROOT; out.bytesRead = buf.length;
} catch (e) { out.error = String(e.message); }
clearTimeout(t); console.log(JSON.stringify(out, null, 1));
