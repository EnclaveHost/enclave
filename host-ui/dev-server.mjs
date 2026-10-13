#!/usr/bin/env node
// host-ui/dev-server.mjs -- the hosting panel in a browser: serves host-ui/ and answers its bridge's requests (/api/...)
// from a node's local API with the node's token, or from fake-node.mjs. Loopback only; the token stays here.
//
//   node host-ui/dev-server.mjs --fake [--phone] [--port 8790]
//   node host-ui/dev-server.mjs --node http://127.0.0.1:9610 --token-file C:\ProgramData\Enclave\hosting\hosting-admin.token
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeNode } from "./fake-node.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

/** -> an http.Server serving the panel; `fake` (a createFakeNode()) or `node` + `token()` answer its requests. */
export function createDevServer({ fake = null, node = null, token = () => null } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/")) {
      const p = url.pathname.slice(4);
      if (!p.startsWith("/v1/local/hosting")) { res.writeHead(403).end(); return; }
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      let r;
      if (fake) r = await fake.request(req.method, p, raw ? JSON.parse(raw) : undefined);
      else {
        try {
          const t = token();
          const a = await fetch(node + p, { method: req.method, headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...(raw ? { "content-type": "application/json" } : {}) },
                                            body: raw || undefined, signal: AbortSignal.timeout(5000) });
          r = { status: a.status, body: await a.json().catch(() => ({})) };
        } catch (e) { r = { status: 0, message: `the node is not answering at ${node} (${e.cause?.code || e.message})` }; }
      }
      const update = fake?.state.update ? { "x-enclave-update": JSON.stringify(fake.state.update) } : {};
      if (!r.status) { res.writeHead(502, { "content-type": "application/json", ...update }).end(JSON.stringify({ error: "unreachable", message: r.message })); return; }
      res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store", ...update }).end(JSON.stringify(r.body));
      return;
    }
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!/^[a-z-]+\.(html|css|js|svg)$/.test(name) || name.endsWith(".mjs")) { res.writeHead(404).end(); return; }
    fs.readFile(path.join(HERE, name), (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(name)], "cache-control": "no-store" }).end(buf);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const port = Number(arg("--port") || 8790);
  const tokenFile = arg("--token-file");
  const srv = process.argv.includes("--fake")
    ? createDevServer({ fake: createFakeNode({ kind: process.argv.includes("--phone") ? "phone" : "pc" }) })
    : createDevServer({ node: arg("--node") || "http://127.0.0.1:9610", token: () => tokenFile ? fs.readFileSync(tokenFile, "utf8").trim() : null });
  srv.listen(port, "127.0.0.1", () => console.log(`host-ui: http://127.0.0.1:${port}/`));
}
