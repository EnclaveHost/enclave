// probe 2: tls.connect over our own net socket; destroy both mid-handshake -> does the peer see the close promptly?
import net from 'node:net'; import tls from 'node:tls';
const t0 = Date.now(), log = (m) => console.log(`${Date.now() - t0}ms ${m}`);
const silent = net.createServer((c) => { log('silent: accepted'); c.on('close', () => log('silent: closed')); c.on('error', () => {}); });
await new Promise((r) => silent.listen(0, '127.0.0.1', r));
for (const mode of ['tls-destroy-only', 'raw-destroy']) {
  const raw = net.connect({ host: '127.0.0.1', port: silent.address().port });
  const s = tls.connect({ socket: raw, rejectUnauthorized: false }); s.on('error', () => {}); raw.on('error', () => {});
  await new Promise((r) => setTimeout(r, 200));
  log(`${mode}: destroying`);
  s.destroy(); if (mode === 'raw-destroy') raw.destroy();
  await new Promise((r) => setTimeout(r, 400));
}
silent.close(); process.exit(0);
