# Combined M7+M10 Base release build on the private RPC guest: v2 (COMPOUND-evidence gate; PREPARED, nothing run)

## v2 change (the v1 package is preserved unchanged in `superseded-v1/`)

**Why v1 could never start:** run 2 ENDED at 23:23:42Z, and its **original receipt is pass:false with ignoredTotal 1**
(`run-2.receipt.json` `b4162de1`, `run-2.out` `6f22c072`, rc 0). Every phase and both anchor controls passed. The single
ignored test is the CLI child `node::tests::validates_sequencer_key_from_env_child`, which three passing parent cases spawn.
v1 demanded `pass:true`, so it would refuse forever. **That receipt stays pinned and unchanged; the gate is NOT weakened to
accept ignored tests.**

**What v2 requires instead: `bundle/runner/check-compound-gate.py` (`bce57917`).** It runs at preflight AND again in the
launcher, and accepts ONLY when ALL of these hold:
1. **The child stage is the reviewed one:** `finality-stage/m10-cli-child-evidence`, copied by root to
   `/srv/m10-guest-validation/stage-cli-child`, equals its `MANIFEST.sha256` **`f3d45ccb`**, with nothing unlisted. That
   fixes the checker (`cd2e2e58`), the pins (`4e7c14f1`), the case runner and the checker's own tests.
2. **The ORIGINAL run-2 receipt is byte-identical:** receipt/out/rc and the 8 phase logs are byte-identical to the actual
   files, and still say `pass:false` and `ignoredTotal 1`. The 6 phases, the 5 REBUILT builds and both exact control sets
   are present.
3. **The ONLY ignored test anywhere is the pinned child,** with its pinned annotation. Every other log has 0 ignored.
   There is no ignore whitelist.
4. **The supplement evidence matches root's pins:** `cli-child-N.{compound.json, launcher.json, out}` equal the pins
   root supplies (computed from the files root collected). The supplement output directory equals its pinned manifest
   (`runner/supplement-manifest.py`), with exactly 99 files (results.json plus 49 runs × stdout/stderr).
5. **The pinned checker is RE-RUN on those actual files:** it must exit 0 with `compoundAccepted:true`, no failures,
   `originalReceiptPass:false`, and summary 45/3/true. Its output must be **byte-identical** to the stored
   `compound.json`. The stored boolean is never trusted on its own.

**Tests:** `tests/test-compound-gate.py` (`75eb2f4a`) has 1 positive and 16 strict negative cases.
- **Inputs:** the **actual run-2 files** and a **synthetic** 49-run supplement. In the positive case, `compound.json` is
  produced by the pinned checker.
- **Negative cases:**
  - an absent compound file, or a wrong pin;
  - a forged `compoundAccepted:true` over a missing run;
  - a `compound.json` edited after a valid run;
  - a forged `pass:true` in the original receipt;
  - a second ignored test, or a changed annotation;
  - a changed checker, or changed checker tests;
  - an unlisted file;
  - a wrong supplement manifest, launcher pin or `.out`;
  - a negative control that passed;
  - an extra log;
  - a malformed pin.
- **PREPARED, NOT RUN.** The positive case is synthetic: it proves the gate's logic, **not** a production pass.

**Dependency status:** I froze against the child worker's completed manifest `f3d45ccb` and report
(`logs/claude-m10-cli-child-evidence-result.md`, 16:35). **No actual supplement exists yet.** If the child stage changes,
the gate refuses until its pins are reviewed and updated.

**Changed files:**
- `verify-stage-release.sh` (`172c6f0a`);
- `run-release.sh` (`b911f304`): new arguments for the CLI-child attempt and 4 pins; the gate's JSON goes into the release
  dir and receipt;
- `release-job.sh` (`94b299cf`): one provenance line, `compoundGate` + `run2OriginalReceiptPass:false`;
- the derived watcher `host/guest-release-watch.py` (`e546652e`; `tools/make-watcher.py` `fe81fd32`, v2), whose precheck
  also requires the CLI-child compound receipt and an inactive child unit.

**Removed from the active bundle** (kept in `superseded-v1/`): `check-run2-receipt.py` and its tests.

**UNCHANGED from v1:** the source/recipe/profile/caps (`guest-env-release.sh` `01650ac3` byte-identical), the patches, the
guards, the isolation and the disk rule.

**Bundle:** `MANIFEST.sha256` = **`00f26a291dcf9cd94ecb2daab19150d4c5b19c828da30f8c7ea4418667893363`** (11 files).

