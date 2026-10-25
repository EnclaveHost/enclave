# Native reproduction: interrupted first attempt, recovery scripts and integrity checks (2026-10-25)

**Status (updated after root's foreground run): R1 and R2 REPRODUCED. R3 FINISHED: NOT reproduced (byte mismatch; hypothesis and heuristics in §8; exact rebuild `r3x` queued).**
- **TWO natives are now reproduced by fresh builds:** the listener `9ca75047…` (§6) and witness-check `4fe0cd3b…` (§7).
- **Not reproduced:** Helios `cc962e2b`. Both clean R3 builds differ from it (§8). For the `eeffcc9` rebuild, the observed
  differences are CONSISTENT WITH (not proven to be) OpenSSL's embedded build timestamp and its layout effects. An exact
  rebuild (`r3x`, §8) is queued, not completed. The 4 libraries
  remain distribution bytes. This is not a native-provenance pass for the image as a whole.
- The audit this follows is in `../` (`README.md`, `audit.json`, `ROOT-REVIEW.md`).
- Root launches `jobs/resume.sh` in the FOREGROUND from a session that survives the CLI. **No job here runs as a
  background job of a CLI session.**

## 1. Interrupted first attempt (`logs/interrupted-first-attempt/`)

- **R1** (`jobs/r1.sh`: the release listener built twice, A and B) and **R2** were started as *background jobs of a CLI
  session*, and **died with it**.
  - R1's build A stopped mid-compile at about 17:16Z (`r1.out`, `r1-build-a.out`); B never started, and there is no `.rc`.
  - R2 was never admitted by the queue (`r2.try1.out`: exit 98, not started; `r2.retries`).
- **Kept outside the repository, NOT copied:** the interrupted A work directory and its cargo-cache copy.
- **A weakness, fixed in the later scripts:** a compound check in `r1.sh` (`need … [ a ] && [ b ]`) verified only its
  first half.

## 2. Recovery scripts (`jobs/`, byte-identical to the reviewed copies)

| script | role |
|---|---|
| `resume.sh` | runs the phases sequentially, each as its own job through the shared queue (16 GiB floor; `q.sh` retries only exit 98, a guard stop is reported and never bypassed); appends to `logs/resume-summary.txt` |
| `q.sh` | queue wrapper: `unshare -r -n`, only lo up (offline); refuses to reuse a log name |
| `inputs.sh` | the input locations and helpers (`need`, `treehash`, the offline proof, the toolchain record) |
| `r1r.sh` (1024 MiB) | **R1:** re-verifies the inputs and the interrupted A; **resumes A in place** with `build-binaries.sh`'s exact release environment (labelled A-resumed); builds **B fully fresh**; compares with `9ca75047` |
| `r2.sh` (1536 MiB) | **R2:** witness-check at the committed `ef320298`, at the original absolute paths. A private mount namespace binds a fresh clean clone, an empty target and a cache copy over the originals, with the vendor tree read-only. The originals are verified unchanged |
| `r3.sh` (1536 MiB, `C=b93fcfd \| eeffcc9`) | **R3:** the Helios CLI the same way, at the original rpc-priority paths; compared with `cc962e2b` |
| `r1.sh` | the first attempt's script, kept as run |

**`VERIFY_ONLY=1`** stops `r1r`, `r2` and `r3` before any compilation. It uses separate `-verify` directories, so the real
runs still start fresh.

## 3. Short integrity checks already run (`logs/integrity-checks/`)

All ran in the foreground through the queue at 512 MiB, offline, with **no compilation** (peaks 31–36 MiB).

| check | rc | result |
|---|---|---|
| `r1r-verify` | **9** | **FAILED on one file:** the cache copy's `.global-cache` (cargo's last-use DB) differs. Every crate file was identical. The check was then narrowed to exclude only cargo's own state files |
| `r1r-verify2` | 0 | inputs pinned and repos clean; interrupted A's sources == a fresh export made with `build-binaries.sh`'s commands; the cache copy is complete and byte-identical except cargo state; 2598 partial target files, no final binary |
| `r2-verify` | 0 | the namespace mounts are correct at the original witness-failover paths; afterwards the originals are unchanged (original binary still `4fe0cd3b`) |
| `r3-verify-b93fcfd` | 0 | the same at the rpc-priority paths, for candidate `b93fcfd`; afterwards the originals are unchanged (still `cc962e2b`) |

