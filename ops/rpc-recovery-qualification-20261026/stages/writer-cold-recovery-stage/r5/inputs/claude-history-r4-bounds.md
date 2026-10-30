# writer-cold-recovery-stage/r4: resource bounds for the backward history (review 1592 M1/M2/L1). FROZEN 2026-10-26 19:47Z, NOT RUN

**Stage:** `writer-cold-recovery-stage/r4/`, **SHA256SUMS sha256 `9fa22972da017bc563064336ce50985a27690391a50a3144e364442a6b40a54c`** (files 0444)

| file | sha256 |
|---|---|
| `patches/writer-cold-recovery-r4-vs-r3.patch` | `d73f127d0b19ead245ee024d2cf3328ca006832be3ad708e839c8d7c8aa977c0` |
| `jobs/root-writer-cold-recovery-r4.sh` | `22ff6d759e5786ff6b80732b066c9b0c7efcca169a3fc88ed5977a16127b2656` |
| `PROVENANCE.md` | `325d910c8493769564d28efa8aa224a6eafb578f309b3a65cd59cd66a22b42bd` |
| `inputs/claude-history-r3-review-1592.md` | `d4958a5f4c4a5dae73642272cb39c31fe5b934a048f3b55a0ba18733ebce425a` |

**Trees:** frozen r3 (`320b80b8…`, re-verified) has tree `a4dd62c3`; r3 + the patch gives **tree `571b5c84a8ffe3e6bc9c21ca4184a5b4a7ebb1af`**.
- **Reproduction:** apply the patch with `git apply --cached` onto a fresh index of `a4dd62c3`.
- **Scratch:** private `/tmp/w8`. `/tmp/w6` was only read (`git diff --cached`); `/tmp/w7` and other agents' scratch were not touched. Frozen r2 `73fae0c1` and r3 `320b80b8` re-verified.

**What I did not do:** no tests, builds, `node`, network, USB or live actions. **Executed:** `bash -n`, sha256, scratch git.

## Contract (what r4 changes; everything else is r3)
### Per-method transports (M1): the actual boundedRpc, not a per-call option
`network/derived-reader/rpc.mjs` is unchanged. Its `maxBytes` is a **factory** option (≤ 32 MiB); the per-call options carry only `signal`.

r4 builds **one boundedRpc per method**, each with its own factory cap:
```js
historyRequest: history ? historyTransport(maxBytes => boundedRpc(baseUrl, { maxBytes, timeoutMs: 60000 })) : null   // provider.mjs
export const HISTORY_RPC_CAPS = { eth_getBlockByNumber: 4 MiB, eth_getRawTransactionByBlockHashAndIndex: 1 MiB,
                                  eth_getBlockReceipts: 32 MiB, debug_getRawTransactions: 32 MiB }        // backward-history.mjs
```
`historyTransport` dispatches by method; any other method is rejected without a network call. The cap is enforced by boundedRpc's own streaming loop, which aborts the fetch once more than `maxBytes` has arrived, before the whole body is buffered.

**How the caps were chosen:**
- **4 MiB header:** `eth_getBlockByNumber(n, false)` is a header plus about 69 bytes per transaction hash, so 4 MiB holds about 60,000 hashes, several times a Base block at today's gas limit. A larger block fails closed (refused, never omitted).
- **1 MiB raw transaction:** holds 512 KiB of transaction bytes. The txpool limit is 128 KiB, and OptimismPortal2 deposit data is ≤ 120,000 bytes; both figures are external facts I did not re-verify here.
- **32 MiB whole-block receipts and raw transactions:** unchanged, as the existing proof path needs.

### Scan-wide budget (M1)
`scanBackwardLeaseHistory` wraps its transport in `limitRpc(transport, rpcBudget)`. Every own-node call of the scan passes through it: preflight, headers, receipts, debug raw and per-index raw.
- **Default `HISTORY_RPC_BUDGET`:** `{ maxCalls: 32, maxBytes: 128 MiB }`.
- **Charging:** each call is charged its method's cap from start until it **settles**. The budget is released before the caller sees the outcome.
- **Queue:** FIFO, so a 32 MiB receipt list is not starved. A queued call whose signal aborts leaves the queue. Freed budget is handed on in a later macrotask, so a failing batch's abort always lands first and no queued call of an aborted batch ever starts.
- **Validation:** `maxBytes` ≥ 32 MiB (the largest cap) and ≤ 1 GiB; `maxCalls` 1..1024.

**Worst-case bytes in flight (enforced):**
- The response bytes held by in-flight calls are ≤ Σ caps ≤ **128 MiB**: for example 4 receipt lists, or 32 headers, or 32 raw transactions, whatever `chunk` (≤ 1024) and `receiptConcurrency` (≤ 8) say.
- In r3 this was unbounded: 1024 header calls × 32 MiB.
- Effective receipt parallelism is therefore ≤ 4 with the default budget.

