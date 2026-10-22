// site-host end to end: the BUILT component under the real `wasmtime serve` (the platform's serve-mode flags), against
// the release directory it embeds.
//
//   SITE_HOST_WASM=target/wasm32-wasip2/release/site_host.wasm SITE_RELEASE_DIR=<dir>/<CID> node --test test/e2e.mjs
//   (SITE_HOST_NETNS=1 asserts the run is inside a network namespace that has only loopback: the cold-start proof)
//
// The expectations come from the release itself:
//   - bytes from site/;
//   - headers from the release tool's headers.caddy;
//   - routes from _redirects;
//   - installers from installers/.
// They also come from the production vhost's rules (work/site-recovery-endpoints/*.candidate.caddy). Nothing here
// imports the component's code.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";

const WASM = path.resolve(process.env.SITE_HOST_WASM || "target/wasm32-wasip2/release/site_host.wasm");
const REL = path.resolve(process.env.SITE_RELEASE_DIR || "");
const WASMTIME = process.env.WASMTIME || "wasmtime";
const WASM_TOOLS = process.env.WASM_TOOLS || "wasm-tools";
const SITE = path.join(REL, "site");
const CID = JSON.parse(fs.readFileSync(path.join(REL, "release.json"), "utf8")).cid;
const OTHER = "bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y"; // a real, different release (production)
const MEM = 256 * 1024 * 1024; // `enclave publish --mem 256`

const servers = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-host-e2e-"));

/** Start `wasmtime serve` as the wasm manager does (-Scli -Shttp, max-memory-size, a read-only /config preopen). */
async function serve({ env = {}, configFile = null } = {}) {
  const cfgDir = fs.mkdtempSync(path.join(tmp, "cfg-"));
  if (configFile !== null) fs.writeFileSync(path.join(cfgDir, "config.json"), configFile);
  const free = await new Promise((ok) => { const l = net.createServer().listen(0, "127.0.0.1", () => { const p = l.address().port; l.close(() => ok(p)); }); });
  const args = ["serve", "-Scli", "-Shttp", "-W", `max-memory-size=${MEM}`, "--dir", `${cfgDir}::/config`,
    ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]), "--addr", `127.0.0.1:${free}`, WASM];
  const p = spawn(WASMTIME, args, { stdio: ["ignore", "pipe", "pipe"] });
  servers.push(p);
  let log = "";
  const port = await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error("wasmtime serve did not start:\n" + log)), 60000);
    const on = (d) => { log += d; const m = /Serving HTTP on http:\/\/127\.0\.0\.1:(\d+)/.exec(log); if (m) { clearTimeout(t); ok(Number(m[1])); } };
    p.stdout.on("data", on); p.stderr.on("data", on);
    p.on("exit", (c) => fail(new Error(`wasmtime serve exited ${c}:\n${log}`)));
  });
  return { port, log: () => log, stop: () => new Promise((ok) => { if (p.exitCode !== null) return ok(); p.once("exit", ok); p.kill("SIGKILL"); }) };
}

/** A raw request: the path goes on the wire exactly as given (no URL normalization). */
function req(port, rawPath, { method = "GET", headers = {} } = {}) {
  return new Promise((ok, fail) => {
    const r = http.request({ host: "127.0.0.1", port, path: rawPath, method, headers: { host: "enclave.host", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", fail);
    r.setTimeout(60000, () => r.destroy(new Error("timeout " + rawPath)));
    r.end();
  });
}

const files = [];
(function walk(abs, rel) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) walk(path.join(abs, e.name), r); else files.push(r);
  }
})(SITE, "");
const isFile = (rel) => { try { return fs.statSync(path.join(SITE, rel)).isFile(); } catch { return false; } };
const isDir = (rel) => { try { return fs.statSync(path.join(SITE, rel)).isDirectory(); } catch { return false; } };
const bytes = (rel) => fs.readFileSync(path.join(SITE, rel));

