// probe (no network beyond loopback): res 'close' on a client abort with no response yet; TLS destroy mid-handshake
import http from 'node:http'; import net from 'node:net'; import tls from 'node:tls';
const t0 = Date.now(), log = (m) => console.log(`${Date.now() - t0}ms ${m}`);
const silent = net.createServer((c) => { log('silent: accepted'); c.on('close', () => log('silent: closed')); c.on('error', () => {}); });
await new Promise((r) => silent.listen(0, '127.0.0.1', r));
const srv = http.createServer((req, res) => {
  log('server: request');
  const s = tls.connect({ host: '127.0.0.1', port: silent.address().port, rejectUnauthorized: false });
  s.on('error', (e) => log('tls error ' + e.message));
  req.on('close', () => log('req close'));
  res.on('close', () => { log(`res close writableFinished=${res.writableFinished}`); s.destroy(); log('tls destroyed'); });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const ac = new AbortController();
const q = http.request({ host: '127.0.0.1', port: srv.address().port, signal: ac.signal, agent: false }); q.on('error', () => log('client aborted')); q.end();
setTimeout(() => ac.abort(), 300);
setTimeout(() => { srv.close(); silent.close(); process.exit(0); }, 1500);
