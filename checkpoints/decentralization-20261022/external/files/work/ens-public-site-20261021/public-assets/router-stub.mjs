// Delegated Routing V1 stub. mode "root": the site ROOT only (what cid.contact / delegated-ipfs.dev answer today, probe2.out);
// mode "all": every CID in the site (what announcing all blocks would give). Logs every query.
import http from "node:http";
import fs from "node:fs";
const [host, port, mode, root, cidsFile, providerAddr, logFile] = process.argv.slice(2);
const all = new Set(fs.readFileSync(cidsFile, "utf8").split("\n").filter(Boolean));
const PEER = "12D3KooWSHxfM6L5zdmTkMh5ho8yPBB2292ug6T46BnkpCwYzoZP";
http.createServer((req, res) => {
  const m = /^\/routing\/v1\/providers\/([^/?]+)/.exec(req.url);
  const hit = m && (mode === "all" ? all.has(m[1]) : m[1] === root);
  fs.appendFileSync(logFile, `${hit ? "HIT " : "MISS"} ${req.method} ${req.url}\n`);
  if (!hit) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ Providers: null })); }
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ Providers: [{ Schema: "peer", ID: PEER, Addrs: [providerAddr] }] }));
}).listen(Number(port), host);
