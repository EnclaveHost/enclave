# Cold-host firmware inventory: result

Checkout: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave` (uncommitted).
- **Not done:** no /dev/sev ioctl was issued; no root, VMs, SSH, production, commits or pushes.
- **Never executed:** the real helper binary was only compiled.
- **Resources:** extra memory stayed well under 300 MiB (gcc/clang compiles of one C file plus Node); there was no
  Rust build.
- **Other workstreams:** files untouched. In `docs/network/cold-host.md`, only the "Chip collateral" table row and
  the "not yet automated" paragraph changed.

**FINAL HARDWARE PROOF: PENDING.**

## Files

- **New:**
  - `isolation/m2/sev-inventory.c`: 175-line read-only helper;
  - `test/sev-inventory-mock.c`: test-only firmware stand-in;
  - `test/host-collateral-inventory.test.mjs`.
- **Modified (mine from the previous round):**
  - `isolation/m2/host-collateral.mjs`: `parseFirmwareInventory`, `firmwareStatement`, `readStatement`,
    `inventory --firmware`, `prepare --statement`, `--cpuinfo`;
  - `docs/network/cold-host-collateral.md`.
- **Narrow edit:** `docs/network/cold-host.md` (the two passages above).
- **Unchanged:** `isolation/m2/vcek-prep.mjs` and all other cold-host runtime files.

## Sources used (primary, local)

- **UAPI:** `/usr/include/linux/psp-sev.h` (`linux-api-headers` 7.2-1). It provides the command enum, `sev_issue_cmd`,
  `sev_user_data_get_id2`, `sev_user_data_snp_status`, the firmware status codes and `SEV_ISSUE_CMD`.
- **Kernel behaviour:** Linux 7.2 `drivers/crypto/ccp/sev-dev.c`, from the local tree at
  `~/.cache/enclave-isolation/planeskit/linux`, commit `bf5bafed`:
  - `sev_ioctl`: dispatch, and the `FMODE_WRITE` checks;
  - `sev_ioctl_do_get_id2`: length probe, `INVALID_LEN` with the needed length, copy of exactly `data.len`;
  - `sev_ioctl_do_snp_platform_status` and `__sev_do_snp_platform_status`: allowed in any SNP state, writes back the
    32-byte status.
- **Compiler-derived values:** compiling against the header gives `SEV_ISSUE_CMD = 0xc0105300`, `SEV_GET_ID2 = 8`,
  `SNP_PLATFORM_STATUS = 9`; struct sizes 16/12/32; issue `data@4`/`error@12`; status `build_id@4`,
  `guest_count@12`, `current@16`, `reported@24`; `mask_chip_id`/`mask_chip_key`/`vlek_en` as bits 0/1/2 of byte 8.
  All of these are pinned with `_Static_assert`.
- **Finding:** in this kernel, `SNP_COMMIT` has **no** write-mode check, so opening read-only is not sufficient by
  itself. The helper's hard command allowlist is the guard.
- **snphost:** not installed, so it was not wrapped. Its human-readable output would have needed a pinned review and
  parsing; the direct helper avoids that.

## Helper behaviour

- **Commands:** opens the fixed path `/dev/sev` with `O_RDONLY|O_CLOEXEC|O_NOCTTY`. It sends only:
  - `SNP_PLATFORM_STATUS`;
  - the `SEV_GET_ID2` length probe;
  - `SEV_GET_ID2` with exactly the probed length.

  `issue()` aborts on any other command, and the program takes no arguments.
- **Bounds:** the ID length must be 64..512 bytes and a multiple of 64. A changed or truncated answer length is
  refused.
- **Retries:** `EINTR` is retried at most 3 times. `EBUSY`/`ETIMEDOUT` exit 75 ("retry later"), never in a loop.
- **Exit codes:** 69 unavailable (no device, kernel older than 6.11, API too old), 70 firmware or protocol error,
  77 permission.
- **Output:** one strict JSON object, also for errors (stage, errno name, firmware status name).

**Wrapper.** `inventory --firmware --helper-output fw.json` (or `--helper /abs/path`) parses the JSON strictly, then
refuses:
- a non-AMD CPU, an unknown product line, or processors that disagree;
- `MASK_CHIP_KEY`, `MASK_CHIP_ID`, or a loaded VLEK;
- SNP not initialized, unless `--allow-uninitialized` is given (it is recorded);
- multiple sockets without `--socket`;
- a zero CHIP_ID or an all-zero TCB;
- reserved TCB bytes that are nonzero for the product `/proc/cpuinfo` names (product mismatch).

It emits a `sev-snp-host-statement` with product, CHIP_ID, raw and decoded **reported** TCB, current TCB, KDS URL,
firmware facts and an explicit note that the statement is an operator claim. `prepare --statement` consumes it:
- the AMD chain and CRL checks still decide;
- `--min-tcb` is still required separately;
- a statement never vouches for another chip's VCEK.

`inventory` without `--firmware` is unchanged.

## Tests

Run: `node --test test/host-collateral.test.mjs test/host-collateral-inventory.test.mjs`. Result: **10 tests,
10 pass, 0 fail, 0 skipped** (5 from the previous round, 5 new).

1. **Compile checks.**
   - Real helper: gcc 16.2.1 `-std=c11 -Wall -Wextra -Werror -static` builds it; clang `-fsyntax-only` passes. Neither
     binary is executed.
   - Drifted header: a copy of the UAPI header with the enum shifted fails to compile, naming
     `SEV_GET_ID2 differs…` and `SNP_PLATFORM_STATUS differs…`.
2. **Source audit.**
   - Every command name is parsed from the real header's enum; only `SEV_GET_ID2` and `SNP_PLATFORM_STATUS` appear in
     the code (comments stripped).
   - There is exactly one `ioctl(` site, the open is read-only, and the source contains no `O_RDWR`, `O_WRONLY`,
     `getenv`, `exec` or `system`.
   - The abort allowlist line is present.
3. **Mock firmware** (emulates the kernel semantics above; exits 99 on any other request, which the harness treats
   as a failure):

   | Scenario | Result |
   | --- | --- |
   | Real Genoa chip | succeeds |
   | Real Turin chip (hwID) | succeeds |
   | One EINTR | retried, then succeeds |
   | Two sockets | reports 2 CHIP_IDs |
   | Truncated answer | exit 70 |
   | Odd length | exit 70 |
   | Oversized length | exit 70 |
   | Probe answered without the needed length | exit 70 |
   | Firmware busy during status | exit 75 |
   | Firmware busy during the ID probe | exit 75 |
   | Kernel without SNP host support | exit 69 |
   | No PSP | exit 69 |
   | Firmware error | exit 70, `INVALID_COMMAND` |
   | Old firmware API | exit 69 |
   | No device | exit 69 |
   | Permission denied | exit 77 |
   | Any argument | exit 64 |
   | `--help` | exit 0 |

   Every error JSON is turned into a clear wrapper error.
4. **Statement.**
   - Strict parsing rejects 11 malformed variants: extra, missing or ill-formed fields; a truncated chip ID; a
     read-write open; an added `SNP_COMMIT`; a non-boolean flag; another tool; oversize input; non-JSON.
   - Refusals: masked chip, masked key, VLEK, zero ID, zero TCB, a Genoa TCB under Turin cpuinfo (reserved byte 6), a
     Turin TCB under Genoa cpuinfo (bytes 2 and 3), Intel, disagreeing processors, multiple sockets without `--socket`,
     `--socket` on a single-socket host, uninitialized SNP without the opt-in.
   - Accepted with the note recorded: a reported TCB lagging the current TCB.
   - The Genoa statement's KDS URL equals AMD's request recorded in `SOURCES.json`.
5. **End to end** (CLI subprocesses):
   - `inventory` without `--firmware` keeps the same keys as before.
   - A saved helper output and a direct `--helper` run give identical statements.
   - The statement file is write-once.
   - Busy firmware, a relative helper path and a missing source are refused.
   - `prepare --statement` with the **real** Genoa VCEK and CRL succeeds, and the KDS URL and TCB match.
   - Mixing `--statement` with `--product` is refused, and a missing `--min-tcb` is refused.
   - The Genoa statement with the Turin VCEK is refused, and no directory is created.
   - The Turin statement with the real Turin VCEK and CRL succeeds.

**Mutation checks.** Each guard was disabled in turn, then the sources were restored and confirmed with `diff`:

| Disabled guard | Failing test |
| --- | --- |
| C command allowlist | 2 |
| C read-only open (changed to read-write) | 2 |
| C truncation check | 3 |
| C `SNP_PLATFORM_STATUS` pin | 1 |
| JS product/TCB layout check | 4 |
| JS masked-chip refusal | 4 |
| JS strict field set | 4 |

## Reviewed read-only command for the coordinator (not run here)

On the target AMD host, from a reviewed checkout:

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -static -o /tmp/sev-inventory isolation/m2/sev-inventory.c
sudo /tmp/sev-inventory > fw.json; echo "exit $?"
node isolation/m2/host-collateral.mjs inventory --firmware --helper-output fw.json --statement-out statement.json
```

The helper sends only `SNP_PLATFORM_STATUS` and `SEV_GET_ID2`. Exit 75 means the firmware is busy; retry later.

## Activation gates

1. **Pending hardware proof.** On a real cold host:
   1. run the command above;
   2. `prepare --statement` with a live KDS fetch or carried files, plus an operator `--min-tcb`;
   3. start guestd with the new `-vcek`, `-chain` and `-min-tcb`;
   4. boot one guest;
   5. confirm its attested verdict names the same CHIP_ID and reported TCB.
2. **Kernel and header requirement:** SNP host support (Linux 6.11 or later) and kernel headers that compile cleanly.
   If a host's headers differ from the reviewed values, the build fails by design; review the new header before
   changing a pin.
3. **Multi-socket hosts:** `--socket` must be confirmed against the first guest report's CHIP_ID.
4. **Uninitialized SNP:** the reported TCB may change at `SNP_INIT`/`SNP_CONFIG`. Prefer reading after SNP is
   initialized.
5. **Unchanged from the collateral round:** TCB floor policy, CRL freshness and ASK rotation remain the operator's
   gates (`claude-cold-collateral-result.md`).
