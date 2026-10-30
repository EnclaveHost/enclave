# A1 live: Base anchor authenticated from our own L1 (root run, 2026-10-25 19:57:00–19:58:04 UTC)

**Verdict: `A1-authenticated`** (`a1-evidence.json`).

**The run:** root ran the published, unchanged A1 helper package (`../`) once, read-only, against **our own** pinned Helios light client and **our own** reth. This directory holds root's run script, the public configs, the outputs and the guard logs, copied verbatim from `outputs/rpc-production-final-20261025/l1-a1-live-1958/`. There are no private HOME/data directories and no keys.

## What was authenticated

| | Value |
|---|---|
| **L1 block (all reads pinned to it)** | 26,271,848, hash `0x3762b17e8235efae14eee170ee13c4f9b316dae37bfd4d9527915085db007cd4`, stateRoot `0x35948eab…c6f2`, finalized-header age **952 s** at the read (bound 1800 s) |
| **Portal** | `0x49048044d57e1c92a77f79988d21fa8faf74e97e` |
| **ASR (portal `anchorStateRegistry()`)** | **`0x909f6cf47ed12f010a796527f562bfc26c7f4e72`** |
| **Anchor game** | `0x343b3a99527af07d2cfb2652747b9e37715e21ac`, respected game type **621** |
| **Anchor N** | **52,866,960** |
| **Output root** | **`0xa996c517b0e797b56426059d57c93ac8352b21b61e04b2fc66866dd61d056700`** |

**Policy:** every A1 check passed. The registry was not paused; the game was respected, finalized, not blacklisted and not retired; status was DEFENDER_WINS. The game's rootClaim and l2SequenceNumber matched the anchor; `game.anchorStateRegistry` equalled the ASR; and the game type equalled the respected type.

**Read sources (`reads`):**
- **16 values** are `helios-call`: verified by the pinned Helios EVM over proofs against the light-client-finalized state.
- **3 accounts** (portal, ASR, game) are `mpt-proof`: verified by our own MPT code against the stateRoot of the header whose hash we recomputed.
- **Nothing** is plain-RPC.

## The ASR conflict, resolved by authentication

| Candidate | Source | `authenticatedMatch` |
|---|---|---|
| `0xdb9091e48b1c42992a1213e6916184f9ebdbfedf` | base v1.5.1 address-book fixture `addresses.rs:134` | **false**: stale for the live portal |
| `0x909f6cf47ed12f010a796527f562bfc26c7f4e72` | root's Helios-verified portal getter at the same L1 block (`../../l1-proof-window/retest-30s/portal-result.json`) | **true** |

The configured `asr` (`a1-config.json`) was taken from that verified getter read by `run.py`, not from either note. A1 then re-read the getter itself and required equality.

## N against the retained state floor

- **Inside the held floor:** N 52,866,960 ≥ the retained changeset/state floor **52,500,000**, by 366,960 blocks. N is **181,566 blocks below** the Base snapshot head 53,048,526.
- **Consequence for the anchor-bootstrap REVIEW** (`../../finality-investigation/anchor-bootstrap-review/REVIEW.md` §3):
  - U1 (unwind within the 140,000-block Distance guard) is **not** available;
  - the bootstrap needs the **held-floor** path (U2/W, with retention holding 52,500,000) until A3/A4 complete.

## Run facts

| Item | Value |
|---|---|
| Start, finish | 19:57:00.54 → 19:58:03.99 UTC (**≈ 63.5 s**, including Helios startup) |
| Evidence written | 19:58:03.973Z |
| Exits | `a1Exit` **0**; run rc **0** (`run.rc`); `a1.stderr` empty; Helios `processStopped: true` |
| Queue | shared at 256 MiB, peak **167 MiB** (`run.guard`, `run.out`) |
| Helios | `cc962e2b…`; checkpoint `0xb5d80340…7094` with 5 sources (`run-result.json` `heliosStatus`). The l1-authority config is published in `../../evidence/l1-own-client-1941/config.json`. |
| Code pins | `run-result.json` `inputPins` = `a1-anchor.mjs` `ec92b70f…`, `a1-read.mjs` `a501a3ec…`, `vendor/anchor-bootstrap.mjs` `90a8afba…`. These are identical to the files in `../`, which are **unchanged**; the parent `SHA256SUMS` still validates. |

**Preserved observations:**
- At 19:57:16 Helios logged `inconsistent block history detected: clearing cache` (`helios.out`). A1 still completed hash-pinned to the finalized block.
- Helios saved checkpoint `0xaecd21ee…a903` to its own data dir, which is not copied.

## What this is NOT

- **Not a state rebuild and not an activation.** **No A2–A4**: header N, unwind to N, and the hashing+merkle state-root rebuild at N are not done. No derivation restart, no production activation or cutover; Base is still disabled.
- **Not SNP or attested.** It is relative to Helios light-client finality (WS checkpoint plus sync committee). It is not SNP, attested or full-consensus authority, and our KVM endpoints were proof sources only.
- **Pins are observations, not approvals.** The `pins` (codeHash, storageRoot, EIP-1967 implementation/admin) are **authenticated observations at this block**, NOT comparisons against approved versions.
  - **Portal:** implementation `0x03863ab7…ca70`.
  - **ASR:** implementation `0x4483f964…b99d`.
  - **Shared admin:** `0x0475cbca…059e` for both portal and ASR.
  - **Game:** the two queried EIP-1967 slots are zero; this does not rule out other forwarding or upgrade mechanisms.

  There is no version approval and no upgrade protection.
- **A one-time bootstrap input.** The anchor game is one-time input for the snapshot bootstrap, not ongoing writer latency.

## Files

`run.py` (root's runner), `a1-config.json`, `a1-evidence.json`, `run-result.json`, `run.out`, `run.guard`, `run.rc`, `helios.out`, `a1.stderr` (empty). Every file is listed in `SHA256SUMS`.
