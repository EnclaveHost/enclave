import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import {spliceStream} from '../isolation/m4/guestd/supervisor-splice.mjs';

test('custom SNI must belong to the deployment before any guest route is opened', async () => {
  for (const [sni, allowed, expected] of [
    ['12345678.app.enclave.host', [], true],
    ['eyesoff.ai', ['eyesoff.ai'], true],
    ['eyesoff.ai', [], false],
    ['other.example', ['eyesoff.ai'], false],
  ]) {
    let routes = 0, finish;
    const result = new Promise(r => finish = r);
    const server = net.createServer(stream => {
      spliceStream({stream, expectName:'12345678.app.enclave.host', allowedNames:allowed,
        instanceId:'gd12345678', expectAppId:'ab'.repeat(32), dataAddr:'127.0.0.1:1',
        transport:{request:async()=>{routes++;throw Error('test route reached')}},
        limits:{helloMs:1000,openMs:1000}}).then(finish);
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const client=tls.connect({host:'127.0.0.1',port:server.address().port,servername:sni});
    client.on('error',()=>{});
    try {
      const r=await result;
      assert.equal(routes,expected?1:0,sni);
      assert.equal(r.kind,expected?'no-route':'wrong-name');
    } finally { client.destroy(); await new Promise(r=>server.close(r)); }
  }
});