**Capacity (root, 23:28; all run-2 builds ended):**
- guest `/sda1` available **18454310912 B (≈ 17599 MiB)** ≥ the preflight's **17408** (8192 floor + 9216);
- debug target 5.55 GiB, cargo home 1.40 GiB;
- the host M7 release target was **3.4 GiB** actual.

The guest cargo home is only 1.40 GiB (versus 4.2 GiB with all sources extracted on the host), so the release may extract
about 1–2.7 GB more. **Estimate:** target 3.4–4.5 + extraction 1–2.7 + about 0.5 = **about 5–7.7 GB**. That leaves about
9.9 GiB or more, above the 8 GiB floor. **Plan A is plausible but tight**, and no tmpfs, deletion or new resource is used.
If free space drops below 17408 before launch, the preflight refuses.

## Root sequence (v2; every step foreground, after review)

```sh
X=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m7-m10-combined-release
Q=/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py
# 0. the child worker's steps (its report): checker tests; copy its stage to /srv/m10-guest-validation/stage-cli-child; run the
#    supplement (attempt CN); collect receipts/cli-child-CN.{out,launcher.json,compound.json} + supplement/cli-child-CN/work/out
python3 $X/tools/make-watcher.py --check $X && echo watcher-derivation-ok
python3 $Q --mib 256 --log $X/logs/compound-gate-tests.guard -- python3 $X/tests/test-compound-gate.py
python3 $Q --mib 256 --log $X/logs/watch-tests.guard -- python3 $X/host/test-guest-release-watch.py
# pins of the COLLECTED supplement evidence (root computes them; never hardcoded):
CC=$(sha256sum < …/cli-child-$CN.compound.json | cut -c1-64); CL=$(sha256sum < …/cli-child-$CN.launcher.json | cut -c1-64); CO=$(sha256sum < …/cli-child-$CN.out | cut -c1-64)
CS=$(python3 -I …/supplement-manifest.py /srv/m10-guest-validation/supplement/cli-child-$CN/work/out | cut -d' ' -f1)   # on the guest (prints "sha count"; count must be 99)
bash $X/host/transfer-release-stage.sh 00f26a291dcf9cd94ecb2daab19150d4c5b19c828da30f8c7ea4418667893363
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && python3 $X/host/guest-release-watch.py 1 \
  00f26a291dcf9cd94ecb2daab19150d4c5b19c828da30f8c7ea4418667893363 $CN $CC $CL $CO $CS /home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/m7-m10-release-1
```

---

# (v1 text below, for reference: superseded where it conflicts with v2 above)

# Combined M7+M10 Base release build on the private RPC guest (PREPARED; nothing transferred, built or run)

## Status and gate

**Not run:** no compile, queue, SSH, transfer, test or commit was performed for this package.

**Run 2 gate:** guest M10 run 2 was still ACTIVE when this was prepared. The release **cannot start** until root
collects run 2's receipts and supplies their sha256 pins. `runner/check-run2-receipt.py` (`8b4ca85e`) accepts ONLY a
complete pass and refuses every other case:
- missing files, a pin mismatch, or malformed JSON;
- rc ≠ 0, attempt ≠ 2, `systemdRunExit` ≠ 0, or `pass` ≠ true;
- a receipt not bound to the given `run-2.out`, or a repair manifest ≠ `1864c852`;
- aggregate ≠ `rc=0`, ignored ≠ 0, or test-result lines ≠ 8;
- any of the 6 phases not OK;
- REBUILT builds ≠ {engine, node, cli, control-engine, control-node}, or a control binary equal to its patched binary;
- either negative control not failing with EXACTLY its expected set;
- any INVALID or missing-test line, or guard lines not both `exit=0`.

**A unit `Result=success` alone is never accepted.** `tests/test-check-run2-receipt.py` (`f63bc732`) holds 19
synthetic accept/refuse cases. **PREPARED, NOT RUN.**

## What is built

**Source:**
- `git archive 5476069f` (`a92160eb`, from the verified OLD guest stage) + M7 `e9dfb8c6` + **fixed** M10 `d97c31b5`;
- source manifest **`58c572cb…`** (2533 files), `Cargo.lock` `f122da76` (unchanged; M10 adds no dependency);
- computed on the build host (`proof/expected-source.txt`).

