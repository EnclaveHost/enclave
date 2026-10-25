#!/usr/bin/env node
// Independent MCP entrypoints (docs/network/independent-mcp.md). The same tools as https://mcp.enclave.host
// (relay/mcp.js createTools), over the independent backend (mcp/independent.mjs): no Enclave gateway, API or IPFS
// service is ever contacted, and the hosted endpoint does not need to exist.
//
//   node mcp/server.mjs --config FILE [--profile NAME]                      stdio (one profile; the default transport)
//   node mcp/server.mjs --config FILE [--profile NAME] --listen 127.0.0.1:P  Streamable HTTP, loopback only
//   node mcp/server.mjs --config FILE --remote --listen HOST:PORT           remote adapter: every configured profile at /p/NAME
//
// The profile (its pins or reviewed profile + digest, RPC quorum, directories, storage plan) is operator configuration
// read at start; no tool argument can name another profile, path or digest. Each profile has its own authority and
// each tools/call its own agreed snapshot: nothing one request reads is visible to another.
import http from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createTools, dispatchIn, SERVER_INFO, rpcError } from "../relay/mcp.js";
import { loadConfig, Authority, independentBackend } from "./independent.mjs";
import { independentExtras } from "./independent-tools.mjs";

export const INDEPENDENT_INSTRUCTIONS = `Enclave runs apps inside hardware TEE enclaves, paid per second in USDC on Base. This is the INDEPENDENT server: every answer comes from the operator's reviewed contract authorities (the admin AddressBook and original contracts) read through an agreeing RPC quorum at one confirmed block, from hosts' own signed records and from the operator's storage adapters - never from an Enclave gateway, API or IPFS service, and never from a first-answering RPC. Trust model: no tool ever sees a private key. State changes return UNSIGNED Base (chainId 8453) transactions for the user's own wallet; with session:{vault, sid} builders return session calls the client signs with its own P-256 key, and session_execute turns them into transactions any gas payer can send (no relay). Owner-scoped host requests (logs, restart, live status, attestation) are signed per request by that session key in two steps. Uploads are signed per storage adapter and go straight to the adapters. Every builder's answer carries the agreed block and was re-checked against a fresh block before it was returned. Start with the guide tool (topic "getting-started").`;
const INFO = { ...SERVER_INFO, title: "Enclave (independent)" };

/** One profile's MCP server: { tools, dispatch(msg) } ; deps (tests): { clients } */
export function createIndependentServer(profileCfg, deps = {}, { remote = false } = {}) {
  const authority = new Authority(profileCfg, deps);
  const backend = independentBackend(authority, independentExtras({ remote }));
  const set = createTools(backend);
  return { name: profileCfg.name, authority, backend, tools: set.tools,
    dispatch: (msg) => dispatchIn(set, backend, msg, { token: null }, { serverInfo: INFO, instructions: INDEPENDENT_INSTRUCTIONS }) };
}

async function handle(server, body) {
  if (Array.isArray(body)) return (await Promise.all(body.map((m) => server.dispatch(m)))).filter(Boolean);
  return server.dispatch(body);
}

/** Streamable HTTP (stateless JSON mode, as the hosted endpoint): POST JSON-RPC; GET is informational or 405 for SSE. */
export function httpHandler(route) {
  const buckets = new Map();
  const allow = (key) => {
    const now = Date.now(); let b = buckets.get(key);
    if (!b) { b = { t: 120, at: now }; buckets.set(key, b); }
    if (buckets.size > 10000) for (const [k, v] of buckets) if (now - v.at > 300000) buckets.delete(k);
    b.t = Math.min(120, b.t + ((now - b.at) / 1000) * 10); b.at = now;
    if (b.t < 1) return false; b.t -= 1; return true;
  };
  return async (req, res) => {
    const send = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
    const server = route(new URL(req.url, "http://x").pathname);
    if (!server) return send(404, { error: "no such profile" });
    if (req.method === "GET") {
      if (/text\/event-stream/.test(req.headers.accept || "")) { res.writeHead(405, { allow: "POST" }); return res.end(); }
      return send(200, { name: INFO.name, title: INFO.title, profile: server.name, protocol: "Model Context Protocol (Streamable HTTP)", tools: server.tools.length });
    }
    if (req.method === "DELETE") { res.writeHead(405, { allow: "POST" }); return res.end(); }
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); }
    if (!allow(req.socket.remoteAddress || "")) return send(429, rpcError(null, -32000, "rate limited; retry shortly"));
    const chunks = []; let n = 0;
    try { for await (const c of req) { n += c.length; if (n > 1048576) throw new Error("body too large"); chunks.push(c); } }
    catch (e) { return send(413, rpcError(null, -32700, e.message)); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString() || ""); } catch (e) { return send(400, rpcError(null, -32700, "Parse error: " + e.message)); }
    const out = await handle(server, body);
    if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
    return send(200, out);
  };
}

