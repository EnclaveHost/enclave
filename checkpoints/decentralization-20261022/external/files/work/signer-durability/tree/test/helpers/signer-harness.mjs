// Shared fixtures for the external-signer concurrency and durability tests: anvil chains, JSON-RPC wallet fixtures,
// a pending-nonce gate, and child processes running signer-child.mjs. Only anvil's published development keys are used;
// nothing talks to a network beyond 127.0.0.1.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

export const KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";   // anvil dev account 0 (published)
export const A0 = privateKeyToAccount(KEY0);
export const SINK = "0x000000000000000000000000000000000000c0de";                            // code 0x00: any call succeeds
export const WAIT = { timeoutMs: 15000, pollMs: 50 };
export const HANG = Symbol("hang");
export const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "signer-child.mjs");
export const tools = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return null; } catch { return "needs Foundry's anvil"; } })();

const procs = [], servers = [], kids = [];
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
export async function anvil() {
  const port = await freePort();
  procs.push(spawn("anvil", ["--port", String(port), "--chain-id", "31337", "--silent", "--base-fee", "5000000"], { stdio: "ignore" }));
  const url = `http://127.0.0.1:${port}`, c = createPublicClient({ chain: foundry, transport: viemHttp(url) });
  for (let i = 0; i < 100; i++) { try { await c.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  return { url, c };
}
export const call = async (url, method, params = []) => {
  const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  return "error" in j ? { error: j.error } : { result: j.result };
};
/** A JSON-RPC wallet fixture: handler(msg) -> {result} | {error} | HANG. Records every method asked. */
export async function walletServer(handler) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    const m = JSON.parse(b); calls.push(m);
    const r = await handler(m);
    if (r === HANG) return;
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...r }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  return { url: `http://127.0.0.1:${srv.address().port}/rpc?token=SECRET-TOKEN`, calls, count: (method) => calls.filter((c) => c.method === method).length };
}
export const forward = (url) => (m) => call(url, m.method, m.params);
/** A sign-only wallet answering from a dev key in this process (eth_signTransaction, as anvil answers it); no node of its own. */
export const keyWallet = (account = A0) => async (m) => {
  if (m.method === "eth_accounts" || m.method === "eth_requestAccounts") return { result: [account.address] };
  if (m.method === "eth_chainId") return { result: "0x7a69" };
  if (m.method !== "eth_signTransaction") return { error: { code: -32601, message: `the method ${m.method} does not exist/is not available` } };
  const p = m.params[0];
  return { result: await account.signTransaction({ type: "eip1559", chainId: Number(p.chainId), nonce: Number(p.nonce), to: p.to, value: BigInt(p.value),
    data: p.data, gas: BigInt(p.gas), maxFeePerGas: BigInt(p.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas), accessList: [] }) };
};
/** The same chain, with hook() awaited before every pending-nonce read (the first thing a send asks the chain). */
export function gatedChain(chain, hook) {
  const g = Object.create(chain);
  g.each = async (fn, what) => { if (what === "pending nonce") await hook(); return chain.each(fn, what); };
  return g;
}
export async function until(pred, ms = 15000, what = "condition") {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 5)); }
}
/** signer-child.mjs in its own process. */
export function child(cfg) {
  const p = spawn(process.execPath, [CHILD, JSON.stringify(cfg)], { stdio: ["pipe", "pipe", "pipe"] });
  kids.push(p);
  const lines = [];
  let err = "";
  readline.createInterface({ input: p.stdout }).on("line", (l) => lines.push(l));
  p.stderr.on("data", (d) => (err += d));
  const exited = new Promise((r) => p.on("exit", (code, signal) => r({ code, signal })));
  const has = (prefix) => lines.some((l) => l === prefix || l.startsWith(prefix + " "));
  return { p, lines, exited, has, stderr: () => err,
    send: (l) => p.stdin.write(l + "\n"),
    wait: (prefix, ms) => until(() => has(prefix), ms, `${prefix} from child ${p.pid} (lines ${JSON.stringify(lines)}; stderr ${err.slice(0, 400)})`),
    result: () => { const l = lines.find((x) => x.startsWith("RESULT ")); return l ? JSON.parse(l.slice(7)) : null; },
    kill: async () => { p.kill("SIGKILL"); return exited; } };
}
export function tmpRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
export function cleanup(tmp) {
  for (const k of kids) { try { k.kill("SIGKILL"); } catch {} }
  for (const s of servers) { s.closeAllConnections(); s.close(); }
  for (const p of procs) p.kill("SIGKILL");
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}
