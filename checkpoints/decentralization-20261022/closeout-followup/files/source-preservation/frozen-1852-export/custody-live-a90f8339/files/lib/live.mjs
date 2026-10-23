// READ-ONLY access to live Base for the rev-17 migration (gates G1 + G3 in ../../ledger17-migration-interface.txt).
// - An explicit allowlist of public endpoints; https only; no credentials, query or fragment.
// - An explicit allowlist of READ methods. There is no eth_send*, eth_sign*, personal_* or anvil_* path here at all:
//   this module cannot submit anything to Base.
// - eth_chainId must answer 8453 on every endpoint before anything else is read.
// - State reads are made AT ONE PINNED BLOCK (by number, with its hash agreed) on every state endpoint, and must be
//   byte-identical on at least two of them. Logs (discovery only) come from the log endpoints; anything they
//   discover is re-read as state at the pinned block before it counts.
import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';

export const BASE_CHAIN_ID = 8453;
export const LIVE = Object.freeze({
  // archive state on both (probed 2026-10-20: historical eth_call at -200k blocks answered by both)
  state: Object.freeze(['https://mainnet.base.org', 'https://base.public.blockpi.network/v1/rpc/public']),
  // archive logs: blockpi; publicnode answers recent ranges only and is used as a second source where it can
  logs: Object.freeze(['https://base.public.blockpi.network/v1/rpc/public', 'https://base-rpc.publicnode.com']),
});
const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_call',
  'eth_getCode', 'eth_getStorageAt', 'eth_getLogs', 'eth_getBalance', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getTransactionCount']);
const ALLOWED_HOSTS = new Set([...LIVE.state, ...LIVE.logs].map((u) => new URL(u).host));
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MC_ABI = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);

export function assertLiveUrl(u) {
  let url; try { url = new URL(u); } catch { throw Error(`not a URL: ${u}`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error(`refused endpoint ${url.host}: https, no credentials/query/fragment`);
  if (!ALLOWED_HOSTS.has(url.host)) throw Error(`refused endpoint ${url.host}: not in the live allowlist`);
  return url.href.replace(/\/$/, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
/** One JSON-RPC READ to one allowlisted endpoint, with bounded retries on rate limits. */
export async function rpc(url, method, params, { tries = 2 } = {}) {
  if (!READ_METHODS.has(method)) throw Error(`refused method ${method}: the live layer is read-only`);
  const u = assertLiveUrl(url);
  let last;
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ jsonrpc: '2.0', id: calls, method, params }), signal: AbortSignal.timeout(10000) });
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch { throw Object.assign(Error(`non-JSON ${r.status}`), { retry: true }); }
      if (j.error) {
        const m = String(j.error.message || '');
        if (/rate|limit|too many|busy|timeout|temporar|capacity/i.test(m) || r.status === 429) throw Object.assign(Error(m), { retry: true });
        throw Object.assign(Error(m), { rpcError: j.error });
      }
      return j.result;
    } catch (e) {
      last = e;
      if (!e.retry && !(e.name === 'TimeoutError' || /fetch failed|ECONN|socket/i.test(e.message))) throw e;
      await sleep(Math.min(20000, 800 * 2 ** i));
    }
  }
  throw Error(`${new URL(u).host} ${method}: ${last?.message}`);
}
export const rpcCalls = () => calls;

export async function assertChain(urls) {
  for (const u of urls) { const id = Number(await rpc(u, 'eth_chainId', [])); if (id !== BASE_CHAIN_ID) throw Error(`${new URL(u).host} is chain ${id}, not ${BASE_CHAIN_ID}`); }
}

/** Pin a block every state endpoint has: min(heads) - depth, with the same hash on all of them. */
export async function pinBlock({ depth = 12 } = {}) {
  await assertChain([...LIVE.state, ...LIVE.logs]);
  const heads = await Promise.all(LIVE.state.map(async (u) => BigInt(await rpc(u, 'eth_blockNumber', []))));
  const n = heads.reduce((a, b) => (a < b ? a : b)) - BigInt(depth);
  const blocks = await Promise.all(LIVE.state.map((u) => rpc(u, 'eth_getBlockByNumber', ['0x' + n.toString(16), false])));
  if (blocks.some((b) => !b || b.hash !== blocks[0].hash)) throw Error(`no agreed block at ${n}: ${blocks.map((b) => b?.hash).join(' vs ')}`);
  return { number: n, hash: blocks[0].hash, timestamp: BigInt(blocks[0].timestamp), baseFeePerGas: BigInt(blocks[0].baseFeePerGas || 0) };
}

/** The same READ on every state endpoint; returns the result only if all agree byte for byte. */
export async function agree(method, params) {
  const rs = await Promise.all(LIVE.state.map((u) => rpc(u, method, params)));
  const s0 = JSON.stringify(rs[0]);
  for (let i = 1; i < rs.length; i++) if (JSON.stringify(rs[i]) !== s0)
    throw Error(`endpoints disagree on ${method} ${JSON.stringify(params).slice(0, 160)}`);
  return rs[0];
}

/** Agreed, batched contract reads at the pinned block. calls: [{address, abi, functionName, args, allowFailure}] */
export async function readMany(block, calls, { batch = 60 } = {}) {
  const out = [];
  for (let i = 0; i < calls.length; i += batch) {
    const part = calls.slice(i, i + batch);
    const data = encodeFunctionData({ abi: MC_ABI, functionName: 'aggregate3', args: [part.map((c) => ({ target: c.address, allowFailure: !!c.allowFailure,
      callData: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args || [] }) }))] });
    const ret = await agree('eth_call', [{ to: MULTICALL3, data }, '0x' + block.number.toString(16)]);
    const res = decodeFunctionResult({ abi: MC_ABI, functionName: 'aggregate3', data: ret });
    res.forEach((r, j) => {
      const c = part[j];
      if (!r.success) { if (!c.allowFailure) throw Error(`${c.functionName} reverted at ${c.address}`); out.push({ ok: false }); return; }
      // a probe that "succeeds" with no data (a fallback, an EOA) or undecodable data is "no such getter", never a value
      try { out.push({ ok: true, value: decodeFunctionResult({ abi: c.abi, functionName: c.functionName, data: r.returnData }) }); }
      catch (e) { if (!c.allowFailure) throw Error(`${c.functionName} at ${c.address}: ${e.shortMessage || e.message}`); out.push({ ok: false }); }
    });
  }
  return out;
}
export const readOne = async (block, c) => (await readMany(block, [c]))[0].value;

/** Agreed code and storage at the pinned block. */
export const codeAt = (block, address) => agree('eth_getCode', [address, '0x' + block.number.toString(16)]);
export const storageAt = (block, address, slot) => agree('eth_getStorageAt', [address, slot, '0x' + block.number.toString(16)]);

/** Logs for discovery: chunked ranges on the archive log endpoint, up to the pinned block. */
export async function logs({ addresses, fromBlock, toBlock, span = 5000n, onProgress }) {
  const out = [];
  for (let f = BigInt(fromBlock); f <= toBlock; f += span) {
    const t = f + span - 1n > toBlock ? toBlock : f + span - 1n;
    const r = await rpc(LIVE.logs[0], 'eth_getLogs', [{ address: addresses, fromBlock: '0x' + f.toString(16), toBlock: '0x' + t.toString(16) }]);
    out.push(...r);
    onProgress?.(t);
  }
  return out;
}
