// test/helpers/lying-peers.mjs: JSON-RPC proxies in front of one anvil, each able to lie, for quorum tests
// (test/direct-chain-quorum-supervisor.test.mjs, test/direct-chain-transport.test.mjs). Per proxy, `ctl`:
//   lies:   [{to?, sel?}]  eth_call answers to that target/selector come back changed (the last nibble of the FIRST word:
//                          a bool or number changes; a dynamic tuple's offset breaks its decoding)
//   nonce:  true           eth_getTransactionCount "pending" answers one more than the chain says
//   code:   true           eth_getCode answers the code with a byte appended
//   logs:   true           eth_getLogs answers drop their last log
//   send:   "ok" | "lost" | "refuse"   eth_sendRawTransaction: forwarded; "lost" forwards and then answers 502;
//                          "refuse" never forwards and answers a definite refusal (insufficient funds)
//   calls:  [{method, to, sel, params}]  every request this proxy saw
import http from "node:http";
import { toHex } from "viem";

export async function startLyingPeers(upstream, { n = 3, stops = [] } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ctl = { lies: [], nonce: false, code: false, logs: false, send: "ok", calls: [] };
    const srv = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString(), q = JSON.parse(raw), qs = [q].flat();
      for (const m of qs) { const p0 = m.params?.[0] || {}; ctl.calls.push({ method: m.method, to: String(p0.to || "").toLowerCase() || null, sel: String(p0.data || p0.input || "").slice(0, 10).toLowerCase() || null, params: m.params }); }
      if (qs.some((m) => m.method === "eth_sendRawTransaction")) {
        if (ctl.send === "refuse") {
          const refused = (m) => ({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "insufficient funds for gas * price + value" } });
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify(Array.isArray(q) ? qs.map(refused) : refused(q)));
        }
        if (ctl.send === "lost") { await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: raw }); res.writeHead(502); return res.end(); }
      }
      const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
      const answers = [await r.json()].flat();
      answers.forEach((j, k) => {
        const m = qs[k], p0 = m.params?.[0] || {};
        if (m.method === "eth_call") {
          const to = String(p0.to || "").toLowerCase(), s4 = String(p0.data || p0.input || "").slice(0, 10).toLowerCase();
          const lie = ctl.lies.find((l) => (!l.to || l.to === to) && (!l.sel || l.sel === s4));
          if (lie && typeof j.result === "string" && j.result.length >= 66) j.result = j.result.slice(0, 65) + (j.result[65] === "0" ? "1" : "0") + j.result.slice(66);
        }
        if (ctl.nonce && m.method === "eth_getTransactionCount" && m.params?.[1] === "pending" && typeof j.result === "string") j.result = toHex(BigInt(j.result) + 1n);
        if (ctl.code && m.method === "eth_getCode" && typeof j.result === "string") j.result = j.result + "00";
        if (ctl.logs && m.method === "eth_getLogs" && Array.isArray(j.result) && j.result.length) j.result = j.result.slice(0, -1);
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(q) ? answers : answers[0]));
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    stops.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); }));
    out.push({ url: `http://127.0.0.1:${srv.address().port}`, ctl });
  }
  out.honest = () => { for (const p of out) Object.assign(p.ctl, { lies: [], nonce: false, code: false, logs: false, send: "ok", calls: [] }); };
  return out;
}
