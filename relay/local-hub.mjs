// relay/local-hub.mjs -- the fleet-tunnel hub ALONE, for attaching a node to a workstation instead of the
// hosted relay (the NucBox node on the custom type-1 path, mode hv-node; a phone; a metal box): the same
// createTunnelHub, no chain, no discovery. GET / lists the attached tunnels; /t/<name>/<path> proxies a request.
// The hv-node attach uses the pinned TPM EK roots (relay/fixtures/tpm-roots.pem, or HVNODE_EK_ROOTS=<pem file>).
// The Windows VBS-enclave attach is RETIRED (2026-09-25): METAL_VBS_* enables nothing here or on the relay.
//   PORT=8100 node relay/local-hub.mjs
import fs from 'node:fs';
import http from 'node:http';
import { createTunnelHub } from './tunnel.js';
import { VBS_DEFAULT_EK_ROOTS } from './vbs-policy.mjs';
const ekRoots = fs.readFileSync(process.env.HVNODE_EK_ROOTS || VBS_DEFAULT_EK_ROOTS, 'utf8');
if (Object.keys(process.env).some((k) => k.startsWith('METAL_VBS_'))) console.warn('[hub] METAL_VBS_* is set, but the VBS-enclave attach is retired: ignored');
const hub = createTunnelHub({ allow: [], attest: { allowedMeasurements: [], requireVcek: false, hvNode: { ekRoots } }, operatorFor: async () => null,
                              onChange: (ev, name) => console.log(`[hub] ${ev} ${name}: ${JSON.stringify(hub.info(name))}`) });
const server = http.createServer(async (req, res) => {
  const im = (req.url || '').match(/^\/info\/([^/]+)$/);
  if (im) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(hub.info(im[1]))); return; }
  const m = (req.url || '').match(/^\/t\/([^/]+)(\/.*)$/);
  if (!m) { res.end(JSON.stringify({ hub: 'local', tunnels: hub.origins() })); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { const r = await hub.request(`tunnel://${m[1]}`, { method: req.method, path: m[2], headers: { 'content-type': req.headers['content-type'] || '' }, body: chunks.length ? Buffer.concat(chunks).toString('base64') : null });
        res.writeHead(r.status, r.headers); res.end(r.body); }
  catch (e) { res.statusCode = 502; res.end(e.message); }
});
server.on('upgrade', (q, s, h) => hub.handleUpgrade(q, s, h));
server.listen(Number(process.env.PORT || 8100), '0.0.0.0', () => console.log(`[hub] listening on ${process.env.PORT || 8100}`));
