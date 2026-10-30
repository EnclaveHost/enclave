// Recording boundary for the composed-stack tests: loopback HTTP servers that record EVERY request (method, path, JSON-RPC
// method) and answer a JSON-RPC error, plus a global fetch recorder. A test proves "no fallback" by the recorders' contents.
import http from 'node:http';
export async function recorder(name) {
  const calls = [];
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      let m = null; try { m = JSON.parse(b); } catch {}
      calls.push({ method: req.method, path: req.url, rpc: Array.isArray(m) ? m.map((x) => x.method) : m?.method ?? null });
      const id = Array.isArray(m) ? null : m?.id ?? null, out = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `${name}: recorder refuses` } });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) }); res.end(out);
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}/`, calls, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) };
}
export const msgOf = (e) => [e?.message, e?.shortMessage, e?.details, e?.cause?.message, e?.cause?.details].filter(Boolean).join(' | ');
