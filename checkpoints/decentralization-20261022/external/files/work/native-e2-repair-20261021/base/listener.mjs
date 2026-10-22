// native-win fixture, OUTSIDE the sandbox: a stand-in for route-dns on loopback - TCP and UDP on one port, plus a second
// TCP port that is NOT granted. Prints {"type":"ready",...}; every accepted TCP connection / UDP datagram is logged as JSON.
import net from 'node:net'; import dgram from 'node:dgram';
const [granted, other] = process.argv.slice(2).map(Number);
const log = (o) => console.log(JSON.stringify(o));
for (const p of [granted, other]) net.createServer((c) => { log({ type: 'tcp', port: p }); c.end('ok'); c.on('error', () => {}); }).listen(p, '127.0.0.1');
const u = dgram.createSocket('udp4'); u.on('message', (m, r) => { log({ type: 'udp', port: granted }); u.send('ok', r.port, r.address); }); u.bind(granted, '127.0.0.1');
setTimeout(() => log({ type: 'ready', granted, other }), 300);
setTimeout(() => process.exit(0), 45000).unref();