// the release tool's own rendering of the ledger: `    Name "value"` lines
const RELEASE_HEADERS = Object.fromEntries([...fs.readFileSync(path.join(REL, "headers.caddy"), "utf8").matchAll(/^ {4}([A-Za-z-]+) "([^"]*)"$/gm)].map((m) => [m[1].toLowerCase(), m[2]]));
const SSO_POPUP = ["/sso/authorize", "/sso/authorize.html", "/sso-authorize", "/sso-authorize.html"];
// standard registrations (IANA / WHATWG), not the component's table
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json", map: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", ico: "image/vnd.microsoft.icon", mp4: "video/mp4", webm: "video/webm", woff2: "font/woff2", woff: "font/woff", wasm: "application/wasm",
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", xml: "text/xml; charset=utf-8", sh: "text/plain; charset=utf-8",
  ps1: "text/plain; charset=utf-8", pdf: "application/pdf", avif: "image/avif", webmanifest: "application/manifest+json" };
const typeOf = (rel) => (path.basename(rel) === "_redirects" ? "text/plain; charset=utf-8" : TYPES[rel.split(".").pop().toLowerCase()]);
const ALLOWED_EXTRA = new Set(["content-type", "content-length", "etag", "cache-control", "accept-ranges", "location", "content-range", "allow", "date", "transfer-encoding", "connection", "keep-alive"]);

function assertReleaseHeaders(r, pathname, what) {
  for (const [k, v] of Object.entries(RELEASE_HEADERS)) {
    if (k === "cross-origin-opener-policy" && SSO_POPUP.includes(pathname.toLowerCase())) {
      assert.equal(r.headers[k], undefined, `${what}: COOP must be absent on the SSO popup document`);
      continue;
    }
    assert.equal(r.headers[k], v, `${what}: ${k}`);
  }
  for (const k of Object.keys(r.headers)) assert.ok(k in RELEASE_HEADERS || ALLOWED_EXTRA.has(k), `${what}: unexpected header ${k}`);
}

let main;
before(async () => { main = await serve({ env: { ENCLAVE_CONFIG: JSON.stringify({ release: CID, wasi: "0.2" }), ENCLAVE_CONFIG_FILE: "/config/config.json" } }); });
after(() => { for (const p of servers) p.kill("SIGKILL"); fs.rmSync(tmp, { recursive: true, force: true }); });

test("the component can fetch nothing: no outgoing-handler, no sockets", () => {
  const wit = execFileSync(WASM_TOOLS, ["component", "wit", WASM], { encoding: "utf8", maxBuffer: 64 << 20 });
  assert.match(wit, /export wasi:http\/incoming-handler@0\.2/);
  assert.doesNotMatch(wit, /import wasi:http\/outgoing-handler/);
  assert.doesNotMatch(wit, /import wasi:sockets\//);
  if (process.env.SITE_HOST_NETNS === "1") {
    const ifaces = fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2).map((l) => l.split(":")[0].trim()).filter(Boolean);
    assert.deepEqual(ifaces, ["lo"], "this run is inside a namespace with loopback only");
  }
});

test("every file of the release is served byte for byte, typed, with the release's headers", async () => {
  assert.ok(files.length > 100, "the real release");
  for (const rel of files) {
    const url = "/" + rel.split("/").map(encodeURIComponent).join("/");
    const r = await req(main.port, url);
    assert.equal(r.status, 200, rel);
    assert.ok(r.body.equals(bytes(rel)), `${rel}: bytes`);
    assert.equal(r.headers["content-type"], typeOf(rel), `${rel}: type`);
    assert.match(r.headers.etag, /^"b[a-z2-7]+"$/, `${rel}: etag`);
    assert.equal(r.headers["cache-control"], rel === "js/boot.js" ? "no-cache" : rel.startsWith("js/chunks/") ? "public, max-age=31536000, immutable" : "no-cache", `${rel}: cache`);
    assertReleaseHeaders(r, url, rel);
  }
});

