// A Delegated Routing V1 HTTP router (specs.ipfs.tech/routing/http-routing-v1) answering like cid.contact did for the
// published site (serving/probe2.json): ONE HTTP provider, the front, for the site ROOT only (the publisher's IPNI config
// has announceAllBlocks:false). Every other CID: no providers. Logs every query so the test can show what was asked.
import http from "node:http";
import fs from "node:fs";
const [host, port, root, providerAddr, logFile] = process.argv.slice(2);
const PEER = "12D3KooWSHxfM6L5zdmTkMh5ho8yPBB2292ug6T46BnkpCwYzoZP";   // the publisher's provider id (probe2: cid.contact)
http.createServer((req, res) => {
  fs.appendFileSync(logFile, `${req.method} ${req.url}\n`);
  const m = /^\/routing\/v1\/providers\/([^/?]+)/.exec(req.url);
  if (!m) { res.writeHead(404); return res.end(); }
  const providers = m[1] === root ? [{ Schema: "peer", ID: PEER, Addrs: [providerAddr] }] : [];
  if (!providers.length) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ Providers: null })); }
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ Providers: providers }));
}).listen(Number(port), host);