**Binding to the tested source:** the job requires the release tree's manifest to equal **both** that pin and the
manifest of run 2's TESTED tree (`runs/run-2/build/tree`, read-only).
- The M10 tests and controls are therefore **not recompiled**.
- They are bound by the source manifest plus the gated run-2 receipts, whose hashes are recorded in `provenance.json`.

**Recipe** = the reviewed host M7 production `build.sh` (`2ee8b8de`, which produced the M7-only `5aa7b291`), with guest
paths:
- `cargo build --locked --offline -p base --bin base`;
- profile `m7m10-release-nolto` = the workspace `[profile.release]` (opt 3, `codegen-units` 16, `strip` symbols, `panic`
  unwind) **with `lto=false`**, as for M7;
- `CARGO_BUILD_JOBS=1`, `-Wl,--threads=1`;
- `SOURCE_DATE_EPOCH` 1792689943;
- `--remap-path-prefix` and `-ffile-prefix-map` for the tree, cargo home and target.

**Toolchain and caches:**
- the staged rust **1.96.0** (`ac68faa20`), from the OLD stage;
- the **reused** ENDED run-1 cargo home: sources only, re-verified offline (crate checksums, `git fsck`);
- a **NEW release target**, with **every compiled unit required to be `fresh=false`**, i.e. built in this run (checked
  from Cargo's JSON).

**Not claimed:** independent reproducibility. It is one build, and it reuses cached dependency *sources*.

**Configuration gates checked on the source:**
- **M7:** `DEFAULT_L1_TRUST_RPC = false`; the validated provider is `201d9b8c`.
- **M10:** `--bootstrap.anchor` is declared exactly twice (the rpc-embedded and standalone consensus args; none in the
  embedded-sequencer args).

**Smoke** (offline, no datadir):
- `--version`, `--help`, and `rpc`/`follow`/`sequencer --help`;
- **M7:** `BASE_NODE_L1_TRUST_RPC` is present in all three;
- **M10:** `--bootstrap.anchor <NUMBER:HASH>` is present in `rpc`, absent from `sequencer`, with no `[env:` binding. Its
  presence in `follow` is recorded only as info.

**Artifact facts recorded:**
- sha256, size, build-id, `.comment`, NEEDED, and the highest GLIBC/GLIBCXX/OPENSSL versions required;
- build-path strings (should be 0);
- `provenance.json` and `out/SHA256SUMS`.

## Isolation (same as the reviewed guest runs)

**The unit:** `m7-m10-release-N` as `m10build` (uid 993).
- `MemoryMax=12G`, no swap, `CPUQuota=200%`, `Nice=10`;
- `PrivateNetwork`, `ProtectSystem=strict`, `KillMode=control-group`, `TimeoutStopSec=30`;
- `RuntimeMaxSec=6h30min`: a single-job release build is longer than a test run; the cargo timeout is 6h.

**Guards:** the copied memory guard (12288 / guest floor 16384) and the disk guard (8192).

**Writable ONLY:** `/srv/m10-guest-validation/release/run-N` and the run-1 cargo home (crate extraction).

**Not written:** run-1/run-2 source, logs, receipts and binaries, live chain data, and services. No VM change.

**The outer host 16 GiB floor** is root's watcher, `host/guest-release-watch.py` (`c74785ae`). It is derived by counted
substitutions from the reviewed `guest-build-watch.py` (`31264eb0`) via `tools/make-watcher.py`; `monitor()` is
unchanged. Its test is `host/test-guest-release-watch.py`; NOT run.

## Storage (the guest OS disk is 30 GiB; root reports about 18 GiB free)

| item | estimate | basis |
|---|---|---|
| release target (new) | **3.4–4.5 GB** | the host M7 release target, same profile, complete: **3.4 GB**. M10 adds little code; Ubuntu builds vendored zlib/libgit2 |
| extra crate extraction in the shared cargo home | **0–3 GB** | `base`'s release graph needs crates the test graphs did not; the host M7 cargo home's `registry/src` is 3.0 GB in total; the guest run-1 extraction size is unknown |
| tree + out + logs | about 0.5 GB | tree 70 MB, binary about 290 MB, build JSON |
| **total** | **about 4–8 GB** | |

**Preflight requirement:** ≥ **17408 MiB free** (the 8192 floor + a 9216 estimate). Otherwise it refuses, and nothing
is deleted.

**Uncertainty:** run 2 is still adding debug artifacts to the shared run-1 target, so free space after it is likely
**below 18 GiB**, and **Plan A may be refused.**

**Alternate staging plans (root decides; none implemented):**
- **B (preferred if A is refused):** put the release target on a **tmpfs inside the unit**, for example
  `TemporaryFileSystem=` or a size-bounded tmpfs at the target path. The binary is copied to `out/` on disk.
  - **Disk need:** drops to about 4 GB (extraction + out).
  - **Memory:** rustc (about 4.1 GiB peak for M7) + target (about 4 GB) ≈ 8–9 GiB, charged to the 12G cgroup. The guest
    floor 16 GiB holds with about 49 GiB available.
  - **Risk:** if the target exceeds about 7 GB, a cgroup OOM. The memory guard measures RSS, not tmpfs.
  - **Needs:** a small reviewed launcher change.
- **C:** root explicitly authorizes removing ONLY the run-1/run-2 debug *target* cache after their receipts are
  collected and published. That is evidence-preserving but deletes test binaries, so it is root's call.
- **D (not recommended):** build on the host. The host queue maximum is 4096, and M7 alone peaked at 4072 MiB.

**Not allowed by this plan:** using live chain disks, new VM allocation, or deleting anything automatically.

## Files

| path | sha256 |
|---|---|
| `bundle/MANIFEST.sha256` (10 files, 148K → `/srv/m10-guest-validation/stage-release-1`) | `e771f25c0bbafbabdba7fbf4458b458a48817afc23b2b300baeca69587b95301` (sha of MANIFEST) |
| `bundle/runner/release-job.sh` | `0c058bcf…` |
| `bundle/runner/guest-env-release.sh` | `01650ac3…` |
| `bundle/runner/verify-stage-release.sh` | `0e3cdc83…` |
| `bundle/runner/run-release.sh` | `9607d0da…` |
| `bundle/runner/check-run2-receipt.py` | `8b4ca85e…` |
| `bundle/runner/{verify-deps.py, disk-guard.py, memory-guard.mjs}` | `7d4394a9`, `40e6d0cc`, `cdd00af7` (reviewed copies) |
| `bundle/inputs/{base-l1-verify.patch, m10-bootstrap-anchor.patch}` | `e9dfb8c6`, `d97c31b5` |
| `host/transfer-release-stage.sh`, `host/guest-release-watch.py`, `host/test-guest-release-watch.py`, `tools/make-watcher.py`, `tests/test-check-run2-receipt.py`, `proof/expected-source.txt` | see `SHA256SUMS` |

## Root commands (after run 2 has COMPLETED and its receipts are collected; foreground)

```sh
X=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m7-m10-combined-release
Q=/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py
python3 $X/tools/make-watcher.py --check $X && echo watcher-derivation-ok
python3 $Q --mib 256 --log $X/logs/gate-tests.guard -- python3 $X/tests/test-check-run2-receipt.py          # 19 synthetic gate cases
python3 $Q --mib 256 --log $X/logs/watch-tests.guard -- python3 $X/host/test-guest-release-watch.py        # 6 monitor controls
# pins of the COLLECTED run-2 receipts (root computes them from the files it collected; they are never hardcoded here):
PR=$(sha256sum < …/run-2.receipt.json | cut -c1-64); PO=$(sha256sum < …/run-2.out | cut -c1-64); PC=$(sha256sum < …/run-2.rc | cut -c1-64)
bash $X/host/transfer-release-stage.sh e771f25c0bbafbabdba7fbf4458b458a48817afc23b2b300baeca69587b95301
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && python3 $X/host/guest-release-watch.py 1 \
  e771f25c0bbafbabdba7fbf4458b458a48817afc23b2b300baeca69587b95301 $PR $PO $PC /home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/m7-m10-release-1
```

**Order:** the guest launcher runs the preflight (with the gate) before anything else.

**Pass:** `receipts/release-1.receipt.json` `"pass": true`, plus the job's final `## rc=0` line, `out/SHA256SUMS` and
`provenance.json`.

**After a pass:** an Ubuntu-native version/help smoke is part of the job. Deployment is a separate, later decision.

## Remaining risks

- **Disk:** see above. Plan A may be refused.
- **Duration:** about 1.5–3 h with one job. M7 alone took about 1 h over interrupted attempts on the host.
- **Memory:** an M7-like peak of about 4.1 GiB is expected, well under 12G. M10's extra code is small.
- **Output:** the M10 flag's help text format is assumed to be `--bootstrap.anchor <NUMBER:HASH>`, from the clap
  definition. A different rendering would fail the smoke visibly.
- **Not run:** none of these scripts has been executed.