test("routes: pretty routes from _redirects, the root, canonical directories, installers, the 404 page", async () => {
  const rules = fs.readFileSync(path.join(SITE, "_redirects"), "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)
    .map((l) => l.split(/\s+/)).filter(([f]) => f !== "/*");
  assert.ok(rules.length >= 10);
  for (const [from, to, status] of rules) {
    const rel = from.slice(1);
    const shadowed = isFile(rel) || isFile(rel + "/index.html");
    const r = await req(main.port, from + "?q=1");
    if (shadowed) continue;
    if (status === "200") {
      assert.equal(r.status, 200, from);
      assert.ok(r.body.equals(bytes(to.slice(1))), `${from} serves ${to}`);
      assertReleaseHeaders(r, from, from);
    } else {
      assert.equal(r.status, Number(status), from);
      assert.equal(r.headers.location, `${to}?q=1`, from);
    }
  }
  // the dashboard and store entries, case-insensitive like the vhost's path matcher
  for (const p of ["/dashboard", "/DASHBOARD", "/apps/publish", "/authorize", "/sso/authorize", "/Sessions"]) {
    const r = await req(main.port, p);
    const rule = rules.find(([f]) => f.toLowerCase() === p.toLowerCase());
    assert.equal(r.status, 200, p);
    assert.ok(r.body.equals(bytes(rule[1].slice(1))), p);
  }
  // /apps: the release ships apps/index.html, so the vhost's `not file {path} {path}/index.html` keeps the rewrite off
  // and file_server canonicalizes the directory: 308 to /apps/, which serves apps/index.html (production does the same)
  assert.ok(isFile("apps/index.html"));
  const apps = await req(main.port, "/apps?view=store");
  assert.equal(apps.status, 308);
  assert.equal(apps.headers.location, "/apps/?view=store");
  assert.ok((await req(main.port, "/apps/")).body.equals(bytes("apps/index.html")));
  const root = await req(main.port, "/");
  assert.equal(root.status, 200);
  assert.ok(root.body.equals(bytes("index.html")));
  // directories: with index.html -> 308 to the slash form, then the index; without -> 404
  for (const d of files.map((f) => path.dirname(f)).filter((d, i, a) => d !== "." && a.indexOf(d) === i)) {
    if (rules.some(([f]) => f.toLowerCase() === "/" + d.toLowerCase())) continue;
    const r = await req(main.port, "/" + d + "?k=v");
    if (isFile(d + "/index.html")) {
      assert.equal(r.status, 308, d);
      assert.equal(r.headers.location, `/${d}/?k=v`);
      const r2 = await req(main.port, "/" + d + "/");
      assert.ok(r2.body.equals(bytes(d + "/index.html")), d);
    } else {
      assert.equal(r.status, 404, d);
    }
  }
  // a file with a trailing slash -> 308 to the file
  const fslash = await req(main.port, "/index.html/");
  assert.equal(fslash.status, 308);
  assert.equal(fslash.headers.location, "/index.html");
  // installers: the release's own, as text/plain
  for (const n of ["install.sh", "install.ps1"]) {
    const r = await req(main.port, "/" + n);
    assert.equal(r.status, 200, n);
    assert.equal(r.headers["content-type"], "text/plain; charset=utf-8");
    assert.ok(r.body.equals(fs.readFileSync(path.join(REL, "installers", n))), n);
  }
  // the 404 page: real status, branded body, never cached, release headers
  const nf = await req(main.port, "/no/such/page");
  assert.equal(nf.status, 404);
  assert.ok(nf.body.equals(bytes("404.html")));
  assert.equal(nf.headers["cache-control"], "no-store");
  assertReleaseHeaders(nf, "/no/such/page", "404");
  // SSO popup documents drop COOP; the dashboard keeps it; the boot entry always revalidates
  assert.equal((await req(main.port, "/sso/authorize")).headers["cross-origin-opener-policy"], undefined);
  assert.equal((await req(main.port, "/dashboard")).headers["cross-origin-opener-policy"], RELEASE_HEADERS["cross-origin-opener-policy"]);
  assert.equal((await req(main.port, "/js/boot.js?v=2")).headers["cache-control"], "no-cache");
});

test("hostile requests: traversal, encoded separators, methods; validators and ranges", async () => {
  const index = bytes("index.html");
  for (const p of ["/../index.html", "/js/../index.html", "/%2e%2e/index.html", "/js%2fboot.js", "/js%5cboot.js", "//index.html", "/./index.html", "/%00", "/%zz", "/js/boot.js%00.html"]) {
    const r = await req(main.port, p);
    assert.equal(r.status, 400, p);
    assert.equal(r.headers["cache-control"], "no-store", p);
    assert.ok(!r.body.includes(index.subarray(0, 64)), p);
  }
  for (const m of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const r = await req(main.port, "/", { method: m });
    assert.equal(r.status, 405, m);
    assert.equal(r.headers.allow, "GET, HEAD");
  }
  const head = await req(main.port, "/index.html", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  const g = await req(main.port, "/index.html");
  assert.equal(head.headers.etag, g.headers.etag);
  const nm = await req(main.port, "/index.html", { headers: { "if-none-match": g.headers.etag } });
  assert.equal(nm.status, 304);
  assert.equal(nm.body.length, 0);
  // ranges, on the largest file in the release
  const big = files.map((f) => [f, fs.statSync(path.join(SITE, f)).size]).sort((a, b) => b[1] - a[1])[0];
  const url = "/" + big[0];
  const part = await req(main.port, url, { headers: { range: "bytes=100-199" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers["content-range"], `bytes 100-199/${big[1]}`);
  assert.ok(part.body.equals(bytes(big[0]).subarray(100, 200)));
  assert.equal((await req(main.port, url, { headers: { range: `bytes=${big[1]}-` } })).status, 416);
  const stale = await req(main.port, url, { headers: { range: "bytes=0-9", "if-range": "\"bafkreistale\"" } });
  assert.equal(stale.status, 200);
  // the same bytes under two releases never share a validator with a different file: ETag is the file's own CID
  const etags = new Map();
  for (const f of files.slice(0, 50)) {
    const r = await req(main.port, "/" + f, { method: "HEAD" });
    const key = r.headers.etag;
    if (etags.has(key)) assert.ok(bytes(etags.get(key)).equals(bytes(f)), `${f} and ${etags.get(key)} share an ETag`);
    etags.set(key, f);
  }
});

test("the pin: a wrong, missing or ambiguous release config refuses the WHOLE site; a file-only config serves", async () => {
  const cases = [
    ["wrong CID", { env: { ENCLAVE_CONFIG: JSON.stringify({ release: OTHER }) } }, "is not the embedded release"],
    ["no config", {}, "has no config"],
    ["unknown key", { env: { ENCLAVE_CONFIG: JSON.stringify({ release: CID, relase: CID }) } }, "unknown key"],
    ["not JSON", { env: { ENCLAVE_CONFIG: "release=" + CID } }, "not JSON"],
  ];
  const index = bytes("index.html");
  for (const [what, opts, why] of cases) {
    const s = await serve(opts);
    for (const p of ["/", "/index.html", "/dashboard", "/js/boot.js", "/install.sh"]) {
      const r = await req(s.port, p);
      assert.equal(r.status, 503, `${what} ${p}`);
      assert.match(r.body.toString(), new RegExp(why), what);
      assert.ok(!r.body.includes(index.subarray(0, 64)), `${what}: no release byte`);
      assert.equal(r.headers["content-security-policy"], "default-src 'none'");
      assert.equal(r.headers["cache-control"], "no-store");
      assert.equal(r.headers.etag, undefined);
    }
    const ev = await req(s.port, "/.well-known/site-host");
    assert.equal(ev.status, 503);
    assert.match(JSON.parse(ev.body).refused, new RegExp(why));
    await s.stop();   // one extra wasmtime at a time: the run stays inside its memory cap
  }
  // the >64 KiB path of the manager: ENCLAVE_CONFIG absent, the config only in /config/config.json
  const f = await serve({ configFile: JSON.stringify({ release: CID }), env: { ENCLAVE_CONFIG_FILE: "/config/config.json" } });
  const r = await req(f.port, "/");
  assert.equal(r.status, 200);
  assert.ok(r.body.equals(bytes("index.html")));
  await f.stop();
});

test("evidence and cost: /.well-known/site-host names the served release; requests stay fast", async () => {
  const ev = JSON.parse((await req(main.port, "/.well-known/site-host")).body);
  assert.equal(ev.release, CID);
  assert.equal(ev.files, files.length);
  const times = [];
  for (let i = 0; i < 15; i++) { const t = process.hrtime.bigint(); await req(main.port, "/dashboard"); times.push(Number(process.hrtime.bigint() - t) / 1e6); }
  times.sort((a, b) => a - b);
  console.log(`# /dashboard latency ms: median ${times[7].toFixed(1)}, max ${times[14].toFixed(1)} (instance per request, full path verification)`);
  assert.ok(times[7] < 2000, "median under 2 s");
});
