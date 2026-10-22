# Cold-host firmware inventory: real Turin GET_ID2 format fix

Checkout: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave` (uncommitted).
- **Not done:** no /dev/sev ioctl was issued here; no root, SSH, VMs, firmware or guest changes, commits or pushes.
- **Coordinator hardening preserved:** refusal of a nonzero `fw_error` on a successful status or length ioctl, and
  the `status-success-error` and `probe-success-error` mocks.
- **Resources:** extra memory stayed far below 300 MiB.

## The actual issue

The coordinator ran the reviewed helper (source sha256 `888c5d68…`) unprivileged as a `kvm` group member on a real
Turin host, issuing only `SNP_PLATFORM_STATUS` and `SEV_GET_ID2`
(`work/cold-hardware-review/{run.json,firmware.json,diagnostic-stderr.txt}`).

| Item | Value |
| --- | --- |
| Result | exit 70 at `get_id2_length` |
| Firmware API | 1.58 |
| SNP state | 1 (INIT) |
| Guests | 4 |
| GET_ID2 probe length | **8** |
| Reported TCB | u64 `0x7500000005020301`, report bytes `0103020500000075` |

The helper accepted only 64..512-byte multiples of 64. It had assumed GET_ID2 always returns the report's 64-byte
CHIP_ID; that assumption came from no source, and it is wrong for Turin.

## Primary sources for the corrected rule

1. **Real Turin firmware 1.58:** GET_ID2 probe length 8.
2. **virtee/sev** (`main` `a966d06d`, `src/firmware/host/mod.rs` and `src/firmware/linux/host/types/mod.rs`):
   - `get_identifier` uses GET_ID2 (ioctl command 0x8) with a 64-byte buffer;
   - it returns `as_slice()` of exactly the `id_len` the kernel writes back ("the kernel will write the length of the
     unique CPU ID").
3. **virtee/snphost** (`main` `f8893be9`, `src/cert/fetch/vek.rs`): `vek_url` builds
   `https://kdsintf.amd.com/vcek/v1/{generation}/{id}` from the raw GET_ID2 identifier. For Turin that identifier is
   the 8-byte KDS hardware ID; `processor.rs` maps family 1Ah to Turin.
4. **Linux 7.2** `sev_ioctl_do_get_id2`: "The length of the ID shouldn't be assumed by software since it may change in
   the future."
5. **Repository evidence:**
   - both real Turin reports (`turin-m4a`, `turin-m4a-app-2026-10-17`) carry CHIP_ID = `fa11afcf54ae9c53` followed by
     56 zero bytes;
   - the real Turin KDS VCEK URL uses exactly those 8 bytes;
   - the real Genoa report's CHIP_ID is a full 64 bytes.

**Resulting formats:** Turin returns 8 bytes (the hardware ID); Milan and Genoa return 64 bytes (the CHIP_ID).

**Multi-socket:** no primary source defines a multi-socket GET_ID2 layout this helper could interpret; virtee's
64-byte call would itself fail on a larger answer. Every other length is refused, and no socket is chosen.

## Changes

- **`isolation/m2/sev-inventory.c`** (184 lines; source sha256
  `e8913b98234a93d56ab0d24c36d3654ebb54ff9289e6c67a967860e3b917607e`):
  - accepts exactly ID length 8 or 64, read into a 64-byte buffer;
  - any other length exits 69, "unsupported ID length… refused rather than guessed";
  - prints the raw ID as `"id_length"` plus `"id"` (exactly `id_length` bytes of hex), replacing the per-64-byte
    `chip_ids` split;
  - still sends only the two allowed commands and opens the device read-only;
  - static assertions, truncation and `fw_error` checks are unchanged.
- **`isolation/m2/host-collateral.mjs`:**
  - strict parsing of the new `id`/`id_length` fields;
  - `ID_FORMAT = { Milan: 64, Genoa: 64, Turin: 8 }`: an ID whose length does not match the cpuinfo product line is
    refused ("ID format mismatch… refused rather than reinterpreted"), including a Turin ID padded to 64 bytes;
  - zero (masked) IDs are refused;
  - the statement records `idFormat`;
  - `--socket` and the multi-socket chooser were removed (`--socket` is now refused);
  - the TCB reserved-byte product check, the masked chip and masked key refusals, VLEK, uninitialized state and the
    separately required `--min-tcb` floor are unchanged.
- **`test/sev-inventory-mock.c`:**
  - Turin scenarios answer the GET_ID2 probe with **8** and the real hardware ID `fa11afcf54ae9c53`;
  - added scenarios: `turin-64` (Turin TCB with a 64-byte answer), `genoa-8`, `turin-truncated`, `turin-zero-id`;
  - `two-sockets`/`odd`/`huge` now expect exit 69;
  - the mock exits 99 if the helper ever accepts an unsupported length;
  - the coordinator's mocks are preserved.
