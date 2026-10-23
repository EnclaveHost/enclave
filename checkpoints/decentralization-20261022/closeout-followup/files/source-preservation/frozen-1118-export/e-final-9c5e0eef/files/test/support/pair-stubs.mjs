// LABELLED FIXTURES for the source-binding adapters. None of these validates anything:
//   startBeaconFixture: a Beacon-API stand-in that answers from an EXECUTION endpoint's own tags (head/finalized payload
//     = that endpoint's latest/finalized block). A real Lighthouse derives these from consensus; this mirrors them, and
//     can be told to lie (override) so the adapter's pairing check is exercised.
//   startRollupFixture: an `optimism_syncStatus` stand-in over a local L2 (heads at chosen numbers) and L1.
//   startExecutionStub: a scripted execution JSON-RPC for pure control-flow tests (reorg between reads, etc.).
import http from 'node:http';

const listen = (handler) => new Promise((ok) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => ok({ server: s, url: `http://127.0.0.1:${s.address().port}` })); });
const body = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => ok(b)); });
export async function jrpc(url, method, params = []) {
  const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`); return j.result;
}

export async function startBeaconFixture({ el, gvr = '0x' + '7e'.repeat(32), state = {} }) {
  const st = { syncing: false, optimistic: false, elOffline: false, peers: 3, finalizedOverride: null, ...state };
  const payload = async (tag) => {
    if (tag === 'finalized' && st.finalizedOverride) return st.finalizedOverride;
    const b = await jrpc(el, 'eth_getBlockByNumber', [tag === 'head' ? 'latest' : 'finalized', false]);
    return { block_number: String(Number(BigInt(b.number))), block_hash: b.hash, slot: String(Number(BigInt(b.number)) + 1000) };
  };
  const { server, url } = await listen(async (req, res) => {
    const send = (d, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: d })); };
    try {
      if (req.url === '/eth/v1/beacon/genesis') return send({ genesis_validators_root: gvr, genesis_time: '1606824023' });
      if (req.url === '/eth/v1/node/syncing') return send({ is_syncing: st.syncing, is_optimistic: st.optimistic, el_offline: st.elOffline, head_slot: '1000' });
      if (req.url === '/eth/v1/node/peer_count') return send({ connected: String(st.peers) });
      const m = /^\/eth\/v2\/beacon\/blocks\/(head|finalized)$/.exec(req.url);
      if (m) { const p = await payload(m[1]); return send({ message: { slot: p.slot, body: { execution_payload: { block_number: p.block_number, block_hash: p.block_hash } } } }); }
      send({ message: 'not found' }, 404);
    } catch (e) { send({ message: String(e) }, 500); }
  });
  return { url, state: st, close: () => server.close() };
}

export async function startRollupFixture({ l2, l1, state = {} }) {
  const st = { safeNumber: null, finalizedNumber: null, l1Override: null, ...state };
  const ref = async (url, n) => { const b = await jrpc(url, 'eth_getBlockByNumber', [n === null ? 'latest' : '0x' + Number(n).toString(16), false]);
    return { hash: b.hash, number: Number(BigInt(b.number)), parentHash: b.parentHash, timestamp: Number(BigInt(b.timestamp)) }; };
  const { server, url } = await listen(async (req, res) => {
    const j = JSON.parse(await body(req));
    const out = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result })); };
    if (j.method !== 'optimism_syncStatus') return out(null);
    const unsafe = await ref(l2, null);
    const l1fin = await jrpc(l1, 'eth_getBlockByNumber', ['finalized', false]);
    const l1ref = { hash: l1fin.hash, number: Number(BigInt(l1fin.number)), parentHash: l1fin.parentHash, timestamp: Number(BigInt(l1fin.timestamp)) };
    const cur = st.l1Override ?? (await ref(l1, null));
    const withOrigin = (r) => ({ ...r, l1origin: { hash: l1ref.hash, number: l1ref.number }, sequenceNumber: 0 });
    out({ current_l1: cur, current_l1_finalized: l1ref, head_l1: cur, safe_l1: l1ref, finalized_l1: st.l1FinalizedOverride ?? l1ref,
      unsafe_l2: withOrigin(unsafe), safe_l2: withOrigin(await ref(l2, st.safeNumber ?? 0)), finalized_l2: withOrigin(await ref(l2, st.finalizedNumber ?? 0)) });
  });
  return { url, state: st, close: () => server.close() };
}

/** A scripted execution node: `answer(method, params, call#)` returns the result (or throws). */
export async function startExecutionStub(answer) {
  let n = 0;
  const { server, url } = await listen(async (req, res) => {
    const j = JSON.parse(await body(req));
    let result, error;
    try { result = await answer(j.method, j.params, ++n); } catch (e) { error = { code: -32000, message: String(e.message || e) }; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...(error ? { error } : { result }) }));
  });
  return { url, close: () => server.close() };
}
