// TEST-ONLY: build OP-stack sequencer commitments (the gossip message Helios's consensus API serves) from a block's
// fields and sign them with a TEST key. The layout is Helios's ExecutionPayload (a16z/helios 2af9b418
// opstack/src/types.rs) = base/base BaseExecutionPayloadV4 (ExecutionPayloadV3 + withdrawals_root); the signed data is
// parentBeaconRoot || SSZ(payload). A commitment made here is a synthetic fixture: it never proves live-chain behaviour.
import { concat, hexToBytes, numberToHex, pad, toHex } from 'viem';
import { sign } from 'viem/accounts';
import { commitmentDigest } from '../../network/op-head-relay.mjs';

const le = (v, n) => { const b = new Uint8Array(n); let x = BigInt(v); for (let i = 0; i < n; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const fixed = (hex, n) => { const b = hexToBytes(hex); if (b.length !== n) throw new Error(`expected ${n} bytes`); return b; };

/** SSZ ExecutionPayload (V4 layout). txs: array of hex raw transactions. */
export function encodePayload(f, txs = []) {
  const extra = hexToBytes(f.extraData || '0x');
  if (extra.length > 32) throw new Error('extraData > 32 bytes');
  const txb = txs.map((t) => hexToBytes(t));
  const txList = new Uint8Array(4 * txb.length + txb.reduce((a, t) => a + t.length, 0));
  let off = 4 * txb.length;
  txb.forEach((t, i) => { txList.set(le(off, 4), 4 * i); txList.set(t, off); off += t.length; });
  const FIXED = 560;
  const extraOff = FIXED, txOff = extraOff + extra.length, wdOff = txOff + txList.length;
  const parts = [
    fixed(f.parentHash, 32), fixed(f.miner, 20), fixed(f.stateRoot, 32), fixed(f.receiptsRoot, 32), fixed(f.logsBloom, 256), fixed(f.mixHash, 32),
    le(f.number, 8), le(f.gasLimit, 8), le(f.gasUsed, 8), le(f.timestamp, 8), le(extraOff, 4), le(f.baseFeePerGas ?? 0, 32), fixed(f.hash, 32),
    le(txOff, 4), le(wdOff, 4), le(f.blobGasUsed ?? 0, 8), le(f.excessBlobGas ?? 0, 8), fixed(f.withdrawalsRoot ?? pad('0x', { size: 32 }), 32),
  ];
  const head = concat(parts.map((p) => toHex(p)));
  if (hexToBytes(head).length !== FIXED) throw new Error('payload fixed part size');
  return concat([head, toHex(extra), toHex(txList)]);
}

/** {data, signature:{r,s,yParity}} for block fields `f`, signed by `privateKey` for `chainId`. */
export async function makeCommitment(f, { chainId, privateKey, txs = [], parentBeaconRoot = pad('0x', { size: 32 }) }) {
  const data = concat([parentBeaconRoot, encodePayload(f, txs)]);
  const s = await sign({ hash: commitmentDigest(data, chainId), privateKey });
  return { data, signature: { r: s.r, s: s.s, yParity: numberToHex(s.yParity ?? (Number(s.v) - 27)) } };
}

/** Block fields for makeCommitment from an eth_getBlockByNumber JSON result. */
export const blockFields = (b) => ({ parentHash: b.parentHash, miner: b.miner, stateRoot: b.stateRoot, receiptsRoot: b.receiptsRoot, logsBloom: b.logsBloom,
  mixHash: b.mixHash, number: BigInt(b.number), gasLimit: BigInt(b.gasLimit), gasUsed: BigInt(b.gasUsed), timestamp: BigInt(b.timestamp), extraData: b.extraData,
  baseFeePerGas: BigInt(b.baseFeePerGas ?? 0), hash: b.hash, blobGasUsed: BigInt(b.blobGasUsed ?? 0), excessBlobGas: BigInt(b.excessBlobGas ?? 0),
  withdrawalsRoot: b.withdrawalsRoot });
