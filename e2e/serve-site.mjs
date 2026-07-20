// Tiny static server over site/ (the tree is valid unbundled ES modules; dev
// never needs the bundler). Mirrors the _redirects pretty URLs the gateway
// serves in production, because the soft-nav router links to them.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain",
  ".wasm": "application/wasm", ".map": "application/json" };
const PRETTY = { "/apps": "/apps.html", "/develop": "/develop.html", "/dashboard": "/dashboard.html",
  "/checkout": "/checkout.html", "/admin": "/admin.html", "/terms": "/terms.html", "/privacy": "/privacy.html",
  "/apps/deploy": "/apps.html", "/apps/publish": "/apps.html" };

export function serveSite(root, port) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html";
    if (PRETTY[p]) p = PRETTY[p];
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found");
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream",
                         "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);                 // EADDRINUSE must FAIL the setup, not crash the runner
    server.listen(port, () => resolve(server));   // all interfaces: the site answers on localhost (WebAuthn needs a domain)
  });
}
