# 1884: acceptance r3 (bsro r12 pins) + independent review of bsro r12 fixture scripts and state-fixture-capture-stage/r2 (SOURCE ONLY)

**Scope of MY activity:**
- **Created:** `state-helper-qualification-stage/r3`.
- **Read:** report 1879, the r12 vs r11 diffs, r12 `positive.sh`/`fixtures.sh`, and capture r2 `capture.py`/`jobs/run.sh`/`jobs/inner.sh`.
- **The only checks I ran:** `ast.parse` syntax checks and `sha256sum -c`.
- **Not done:** tests, queue jobs, mounts, builds, network, data access or commits.
- **Untouched and re-verified clean:** acceptance r1 and r2, bsro r12 (`2911943d…`) and capture r2 (`f07bd6da…`).
- **Results:** the r2 46/46 PASS is root's. **No r3 test has run.**

## 1. Acceptance r3 (= r2 with only the r12 pins, markers, source test and labels)

| r3 file | sha256 |
|---|---|
| `SHA256SUMS` | `1e7eb6367e2cfbbf38c0f6debb92492421f3b9086dc3f8fd8236ce55319faadd` |
| `acceptance.py` | `b2c10534ac349a3233da06aed60374ae20762d2b1b8527bbb799e74078cfd0ec` |
| `tests/test_acceptance.py` (46) | `4e6698c3159ade91c94732af43f39a51d812414791cb555f3f6e54e3d8a9b58d` |
| `jobs/tests.sh` (requires exactly `Ran 46 tests`; receipt format r3) | `5d92db88dbbad7eb04e8dbdd32b22f74559f2ed085d700ba11005800de7f6a98` |
| `README.md` | `12e172f273aca78e47386adf46c90d152d38f72cd869f93e2b7416ade1359dc2` |

