// Read-only probe (no transaction, no key): the EnclaveAddressBook's deployment block by binary search over eth_getCode
// on every given RPC (they must agree), and each RPC's eth_getLogs range acceptance for the book's AddressSet filter.
//   node harness/probe-book.mjs https://base-rpc.publicnode.com https://mainnet.base.org https://base.drpc.org
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
const BOOK = "0xab214342d5a490150a4a977063a2f88e21f80907";
const SET_TOPIC = "0xb37614c7d254ea8d16eb81fa11dddaeb266aa8ba4917980859c7740aff30c691";
const KEY_DEPLOYMENTS = "0x6465706c6f796d656e7473000000000000000000000000000000000000000000";
const rpcs = process.argv.slice(2);
const clients = rpcs.map((u) => createPublicClient({ chain: base, transport: http(u, { timeout: 20000, retryCount: 2, retryDelay: 1500 }) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const head = BigInt(Math.min(...(await Promise.all(clients.map((c) => c.getBlockNumber()))).map(Number))) - 10n;
const has = async (n) => {
  const a = await Promise.all(clients.map(async (c) => { const x = await c.getCode({ address: BOOK, blockNumber: n }); await sleep(120); return !!x && x !== "0x"; }));
  if (new Set(a).size !== 1) throw Error("RPCs disagree about the book's code at block " + n);
  return a[0];
};
if (!(await has(head))) throw Error("the book has no code at the head");
let lo = 0n, hi = head;                                   // invariant: no code at lo (genesis), code at hi
while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (await has(mid)) hi = mid; else lo = mid; }
console.log(JSON.stringify({ book: BOOK, head: head.toString(), deployBlock: hi.toString(), rpcs }));
for (const [i, c] of clients.entries()) for (const span of [10000n, 50000n, 500000n]) {
  try {
    const logs = await c.request({ method: "eth_getLogs", params: [{ address: BOOK, topics: [SET_TOPIC, KEY_DEPLOYMENTS],
      fromBlock: "0x" + hi.toString(16), toBlock: "0x" + (hi + span - 1n).toString(16) }] });
    console.log(JSON.stringify({ rpc: rpcs[i], span: span.toString(), ok: true, logs: logs.length }));
  } catch (e) { console.log(JSON.stringify({ rpc: rpcs[i], span: span.toString(), ok: false, error: String(e.shortMessage || e.message).slice(0, 160) })); }
  await sleep(300);
}
