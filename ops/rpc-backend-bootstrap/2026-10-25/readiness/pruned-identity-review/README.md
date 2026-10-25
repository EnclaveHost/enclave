# Pruned-genesis identity review (2026-10-25)

**Status:** test behaviour **PASS** on review. **Every wrapper exited 1, and that is kept as recorded.** Root installed
the read-only sampler `9aa80ab8…` in versioned form. A new live window is still running; there is no result here.

| Item | sha256 |
| --- | --- |
| `../readiness_sampler.py` (tested, installed) | `9aa80ab8a2cbe156f513349f44366c4ad2c8588539666ac802ed9015c771d055` |
| `../test_readiness_sampler.py` (tested in 2011) | `10c88fa2618b43f793e49ce62b59e3c35d7c99fd5dc992a5afde9750e80bdf72` |
| `negative-control/original_readiness_sampler_b15b77af.py` (pre-change sampler; the baseline negative control) | `b15b77afa653ee70439596d1a6aa6b8b4add0371e0a6d01eb506e276c114cec8` |

For what the change accepts and why it is sound, see `../README.md`, "Pruned-genesis identity". In short:
- **Accepted:** only reth's exact code-4444 `pruned history unavailable: requested 0, earliest available N` refusal.
- **Still required:** all pinned chain identity checks, plus a compensating paired (L1) or derived (Base) finalized
  block. That basis is downgraded unless its pairing gates hold for the whole window.
- **Trust:** operational identity that trusts the local CL and rollup node. It is not cryptographic authority against
  the host, and the sampler does not call Helios.

## Test history (every attempt, in order)

**1. `logs/test-20261025T195417Z.out`** (worker background run via `jobs/run-queued.sh`; the guard log was not kept)
- **Result:** died after about 6 cases. **No rc.**
- **Verdict: NOT a pass, not evidence.**

**2. `logs/root-tests-2003.{out,guard,rc}`** (root foreground run via `jobs/jobs.sh`; sampler `9aa80ab8`, test
`b8f79ccc`)
- **Result:** rc **1**. The suite ran 89 tests, OK; the baseline was KILLED (2 failures); m1, m2, m4 and m5 were KILLED.
  m3 was **SURVIVED by rule**: `errors=2`, because a `KeyError` was raised instead of an assertion failing.
- **Verdict: FAIL.** The test-strictness defect was fixed test-only with `.get('code')` in two assertions, giving test
  `10c88fa2`.

**3. `logs/root-tests-2011.{out,guard,rc}`** (root foreground run via `jobs/jobs-rerun-as-run-2011.sh`; sampler
`9aa80ab8`, test `10c88fa2`)
- **Result:** wrapper rc **1**. The suite ran **89 tests, OK**; **BASELINE KILLED** (2 failures); **m1-m5 all KILLED**
  by assertion failures: 6, 1, **2**, 1 and 2.
- **Why rc 1:** the wrapper then printed `NOT ALL 5 MUTANTS KILLED` because of **its own reporting regex bug**:
  `[a-z-]` cannot match the digit in `m2-no-in-gate-l1-pairing` or `m5-pruned-skips-cl-identity`.
- **Verdict: test behaviour PASS. The wrapper's exit 1 is retained.**

**Root's independent review: `logs/root-tests-2011-reviewed.json`.** It parses the exact five named
expected-failure counts from the out file (bound by its sha256 `059d2d37…`), and records `originalWrapperExit: 1`.
- Root corrected **only** the reporting regex, to `[a-z0-9-]`: `jobs/jobs-rerun-corrected-not-executed.sh`,
  `3d96baad…`.
- **That corrected wrapper has NOT been executed. No re-execution and no wrapper rc 0 is claimed.**
- `jobs/jobs-rerun-as-run-2011.sh` (`20aaa328…`) is the wrapper as it actually ran. It was reconstructed by reverting
  only that regex line, and the reconstruction hashes exactly to the pre-correction digest.

**Recipes:** `jobs/jobs.sh` (unchanged across 2003 and 2011) and `jobs/mutants.py` are the exact stage recipes. They
use the workstation stage layout (`orig/`, `patched/`, `tmp/`) and absolute paths, so they document what ran; they
are not a portable runner.
- **`mutants.py`:** a kill requires an assertion failure, not an error.
- **The five mutants:**
  - m1, generic error waiver;
  - m2, no in-gate L1 pairing;
  - m3, no whole-window enforcement;
  - m4, no Base derived-finalized check;
  - m5, the pruned case skips CL identity.

## Root live install (historical, NOT reusable): `live-install-historical-not-reusable/`

**`run.py`** (`4f653807…`) is root's actual installer and window launcher. It is published as a record only.
- **Before installing,** it checks the review JSON and the sha256 of the 2011 log and of the sampler.
- **The install:** over root's SSH, with `sudo -n`, it writes `/opt/enclave-rpc/readiness/9aa80ab8a/readiness_sampler.py`
  with `O_EXCL`, mode 0644, owned by root, and checks the hash after writing.
- **Then** it starts a 7-sample, 720 s window with `--continue-on-fail`.
- **Not reusable:** it embeds workstation paths and SSH and sudo access. Root may only re-run it after a fresh review.

**`install.out`** (`7032e00f…`) is the receipt: path as above, sha256 `9aa80ab8…`, uid 0, mode `0o644`,
`serviceChanges: false`. No service or config changed.

**Live window not published:** `window.out` and `run.out` (root exec 2169, started about 20:14) were **still growing**
at publication. No live result for the pruned basis is claimed. All live Base gates remain INCOMPLETE while the Base
client is disabled.

`SHA256SUMS` covers every file in this directory.