## 4. Expected values: `expected-pins.json`

- the 7 image pins, with their kind and status;
- the 4 distribution libraries' signed-package evidence;
- the toolchain;
- each target's commit, tree, `Cargo.lock` and cache and vendor manifests.

## 5. Interpretation, fixed before the run

- **Only a byte match from a FRESH build reproduces a pin.** A-resumed is supplementary.
- **A mismatch does NOT prove the source differed.** It calls for a diff diagnosis.
- **Any pin change needs root review and a new image.**
- **Not established here:** hardware attestation, activation, readiness and finality.

## 6. R1r result (root-launched FOREGROUND run of `jobs/resume.sh`, phase `r1r`; evidence in `r1r/`)

- **Job:** `r1r` exit **0**, finished 18:04:46Z. Memory guard: peak 725 MiB, host minimum 21040 MiB (`r1r/r1r.guard`,
  `r1r/r1r.rc`). Offline, through the shared queue at 1024 MiB.
- **Re-checked before building** (`r1r/r1r.out` §0–1):
  - all original inputs (script `d5bb17e8`, tarball `9784e20a`, listener `5e178676` and helios `ef320298` trees, clean
    repos, the original cache manifest `95d7ca22…`);
  - interrupted A's sources are again equal to a fresh export, and its cache is byte-identical except cargo state.

| build | how | log | binary sha256 |
|---|---|---|---|
| **B-fresh: THE reproduction** | `build-binaries.sh` release from scratch: new work dir and cache copy, all 404 units compiled; started 17:58:43Z, `Finished … in 6m 00s` | `r1r/r1r-build-b.out`, `r1r/receipts/B-fresh-BUILD.json` | **`9ca75047ab9ee4f2c44a211b237aa5a8171af1661b17047aafaf2e9b63d10ba3`** |
| A-resumed (supplementary) | the interrupted first-attempt A, resumed in place with the script's exact release environment; 114 remaining units, 17:55:07–17:58:39Z, `Finished … in 3m 32s` | `r1r/r1r-build-a-resume.out`, `r1r/receipts/r1r-a-resume-*.utc` | `9ca75047…` (equal to B) |

- **Pin:** `9ca75047…` (`chain-verifier-inputs/PINS.sha256`, the image record at `0235e7d96`). **B-fresh == pin.**
  A-resumed == B, but A reused units compiled in the interrupted attempt, so it is NOT counted as the reproduction.
- **Hashes, independently re-checked** for this publication (sha256 of both binaries on disk, read-only): both equal
  `r1r/receipts/r1r.sha256` and `B-fresh-BUILD.json`.
- **Afterwards, originals unchanged:** the listener cache, and both repos clean.
- **What this proves:** the pinned release listener is reproducible from the committed listener `5e178676` and base/base
  tarball `9784e20a` with the recorded toolchain and recipe, on this host.
  - **Not proven:** that it reproduces on a different host or toolchain installation. A second, independent builder
    host is still open.
- **R2 (`r2b`) and R3 (`r3-b93fcfd`, `r3-eeffcc9`):** were still running or pending when this was written (R2 has since
  finished and is published in §7; R3 in §8). Their logs
  are deliberately NOT copied, to avoid publishing incomplete files. No result is claimed.

## 7. R2b result (root-launched FOREGROUND run of `jobs/resume.sh`, phase `r2b`; evidence in `r2b/`)

- **Job:** `r2b` exit **0**, finished 18:12:44Z. Memory guard: peak 1198 MiB, host minimum 20757 MiB (`r2b/r2b.guard`,
  `r2b/r2b.rc`). Offline, through the shared queue at 1536 MiB.
