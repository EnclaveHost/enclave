// Local orchestration API for untrusted witness producers. These JSON replies
// are NOT remotely verifiable authority. Lifecycle consumers call the local
// reader capability inside the accepted domain; remote consumers need its
// attested channel. Only loopback is exposed here.
import http from 'node:http';
export async function serveDerivedReader(reader, { port = 0, maxWitnessBytes = 64 << 20, operationTimeoutMs = 200000 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(maxWitnessBytes) || maxWitnessBytes < 1 || maxWitnessBytes > (128 << 20) ||
      !Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 3600000) throw Error('invalid derived reader API bounds');
  let active = false;
  const controllers = new Set();
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-enclave-authority-scope': 'local-process-only' });
      res.end(JSON.stringify(body));
    };
    const witness = /^\/witness\/([0-9a-f]{64})$/.exec(req.url || '');
    if (req.method === 'GET' && req.url === '/status') {
      try { return reply(200, { ...reader.status(), remotelyVerified: false }); }
      catch { return reply(503, { error: 'reader status unavailable', remotelyVerified: false }); }
    }
    if (!(req.method === 'GET' && req.url === '/anchor') && !(req.method === 'POST' && (req.url === '/prepare' || witness))) return reply(404, { error: 'not found' });
    if (active) return reply(503, { error: 'reader busy' });
    active = true;
    const ac = new AbortController(); controllers.add(ac);
    const timer = setTimeout(() => ac.abort(Error('reader API deadline')), operationTimeoutMs);
    const disconnected = () => { if (!res.writableEnded) ac.abort(Error('reader client disconnected')); };
    req.once('aborted', disconnected); res.once('close', disconnected);
    try {
      let body;
      if (req.method === 'POST') {
        const cap = witness ? maxWitnessBytes : 262144;
        if (Number(req.headers['content-length'] || 0) > cap) throw Error('reader request too large');
        if (witness ? req.headers['content-type'] !== 'application/octet-stream' : req.headers['content-type'] !== 'application/json') throw Error('wrong reader content type');
        const chunks = []; let bytes = 0;
        const abortBody = () => req.destroy(ac.signal.reason);
        ac.signal.addEventListener('abort', abortBody, { once: true });
        const bodyTimer = setTimeout(() => ac.abort(Error('reader body deadline')), 30000);
        try {
          for await (const part of req) { bytes += part.length; if (bytes > cap) throw Error('reader request too large'); chunks.push(part); }
          body = Buffer.concat(chunks);
        } finally { clearTimeout(bodyTimer); ac.signal.removeEventListener('abort', abortBody); }
      }
      ac.signal.throwIfAborted();
      if (req.url === '/anchor') reply(200, await reader.readAnchor({ signal: ac.signal }));
      else if (witness) reply(200, await reader.submit({ ticket: witness[1], witness: body, signal: ac.signal }));
      else {
        const input = JSON.parse(body.toString('utf8'));
        if (!input || Object.keys(input).sort().join(',') !== 'blockNumber,rollupConfigTemplate') throw Error('exact prepare input required');
        reply(200, await reader.prepare({ ...input, signal: ac.signal }));
      }
    } catch (e) { reply(409, { error: String(e.message).slice(0, 300) }); }
    finally { clearTimeout(timer); controllers.delete(ac); active = false; req.removeListener('aborted', disconnected); res.removeListener('close', disconnected); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
  return { port: server.address().port, async close() {
    for (const ac of controllers) ac.abort(Error('reader API closed'));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}
