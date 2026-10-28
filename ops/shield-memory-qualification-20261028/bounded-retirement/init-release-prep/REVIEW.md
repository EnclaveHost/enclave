# Init release prep: opt-in bounded-retirement marker (budget 1024 MiB)

Date: 2026-10-28. **Source only.** I used only Read, Grep, Glob, Write and Edit.
- Nothing was compiled, run or tested. **No test result exists.**
- No commands were run, and nothing in production, services, VMs, GPUs, config or finance was changed.
- No release was copied or composed.
- I read no secrets, tenant logs or app configs. I read the `release.json` of `release-af50d526` (a public manifest) only to get the pins.

This is not a release, GPU, memory or performance qualification. Production stays on af50d526.

## 0. Reproduction status (a correction to the brief)

The brief says init reproduction is not established. Root's own record says it is, for these inputs:
- `../init-baseline-build/RESULT.json` and `../ROOT-BASELINE.md:11`.
- Source `isolation/m2/dominit.c` = `7427144398f3e0405ba035dad996104bbd582a90099463465b9219162cc86576`.
- musl specs = `4b0202b5…95bf`, `libc.a` = `4f72e098…0959`.
- Built `dffd093b8458e109c64756c26fe5efd8b8226da712fb03a81f28d50aaa27cb0b`, which equals the installed init (116880 B).

I did not re-verify that record (I cannot hash). `build_init.py` uses those values as hard pins and re-establishes the reproduction itself before it builds anything:
- It rebuilds the baseline in the **same scratch layout** the candidate uses (copied `dominit.c` and `*.h` files, same command).
- If that does not give `dffd093b…`, it stops. The candidate is never compiled.
- This also covers the risk that changing the build directory changes the output. GCC's `.file` symbol takes the basename `dominit.c` in both layouts [est], and the gate checks it either way.

## 1. Files (all new, in this directory)

| File | Purpose |
|---|---|
| `shield-retire-marker.h` | `shield_retire_marker_at(path)` and two constants: the marker path and the env string |
| `test_retire_marker.c` | Native tests of the marker parser in a private temp dir |
| `build_init.py` | Pin check → staging → baseline reproduction gate → candidate build → diff and `RESULT.json` |
| `test_build_init.py` | Offline tests: transform, order and envp bound, ELF gate, fake-compiler build gate. Also reads the real original source if it is the pinned bytes |
| `compose_init_release.py` | Three-path composer derived from `prod-loader-rollout/compose_loader_release.py`. That file is not modified or imported |
| `test_compose_init_release.py` | Tiny fixture releases. Uses the source `release-manifest.py` (read only), or `$RELEASE_MANIFEST_TOOL` |

`TASK.txt`, `run.py` and `claude.out` were already here; I did not touch them. There is no hand-copied `dominit.c`. The candidate source is **generated** from the pinned original bytes by `build_init.make_candidate`, and it is written only under the build `--out`. The machine-generated diff is `--out/dominit-retire-budget.diff`.

## 2. The init diff (exactly three insertions, nothing removed)

`INSERTIONS` in `build_init.py`. Each anchor must occur exactly once in the original.
1. After `#include "shield-config.h"` (dominit.c:277): `#include "shield-retire-marker.h"`.
2. After the `reclaim_sources` computation (dominit.c:499-500), still in the forked child, as root, **before** `drop_to_app()` and `app_seccomp_install()`:
   ```c
   const int retire_budget = reclaim_sources ? shield_retire_marker_at(SHIELD_RETIRE_MARKER) : 0;
   if (retire_budget < 0) { dprintf(1, "DOM ERROR %s is malformed: not started\n", SHIELD_RETIRE_MARKER); _exit(125); }
   ```
3. After `envp[ei++] = "ENCLAVE_SHIELD_PRIVATE_SOURCE=fd:198";` (dominit.c:632), inside the existing `if (reclaim_sources)` block:
   `if (retire_budget == 1) envp[ei++] = SHIELD_RETIRE_ENV;` (`ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB=1024`).

Semantics [src]:
- **Marker absent** (`ENOENT`): `retire_budget = 0`. No env is added, and the envp contents and order are exactly today's.
  - The only new runtime effect is one failed `open()` in the large-model app child.
  - The `/shieldmodel` spawn and non-shield spawns never read the marker, because `reclaim_sources` is 0 for them.
