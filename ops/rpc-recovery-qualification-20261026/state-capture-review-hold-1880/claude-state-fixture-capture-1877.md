# 1877: state-fixture-capture-stage/r1, capture-authenticated receipts for the frozen r11 compiled fixtures (SOURCE ONLY; nothing run)

**Scope:** root 1872 applies.

**What I did not do:** run, test, build or queue anything; use the network or mounts; read part, backup or production data; install; commit; touch frozen stages.

**Read before writing:** r11 `jobs/{bsro_gate.py, positive.sh, fixtures.sh, build.sh, build-inner.sh}` and `state-helper-qualification-stage/r1`.

**Re-verified after writing (`sha256sum -c` clean):**
- r11 (`246ff06b…`) and r10;
- acceptance r1 (`25ca8ece…`).

**Saved evidence I found:** acceptance r1's actual tests **PASSED**: `runs/tests-20261027T093534Z-3031705/receipt.json` (sha `1f6ec605…`), `pass: true`, `Ran 38`, rc 0, stage SUMS `25ca8ece…`. That receipt is now a pin here.

**No claim of RPC, state or canonical readiness.** No compiled r11 build exists, so no fixture run or receipt exists.

## Frozen stage
- **SHA256SUMS sha256:** `state-fixture-capture-stage/r1/` → **`178f4c3a4388ff78b89efbd2e1c20b408befb975c0ae0609b4432f3f173441f6`**
- **Contents:** 5 files, all a-w; no runs/`__pycache__`.

| file | sha256 |
|---|---|
| `capture.py` | `de73b0af33956e1f2308357b419cd95976b4ed28a1821dcedf77e6d6df82014e` |
| `jobs/run.sh` | `706319e5f59a7a5707cf63d1001fe46ec19784d74225122174ed4fe80978e0d3` |
| `jobs/tests.sh` | `9b690762c74b0960265ee9d19dd0f2ee3839fe38a319b68b812736cf42123193` |
| `tests/test_capture.py` | `35b1a8c6c2807581bfa652fc749ace92c033a7d9e5ab5ab6919b71aab98597d6` |
| `README.md` | `43e204f1cd81f4b6c983c54c9bb9059f2ae510079664fc7a3a588103fde84ab0` |

**Pins in `capture.py`:**
- r11 SUMS `246ff06b…` and r11 `jobs/bsro_gate.py` `42cf6b47…`;
- acceptance SUMS `25ca8ece…` and `acceptance.py` `81c3fd3c…`;
- the acceptance 38-test receipt `1f6ec605…`.

The r11 script shas come from acceptance's own pins (`24b8c3e9…`, `fc1e2842…`) and are cross-checked against the r11 SUMS.

## The reusable seam: used unchanged, no frozen-gate change needed
**Loading:** `capture.py` loads the pinned r11 `bsro_gate.py` **from its hashed bytes**, as `load_exact` does. The module's `S` is the r11 stage.

**It reuses:**
- **`run_capture`:** the owned new session/group with a bounded NEW file (1 MiB kept, rest drained and counted), TERM/INT/HUP forwarding, the grace/hard/term_wait deadlines, owned-group cleanup and the single final reap (the r10 fixes);
- **`verify_binaries`:** before and after the run;
- **`qualified`:** r11 guard + ns PASS receipts;
- **`live_completion`:** the all-265 gate;
- **`no_live_sessions`**;
- **`root_floor_ok`:** applied to `free − 128 MiB` for the scripts' own `r11/runs` files;
- **`maps_inside`:** exact `0 <uid> 1` maps, setgroups deny;
- **`propagation_private`**;
- **`group_alive`, `file_sha`, `write_new` and `read_all`.**

**From acceptance r1:** `check_fixture_capture` and `MAX_CAPTURE_BYTES`.

