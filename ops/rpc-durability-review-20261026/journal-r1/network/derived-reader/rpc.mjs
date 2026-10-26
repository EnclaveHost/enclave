// Transport discipline, not proof authority. A local Helios binding supplies
// the ownership assertion; execution/header/witness endpoints remain untrusted.
export function boundedRpc(url, { assertOwned = () => {}, timeoutMs = 20000, maxBytes = 4 << 20 } = {}) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash || u.search) throw Error('invalid reader transport URL');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 200000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > (32 << 20))
    throw Error('invalid reader transport limits');
  let sequence = 0;
  return async (method, params, { signal } = {}) => {
    assertOwned(); signal?.throwIfAborted();
    const id = ++sequence, controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(Error('reader transport deadline')), timeoutMs);
    try {
      const response = await fetch(u, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      if (!response.ok) throw Error(`reader transport HTTP ${response.status}`);
      const chunks = []; let size = 0;
      for await (const bytes of response.body) {
        size += bytes.length;
        if (size > maxBytes) { controller.abort(); throw Error('reader response exceeds byte limit'); }
        chunks.push(bytes);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value?.jsonrpc !== '2.0' || value.id !== id || Object.hasOwn(value, 'error') || !Object.hasOwn(value, 'result')) throw Error('invalid reader RPC response');
      signal?.throwIfAborted(); assertOwned();
      return value.result;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
}
export function finalizedHeader(raw, nowSec, maxAgeSec) {
  const hash = /^0x[0-9a-f]{64}$/, qty = /^0x(0|[1-9a-f][0-9a-f]*)$/;
  if (!raw || !hash.test(raw.hash) || !hash.test(raw.stateRoot) || !qty.test(raw.number) || !qty.test(raw.timestamp)) throw Error('invalid finalized L1 header');
  const number = Number(BigInt(raw.number)), timestamp = Number(BigInt(raw.timestamp));
  if (!Number.isSafeInteger(number) || !Number.isSafeInteger(timestamp) || timestamp > nowSec + 2 || nowSec - timestamp > maxAgeSec) throw Error('L1 finalized header is outside freshness bound');
  return Object.freeze({ number, timestamp, hash: raw.hash, stateRoot: raw.stateRoot });
}
