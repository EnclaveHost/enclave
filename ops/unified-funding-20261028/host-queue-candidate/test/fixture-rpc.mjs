// SCRIPTED stand-ins for the TxQueue tests: a public client / wallet client pair whose answers the test sets per hash and
// per block number. No EVM, no signing, no key: hashes are made up and receipts are whatever the script says. Nothing
// here proves on-chain behaviour; it only drives the ACTUAL patched TxQueue through the RPC answers a Base node can give.
import { createHash } from "node:crypto";

export const ZERO32 = "0x" + "0".repeat(64);
export const ME = "0x1111111111111111111111111111111111111111";        // the relayer ADDRESS (no key exists here)
export const STRANGER = "0x9999999999999999999999999999999999999999";
export const TO = "0x2222222222222222222222222222222222222222";
export const DATA = "0xdeadbeef" + "00".repeat(32);

export const h32 = (tag) => "0x" + createHash("sha256").update(String(tag)).digest("hex");
export const txh = (n) => h32(`tx:${n}`);

export function receipt(hash, { block = 101n, blockHash = h32(`block:${block}`), status = "success", from = ME, logs = [] } = {}) {
  return { transactionHash: hash, blockHash, blockNumber: BigInt(block), status, from, to: TO, gasUsed: 21_000n, logs };
}
export function header(number, { hash = h32(`block:${number}`), txs = [] } = {}) {
  return { number: BigInt(number), hash, transactions: txs };
}

/** The receipt AND its header: canonical as far as any node asked can tell. */
export function makeCanonical(s, hash, opts = {}) {
  const r = receipt(hash, opts);
  s.receipts.set(hash.toLowerCase(), r);
  s.blocks.set(String(r.blockNumber), header(r.blockNumber, { hash: r.blockHash, txs: [hash] }));
  return r;
}
/** A Base flashblocks preconfirmation: a receipt with a zero block hash. */
export function makePreconfirmed(s, hash, opts = {}) {
  const r = receipt(hash, { blockHash: ZERO32, ...opts });
  s.receipts.set(hash.toLowerCase(), r);
  return r;
}

export function scripted({ from = ME, pendingNonce = 7, sendScript = [] } = {}) {
  const s = {
    sends: [],                 // every sendTransaction request, in order (a thrown attempt included)
    sent: [],                  // the hashes returned
    receipts: new Map(),       // hash -> receipt | (readIndex) => receipt | null
    blocks: new Map(),         // String(number) -> header | () => header
    reads: new Map(),          // hash -> getTransactionReceipt calls
    pendingNonce,
    sendScript: [...sendScript],
    afterSend: null,           // (hash, req) => void
    onRead: null,              // (hash) => void, before each receipt read
  };
  const pc = {
    async estimateGas() { return 100_000n; },
    async estimateMaxPriorityFeePerGas() { return 1_000_000n; },
    async getTransactionCount({ blockTag }) {
      if (blockTag !== "pending") throw new Error("the queue must read the PENDING nonce");
      return s.pendingNonce;
    },
    async getBlock(args = {}) {
      if (args.blockNumber == null) return { number: 100n, hash: h32("block:latest"), baseFeePerGas: 5_000_000n, transactions: [] };
      const v = s.blocks.get(String(args.blockNumber));
      const b = typeof v === "function" ? v() : v;
      if (!b) throw new Error(`BlockNotFoundError: ${args.blockNumber}`);
      return b;
    },
    async getTransactionReceipt({ hash }) {
      const k = String(hash).toLowerCase();
      s.onRead?.(k);
      const i = s.reads.get(k) ?? 0;
      s.reads.set(k, i + 1);
      const v = s.receipts.get(k);
      const r = typeof v === "function" ? v(i) : v;
      if (!r) throw new Error(`TransactionReceiptNotFoundError: ${hash}`);
      return r;
    },
    async simulateContract() { return { result: undefined }; },
  };
  const wc = {
    chain: { id: 31337 },
    async sendTransaction(req) {
      s.sends.push(req);
      const step = s.sendScript.shift();
      if (step?.error) throw Object.assign(new Error(step.error), { shortMessage: step.error });
      const h = step?.hash ?? txh(s.sends.length);
      s.sent.push(h);
      s.afterSend?.(h, req);
      return h;
    },
  };
  return { s, pc, wc, account: { address: from } };
}

export function memJournal() {
  return { data: { txs: [] }, saves: 0, flushes: 0, saveSoon() { this.saves++; }, flush() { this.flushes++; } };
}

/** Injected time: sleep advances a fake clock and may run the test's per-sleep hook. */
export function fakeTime() {
  const t = { now: 0, sleeps: 0, onSleep: null };
  return { t, clock: () => t.now, sleep: async (ms) => { t.now += ms; t.sleeps++; await t.onSleep?.(t); } };
}
