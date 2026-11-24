// Local-only adapters for ordinary SSH and GameStream clients. The supplied
// dial function MUST check the attested key before attaching its HTTP request.
import net from 'node:net';
import dgram from 'node:dgram';
import { Duplex } from 'node:stream';
const MAX_DATAGRAM = 65507;
const MAX_QUEUE = 256 * 1024;
export function parseBindings(text) {
  const seen = new Set();
  return text.split(',').map(s => {
    const m = /^(tcp|udp):([1-9][0-9]{0,4})(?:=([1-9][0-9]{0,4}))?$/.exec(s);
    if (!m || +m[2] > 49999 || +(m[3] || m[2]) > 65535) throw new Error(`invalid binding ${s}`);
    const b = { protocol: m[1], remote: +m[2], local: +(m[3] || m[2]) };
    const key = `${b.protocol}:${b.local}`;
    if (seen.has(key) || seen.size >= 32) throw new Error('duplicate or excessive bindings');
    seen.add(key); return b;
  });
}
// host: the loopback address the local ports bind (default 127.0.0.1; a GameStream client may need its own, e.g. 127.0.0.2).
// renewSilentMs: a UDP association the guest has not answered within this long (while the client keeps sending) is
//   dropped and opened again on the next datagram. A GameStream client pings its UDP ports before the server opens
//   them; an association made then never recovers, and Sunshine ends the session when its audio ping never arrives.
// supersedeMs: a new client of a UDP port ends that port's associations whose client has been quiet this long (a
//   restarted stream comes from new client ports, and the old associations would hold the guest's tunnel slots).
export async function startConnector(text, dial, { host = '127.0.0.1', log = console.log, renewSilentMs = 0, supersedeMs = 0 } = {}) {
  if (!/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) throw new Error('forwarded ports bind only to a 127.x loopback address');
  const listeners = [], connections = new Set(), cancelPeers = new Set();
  let stopped = false;
  const stop = () => {
    stopped = true;
    for (const cancel of cancelPeers) cancel();
    for (const c of connections) c.destroy();
    for (const l of listeners) { try { l.close(); } catch {} }
  };
  try {
    for (const b of parseBindings(text)) {
      if (b.protocol === 'tcp') {
        const server = net.createServer({ pauseOnConnect: true, allowHalfOpen: true }, async local => {
          if (connections.size >= 128) { local.destroy(); return; }
          connections.add(local);
          let remote;
          const close = () => { local.destroy(); remote?.destroy(); connections.delete(local); if (remote) connections.delete(remote); };
          local.on('error', close); local.on('close', close);
          try {
            remote = tcpChannel(await dial(b.protocol, b.remote));
            if (stopped || local.destroyed) { remote.destroy(); return; }
            connections.add(remote);
            remote.on('error', close);
            remote.on('close', () => { connections.delete(remote); if (!remote.readableEnded) close(); });
            local.setTimeout(180000, close);
            local.pipe(remote); remote.pipe(local); local.resume();
          } catch (e) { console.error(`tcp:${b.remote}: ${e.message}`); close(); }
        });
        listeners.push(server);
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(b.local, host, resolve); });
      } else {
        const socket = dgram.createSocket('udp4'), peers = new Map();
        listeners.push(socket);
        socket.on('error', e => console.error(`udp:${b.local}: ${e.message}`));
        socket.on('message', (packet, peer) => {
          if (packet.length > MAX_DATAGRAM) return;
          const key = `${peer.address}:${peer.port}`;
          let state = peers.get(key);
          if (!state) {
            if (peers.size >= 32 || connections.size >= 128) return;
            if (supersedeMs) for (const [k, o] of peers) if (Date.now() - o.fromClient > supersedeMs) o.close();
            state = { pending: [], bytes: 0, stream: null, dead: false, input: Buffer.alloc(0), answered: false, fromClient: Date.now(), close: null };
            peers.set(key, state);
            const close = () => {
              if (state.dead) return;
              state.dead = true; peers.delete(key); clearTimeout(state.timer); cancelPeers.delete(close);
              if (state.stream) { connections.delete(state.stream); state.stream.destroy(); }
            };
            state.close = close;
            cancelPeers.add(close);
            state.timer = setTimeout(close, 180000); state.timer.unref();
            dial(b.protocol, b.remote).then(stream => {
              if (state.dead) { stream.destroy(); return; }
              state.stream = stream; connections.add(stream);
              stream.setTimeout(180000, close); stream.on('close', close); stream.on('error', close);
              if (renewSilentMs) setTimeout(() => { if (!state.answered && !state.dead) { log(`udp:${b.remote}: no answer from the guest in ${renewSilentMs} ms; reopening`); close(); } }, renewSilentMs).unref();
              stream.on('data', chunk => {
                state.answered = true;
                state.input = Buffer.concat([state.input, chunk]);
                while (state.input.length >= 2) {
                  const size = state.input.readUInt16BE();
                  if (size > MAX_DATAGRAM) { close(); return; }
                  if (state.input.length < size + 2) break;
                  socket.send(state.input.subarray(2, size + 2), peer.port, peer.address, e => { if (e) close(); });
                  state.input = state.input.subarray(size + 2);
                }
              });
              for (const p of state.pending) stream.write(p);
              state.pending = []; state.bytes = 0;
            }).catch(e => { console.error(`udp:${b.remote}: ${e.message}`); close(); });
          }
          state.timer.refresh(); state.fromClient = Date.now();
          const frame = Buffer.allocUnsafe(packet.length + 2); frame.writeUInt16BE(packet.length); packet.copy(frame, 2);
          // UDP overload drops datagrams; it must not grow a video-frame backlog.
          if (state.stream) { if (state.stream.writableLength + frame.length <= MAX_QUEUE) state.stream.write(frame); }
          else if (state.bytes + frame.length <= MAX_QUEUE) { state.pending.push(frame); state.bytes += frame.length; }
        });
        await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(b.local, host, resolve); });
      }
      log(`FORWARD ${b.protocol} ${host}:${b.local} -> guest:${b.remote} (attested TLS)`);
    }
  } catch (e) { stop(); throw e; }
  return stop;
}

