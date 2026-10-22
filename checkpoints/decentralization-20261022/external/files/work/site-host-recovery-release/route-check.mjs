#!/usr/bin/env node
// Named-route checks of the BUILT site-host wasm serving the new release, under the fleet engine with the wasm
// manager's serve flags.
//   WASMTIME=<engine> node route-check.mjs <site_host.wasm> <release dir>
// Covers what the frontend change touches:
//   - /dashboard (not a 404);
//   - /apps and the store;
//   - /credit and /recover direct routing, with their configs and modules;
//   - the credit vendor bundle;
//   - the private-app browser/login paths (/authorize, /sso/authorize without COOP);
//   - every /assets path (app/brand icons, logos, media) with its type;
//   - ranges on media.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";

const [WASM, RELDIR] = process.argv.slice(2).map((p) => path.resolve(p));
const SITE = path.join(RELDIR, "site");
const CID = JSON.parse(fs.readFileSync(path.join(RELDIR, "release.json"), "utf8")).cid;
const bytes = (rel) => fs.readFileSync(path.join(SITE, rel));
const fails = [];
const check = (cond, what) => { if (!cond) fails.push(what); };

const port = await new Promise((ok) => { const l = net.createServer().listen(0, "127.0.0.1", () => { const p = l.address().port; l.close(() => ok(p)); }); });
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "route-check-"));
const proc = spawn(process.env.WASMTIME || "wasmtime", ["serve", "-Scli", "-Shttp", "-W", `max-memory-size=${256 << 20}`, "--dir", `${cfg}::/config`,
  "--env", `ENCLAVE_CONFIG=${JSON.stringify({ release: CID })}`, "--addr", `127.0.0.1:${port}`, WASM], { stdio: ["ignore", "pipe", "pipe"] });
await new Promise((ok, fail) => {
  let log = ""; const t = setTimeout(() => fail(new Error("serve did not start\n" + log)), 60000);
  const on = (d) => { log += d; if (log.includes("Serving HTTP")) { clearTimeout(t); ok(); } };
  proc.stdout.on("data", on); proc.stderr.on("data", on);
});
const get = (p, headers = {}, method = "GET") => new Promise((ok, fail) => {
  const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: { host: "enclave.host", ...headers } }, (res) => {
    const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
  });
  r.on("error", fail); r.end();
});

try {
  const ev = JSON.parse((await get("/.well-known/site-host")).body);
  check(ev.release === CID, `/.well-known/site-host names ${ev.release}, not ${CID}`);
  for (const [p, file] of [["/dashboard", "dashboard.html"], ["/DASHBOARD", "dashboard.html"], ["/", "index.html"], ["/apps/", "apps/index.html"],
    ["/apps/publish", "apps/publish.html"], ["/authorize", "authorize.html"], ["/sso/authorize", "sso/authorize.html"], ["/sessions", "sessions.html"],
    ["/credit/", "credit/index.html"], ["/credit/index.html", "credit/index.html"], ["/credit/credit.js", "credit/credit.js"],
    ["/credit/credit-config.json", "credit/credit-config.json"], ["/recover/", "recover/index.html"], ["/recover/recover.js", "recover/recover.js"],
    ["/recover/recover-config.json", "recover/recover-config.json"], ["/vendor/credit-vault.js", "vendor/credit-vault.js"]]) {
    const r = await get(p);
    check(r.status === 200, `${p}: ${r.status}`);
    check(r.body.equals(bytes(file)), `${p}: not the bytes of ${file}`);
    check(!!r.headers["content-security-policy"], `${p}: no release CSP`);
  }
  for (const [p, to] of [["/apps", "/apps/"], ["/credit", "/credit/"], ["/recover", "/recover/"], ["/credit?x=1", "/credit/?x=1"]]) {
    const r = await get(p);
    check(r.status === 308 && r.headers.location === to, `${p}: ${r.status} -> ${r.headers.location} (want 308 -> ${to})`);
  }
  check((await get("/sso/authorize")).headers["cross-origin-opener-policy"] === undefined, "/sso/authorize carries COOP");
  check(!!(await get("/dashboard")).headers["cross-origin-opener-policy"], "/dashboard lost COOP");
  check(JSON.parse((await get("/credit/credit-config.json")).body).leaseGasReserve === null, "served credit-config enables a reserve");
  check(/^text\/javascript/.test((await get("/credit/credit.js")).headers["content-type"] || ""), "/credit/credit.js is not served as JavaScript");
  // every asset (brand/app/technology icons, logos, cinematic media): served, typed, byte-exact
  const assets = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "logs/asset-paths.txt"), "utf8").trim().split("\n");
  for (const a of assets) {
    const r = await get(a);
    check(r.status === 200 && r.body.equals(bytes(a.slice(1))) && !!r.headers["content-type"], `${a}: ${r.status}`);
  }
  const mp4 = assets.find((a) => a.endsWith(".mp4"));
  const part = await get(mp4, { range: "bytes=0-1023" });
  check(part.status === 206 && part.body.equals(bytes(mp4.slice(1)).subarray(0, 1024)), `${mp4} range: ${part.status}`);
  const nf = await get("/no-such-page");
  check(nf.status === 404 && nf.body.equals(bytes("404.html")), "404 page");
  console.log(JSON.stringify({ release: CID, assetsChecked: assets.length, failures: fails }, null, 1));
} finally { proc.kill("SIGKILL"); fs.rmSync(cfg, { recursive: true, force: true }); }
if (fails.length) { console.error("ROUTE-CHECK-FAILED"); process.exit(1); }
console.log("ROUTE-CHECK-OK");
