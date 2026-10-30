# base-bytecode-check v2 release candidate: Ubuntu guest ABI launch + REFUSAL-ONLY smoke (PREPARED; NOT run)

## Status

- **Not done:** nothing here has been executed, copied to the guest, or run over SSH. There was no live database access, queue use or commit.
- **Root runs it.** It is a **launch/refusal smoke only**:
  - no datadir is opened;
  - it is not a scan, not a performance or functional test, and not a deployment.
- **A2:** `BYTECODE_CHECKER_V2_SHA256` stays `None`.

## The candidate

- **Binary:** root's actual release `root-bytecode-v2-release-2303` (rc 0): `b55e6b78c6ac8e0a672f69e238135eca7466d1081479cd0868204cee9a1654d7`, 1,276,048 bytes, at `finality-stage/bytecode-v2-recovery/build/target/release/base-bytecode-check`.
- **Manifest:** `bytecode-v2-release-recovery/release-logs/release-manifest.json` (`06c88f03…`).

**Static ELF facts** (`binary-elf.txt`; `readelf` only):
- **Interpreter:** `/lib64/ld-linux-x86-64.so.2`.
- **NEEDED:** `libc.so.6`, `ld-linux-x86-64.so.2`, `libgcc_s.so.1`; no RPATH or RUNPATH.
- **Highest symbol versions required:** `GLIBC_2.38` and `GCC_4.2.0`.
- **Not linked:** OpenSSL and libstdc++.

**What this implies (necessary, not sufficient):**
- By symbol versions, the binary may load on the Ubuntu target's system glibc 2.39 (root, 19:34), as v1 `42d692d4` did.
- Only the guest run below establishes that it launches.

## Based on the v1 helper

Root's v1 guest smoke (`bytecode-native-validated/release-evidence/ubuntu-smoke.out`, rc 0) checked:
- the pinned sha;
- that a missing argument is refused with `usage`;
- that an absent `<dir>/absent-datadir` is refused with `Could not open database at path:`;
- that no directory was created.

`abi-smoke.sh` makes that procedure a pinned script, with refusals checked **before** the binary is launched:
- the argument sha must be the release pin, and the binary sha and size must match;
- no `LD_*` variable and no `/etc/ld.so.preload`;
- it runs as root, with the dir owned by root and mode 700;
- the dir is not under `/srv`, `/var/lib` or `/opt/enclave-rpc*`;
- the dir holds **exactly** the script and the binary, and the binary is not a symlink.

**v2 cases** (each must exit **1** with the exact message; empty environment, stdin `/dev/null`, 30 s timeout):

| Case | Arguments | Expected |
|---|---|---|
| usage | none | `usage: base-bytecode-check <datadir>` |
| extra-arg | two paths (absent) | `usage: …` (v2 `main.rs`: exactly one argument) |
| absent-db | `<dir>/absent-datadir` | `Could not open database at path:` |
| non-utf8 | `<dir>/absent-\xff` | `datadir is not UTF-8` (v2 `args_os` + `into_string`) |

**After the cases:** the dir must still hold exactly the two files (nothing was created), and the binary sha must be unchanged.
- **Pass:** the last line is `## abi-smoke rc=0`, preceded by `ABI launch/refusal smoke PASS; no live database accessed`.
- **Refusal before launch:** rc 2.

## Root commands (guest; root's existing guest access; fresh private dir)

```
# on the build host: the two inputs and their pins
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
sha256sum $P/finality-stage/bytecode-v2-recovery/build/target/release/base-bytecode-check $P/finality-stage/bytecode-v2-abi/abi-smoke.sh
# on the guest (as root), after transferring exactly those two files into a NEW dir:
DIR=/root/enclave-rpc-bytecode-v2-abi-$(date -u +%Y%m%d-%H%M); install -d -m 700 -o root -g root "$DIR"   # then place the two files in it
sha256sum "$DIR/base-bytecode-check" "$DIR/abi-smoke.sh"     # must equal the pins below before running
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 unshare -n timeout 300 bash "$DIR/abi-smoke.sh" "$DIR" b55e6b78c6ac8e0a672f69e238135eca7466d1081479cd0868204cee9a1654d7 > "$DIR.out" 2>&1; echo $? > "$DIR.rc"
```

- **Pins:** `abi-smoke.sh` is in `SHA256SUMS` here; the binary is `b55e6b78…`.
- **Placement:** keep the outputs outside the dir (`$DIR.out`, `$DIR.rc`), so the "nothing created" check stays exact.
- **Accept** only rc 0 with the PASS line.

## Not established

- Behaviour on a real datadir, and the full read-only scan at N.
- The Ubuntu libgcc version (`GCC_4.2.0` is very old and expected everywhere, but it was not checked on the target).
- Exact glibc loader behaviour beyond launching.

These need the separate live read-only run under root review, after A2–A4.
