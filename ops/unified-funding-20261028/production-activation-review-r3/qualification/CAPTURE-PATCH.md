# Capture candidate patch (review copy)

`capture-observation.candidate.mjs` is `production-activation-prep-r1/capture-observation.mjs` with the hunks below and nothing else. The original file is unchanged.
Not changed: `rpcClient`, `PUBLIC_RPCS`, `READ_METHODS`, `TIMEOUT_MS`, `MAX_RPC_BYTES`, `SPACING_MS` (2500 ms), `recordingReader`, `collectBindings`, the out-file rules and the CLI arguments.

```diff
-import { CHAIN_ID, K, callData, collectBindings, lower, normalizeCall, refuse } from "./lib/bindings.mjs";
-import { loadContext } from "./lib/context.mjs";
-import { OBSERVATION_SCHEMA } from "./prepare-activation.mjs";
+import { CHAIN_ID, K, callData, collectBindings, lower, normalizeCall, refuse } from "../production-activation-prep-r1/lib/bindings.mjs";
+import { loadContext } from "../production-activation-prep-r1/lib/context.mjs";
+import { MAX_BLOCK_LAG_SEC, OBSERVATION_SCHEMA } from "../production-activation-prep-r1/prepare-activation.mjs";
@@ (new, after rpcClient)
+const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
+const quantity = (v, what) => { if (typeof v !== "string" || !QUANTITY.test(v)) refuse("rpc_header", ...); return BigInt(v); };
+export function checkHeader(h, n, origin) {
+  // number must EQUAL requested n (header_mismatch); hash 32-byte lowercase hex; timestamp strict quantity, > 0, safe;
+  // baseFeePerGas strict quantity. Returns { number, hash, timestamp, baseFeePerGas } as decimal strings.
+}
@@ capture()
-export async function capture({ pinsPath, rpcs, out }) {
+export async function capture({ pinsPath, rpcs, out, fetchImpl, wait }) {          // fetchImpl / wait: tests only
-  const clients = urls.map((u) => ({ origin: new URL(u).origin, rpc: rpcClient(u) }));
+  const clients = urls.map((u) => ({ origin: new URL(u).origin, rpc: rpcClient(u, { ...(fetchImpl ? { fetchImpl } : {}), ...(wait ? { wait } : {}) }) }));
-  const tip = BigInt((await clients[0].rpc("eth_getBlockByNumber", ["latest", false])).number);
+  const tip = quantity((await clients[0].rpc("eth_getBlockByNumber", ["latest", false]))?.number, `... latest block number`);
-  for (const c of clients) {
-    const h = await c.rpc("eth_getBlockByNumber", [hex(n), false]);
-    if (!h?.hash || h.baseFeePerGas === undefined) refuse("rpc", `${c.origin} has no header for block ${n}`);
-    headers.push({ number: n.toString(), hash: lower(h.hash), timestamp: BigInt(h.timestamp).toString(), baseFeePerGas: BigInt(h.baseFeePerGas).toString() });
-  }
-  if (headers.some((h) => h.hash !== headers[0].hash)) refuse("provider_disagreement", ...);
-  const providers = [];
-  for (const [i, c] of clients.entries()) {
-    const r = recordingReader(c.rpc, headers[0].hash);
-    await collectBindings(r, ctx);
-    providers.push({ url: c.origin, chainId: CHAIN_ID, block: headers[i], reads: r.reads });
-  }
-  const observation = { schema: OBSERVATION_SCHEMA, readOnly: true, capturedAt: Math.floor(Date.now() / 1000), providers, ... };
+  for (const c of clients) headers.push(checkHeader(await c.rpc("eth_getBlockByNumber", [hex(n), false]), n, c.origin));
+  for (const k of ["hash", "timestamp", "baseFeePerGas"]) {
+    if (headers.some((h) => h[k] !== headers[0][k])) refuse("provider_disagreement", ...);
+  }
+  const walks = await Promise.allSettled(clients.map(async (c, i) => {
+    const r = recordingReader(c.rpc, headers[0].hash);
+    await collectBindings(r, ctx);
+    return { url: c.origin, chainId: CHAIN_ID, block: headers[i], reads: r.reads };
+  }));
+  const failed = walks.find((w) => w.status === "rejected");
+  if (failed) throw failed.reason;
+  const providers = walks.map((w) => w.value);
+  const capturedAt = Math.floor(Date.now() / 1000);
+  if (capturedAt - Number(headers[0].timestamp) > MAX_BLOCK_LAG_SEC) refuse("observation_stale", ...);
+  const observation = { schema: OBSERVATION_SCHEMA, readOnly: true, capturedAt, providers, ... };
```

Why each change is needed:

- **Header number.** The original wrote `number: n` without reading `h.number`. A provider that answers a different block would still have been recorded as block n. The candidate refuses with `header_mismatch`.
- **All header fields agree.** The original compared only the hash across providers, and each provider's own timestamp and base fee went into the file. The preparer would catch a difference, but only later. The candidate now refuses before any binding walk. It also refuses a non-strict QUANTITY (leading zero, decimal, uppercase, empty, a number, null) instead of letting `BigInt()` accept it.
- **Parallel walks.** One walk is roughly 55 paced reads at 2.5 s each, so about 140 s. Two sequential walks plus the header reads come close to, or go over, the preparer's unchanged `MAX_BLOCK_LAG_SEC` of 300 s, measured from the pinned block (tip − 2) to `capturedAt`. Running the walks in parallel brings the capture to about 140 s.
  - Each walk keeps its own `rpcClient`, so its own `nextAt` pacing, request ids, identity, size and timeout checks.
  - Each walk keeps its own recording reader and the full `collectBindings`.
  - `allSettled` waits for both walks. Any refusal is re-thrown and nothing is written. On a failure the other walk finishes its paced reads first, which can take up to about 140 s.
- **Lag pre-check.** The candidate does not write an observation that the preparer is certain to refuse. The limit is the same constant, not loosened.