- **Marker present but reclaim off:** the marker is not read and has no effect. The composer also refuses any base without `shield-original-source-reclaim.enabled` = `"1\n"`.
- **Marker valid:** a regular file, not a symlink, exactly 2 bytes, exactly `"1\n"`. Then exactly one env entry is added, at a fixed position before `extra`.
- **Marker malformed:** wrong bytes or size, a directory, symlink, FIFO (opened `O_NONBLOCK`, never blocks), `EACCES`, `ENOTDIR` or `ENAMETOOLONG`. The app is refused (`_exit(125)`), in the same way as a failed source-fd open at dominit.c:507.
  - This changes only a release that carries a bad marker. Releases come from the composer, which writes exactly `"1\n"`.
- **No tenant control:**
  - The marker is in the measured initramfs.
  - The value is a compile-time constant; no config field is parsed.
  - `extra` is only ever the front's `ENCLAVE_CONFIG=<config>` (dominit.c:675-681, :951, :982), so a tenant cannot add a second `ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB=` entry to the native envp.
- **envp bound:** `envp[80]`. The worst case counts every `envp[ei++]` as taken, plus the 2 initial entries and the NULL. That is 59 today and 60 after the change (`test_real_original` asserts 60; `check_candidate` refuses anything over 80).
- **Shim side:** the candidate shim parses `1024` as plain decimal in [64, 65536] (candidate/REVIEW.md §4). If the marker were present with the current shim (5fce1b9e), the env would be ignored [est]. The composer does not allow that pairing: it requires the shim to contain the env name.

## 3. Exact commands (not run; root runs them inside its own memory queue, no swap)

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/shield-memory-20261028/steady-memory-r1/init-release-prep

# (a) marker parser, glibc + ASan/UBSan; expects "retire marker: all checks passed (N)"
timeout 120 gcc -std=c11 -O1 -g -Wall -Wextra -fsanitize=address,undefined -fno-sanitize-recover=undefined \
  -I. test_retire_marker.c -o /tmp/test_retire_marker && timeout 30 /tmp/test_retire_marker
# (b) the same header compiled as init is (static musl, clean env)
timeout 120 env -i PATH=/usr/bin:/bin /usr/bin/gcc -specs /home/steven/.cache/enclave-isolation/musl-1.2.6/lib/musl-gcc.specs \
  -static -O2 -Wall -Wextra -I. test_retire_marker.c -o /tmp/test_retire_marker_musl && timeout 30 /tmp/test_retire_marker_musl

# (c) offline Python tests: fixtures in $TMPDIR only; no gcc, release, VM or GPU
timeout 300 python3 -m unittest -v test_build_init test_compose_init_release
#     optionally against the production-pinned manifest tool (must be sha256 6facdb9a77da…fd6b):
RELEASE_MANIFEST_TOOL=/home/steven/enclave-prod/iso-sdshield-1c3cdbb8/isolation/m4/release-manifest.py \
  timeout 300 python3 -m unittest -v test_compose_init_release

# (d) reproduction gate, then candidate init (two gcc runs, each with RLIMIT_AS 2 GiB, CPU 120 s, timeout 180 s;
#     root measured 81 MiB peak for the baseline build). Writes only build-r1/.
timeout 420 python3 build_init.py \
  --m2 /home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov-init/isolation/m2 \
  --musl /home/steven/.cache/enclave-isolation/musl-1.2.6 \
  --installed-init /home/steven/enclave-prod/release-af50d526/template/init \
  --out build-r1
#     pass = exit 0, RESULT.json reproduced:true, baselineBuiltSha256 dffd093b…, candidateInitSha256 = <new pin>.
#     Review build-r1/dominit-retire-budget.diff (only "+" lines, 3 hunks) before anything else.
```

(e) Composer (**not to be run by me**; run it only after (a)-(d) pass and are reviewed). It reads the whole ~17.5 GB release, so the output goes to staging, never into the base:

```
python3 compose_init_release.py \
  --base /home/steven/enclave-prod/release-af50d526 \
  --base-id af50d526be6deefcdd815968ff1dd2c04327f6c3b3f981c0aa90cc585b0effae \
  --init  .../init-release-prep/build-r1/candidate/init --init-sha256 <candidateInitSha256 from build-r1/RESULT.json> \
  --shim  .../steady-memory-r1/candidate-build/libenclave_llama.so \
  --shim-sha256 dd7ad838ec6b1054f8b7f3e90a91d2b35fbcc68878b101e648aea4542001e136 \
  --manifest-tool /home/steven/enclave-prod/iso-sdshield-1c3cdbb8/isolation/m4/release-manifest.py \
  --manifest-tool-sha256 6facdb9a77da31e6ddaf5a544f58a4966ea8dfdede87ad36e50818e22adbfd6b \
  --out <new, nonexistent staging dir> --receipt <new file outside --out>
