# Native reproduction: interrupted first attempt, recovery scripts and integrity checks (2026-10-25)

**Status (updated after root's foreground run): R1 REPRODUCED. R2 and R3 UNFINISHED and NOT published here.**
- **ONE native is reproduced: the release listener `enclave-base-head-listener` `9ca75047…`, by a FRESH build** (section 6).
- **No other native is reproduced:** witness-check `4fe0cd3b` and Helios `cc962e2b` are still open, and the 4 libraries
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
- **R2 (`r2b`) and R3 (`r3-b93fcfd`, `r3-eeffcc9`):** were still running or pending when this was written. Their logs
  are deliberately NOT copied, to avoid publishing incomplete files. No result is claimed.
