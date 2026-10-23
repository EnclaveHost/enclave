// READ-ONLY review of setting the ORIGINAL EnclaveAddressBook's "sessionVaultFactory" entry (0 -> the original factory).
// Network access goes ONLY through root's allowlist (../custody-v2-live-20261023/lib/live.mjs: https, allowlisted hosts) and
// a read-method allowlist; every request is counted against a hard per-attempt budget; nothing is retried here.
import { encodeFunctionData, decodeFunctionResult, parseAbi, toEventSelector } from "viem";
import { LIVE, assertLiveUrl } from "../../custody-v2-live-20261023/lib/live.mjs";

export { LIVE };
export const ZERO = "0x0000000000000000000000000000000000000000";
export const CHAIN_ID = 8453;
const READ = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_call", "eth_getCode", "eth_getLogs"]);

export class BudgetExhausted extends Error {}
/** A counted, budgeted, single-try JSON-RPC reader. transport(url, body) -> parsed JSON (injectable for tests). */
export function budgetedRpc({ max, transport = httpTransport, check = assertLiveUrl }) {
  let used = 0;
  const log = [];
  async function rpc(url, method, params) {
    if (!READ.has(method)) throw new Error(`refused method ${method}: read-only`);
    const u = check(url);
    if (used >= max) throw new BudgetExhausted(`request budget ${max} exhausted before ${method}`);
    used++;
    const t0 = Date.now();
    let j;
    try { j = await transport(u, { jsonrpc: "2.0", id: used, method, params }); }
    catch (e) { log.push({ n: used, host: new URL(u).host, method, ms: Date.now() - t0, error: String(e.message).slice(0, 200) }); throw classify(e); }
    if (j.error) { const e = classify(new Error(String(j.error.message || j.error.code))); log.push({ n: used, host: new URL(u).host, method, ms: Date.now() - t0, error: e.message.slice(0, 200), kind: e.kind }); throw e; }
    log.push({ n: used, host: new URL(u).host, method, ms: Date.now() - t0 });
    return j.result;
  }
  return { rpc, used: () => used, log, max };
}
export async function httpTransport(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(`HTTP ${r.status} non-JSON`); }
}
// a provider's refusal: a RANGE limit (retryable with a smaller range) vs a RATE limit (stop; never storm)
export function classify(e) {
  const m = e.message || "";
  if (/range|too many (blocks|results)|block limit|max.*block|exceed.*(block|10000|5000|results)|query returned more than|response size/i.test(m) && !/rate limit|request limit|RU package|too many requests/i.test(m)) e.kind = "range";
  else if (/rate|request limit|too many requests|429|RU package|capacity|busy/i.test(m)) e.kind = "rate";
  else e.kind = e.kind || "other";
  return e;
}

/** One block both state endpoints agree on: min(head) - depth. */
export async function pinBlock(rpc, { depth = 12 } = {}) {
  for (const u of LIVE.state) if (Number(await rpc(u, "eth_chainId", [])) !== CHAIN_ID) throw new Error(`${u} is not Base`);
  const heads = await Promise.all(LIVE.state.map(async (u) => BigInt(await rpc(u, "eth_blockNumber", []))));
  const n = (heads[0] < heads[1] ? heads[0] : heads[1]) - BigInt(depth);
  const bs = await Promise.all(LIVE.state.map((u) => rpc(u, "eth_getBlockByNumber", ["0x" + n.toString(16), false])));
  if (!bs[0] || !bs[1] || bs[0].hash !== bs[1].hash) throw new Error(`no agreed block at ${n}`);
  return { number: n, hash: bs[0].hash, timestamp: Number(bs[0].timestamp) };
}

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MC = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"]);
/** Agreed (byte-identical on both state endpoints) batched reads at the pinned block. calls: [{address, abi, functionName, args}] */
export async function readAgreed(rpc, block, calls) {
  const data = encodeFunctionData({ abi: MC, functionName: "aggregate3", args: [calls.map((c) => ({ target: c.address, allowFailure: true,
    callData: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args || [] }) }))] });
  const at = "0x" + block.number.toString(16);
  const rs = await Promise.all(LIVE.state.map((u) => rpc(u, "eth_call", [{ to: MULTICALL3, data }, at])));
  if (rs[0] !== rs[1]) throw new Error(`state endpoints disagree on a batch of ${calls.length} reads`);
  return decodeFunctionResult({ abi: MC, functionName: "aggregate3", data: rs[0] }).map((r, i) => {
    if (!r.success) return { ok: false };
    try { return { ok: true, value: decodeFunctionResult({ abi: calls[i].abi, functionName: calls[i].functionName, data: r.returnData }) }; }
    catch { return { ok: false }; }
  });
}
export async function codeAgreed(rpc, block, address) {
  const at = "0x" + block.number.toString(16);
  const rs = await Promise.all(LIVE.state.map((u) => rpc(u, "eth_getCode", [address, at])));
  if (rs[0] !== rs[1]) throw new Error(`state endpoints disagree on the code of ${address}`);
  return rs[0];
}

