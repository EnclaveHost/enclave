/* ============================================================
   keccak256 - the one hash the site has to be able to compute
   itself.

   It exists for exactly one caller: site/js/core/vault.js, which
   must RECOMPUTE the digest a passkey is about to sign rather
   than sign whatever the relay hands it. Without a local hash
   there is no way to bind "what I asked for" to "what I signed",
   and the whole point of the credit vault is that the contract
   trusts the customer's signature, not the relay.

   Keccak-f[1600] with BigInt lanes: this hashes a few hundred
   bytes a handful of times per user action, so clarity beats
   speed by a mile - and a compact, readable permutation is one
   you can actually check against the spec. Pinned against viem's
   keccak256 over a corpus in test/vault-digest.test.mjs.

   Keccak padding (0x01 … 0x80), NOT SHA3's 0x06 - the difference
   is the whole reason Ethereum's "sha3" is its own thing.
   ============================================================ */

const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << n) | (x >> (64n - n))) & MASK;

// ι round constants
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// ρ rotation offsets, r[x][y]
const ROT = [
  [0n, 36n, 3n, 41n, 18n],
  [1n, 44n, 10n, 45n, 2n],
  [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n],
  [27n, 20n, 39n, 8n, 14n],
];

// state A is 25 lanes, index = x + 5y
function keccakF(A) {
  const C = new Array(5), B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];   // θ
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D;
    }
    for (let x = 0; x < 5; x++)                                                               // ρ + π
      for (let y = 0; y < 5; y++)
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x][y]);
    for (let y = 0; y < 5; y++)                                                               // χ
      for (let x = 0; x < 5; x++)
        A[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & MASK) & B[(x + 2) % 5 + 5 * y]);
    A[0] ^= RC[round];                                                                        // ι
  }
}

const RATE = 136;   // 1088 bits, the keccak256 rate

/** keccak256 over bytes -> 32-byte Uint8Array. */
export function keccak256Bytes(input) {
  const msg = input instanceof Uint8Array ? input : new Uint8Array(input);
  const padded = new Uint8Array(Math.ceil((msg.length + 1) / RATE) * RATE);
  padded.set(msg);
  padded[msg.length] = 0x01;                        // keccak pad10*1, first bit
  padded[padded.length - 1] |= 0x80;                // …and the last
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {            // absorb, lanes little-endian
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  const out = new Uint8Array(32);                   // squeeze: 32 bytes < rate, one pass
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}

export const bytesToHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/, "");
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error("not hex: " + String(hex).slice(0, 32));
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** keccak256 of a 0x-hex byte string -> 0x-hex digest. */
export const keccak256Hex = (hex) => bytesToHex(keccak256Bytes(hexToBytes(hex)));
/** keccak256 of a UTF-8 string -> 0x-hex digest (Solidity's keccak256(bytes(s))). */
export const keccak256Utf8 = (s) => bytesToHex(keccak256Bytes(new TextEncoder().encode(s)));
