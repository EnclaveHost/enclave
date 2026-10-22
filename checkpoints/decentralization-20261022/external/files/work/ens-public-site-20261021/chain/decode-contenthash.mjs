// ENSIP-7 contenthash -> namespace + CID string (no dependency): varint codec, then the CID bytes.
// ipfs-ns 0xe3 -> CIDv1 base32 ('b'); ipns-ns 0xe5 -> CIDv1 libp2p-key base36 ('k'), the form IPFS uses for IPNS names.
const hex = process.argv[2].replace(/^0x/, ''); const b = Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));
function varint(buf, i) { let v = 0, s = 0, x; do { x = buf[i++]; v += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return [v, i]; }
const [codec, i] = varint(b, 0); const cid = b.slice(i);
const NS = { 0xe3: 'ipfs-ns', 0xe5: 'ipns-ns', 0xe4: 'swarm-ns', 0x1bc: 'onion', 0x1bd: 'onion3' };
const [ver, j] = varint(cid, 0); const [cidCodec, k] = varint(cid, j); const [mhCode, m] = varint(cid, k); const [mhLen, n] = varint(cid, m);
function baseN(bytes, alphabet, prefix) { // big-integer base conversion, leading zero bytes kept as alphabet[0]
  let digits = [0]; for (const byte of bytes) { let carry = byte; for (let d = 0; d < digits.length; d++) { carry += digits[d] * 256; digits[d] = carry % alphabet.length; carry = Math.floor(carry / alphabet.length); } while (carry) { digits.push(carry % alphabet.length); carry = Math.floor(carry / alphabet.length); } }
  let z = 0; while (z < bytes.length - 1 && bytes[z] === 0) z++;
  return prefix + alphabet[0].repeat(z) + digits.reverse().map((d) => alphabet[d]).join('').replace(/^0+(?=.)/, '');
}
function base32(bytes) { const A = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, val = 0, out = ''; for (const x of bytes) { val = (val << 8) | x; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += A[(val << (5 - bits)) & 31]; return 'b' + out; }
const str = cidCodec === 0x72 ? baseN(cid, '0123456789abcdefghijklmnopqrstuvwxyz', 'k') : base32(cid);
console.log(JSON.stringify({ namespace: NS[codec] || codec, cidVersion: ver, cidCodec: '0x' + cidCodec.toString(16) + (cidCodec === 0x72 ? ' (libp2p-key)' : cidCodec === 0x70 ? ' (dag-pb)' : ''),
  multihash: { code: '0x' + mhCode.toString(16) + (mhCode === 0 ? ' (identity)' : mhCode === 0x12 ? ' (sha2-256)' : ''), length: mhLen, digest: Buffer.from(cid.slice(n)).toString('hex') },
  cid: str, path: (NS[codec] === 'ipns-ns' ? '/ipns/' : '/ipfs/') + str, keyType: cidCodec === 0x72 && cid[n] === 0x08 && cid[n + 1] === 0x01 ? 'ed25519 (libp2p PublicKey protobuf, KeyType=1)' : undefined }, null, 1));