**Local additions, small and each tested:**
- **(a) A 512 MiB lane check.** r11 `own_lane` is hard-wired to the 4096 MiB build lane, and the r11 README puts the fixtures in the 512 lane. It keeps the same 16 GiB host floor + 256 MiB headroom.
- **(b) A wall-clock bound:** `/usr/bin/timeout -s TERM -k 60 LIMIT` (positive 12600 s = 26 × (120 + 300) s + margin; fixtures 900 s), inside the owned group.
- **(c) The exactly-one build receipt lookup.** It uses `verify_binaries`' own rule plus `mode == build`, because `verify_binaries` does not return which receipt matched.
- **(d) Leftover checks:** `/tmp/bsro-r11-{pos,fix}-*` dirs and mounts, before (refuse) and after (fail).
- **(e) The receipt** (`bsro-fixture-capture-receipt/r1`) and the consumer check `receipt_errors`.

## Flow of `jobs/run.sh KIND BUILD_OUT_DIR`
It does: this stage's `sha256sum -c`, then `unshare -Urnm env -i … python3 -I -B capture.py run …`. `capture.py run`:
1. **Verifies SUMS** of every listed file: this stage, r11 and acceptance. It checks the pinned shas of `bsro_gate.py`, `acceptance.py` and the 38-test receipt (`pass` true, `Ran 38`).
2. **Checks the namespace:** maps and private propagation, and no IPv4 route.
3. **Checks the gates:** qualified; `live_completion` (fingerprint recorded); `no_live_sessions`; the 512 lane + host floor; the root floor; /vm free ≥ 40 GiB + a 64 MiB capture budget.
4. **Checks the build output:** `BUILD_OUT_DIR` must equal `/vm/enclave-volumes/rpc-recovery-validation-build/run-<UTC>-<pid>/out` as its own real path. `verify_binaries` must pass with exactly one verified build receipt. The expected identities come from:
   - the r11 SUMS pin and the script pin;
   - the receipt's `guard.binaries` shas;
   - the receipt sha.

   The observed identities must equal them. There must be no leftovers.
5. **Creates its own dir:** `BUILD_OUT_DIR/fixture-captures/` (0700, ours, same filesystem), then a NEW `<kind>-<UTC>-<pid>/`. **Up to here, any failure → rc 3 and nothing has run.**
6. **Spawns** `timeout … /usr/bin/bash <r11>/jobs/{positive|fixtures}.sh <BD | BD/base-state-readonly>` via `run_capture` into `capture.txt`.
7. **After the run:**
   - observes the identities again;
   - re-verifies the r11 and acceptance SUMS;
   - runs `verify_binaries` again;
   - checks for leftover tmp dirs and mounts, and whether the group is still alive;
   - runs `check_fixture_capture` (rc, timeout = 124/137 or abandoned, truncation = total > kept, identities);
   - runs `decide`.
8. **Writes `receipt.json`** with `write_new` (O_EXCL, ≤ 1 MiB). **`pass` is true only if every check holds → rc 0; otherwise rc 4.**

## Prepared tests (NOT run): 12 pure tests; `jobs/tests.sh` on the 256 lane
1. **Pins:** every pin re-hashed; r11 SUMS lists the scripts and gate at those pins; the gate source has `BASE` and the reused functions.
2. **`parse_sums`:** strict, rejecting duplicates, an absolute path, `..`, uppercase hex, bad spacing, no final newline, empty, bytes.
3. **The 512 lane / host floor**, incl. 4096, `max`, below the floor, and a bool.
4. **IPv4 route refusal.**
5. **Leftover dir/mount detection.**
6. **The build out-dir shape**, incl. a trailing slash, `..`, root, /tmp, None.
7. **The build receipt rule** (each disqualifier; 2 matches is not 1) and the expected identities per kind.
8. **`decide`:** pass only when complete. 16 fault cases: no rc, abandoned, sink error, truncated, timeout, `timed_out` None, identity changed, identity ≠ expected, tmp/mount leftovers, live group, no cleanup record, `verify_binaries` after false, an invalid or missing check, no cap.
9. **`decide` with the pinned acceptance check** on synthetic captures: an exact pass, `failed=1`, a timeout. `authenticated: false` is asserted.
10. **`receipt_errors`:** the exact keys; `synthetic: true`, a non-capture source, `pass` false, reasons, kind, format, verify, identities, pins, check, cleanup, spawn, each capture flag, a missing/extra key.
11. **Confinement:** `run_capture`, `write_new` and `mkdir` are used only in `run()`; `exec` only in `load_pinned`; `run` called only from `main`; no subprocess/shutil import.
12. **The `run.sh` invocation:** SUMS check, `unshare -Urnm env -i … capture.py run`, uid/gid, the /vm path pattern, no fixture flag.

