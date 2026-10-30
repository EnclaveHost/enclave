// helios_probe.mjs HELIOS_URL OUT (guest, in the SAME scope as Helios, as the A1 reader was; PREPARED, NOT run). Waits (<= 900 s)
// for Helios to report a finalized block, then issues A1's first verified call, anchorStateRegistry() on the portal, exactly as
// a1-anchor.mjs does ({blockHash: finalized}, 20 s abort = the reader's rpc() default) and records whether it times out; then the
// SAME call with a 240 s diagnostic bound (to measure Helios's real latency, NOT a capture), then at the "finalized" tag and
// "latest". Records Helios-side timings only; the proxy log has the EL requests Helios made for each. No writes elsewhere.
import fs from "node:fs";
const [H, OUT] = process.argv.slice(2);
const { keccak_256 } = await import(process.env.K);
const PORTAL = "0x49048044d57e1c92a77f79988d21fa8faf74e97e";
const SEL = "0x" + Buffer.from(keccak_256(new TextEncoder().encode("anchorStateRegistry()"))).toString("hex").slice(0, 8);
const steps = []; let id = 0; const T0 = performance.now();
async function rpc(label, method, params, timeoutMs) {
  const t0 = performance.now(); const s = { label, method, startMs: Math.round(t0 - T0) };
  try {
    const r = await fetch(H, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const j = JSON.parse(await r.text()); s.ms = Math.round(performance.now() - t0);
    if (j.error) s.error = JSON.stringify(j.error).slice(0, 300); else s.result = String(JSON.stringify(j.result)).slice(0, 200);
    steps.push(s); return j.result;
  } catch (e) { s.ms = Math.round(performance.now() - t0); s.error = String(e?.message || e).slice(0, 300); steps.push(s); return undefined; }
}
const out = { selector: SEL, startedAt: new Date().toISOString(), steps };
try {
  let fin;
  for (const end = performance.now() + 900000; performance.now() < end; await new Promise((r) => setTimeout(r, 3000))) {
    try {
      const r = await fetch(H, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_getBlockByNumber", params: ["finalized", false] }) });
      fin = (await r.json()).result; if (fin?.hash) break;
    } catch { /* Helios not up yet */ }
  }
  out.readyMs = Math.round(performance.now() - T0);
  out.finalized = fin && { number: Number(fin.number), hash: fin.hash, ageSec: Math.floor(Date.now() / 1000) - Number(fin.timestamp) };
  if (fin?.hash) {
    const call = { to: PORTAL, data: SEL };
    await rpc("A1-exact: call@finalizedHash 20s", "eth_call", [call, { blockHash: fin.hash }], 20000);
    await rpc("diag: call@finalizedHash 240s", "eth_call", [call, { blockHash: fin.hash }], 240000);
    await rpc("diag: call@finalizedTag 240s", "eth_call", [call, "finalized"], 240000);
    await rpc("diag: call@latest 240s", "eth_call", [call, "latest"], 240000);
  }
} finally {
  out.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
}
