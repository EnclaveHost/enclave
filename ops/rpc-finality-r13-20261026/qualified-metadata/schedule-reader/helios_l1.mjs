// derivation-schedule-auth-stage/reader/helios_l1.mjs (50cf; PREPARED; never run against a live service by Claude).
// The production `l1` binding for schedule_reader.mjs: JSON-RPC to the in-domain Helios (l1-authority) on a LOOPBACK literal URL.
// Helios verifies eth_getBlockByNumber/eth_call against the beacon light client; this adapter adds only transport discipline:
// loopback-only literal IP, redirect:error, an integer AbortSignal timeout, a streamed byte cap, strict JSON-RPC envelope/id and
// strict hex. It never uses a provider label as authority: `finalized()` only BOUNDS the caller's anchor (schedule_reader checks).
// MISSING (stated, not faked): the pinned, running in-domain Helios instance and its runtime binding (URL, unit, readiness).
import net from 'node:net';
import { Refused } from './schedule_reader.mjs';

const refuse = (code, msg) => { throw new Refused(code, msg); };
const HASH = /^0x[0-9a-f]{64}$/, QTY = /^0x(0|[1-9a-f][0-9a-f]{0,15})$/, DATA = /^0x([0-9a-f]{2})*$/;

export function heliosL1(url, { timeoutMs = 20000, maxBytes = 1 << 20 } = {}) {
  let u;
  try { u = new URL(url); } catch { refuse('l1', 'helios url is not a URL'); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol !== 'http:' || !net.isIP(host) || !(host === '127.0.0.1' || host === '::1') || u.username || u.password || u.search || u.hash)
    refuse('l1', 'helios url must be plain http to a loopback literal');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) refuse('l1', 'timeoutMs must be a positive integer');
  let id = 0;
  async function rpc(method, params) {
    const myId = ++id;
    const res = await fetch(u, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) });
    if (!res.ok) refuse('l1', `${method}: HTTP ${res.status}`);
    const chunks = []; let n = 0;
    for await (const c of res.body) { n += c.length; if (n > maxBytes) refuse('l1', `${method}: response over ${maxBytes} bytes`); chunks.push(c); }
    let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { refuse('l1', `${method}: not JSON`); }
    if (j?.jsonrpc !== '2.0' || j.id !== myId || ('error' in j) || !('result' in j)) refuse('l1', `${method}: bad JSON-RPC envelope or error`);
    return j.result;
  }
  const block = (b, what) => {
    if (!b || !QTY.test(b.number) || !HASH.test(b.hash)) refuse('l1', `${what}: malformed block`);
    return { number: BigInt(b.number), hash: b.hash };
  };
  const qty = (n) => '0x' + n.toString(16);
  return {
    finalized: async () => block(await rpc('eth_getBlockByNumber', ['finalized', false]), 'finalized'),
    blockByNumber: async (n) => block(await rpc('eth_getBlockByNumber', [qty(n), false]), `block ${n}`),
    call: async (to, data, n) => {
      const r = await rpc('eth_call', [{ to, data }, qty(n)]);
      if (typeof r !== 'string' || !DATA.test(r)) refuse('l1', 'eth_call: malformed result');
      return r;
    },
  };
}
