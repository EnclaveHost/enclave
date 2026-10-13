// host-ui/fake-node.mjs -- an in-memory node answering the local hosting API (README.md), for the panel's tests and for
// working on the panel with no node at hand. It keeps the contract's rules that the panel depends on: caps snapped to 5%,
// 409 would_drop until the owner names every deployment a change would stop (newest first), prices and the payout wallet
// checked as the nodes check them. kind "phone" answers as the phone's agent does (one CPU & RAM share, no GPU).
const ZERO = /^0x0{40}$/;
const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !ZERO.test(a);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

export function createFakeNode({ kind = "pc", token = null, now = () => Date.now() } = {}) {
  const phone = kind === "phone";
  const s = {
    caps: { cpuShare: 0.5, gpuShare: phone ? 0 : 0.25, paused: false },
    apps: [
      { id: "0xa69dcbba" + "1".repeat(56), appRef: "enclave-apps/cron@1.0.2", cpuShare: 0.1, gpuShare: 0, phase: "serving", at: 1 },
      { id: "0x77e75476" + "2".repeat(56), appRef: "enclave-apps/api-mcp-adapter@0.4.1", cpuShare: 0.2, gpuShare: 0, phase: "serving", at: 2 },
    ],
    pricing: { cpuPerHour: null, gpuPerHour: null },
    market: { taking: true, why: "listed on enclave.host" },
    gas: { operator: "0x389c" + "0".repeat(32) + "a11c", low: false, hoursLeft: 412, renewalsLeft: 3100 },
    wallet: null, earned6: 1234567n, paidOut6: 0n, history: [], paying: false, lastError: null,
    failPayout: null, unreachable: false, delayMs: 0, log: [],
  };
  const defaults = phone ? { cpu: { perHour: 0.0108, gb: 4, flops: 1.4, tier: "pvm-cpu", from: "" } }
                         : { cpu: { perHour: 0.0475, gb: 24, flops: 446.7, tier: "tee-cpu", from: "nucbox-k11-4" },
                             gpu: { perHour: 0.31, gb: 12, flops: 22.1, tier: "tee-gpu", from: "" } };
  const posted = (x) => Math.max(1, Math.round(x * 1e6 / 3600)) * 3600 / 1e6;   // whole micro-USDC a second
  const pricingView = () => {
    const out = {};
    for (const axis of ["cpu", "gpu"]) {
      const d = defaults[axis];
      if (!d) { out[axis] = null; continue; }
      const over = s.pricing[`${axis}PerHour`];
      out[axis] = { perHour: posted(over ?? d.perHour), tier: d.tier, gb: d.gb, flops: d.flops, override: over,
                    default: { perHour: d.perHour, from: d.from, unitPerHour: d.perHour / (d.gb * d.flops) } };
    }
    return out;
  };
  const use = () => s.apps.reduce((u, a) => ({ cpu: u.cpu + a.cpuShare, gpu: u.gpu + a.gpuShare }), { cpu: 0, gpu: 0 });
  const view = () => {
    const u = use();
    return {
      caps: { ...s.caps }, step: 0.05, capsError: null, pricing: pricingView(),
      sold: { cpuShare: r4(u.cpu), gpuShare: r4(u.gpu) }, inUse: { cpuShare: r4(u.cpu), gpuShare: r4(u.gpu) },
      free: { cpuShare: r4(Math.max(0, s.caps.cpuShare - u.cpu)), gpuShare: r4(Math.max(0, s.caps.gpuShare - u.gpu)) },
      reservedShare: phone ? 0 : 0.25, deploymentsServed: s.apps.length, waitingForCap: 0, backend: phone ? "pvm" : "hv",
      gpu: phone ? { consumer: false, why: "a protected VM cannot reach the phone's GPU" } : { consumer: true, why: "partitions on the isolated backend hold 0% of the GPU" },
      appsEnabled: true, market: s.caps.paused ? { taking: false, why: "hosting is off" } : { ...s.market }, gas: { ...s.gas },
      logsDir: phone ? null : "C:\\ProgramData\\Enclave\\node",
      device: phone ? { kind: "phone", noun: "phone" } : { kind: "pc", noun: "PC" },
      ...(phone ? { axes: ["cpu"], cpuLabel: "CPU & RAM" } : {}),
      apps: s.apps.map((a) => ({ id: a.id, appRef: a.appRef, phase: a.phase })),
    };
  };
  /** What the caps would stop: newest first, until what stays fits (everything, when paused). */
  const dropPlan = (next) => {
    const newest = [...s.apps].sort((a, b) => b.at - a.at), plan = [];
    let u = use();
    for (const a of newest) {
      if (!next.paused && u.cpu <= next.cpuShare + 1e-9 && u.gpu <= next.gpuShare + 1e-9) break;
      plan.push({ id: a.id, appRef: a.appRef, cpuShare: a.cpuShare, gpuShare: a.gpuShare });
      u = { cpu: u.cpu - a.cpuShare, gpu: u.gpu - a.gpuShare };
    }
    return plan;
  };
  const earnings = () => {
    const operator = s.gas.operator;
    const payTo = s.wallet && s.wallet.toLowerCase() !== operator.toLowerCase() ? s.wallet : null;
    return { enclaveId: "0x" + "e".repeat(64), wallet: s.wallet, setAt: null, minPayout6: "1000000", paidOut6: String(s.paidOut6),
             history: [...s.history].reverse().slice(0, 10), paying: s.paying, lastError: s.lastError, readable: true, operator,
             earned6: String(s.earned6), gasWei: "800000000000000", payTo, why: payTo ? null : s.wallet ? "the payout wallet is this machine's own operator key" : "no payout wallet is set" };
  };

  async function route(method, p, body) {
    const bad = (m, code = "bad_request") => [400, { error: code, message: m }];
    if (p === "/v1/local/hosting") {
      if (method === "GET") return [200, view()];
      if (method !== "PUT") return [405, { error: "method_not_allowed" }];
      const extra = Object.keys(body || {}).filter((k) => !["cpuShare", "gpuShare", "paused", "drop"].includes(k));
      if (extra.length) return bad(`unknown field ${extra[0]}`);
      if (phone && "gpuShare" in body && body.gpuShare !== 0) return bad("this phone offers no GPU");
      const next = { ...s.caps };
      for (const k of ["cpuShare", "gpuShare"]) {
        if (!(k in body)) continue;
        const v = body[k];
        if (typeof v !== "number" || !(v >= 0 && v <= 1)) return bad(`${k} must be a number from 0 to 1`);
        next[k] = Math.round(v * 20) / 20;
      }
      if ("paused" in body) { if (typeof body.paused !== "boolean") return bad("paused must be true or false"); next.paused = body.paused; }
      const ack = new Set((Array.isArray(body.drop) ? body.drop : []).map((x) => String(x).toLowerCase()));
      const plan = dropPlan(next);
      if (plan.some((u) => !ack.has(u.id.toLowerCase())))
        return [409, { error: "would_drop", drop: plan, message: `these caps leave no room for ${plan.length} running deployment(s); nothing was changed` }];
      s.apps = s.apps.filter((a) => !plan.some((u) => u.id === a.id));
      s.caps = next;
      s.log.push({ put: body });
      return [200, { ...view(), dropped: plan }];
    }
    if (p === "/v1/local/hosting/price") {
      if (method !== "PUT") return [405, { error: "method_not_allowed" }];
      for (const k of Object.keys(body || {})) {
        if (!["cpuPerHour", "gpuPerHour"].includes(k)) return [400, { error: "bad_price", message: `unknown field ${k}` }];
        const v = body[k];
        if (v !== null && (typeof v !== "number" || !(v > 0 && v <= 1000))) return [400, { error: "bad_price", message: `${k} is a price in USDC per hour, above 0 and at most 1000, or null` }];
        s.pricing[k] = v;
      }
      return [200, view()];
    }
    if (p === "/v1/local/hosting/earnings" && method === "GET") return [200, earnings()];
    if (p === "/v1/local/hosting/payout-wallet" && method === "PUT") {
      const a = String(body?.address ?? "").trim();
      if (!isAddress(a)) return [400, { error: "bad_address", message: "that is not a wallet address: it is 0x followed by 40 hexadecimal characters (0-9, a-f)" }];
      s.wallet = a;
      return [200, earnings()];
    }
    if (p === "/v1/local/hosting/payout" && method === "POST") {
      const e = earnings();
      if (!e.payTo) return [409, { error: "not_paid", paid: false, message: e.why }];
      if (s.failPayout) return [409, { error: "not_paid", paid: false, message: s.failPayout }];
      if (s.earned6 === 0n) return [409, { error: "not_paid", paid: false, message: "$0.00 earned" }];
      if (phone) { s.paying = true; return [202, { paid: false, pending: true, message: `Paying out $${(Number(s.earned6) / 1e6).toFixed(2)} to ${e.payTo.slice(0, 8)}\u2026${e.payTo.slice(-4)}: the transaction goes out within a minute.` }]; }
      const tx = "0x" + (s.history.length + 1).toString(16).padStart(64, "f");
      s.history.push({ tx, to: e.payTo, amount6: String(s.earned6), at: new Date(now()).toISOString() });
      s.paidOut6 += s.earned6; s.earned6 = 0n;
      return [200, { paid: true, tx, amount6: s.history.at(-1).amount6, to: e.payTo }];
    }
    return [404, { error: "not_found" }];
  }

  /** (method, path, body) -> { status, body }; status 0 while `unreachable` is set (the node is down). */
  async function request(method, p, body) {
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    if (s.unreachable) return { status: 0, message: typeof s.unreachable === "string" ? s.unreachable : "the node is not answering on 127.0.0.1:9610" };
    const [status, b] = await route(method, String(p).split("?")[0], body ?? {});
    return { status, body: b };
  }
  /** The same over HTTP, with the token checked when one is set: for dev-server.mjs. */
  function handler(req, res) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const send = (status, o) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
      if (token && req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
      let body;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; } catch { return send(400, { error: "bad_request", message: "the body is not JSON" }); }
      const r = await request(req.method, req.url, body);
      if (!r.status) { res.socket.destroy(); return; }
      send(r.status, r.body);
    });
  }
  return { state: s, request, handler, view, earnings };
}