```

## 4. What the composer enforces [src]

- **Base:**
  - The CLI accepts only af50d526.
  - The pinned tool verifies the whole manifest: every file's sha256 and size, the exact set of directories, no unlisted entry, no symlink.
  - The base `template/init` must be `dffd093b…`/116880, `template/rt/libenclave_llama.so` must be `5fce1b9e…`/73344, and `template/shieldmodel` must be the drop-cache loader `acd688ec…`/3010366.
  - `shield-original-source-reclaim.enabled` and `shield-model-drop-cache.enabled` must both be exactly `"1\n"`.
  - No path may contain `packed24` or `experimental`, and the new marker must not exist yet.
- **Candidates:**
  - Each must be a regular file (no symlink) that matches its pin and differs from the base's copy.
  - The init must be an x86-64 ELF64 with no `PT_INTERP`, and must contain both the marker path and the env string.
  - The shim must be an `ET_DYN` x86-64 ELF64 that contains the env name.
- **Output:**
  - `--out` and `--receipt` must not exist. Neither may lie inside the base, and the receipt may not be inside `--out`.
  - Every file is a new inode copied in bounded chunks, and the bytes written are hashed against the pin. Modes are kept.
  - `release.json` must be byte-equal to the canonical expected manifest. The tool verifies the new release against its own id.
  - An independent walk refuses any extra entry, symlink or hard link.
  - The diff against the base is exactly `{template/init, template/rt/libenclave_llama.so, template/rt/shield-source-retire-budget-1024.enabled}`, with the file count +1 and the same dirs, cmdline, measure and format.
  - After the copy, the base is re-verified and both candidates are re-hashed.
- **Receipt:**
  - Lists the delta, the canonical hash of the unchanged set, the retained markers and the rollback (= af50d526, only read).
  - Its `not_done` field records that this is not admission or activation.

Not covered: a fixture test against the real 17.5 GB base (on purpose), and the production-tool run of the composer tests (command (c), second form).

## 5. Prerequisites before any canary (none done here)

1. **Tests:** (a), (b) and (c) pass, and (d) reproduces `dffd093b…` and gives a candidate pin. The root reviewer reads the generated diff.
2. **Shim:** decide whether the bench shim needs the `reread_bytes` log line (candidate/REVIEW.md §6). If it does, rebuild it, which gives a new shim pin. The composer takes any pin, but the receipt flags `shim_is_reviewed` only for `dd7ad838…`.
3. **Compose** into new staging with (e). Review the receipt. af50d526 stays installed and admitted for rollback.
4. **Prediction:** an independent measurement prediction for the new release with the real EyesOff bundle, like `prod-loader-rollout/remote-predict.py`. It must match the composer's new id/measurement. Any init or shim change is a new measurement, even with the marker removed.
5. **Admission:** install and admit on the live relay, keeping af50d526 admitted. Refresh the relay-expected files; don't reuse the r1-r3 ones.
6. **Controller adoption:** take the manager argv and guestd flags from the **running** process at that time, not from `manager-argv-*.json` or old dry runs.
   - Re-run the `safe_manager_switch.py` dry-run and plan review. Use the `zzzzzzzz-` drop-in naming rule (see `prod-loader-rollout` memory).
   - No stale PIDs (the recorded QEMU pid 44174 is historical).
   - No old wallet, lease or pad actions. Keep exact private pad ownership, and never reuse a burned pad.
7. **Restart:** an explicit, at-the-time, EyesOff-only restart, approved then. First take a fresh read-only guestd snapshot that shows the floors are kept (last one: 29123 MiB available / 18432 MiB floor). No parallel large GPU guest.
8. **Measure** (new measurement required): host `memory.peak`, `released_bytes`/`reread_bytes`, cold start, and decode tok/s against an adjacent af50d526 control, ≥2 boots each, with identical token IDs on fixed public prompts.
   - Pass: `reread_bytes == 0` during the batch, and tok/s within the owner's bound.
   - Rollback: relaunch on af50d526.

## 6. Limitations

- Untested and uncompiled. Errors in the Python or C will only show up in steps (a)-(d).
- The ordering check in `check_candidate` is textual (positions inside `spawn()`), not a parse.
- The runtime/WASI side is not re-audited for whether any app-config key can reach the native process environment. The init cannot do it, but confirm this in the shim/runtime before the canary.
- If the marker is malformed, the app is refused. That is fail-closed, but it is an availability event. The composer only ever writes `"1\n"`.
