// relay/local-hub.mjs -- the fleet-tunnel hub ALONE, for attaching a node to a workstation instead of the
// hosted relay (a Windows VBS node under test, a phone, a metal box): the same createTunnelHub, the same
// policy env (METAL_VBS_ENCLAVE_MEASUREMENTS, METAL_VBS_ALLOW_TESTSIGNING, METAL_AVF_*), no chain, no
// discovery. GET / lists the attached tunnels; /t/<name>/<path> proxies a request to one.
//   METAL_VBS_ENCLAVE_MEASUREMENTS=<key> METAL_VBS_ALLOW_TESTSIGNING=1 PORT=8100 node relay/local-hub.mjs
import http from 'node:http';
import { createTunnelHub } from './tunnel.js';
import { vbsPolicyFromEnv } from './vbs-policy.mjs';
const vbs = vbsPolicyFromEnv(process.env);
if (!vbs) { console.error('set METAL_VBS_ENCLAVE_MEASUREMENTS (and METAL_VBS_ALLOW_TESTSIGNING=1 for the lab box)'); process.exit(2); }
const hub = createTunnelHub({ allow: [], attest: { allowedMeasurements: [], requireVcek: false, vbs }, operatorFor: async () => null,
                              onChange: (ev, name) => console.log(`[hub] ${ev} ${name}: ${JSON.stringify(hub.info(name))}`) });
const server = http.createServer(async (req, res) => {
  const m = (req.url || '').match(/^\/t\/([^/]+)(\/.*)$/);
  if (!m) { res.end(JSON.stringify({ hub: 'local', tunnels: hub.origins() })); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { const r = await hub.request(`tunnel://${m[1]}`, { method: req.method, path: m[2], headers: { 'content-type': req.headers['content-type'] || '' }, body: chunks.length ? Buffer.concat(chunks).toString('base64') : null });
        res.writeHead(r.status, r.headers); res.end(r.body); }
  catch (e) { res.statusCode = 502; res.end(e.message); }
});
server.on('upgrade', (q, s, h) => hub.handleUpgrade(q, s, h));
server.listen(Number(process.env.PORT || 8100), '0.0.0.0', () => console.log(`[hub] listening on ${process.env.PORT || 8100}`));
