# Native artifacts: two root builds BUILT and offline CLI-SMOKED only (2026-10-26 UTC)

**What this record is:** the bounded source, preparation and actual receipts of two completed root native builds.
- **What it proves:** each artifact was **built**, and it passed an **offline CLI smoke** (`--version` / `--help`).
- **NOT installed, deployed or released.**
- **NOT shown:** SNP or attestation qualification, a proof-path or end-to-end validation, readiness, finality, or
  production fitness.
- **Not reproduced:** neither build is an independent reproduction. **Custody v2 stays REFUSED.**

## 1. Canonical Helios verifier CLI: `root-canonical-helios-build-0046`, rc 0

**Artifact:** `helios` **`8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378`** (125121704 bytes). It
is **not included here**.
- **ELF metadata:** Build ID `7e055ade…`; rustc 1.96.0; LLD 22.1.2; NEEDED libc, libm, libgcc_s and ld-linux, a subset
  of the pinned glibcRuntime; highest GLIBC 2.39.
- **Build type:** a debug build (`dev`, opt 0) with 32 absolute build-path strings (informational).

**Source:** committed Helios `eeffcc9` (tree `2171ad2b`, lock `28f4400c`) **plus `canonical-block.patch` `41667ec9`**
(`PATCHED.sha256` `7e87fad8`). The pinned `vendor-inspect` is `9784e20a` / `c9301490`, and `INPUT-MANIFEST` is
`df1f198a`.
- **Same source as tested:** this is exactly the source that passed the canonical tests (35 named + 91 core), 12/12
  required controls (corrected reevaluation `93c65ee9`), and the EVM tests (9 + 100 core) with 5/5 EVM controls.
- **Tested-evidence pins:** `stage/jobs/TESTED-EVIDENCE.sha256` and `provenance.json` `testedBy` pin those receipts.

**Build:**
- **Command:** `cargo build --offline --locked -p helios-cli --bin helios`, `SOURCE_DATE_EPOCH` 1792720709 (=
  `eeffcc9` commit time), one job, toolchain 1.96.0.
- **Cache:** the cargo cache was reused from an ended canonical test run, and only the CLI package was cleaned (716
  units, 695 fresh).
- **`Cargo.lock`:** unchanged.
- **Memory:** peak 1147 MiB; minimum host available 22833 MiB.

**Smoke:** offline, 30 s each. `helios --version` (helios-cli 0.12.0) and `--help` pass on the host and on the
image's pinned glibc runtime; `ethereum`, `opstack` and `linea` `--help` all exit 0.

**Root's own result line:** "canonical Helios artifact 8250f08a… built; **NOT a pass, NOT a reproduction, NOT
deployed**".

**Runner provenance:**

| File | sha256 | Role |
| --- | --- | --- |
| `stage/prior-pre-root-review/build-helios.sh` | `f0d70c47…` | the **original** prepared runner, with its `SHA256SUMS` |
| `stage/jobs/build-helios.sh` | `b7509206…` | the **root-corrected** runner that ran |

- **Stage manifest:** `stage/SHA256SUMS` (`bf0ea1e4…`) verifies the stage copy.
- **Integration scripts:** `stage/integration/` is **prepared only** and has not been run.

**Witness impact audit:** `witness-impact-audit/FINDINGS.md` and `EVIDENCE.txt`, a read-only source-reachability
audit.
- **Verdict:** witness-check `4fe0cd3b` (from `ef320298`) is **NOT AFFECTED** by `41667ec9`, so it can be reused
  unchanged.
- **Caveat:** nothing was compiled or run for that audit.

## 2. Combined M7+M10 Base guest release build: attempt 1 (root 2352 → 0055), pass

**Artifact:** `base` **`4a7c013a510f88166779281ad0108790f25efa07f22f6457d54add709488372f`** (289478208 bytes). It is
**not included here**.
- **ELF metadata:** Build ID `35f1b65f…`; rustc 1.96.0; 0 build-path strings.
- **NEEDED:** libstdc++, libc, ld-linux, libssl 3, libcrypto 3, libgcc_s and libm.

**Source:** base `5476069f`. Base tar `a92160eb` + M7 patch `e9dfb8c6` + fixed M10 patch `d97c31b5` give source
manifest **`58c572cb`** (2533 files). That **equals the tree run 2 tested**. `Cargo.lock` is `f122da76`.
- **Gates:** M7 (CLI default l1 trust-rpc = false; provider == validated `201d9b8c`) and M10 (`--bootstrap.anchor`
  declared exactly twice, none in sequencer args).

