// network/client-hello.mjs: the SNI peek the app ingress gate, the direct runtime and the providers' SNI router use.
import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import net from 'node:net';
import {once} from 'node:events';
import {clientHelloName} from '../network/client-hello.mjs';

test('ClientHello parser waits for fragmented input and rejects malformed TLS', () => {
  assert.equal(clientHelloName(Buffer.from([22, 3])), null);
  assert.equal(clientHelloName(Buffer.from('GET / HTTP/1.1')), false);
  const malformed = Buffer.from([22, 3, 3, 0, 4, 1, 0, 0, 99]);
  assert.equal(clientHelloName(malformed), false);
});

test('a real ClientHello yields its server name, and a prefix of it asks for more bytes', async t => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const hello = new Promise(resolve => server.once('connection', socket => { let buf = Buffer.alloc(0);
    socket.on('data', chunk => { buf = Buffer.concat([buf, chunk]); if (clientHelloName(buf) !== null) { socket.destroy(); resolve(buf); } }); }));
  const client = tls.connect({host: '127.0.0.1', port: server.address().port, servername: 'Shop.Example.COM', rejectUnauthorized: false});
  client.on('error', () => {});
  const buf = await hello; client.destroy();
  assert.equal(clientHelloName(buf), 'shop.example.com');
  assert.equal(clientHelloName(buf.subarray(0, buf.length - 1)), null);
});
