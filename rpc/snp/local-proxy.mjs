// Loopback-only plain-HTTP view of an attested SEV-SNP RPC enclave, for host tools
// that speak to local nodes (the Base coverage gate, readiness samplers):
//
//   node rpc/snp/local-proxy.mjs ORIGIN MEASUREMENT [EL_PORT=18645] [BEACON_PORT=15052]
//
// EL_PORT forwards JSON-RPC POSTs to ORIGIN/l1; BEACON_PORT forwards GETs to
// ORIGIN/beacon/<path>. Every upstream request goes through attested-fetch, so it
// reaches only an enclave whose SNP report verifies against MEASUREMENT and whose
// TLS key is the attested one. The listeners bind 127.0.0.1 only.
import http from 'node:http';
import { createAttestedFetch } from './attested-fetch.mjs';

const [origin, measurement, elPort = '18645', beaconPort = '15052'] = process.argv.slice(2);
if (!origin || !/^[0-9a-f]{96}$/.test(measurement || '')) {
  console.error('usage: local-proxy.mjs ORIGIN MEASUREMENT [EL_PORT] [BEACON_PORT]');
  process.exit(2);
}
const f = createAttestedFetch({ attested: { [origin]: { allowedMeasurements: [measurement] } } });
const MAX_BODY = 1 << 20;

function serve(port, handle) {
  http.createServer(async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { code: 413 }); chunks.push(c); }
      const r = await handle(req, Buffer.concat(chunks));
      const body = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', 'content-length': body.length });
      res.end(body);
    } catch (e) {
      res.writeHead(e.code === 413 ? 413 : 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.code === 413 ? 'request too large' : 'attested upstream unavailable' }));
    }
  }).listen(Number(port), '127.0.0.1', () => console.log(JSON.stringify({ event: 'listening', port: Number(port) })));
}

serve(elPort, (req, body) => {
  if (req.method !== 'POST') throw new Error('POST only');
  return f(origin + '/l1', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
});
serve(beaconPort, (req) => {
  if (req.method !== 'GET') throw new Error('GET only');
  return f(origin + '/beacon' + req.url, { method: 'GET' });
});