**Not enforced by the budget (stated):**
- **Transient parsing:** each boundedRpc call holds its chunks, then one `Buffer.concat` copy, the UTF-8 string and the parsed value. That is a small multiple of one call's bytes, done one call at a time on the JS thread.
- **Parsed results held by `bounded()` receipt tasks:** ≤ `receiptConcurrency` blocks × (≤ 32 MiB receipt JSON + ≤ 32 MiB raw JSON) as parsed objects. The object expansion factor is unmeasured, so the signed `receiptConcurrency` should stay small (1-2) on the 16 GiB-floor host until measured.
- **A replaced scan:** a scan aborted by a new seed is not awaited, but its calls abort promptly, so two budgets can briefly overlap.

### Batch abort and settle (M2)
`allOrAbort(signal, makers)` runs a header chunk (`fetchRange`) and a block's per-index raw transactions.
- On the first failure it aborts the batch's local controller and **awaits every call's settlement** before rethrowing.
- The scan, and so the provider's 60 s retry, therefore never overlaps its predecessor's calls.
- Receipt blocks already used `bounded()`, which aborts and awaits.

### Statistics (L1)
`cacheHits`/`cacheRejected` are added to `stats` only at the chunk commit, together with headers and bloom hits.

**Unchanged:**
- authenticated header hashing and parent links from N;
- the floor-inclusive walk and the gap check;
- the bloom rule;
- `transactionsRoot` from raw transactions and the full `verifyBlockReceipts`;
- the absolute-chunk lean cache, slicing and eviction;
- result ordering (by index) and RAM resume exactness (commit point unchanged);
- the v2 policy (keys unchanged; the budget is a code constant, not policy);
- default-disabled behaviour, enrollment gating, the writer authority and admin controls.

## Tests (prepared, NOT run). backward-history **16** (r3's 13 + 3); writer-history 9; the other suites unchanged
1. **`r4 M1/M2: a 64-header chunk …`** (synthetic chain 1000..1063, chunk 64):
   - With budget 8, exactly 8 header calls are in flight. The default budget gives 32 (= min(32, 128 MiB / 4 MiB)).
   - Header 1003 fails while 1000..1007 are in flight: the 7 others are aborted, none of the 56 queued starts, in-flight is 0 when the scan rejects, and progress stays at 1063.
   - No statistics are recorded from the uncommitted chunk (L1), and a retry completes.
   - A budget below 32 MiB is refused.
2. **`r4 M1: per-index raw transactions of CONCURRENT receipt blocks …`** (`receiptConcurrency` 4):
   - with budgets 2 and 3 calls, the in-flight count across all methods reaches and never exceeds the budget, and the history is the same complete ordered result;
   - a 64 MiB byte budget admits ≤ 2 receipt lists at once;
   - one per-index raw call of block 1007 fails: everything aborts and settles before rejection, and no call starts after the failure.
3. **`r4 M1: the ACTUAL boundedRpc transport, one per method …`** (loopback HTTP server):
   - the factory is called once per method with exactly `HISTORY_RPC_CAPS`;
   - a streamed 24 MiB header reply and a 24 MiB raw-transaction reply are rejected ("exceeds byte limit"), and the server observes the connection cut before it finished writing;
   - a 6 MiB receipt list is still accepted (32 MiB cap);
   - `eth_call` is refused without reaching the server;
   - `limitRpc` over the real transport charges a receipt call 32 MiB and frees it on settlement.

None of these is a mainnet or performance claim.

