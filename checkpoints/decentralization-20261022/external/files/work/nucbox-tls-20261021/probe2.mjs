// READ-ONLY, bounded probe 2 (GET + eth_call + TLS handshakes; 20 s each; no keys, no writes):
//   A. the public route map https://api.enclave.host/v1/network/routes: the nucbox labels and any `pending` reasons
//   B. the nucbox deployments' public ledger rows on Base (two RPCs): runner, leaseUntil vs now, active
//   C. the host's registry endpoint (api.enclave.host/t/nucbox-k11-4) status
//   D. what each of the four fronts presents for SNI 59f1273d.app.enclave.host (what a stale-cached browser reaches)
import fs from "node:fs";
import tls from "node:tls";
import { createPublicClient, http } from "../enclave/node_modules/viem/_esm/index.js";
import { base } from "../enclave/node_modules/viem/_esm/chains/index.js";
const { ENROLLMENT } = await import("../lease-enrollment-signing/trust.mjs");

const IDS = { "59f1273d": "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c",
  "d9798e4c": "0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a",
  "7ae476a3": "0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33",
  "9eb4e600-control": null };
const FRONTS = ["134.209.248.172", "146.190.246.39", "165.245.191.129", "134.199.235.187"];
const out = { at: new Date().toISOString() };
const get = async (url) => { const t0 = Date.now(); try { const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "enclave-tls-diagnosis/2" } });
  const b = await r.text(); return { status: r.status, body: b.slice(0, 400000), seconds: (Date.now() - t0) / 1000 }; } catch (e) { return { error: `${e.name}: ${e.message}` }; } };

// A
const rm = await get("https://api.enclave.host/v1/network/routes");
if (rm.body) {
  try {
    const j = JSON.parse(rm.body), now = Date.now();
    out.routeMap = { status: rm.status, updatedAt: j.updatedAt, labels: Object.keys(j.labels || {}).length, deployments: Object.keys(j.deployments || {}).length,
      nucbox: Object.fromEntries(Object.keys(IDS).filter((k) => !k.includes("control")).map((k) => [k, j.labels?.[k] ? { ...j.labels[k], expiresInS: Math.round((j.labels[k].expiresAt - now) / 1000) } : null])),
      control9eb4e600: j.labels?.["9eb4e600"] ? { addresses: j.labels["9eb4e600"].addresses, expiresInS: Math.round((j.labels["9eb4e600"].expiresAt - now) / 1000) } : null,
      pending: (j.pending || []).map((p) => ({ id: p.id.slice(0, 10), reason: p.reason })),
      allLabels: Object.keys(j.labels || {}) };
  } catch (e) { out.routeMap = { status: rm.status, parseError: e.message, sample: rm.body.slice(0, 300) }; }
} else out.routeMap = rm;

// B
const abi = JSON.parse(fs.readFileSync(new URL("../enclave/contracts/EnclaveDeployments.abi.json", import.meta.url), "utf8"));
out.ledger = {};
for (const url of ["https://mainnet.base.org", "https://base-rpc.publicnode.com"]) {
  try {
    const c = createPublicClient({ chain: base, transport: http(url, { timeout: 20_000 }) });
    const bn = await c.getBlockNumber() - 2n, blk = await c.getBlock({ blockNumber: bn });
    for (const [k, id] of Object.entries(IDS)) if (id) {
      const d = await c.readContract({ address: ENROLLMENT.ledger, abi, functionName: "get", args: [id], blockNumber: bn });
      (out.ledger[k] ??= []).push({ rpc: url, block: String(bn), blockTime: new Date(Number(blk.timestamp) * 1000).toISOString(), active: d.active, runner: d.runner,
        leaseUntil: new Date(Number(d.leaseUntil) * 1000).toISOString(), leaseLeftS: Number(d.leaseUntil) - Number(blk.timestamp) });
    }
  } catch (e) { out.ledger[url] = String(e.shortMessage || e.message).slice(0, 300); }
}

// C
const reg = await get("https://api.enclave.host/t/nucbox-k11-4");
out.registryEndpoint = { status: reg.status, error: reg.error, sample: reg.body?.slice(0, 600) };

// D
const hs = (ip, sni) => new Promise((ok) => {
  const t0 = Date.now(), s = tls.connect({ host: ip, port: 443, servername: sni, rejectUnauthorized: false, ALPNProtocols: ["h2", "http/1.1"], timeout: 20_000 }, () => {
    const c = s.getPeerCertificate();
    ok({ ip, sni, authorized: s.authorized, authError: s.authorizationError || null, alpn: s.alpnProtocol, subject: c?.subject?.CN, san: c?.subjectaltname, issuer: c?.issuer?.O + " / " + c?.issuer?.CN,
         validFrom: c?.valid_from, validTo: c?.valid_to, fingerprint256: c?.fingerprint256, seconds: (Date.now() - t0) / 1000 }); s.end(); });
  s.on("error", (e) => ok({ ip, sni, error: `${e.code || e.name}: ${e.message}`, seconds: (Date.now() - t0) / 1000 }));
  s.on("timeout", () => { s.destroy(); ok({ ip, sni, error: "timeout" }); });
});
out.fronts = [];
for (const ip of FRONTS) {
  out.fronts.push(await hs(ip, "59f1273d.app.enclave.host"));
  out.fronts.push(await hs(ip, "9eb4e600.app.enclave.host"));
}
fs.writeFileSync(new URL("./probe2.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, routeMap: out.routeMap && { ...out.routeMap, allLabels: undefined } }, null, 1));
