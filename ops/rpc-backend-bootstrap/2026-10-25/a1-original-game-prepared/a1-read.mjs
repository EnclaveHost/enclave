#!/usr/bin/env node
// A1 live READ-ONLY runner for root (never run by this stage). Usage:
//   ANCHOR_DEPS_ROOT=<checkout> node a1-read.mjs CONFIG.json > a1-evidence.json
// CONFIG: { heliosUrl, elUrl, portal, asr, portalAsrGetter, expectedChainId: 1, pinBy?, proofSlots?, asrCandidates? }
// heliosUrl = the l1-authority Helios loopback listener (the VERIFIER); elUrl = our own reth (an UNTRUSTED proof source).
// Both must be http://<loopback literal>:<port>: no public RPC, no names, no credentials. JSON-RPC POST only (reads).
import fs from "node:fs";
import { keccak_256 } from "./test/deps.mjs";
import { headerHash } from "./vendor/anchor-bootstrap.mjs";
import { runA1, A1Error } from "./a1-anchor.mjs";

export function loopbackUrl(u, what) {
  let x; try { x = new URL(u); } catch { throw new A1Error("bad_config", `${what} is not a URL`); }
  const host = x.hostname.replace(/^\[|\]$/g, "");
  if (x.protocol !== "http:" || x.username || x.password || x.search || x.hash || !(host === "127.0.0.1" || host === "::1") || !x.port)
    throw new A1Error("bad_config", `${what} must be http://127.0.0.1:<port> or http://[::1]:<port>`);
  return x.href;
}
export function rpc(url, { timeoutMs = 20000, maxBytes = 8 << 20 } = {}) {
  let id = 0;
  return async (method, params) => {
    const rid = ++id;
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) { try { await r.body?.cancel(); } catch {} throw new Error(`HTTP ${r.status}`); }
    const declared = Number(r.headers.get("content-length"));
    if (declared > maxBytes) { try { await r.body?.cancel(); } catch {} throw new Error("reply too large (declared)"); }
    // stream the body and refuse as soon as the BYTE count passes maxBytes: nothing beyond the cap is buffered
    const reader = r.body.getReader(), chunks = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBytes) { try { await reader.cancel(); } catch {} throw new Error("reply too large"); }
      chunks.push(value);
    }
    const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (j.jsonrpc !== "2.0" || j.id !== rid || ("result" in j) === ("error" in j)) throw new Error("bad JSON-RPC envelope");
    if (j.error) throw new Error(`${j.error.code}: ${j.error.message}`);
    return j.result;
  };
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  try {
    const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const io = { helios: rpc(loopbackUrl(cfg.heliosUrl, "heliosUrl")), el: rpc(loopbackUrl(cfg.elUrl, "elUrl")) };
    const out = await runA1(cfg, io, { keccak: (b) => keccak_256(b), headerHash, now: () => Date.now() });
    process.stdout.write(JSON.stringify({ ...out, at: new Date().toISOString(), label: "A1 read: Helios-light-client-relative; not SNP/attested" }, (k, v) => typeof v === "bigint" ? v.toString() : v, 1) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ verdict: "refused", code: e.code || "error", message: String(e.message || e).slice(0, 300) }) + "\n");
    process.exitCode = 3;
  }
}