- **What was built:** `witness-check` (debug), from a FRESH clone of the **committed** `ef320298` (tree `eec339e1`,
  `Cargo.lock` `28f4400c`, clean before and after), at the ORIGINAL absolute paths through a private mount namespace.
  - Mounted over the originals: the clone, an EMPTY target, and a byte-equal copy of the original cache (manifest
    `8fe797b4…`). The vendor tree was read-only (manifest `d3115258…`).
  - The flags and command are those of the original build script (`helper-build-test-r5.sh`): rustc 1.96.0
    (`ac68faa20`), `CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_INCREMENTAL=0`, `CARGO_BUILD_JOBS=1`, offline,
    `-Wl,--threads=1`.
  - Build started 18:05:03Z, `Finished dev … in 7m 36s`; `Cargo.lock` unchanged.
- **Result:** rebuilt `4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411` == **the pin**
  (`r2b/receipts/r2.sha256`). The sha256 of the rebuilt file was independently re-checked for this publication.
- **Afterwards, originals unchanged:** the helios repo HEAD and clean state, the original target binary (still the pin),
  the original cache and the vendor tree.
- **What this settles:** the audit's open point. The pinned helper had been built from a DIRTY `aca8176` tree 15 minutes
  before `ef320298` was committed. A fresh build of the committed `ef320298` now yields the same bytes, so the pinned
  `witness-check` corresponds to committed source `ef320298` (on this host, with this toolchain).
  - **Not proven:** reproduction on a different host or toolchain installation; a second, independent builder is still
    open.
- **R3:** `r3-b93fcfd` was running and `r3-eeffcc9` was pending when this was written (both have since finished: §8). Their logs are NOT copied, and no
  Helios result is claimed.

## 8. R3 results: Helios CLI NOT reproduced; mismatch examined read-only (evidence in `r3/`)

**Both clean builds finished, rc 1 (byte mismatch), no guard kill.** Both ran offline at the original rpc-priority paths
through a private mount namespace, from fresh clean clones, an empty target and a cache copy, with `Cargo.lock` unchanged.

| candidate | job | build | rebuilt sha256 (independently re-hashed) | vs pin `cc962e2b…` |
|---|---|---|---|---|
| `b93fcfd` (tree `ef08b7cf…`) | `r3-b93fcfd`, guard peak 1237 MiB | `Finished … 7m 46s` | `97de79e2d820bde6f8b9c7b2de642a5b1ee292beacfed3f3e543e4119ce40813` | differs (size −19384 bytes) |
| `eeffcc9` (tree `2171ad2b…`) | `r3-eeffcc9`, guard peak 1350 MiB | `Finished … 7m 38s` | `b9432500764ed2266f1ae925ebcad76f742696b08aefe5c2e11bd7100819a8de` | differs (same size, 124722632 bytes) |

### 8.1 Observed facts (pin `cc962e2b` vs the `eeffcc9` rebuild unless stated)

How these were produced: `r3/diagnosis/`, read-only, through the shared queue at 256 MiB. The small scripts and their
outputs `d1`–`d5` are included. No disassembly dump, and no binary, is published.

- **Section comparison** (`d1.out`, `elfdiff.py`):
  - 31 of 35 ELF sections are byte-identical, including the full `.symtab` and `.strtab`, `.data`, `.data.rel.ro`,
    `.eh_frame*` and `.gcc_except_table`;
  - four differ, all at equal size: `.note.gnu.build-id`, `.text` (1393 bytes), `.rodata` (28103 bytes) and `.rela.dyn`
    (840 bytes);
  - the `b93fcfd` rebuild differs in size and content in most sections.
- **Build stamp** (`d3.out`): all three Helios binaries contain vendored OpenSSL 3.5.1 (`openssl-src 300.5.1+3.5.1`)
  with a build-stamp string:
  - the pin: `built on: Fri Oct 23 01:31:58 2026 UTC`;
  - the `eeffcc9` rebuild: `… Sun Oct 25 18:24:37 2026 UTC`;
  - the `b93fcfd` rebuild: `… 18:16:35 …`.

  The witness-check binaries contain no such string.
