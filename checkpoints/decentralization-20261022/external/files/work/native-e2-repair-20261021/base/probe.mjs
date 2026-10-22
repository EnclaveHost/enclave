// native-win fixture, INSIDE the circuit sandbox (a node.exe copy as worker.exe, exactly like a circuit worker): which
// loopback paths does the AppContainer + enclave-circuit-firewall policy allow? Prints one JSON line.
import net from 'node:net'; import dgram from 'node:dgram';
const [granted, other] = process.argv.slice(2).map(Number);
const tcp = (port) => new Promise((ok) => { const c = net.connect({ host: '127.0.0.1', port }); const t = setTimeout(() => { c.destroy(); ok(false); }, 3000);
  c.on('data', () => { clearTimeout(t); c.destroy(); ok(true); }); c.on('error', () => { clearTimeout(t); ok(false); }); });
const udp = (port) => new Promise((ok) => { const s = dgram.createSocket('udp4'); const t = setTimeout(() => { s.close(); ok(false); }, 3000);
  s.on('message', () => { clearTimeout(t); s.close(); ok(true); }); s.on('error', () => { clearTimeout(t); try { s.close(); } catch {} ok(false); });
  s.send('q', port, '127.0.0.1', (e) => { if (e) { clearTimeout(t); try { s.close(); } catch {} ok(false); } }); });
const out = { type: 'probe', tcpGranted: await tcp(granted), tcpOther: await tcp(other), udpGranted: await udp(granted) };
console.log(JSON.stringify(out));