## Root
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh wcr-r4-slice  512 unshare -Urnm bash writer-cold-recovery-stage/r4/jobs/root-writer-cold-recovery-r4.sh slice
bash jobs/q-exit-status.sh wcr-r4-check 2560 unshare -Urnm bash writer-cold-recovery-stage/r4/jobs/root-writer-cold-recovery-r4.sh check
```
**What the job does:**
- verifies this stage and frozen r3 `320b80b8`, plus everything r3 verified (r2, two-anchor r1-r3, r9 with its check verdict, the KVM r3 closure);
- composes r9 → W1 → W2 → W3 → CR2 `e903c224` → CR3 `a4dd62c3` → **`571b5c84`**, asserting each tree;
- expects backward-history **16**; all other counts as in r3.

**Test 3 needs** loopback inside the namespace (`ip link set lo up` is in the job).

## For Claude50 / integrated r3 (integrated r2 `a01a3e95` is frozen; root 1594 is running)
- The patch touches only `backward-history.mjs`, `provider.mjs` (the import plus the one `historyRequest` line) and `backward-history.test.mjs`.
- Apply on the r3 blobs (`023eefdc…`, `fde14516…`, `84e20475…`) with `git apply --index`, or with `--3way`.
- **Producer placement:** wherever the integrated stage constructs the history transport, it must be `historyTransport(maxBytes => boundedRpc(baseUrl, { maxBytes, timeoutMs: 60000 }))`, never a single 32 MiB boundedRpc.

## Residuals (honest)
- **Unmeasured:** own-node throughput under the budget, mainnet scan cost, and the parsed-object memory of `receiptConcurrency` blocks.
- **Block size:** a block whose header + hash list exceeds 4 MiB, or a single raw transaction exceeding 1 MiB, refuses the scan (fail-closed). Raise the constant only with evidence.
- **Generated bundle:** `relay/derived-reader-runtime.bundle.mjs` in the tree contains no history code (0 matches for `scanBackwardLeaseHistory`/`historyRequest`). The check mode's regenerated reader runtime is what carries r3/r4. That is root's existing check path; nothing about it changed here.

## Full patch (`patches/writer-cold-recovery-r4-vs-r3.patch`, sha256 d73f127d…)
```diff
diff --git a/network/derived-reader/backward-history.mjs b/network/derived-reader/backward-history.mjs
index 023eefdcada9f7d9764aa7ee3183d40a279fc923..6e8b416ea4e8018fb86854b200ee3bc6de309fb6 100644
--- a/network/derived-reader/backward-history.mjs
+++ b/network/derived-reader/backward-history.mjs
@@ -14,8 +14,11 @@
 // restarts; the cache holds only the hashed header fields, is read bounded / regular / O_NOFOLLOW and evicts within its byte and
 // file bounds; the raw-transaction method is signed policy and pre-flighted; receipt blocks run with bounded concurrency and the
 // event loop is yielded between verified blocks; an in-memory progress record (RAM only, per authenticated seed) lets a retry
-// resume at the last fully verified chunk instead of N. The own node is untrusted transport. Nothing here is persisted as
-// authority: cached header bytes are re-hashed and re-linked from N on every use. Fail closed: missing, malformed, non-canonical,
+// resume at the last fully verified chunk instead of N. r4 (review 1592 M1/M2/L1): EVERY own-node call of a scan passes one
+// scan-wide budget (calls and response bytes, each method charged its transport's byte cap); a batch (a header chunk, a block's
+// per-index raw transactions) aborts its other calls on the first failure and settles them all before the scan rejects, so a
+// retry never overlaps its predecessor's calls; cache statistics count only committed chunks. The own node is untrusted
+// transport. Nothing here is persisted as authority: cached header bytes are re-hashed and re-linked from N on every use. Fail closed: missing, malformed, non-canonical,
 // oversized, truncated, gapped, mismatched-root or unsupported-type input refuses the whole scan.
 import { headerHash, ISTHMUS_FIELDS } from './vendor/anchor-bootstrap.mjs';
 import { verifyBlockReceipts, orderedTrieRoot, BASE_MAINNET } from '../op-receipts-root.mjs';
