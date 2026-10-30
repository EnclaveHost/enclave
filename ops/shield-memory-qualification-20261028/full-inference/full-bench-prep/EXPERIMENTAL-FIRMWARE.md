# Opt-in experimental benchmark firmware (fullbench.py)

Source only. Nothing was run, built, launched or installed. `release.json`, `stage`, runtime, template, kernel, model, trust, min-TCB, resource floors and packed24 are unchanged.

## Why

The original installed firmware (`release.json` `firmware.fd`, 142589cc…) cannot boot the full 724 MiB initrd (EFI_OUT_OF_RESOURCES). The new bounded high-RAM-acceptance firmware is a **new build**, not the original release. Even an unpatched rebuild (2bcca0a2…) differs from the installed binary. Isolated full A/B needs a way to boot both arms on one candidate firmware without weakening the default pins.

## Changes (`fullbench.py`)

- **`plan` flags:** `--experimental-firmware PATH` and `--experimental-firmware-sha256 SHA`. You must pass both or neither. `make_plan` checks the pair shape first, before it reads anything.
  - It refuses a one-sided flag, an empty value, or a SHA that isn't 64 lowercase hex.
  - It refuses a path that isn't QEMU-safe (`SAFE`), or one inside the production release.
  - It refuses the original release SHA as the "candidate".
  - It refuses a file whose current sha256 differs from the supplied SHA.
  - There is no discovery, no default candidate and no hard-coded hash. Root picks the hash.
- **Hashed plan record:** `plan.json` always has a new `experimental_firmware` key.
  - Default: `null`.
  - Opt-in: `{path, sha256, original_release_sha256, scope}`. `scope` is the constant `EXPERIMENTAL_FW_SCOPE`: new build, not the installed original release, not production-qualified, measurements root-computed for this binary, a fresh attested verdict is required.
  - With opt-in, `snp_claim` also gets "booted experimental firmware <sha>, not the original release firmware".
  - The `plan` output, the `execute` dry run and the receipt all echo the record.
- **`pins.firmware` stays exactly `<RELEASE>/firmware.fd`.** A new `boot_firmware(p)` returns the candidate path only when the record is present. Otherwise it returns the pin. `qemu_argv`, `qemu_violations` (`-bios` must equal `boot_firmware(p)`) and the storage check use it. Old plans have no key, so they boot the pin as before.
- **`firmware_problems` (called by `preflight`, replacing the single firmware-pin check):**
  1. `pins.firmware` must still be `<release>/firmware.fd`. This stops a silent pin swap.
  2. The original release firmware must still hash to `release.json`. This runs **always**, even when a candidate is used.
  3. If there is a record, it must be well-formed: exact scope constant, 64-hex SHA, absolute safe path, path ≠ pin. Its `original_release_sha256` must equal the current `release.json`, its SHA must differ from the original, and the candidate file must still hash to the approved SHA.
- **Unchanged:** the root-fixed `-machine` SNP/memory binding check and every other `qemu_violations` rule. The kernel/runtime/trust/model/worker/client/fwd identity checks are unchanged. So are all resource, ownership, GPU and privacy guards.

## Tests

New file `test_experimental_firmware.py` (offline; temp files only; the host only hashes them). It covers:
- the default pin
- an accepted explicit pair, with `-bios` set to the candidate only
- the root `-machine` binding, still enforced with a candidate
- candidate drift, both content change and a missing file
- original firmware drift, which fails even with a valid candidate
- `release.json` firmware hash changes
- silent pin replacement and scope tampering
- one-sided, empty, malformed or original-hash pairs, and paths inside the release
- CLI one-sided flags refused before any host access

The existing `test_fullbench.py` and `test_root_review.py` are not modified. Their fixtures have no `experimental_firmware` key, so they follow the default path. **These tests were not executed in this session** (no commands allowed). Root must run all three files.

## Limitations / root obligations

- **Measurement:** every `--measurement ARM=…` must be computed by root with `sev-snp-measure --ovmf <candidate>` for the exact candidate binary. The helper cannot check this. A wrong prediction only fails closed at the client.
- **Gate:** each arm still needs `client.mjs` `VERDICT attested`, with the pinned key, status 200 and exit 0. The trust policy and min-TCB are unchanged.
- **Hash choice:** the CLI accepts any explicit pair. Per the current root update, isolated full A/B is meant to use the qualified DEBUG candidate `0598d551…`. The RELEASE candidate `5c4840cd…` silently dead-loops on initrd substitution, which is inconclusive under the strict classifier. It is not production-qualified. Root must pass the correct known hash. Nothing here declares any build production-qualified.
- **Integrity checks are point-in-time:** hashes are checked at plan and at each arm's preflight, not while QEMU opens `-bios` (same TOCTOU as the existing pins). Symlinks are not resolved. Root should keep the candidate in a root-controlled, non-writable directory.
- **DEBUG firmware** may assert or log differently from RELEASE. Performance and boot-time numbers are for this candidate, not for the original release.
- Production firmware acceptance, allowlists and admission floors are untouched.
