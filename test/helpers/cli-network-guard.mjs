// Preloaded into a CLI process under test (NODE_OPTIONS=--import=…): every outbound connection that is not loopback is
// refused and recorded in ENCLAVE_TEST_NET_LOG, and so is any request at all to the loopback port named by
// ENCLAVE_TEST_DENY_PORT (the stand-in Enclave API). A test then proves "zero calls" from the log, not from the
// absence of an error message.
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";

import { syncBuiltinESMExports } from "node:module";

const LOG = process.env.ENCLAVE_TEST_NET_LOG;
// ENCLAVE_TEST_ROUTE="PUBLIC_IP:PORT=127.0.0.1:PORT[,…]": the ONLY test transport override. A signed management record
// must name a public literal address (production validation is unchanged); this maps exactly that address to the local
// gateway inside the CLI process under test, and logs each use to ENCLAVE_TEST_ROUTE_LOG.
const ROUTES = new Map(String(process.env.ENCLAVE_TEST_ROUTE || "").split(",").filter(Boolean).map((x) => {
  const [from, to] = x.split("="); const [host, port] = to.split(":"); return [from, { host, port: Number(port) }];
}));
const ROUTE_LOG = process.env.ENCLAVE_TEST_ROUTE_LOG;
function routed(host, port) {
  const to = ROUTES.get(`${host}:${port}`);
  if (to && ROUTE_LOG) fs.appendFileSync(ROUTE_LOG, JSON.stringify({ from: `${host}:${port}`, to: `${to.host}:${to.port}` }) + "\n");
  return to || null;
}
const DENY = new Set(String(process.env.ENCLAVE_TEST_DENY_PORT || "").split(",").filter(Boolean).map(Number));
const loopback = (h) => h === undefined || h === null || h === "" || h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(String(h));
function record(what) { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, what, at: Date.now() }) + "\n"); }
function check(host, port, how) {
  if (ROUTES.has(`${host}:${port}`)) return;
  if (!loopback(host) || DENY.has(Number(port))) {
    record(`${how} ${host}:${port}`);
    throw Object.assign(new Error(`test network guard: ${how} to ${host}:${port} refused`), { code: "ECONNREFUSED" });
  }
}
function target(args) {
  const a = args[0];
  if (typeof a === "number") return { port: a, host: typeof args[1] === "string" ? args[1] : "localhost" };
  if (a && typeof a === "object") return { port: a.port, host: a.host ?? a.hostname ?? "localhost", path: a.path };
  return { port: undefined, host: "localhost" };
}
for (const [mod, name] of [[net, "connect"], [net, "createConnection"], [tls, "connect"]]) {
  const orig = mod[name];
  mod[name] = function (...args) {
    const t = target(args);
    const to = t.port !== undefined ? routed(t.host, t.port) : null;
    if (to) {
      // rewrite only the explicitly mapped public address; everything else is checked as-is
      if (typeof args[0] === "object" && args[0]) args[0] = { ...args[0], host: to.host, port: to.port, servername: undefined };
      else args = [to.port, to.host, ...args.slice(2).filter((x) => typeof x !== "string" && typeof x !== "number")];
    } else if (t.path === undefined || t.port !== undefined) check(t.host, t.port, `${name}`);
    return orig.apply(this, args);
  };
}
const origFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  check(u.hostname.replace(/^\[|\]$/g, ""), Number(u.port || (u.protocol === "https:" ? 443 : 80)), "fetch");
  return origFetch(input, init);
};
for (const mod of [http, https]) for (const name of ["request", "get"]) {
  const orig = mod[name];
  mod[name] = function (...args) {
    let host, port;
    if (typeof args[0] === "string" || args[0] instanceof URL) { const u = new URL(String(args[0])); host = u.hostname; port = u.port; }
    else { host = args[0]?.host ?? args[0]?.hostname; port = args[0]?.port; }
    check(String(host ?? "localhost").replace(/^\[|\]$/g, ""), Number(port || (mod === https ? 443 : 80)), `${mod === https ? "https" : "http"}.${name}`);
    return orig.apply(this, args);
  };
}
// named imports of node:net/tls/http/https (import {connect} from "node:tls") see the patched functions too
syncBuiltinESMExports();