@@ -38,6 +41,73 @@ const fail = (code, message) => { throw Object.assign(new Error(`backward histor
 const bytesOf = h => Uint8Array.from(h.slice(2).match(/../g) || [], x => parseInt(x, 16));
 const toHex = b => '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
 const yieldLoop = () => new Promise(resolve => setImmediate(resolve));
+/**
+ * r4: the per-method response byte cap of the history transport (each a SEPARATE boundedRpc whose own factory maxBytes is this
+ * value; nothing is a per-call option). eth_getBlockByNumber(n, false) is a header plus one 66-character hash per transaction:
+ * 4 MiB holds ~60,000 transaction hashes, several times a Base block at today's gas limit. One raw transaction: 1 MiB holds
+ * 512 KiB of transaction bytes (txpool limit 128 KiB; OptimismPortal2 deposit data <= 120,000 bytes). Whole-block receipts and
+ * whole-block raw transactions keep the existing 32 MiB (the bound the receipt proof already needs; not narrowed).
+ */
+export const HISTORY_RPC_CAPS = Object.freeze({ eth_getBlockByNumber: 4 << 20, eth_getRawTransactionByBlockHashAndIndex: 1 << 20,
+  eth_getBlockReceipts: 32 << 20, debug_getRawTransactions: 32 << 20 });
+/**
+ * r4: the scan-wide budget. At most maxCalls calls in flight and the SUM of their byte caps <= maxBytes: response bytes held at
+ * once <= 128 MiB (e.g. four 32 MiB receipt lists, or 32 headers, or 32 raw transactions), whatever chunk / receiptConcurrency
+ * say. Transient parse cost is a small multiple of that (body chunks + one concat + the JSON string and object).
+ */
+export const HISTORY_RPC_BUDGET = Object.freeze({ maxCalls: 32, maxBytes: 128 << 20 });
+/** r4: the method-selecting history transport: make(maxBytes) must return a boundedRpc-shaped request with THAT factory cap */
+export function historyTransport(make) {
+  const by = Object.fromEntries(Object.entries(HISTORY_RPC_CAPS).map(([m, cap]) => [m, make(cap)]));
+  if (Object.values(by).some(f => typeof f !== 'function')) throw Error('history transport factory must return request functions');
+  return (method, params, opts) => Object.hasOwn(by, method) ? by[method](method, params, opts)
+    : Promise.reject(Error(`history transport serves no ${String(method).slice(0, 60)}`));
+}
+/**
+ * r4: one shared budget over a request function (FIFO; a queued call whose signal aborts leaves the queue). A call holds its
+ * method's cap from start until its promise SETTLES (boundedRpc settles only after its body loop ended or was aborted).
+ */
+export function limitRpc(request, { maxCalls = HISTORY_RPC_BUDGET.maxCalls, maxBytes = HISTORY_RPC_BUDGET.maxBytes, costOf = m => HISTORY_RPC_CAPS[m] } = {}) {
+  if (typeof request !== 'function' || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 1024 ||
+      !Number.isSafeInteger(maxBytes) || maxBytes < Math.max(...Object.values(HISTORY_RPC_CAPS)) || maxBytes > (1024 << 20))
+    fail('bad_input', 'invalid history RPC budget');
+  let calls = 0, bytes = 0, peakCalls = 0, peakBytes = 0, scheduled = false;
+  const queue = [];
+  const pump = () => {
+    scheduled = false;
+    while (queue.length && calls < maxCalls && bytes + queue[0].cost <= maxBytes) {
+      const q = queue.shift();
+      q.signal?.removeEventListener('abort', q.onAbort);
+      if (q.signal?.aborted) { q.reject(q.signal.reason); continue; }      // never start a call whose batch was already aborted
+      calls++; bytes += q.cost; peakCalls = Math.max(peakCalls, calls); peakBytes = Math.max(peakBytes, bytes);
+      const release = () => { calls--; bytes -= q.cost; later(); };      // the budget is free BEFORE the caller sees the outcome
+      Promise.resolve().then(() => request(q.method, q.params, q.opts)).then(v => { release(); q.resolve(v); }, e => { release(); q.reject(e); });
+    }
+  };
+  // freed budget is handed on in a LATER macrotask: a failing batch's abort (promise reactions) always lands first, so a queued
+  // call of an aborted batch is dropped instead of started
+  const later = () => { if (!scheduled) { scheduled = true; setImmediate(pump); } };
+  const limited = (method, params, opts = {}) => new Promise((resolve, reject) => {
+    const cost = costOf(method), signal = opts?.signal;
+    if (!Number.isSafeInteger(cost) || cost < 1 || cost > maxBytes) return reject(Error(`history RPC ${String(method).slice(0, 60)} has no byte budget`));
+    if (signal?.aborted) return reject(signal.reason);
+    const q = { method, params, opts, cost, signal, resolve, reject };
+    q.onAbort = () => { const i = queue.indexOf(q); if (i >= 0) { queue.splice(i, 1); reject(signal.reason); later(); } };
+    signal?.addEventListener('abort', q.onAbort, { once: true });
+    queue.push(q); if (queue.length === 1) pump(); else later();
+  });
+  limited.usage = () => ({ calls, bytes, queued: queue.length, peakCalls, peakBytes, maxCalls, maxBytes });
+  return limited;
+}
+/** r4 (M2): run a batch; on the first failure abort the others, and reject only after EVERY call has settled */
+async function allOrAbort(signal, makers) {
+  const local = new AbortController(), sig = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
+  let first = null;
+  const settled = await Promise.allSettled(makers.map(make => Promise.resolve().then(() => make(sig))
+    .catch(e => { if (!first) { first = { e }; local.abort(e); } throw e; })));
+  if (first) throw first.e;
+  return settled.map(r => r.value);
+}
 /** only the hashed fields (anything else an RPC adds, e.g. transaction-hash lists, is dropped before caching) */
 export const leanHeader = h => (h && typeof h === 'object' && !Array.isArray(h)
   ? Object.fromEntries(HASHED_HEADER_FIELDS.filter(k => h[k] !== undefined && h[k] !== null).map(k => [k, h[k]])) : h);
@@ -153,9 +223,10 @@ async function bounded(items, limit, signal, task) {
  *     chunk (it only ever holds results already verified against N in this process; never persisted)
  * -> frozen { format, anchor, floor, ledgers, logs (ascending; native coverage log shape), stats }
  */
-export async function scanBackwardLeaseHistory({ request, anchor, ledgers, floor, keccak, signal, chunk = 256, maxScanBlocks, maxLogs,
-  cache = null, rawTransactions = 'debug', receiptConcurrency = 1, preflight = false, progress = null, chain = BASE_MAINNET }) {
-  if (typeof request !== 'function' || typeof keccak !== 'function') fail('bad_input', 'request and keccak are required');
+export async function scanBackwardLeaseHistory({ request: transport, anchor, ledgers, floor, keccak, signal, chunk = 256, maxScanBlocks, maxLogs,
+  cache = null, rawTransactions = 'debug', receiptConcurrency = 1, preflight = false, progress = null, chain = BASE_MAINNET, rpcBudget = HISTORY_RPC_BUDGET }) {
+  if (typeof transport !== 'function' || typeof keccak !== 'function') fail('bad_input', 'request and keccak are required');
+  const request = limitRpc(transport, rpcBudget);                // r4 (M1): every call of this scan shares one budget
   if (!anchor || !uint(anchor.number) || !HASH.test(lc(anchor.hash))) fail('no_anchor', 'an authenticated anchor {number, hash} is required');
   if (!Array.isArray(ledgers) || !ledgers.length || ledgers.some(a => !ADDRESS.test(a))) fail('bad_input', 'ledgers must be lowercase addresses');
   if (!uint(floor) || !Number.isInteger(chunk) || chunk < 1 || chunk > 1024 || !Number.isInteger(maxScanBlocks) || !Number.isInteger(maxLogs) ||
@@ -172,7 +243,7 @@ export async function scanBackwardLeaseHistory({ request, anchor, ledgers, floor
   const stats = p.stats;
   if (preflight) await preflightNode();
   const chunkLo = n => floor + Math.floor((n - floor) / chunk) * chunk;           // absolute boundaries: independent of N
-  const fetchRange = (lo, hi) => Promise.all(Array.from({ length: hi - lo + 1 }, (_, i) => request('eth_getBlockByNumber', [hex(lo + i), false], { signal })));
+  const fetchRange = (lo, hi) => allOrAbort(signal, Array.from({ length: hi - lo + 1 }, (_, i) => sig => request('eth_getBlockByNumber', [hex(lo + i), false], { signal: sig })));
   // verify one ascending range [lo, hi] DOWNWARD against the authenticated expectation; -> the per-block verified (lean) headers
   const verifyRange = (headers, lo, hi, expectHash) => {
     if (!Array.isArray(headers) || headers.length !== hi - lo + 1) fail('truncated', `header chunk ${lo}..${hi} is incomplete`);
@@ -196,11 +267,11 @@ export async function scanBackwardLeaseHistory({ request, anchor, ledgers, floor
   while (p.nextHi >= floor) {
     signal?.throwIfAborted();
     const hi = p.nextHi, lo = chunkLo(hi), complete = lo + chunk - 1 === hi;
-    let verified = null;
+    let verified = null, cacheHit = 0, cacheRejected = 0;          // r4 (L1): counted into stats only when the chunk commits
     const cached = cache?.get(chunk, lo) ?? null;                   // a complete chunk; only [lo, hi] (<= N) is ever used
     if (cached) {
-      try { verified = verifyRange(cached.slice(0, hi - lo + 1), lo, hi, p.expectHash); stats.cacheHits++; }
-      catch { stats.cacheRejected++; try { cache.drop(chunk, lo); } catch { /* optional */ } }   // tampered or stale: refetched
+      try { verified = verifyRange(cached.slice(0, hi - lo + 1), lo, hi, p.expectHash); cacheHit = 1; }
+      catch { cacheRejected = 1; try { cache.drop(chunk, lo); } catch { /* optional */ } }   // tampered or stale: refetched
     }
     if (!verified) {
       verified = verifyRange(await fetchRange(lo, hi), lo, hi, p.expectHash);
@@ -214,6 +285,7 @@ export async function scanBackwardLeaseHistory({ request, anchor, ledgers, floor
     if (p.collected.length + add.length > maxLogs) fail('resource_bound', `more than ${maxLogs} lease logs`);
     // the chunk is fully verified: only now does the RAM progress advance
     p.collected.push(...add); stats.headers += verified.out.length; stats.bloomHits += hits.length; stats.receiptBlocks += hits.length;
+    stats.cacheHits += cacheHit; stats.cacheRejected += cacheRejected;
     p.expectHash = verified.want; p.nextHi = lo - 1;
   }
   if (p.nextHi !== floor - 1) fail('gap', 'the scan did not reach the floor');
@@ -235,7 +307,7 @@ export async function scanBackwardLeaseHistory({ request, anchor, ledgers, floor
     if (!Array.isArray(receipts)) fail('missing', `no receipt list for block ${n}`);
     let raws;
     if (rawTransactions === 'debug') raws = await request('debug_getRawTransactions', [blockHash], { signal: sig });
-    else raws = await Promise.all(receipts.map((_, i) => request('eth_getRawTransactionByBlockHashAndIndex', [blockHash, hex(i)], { signal: sig })));
+    else raws = await allOrAbort(sig, receipts.map((_, i) => s => request('eth_getRawTransactionByBlockHashAndIndex', [blockHash, hex(i)], { signal: s })));
     if (!Array.isArray(raws) || raws.some(r => typeof r !== 'string' || !RAW.test(lc(r)))) fail('missing', `raw transactions of block ${n} are missing or malformed`);
     sig.throwIfAborted();
     const txs = raws.map(r => bytesOf(lc(r)));
diff --git a/network/derived-reader/provider.mjs b/network/derived-reader/provider.mjs
index fde145165f1fc12eb86ecc5282bf87e496da57f2..f2e6db01a0f4a039944d344c9389e6760794ae4b 100644
--- a/network/derived-reader/provider.mjs
+++ b/network/derived-reader/provider.mjs
@@ -15,7 +15,7 @@ import { authenticateBootstrap, prepareProof, bindNativeV2, bindNativeV3, DERIVE
 import { invokeDerivation, DERIVATION_BUILDS, DERIVATION_V3_BUILDS } from './native.mjs';
 import { openCoverageStore, MAX_HISTORY_BYTES } from './coverage-store.mjs';
 import { MAX_COVERAGE_BYTES, LEASE_TOPICS, COVERAGE_FORMAT, FILTER_ID } from './coverage.mjs';
-import { backwardHistoryPolicy, scanBackwardLeaseHistory, fileHeaderCache } from './backward-history.mjs';
+import { backwardHistoryPolicy, scanBackwardLeaseHistory, fileHeaderCache, historyTransport } from './backward-history.mjs';
 import { takeRuntimeLock } from '../runtime-lock.mjs';
 import { strictWriteFile } from '../lease-release-journal.mjs';
 import { commitJournalBytes, journalBytesDigest, validateJournalCommit } from '../journal-commit.mjs';
@@ -626,7 +626,8 @@ export async function startDerivedReader(config, options = {}) {
     provider = await createDerivedProvider({ l1, journal, executable, runtime, workDir: nativeDir, base, resultVersion, coverageStore, provisional,
       provisionalEvidence: provisional ? options.provisionalEvidence ?? null : null, history,
       // the own Base node: untrusted transport for the scan (receipts of large blocks need a larger byte cap)
-      historyRequest: history ? boundedRpc(baseUrl, { maxBytes: 32 << 20, timeoutMs: 60000 }) : null,
+      // r4 (review 1592 M1): one boundedRpc per method, each with its OWN factory byte cap (HISTORY_RPC_CAPS); the scan budgets them
+      historyRequest: history ? historyTransport(maxBytes => boundedRpc(baseUrl, { maxBytes, timeoutMs: 60000 })) : null,
       // untrusted header bytes kept across restarts (beside runs/, never reaped as a run): re-authenticated from N on every use
       historyCache: history ? fileHeaderCache(path.join(path.dirname(runs), 'history-cache')) : null,
       bootstrap: params => authenticateBootstrap({ l1, execution, base, a1Config, ...params, now: options.now || Date.now }),
diff --git a/test/derived-reader/backward-history.test.mjs b/test/derived-reader/backward-history.test.mjs
index 84e20475a0133f99a334dc46ebe7c155aba46d7e..da9061c4263716fa6bd9fed3dc7c71c41b49e20b 100644
--- a/test/derived-reader/backward-history.test.mjs
+++ b/test/derived-reader/backward-history.test.mjs
@@ -16,7 +16,9 @@ import { consensusReceiptsRoot, logsBloom, orderedTrieRoot } from '../../network
 import { keccak } from '../../network/derived-reader/proof.mjs';
 import { LEASE_TOPICS } from '../../network/derived-reader/coverage.mjs';
 import { scanBackwardLeaseHistory, mayHoldLeaseLog, bloomMayContain, fileHeaderCache, backwardHistoryPolicy, BACKWARD_HISTORY_POLICY_FORMAT,
-  DEFAULT_CACHE_MAX_BYTES, MAX_CACHE_FILE_BYTES } from '../../network/derived-reader/backward-history.mjs';
+  DEFAULT_CACHE_MAX_BYTES, MAX_CACHE_FILE_BYTES, HISTORY_RPC_CAPS, HISTORY_RPC_BUDGET, historyTransport, limitRpc } from '../../network/derived-reader/backward-history.mjs';
+import { boundedRpc } from '../../network/derived-reader/rpc.mjs';
+import http from 'node:http';
 import { createDerivedProvider, derivedReaderBinding, startDerivedReader } from '../../network/derived-reader/provider.mjs';
 import { openDerivedJournal } from '../../network/derived-reader/journal.mjs';
 import { openCoverageStore } from '../../network/derived-reader/coverage-store.mjs';
@@ -377,3 +379,96 @@ test('r3 F2/F4/F5: bounded receipt concurrency, RAM-only resume of a failed scan
   assert.deepEqual((await scan(c, node(c, { fail: m => m === 'debug_getRawTransactions' }), { preflight: true, rawTransactions: 'per-index' })).logs, c.expected);
   await refuses(scan(c, node(c, { receipts: (r, h) => h === c.headers.get(1012).hash ? [] : r }), { preflight: true }), 'preflight');
 });
+
+// ---- r4 (review 1592 M1/M2/L1): resource bounds. Synthetic chains and a loopback HTTP server only; no performance claim ----
+/** an own node whose calls stay in flight until a timer or their abort; counts in-flight calls per method */
+function slowNode(c, { ms = 15, failWhen = () => false } = {}) {
+  const own = node(c), st = { inFlight: 0, max: 0, started: 0, aborted: 0, afterFailure: 0, failed: false, byMethod: {}, maxByMethod: {} };
+  const request = (m, p, o) => new Promise((resolve, reject) => {
+    if (st.failed) st.afterFailure++;
+    st.started++; st.inFlight++; st.max = Math.max(st.max, st.inFlight);
+    st.byMethod[m] = (st.byMethod[m] || 0) + 1; st.maxByMethod[m] = Math.max(st.maxByMethod[m] || 0, st.byMethod[m]);
+    let open = true;
+    const end = () => { if (!open) return false; open = false; st.inFlight--; st.byMethod[m]--; o?.signal?.removeEventListener('abort', onAbort); return true; };
+    const onAbort = () => { if (end()) { clearTimeout(t); st.aborted++; reject(o.signal.reason); } };
+    const t = setTimeout(() => { if (!end()) return;
+      if (failWhen(m, p)) { st.failed = true; reject(Error('own node outage')); } else own.request(m, p, o).then(resolve, reject); }, failWhen(m, p) ? 1 : ms);
+    o?.signal?.addEventListener('abort', onAbort, { once: true });
+  });
+  return { request, st };
+}
+
+test('r4 M1/M2: a 64-header chunk runs under the scan-wide call budget; a failed header aborts its batch and EVERY call settles before the scan rejects', async () => {
+  const c = buildChain({ from: 1000, to: 1063 }), budget = { maxCalls: 8, maxBytes: HISTORY_RPC_BUDGET.maxBytes };
+  const ok = slowNode(c);
+  const r = await scan(c, ok, { chunk: 64, rpcBudget: budget });
+  assert.equal(r.stats.headers, 64); assert.deepEqual(r.logs, []);
+  assert.equal(ok.st.max, 8, `at most (and here exactly) 8 header calls in flight (saw ${ok.st.max})`);
+  // the default budget: 32 calls; 128 MiB / 4 MiB per header also admits 32
+  const dflt = slowNode(c); await scan(c, dflt, { chunk: 64 });
+  assert.equal(dflt.st.max, Math.min(HISTORY_RPC_BUDGET.maxCalls, HISTORY_RPC_BUDGET.maxBytes / HISTORY_RPC_CAPS.eth_getBlockByNumber));
+  // header 1003 fails while 1000..1007 are in flight: the other 7 are aborted, the 56 queued ones never start, and the scan
+  // rejects only when nothing of it is still in flight (a retry can never overlap it)
+  const bad = slowNode(c, { ms: 200, failWhen: (m, p) => m === 'eth_getBlockByNumber' && Number(BigInt(p[0])) === 1003 });
+  const progress = {};
+  await assert.rejects(scan(c, bad, { chunk: 64, rpcBudget: budget, progress }), /own node outage/);
+  assert.equal(bad.st.inFlight, 0, 'every call of the failed batch settled before the rejection');
+  assert.equal(bad.st.aborted, 7); assert.equal(bad.st.started, 8); assert.equal(bad.st.afterFailure, 0);
+  assert.equal(progress.nextHi, 1063, 'nothing of the failed chunk was committed');
+  assert.equal(progress.stats.cacheHits + progress.stats.cacheRejected + progress.stats.headers, 0, 'L1: no statistics from an uncommitted chunk');
+  assert.deepEqual((await scan(c, node(c), { chunk: 64, progress })).stats.headers, 64, 'the retry completes the same chunk');
+  // budgets that could not even admit one receipt list are refused
+  assert.throws(() => limitRpc(async () => null, { maxBytes: HISTORY_RPC_CAPS.eth_getBlockReceipts - 1 }), /invalid history RPC budget/);
+});
+
+test('r4 M1: per-index raw transactions of CONCURRENT receipt blocks share one global cap; a failed raw call aborts and settles the rest', async () => {
+  const c = history();
+  for (const maxCalls of [2, 3]) {
+    const own = slowNode(c, { ms: 5 });
+    const r = await scan(c, own, { chunk: 13, rawTransactions: 'per-index', receiptConcurrency: 4, rpcBudget: { maxCalls, maxBytes: HISTORY_RPC_BUDGET.maxBytes } });
+    assert.deepEqual(r.logs, c.expected, 'the same complete, ordered history under any budget');
+    assert.ok(own.st.max <= maxCalls, `all methods together: at most ${maxCalls} in flight (saw ${own.st.max})`);
+    assert.equal(own.st.max, maxCalls, 'the budget was reached, so it is what bounded the fan-out');
+  }
+  // receipt lists are charged 32 MiB each: a 64 MiB budget admits two at once even with receiptConcurrency 4
+  const wide = slowNode(c, { ms: 5 });
+  await scan(c, wide, { chunk: 13, rawTransactions: 'per-index', receiptConcurrency: 4, rpcBudget: { maxCalls: 32, maxBytes: 64 << 20 } });
+  assert.ok(wide.st.maxByMethod.eth_getBlockReceipts <= 2, `byte budget: ${wide.st.maxByMethod.eth_getBlockReceipts} receipt lists at once`);
+  // one raw transaction of block 1007 fails: its siblings and the other blocks' calls are aborted and settled first
+  const h1007 = c.headers.get(1007).hash;
+  const bad = slowNode(c, { ms: 60, failWhen: (m, p) => m === 'eth_getRawTransactionByBlockHashAndIndex' && p[0] === h1007 && p[1] === '0x1' });
+  await assert.rejects(scan(c, bad, { chunk: 13, rawTransactions: 'per-index', receiptConcurrency: 4, rpcBudget: { maxCalls: 6, maxBytes: HISTORY_RPC_BUDGET.maxBytes } }), /own node outage/);
+  assert.equal(bad.st.inFlight, 0, 'nothing of the failed scan is still in flight'); assert.equal(bad.st.afterFailure, 0);
+});
+
+test('r4 M1: the ACTUAL boundedRpc transport, one per method: an oversized header or raw-transaction reply is refused before its body is fully read; receipts keep 32 MiB', async t => {
+  const TOTAL = 24 << 20, piece = Buffer.alloc(64 << 10, 0x20), seen = [];
+  const server = http.createServer(async (req, res) => {
+    const chunks = []; for await (const b of req) chunks.push(b);
+    const { id, method } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
+    const rec = { method, written: 0, closedEarly: false }; seen.push(rec);
+    if (method === 'eth_getBlockReceipts') {                        // 6 MiB of valid JSON-RPC: inside the 32 MiB receipt cap
+      return res.end(JSON.stringify({ jsonrpc: '2.0', id, result: ['x'.repeat(6 << 20)] }));
+    }
+    res.writeHead(200, { 'content-type': 'application/json' }); res.write(`{"jsonrpc":"2.0","id":${id},"result":"`);
+    rec.done = new Promise(resolve => {
+      res.on('close', () => { rec.closedEarly = rec.written < TOTAL; resolve(); });
+      const pump = () => { while (!res.destroyed && rec.written < TOTAL) { rec.written += piece.length; if (!res.write(piece)) return res.once('drain', pump); } if (!res.destroyed) res.end('"}'); };
+      pump();
+    });
+  });
+  server.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
+  t.after(() => { server.closeAllConnections(); server.close(); });
+  const made = [];
+  const rpc = historyTransport(maxBytes => { made.push(maxBytes); return boundedRpc(`http://127.0.0.1:${server.address().port}`, { maxBytes, timeoutMs: 20000 }); });
+  assert.deepEqual(made.sort((a, b) => a - b), Object.values(HISTORY_RPC_CAPS).sort((a, b) => a - b), 'each method has its own transport with its own factory cap');
+  await assert.rejects(rpc('eth_getBlockByNumber', ['0x1', false]), /exceeds byte limit/);
+  await assert.rejects(rpc('eth_getRawTransactionByBlockHashAndIndex', [`0x${'aa'.repeat(32)}`, '0x0']), /exceeds byte limit/);
+  for (const rec of seen) { await rec.done; assert.ok(rec.closedEarly, `${rec.method}: the connection was cut at ${rec.written} of ${TOTAL} bytes`); }
+  assert.equal((await rpc('eth_getBlockReceipts', [`0x${'aa'.repeat(32)}`]))[0].length, 6 << 20, 'a large receipt list is still accepted');
+  await assert.rejects(rpc('eth_call', [{}, 'latest']), /serves no eth_call/);
+  assert.equal(seen.length, 3, 'a method outside the history set never reaches the node');
+  // the real transport under the scan-wide budget: the limiter charges each call its method's cap
+  const limited = limitRpc(rpc, { maxCalls: 4 }); await limited('eth_getBlockReceipts', [`0x${'aa'.repeat(32)}`]);
+  assert.deepEqual([limited.usage().calls, limited.usage().bytes, limited.usage().peakBytes], [0, 0, HISTORY_RPC_CAPS.eth_getBlockReceipts]);
+});
```