// ---- the ABIs (from the vault, ledger, book and SessionVault sources; v1 and v2 declare identical events/getters) ----
export const ABI = {
  book: parseAbi(["function addr(bytes32) view returns (address)", "function owner() view returns (address)"]),
  ledger: parseAbi(["function count() view returns (uint256)", "function idAt(uint256) view returns (bytes32)"]),
  vault: parseAbi(["function beneficialOwnerOf(bytes32) view returns (address)",
    "function policyOf(bytes32) view returns (address owner, uint64 policyRev, uint64 secretRev, bytes32 committeeId, bool paused, bytes rules)"]),
  factory: parseAbi(["function isVault(address) view returns (bool)"]),
  sv: parseAbi(["function owner() view returns (address)", "function book() view returns (address)", "function factory() view returns (address)"]),
};
export const EVENTS = Object.freeze({
  PolicyUpdated: toEventSelector("PolicyUpdated(bytes32,address,uint64,bytes32,bool)"),
  PolicyClaimed: toEventSelector("PolicyClaimed(bytes32,address,address,uint64)"),
});
const lc = (a) => String(a).toLowerCase();

/**
 * The exact effect of the factory entry on one id in one vault (EnclaveSecretVault[V2] beneficialOwnerOf/_ownerFor/_apply/_claim):
 *   before = the ledger owner (the factory entry is zero), after = isVault(ledger owner) ? that vault's owner() : the ledger owner.
 */
export function effectOf({ before, after, policy }) {
  const b = lc(before), a = lc(after);
  if (!policy || BigInt(policy.policyRev) === 0n) return b === a ? "unchanged" : "no_policy_first_writer_changes";
  const o = lc(policy.owner);
  if (b === a) return "unchanged";
  if (o === b) return "STRANDED";                 // updates now revert NotOwner; only claimPolicy by `after`, which destroys the bundle
  if (o === a) return "restored";                 // a policy already detached from its ledger owner becomes updatable again
  return "claimant_changes";                      // already claimable; the claimant becomes `after` instead of `before`
}

/**
 * Bounded, resumable log discovery for exact topics on fixed addresses. cursor = { next, to, span, covered: [[a,b]],
 * events: [], stops: [] }. Each request covers [next, next+span-1]; a RANGE refusal halves the span (down to minSpan);
 * a RATE refusal, a budget stop or any other error ends the attempt with the cursor saved. Never claims completeness
 * beyond `covered`.
 */
export async function discoverLogs({ rpc, url, addresses, topics, cursor, minSpan = 500n, onStep }) {
  const B = (x) => BigInt(x);
  while (B(cursor.next) <= B(cursor.to)) {
    const from = B(cursor.next), span = B(cursor.span);
    const to = from + span - 1n > B(cursor.to) ? B(cursor.to) : from + span - 1n;
    let res;
    try { res = await rpc(url, "eth_getLogs", [{ address: addresses, topics: [topics], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]); }
    catch (e) {
      if (e instanceof BudgetExhausted) { cursor.stops.push({ at: from.toString(), reason: "budget" }); return "budget"; }
      const stated = /limited to (\d+) block range/i.exec(e.message || "");          // a provider's own stated limit
      if (e.kind === "range" && stated && BigInt(stated[1]) < span && BigInt(stated[1]) >= minSpan) { cursor.span = stated[1]; cursor.stops.push({ at: from.toString(), reason: `range refused at span ${span}: provider limit ${stated[1]}` }); continue; }
      if (e.kind === "range" && span / 2n >= minSpan) { cursor.span = (span / 2n).toString(); cursor.stops.push({ at: from.toString(), reason: `range refused at span ${span}: halved`, message: e.message.slice(0, 160) }); continue; }
      cursor.stops.push({ at: from.toString(), reason: e.kind === "rate" ? "rate_limited" : e.kind === "range" ? "range_refused_at_min_span" : "error", message: e.message.slice(0, 200) });
      return e.kind === "rate" ? "rate_limited" : "error";
    }
    if (!Array.isArray(res)) { cursor.stops.push({ at: from.toString(), reason: "non-array answer" }); return "error"; }
    for (const l of res) {
      if (!addresses.map(lc).includes(lc(l.address)) || !topics.includes(l.topics?.[0])) { cursor.stops.push({ at: from.toString(), reason: "provider returned a log outside the filter" }); return "error"; }
      cursor.events.push({ address: lc(l.address), event: l.topics[0] === EVENTS.PolicyUpdated ? "PolicyUpdated" : "PolicyClaimed", id: l.topics[1],
        block: B(l.blockNumber).toString(), tx: l.transactionHash, logIndex: B(l.logIndex).toString(), removed: !!l.removed });
    }
    const last = cursor.covered[cursor.covered.length - 1];
    if (last && B(last[1]) + 1n === from) last[1] = to.toString(); else cursor.covered.push([from.toString(), to.toString()]);
    cursor.next = (to + 1n).toString();
    onStep?.(cursor);
  }
  return "complete";
}
export function uncovered(cursor, start) {
  const out = []; let at = BigInt(start);
  for (const [a, b] of cursor.covered) { if (BigInt(a) > at) out.push([at.toString(), (BigInt(a) - 1n).toString()]); at = BigInt(b) + 1n; }
  if (at <= BigInt(cursor.to)) out.push([at.toString(), cursor.to.toString()]);
  return out;
}
