// el_probe.mjs EL_URL OUT (guest, inside a bounded scope; r3; PREPARED, NOT run). READ-ONLY timings against OUR OWN L1 EL of exactly what
// Helios needs to answer A1's first verified call, anchorStateRegistry() on the OptimismPortal, at the EL's finalized block:
// eth_call, eth_createAccessList, eth_getProof (empty keys, access-list keys, every access-list account), repeated, plus one
// out-of-window proof to record the configured proof-window response. Sequential, one request at a time, 240 s per request.
// r3: (1) the block summary is computed safely INSIDE the guarded path (r2 aborted on params=[]: undefined.slice); (2) OUT is rewritten
// atomically after EVERY request, so a timeout/kill keeps every earlier timing; (3) `complete: true` is written ONLY after the last
// step ran. Timings/errors are observations, never a verdict. env K = file URL of the pinned @noble/hashes sha3.js (keccak only).
import fs from "node:fs";
const [EL, OUT] = process.argv.slice(2);
const { keccak_256 } = await import(process.env.K);
const PORTAL = "0x49048044d57e1c92a77f79988d21fa8faf74e97e";
const SEL = "0x" + Buffer.from(keccak_256(new TextEncoder().encode("anchorStateRegistry()"))).toString("hex").slice(0, 8);
const hex = (n) => "0x" + n.toString(16);
const steps = [];
const out = { format: "enclave-el-probe/v3", selector: SEL, portal: PORTAL, startedAt: new Date().toISOString(), complete: false, steps };
const flush = () => { fs.writeFileSync(OUT + ".tmp", JSON.stringify(out, null, 1)); fs.renameSync(OUT + ".tmp", OUT); };
const blockOf = (params) => {
  if (!Array.isArray(params) || params.length === 0) return null;
  const s = JSON.stringify(params[params.length - 1]);
  return typeof s === "string" ? s.slice(0, 80) : null;
};
let id = 0;
async function rpc(label, method, params, timeoutMs = 240000) {
  const t0 = performance.now(); const s = { label, method };
  try {
    s.block = blockOf(params);
    const r = await fetch(EL, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const t = await r.text(); s.ms = Math.round(performance.now() - t0); s.bytes = t.length; s.http = r.status;
    const j = JSON.parse(t);
    if (j.error) { s.error = JSON.stringify(j.error).slice(0, 300); return null; }
    return j.result;
  } catch (e) { s.ms = Math.round(performance.now() - t0); s.error = String(e?.message || e).slice(0, 300); return null; }
  finally { steps.push(s); flush(); }
}
try {
  flush();
  const head = await rpc("head", "eth_blockNumber", []);
  const fin = await rpc("finalized", "eth_getBlockByNumber", ["finalized", false]);
  out.head = head ? Number(head) : null; out.finalized = fin && { number: Number(fin.number), hash: fin.hash, timestamp: Number(fin.timestamp) };
  if (fin) {
    const fn = hex(Number(fin.number)), at = { blockHash: fin.hash }, call = { to: PORTAL, data: SEL };
    out.distance = out.head === null ? null : out.head - out.finalized.number; flush();
    await rpc("call@finalizedHash", "eth_call", [call, at]);
    await rpc("call@latest", "eth_call", [call, "latest"]);
    const al = await rpc("accessList@finalized", "eth_createAccessList", [call, fn]);
    await rpc("accessList@latest", "eth_createAccessList", [call, "latest"]);
    const list = (Array.isArray(al?.accessList) ? al.accessList : []).slice(0, 8);
    out.accessList = list.map((x) => ({ address: x.address, keys: (x.storageKeys || []).length }));
    const pk = (list.find((x) => String(x.address).toLowerCase() === PORTAL)?.storageKeys) || [];
    for (let i = 0; i < 3; i++) await rpc(`proof@finalized#${i}`, "eth_getProof", [PORTAL, [], fn]);
    await rpc("proofKeys@finalized", "eth_getProof", [PORTAL, pk, fn]);
    await rpc("proofKeys@latest", "eth_getProof", [PORTAL, pk, "latest"]);
    for (const x of list) await rpc(`proofAccount@finalized:${x.address}`, "eth_getProof", [x.address, x.storageKeys || [], fn]);
    await rpc("proof@finalized-300 (window check)", "eth_getProof", [PORTAL, [], hex(Number(fin.number) - 300)], 60000);
    out.complete = true;                                   // every step RAN (each step's own error, if any, is an observation)
  } else out.incompleteReason = "the EL returned no finalized block";
} catch (e) {
  out.incompleteReason = `probe aborted: ${String(e?.message || e).slice(0, 200)}`;
} finally {
  out.finishedAt = new Date().toISOString(); flush();
}
