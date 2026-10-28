// client-native-r1 self-test server (UNREVIEWED, NOT RUN). Loopback only, exactly four public static paths, GET/HEAD
// only, Host header must be the loopback literal it listens on, strict CSP (no network from the page: connect-src
// 'none'), no-store. The bundle is served only if its sha256 equals SELFTEST_BUNDLE_SHA256 (root pins it after review).
//   SELFTEST_BUNDLE_SHA256=<hex> node client-native-r1/browser-selftest/server.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const WANT = String(process.env.SELFTEST_BUNDLE_SHA256 || "");
if (!/^[0-9a-f]{64}$/.test(WANT)) throw new Error("SELFTEST_BUNDLE_SHA256 (root-reviewed bundle hash) is required");
const bundle = fs.readFileSync(path.join(HERE, "dist", "selftest.js"));
const got = createHash("sha256").update(bundle).digest("hex");
if (got !== WANT) throw new Error(`dist/selftest.js sha256 ${got} != SELFTEST_BUNDLE_SHA256 ${WANT}`);

const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/child.html": ["child.html", "text/html; charset=utf-8"],
  "/dist/selftest.js": [null, "text/javascript; charset=utf-8"],
};
const CSP = "default-src 'none'; script-src 'self'; frame-src 'self'; child-src 'self'; connect-src 'none'; img-src 'none'; "
  + "style-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

const port = Number(process.argv[2] ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("bad port");
const server = http.createServer((req, res) => {
  const here = `127.0.0.1:${server.address().port}`;
  const deny = (status, msg) => { res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" }); res.end(msg); };
  if (req.headers.host !== here) return deny(421, "wrong host");
  if (req.method !== "GET" && req.method !== "HEAD") return deny(405, "method");
  const u = new URL(req.url, `http://${here}`);
  const f = FILES[u.pathname];
  if (!f) return deny(404, "not found");
  const body = f[0] === null ? bundle : fs.readFileSync(path.join(HERE, f[0]));
  res.writeHead(200, { "content-type": f[1], "cache-control": "no-store", "content-security-policy": CSP,
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "SAMEORIGIN",
    "cross-origin-opener-policy": "same-origin", "cross-origin-resource-policy": "same-origin" });
  res.end(req.method === "HEAD" ? undefined : body);
});
server.listen(port, "127.0.0.1", () => {
  const a = server.address();
  if (a.address !== "127.0.0.1") { server.close(); throw new Error("not bound to loopback"); }
  console.log(`client-native-r1 selftest: http://127.0.0.1:${a.port}/  (Ctrl-C to stop)`);
});