- **`test/host-collateral-inventory.test.mjs`:** updated as below.
- **`docs/network/cold-host-collateral.md`:** a "GET_ID2 ID formats (corrected after the first hardware run)" section
  documenting the actual failure, the evidence, the format table and the multi-socket refusal; the bounds, exit
  codes, refusals and limits are updated.

## Tests

Run: `node --test test/host-collateral.test.mjs test/host-collateral-inventory.test.mjs`. Result: **10 tests,
10 pass, 0 fail, 0 skipped.**

1. **Compile and audit:** the gcc static `-Werror` build and clang syntax checks pass; the drifted-header compile
   failure and the read-only/allowlist source audit still pass.
2. **Mock:**
   - `ok-turin` returns exit 0 with `id_length` 8, `id` `fa11afcf54ae9c53` and TCB `0103020500000075`. This is the
     real host's answer; the earlier helper failed on it.
   - `ok-genoa` returns 64 bytes.
   - Truncation exits 70 for both Genoa and Turin.
   - Two sockets, odd, huge and probe-without-length each exit 69.
   - Every earlier errno/firmware case still passes, including the coordinator's `status-success-error` and
     `probe-success-error`.
3. **Statement:**
   - The Turin statement's chip ID is `fa11afcf54ae9c53`, with `turin-hardware-id-8` and the exact recorded KDS URL.
   - The Genoa statement uses the 64-byte ID and AMD's recorded URL.
   - The real host's values (API 1.58, 4 guests, TCB `0103020500000075`) yield a Turin statement.
   - Strict parsing rejects the old `chip_ids` shape, a 128-byte ID, `id_length` 16, Turin IDs with an extra byte or a
     wrong length, a truncated ID, and the earlier variants.
   - **Format mismatches refused:** an 8-byte ID under Genoa cpuinfo; a 64-byte ID under Turin cpuinfo; a padded
     Turin 64-byte ID.
   - **TCB layout mismatches refused independently:** `genoa-8` under Turin (reserved byte 6); `turin-64` under Genoa
     (bytes 2 and 3).
   - Also refused: zero Genoa and Turin IDs, masked chip, masked key, VLEK, zero TCB, Intel, disagreeing processors,
     a 128-byte answer (no socket chosen), and uninitialized SNP without the opt-in.
4. **End to end:**
   - The mock Turin firmware → `inventory --firmware` → statement → `prepare --statement` with the **real Turin VCEK
     and CRL** succeeds.
   - `collateral.json` shows `hwId` `fa11afcf54ae9c53`, `chipId` null (only the hardware ID was stated) and the
     canonical Turin KDS URL.
   - The Turin statement with the Genoa VCEK is refused, and no directory is created.
   - Genoa firmware output under Turin cpuinfo is refused with "ID format mismatch".
   - `--socket` is refused.
   - The Genoa end-to-end path and the filesystem-only inventory are unchanged.

**Mutation checks** (sources restored afterwards and confirmed with `diff`):

| Mutation | Failing tests |
| --- | --- |
| C accepts any length 8..64 | 3 |
| C restores the old 64-multiple rule (the defect seen on hardware) | 3, 4, 5 |
| JS per-product format check removed | 4, 5 |
| JS zero-ID refusal removed | 4 |

## For the coordinator: re-run on the real host (read-only)

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -static -o /tmp/sev-inventory isolation/m2/sev-inventory.c   # source sha256 e8913b98…607e
/tmp/sev-inventory > fw.json; echo "exit $?"     # root, or the kvm group as before; only SNP_PLATFORM_STATUS + SEV_GET_ID2
node isolation/m2/host-collateral.mjs inventory --firmware --helper-output fw.json --statement-out statement.json
```

Expected on that host: exit 0, `"id_length":8`, a 16-hex `id`, and `reported_tcb` `0103020500000075`. The statement
gives `--kds-url`-equivalent input to `prepare --statement`, with the operator's own `--min-tcb`.

## Activation gates

1. **Pending hardware proof:**
   1. re-run the corrected helper;
   2. `prepare --statement` with a live or carried VCEK and CRL plus an operator floor;
   3. start guestd with the new collateral;
   4. boot one guest;
   5. confirm the attested verdict names the same 8-byte hardware ID and reported TCB.
2. **Multi-socket and future ID formats:** refused by design. Such hosts need a statement given by hand, confirmed
   against a guest report, or new primary evidence before the helper is extended.
3. **Unchanged:** kernel 6.11+ with headers matching the pinned UAPI; floor policy, CRL freshness and ASK rotation
   remain the operator's gates.
