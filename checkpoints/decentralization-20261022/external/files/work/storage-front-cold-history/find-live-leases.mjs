// Read-only: live rev-16d deployments with a CURRENT lease (a Renewed or Claimed log in the last ~900 blocks = 30 min),
// for the live cold-history read (bootstrap TestLiveColdHistory). Prints the JSON for LIVE_COLD_HISTORY.
const LEDGER = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b";
const CLAIMED = "0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0", RENEWED = "0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e";
const URL = "https://gateway.tenderly.co/public/base";
// tenderly's public endpoint rate-limits (probe-throughput.json): retry with backoff, bounded
const rpc = async (method, params) => {
  for (let i = 0; ; i++) {
    const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (!j.error) return j.result;
    if (i >= 6 || !/rate limit/i.test(j.error.message)) throw new Error(j.error.message);
    await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i));
  }
};
const head = Number(BigInt(await rpc("eth_blockNumber", [])));
const ids = new Map();
for (let lo = head - 899; lo <= head; lo += 300) {
  const logs = await rpc("eth_getLogs", [{ address: LEDGER, topics: [[CLAIMED, RENEWED]], fromBlock: "0x" + lo.toString(16), toBlock: "0x" + Math.min(head, lo + 299).toString(16) }]);
  for (const l of logs) ids.set(l.topics[1], Number(BigInt(l.blockNumber)));
}
const out = { ids: [...ids.keys()].slice(0, 2), history: ["https://gateway.tenderly.co/public/base", "https://base-public.nodies.app"], windowSec: 780, measuredWindowSec: 120, found: ids.size, head };
console.log(JSON.stringify(out));
