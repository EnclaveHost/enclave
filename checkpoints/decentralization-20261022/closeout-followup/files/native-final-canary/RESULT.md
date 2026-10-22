# Native-final direct-control hardware canary: STAGED / PREPARED, NOT RUN (2026-10-22)

**Status.** Source is ready for root review. No QEMU, VM or SNP guest was launched and no quote was collected. There was
no SSH, network, registry, signing, wallet or production action. Only offline fixture tests and a read-only preflight ran.
Root owns the final check and the single launch.

## What it is
- **Origin.** It is the root-reviewed `direct-hardware-canary`, adapted for the NEW image, in a new directory
  (`native-final-canary`, mode 0700).
  - The reviewed package had FROZEN-PINS 6025fff2 and ROOT-LAUNCH-REVIEW 2026-10-22T20:55:07Z.
  - Its run 20261022T205536Z passed on the 6f2c7da4 image.
  - The old package, its runs and the old image were only read.
- **Image.** `native-final-image/image/dist-direct-493ee9ee0`, from commit `493ee9ee07497c94159ec4f6916e9ea920d31959`,
  tree `b21163723ea789db13ff84d148e309e2709a89f4`.
  - Root published the descendant `dfe020abf`. Its extra commits touch only the admin CLI, its docs and its tests,
    none of which the canary uses.
- **Expected measurement:**
  `fe897820f632bae497511a229f0c74465dade8841d5807f8287a3a2caa928d22c8d79c24ffa9b1f9554434b483fae38f`
  - Parameters: 4 vCPUs, family 26 model 2 stepping 1, QEMU, OVMF 142589cc.
  - It is read at run time from `native-final-image/public/BUILD-RECEIPT.json` (78306775…), which equals the image's
    MEASUREMENT file.
- **Expected runtime** (from the 493 build inputs, `public/inputs-precheck.json` 8790859c):
  - gsup 07e0583974818a5b…
  - measured-control helper 26a8982c52497d88…
  - supervisor 2c87a36fbffe9ff1… (unchanged)

## Source changes (all of them; `public/SOURCE-DELTA.diff`, provenance in `SOURCES.json`)
| file | change |
| --- | --- |
| canary/run-canary.py | image/receipt/inputs paths now point at native-final-image; docstrings; the result scope sentence. Every gate, bound, ownership, cleanup and acceptance rule is unchanged. |
| canary/verify-canary.mjs | +1 REQUIRED bare-role check: the statement has no `native` member (493 statements carry one only for a bound nativeControl). The verifier's new `identity.chipId` is reported as a diagnostic only. |
| canary/owner-config.mjs | `nativeControl` (a new optional member at 493) added to the bare-config refusal list. |
| test/canary-launcher.test.mjs | image path; `noNative` added to the acceptance fixture, plus 2 mutations; nativeControl added to the bare assertion. |
| tools/env.sh, freeze.py, stage-tree.sh, unit-checks.sh | new directory, commit and tree; queue note 512. |
| tools/prepare.sh | NEW: one 512 job that runs stage, unit tests, then freeze and preflight. |
| bin/ssh, scp, sftp | stub log path. |

**Unchanged** (byte-identical to the reviewed copies): `canary/qemu-restrict.sh` (3fd3a1dc), `test/test_run_canary.py`,
`test/fake-qemu.sh`, `test/supervise_driver.py`, `tools/q.sh`, `tools/crl-info.mjs` and `tools/freeze-and-preflight.sh`.

**The runtime tree** is a `git archive` of 493ee9ee (8345 files, list sha ccb2420b…) plus a real copy of
work/enclave/node_modules:
- 139 lock packages, 0 mismatches, 0 verifier-closure mismatches;
- node_modules list sha 4e08fbc6… is the same as the reviewed run's;
- the launcher, `verifier/`, memory-guard, contract pins and package-lock are unchanged since 6f2c7da4.

## Frozen pins: `FROZEN-PINS.json` sha256 `280c89d36914b92c3f04668778dc3072ab0ff082e724dfc991d35feb98ad4aa7` (20 pins)
- **Image files:**
  - initramfs a8a2a40c…
  - vmlinuz 1a3a02d5…
  - manifest d34294b2…
  - cmdline fd236eb2…
  - MEASUREMENT 15a1f962…
