// READ-ONLY: the eu-central relay's PUBLIC identity and the payee's public chain state.
//   - GET https://134.209.248.172/v1/info with Node's default TLS verification (the endpoint's IP certificate);
//   - its signed statement verified with main's verifyRelayStatement against the expected payee and the reviewed
//     deployment record's chain/reserve/executor (work/eu-relay-user-target/config/lease-gas-deployment.json, 1665c218);
//   - the payee's balance and latest/pending nonce from three public Base RPCs (a 2-of-3 agreement is required).
// Prints one JSON line. Sends nothing but GETs and eth_ reads.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url)), WORK = path.resolve(HERE, "../..");
const imp = (p) => import(pathToFileURL(path.join(WORK, "enclave", p)).href);
const { verifyRelayStatement } = await imp("client/lease-executor-client.mjs");
const PAYEE = "0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a", ORIGIN = "https://134.209.248.172";
const recBytes = fs.readFileSync(path.join(WORK, "eu-relay-user-target/config/lease-gas-deployment.json"));
const rec = JSON.parse(recBytes);
const out = { at: new Date().toISOString(), origin: ORIGIN, recordSha256: createHash("sha256").update(recBytes).digest("hex") };
const lc = (s) => String(s || "").toLowerCase();
try {
  const r = await fetch(`${ORIGIN}/v1/info`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  out.tlsVerified = true; out.httpStatus = r.status;
  const info = await r.json();
  out.payee = info.payee;
  out.deploymentMatches = Number(info.chainId) === rec.chainId && lc(info.reserve) === lc(rec.reserve) && lc(info.executor) === lc(rec.executor);
  try { await verifyRelayStatement(info, { expectedPayee: PAYEE, pins: { chainId: rec.chainId, reserve: rec.reserve, executor: rec.executor } }); out.statementVerified = true; }
  catch (e) { out.statementVerified = false; out.statementError = e.message; }
} catch (e) { out.tlsVerified = /certificate|TLS|SSL/i.test(String(e.cause?.code || e.cause?.message || e.message)) ? false : null; out.error = `${e.message} ${e.cause?.code || ""}`.trim(); }
const rpcs = ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base-mainnet.public.blastapi.io"];
const call = async (url, method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
};
const per = await Promise.all(rpcs.map(async (u) => {
  try { const [latest, pending, bal, block] = await Promise.all([call(u, "eth_getTransactionCount", [PAYEE, "latest"]), call(u, "eth_getTransactionCount", [PAYEE, "pending"]), call(u, "eth_getBalance", [PAYEE, "latest"]), call(u, "eth_blockNumber", [])]);
        return { rpc: new URL(u).host, latest: Number(BigInt(latest)), pending: Number(BigInt(pending)), balanceWei: BigInt(bal).toString(), block: Number(BigInt(block)) }; }
  catch (e) { return { rpc: new URL(u).host, error: String(e.message).slice(0, 120) }; }
}));
const ok = per.filter((p) => !p.error);
const counts = {}; for (const p of ok) counts[p.latest] = (counts[p.latest] || 0) + 1;
const [nonce, votes] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [null, 0];
out.chain = { perRpc: per, agreed: votes >= 2, agreedLatestNonce: votes >= 2 ? Number(nonce) : null,
  pendingEqualsLatest: votes >= 2 ? ok.filter((p) => String(p.latest) === nonce).every((p) => p.pending === p.latest) : null,
  balanceEth: ok.length ? Number(BigInt(ok[0].balanceWei)) / 1e18 : null };
console.log(JSON.stringify(out));