**Build:**
- **Where:** the private RPC guest (Ubuntu 24.04, uid m10build).
- **Settings:** profile `m7m10-release-nolto`, one job, `SOURCE_DATE_EPOCH` 1792689943.
- **Units:** 1203 compiled units, **all built in this run** (0 fresh). The cargo home was reused from ended run 1 and
  verified offline: sources only.

**Smoke:** bounded, no network, no data dir.
- `base --version` gives `base 1.5.1`.
- `--help`, `rpc --help`, `follow --help` and `sequencer --help` all exit 0.
- The M7 env flag is present in rpc, follow and sequencer.
- The M10 flag is in rpc, absent from sequencer, and has no env binding.

**Receipts:**
- **`receipt.json`:** `pass:true`, systemd `Result=success`, stage bundle manifest `9c9b2e83`, compound gate
  `1082d775`.
- **Disk and memory guards:** min free disk **13530 MiB**; peak 4217 MiB; guest minimum available **48799 MiB**.
- **Root watcher (`m7-m10-release-1/result.json`):** exit 0, minimum host available **21940 MiB**.
- **Not a reproduction:** this is **ONE** build, not an independent reproduction, and not deployed.

**Failure preserved:** the **original run-2 receipt stays `pass:false`**. That is `run-2.receipt.json` `b4162de1`,
with `ignoredTotal` 1, and `provenance.json` records `"run2OriginalReceiptPass": false`.
- **How the release was accepted:** through the reviewed compound gate (`compoundAccepted:true`), not by rewriting
  that receipt.
- **Where the details are:** `prepared-stage/README.md`.

**Prepared stage:** `m7-m10-guest-release/prepared-stage/` is a byte copy of
`finality-stage/m7-m10-combined-release` (45 files). Its `SHA256SUMS` (`9f0de11e…`) is identical to the existing
`../m7-m10-combined-release-prepared/` record.

## 3. Finality: unsafe vs safe vs finalized (explicit)

**Neither artifact establishes finality.**
- **Canonical Helios gate:** `requireCanonical:true` means **on the chain of the current verified head**. That head is
  fresh (≤ 60 s), and the walk is exact parent-hash ancestry up to 256 deep.
  - **That head can still reorg.** It is **not** a safe or finalized guarantee.
  - Absent or false flags give only the exact authenticated block.
  - Consumers that need settlement must use **safe** or **finalized** semantics, which these artifacts do not
    validate.
- **Base (OP Stack):** **unsafe** = sequencer/gossip head; **safe** = derived from L1 data; **finalized** = derived
  from finalized L1.
  - **What M7 and M10 do:** M7 removes default trust in L1 RPC, and M10 adds the bootstrap anchor flag.
  - **What this build shows:** only that those flags exist in the built CLI. Nothing here exercises derivation, the
    safe or finalized depth, or anchor validation on a live chain.

## Contents

**Bounded text only:** no binaries, caches, `metadata.json`, cargo `build.json`, helios or vendor trees, or private
keys. Matches for "secret/private key" occur only in CLI help descriptions.

| Path | Contents |
| --- | --- |
| `canonical-helios/stage/` | the stage minus `run/` |
| `canonical-helios/actual/` | `root-canonical-helios-build-0046.{out,rc,guard}` |
| `canonical-helios/actual/run-build-20261026T004633Z/` | `build.err`, `fetch.out`, `metadata.err`, `CACHE-REUSED-FROM` |
| `canonical-helios/actual/run-build-20261026T004633Z/out/` | `SHA256SUMS`, `provenance.json`, the 7 `smoke-*.txt` files |
| `canonical-helios/witness-impact-audit/` | the audit |
| `m7-m10-guest-release/actual/m7-m10-release-completed-0055/` | `release.out`, `receipt.json`, `provenance.json`, `SHA256SUMS` and the 5 smoke files (help texts, 6–88 KB) |
| `m7-m10-guest-release/actual/m7-m10-release-1/` | the root watcher: `result.json`, `remote.out`, `precheck.out`, `initial/` |
| `m7-m10-guest-release/prepared-stage/` | the prepared release stage |

**Verify:** `sha256sum -c SHA256SUMS` covers every file here.
- **Nested manifests:** they verify too. The two artifact `SHA256SUMS` each list their binary (`helios`, `base`),
  which is deliberately absent; every other line verifies.

**What's next (not done):** install or verifier-package integration, SNP or measured-release qualification,
proof-path E2E, readiness and finality validation, and independent reproduction.

Root independently rehashed both actual binaries (Base over SSH) and all recorded smoke/test-evidence inputs, matched the original source manifest and compound gate, and retained the original incomplete receipt. See `root-verification/`: exit 0, peak 14 MiB, minimum host available 22827 MiB. This is an identity check, not independent reproduction or production qualification.
