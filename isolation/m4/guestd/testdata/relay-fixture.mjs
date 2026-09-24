// Driven by datapath_chain_test.go: what relay/relay.js does AFTER it has chosen a route - carry a client's raw TCP
// bytes, unchanged, as binary WebSocket frames to the supervisor's /x/<id>/https. Here each listener's route is
// FIXED to one deployment, whatever the ClientHello says, so a test can also deliver a session to the wrong route
// on purpose (a relay that misroutes).
//   node relay-fixture.mjs <supervisor port> <deployment id>...
// Prints {"routes":{"<id>":<port>,...}} once every listener is up.
import net from "node:net";
import WebSocket, { createWebSocketStream } from "ws";

const [supPort, ...ids] = process.argv.slice(2);
const routes = {};
await Promise.all(ids.map((id) => new Promise((resolve) => {
  const srv = net.createServer((client) => {
    const ws = new WebSocket(`ws://127.0.0.1:${supPort}/x/${id}/https`);
    const up = createWebSocketStream(ws);
    const close = () => { client.destroy(); up.destroy(); };
    up.on("error", close); client.on("error", close);
    up.on("close", close); client.on("close", close);
    client.pipe(up);
    up.pipe(client);
  });
  srv.listen(0, "127.0.0.1", () => { routes[id] = srv.address().port; resolve(); });
})));
console.log(JSON.stringify({ routes }));
