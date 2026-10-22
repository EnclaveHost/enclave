// policy-probe.mjs - READ-ONLY public probe of the platform host policy read, run INSIDE an extract of the corrected
// release's image (copied to <extract>/app/zz-policy-probe.mjs), so every module and viem are the image's own bytes.
// 1. per provider, the runtime's exact read (network/host-policy-runtime.mjs quorumSnapshot): getBlockNumber, getBlock,
//    readPolicyFacts' four parallel eth_calls + eth_getCode bound by {blockHash, requireCanonical:true}, getBlock again -
//    each call's outcome recorded; then the same read with {blockHash} alone and with the block NUMBER (to separate
//    EIP-1898 support from transport/rate failures);
// 2. the image's own createHostPolicyRuntime(production).gate.decide() over the production quorum (reproduction).
// No keys, no writes, no private config: public JSON-RPC only. RPC error texts are truncated.
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult } from "viem";
import { readPolicyFacts } from "./network/platform-host-policy.mjs";
import { createHostPolicyRuntime } from "./network/host-policy-runtime.mjs";
import { resolveHostPolicyConfig, PRODUCTION_RPCS, PRODUCTION_BOOK, PRODUCTION_HOST_OWNERSHIP } from "./network/platform-host-policy-config.mjs";

const EXTRA = (process.env.PROBE_EXTRA_RPCS || "").split(",").map((s) => s.trim()).filter(Boolean);
const ROUNDS = Number(process.env.PROBE_ROUNDS || 3);
const short = (e) => { const d = String(e?.details || e?.shortMessage || e?.message || e).replace(/\s+/g, " ");
  return `${e?.name || "Error"}${e?.code !== undefined ? "(" + e.code + ")" : ""}${e?.status ? "[http " + e.status + "]" : ""}: ${d.slice(0, 140)}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function one(url, mode) {
  const c = createPublicClient({ transport: http(url, { timeout: 10_000, retryCount: 0 }) });
  const steps = [], t0 = Date.now();
  const step = async (name, f) => { const s = Date.now(); try { const v = await f(); steps.push(`${name}:ok(${Date.now() - s}ms)`); return v; }
    catch (e) { steps.push(`${name}:FAIL(${Date.now() - s}ms) ${short(e)}`); throw e; } };
  try {
    const head = await step("head", () => c.getBlockNumber({ cacheTime: 0 }));
    const number = head - 2n;      // the quorum reads the minAgree-th highest head; stay a little behind
    const b = await step("block", () => c.getBlock({ blockNumber: number }));
    const tag = mode === "canonical" ? { blockHash: b.hash, requireCanonical: true } : mode === "hash" ? { blockHash: b.hash } : "0x" + number.toString(16);
    let i = 0;
    const at = {
      call: (address, abi, functionName, args = []) => step(`call${++i}:${functionName}`, async () => decodeFunctionResult({ abi, functionName,
        data: await c.request({ method: "eth_call", params: [{ to: address, data: encodeFunctionData({ abi, functionName, args }) }, tag] }) })),
      code: (a) => step("getCode", () => c.request({ method: "eth_getCode", params: [a, tag] })),
    };
    await readPolicyFacts(at, { book: PRODUCTION_BOOK, hostOwnership: PRODUCTION_HOST_OWNERSHIP, registryIds: [], check1271: [] });
    await step("block2", () => c.getBlock({ blockNumber: number }));
    return { ok: true, ms: Date.now() - t0, steps };
  } catch { return { ok: false, ms: Date.now() - t0, steps }; }
}

const all = [...PRODUCTION_RPCS, ...EXTRA];
const table = {};
for (let r = 1; r <= ROUNDS; r++) {
  for (const url of all) for (const mode of ["canonical", "hash", "number"]) {
    const res = await one(url, mode);
    (table[url] ||= {})[mode] = [...((table[url] || {})[mode] || []), res.ok];
    console.log(`PROBE r${r} ${mode.padEnd(9)} ${res.ok ? "OK  " : "FAIL"} ${url} ${res.ms}ms ${res.ok ? "" : res.steps.filter((s) => s.includes("FAIL")).join(" | ")}`);
  }
  if (r < ROUNDS) await sleep(10_000);
}
console.log("SUMMARY (per mode: successes/rounds)");
for (const [url, m] of Object.entries(table))
  console.log(`SUMMARY ${url} canonical ${m.canonical.filter(Boolean).length}/${ROUNDS} hash ${m.hash.filter(Boolean).length}/${ROUNDS} number ${m.number.filter(Boolean).length}/${ROUNDS} ${PRODUCTION_RPCS.includes(url) ? "(production policy RPC)" : "(candidate)"}`);
// 2. the image's own runtime over the production quorum (what the guest runs)
const rt = createHostPolicyRuntime(resolveHostPolicyConfig({ chainId: 8453, book: PRODUCTION_BOOK }), { log: () => {} });
for (let r = 1; r <= ROUNDS; r++) {
  try { const d = await rt.gate.decide({ registryIds: [] }); console.log(`RUNTIME r${r} OK anchor=${d.anchor} block=${d.block}`); }
  catch (e) { console.log(`RUNTIME r${r} FAIL ${e.code || ""} ${String(e.message).slice(0, 200)}`); }
  if (r < ROUNDS) await sleep(5_000);
}
