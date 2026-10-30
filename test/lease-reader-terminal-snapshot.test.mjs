// LeaseReader authority 'verifier' with BOTH lifecycle fixes composed: B's whole-operation deadline (62feb3aaf, 8d110101f)
// and the terminal-snapshot rules root applied to network/verified-chain.mjs (fd6a1762e): a transport answer that arrives
// after the deadline cannot move the accepted floor, and a retained client refuses EVERY method once its operation has
// settled - including the ones that send nothing (chain id, block number). Scripted in-process transports, no network.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { pad, toHex } from 'viem';
import { LeaseReader } from '../network/lease-reader.mjs';

const BOOK = '0x' + '33'.repeat(20), ADDR = '0x' + '44'.repeat(20);
const HASH = (n) => pad(toHex(BigInt(n) * 1000n + 1n), { size: 32 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keepAlive = setInterval(() => {}, 1000); after(() => clearInterval(keepAlive));
function scripted() {
  const st = { head: 102n, headers: 0, holdSecondHeader: null, signals: [] };
  const verifier = { request: async (method, params, _ms, signal) => {
    st.signals.push(signal);
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_blockNumber') return toHex(st.head);
    if (method === 'eth_getBlockByNumber') {
      const n = BigInt(params[0]);
      if (++st.headers === 2 && st.holdSecondHeader) await st.holdSecondHeader;   // the re-check header answers late
      return { number: toHex(n), hash: HASH(n), stateRoot: pad('0x22', { size: 32 }), timestamp: toHex(Math.floor(Date.now() / 1000)) };
    }
    if (method === 'eth_getCode') return '0x60';
    throw new Error('method not supported');
  } };
  return { st, verifier };
}
const reader = (verifier) => new LeaseReader({ authority: 'verifier', verifier, addressBook: BOOK, confirmations: 2, deadlineMs: 100 });

test('a final header that answers after the deadline cannot advance the accepted floor', { timeout: 5000 }, async () => {
  const { st, verifier } = scripted(); const r = reader(verifier);
  let release; st.holdSecondHeader = new Promise((ok) => { release = ok; });
  await assert.rejects(r.agreed(async () => ({ ok: true })), /deadline/);
  release(); await sleep(20);
  assert.equal(r.lastBlock, 0n, 'the timed-out read accepted nothing');
  st.head = 101n; st.holdSecondHeader = null; st.headers = 0;
  assert.equal((await r.agreed(async () => ({ ok: true }))).blockNumber, '99', 'an otherwise valid older block still reads');
  st.head = 98n; st.headers = 0;   // a verifier head below the accepted block 99
  await assert.rejects(r.agreed(async () => ({ ok: true })), /behind block 99/, 'a really accepted floor is still enforced');
});

test('a retained client refuses metadata AND RPC methods after success, failure or timeout', { timeout: 5000 }, async () => {
  for (const outcome of ['success', 'failure', 'timeout']) {
    const { st, verifier } = scripted(); const r = reader(verifier); let kept;
    const p = r.agreed(async (c) => { kept = c; if (outcome === 'failure') throw new Error('callback failed'); if (outcome === 'timeout') return new Promise(() => {}); return { ok: true }; });
    if (outcome === 'success') await p; else await assert.rejects(p);
    for (const call of [() => kept.getChainId(), () => kept.getBlockNumber(), () => kept.getBlock(), () => kept.getCode({ address: ADDR })])
      await assert.rejects(call(), /closed|deadline/, outcome);
    assert.ok(st.signals.length && st.signals.every((s) => s?.aborted), `${outcome}: cancellation reached every request`);
  }
  // readAt (pinned history) hands out the same terminal client
  const { verifier } = scripted(); const r = reader(verifier); let kept;
  await r.readAt({ blockNumber: 90n }, async (c) => { kept = c; return { ok: true }; });
  await assert.rejects(kept.getBlockNumber(), /closed/);
});
