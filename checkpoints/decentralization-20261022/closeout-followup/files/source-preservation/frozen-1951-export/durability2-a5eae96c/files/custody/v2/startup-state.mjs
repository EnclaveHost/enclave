// Only an explicit missing-state response permits a new identity. Transport,
// storage and authentication failures must never overwrite an existing share.
export async function readStartupState(url, { fetchImpl = fetch, timeoutMs = 10000, maxBytes = 4 << 20 } = {}) {
  const r = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (r.status === 404) { await r.body?.cancel(); return null; }
  if (r.status !== 200) { await r.body?.cancel(); throw Error(`sealed state read failed: HTTP ${r.status}`); }
  const chunks = []; let size = 0;
  for await (const chunk of r.body || []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw Error('sealed state exceeds its size limit');
    chunks.push(Buffer.from(chunk));
  }
  if (size < 28) throw Error('sealed state response is empty or truncated');
  return Buffer.concat(chunks);
}

export async function loadStartupState({ read, unseal, fresh, persist }) {
  const blob = await read();
  if (blob !== null) return unseal(blob);
  const state = fresh();
  await persist(state);
  return state;
}
