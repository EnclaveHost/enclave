#!/usr/bin/env node
// lab-site.mjs -- the SITE for the LAB browser channel (PVM-CPU.md; NOT production): it serves the page and its code
// (web/*.js, lab.html) and the page's pins, from an origin that is not the relay's -- the relay carries bytes and never
// serves the code that verifies it. POST /result appends the page's outcome (one JSON line) to --results.
//   node web/lab-site.mjs --port 18450 --results FILE --app HEX --code-hash HEX --authority HEX [--runtime-id HEX]
//                         --connect "http://127.0.0.1:18447 http://127.0.0.1:18457"   (the relays the page may reach)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
const pins = { app: arg("--app"), codeHash: arg("--code-hash"), authority: arg("--authority"),
               runtimeId: arg("--runtime-id") || createHash("sha256").update(PIXEL).digest("hex"),
               ...(arg("--root-pin") ? { rootPins: [arg("--root-pin")] } : {}) };   // --root-pin: synthetic-chain tests only (default: Google's roots)
if (!pins.app || !pins.codeHash || !pins.authority) { console.error("usage: lab-site.mjs --app H --code-hash H --authority H [--runtime-id H] [--port P] [--results F] [--connect ORIGINS]"); process.exit(2); }
const FILES = { "/lab.html": "text/html", "/pvm-client.js": "text/javascript", "/pvm-verify.js": "text/javascript", "/pvm-sealed.js": "text/javascript", "/lab.js": "text/javascript", "/vendor/hpke-core-1.9.0.js": "text/javascript" };
const csp = `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' ${arg("--connect", "")}; base-uri 'none'; form-action 'none'`;
const log = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "POST" && u.pathname === "/result") {
    let b = ""; req.on("data", (d) => { b += d; if (b.length > 1 << 20) req.destroy(); });
    req.on("end", () => { try { const r = JSON.parse(b); fs.appendFileSync(arg("--results", "/dev/null"), JSON.stringify(r) + "\n"); log({ result: r.label, status: r.status ?? null, step: r.step ?? null }); } catch {} res.end("ok"); });
    return;
  }
  if (u.pathname === "/pins.json") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); return res.end(JSON.stringify(pins)); }
  const type = FILES[u.pathname];
  if (!type) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "content-security-policy": csp, "x-content-type-options": "nosniff" });
  res.end(fs.readFileSync(path.join(HERE, u.pathname.slice(1))));
}).listen(Number(arg("--port", "18450")), "127.0.0.1", function () { log({ site: `http://127.0.0.1:${this.address().port}/lab.html`, pins }); });
process.on("SIGTERM", () => process.exit(0));
