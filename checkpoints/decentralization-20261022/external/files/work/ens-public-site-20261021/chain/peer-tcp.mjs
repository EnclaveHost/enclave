// READ-ONLY reachability of the second provider record's address (62.238.4.214:4001, the Nan Kubo peer): one TCP connect
// per address, 8 s timeout, no bytes sent, connection closed at once. Not an HTTP/gateway probe.
import net from 'node:net';
const targets = [['62.238.4.214', 4001], ['2a01:4f9:c013:bdfd::1', 4001]];
const res = {};
for (const [h, p] of targets) res[`${h}:${p}`] = await new Promise((ok) => { const t0 = Date.now(); const s = net.connect({ host: h, port: p });
  const done = (r) => { s.destroy(); ok({ ...r, ms: Date.now() - t0 }); };
  s.setTimeout(8000, () => done({ result: 'timeout' })); s.on('connect', () => done({ result: 'connected' })); s.on('error', (e) => done({ result: 'error', code: e.code })); });
console.log(JSON.stringify({ at: new Date().toISOString(), res }, null, 1));