- **`mkbuildinf.pl`:** the vendored `openssl/util/mkbuildinf.pl` (line 19) writes
  `gmtime($ENV{SOURCE_DATE_EPOCH} // time())`. A grep of the cache found `SOURCE_DATE_EPOCH` only in OpenSSL's own
  scripts (`mkbuildinf.pl`, `mkrc.pl`, `progs.pl`), not in other build scripts, Rust sources, or Helios.

### 8.2 Heuristic checks and their limits (what each one does and does NOT establish)

1. **`.rodata` strings** (`d4.out`, `rodata_set.py`):
   - **What it does:** it takes the window spanning all differing `.rodata` bytes (31 KB) and splits it at NUL bytes.
   - **What it found:** the resulting multisets are equal (675 pieces each) except one piece per side, which is the build
     stamp.
   - **Limit:** this is a string-multiset heuristic over a byte window. It does not parse section or object boundaries,
     and non-string data in the window would be split arbitrarily.
2. **`.rela.dyn`** (`d4.out`):
   - **What it found:** all 674 differing entries are `R_X86_64_RELATIVE`, in identical slots, and both addends fall
     inside that window.
   - **Limit:** it does NOT check that each pair of addends points to the same string.
3. **`.text`** (`d5.out`, `text_disp.py`):
   - **What it found:** every one of the 1393 differing bytes falls within SOME 4-byte window that, read as a
     little-endian rel32 displacement ending at that position, gives targets inside the same `.rodata` window in both
     binaries, with the 3 preceding bytes equal (0 bytes outside such a window).
   - **Limits:**
     - it scans arbitrary 4-byte windows and does NOT decode instructions;
     - it does NOT confirm the bytes are displacement operands;
     - it does NOT confirm that matched pin and candidate targets point to the same string;
     - **it is not a disassembler or semantic comparison.**
   - **Note:** the scripts and outputs are kept exactly as run. Their own wording (e.g. `d5.out`'s "explained as
     RIP-relative displacements", and the script docstrings) states the heuristic more strongly than it establishes; the
     limits above apply.

### 8.3 Hypothesis (NOT proven)

- **The hypothesis:** the only input difference between the pin and the `eeffcc9` rebuild is the OpenSSL build
  timestamp. The linker then reordered the merged strings, which changes string references in code and relocations, and
  the build-id follows.
- **Evidence:** the observations above are consistent with it.
- **What is not established:**
  - that no program code or data differs;
  - that the pin was built from `eeffcc9`;
  - that `b93fcfd` (or any other tree) was not its source.

  The `b93fcfd` rebuild's broader differences make it a poor match under this recipe, but that is not a source verdict.
- **Only an exact byte reproduction settles it.**

### 8.4 Exact-rebuild test: QUEUED, not yet completed

- **Job:** the foreground job `r3x-eeffcc9`, launched by root (exec62493) and QUEUED behind M7 at the time of writing.
  - It runs `jobs/r3x.sh` (archived here as `r3/prepared-not-run/r3x.sh`, a historical filename; sha256 `9d621d4b…`).
  - That is `r3.sh` plus `SOURCE_DATE_EPOCH=1792719118` (= `Fri Oct 23 01:31:58 2026 UTC`), with separate `r3x-`
    directories and receipts.
  - Command: `C=eeffcc9 SOURCE_DATE_EPOCH_PIN=1792719118 ./jobs/q.sh 1536 r3x-eeffcc9 bash jobs/r3x.sh`.
- **No result is claimed.**
  - Byte equality with `cc962e2b` would reproduce the pin from committed `eeffcc9` (on this host).
  - A mismatch would mean the hypothesis is incomplete; it would not by itself say why.
- **Going forward (independent of `r3x`):** a fixed `SOURCE_DATE_EPOCH` in the Helios recipe, and a re-pin to such a
  build. A pin change requires root review and a NEW image.

**Production remains blocked for Helios native provenance until an exact reproduction or a reviewed re-pin exists.**