**Synthetic inputs** in the tests are parser inputs: never written as receipts, never qualification.

**Command:**
```
bash jobs/q-exit-status.sh sfc-r1-tests 256 unshare -Urn bash state-fixture-capture-stage/r1/jobs/tests.sh       # expect Ran 12, OK
```

## Remaining required live/compiled tests (in order; none claimed)
1. The r11 guard-tests (10 + 6 + 16) and ns-tests (5) actual PASS (queued).
2. The r11 `build-outer.sh preflight` and `build` on 4096, after all 265 are CONFIRMED, giving a verified build receipt. **The r11 Rust has never been compiled.**
3. `sfc-r1-tests` (12, pure).
4. `sfc-r1-positive` and `sfc-r1-fixtures` on 512, giving two `pass: true` receipts on /vm. **Only these are real fixture receipts.**
5. The state runner (1869 §2), which consumes them via `receipt_errors` + re-checking `capture.txt`. The header extraction, the cmv-r10 structural run, G8 and final acceptance remain separate.

## Precise scope limits / blockers (no unsafe duplicate made)
- **B1, the namespace (the requested "inside the reviewed build namespace" is NOT possible with the frozen scripts):**
  - **Why:** the frozen `positive.sh`/`fixtures.sh` create `T=/tmp/bsro-r11-{pos,fix}-…`. `positive.sh` also writes `O=$S/runs/positive-…` and bind-mounts fixture dirs. Under the build namespace's `ns_harden /home/steven /tmp` (recursive RO), all of those fail with EROFS.
  - **What I did instead:** the wrapper runs them where their headers say: a private `unshare -Urnm` namespace (exact maps and private propagation re-checked), not RO-hardened.
  - **What still protects the frozen source:** byte-binding, not RO mounts. The r11 and acceptance SUMS are re-verified after the run, and the script/binaries/receipt are re-hashed.
  - **Smallest required change (a future r12 of the scripts only; `bsro_gate` unchanged):** take an explicit work/output dir argument, which the wrapper passes as `BUILD_OUT_DIR/fixture-captures/<run>/work` on /vm. Then the run can happen under `ns_harden /home/steven /tmp` with only that /vm dir writable.
- **B2, output placement:**
  - **What is on /vm:** this wrapper's `capture.txt` (≤ 1 MiB kept) and `receipt.json` (≤ 1 MiB).
  - **What is on root:** the frozen `positive.sh` still writes its per-case evidence to `r11/runs/positive-*`, each `head -c 1 MiB`. Typically KBs, worst case about 100 MiB; the root floor check includes a 128 MiB allowance.
  - **The fixture trees:** they live in `/tmp` and are removed by the script, which is verified afterwards. The B1 change would move all of it to /vm.
- **The lane:** a local 512 MiB check, because the frozen `own_lane` is 4096-only. If root prefers the 4096 lane, `own_lane` would need parameterization in a new bsro revision; I did not duplicate it.
- **Writes into the build out dir:** the wrapper adds `out/fixture-captures/` after accounting, so `runDirAllocBytes` in `accounting.json` predates it (informational). `authenticate`/`verify_binaries` check only the binaries and `accounting.json`, so they are unaffected.
- **Receipt authenticity:** the receipt is honest-capture evidence only; it cannot defeat a malicious same-user writer. Consumers must re-check `capture.txt` (sha-bound in the receipt) with the pinned acceptance check.
- **Untested here:** the GNU `timeout` group behaviour inside the `run_capture` session (it signals its own process group, i.e. our owned group), the real merged stderr of the scripts (any noise fails closed), and the namespace checks. All of these need the live runs above.