- **Host binaries and inputs:**
  - OVMF 142589cc…
  - QEMU 11.1.2 a2250f5e…
  - node v22.23.3 7af789e5…
  - receipt 78306775…
  - inputs 8790859c…
- **Canary sources:** canary helpers (run-canary bc3397ef, verify-canary a5bea76c, owner-config 79c592e0, qemu-restrict
  3fd3a1dc), stubs, tree source list ccb2420b, node_modules 4e08fbc6.
- **Re-verification.** The pins are checked again by `--preflight`, by `--run` before the run directory is created, and
  in the child just before the launcher starts.

## Evidence (work/claude-test-queue.py)
**prepare-1 (512): exit 0, peak 215 MiB.**
- **stage-tree:** OK (above).
- **unit-checks:** node `test/canary-launcher.test.mjs` 4/4 and python `test/test_run_canary.py` 18/18.
  - The node tests include the launcher dry run with a FAKE QEMU against the real 493 image paths, and the 493
    `planDirectBoot` on its fw_cfg.
  - 0 ssh stub invocations.
  - The protected QEMUs were unchanged.
- **freeze + read-only preflight:** PREFLIGHT PASS on all 16 gates:
  - SNP is on; /dev/sev and /dev/kvm are writable; CPU 26/2/1; 32 CPUs;
  - every pin holds; the measurement is 96 hex and equals the image;
  - the measured cmdline matches;
  - protected QEMUs 3483499 (starttime 87503396) and 3817658 (starttime 32598976) are present with the recorded
    identities;
  - MemAvailable is 86983 MiB, above the 23552 needed;
  - collateral, disk and stubs are all present.

**crl-info (512): exit 0.** Read-only: the Turin CRL has thisUpdate 2026-09-22 and nextUpdate 2026-11-09 (not past),
the chain is valid to 2048, and there is 1 VCEK.

I did not re-run the old unchanged canary suites beyond this package's own narrow tests on the changed paths.

## Root commands (see RECIPE.md; NOT executed by Claude)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-final-canary
sha256sum FROZEN-PINS.json        # 280c89d36914b92c3f04668778dc3072ab0ff082e724dfc991d35feb98ad4aa7
. tools/env.sh
python3 canary/run-canary.py --preflight                      # must end PREFLIGHT PASS
python3 canary/run-canary.py --run --kds off --registry off   # only with both queue lanes free
```

**The run's bounds** are unchanged from the reviewed package:
- 4096 MiB guest in a unique transient scope with MemoryMax 6144M and MemorySwapMax 0;
- memory-guard at 6144 MiB with the 16384 MiB floor;
- `timeout` 330 s plus a 40 s kill-after;
- slirp restrict=on with one ephemeral loopback forward to 8444;
- owned (pid, starttime) group signals only;
- the protected production VMs and services are checked before and after;
- the parent stops ONLY its own scope, proves the cgroup observed and empty, then scrubs private/.

**Accept the result only if:**
- `terminal.json` shows `cgroupEmpty: true`, `ownedAbsenceProven: true`, `survivors: []`, `privateAbsent: true` and
  `code: 0`;
- `result.json` shows `ok: true` with every required check, including the new no-`native` bare-role check;
- the registry stays `pending` (diagnostic, never faked).

## Limits
- **Nothing was run on hardware.** A pass would show that the actual new image boots under SNP, that the bound config and
  HOST_DATA, the attested control TLS key, the minted supervisor keys and the exact runtime are correct, and that the
  hardware measurement is fe897820. It would show nothing about API, MCP or native TLS, Platform API group activation or
  failover, registration or selling.
- **Protected identities.** They are pinned in the code (3483499/87503396 and 3817658/32598976). If either production
  VM restarts before the launch, the preflight fails closed, and root must re-review before updating them.
- **Collateral.** The cached CRL expires 2026-11-09. With `--kds off`, a VCEK that does not match the chip's current TCB
  fails the report check closed.
- **Commits and other uses.** No source commit was made and nothing was pushed. Generated `tree/` (archive plus
  node_modules) and `rawlogs/` are local and not for Git.
