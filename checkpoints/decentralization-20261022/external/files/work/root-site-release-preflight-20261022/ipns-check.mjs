// READ-ONLY: the IPNS record the ENS contenthash points to, from the public delegated routing API (IPIP-337/379,
// /routing/v1/ipns/<name>), its Ed25519 signature verified LOCALLY against the public key inside the name, its
// validity/sequence/value; then who provides the CID it names (/routing/v1/providers/<cid>). Routing reads only: no
// gateway content fetch (root owns the HTTP gateway checks), no key, no write.
import { createPublicKey, verify } from 'node:crypto';
const NAME = 'k51qzi5uqu5dma8l0w05o02gkz7l80f3r3mb536qh8fuhrr2qj4nsa2afe9b52';
const PUBKEY = Buffer.from('f4ccac9830ca7812cd29a5e4408a2080fcd8d53f49d22fbb2baaf416b39a2aa6', 'hex'); // from the contenthash
const ROUTERS = ['https://delegated-ipfs.dev'];
const out = { name: NAME, at: new Date().toISOString(), routers: {} };

function varint(b, i) { let v = 0, s = 0, x; do { x = b[i++]; v += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return [v, i]; }
function protobuf(b) { const f = {}; let i = 0; while (i < b.length) { let key; [key, i] = varint(b, i); const no = Math.floor(key / 8), wt = key & 7; let v;
  if (wt === 0) [v, i] = varint(b, i); else if (wt === 2) { let len; [len, i] = varint(b, i); v = b.subarray(i, i + len); i += len; } else throw new Error('wire type ' + wt);
  (f[no] ||= []).push(v); } return f; }
// minimal CBOR map decoder (text keys; bytes/int/text values) for IpnsEntry.data (the V2-signed fields)
function cbor(b) { let i = 0; const head = () => { const ib = b[i++], mt = ib >> 5, ai = ib & 31; let n = ai;
    if (ai === 24) n = b[i++]; else if (ai === 25) { n = b.readUInt16BE(i); i += 2; } else if (ai === 26) { n = b.readUInt32BE(i); i += 4; } else if (ai === 27) { n = Number(b.readBigUInt64BE(i)); i += 8; }
    return [mt, n]; };
  const item = () => { const [mt, n] = head(); if (mt === 0) return n; if (mt === 2) { const v = b.subarray(i, i + n); i += n; return v; } if (mt === 3) { const v = b.subarray(i, i + n).toString(); i += n; return v; }
    if (mt === 5) { const o = {}; for (let k = 0; k < n; k++) o[item()] = item(); return o; } throw new Error('cbor major ' + mt); };
  return item(); }
const spki = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), PUBKEY]), format: 'der', type: 'spki' });

for (const r of ROUTERS) {
  const o = out.routers[r] = {};
  try {
    const res = await fetch(`${r}/routing/v1/ipns/${NAME}`, { headers: { accept: 'application/vnd.ipfs.ipns-record' }, signal: AbortSignal.timeout(20_000) });
    o.status = res.status; o.contentType = res.headers.get('content-type');
    if (res.ok) {
      const b = Buffer.from(await res.arrayBuffer()); o.bytes = b.length;
      const f = protobuf(b), data = f[9]?.[0] ? cbor(Buffer.from(f[9][0])) : null;
      const sigV2 = f[8]?.[0] ? Buffer.from(f[8][0]) : null;
      o.signatureV2Valid = sigV2 && f[9] ? verify(null, Buffer.concat([Buffer.from('ipns-signature:'), Buffer.from(f[9][0])]), spki, sigV2) : false;
      o.value = data ? Buffer.from(data.Value).toString() : (f[1] ? Buffer.from(f[1][0]).toString() : null);
      o.validity = data ? Buffer.from(data.Validity).toString() : (f[4] ? Buffer.from(f[4][0]).toString() : null);
      o.validityType = data ? data.ValidityType : f[3]?.[0];
      o.sequence = data ? data.Sequence : f[5]?.[0];
      o.ttlNs = data ? data.TTL : f[6]?.[0];
      o.ttlSeconds = o.ttlNs != null ? Number(o.ttlNs) / 1e9 : null;
      o.expired = o.validity ? new Date(o.validity.replace(/(\.\d{3})\d*Z$/, '$1Z')).getTime() < Date.now() : null;
      o.v1ValueMatchesV2 = f[1] && data ? Buffer.from(f[1][0]).toString() === o.value : null;
    } else o.body = (await res.text()).slice(0, 300);
  } catch (e) { o.error = String(e.message).slice(0, 200); }
  const cid = o.value?.match(/^\/ipfs\/([a-z0-9]+)/)?.[1];
  if (cid) {
    try {
      const res = await fetch(`${r}/routing/v1/providers/${cid}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      o.providers = { status: res.status };
      if (res.ok) { const j = await res.json(); o.providers.count = (j.Providers || []).length;
        o.providers.list = (j.Providers || []).slice(0, 20).map((p) => ({ id: p.ID, protocols: p.Protocols, addrs: (p.Addrs || []).slice(0, 6) })); }
      else o.providers.body = (await res.text()).slice(0, 300);
    } catch (e) { o.providers = { error: String(e.message).slice(0, 200) }; }
  }
}
console.log(JSON.stringify(out, (k, v) => typeof v === 'bigint' ? v.toString() : v, 1));
