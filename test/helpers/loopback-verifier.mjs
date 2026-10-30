// A LOOPBACK stand-in for the local proof-backed verifier (the patched Helios of work/rpc-priority, enclave-base-evm) for the
// host-service role tests: it speaks exactly the verifier protocol network/verified-chain.mjs and LeaseReader's verifier
// client use (eth_chainId, eth_blockNumber, eth_getBlockByNumber, and state reads PINNED by block hash) and answers from
// the test chain. It does NOT check Merkle proofs - that is the real verifier's job, proven by work/rpc-priority's
// policy-verifier E2E on a canonical-trie chain. What it does model is every way the real one REFUSES, so consumers can be
// tested for fail-closed behaviour:
//   fault 'proof'   state reads answer "invalid storage proof" (a tampered witness)
//   fault 'missing' state reads answer "missing witness" (no execution-data holder)
//   fault 'stale'   headers are 600 s old (a stalled signed-head stream)
//   fault 'unknown' the verifier has no such block (null header)
//   fault 'down'    HTTP 502
// An unpinned state read (a block tag instead of {blockHash}) is refused, as the real verifier refuses it.
import http from 'node:http';

export async function startLoopbackVerifier({ upstream, chainId = 8453 }) {
  const state = { fault: null, calls: [] };
  let id = 0;
  const up = async (method, params) => {
    const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'upstream error');
    return j.result;
  };
  const pinned = (p) => p && typeof p === 'object' && /^0x[0-9a-fA-F]{64}$/.test(String(p.blockHash || ''));
  async function answer(method, params = []) {
    const f = state.fault;
    switch (method) {
      case 'eth_chainId': return '0x' + chainId.toString(16);
      case 'eth_blockNumber': return up(method, []);
      case 'eth_getBlockByNumber': {
        if (f === 'unknown') return null;
        const b = await up(method, [params[0], false]);
        if (!b) return null;
        return { number: b.number, hash: b.hash, stateRoot: b.stateRoot, timestamp: f === 'stale' ? '0x' + (BigInt(b.timestamp) - 600n).toString(16) : b.timestamp };
      }
      case 'eth_call': case 'eth_getCode': case 'eth_getStorageAt': case 'eth_getBalance': {
        const at = params[params.length - 1];
        if (!pinned(at)) throw new Error('verifier: state reads must be pinned by block hash');
        if (f === 'proof') throw new Error('verifier: invalid storage proof');
        if (f === 'missing') throw new Error('verifier: missing witness for the requested state');
        return up(method, params);
      }
      default: throw new Error('verifier: method not supported');
    }
  }
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      if (state.fault === 'down') { res.writeHead(502); return res.end('verifier down'); }
      let q; try { q = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); return res.end(); }
      const one = async (m) => {
        state.calls.push({ method: m.method, to: m.params?.[0]?.to?.toLowerCase?.() ?? null, fault: state.fault });
        try { return { jsonrpc: '2.0', id: m.id, result: await answer(m.method, m.params) }; }
        catch (e) { return { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: e.message } }; }
      };
      const out = Array.isArray(q) ? await Promise.all(q.map(one)) : await one(q);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(() => r())); } };
}
