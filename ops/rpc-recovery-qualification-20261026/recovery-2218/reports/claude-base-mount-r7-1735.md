# base-state-readonly-stage/r7: fail-closed /vm device-identity parser (root 1735). Source only - 2026-10-26

**Not done by me:** no build, test, mount, scratch or data copy.
- **One read-only metadata query:** after freezing, I ran `findmnt -n -o UUID,SOURCE,FSTYPE,MAJ:MIN -T /vm/enclave-volumes | cat -A`. It shows exactly root's shape: `aaae081c-f829-4484-a50f-a9bbb87d31f9 /dev/mapper/cryptvm ext4 253:1  $`, with two trailing spaces.
- **Preserved and verified:** r4, r5 (`71e5fac4…`) and r6 (`c7315770…`).

## The cause and the fix
- **The cause:** r5/r6 `jobs/build.sh` compared `"$(findmnt … | tr -s ' ')"` with the exact string `"$VM_UUID $VM_SRC $VM_FS $VM_MM"`. findmnt pads its last column, and `tr -s` squeezes the padding to ONE trailing space, so the comparison could never match. The job refused before any scratch was allocated.
- **The fix in r7:**
  - **A new `jobs/mount_identity.py`** (stdlib only) runs `findmnt -n -o UUID,SOURCE,FSTYPE,MAJ:MIN -T /vm/enclave-volumes` (PATH=/usr/bin:/bin, 10 s, stdin closed).
  - **It requires all of:** rc 0; **exactly one** non-blank line; **exactly 4** whitespace-separated fields; and each field equal to its pinned value, **compared one by one** (`uuid`, `source`, `fstype`, `majmin`). Pinned values must be non-empty and contain no whitespace.
  - **Everything else refuses with exit 9:** missing, extra or mismatched fields, several lines, no output, or a findmnt error. Only padding is tolerated.
  - **The build.sh change:** it calls this script instead of the string compare. It still refuses with "## REFUSED: /vm is not the pinned device".
- **Unchanged:**
  - `jobs/disk_guard.py`, `tests/test_disk_guard.py` and `tests/guard_wrapper.py` are **byte-identical to r5**. `build.sh` still `cmp`s them against r5 and requires r5 to be frozen.
  - **All thresholds** are unchanged (start ≥ 64 GiB free, floor 40 GiB, scratch ≤ 20 GiB, 7500 s), and so are the guard's own mountinfo majmin/source/fstype check.
  - `src/main.rs` and `src/bin/mk_fixture.rs` are **= r6**: the mandatory hashed-only root plus the trie-cache Verifier. **They are still NOT compiled and unqualified.**
- **Expected next real outcome:** with /vm at about 59 GiB free, the identity check now passes, and **disk_guard.py must then refuse** (< 64 GiB to start, rc 3). That is a correct refusal, not a defect.

## Parser fixtures: `tests/test_mount_identity.py` (6 tests; pure strings, no findmnt or mount)
1. **Padded valid lines:** the observed line with two trailing spaces is accepted, and so is any column padding (leading spaces, a tab, blank trailing lines).
2. **Missing field** (3 fields) → refused, "exactly 4 fields".
3. **Extra field** (5 fields) → refused.
4. **Wrong device:** each single field wrong (uuid, source, fstype, majmin) → refused, naming that field.
5. **Several lines, empty output or a blank line** → refused.
6. **The CLI refuses** a pinned value containing whitespace (exit 9).

**`jobs/guard-tests.sh`** now runs both suites, each of which must pass exactly: disk guard "Ran 10 tests", mount identity "Ran 6 tests". Each needs last line OK, empty stdout and no bad markers.
- **Receipt:** format `bsro-guard-test-receipt/r7`, with both suites and `stageSums`. `build.sh` requires this r7 receipt.

## Stage: `base-state-readonly-stage/r7`, FROZEN
**`SHA256SUMS` = `7d4ccc8f873c435f6e1fd5577e8f6d40e833479605c79701fe742dfcb00e0056`.**

| file | sha256 |
|---|---|
| `jobs/mount_identity.py` (new) | `fc4d1ede042e36894a70d1e825a1f934dc0fd16239ce700e39d402ebb79918a1` |
| `tests/test_mount_identity.py` (new, 6) | `ac6b23084dca313edaa50dd0405055b51e3a9098c27ff009a52640bca720a165` |
| `jobs/build.sh` | `4d28e87b43206a84fa09fd140b0665f6891f57a2d1713dc47473f53016bfd89b` |
| `jobs/guard-tests.sh` | `696ae876c03b2b1afd745876b351a92deca173627d4fa97c580686fa1203df26` |
| `jobs/disk_guard.py`, `tests/test_disk_guard.py`, `tests/guard_wrapper.py` | = r5 (`b42cf8fd…`, `366878f5…`, `6c6e231c…`) |
| `src/main.rs`, `src/bin/mk_fixture.rs`, `Cargo.toml` | = r6 (`597a499a…`, `1db170dc…`, `42dcdc8f…`) |
| `jobs/build-inner.sh`, `env.sh`, `fixtures.sh`, `positive.sh`, `preflight.sh` | r6 with the r7 labels only |
| `README.md` | `c51253426ef897e3061a06976f3f98b11ed5e5032f29b391d25ae17fd8bf4be6` |

## Exact root commands
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh bsro-r7-guard-tests 256 unshare -Urn bash base-state-readonly-stage/r7/jobs/guard-tests.sh     # both suites PASS (10 + 6), r7 receipt
bash jobs/q-exit-status.sh bsro-r7-build 4096 unshare -Urn bash base-state-readonly-stage/r7/jobs/build.sh                # identity now passes; at < 64 GiB free the guard refuses (rc 3)
# after >= 64 GiB free on /vm and a build PASS:
bash jobs/q-exit-status.sh bsro-r7-fixtures 512 unshare -Urn bash base-state-readonly-stage/r7/jobs/fixtures.sh <ABS runs/build-*/base-state-readonly>
bash jobs/q-exit-status.sh bsro-r7-positive 512 unshare -Urnm bash base-state-readonly-stage/r7/jobs/positive.sh <ABS runs/build-*/>   # "## cases=14 failed=0"
```
- **Optional standalone parser check** (read-only; it prints the parsed fields):
```
python3 -I -B base-state-readonly-stage/r7/jobs/mount_identity.py --target /vm/enclave-volumes --uuid aaae081c-f829-4484-a50f-a9bbb87d31f9 --source /dev/mapper/cryptvm --fstype ext4 --majmin 253:1
```

## Corrections and not claimed
- **Correction to 1733:** a real **read-only** check is **already authorized**. Only writes, downloads and VM boot are paused. 1733's "needs separate authorization" was wrong on this point.
- **Nothing executed** except the single read-only findmnt display above.
- **The r6/r7 full-state code** (hashed-only root + Verifier) is uncompiled and unqualified until root's build and `positive.sh` (14 runs) pass.
- **The canonical chain anchor** remains separate and required.
