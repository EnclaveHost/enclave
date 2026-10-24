// READ-ONLY JSON-RPC to two public Base providers. There is no send, sign, personal_* or wallet path here: a method
// outside READ is refused before any request is made, so this process cannot submit anything. Every request has a
// bounded timeout and at most one retry; callers additionally bound the whole operation (withDeadline).
const READ = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_getBalance", "eth_getTransactionCount",
  "eth_call", "eth_estimateGas", "eth_maxPriorityFeePerGas", "eth_getTransactionByHash", "eth_getTransactionReceipt"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Production endpoints: https, no credentials/query/fragment. Tests may pass loopback http explicitly. */
export function checkUrl(u, { allowLoopback = false } = {}) {
  const url = new URL(u);
  if (url.username || url.password || url.search || url.hash) throw Error(`refused RPC ${url.host}: no credentials, query or fragment`);
  const loop = allowLoopback && url.protocol === "http:" && /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol !== "https:" && !loop) throw Error(`refused RPC ${url.host}: https only`);
  return url.href;
}

export function rpcClient(u, { timeoutMs, allowLoopback = false } = {}) {
  const url = checkUrl(u, { allowLoopback }), host = new URL(url).host;
  let id = 0;
  async function request(method, params = []) {
    if (!READ.has(method)) throw Error(`refused ${method}: this process only reads`);
    let last;
    for (let i = 0; i < 2; i++) {
      try {
        const requestId = ++id;
        const r = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }), signal: AbortSignal.timeout(timeoutMs) });
        const text = await r.text();
        let j; try { j = JSON.parse(text); } catch { throw Object.assign(Error(`${host}: non-JSON HTTP ${r.status}`), { retry: true }); }
        if (!r.ok) throw Object.assign(Error(`${host}: HTTP ${r.status}`), { retry: r.status === 429 || r.status >= 500 });
        if (!j || typeof j !== "object" || Array.isArray(j) || j.jsonrpc !== "2.0" || j.id !== requestId)
          throw Object.assign(Error(`${host} ${method}: invalid RPC response envelope`), { retry: true });
        if (j.error) {
          const m = String(j.error.message || "rpc error");
          if (r.status === 429 || /rate|limit|too many|busy|capacity/i.test(m)) throw Object.assign(Error(`${host}: ${m}`), { retry: true });
          throw Object.assign(Error(`${host} ${method}: ${m}`), { rpcError: j.error });
        }
        if (!("result" in j)) throw Object.assign(Error(`${host} ${method}: no result`), { retry: true });
        return j.result;
      } catch (e) {
        last = e;
        const transient = e.retry || e.name === "TimeoutError" || e.name === "AbortError" || /fetch failed|ECONN|socket/i.test(String(e.message));
        if (!transient || i === 1) break;
        await sleep(500);
      }
    }
    if (last?.name === "TimeoutError" || last?.name === "AbortError") throw Error(`${host} ${method}: no answer within ${timeoutMs} ms`);
    throw last;
  }
  return { url, host, request };
}

/** Exactly two clients on two different hosts. */
export function pair(clients) {
  if (clients.length !== 2) throw Error("requires two independently operated providers");
  if (clients[0].host === clients[1].host || new URL(clients[0].url).hostname === new URL(clients[1].url).hostname) throw Error("duplicate RPC host");
  return clients;
}

export function clientsFor(urls, { timeoutMs, allowLoopback = false }) {
  return pair(urls.map((u) => rpcClient(u, { timeoutMs, allowLoopback })));
}

/** Rejects when `ms` elapses first; the work's own requests are bounded by their per-request timeouts. */
export async function withDeadline(ms, what, work) {
  let t;
  const limit = new Promise((_, reject) => { t = setTimeout(() => reject(Error(`${what} did not finish within ${ms / 1000} s`)), ms); });
  try { return await Promise.race([work(), limit]); } finally { clearTimeout(t); }
}
