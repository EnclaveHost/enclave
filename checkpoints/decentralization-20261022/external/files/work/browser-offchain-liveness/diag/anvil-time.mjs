// Does anvil --timestamp <past> keep later automined blocks in the past, and can evm_setNextBlockTimestamp jump to now?
import { spawn } from "node:child_process";
import net from "node:net";
const port = await new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const now = Math.floor(Date.now() / 1000), url = "http://127.0.0.1:" + port;
const a = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--silent", "--timestamp", String(now - 7200)], { stdio: "ignore" });
const rpc = async (method, params = []) => { const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
try {
  for (let i = 0; i < 100; i++){ try { await rpc("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const ts = async () => Number((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  console.log("genesis offset", (await ts()) - now);
  await rpc("evm_mine"); await new Promise((r) => setTimeout(r, 1500)); await rpc("evm_mine");
  console.log("after 2 mines offset", (await ts()) - now);
  await rpc("evm_setNextBlockTimestamp", [now + 5]); await rpc("evm_mine");
  console.log("after jump offset", (await ts()) - now);
  await new Promise((r) => setTimeout(r, 1500)); await rpc("evm_mine");
  console.log("after jump + 1.5s mine offset", (await ts()) - now);
} finally { a.kill("SIGKILL"); }
