# Writer-authority freshness: what exists, why finalized-only cannot pass 120 s, and the smallest reviewable path (read-only source audit)

> **Corrections (16:45-16:51Z):** see **Addendum A** at the end. It records the r8 hash verification, the Helios eeffcc9 `latest` semantics, the native-input finality gate I had missed (`schedule_reader.mjs:158-162`), the trace of the 120 s requirement, and the options with their security properties.
> - **§4-§7 are partly superseded:** facts must keep a **finalized claim**; the provisional range may only establish current-ness. Addendum A replaces §7's "decision" framing.
> - **The path is still unqualified:** nothing is implemented, tested or measured.

## Scope and bytes (2026-10-26, 16:39-16:44Z; the earlier "~16:40-17:10Z" was wrong)
**No edit, test, build, network, queue, VM or live action.** Nothing here is a test result or a qualification. Enrollment (Claude50) and guest extraction (Claude370) are not touched or repeated.

**The requested tree is gone:** `accepted-image-enrollment-stage/r7/runs/20261026T163100Z-slice-2026124/repo` no longer exists. The job deletes it at the end (`root-accepted-image-enrollment-r7.sh:168`, `rm -rf $OUT/repo`).
- **What the run recorded:** `verdict.json` shows tree `1cc32f1c…` and enrollment 18/19 (`not ok 15`, commit in flight; that is Claude50's area).

**How I read the same content:** using that job's recorded composition (`:105-123`), without extracting the tree.
- **`relay/derived-writer-authority.mjs`** (sha256 `355ccdf8…7641a`, 364 lines) and **`relay/derived-reader-runtime.mjs`** (`cd62be18…f717`):
  - **built from:** r4 git `929fc19a` blobs, plus the three patches that touch them: enrollment `vs-r3`, `r2-vs-r1`, `r3-vs-r2-kvm2`;
  - **unchanged by later layers:** the r4-r7 patches do not touch these files (checked by file list);
  - **where:** reconstructed in `/tmp/wfa` (44 KB);
  - **not verified:** I did not compare them to tree `1cc32f1c`, because that tree no longer exists.
- **`network/*`** = the KVM r3 closure copies. `logs/kvm-overlay.json` lists them as overlaid; the closure SUMS are `14656ef5…`.
  - `lifecycle-finality-bridge.mjs` `a675c3f2…`
  - `derived-reader/provider.mjs` `8c68d914…`
  - `proof.mjs` `c5b2b0dc…`
  - `l1-runtime.mjs` `30a43313…`
  - `journal.mjs` `1ba1738a…`
  - `coverage-store.mjs` `0d6a6121…`
  - `deployment-lifecycle-journal.mjs` `14471c5e…`
- **`network/derived-reader/lifecycle.mjs`** is base `3e8538a4…`.
- **Also read:**
  - `relay/lease-generation.mjs` (base);
  - `network/chain-authority.mjs` (assets r2 run repo; not in any later patch list);
  - `verifier-canonical-evm-stage/README.md`;
  - `logs/claude-finalized-writer-adapter-r2.md`;
  - `logs/claude-accepted-image-state-audit.md`.

## 1. Exact current interfaces
**Writer authority** (`relay/derived-writer-authority.mjs`):
- `MAX_ANCHOR_AGE_SEC = 120` (`:33`); construction refuses any value outside 1..120 (`:192-193`).
- **The check:** `stale_snapshot` if `v.time > t+5 || v.time < t − 120` (`:266-267`), where `v.time` = the Base block timestamp of the bridge's anchor (`:207`). It runs **before** the deny-only check (`:275`).
- **Capability:** `{ snapshot(read), readDerivedLogs(query) }` (`:185-186`, `:359`).
  - `snapshot(read)` hands `read(client, number)` a client pinned to the anchor block. The row, schema and book are read at B, and the lease logs are read with `anchor {number: B, hash}` (`:205-223`).
- **Deny-only "fresh" check** (`:235-256`): the local verifier's head, logs after B, and the row and book at head. It can only refuse.
- **Result labels:** `evidence.tier: "l1-finalized-derived"` and `block.finalized: v.B` (`:278-280`).
- **Wiring:** `derivedWriterAuthorityFromEnv` (`:294-364`) starts `startDerivedLifecycleReader` in-process (`:347`/`:349`). The reader config's own `maxAnchorAgeSec` bounds only KVM's reader (`:360-361`).

**Bridge** (`network/lifecycle-finality-bridge.mjs`):
- `readAnchor` must return `tier === 'l1-finalized-derived'` (`:31`); its age bound is 20..3600 s (`:14`).
- The derived anchor's hash, stateRoot and time must equal the **local verifier's** header at that number (`match`, `:47-53`, checked twice).
- The read goes through `pinnedClient` at the anchor hash (`:54`).
- `journal.acceptAnchor` runs **before** publishing (`:58`). This is persisted floor (b).

**Reader** (`network/derived-reader/provider.mjs`):
- The derivation's L1 head is **always** `l1.finalized()` (`:89`).
- The native v3 result is bound by `bindNativeV3`, which hard-labels `tier: 'l1-finalized-derived'` (`proof.mjs:79`).
- Each accepted result is journaled (`:122`) and becomes the next `agreed` (`:129`). It is served as `latest` only if its age ≤ `maxAnchorAgeSec` (20..3600, `:132-137`).
- `readAnchor`/`readDerivedLogs` re-check the age and that the L1 head still matches the light client (`consistentL1`, `:51-55`, `:65-71`, `:144-152`).

**L1** (`l1-runtime.mjs`):
- the pinned Helios **ethereum** mode (`cc962e2b`) with the reviewed checkpoint;
- only `finalized({maxAgeSec ≤ 3600})` is exposed (`:86-89`);
- the generic `request` exists (`:68`, `:85`).

**Persisted tiers are finalized-only:**
- `journal.mjs:16`, `:64`;
- `deployment-lifecycle-journal.mjs:51`;
- `coverage-store.mjs:78`, `:95`.

**The original authority that defined "120 s"** (`relay/lease-generation.mjs:129`, `:214-242`):
- B = the second-highest head of agreeing **public RPCs**, minus 2 confirmations, with `maxBlockAgeSec 120`;
- so the 120 s ceiling was calibrated for a head−2 (unsafe/latest) tier.

## 2. Why the finalized derived anchor can never pass 120 s (not an implementation gap)
**The timing:**
- An `l1-finalized-derived` Base block can only be derived once the L1 block carrying its batch is **finalized**: two epochs, 64 × 12 s ≈ 12.8 min after inclusion, plus the batcher's posting delay and the derivation run.
- So `now − v.time` ≥ ≈ 13 min at every use, and `:266` must refuse.

**What would make it pass, and why none is acceptable:**
- **Raising the ceiling:** forbidden.
- **Re-labelling an old anchor as fresh:** "inventing freshness", forbidden.
- **Taking freshness from something newer than L1-finality:** the only remaining route, examined in §3-4.

## 3. The "existing independently verified recent native-validated branch" is the unsafe tier
**What exists:** the relay's local verifier (`network/chain-authority.mjs`; Helios opstack, the canonical-integration pin `8250f08a`).
- It is recent and proof-executed: the EVM runs locally over proven state, and `requireCanonical` requires parent-hash ancestry.

**Where its authority comes from:**
- its head is "**the verifier's sequencer-signed unsafe head**" (`chain-authority.mjs:7`, `:30`);
- it refuses `safe`/`finalized` tags because it has no such tier (`:205-206`);
- it describes itself as `tier: 'unsafe', finality: 'none'` (`:231`);
- `eth_getLogs` proves **inclusion, not completeness** (METHODS).

**Consequences:**
- Using its head time as the anchor time **is** "unsafe head as authority". Its blocks after B are defined by the sequencer key, not by L1. They can be reorged out by derivation, and a missing Released/Claimed log cannot be detected.
- **It cannot even link to B:** its canonical-ancestry check is bounded at depth 256 (`verifier-canonical-evm-stage/README.md:27-28`). That is ≈ 8.5 min of 2 s Base blocks, while a finalized B is ≈ 385+ blocks behind head. So it cannot prove "H descends from the finalized B" through its existing interface.
- **Correct current use:** deny-only (`derived-writer-authority.mjs:18-20`, `:235-256`). It must stay so.

## 4. The only recent branch that is neither unsafe nor public-RPC: SAFE derivation
**Already built:**
- the same pinned native v3 derivation (`49f4d7e3…`) derives and executes Base from **any** `l1Head` it is given, up to the latest Base block whose batch is included at or below it, i.e. OP's safe head;
- the same owned light client supplies L1 headers.

**What is missing is only the L1 head selection and a provisional track.**

**Trust anchor vs live branch:**

| | **finalized trust anchor (unchanged)** | **live SAFE branch (new, provisional)** |
|---|---|---|
| L1 head | `l1.finalized()` | the same light client's latest **attested** header (new `l1.attested({maxAgeSec})`, which reads `latest` via the owned runtime) |
| Base data | batches in finalized L1 blocks | batches in included, **not yet finalized** L1 blocks |
| executed by | native v3 in-domain | native v3 in-domain (same binary, same witness checks) |
| starts from | ASR bootstrap, then `agreed` | the latest finalized `agreed` (or the previous provisional link whose L1 head is still canonical) |
| persisted | `journal.accept`, bridge `acceptAnchor`, coverage store, replicated floors | **never**: memory only; never `agreed`, never a floor, never in coverage-store or replica |
| added risk | none | L1 re-org before finality, which can remove or replace the batch; detected at use by `consistentL1` and dropped |
| writer use | stays refused (`stale_snapshot`) | allowed **only** if `now − v.time ≤ 120` at use, the identical `:266` check |

- **No new signer trust:** the L1 header comes from the same pinned light client. The added risk is L1 fork-choice before finality, not a new signer.
- **To confirm by a source check of the pinned Helios build:** how it serves `latest` (whether it is sync-committee attested and what its age is). I did not verify this.

**Unknown whether it can meet 120 s; I do not estimate it.** The budget must be measured:
- the Base unsafe→safe posting lag;
- the attested L1 lag;
- the native run;
- witness production;
- the read.

If p99 of that end-to-end does not fit comfortably inside 120 s, this path is also impossible and the source stays blocked (see §7).

## 5. Minimal changes (only if the decision in §7 is taken and the measurement passes)
**KVM-owned (`network/…`, KVM's closure; not mine to edit):**
1. **`derived-reader/l1-runtime.mjs`:** add `attested({ signal, maxAgeSec })`, with `maxAgeSec` ≤ 60, refusing future timestamps, via the owned `request`. Leave `finalized` unchanged.
2. **`derived-reader/proof.mjs`:** `bindNativeV3(result, input, header, l1Head, tier)`.
   - The tier is passed **only** by provider code, according to which L1 call produced `l1Head`. It is never taken from input or JSON.
   - Allowed values: `'l1-finalized-derived' | 'l1-safe-derived'`.
3. **`derived-reader/provider.mjs`:** a separate provisional track (`prepare/submit` with `{ track: 'safe' }`, or `prepareSafe/submitSafe`).
   - **Memory and persistence:** it keeps `provisional = { anchor, coverage }` in memory only. It **never** calls `journal.accept` and never sets `agreed`. `coverageStore.stage` is not used for it.
   - **Re-checks:** `consistentL1(provisional.l1)` on every read.
   - **Dropped when:** the L1 block hash changes, or the finalized track passes it. If finalized contradicts it, fence and log.
   - **`readAnchor({ tier })`:** the default stays finalized.
   - **`readDerivedLogs`** for a provisional anchor = the persisted coverage `[availableFrom, B_final]` plus the in-memory provisional `(B_final, S]`. It must be contiguous; otherwise `coverage_incomplete`.
4. **`derived-reader/coverage-store.mjs`:** `read(query, anchor, { overlay })` serves the provisional overlay with **no write path**.
5. **`lifecycle-finality-bridge.mjs`:**
   - accept `'l1-safe-derived'` only when constructed with an explicit `allowSafe` (from the writer path);
   - keep the floor rollback check and the verifier `match()`;
   - **skip `journal.acceptAnchor` for the safe tier**, so bridge floor (b) stays finalized-only.
6. **No change:**
   - `journal.mjs:16`/`:64`, `deployment-lifecycle-journal.mjs:51` and `coverage-store.mjs:78`/`:95` stay finalized-only. That is the invariant tested below.
   - enrollment, replica, checkpoint and ASR bootstrap.

**Relay (ours):**
7. **`relay/derived-writer-authority.mjs`:**
   - request the safe snapshot;
   - **keep `MAX_ANCHOR_AGE_SEC = 120` and `:192-193`/`:266-267` byte-identical**;
   - keep the deny-only check;
   - fix the labels: `evidence.tier = 'l1-safe-derived'`, `block.finalized = <the finalized anchor number>`. Today `:278` writes `finalized: v.B`, which would be false for a safe B.
   - The lease16 fact bytes are unchanged; whether consumers must see the tier is part of the §7 decision.
8. **`relay/derived-reader-runtime.mjs` / `derivedWriterAuthorityFromEnv`:** pass `allowSafe` **only** when the enrolled reader config (inside KVM's signed `binding`) carries the reviewed safe-tier policy.
   - Never from env or the caller, so enabling it changes the binding: an admin-controlled, signed change.
   - Admin controls are otherwise untouched.

## 6. Test cases (fixtures; root runs; none run by me)
1. **The ceiling is unchanged:**
   - for safe anchors, age 120 is accepted, 121 refused, +5 s accepted, +6 refused;
   - `maxAnchorAgeSec` 121/600/3600 still throw;
   - the stale refusal happens before the deny-only check.
2. **The default is unchanged:** without the signed safe policy, a 13-min finalized anchor still gives `stale_snapshot`, and existing tests pass unmodified.
3. **Tier provenance:**
   - an anchor labelled `l1-safe-derived` from JSON, ASR or `finalized()` is refused;
   - only `attested()` → native → `bindNativeV3(..., 'l1-safe-derived')` produces it.
4. **Never persisted:** safe anchors cannot reach `journal.accept`, `acceptAnchor`, `coverageStore.stage` or the replica (each throws or is not called).
   - After safe runs plus a restart, floors equal the last finalized and recovery re-derives from ASR + floors.
5. **L1 re-org:** the light client's hash at the provisional `l1.number` changes, so `readAnchor`/`readDerivedLogs` refuse, the provisional state is dropped, and no fact is issued.
6. **Coverage merge:**
   - a Claimed in `(B_final, S]` replays to the row;
   - a Released in `(B_final, S]` gives `lease_not_current`;
   - a gap or overlap between the persisted and provisional ranges gives `coverage_incomplete`.
7. **Finalized catches up:** the provisional S equals the finalized hash at S, so it is superseded silently. A contradiction fences the reader and logs the claim/block of any fact issued from S.
8. **The unsafe verifier stays deny-only:** its newer head cannot refresh `v.time`; its silence creates no fact; a re-claim or release it reports refuses.
9. **Attested L1 bounds:** an attested header older than `maxAgeSec`, from the future, or on another chain is refused.
10. **No public RPC:** URL or endpoint configs are still refused (`:302-303`), unchanged.

## 7. Decision required (smallest, user-reviewable; no silent relaxation)
**Under today's trust assumptions** (L1-finalized only; unsafe = deny-only; no public RPC), **a writer fact within 120 s is impossible** (§2).

**The smallest architecture decision that could make it possible without touching the ceiling:**

> **Allow writer facts at tier `l1-safe-derived`:** Base blocks whose batches are included in, but not yet finalized by, L1. They are derived and executed in-domain by the same pinned native binary from the same pinned light client, held only provisionally (never a floor or persisted state), and enabled only through the signed reader binding. The 120 s ceiling is unchanged. **The residual risk is an L1 re-org before finality** removing or replacing the batch that contains the claim or a later release. Decide also:
> - (a) whether such facts must be re-confirmed when that range finalizes, and what happens to a fact whose claim is re-orged away (revocation or alarm);
> - (b) whether consumers must see the tier.

**Precondition, before any code:** measure on root's own nodes, without inventing numbers:
- the Base safe-lag distribution over days (`optimism_syncStatus` safe vs. now);
- the pinned Helios's `latest` lag;
- native v3 and witness time for typical incremental ranges;
- the end-to-end pipeline.

**If p99 does not fit inside 120 s with margin, decline, and the derived writer authority stays blocked.**

**Not proposed:**
- raising or bypassing 120 s;
- using the unsafe verifier head (or its 256-deep ancestry) as authority;
- public-RPC agreement;
- relabelling finalized anchors.

**Whatever is decided, until it is implemented and qualified:** writer authority under `derived` stays `stale_snapshot` (unproven). Production keeps its existing selection (legacy quorum or the explicit unproven refusal, `:286-293`), and `derivedReader` stays unbound per the state audit.

---

## Addendum A (2026-10-26 16:45-16:51Z; read-only; no tests, builds, network, queue, live or edits to source)

### A0. r8 hashes verified against the live composed tree
**Checked at 16:45:10Z** in `accepted-image-enrollment-stage/r8/runs/20261026T164255Z-check-2039391/repo`. Its HEAD is `7fbc305` ("accepted-image-enrollment release (generated files)"), tree `90e4cdaa…`.
- **Commands I ran in that tree:** only `sha256sum`, `cp` of 14 small files to `/tmp/wfa/` (about 0.5 MB), and the read-only `git log -1` and `git rev-parse`. The job was not stopped or modified, and the repo was still present at 16:49:14Z.
- **Both reconstructed files match byte for byte:**
  - `relay/derived-writer-authority.mjs` `355ccdf8…7641a`
  - `relay/derived-reader-runtime.mjs` `cd62be18…f717`
- **Every `network/` digest in the scope section matches.**
- **Also recorded:**
  - `relay/derived-state-commit.mjs` `0273236c…`
  - `network/derived-reader/lifecycle.mjs` `3e8538a4…`
  - `network/chain-authority.mjs` `d4a4f14e…`
  - `relay/lease-generation.mjs` `8a0831b9…`

### A1. Pinned L1 light client `cc962e2b`: what `latest` actually is
**Source:** `cc962e2b` = Helios `eeffcc9` without the canonical-block patch (`scripts/rpc-runtime/closure.json:67`, `docs/network/local-chain-verifier.md:129`). I read `verifier-canonical-stage/base-eeffcc9/`.
- **Only finality updates are fetched:** `advance()` calls `get_finality_update` only and never an optimistic update (`ethereum/src/consensus.rs:439-461`).
- **`latest` = the attested header of the latest verified finality update:**
  - `apply_generic_update` sets `optimistic_header = update.attested_header` when `committee_bits > safety_threshold`, i.e. **more than half of the maximum recent sync-committee participation**, and the slot advances (`consensus-core/src/consensus_core.rs:153-158`, `:512-517`).
  - `send_blocks` serves it as `latest` (`consensus.rs:463-492`).
  - **Requirements:** a BLS aggregate signature of the current or next sync committee over the attested beacon header, `signature_slot > attested slot`, and a valid execution-payload proof (`consensus_core.rs:248-360`).
  - **No fork-choice finality.**
- **`finalized` additionally requires:** `committee_bits·3 ≥ 2·512` (has_majority) **and** a valid finality branch from the attested header (`consensus_core.rs:176-184`, `:302-320`).
- **`safe` is not a separate tier:** the `Safe` tag returns the **finalized** block (`core/src/execution/providers/block/block_cache.rs:73-76`). So "safe" in this client means finalized; an L1 "safe" head is not available.
- **Blocks by number** come from:
  - the cache (parent-hash-consistent with pushed `latest` blocks; cleared on inconsistency, `block_cache.rs:112-150`);
  - otherwise EIP-2935 history **read with verified account access at the trusted `latest` block** (`historical/eip2935.rs:58-135`, `:91`, `:118`).
- **Consequence:** today's finalized path already authenticates historical L1 headers through the sync-committee-signed `latest` root. That covers `schedule_reader` `blockByNumber(anchor)` and the reader's `consistentL1`.
- **What using `latest` as a derivation L1 head adds:** no new signer set. It adds:
  - (i) L1 fork-choice re-org exposure;
  - (ii) the lower (> ½ of recent maximum) participation gate on the head itself, instead of ≥ ⅔ plus a finality proof.
- **Not measured:** the lag of `latest` behind wall time (one finality-update cadence plus about 1 slot by construction).

### A2. Does the native derivation support a recent L1 head today? **No, by the JS gate. The native harness itself is finality-agnostic.**
**The harness:** it takes `l1Head`/`l1HeadNumber` as trusted hashes into OP boot keys and binds them in the result (`derivation-client-stage/src/examples/derivation_harness.rs:33-41`, `:94-118`; v3 `derivation-lease-coverage-stage/src/zk-utils/examples/derivation_harness_lease_v3.rs:661-673`). Nothing there encodes finality.
- I read only these Rust excerpts, not the full upstream client.

**The finality gates, all in JS:**
- `provider.mjs:89`: `l1Head = l1.finalized()`.
- **The pinned vendored schedule reader** refuses `not_finalized` when `anchor.number > Helios finalized`, before **and** after the read (`vendor/schedule_reader.mjs:10-15`, `:158-169`). Its header states the anchor "is never a provider label ('finalized'/'latest')".
- `proof.mjs:79` hard-labels `l1-finalized-derived`.
- **Persisted tiers:** `journal.mjs:16`, `:64`; `deployment-lifecycle-journal.mjs:51`; `coverage-store.mjs:78`, `:95`.

**So a recent-head derivation also needs a reviewed change to the vendored schedule reader.** My §5 omitted this; it is a correction. The change would be a provisional mode in which:
- the anchor is ≤ Helios `latest` and equals Helios `block(anchor.number)`;
- the schedule is read at the anchor;
- the finalized floor ≤ anchor.

### A3. Where the 120 s comes from
**Normative requirement** (`work/storage-fencing-implementation-interface.txt` §5): the title is "**WRITER AUTHORITY FACT (who may preempt; availability, not safety)**".
- For lease16, `gen = (16<<48) | claimBlock<<16 | claimLogIndex` "(live rev 16: the **finalized** Claimed log)".
- "The deliverer … MUST compute it from **FINALIZED chain reads** of the lease it is releasing for."
- **Safety is the fence:** a monotonic `gen‖counter‖iid` raised at indexd; a lower or equal fence gets 409; readiness needs confirmation rounds (§2-§4).

**Legacy implementation** (`relay/lease-generation.mjs`):
- the header requires the **claim** to be FINALIZED ("a reorged claim could otherwise leave a fence no later holder … could ever raise above", `:16-17`);
- step 5 enforces it with `claim_not_final` (`:309`);
- separately, the **current-lease state** (row active/runner/operator/leaseUntil, plus replay of logs from the claim to B) is read at B = the second-highest public-RPC head − 2, refused if `S.time < now − maxBlockAgeSec` (default **120**, `:129`, `:222`, `:242`).

**Conclusion:**
- **Claim finality** is the protocol/security requirement: fence monotonicity.
- **The 120 s** is the legacy reader's **current-lease state freshness** bound on an unsafe-tier, RPC-quorum snapshot. It is an availability property (who may preempt now). No document I found derives 120 from a security argument; it is the reader's default, kept by policy in r2 as "never raised".
- **The current derived adapter conflates the two:** `derived-writer-authority.mjs:266` applies 120 s to the **finalized** anchor that also supplies the claim, which is why it can never pass.

### A4. Two different ages
| age | what it bounds | legacy | derived today | must stay |
|---|---|---|---|---|
| **authority state freshness** | the block whose state proves "this claim is still the current lease" | B (head−2) ≤ 120 s | the finalized anchor ≤ 120 s (impossible) | ≤ 120 s, never raised |
| **claim finality** | the block of the Claimed log that sets `gen` | claim ≤ RPC `finalized` | claim ≤ the finalized anchor (coverage) | finalized, never provisional |
| **verification / liveness age** | how old the reader's finalized anchor, L1 header and checkpoint may be while still serving | n/a | reader `maxAnchorAgeSec` 20..3600 (`provider.mjs:35`), bridge 1800 (`lifecycle.mjs:10`), L1 finalized ≤ 1800 (`l1-runtime.mjs:86-88`), checkpoint 7 d (`:28`, `:65`) | unchanged |

**Rules for every option:**
- **No log absence as evidence:** a missing Released or Claimed log from an inclusion-only source (`chain-authority.mjs` METHODS `eth_getLogs`) is never evidence of absence.
- **Positive evidence is either:**
  - (a) **state** proven against an authenticated block's state root (the row: a release zeroes the runner; another runner's claim changes it), or
  - (b) **complete coverage** asserted by the pinned native v3 executable over the executed range.
- **The same-runner gap:** a same-runner release + re-claim leaves the row's runner and operator unchanged (rev 16d has no generation field, `lease-generation.mjs:7`), so only (b) or complete receipts detect it.

### A5. Options and their security properties
**A. Finalized-only, queued execution.** Answer only from the finalized derived anchor, delaying delivery until it covers the request time.
- **Claim finality:** ✓. No unsafe, no public RPC: ✓.
- **State freshness at delivery:** ≥ L1 finality + batch lag (about 13 min or more) ✗.
- **Passing 120 s would require** measuring age against the request time instead of the delivery time. That is a weakening: the exposure window at delivery becomes the finality latency.
- **Per §5 the exposure is availability, not data safety:** a no-longer-current holder may preempt until the new holder raises.
- **Code:** none in KVM; the relay changes only the age reference. **Not compatible with "do not weaken 120 s".**

**B. Safe-provisional with monotonic finalized floors.** This keeps the legacy two-part shape, with derived trust.
- **Claim:** from the **finalized** derived anchor B_f with complete coverage to B_f. Claims in `(B_f, S]` give `claim_not_final` (retry), as in legacy step 5. `gen` is always finalized.
- **Current-ness:** at a provisional anchor S derived natively by the same v3 binary with `l1Head` = Helios `latest` (A1).
  - complete coverage `(B_f, S]` gives no Claimed/Released after C, as positive coverage;
  - the row at S is read through the bridge `pinnedClient` at S's **derivation-authenticated** hash (the local verifier is only a proof transport there, `lifecycle-finality-bridge.mjs:47-55`);
  - **`now − S.time ≤ 120`**, the unchanged `:266` expression.
- **Floors:** the journal, bridge floor, coverage store and replica stay **finalized-only and monotonic**. S is memory-only and never `agreed`. It is dropped when Helios's hash at `S.l1.number` changes, or when finalized passes it; a contradiction fences the reader.
- **Trust added:** L1 pre-finality re-org, and the > ½-participation attested head (A1). No unsafe tier, no public RPC.
- **Residual:** an L1 re-org can drop the batch containing a Released log that S showed, or add one S lacked. That is the availability exposure §5 describes, bounded by L1 re-org depth instead of 120 s of sequencer data.
- **Feasibility:** unknown until M1-M4 are measured.
- **Code** (KVM-owned, root coordinates):
  - `l1-runtime.mjs` (a `latest()` with a maximum age);
  - `vendor/schedule_reader.mjs` (provisional anchor mode; reviewed, since it is pinned);
  - `proof.mjs` (tier parameter);
  - `provider.mjs` (provisional chain rooted at `agreed`, each link's L1 head re-checked);
  - `coverage-store.mjs` (read-only overlay);
  - `lifecycle-finality-bridge.mjs` (two-anchor snapshot; journal only B_f).
- **Code** (relay): `derived-writer-authority.mjs`:
  - split `derivedRead` into claim at B_f and state at S;
  - apply 120 s to `S.time`;
  - apply the liveness bound to B_f;
  - `evidence {tier: 'l1-safe-derived', claimTier: 'l1-finalized-derived', finalized: B_f, state: S}`;
  - fix `block.finalized` (`:278`).
- **Fact bytes:** unchanged.

**C. Current-claim state from the local verifier.** The claim is from B_f (finalized); current-ness comes from the proof-verified row at the verifier's head H, with `now − H.time ≤ 120`.
- This is the row read that `denyIfStale` already does (`derived-writer-authority.mjs:242`, `:254-255`), promoted from deny-only to positive evidence.
- **Claim finality:** ✓. No public RPC: ✓. **120 s:** ✓, H is about 2 s old.
- **But current-ness then rests on the sequencer-signed unsafe head** (`chain-authority.mjs:7`, `:30`, `:231`): the same tier as the legacy head−2, with one trusted signer instead of an RPC quorum. **That conflicts with the stated constraint "not accepting unsafe head as authority"; this is a fact about the option, not a preference.**
- **Same-runner gap:** release + re-claim in `(B_f, H]` is undetectable by the row. It is detectable only by complete receipts: `eth_getBlockReceipts` is checked against each verified block's receipts root, but over roughly 400-600+ blocks (cost unmeasured, M6), and verifier ancestry is limited (depth 256, §3).
- **Code:** relay-only, small.

**Assessment against the stated constraints:**
- **Only B satisfies all four** (keep 120 s, no invented freshness, no unsafe authority, no public RPC). It also matches the normative §5 requirement and the legacy two-part semantics.
- **A violates the 120 s constraint; C violates the unsafe-authority constraint.**
- **B is implementable under the RPC authorization** once KVM ownership is coordinated, but **its feasibility is unmeasured**. If M1-M4 show p99 S-age > 120 s, B cannot ship, and the remaining choices are A or C, each conflicting with one stated constraint.

### A6. Unresolved measurements (root, own nodes only; nothing estimated here)
- **M1:** Base safe-head lag vs wall time (`optimism_syncStatus` `safe_l2.timestamp` vs now): p50/p99/max over days.
- **M2:** the age and update cadence of Helios `cc962e2b` `latest`.
- **M3:** native v3 + witness time per provisional increment (6/30/60/120 blocks) and for a cold B_f→S run (≈ 400-700 blocks; `maxBlocks` 1800, `nativeTimeoutMs` 180 s).
- **M4:** coverage overlay read + bridge snapshot + deny-only check, end to end.
- **M5:** historical L1 re-org depth and Base unsafe re-org frequency (policy input).
- **M6:** for C only: the cost of complete receipts over `(B_f, H]`.

### A7. Additional tests for B (beyond §6; still not run)
- **Claim finality:**
  - a claim in `(B_f, S]` gives `claim_not_final` and never a fact;
  - a `gen` from a provisional block is impossible (it throws).
- **Positive coverage:**
  - a Released in `(B_f, S]` gives `lease_not_current`;
  - another runner's claim in `(B_f, S]` gives `lease_not_current` or `claim_not_final`;
  - a same-runner release + re-claim in `(B_f, S]` is caught by coverage (and the row alone is never accepted).
- **The two ages:**
  - `S.time` at 121 s gives `stale_snapshot` even with B_f valid;
  - B_f older than the liveness bound refuses even with S fresh.
- **Schedule reader (provisional mode):**
  - anchor > Helios `latest`, anchor hash ≠ Helios `block(n)`, or the finalized floor > anchor: refused;
  - the finalized mode is byte-identical.
- **L1 head:** the Helios `latest` slot regresses or the hash at `S.l1.number` changes, so S is dropped and no fact is issued.
- **Floors:** stay monotonic and finalized-only across safe runs, restarts and failovers.
- **Unsafe-verifier rules unchanged:** its silence never creates a fact, and a newer verifier head never refreshes `S.time`.

**Status:** the path is **not implemented, not tested and not measured**. Writer authority under `derived` remains `stale_snapshot` until B is built and qualified, and production keeps its existing selection.
