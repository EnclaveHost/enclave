// Per-tenant authenticated SOCKS front. TUNA carries the outbound connection;
// there is no Enclave relay control channel or dedicated source-IP claim.
import net from 'node:net';
import dns from 'node:dns/promises';
import { once } from 'node:events';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isBlockedHost } from './net-guard.mjs';

export function egressToken(secret, id) {
  return createHmac('sha256', secret).update('nan-egress:' + id).digest('base64url');
}
const reply = code => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
function reader(socket) {
  let buf = Buffer.alloc(0), waiting, failure;
  const fail = e => { failure = e; waiting?.(); };
  const data = b => { buf = Buffer.concat([buf, b]); if (buf.length > 65536) socket.destroy(new Error('SOCKS handshake overflow')); waiting?.(); };
  const end = () => fail(new Error('SOCKS connection ended'));
  socket.on('data', data); socket.on('error', fail); socket.on('end', end); socket.on('close', end);
  return {
    async take(n) {
      while (buf.length < n) {
        if (failure) throw failure;
        await new Promise(resolve => { waiting = resolve; }); waiting = null;
      }
      const out = buf.subarray(0, n); buf = buf.subarray(n); return out;
    },
    release() {
      socket.pause(); socket.off('data', data); socket.off('error', fail); socket.off('end', end); socket.off('close', end);
      if (buf.length) socket.unshift(buf);
    },
  };
}
async function address(read, type) {
  if (type === 1) return [...await read.take(4)].join('.');
  if (type === 4) {
    const b = await read.take(16); return Array.from({length: 8}, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':');
  }
  if (type === 3) {const n = (await read.take(1))[0]; if (n) return (await read.take(n)).toString('utf8');}
  throw new Error('invalid SOCKS address');
}

export function createEgress({ secret, socksPort = 1080, upstream, isKnown, lookup = dns.lookup, log = () => {} }) {
  const target = new URL(upstream);
  if (target.protocol !== 'socks5:' || !target.hostname || !target.port || target.username || target.password) throw new Error('TUNA SOCKS upstream required');
  const connections = new Set();
  const track = s => { connections.add(s); s.on('error', () => s.destroy()); s.once('close', () => connections.delete(s)); return s; };
  async function connect(sock) {
    const input = reader(sock); let output, remote;
    sock.setTimeout(15000, () => sock.destroy(new Error('SOCKS handshake timed out')));
    try {
      const greeting = await input.take(2);
      if (greeting[0] !== 5 || !(await input.take(greeting[1])).includes(2)) {sock.end(Buffer.from([5, 255])); return;}
      sock.write(Buffer.from([5, 2]));
      const auth = await input.take(2);
      if (auth[0] !== 1 || !auth[1]) throw new Error('invalid SOCKS authentication');
      const id = (await input.take(auth[1])).toString('utf8');
      const password = await input.take((await input.take(1))[0]);
      const expected = Buffer.from(egressToken(secret, id));
      if (password.length !== expected.length || !timingSafeEqual(password, expected) || (isKnown && !isKnown(id))) {
        sock.end(Buffer.from([1, 1])); return;
      }
      sock.write(Buffer.from([1, 0]));
      const req = await input.take(4);
      if (req[0] !== 5 || req[1] !== 1 || req[2] !== 0) {sock.end(reply(7)); return;}
      const host = await address(input, req[3]), port = (await input.take(2)).readUInt16BE(0);
      if (!port || isBlockedHost(host)) {sock.end(reply(2)); return;}
      // Resolve before sending a literal address to the provider. A hostname
      // cannot redirect a second DNS lookup into either host's private network.
      const addresses = net.isIP(host) ? [{address: host}] : await lookup(host, {all: true});
      if (!addresses.length || addresses.some(a => isBlockedHost(a.address))) {sock.end(reply(2)); return;}
      if (sock.destroyed) return;
      const destination = addresses[0].address;
      remote = track(net.connect(Number(target.port), target.hostname.replace(/^\[|\]$/g, '')));
      sock.once('close', () => remote.destroy()); remote.once('close', () => sock.destroy());
      remote.setTimeout(15000, () => remote.destroy(new Error('TUNA SOCKS upstream timed out')));
      await once(remote, 'connect'); output = reader(remote);
      remote.write(Buffer.from([5, 1, 0]));
      const accepted = await output.take(2);
      if (accepted[0] !== 5 || accepted[1] !== 0) throw new Error('TUNA SOCKS authentication unavailable');
      const name = Buffer.from(destination), request = Buffer.alloc(7 + name.length);
      request.set([5, 1, 0, 3, name.length]); name.copy(request, 5); request.writeUInt16BE(port, 5 + name.length);
      remote.write(request);
      const response = await output.take(4);
      if (response[0] !== 5 || response[1] !== 0 || response[2] !== 0) throw new Error('TUNA provider refused destination');
      await address(output, response[3]); await output.take(2);
      input.release(); output.release();
      sock.setTimeout(0); remote.setTimeout(0); sock.write(reply(0));
      sock.pipe(remote).pipe(sock); sock.resume(); remote.resume();
    } catch (e) {
      log(`[egress] ${e.message}`); remote?.destroy(); if (!sock.destroyed) sock.end(reply(4));
    }
  }
  const socks = net.createServer(sock => {track(sock); connect(sock).catch(() => sock.destroy());});
  socks.on('error', e => log(`[egress] ${e.message}`));
  return {
    start() { return new Promise((resolve, reject) => {socks.once('error', reject); socks.listen(socksPort, '127.0.0.1', resolve);}); },
    stop() {socks.close(); for (const s of connections) s.destroy();},
    socksPort: () => socks.address()?.port ?? socksPort,
    envFor(id) {return `socks5h://${id}:${egressToken(secret, id)}@127.0.0.1:${socks.address()?.port ?? socksPort}`;},
  };
}
