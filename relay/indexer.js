// PaymentRouter indexer: watch PaymentReceived(orderRef, payer, amount) on
// Base and hand each CONFIRMED payment to billing.js exactly once.
//
// Direct port of the supervisor's pollPayments (supervisor.js) - the two
// public-RPC failure modes and their fixes travel with it:
//  (1) MISSED LOGS: load-balanced RPCs answer getBlockNumber/getLogs from
//      different nodes at different heights - advancing past an unseen log
//      loses the payment. Fix: only finalize up to tip - INDEXER_CONFIRMATIONS
//      and re-scan a trailing overlap every poll.
//  (2) DOUBLE-CREDIT: the re-scan would re-run the handler. Fix: dedup on
//      txHash:logIndex (pruned below the window), which also makes a mid-poll
//      RPC failure safe to retry. billing.js re-dedups against the persisted
//      order for restart safety across the cursor gap.
// The block cursor persists to indexer-cursor.json after every chunk, so a
// restart resumes where it left off - it never skips forward to the tip.
//
// A second, display-only pass scans the UNCONFIRMED window [safe+1, tip] and
// reports matches as pending - billing marks the order pending_confirmations
// for the UI, but only the confirmed pass ever moves money-state.

import { JsonStore, dataFile, rpcPool } from "./store.js";

const CONFIRMATIONS = parseInt(process.env.INDEXER_CONFIRMATIONS || "3", 10);
const POLL_SEC = parseInt(process.env.INDEXER_POLL_SEC || "12", 10);
const RESCAN = BigInt(process.env.INDEXER_RESCAN_BLOCKS || "20");
const CHUNK = BigInt(process.env.INDEXER_CHUNK_BLOCKS || "4000");
const MAX_CATCHUP = BigInt(process.env.INDEXER_MAX_CATCHUP_BLOCKS || "200000");

export const PAYMENT_EVENT = {
  type: "event", name: "PaymentReceived",
  inputs: [
    { name: "orderRef", type: "bytes32", indexed: true },
    { name: "payer", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
  ],
};

let cursorStore = null;
let _seen = new Map();       // "txHash:logIndex" -> blockNumber
let _polling = false;
let _lastOkAt = 0;

export const indexerFresh = () => Date.now() - _lastOkAt < Math.max(60_000, 5 * POLL_SEC * 1000);

// deps: { dir, getRouter() -> 0x.. | "", onPayment({orderRef, payer, amount, txHash, logIndex, block}),
//         onPending?({orderRef, payer, amount, txHash}) }
export function startIndexer(deps) {
  cursorStore = new JsonStore(dataFile(deps.dir, "indexer-cursor.json"), { fromBlock: null });
  const t = setInterval(() => poll(deps), POLL_SEC * 1000);
  t.unref?.();
  poll(deps);
  console.log(`[indexer] watching PaymentReceived every ${POLL_SEC}s (confirmations=${CONFIRMATIONS})`);
}

async function poll(deps) {
  const router = deps.getRouter();
  if (!router || _polling) return;
  _polling = true;
  try {
    const pub = await rpcPool();
    const tip = await pub.getBlockNumber();
    const safe = tip - BigInt(CONFIRMATIONS);
    if (safe < 0n) return;
    let from = cursorStore.data.fromBlock == null ? null : BigInt(cursorStore.data.fromBlock);
    if (from == null) {
      from = safe + 1n;                                     // first EVER run: start at the confirmed tip
      cursorStore.data.fromBlock = from.toString();         // persist NOW - re-deriving "the tip" every
      cursorStore.saveSoon();                               // poll would advance past unscanned blocks
    }
    if (safe - from > MAX_CATCHUP) {
      console.warn(`[indexer] catch-up clamped: ${safe - from} blocks behind, scanning last ${MAX_CATCHUP}`);
      from = safe - MAX_CATCHUP;
    }
    while (from <= safe) {
      const scanFrom = from > RESCAN ? from - RESCAN : 0n;
      const to = (safe - scanFrom) > CHUNK ? scanFrom + CHUNK : safe;
      for (const [k, b] of _seen) if (b < scanFrom) _seen.delete(k);
      const logs = await pub.getLogs({ address: router, event: PAYMENT_EVENT, fromBlock: scanFrom, toBlock: to });
      for (const lg of logs) {
        const key = `${lg.transactionHash}:${lg.logIndex}`;
        if (_seen.has(key)) continue;                        // exactly-once across re-scans
        _seen.set(key, lg.blockNumber);
        const a = lg.args || {};
        await deps.onPayment({ orderRef: a.orderRef, payer: a.payer, amount: a.amount,
          txHash: lg.transactionHash, logIndex: Number(lg.logIndex), block: lg.blockNumber.toString() });
      }
      from = to + 1n;
      cursorStore.data.fromBlock = from.toString();          // restart resumes HERE, never skips
      cursorStore.saveSoon();
    }
    // display-only pass over the unconfirmed window: lets the UI say
    // "payment seen, waiting for confirmations" without moving money-state
    if (deps.onPending && tip > safe) {
      try {
        const fresh = await pub.getLogs({ address: router, event: PAYMENT_EVENT, fromBlock: safe + 1n, toBlock: tip });
        for (const lg of fresh) {
          const a = lg.args || {};
          await deps.onPending({ orderRef: a.orderRef, payer: a.payer, amount: a.amount, txHash: lg.transactionHash });
        }
      } catch { /* cosmetic pass; the confirmed pass is the source of truth */ }
    }
    _lastOkAt = Date.now();
  } catch (e) {
    console.warn(`[indexer] poll error: ${e.shortMessage || e.message}`);
  } finally { _polling = false; }
}
