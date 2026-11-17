// A host behind the relay's tunnel, for tests: the relay's own hub (relay/tunnel.js) with one box attached over a
// WebSocket, and an HTTP front that carries a request the way api-relay.js's proxyViaTunnel does (the body buffered,
// one frame each way, base64 inside JSON). `handle(method, path, body)` -> {status, body} is the box.
// -> {origin, frames: [{path, requestBytes, responseBytes, ms}], close()}
import http from 'node:http';
import {createHash} from 'node:crypto';
import {WebSocket} from 'ws';
import {createTunnelHub} from '../../relay/tunnel.js';

export async function tunnelHop(handle, {name = 'metal0', reqTimeoutMs = 30000} = {}) {
  const token = 'tunnel-hop-token', origin = `tunnel://${name}`, frames = [];
  const hub = createTunnelHub({allow: [{name, tokenSha256: createHash('sha256').update(token).digest('hex')}], reqTimeoutMs});
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks), started = Date.now();
      try {
        const r = await hub.request(origin, {method: req.method, path: req.url, headers: {'content-type': req.headers['content-type'] || ''}, body: body.length ? body : null});
        frames.push({path: req.url, requestBytes: body.length, responseBytes: r.body.length, ms: Date.now() - started});
        res.writeHead(r.status, {'content-type': r.headers['content-type'] || 'application/json'}); res.end(r.body);
      } catch (e) { res.writeHead(502, {'content-type': 'application/json'}); res.end(JSON.stringify({error: 'tunnel_error', message: e.message})); }
    });
  });
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/fleet-tunnel`, {headers: {'x-metal-name': name, 'x-metal-token': token}});
  ws.on('message', async d => {
    let f; try { f = JSON.parse(d); } catch { return; }
    if (f.t !== 'req') return;
    let out;
    try { out = await handle(f.method, f.path, f.body ? Buffer.from(f.body, 'base64') : Buffer.alloc(0)); }
    catch (e) { out = {status: 503, body: {error: String(e?.message || e).slice(0, 200)}}; }
    ws.send(JSON.stringify({t: 'res', id: f.id, status: out.status, headers: {'content-type': 'application/json'}, body: Buffer.from(JSON.stringify(out.body)).toString('base64')}));
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  for (let i = 0; i < 100 && hub.count() < 1; i++) await new Promise(r => setTimeout(r, 10));
  return {origin: `http://127.0.0.1:${port}`, frames,
    close: () => new Promise(r => { try { ws.terminate(); } catch {} server.closeAllConnections?.(); server.close(() => r()); })};
}
