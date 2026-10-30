# Historical L1/blob readiness for the first Base launch (evidence; no prefetch; no actual safe origin claimed)

**What I did:**
- read sources;
- made **4** bounded read-only requests to our own L1 (EL `127.0.0.1:28645`, CL `127.0.0.1:25052`), via the shared 512 MiB queue (`claude-historical-blob-probe-1` with 3 requests, `-probe-2` with 1).

Raw outputs are in `historical-blob-readiness-stage/logs/` (`SHA256SUMS` listed in that stage).

**What I did not do:** no public provider, no blob payload or bulk download, no SSH, no mutation, and no change to the downloader, extraction, candidate 80cea, native or retention stages. The 16 GiB floor and existing apps are untouched.

## The key finding: the coverage reference must be the launch anchor N, not the snapshot's safe head

- **What the existing coverage procedure assumes.** `coverage/coverage_gate.py` (`need_from = safe.l1Origin − SEQ_WINDOW 3600`, `HARD_MAX_BLOCKS = 30000`) takes `safe` from `coverage/origin_extract.py` (6b63b901). That tool reads only the snapshot's persisted `ChainState[LastSafeBlock]`/finalized labels. Snapshot manifest 1f0c4e6c is at block **53048526**.
- **What the first launch actually does.** It bootstraps from the **original game anchor N = 52866960**:
  - the source-pinned receipt b9a90847;
  - harness-first `_initial_ok` requires it;
  - A3 unwinds the DB to N.

  After that, our Base node must **re-derive from N**, so it needs L1 data from about **l1Origin(N) − 3600**. That is 181,566 Base blocks (~4.2 days) earlier than the snapshot head the procedure measures.
- **No tool extracts block N's origin.** `origin_extract.py` has **no per-block mode**. It cannot extract the L1-attributes deposit of block N.

## Numbers (estimates and hints; NOT the exact origin)

**Inputs:**
- **Base N timestamp** = 1686789347 + 2·52866960 = **1792523267 (2026-10-20T19:07:47Z)**, from the compiled genesis rule.
- **HINT** (untrusted for derivation; pre-fetch planning only): L1 block **26235782** has timestamp **1792523243** (own EL, probe-2), 24 s before N. So l1Origin(N) ≲ 26235784.
  - The **exact** l1Origin(N) must come from block N's own L1-attributes deposit (static files ≥ 48000000 after extraction).
  - Later verification must bind that exact origin and each blob's KZG commitment. The derivation client already KZG-checks every blob it uses.
- **need_from(N) hint** ≈ 26235784 − 3600 ≈ **26232184** (the conservative seq-window rule).
- **Own L1 finalized now (probe-1, 10:15:42Z):** EL **26276116** at 1793008727; CL finalized slot **15515392**.

**Results:**
- **Range now:** need_from(N) → finalized ≈ **43,933 L1 blocks**, already **above the reviewed 30000 cap**.
  - It crossed 30000 at about 2026-10-24 12:00 UTC (estimate).
  - It was already about 33.7k at the snapshot time.
  - It grows by about 7,200/day.
- **Consequence:** under the existing gate, an N-anchored launch can **never** pass a single `need_from → finalized` coverage run.
- **Oct 28 deadline:** the earlier "~2026-10-28 16:00 UTC" deadline (`logs/claude-historical-blob-live-0547.md`, my own estimate for the *snapshot-safe-head* reference) **does not apply** to an N-anchored launch. It remains an estimate, not proof.

## Actual retention and availability of our own L1 (probe-1 + earlier evidence)

- **Lighthouse v8.3.2** (`/lighthouse/database/info`):
  - `prune_blobs` **true**, `blob_prune_margin_epochs` **0**, `epochs_per_blob_prune` **256**. That is the standard 4096-epoch blob/column window, deleted in batches of about every 27 h.
  - `--semi-supernode` (wrapper `chain_service.py:949`).
  - CL **blocks** go back to `oldest_block_slot` **15214144** (anchor 15508320).
  - This version returns `blob_info`/`data_column_info` as `null`. The last observed `oldest_data_slot` is **15382624** (05:46 UTC today, `logs/historical-blob-live-0547/`).
- **Reth EL:** history from **26100000** (code-4444 evidence from earlier today), covering need_from(N) ≈ 26232184.
- **Retention deadline for need_from(N):**
  - ≈ slot 15471600 + 131072 → pruning becomes possible from **≈ 2026-11-07 13:00 UTC** (estimate; the batching can delay it by up to about 27 h, never advance it);
  - for the ~43.9k-block range itself, data for later blocks lasts longer.
- **So the data is still physically present and retained** in our own CL/EL for the whole N → now range.

## Prefetch decision

- **Not now.** Nothing is lost before about Nov 7. The disk is about 96% busy extracting. A prefetch would compete with extraction and needs the exact origin anyway.
- **No bulk work was started.**
- **No new tooling was prepared:** no missing piece blocks preservation before Nov 7.

## Concrete next actions

1. **Root decision (before any N-anchored coverage claim):** the coverage reference is N's L1 origin, and the reviewed cap of 30000 cannot span need_from(N) → finalized (≈43.9k now). Either:
   - review a gate run over **contiguous ≤30000-block segments** of the same range (same per-block checks, no redefinition of "complete"); or
   - review a different anchor (a source re-pin; first bootstrap is pinned to b9a90847/N).

   I changed nothing.
2. **After state extraction finishes (~3 h):** obtain the **exact** l1Origin(N) from block N's L1-attributes deposit. This needs a per-block read in the `origin_extract.py` style (read-only mount + scratch view), because the existing tool reads only LastSafeBlock/finalized. It is a small, bounded follow-up; not done now.
3. **Then:** compute exact `need_from(N) = l1Origin(N) − 3600` and check our CL's availability over the range in ≤30000 segments (per root's decision). Everything must complete well **before ≈ 2026-11-07 13:00 UTC**, the earliest possible pruning of need_from(N)'s blob data. That date is an estimate from slot arithmetic and today's observed window, not proof.

Production is unqualified. No coverage verdict is claimed and no actual safe origin is asserted.