/** MCP stdio transport: one JSON-RPC message per line in, one per line out; diagnostics only on stderr. */
export function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let pending = 0, closed = false, done;
  const finished = new Promise((r) => { done = r; });
  const maybeDone = () => { if (closed && pending === 0) done(); };
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    pending++;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { output.write(JSON.stringify(rpcError(null, -32700, "Parse error: " + e.message)) + "\n"); pending--; return maybeDone(); }
    try { const out = await handle(server, msg); if (out && !(Array.isArray(out) && !out.length)) output.write(JSON.stringify(out) + "\n"); }
    catch (e) { output.write(JSON.stringify(rpcError(msg?.id, -32603, String(e?.message || e))) + "\n"); }
    pending--; maybeDone();
  });
  rl.on("close", () => { closed = true; maybeDone(); });
  return finished;
}

const LOOPBACK = (h) => h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);   // literal loopback only, never a name
function parseListen(v) {
  const m = /^(\[[0-9a-fA-F:]+\]|[^:]+):(\d{1,5})$/.exec(String(v || ""));
  if (!m) throw new Error("--listen HOST:PORT");
  return { host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const o = { remote: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--remote") o.remote = true;
    else if (["--config", "--profile", "--listen"].includes(a)) { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); o[a.slice(2)] = argv[++i]; }
    else throw new Error(`unknown argument ${a}\nusage: mcp/server.mjs --config FILE [--profile NAME] [--listen 127.0.0.1:PORT] | --config FILE --remote --listen HOST:PORT`);
  }
  if (!o.config) throw new Error("--config FILE is required (the operator's reviewed profiles; there is no default)");
  const cfg = loadConfig(o.config);
  if (o.remote) {
    if (!o.listen) throw new Error("--remote needs --listen HOST:PORT");
    if (o.profile) throw new Error("--remote serves every configured profile at /p/NAME; --profile selects one for stdio or loopback");
    const servers = new Map([...cfg.profiles.values()].map((p) => [p.name, createIndependentServer(p, deps, { remote: true })]));
    const { host, port } = parseListen(o.listen);
    const srv = http.createServer({ requestTimeout: 330000, headersTimeout: 15000 }, httpHandler((p) => {
      const m = /^\/p\/([a-z0-9-]{1,40})\/?$/.exec(p); return m ? servers.get(m[1]) || null : null; }));
    await new Promise((r) => srv.listen(port, host, r));
    process.stderr.write(`independent MCP remote adapter on ${host}:${srv.address().port}: ${[...servers.keys()].map((n) => `/p/${n}`).join(", ")}\n`);
    return srv;
  }
  const names = [...cfg.profiles.keys()];
  const name = o.profile || (names.length === 1 ? names[0] : null);
  if (!name || !cfg.profiles.has(name)) throw new Error(`--profile NAME: one of ${names.join(", ")}`);
  const server = createIndependentServer(cfg.profiles.get(name), deps);
  if (o.listen) {
    const { host, port } = parseListen(o.listen);
    if (!LOOPBACK(host)) throw new Error("--listen without --remote is loopback only (127.0.0.1 or [::1])");
    const srv = http.createServer({ requestTimeout: 330000, headersTimeout: 15000 }, httpHandler(() => server));
    await new Promise((r) => srv.listen(port, host, r));
    process.stderr.write(`independent MCP (profile ${name}) on http://${host}:${srv.address().port}/\n`);
    return srv;
  }
  process.stderr.write(`independent MCP (profile ${name}) on stdio\n`);
  return serveStdio(server);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => { process.stderr.write(`mcp/server: ${e.message}\n`); process.exit(1); });