// TCP data uses the same bounded length framing as UDP; zero means FIN.
// FIN travels inside TLS, so an opaque relay never mistakes a half-close for
// a request to destroy the whole stream before the response has arrived.
export function tcpChannel(socket) {
  let pending = Buffer.alloc(0), ended = false, blocked = false;
  const parse = () => {
    while (!blocked && pending.length >= 2) {
      const n = pending.readUInt16BE();
      if (n > MAX_DATAGRAM || ended) { channel.destroy(new Error('invalid TCP tunnel frame')); return; }
      if (pending.length < n + 2) break;
      const data = pending.subarray(2, n + 2); pending = pending.subarray(n + 2);
      if (!n) { ended = true; channel.push(null); if (pending.length) channel.destroy(new Error('data after FIN')); return; }
      if (!channel.push(data)) { blocked = true; socket.pause(); }
    }
  };
  const channel = new Duplex({ allowHalfOpen: true,
    read() { blocked = false; parse(); if (!blocked) socket.resume(); },
    write(data, encoding, cb) {
      let offset = 0;
      const next = () => {
        if (offset === data.length) { cb(); return; }
        const n = Math.min(MAX_DATAGRAM, data.length - offset), frame = Buffer.allocUnsafe(n + 2);
        frame.writeUInt16BE(n); data.copy(frame, 2, offset, offset + n); offset += n;
        socket.write(frame, e => e ? cb(e) : next());
      }; next();
    },
    final(cb) { socket.write(Buffer.from([0,0]), cb); },
    destroy(err, cb) { socket.destroy(); cb(err); }
  });
  socket.setTimeout(180000, () => channel.destroy(new Error('idle tunnel')));
  socket.on('data', data => { pending = Buffer.concat([pending, data]); parse(); });
  socket.on('error', e => channel.destroy(e));
  socket.on('end', () => { if (!ended) channel.destroy(new Error('truncated TCP tunnel')); });
  socket.on('close', () => { if (!ended) channel.destroy(new Error('closed TCP tunnel')); });
  return channel;
}