**The pins:**
- `R12_STAGE_SUMS_SHA256` `2911943d…`, `R12_POSITIVE_SH_SHA256` `3ba41117…` and `R12_FIXTURES_SH_SHA256` `4cf3d582…`. All equal the frozen r12 SUMS entries.
- `R12_MAIN_RS_SHA256` `5a6fa214…` (byte-identical to r11).
- They are used by `pins_errors` (the final-evidence `stageSums`) and by `_identity_errors` (the capture's expected stage/script).

**Markers:** `## bsro-r12-positive rc=0` and `## bsro-r12-fixtures rc=0`. A grep confirms neither r12 script contains `bsro-r11-`.

**Tests:**
- r2's 46, with the pins and markers updated.
- **Test 37** now cross-checks against frozen r12. It also asserts `echo "## outputs $O"`, `O=$WORK/out`, and no `bsro-r11-` marker in either script.
- **The count stays 46.**

**Unchanged:** a normalised diff of r2 → r3 (r11/r12 names, the shas and the labels masked) shows **only docstring/comment lines** differ. Therefore unchanged:
- the report format `base-state-readonly/r11` and all report constants;
- the schema, `derived_exit`, the predicate and classification;
- the P1–P4 evidence rules;
- the 26 labels and 6 cases, `## runs=26 failed=0` and `## fixtures failed=0`.

**Root runs:** `bash jobs/q-exit-status.sh sq-r3-tests 256 unshare -Urn bash state-helper-qualification-stage/r3/jobs/tests.sh`.

## 2. Review of bsro r12 `positive.sh` / `fixtures.sh` (the substantive changes only)
**Sound:**
- **The arguments:** exactly 2 arguments, no default and no fallback. The regex is anchored to the `/vm` guard run `out` dir. WORK must be `BD/fixture-captures/<[A-Za-z0-9_-]+>/work`. BD and the run dir must be their own `pwd -P` on the same device. `mkdir -m 0700 WORK` must create it.
- **Every redirect** targets `$O/` or `$T/` under WORK. There is no `/tmp`, `$S/runs` or `mktemp`.
- **`positive.sh` cleanup:**
  - unmounts each `"$T"/*/` that is a mountpoint (`:167`);
  - then `findmnt` refuses removal while any mount remains under `$T/`, counting a failure;
  - otherwise `rm -rf -- "$T"`, with an rm failure counted;
  - `WORK/out` is kept.
- **`fixtures.sh` cleanup:** `chmod -R u+w "$T" && rm -rf -- "$T"`, with failure counted. The per-case outputs are now kept in `$O`.
- **Output on success** is unchanged except for the marker: `umount`, `mountpoint -q`, `findmnt|awk`, `rm` and `chmod` print nothing. So acceptance r3 parses it exactly.
- **The positive time budget:** 26 × (120 + 300) s = 10,920 s, under the capture's 12,600 s limit.

**Issues (minor, not blockers):**
- **S1:** both scripts `mkdir` WORK **before** the stage `sha256sum -c`, `verify-binaries` and (positive) the IPv4-route check. Report 1879 says "before any write", which is not quite true. A later exit 9 leaves an empty WORK; capture then records `evidenceKept` false and fails, closed. Fix in a future revision, or correct the wording.
- **S2:** the full helper JSON (`$T/out/<label>.json`) is deleted with `$T`; only a ≤ 1 MiB copy (`$O/<label>.result.json`) is kept. That is acceptable at fixture sizes, but it should be stated as the evidence boundary.

## 3. Review of capture r2 against RO home/tmp, NVMe-only writes, command cleanup and provenance
**Sound:**
- `precheck` runs outside any namespace before `unshare`.
- `inner.sh` pins the r12 SUMS and the `ns.sh` sha, then `ns_harden /home/steven /tmp`, then `exec env -i … capture.py run`.
- `run` repeats every gate, then `maps_inside`, then no IPv4 route, then `ns_checks(ro=[/home/steven, /tmp, r12, this stage], rw=[BD])`.
- It creates a NEW 0700 run dir on BD's device, and spawns `timeout -s TERM -k 60 LIMIT bash <pinned script>` through the pinned r12 `run_capture` (an owned group; `timeout` is the session leader, so its group signal reaches `mk_fixture` and the helper).
- **The post-checks:** identities before == after == expected, stage SUMS re-verified, `verify_binaries`, `ns_checks`, no mount under the run dir, `trees` gone, `out` kept, group not alive, r12 `runs/` unchanged, and the parser.
- **The receipt** is `write_new`; anything else is rc 4 with `pass:false`.

**Actionable issues for capture r3** (r2 is frozen; I edited nothing):
- **B1. Writes outside `/vm` are not enforced RO; only `/home/steven` and `/tmp` are.**
  - **What stays writable:** inside `unshare -Urnm`, every other path writable by the outer uid remains writable. That includes `/var/tmp` (the root filesystem), `/dev/shm` and `/run/user/<uid>` (tmpfs/RAM), and `/dev/mqueue`.
  - **The consequence:** confinement of writes to `/vm` currently rests on the scripts' construction, not on enforcement. "NVMe-only writes" is not guaranteed.
  - **Fix:**
    - `inner.sh`: `ns_harden /home/steven /tmp /var/tmp /dev/shm /run/user/$OUID` (each that exists);
    - add the same paths to `RO_PATHS`, so `ns_checks` and the post-run `roStillOk` verify them recursively;
    - extend the ns test to cover tmpfs `/dev/shm` and `/run/user`.
  - **Alternatively:** a writable-probe check that refuses if any path outside BD's run dir is writable.
- **B2. BD's filesystem is not asserted to be the NVMe `/vm`.**
  - **What exists:** `out_dir_ok` (a path regex), `realpath`, same-device checks for the subdirs, and free space.
  - **What is missing:** nothing binds BD's mount, meaning its mountinfo entry (major:minor, source, fstype), to a pinned NVMe identity. A different filesystem mounted at `/vm` would pass.
  - **Fix:** pin `/vm`'s mount source and major:minor from root's existing records. Check them in `gates` and inside the namespace, and record them in the receipt.
- **B3. The provenance does not bind `WORK/out`.**
  - **What is bound:** `capture.txt` (by sha), the identities and the build receipt.
  - **What is not:** the per-case evidence files and `binaries.sha256`, so later tampering is undetectable.
  - **Fix:**
    - after the run, record a bounded manifest of `work/out` (regular files only, no symlinks; name, size, sha256; count and byte caps) in the receipt, and require it in `receipt_errors`;
    - also require that the positive run's `binaries.sha256` lines equal the expected helper and `mk_fixture` shas.
- **B4. The `## outputs` path is unbound.** Acceptance r3 accepts any absolute path. Capture must parse that line from `captured` and require it to equal `<runDir>/work/out` (report 1879 §5b also recommends this).
- **B5. The parser binding for capture r3:**
  - `ACCEPTANCE = {"sums": (<acc r3>/SHA256SUMS, 1e7eb636…), "module": (<acc r3>/acceptance.py, b2c10534…), "tests": (<the actual sq-r3-tests receipt>, sha)}`.
  - **Tighten `gates`'** test-receipt check, which today requires only `pass` and `stageSums`. Also require `format == "state-acceptance-test-receipt/r3"`, `expected == 46` and `ran == ["46"]`.
- **B6. A failed run's trees are not cleaned up (minor).**
  - **What happens:** after a timeout or kill, the bind mounts under `$T` remain until `capture.py` exits and the namespace dies. The receipt records `mountsLeft`/`treesLeft` and fails, closed.
  - **The gap:** the trees then stay on `/vm` with no cleanup path. Document a manual, ownership-checked removal. Never let it be automatic over an unverified tree.
- **B7. Residual TOCTOU (documented, accept):** a recovery session started between `precheck` and `ns_harden` would be cloned read-only into the private namespace. `run`'s gates then refuse after the fact. Nothing is written to it, and the clone dies with the namespace.

## 4. Order (no claims)
1. Root runs `sq-r3-tests` (46).
2. Capture r3 implements B1–B5: a pinned acceptance r3 plus its actual receipt.
3. The r12 guard/ns suites pass.
4. The r12 build, which needs all 265 parts CONFIRMED.
5. The `sfc` positive/fixtures runs.

Nothing here is a compiled-fixture qualification, a state result, canonical proof, recovery acceptance or reset authority.
