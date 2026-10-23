# Exact recovery target for the frozen helpers (ROOT-RECOVERY-IMAGE-PINS.txt)

This is source plus offline tests, prepared 2026-10-23, and has not been run live. **Root runs it after activating the recovery
image.** `attest-control.mjs` (2d407753) and `verify-recipient-proofkey.mjs` (cb7fa858) are **unchanged**: `recovery-target.mjs`
checks their sha256s before anything else. The verifier modules stay the a6b1378c pins (`checkPins`).

```
node work/custody-recipient-activation-20261023/recovery-target.mjs attest
node work/custody-recipient-activation-20261023/recovery-target.mjs proofkey --expect-proof-key 0x<THIS boot's key>
```

## The target

The wrapper adds exactly one entry, `TARGETS.recovery`, in-process and frozen, using
`../custody-recipient-restore-20261023/BUILD-APPROVED-RESULT.md`:
- **Measurement:** **08d1f838…c5c53318a000**, from H 9f6d37bd on a6b1378c, built and passed by root.
- **No flags:** there is no measurement or target flag, and no generic unknown-measurement path.
- **Refusals:** a different `recovery` entry already present refuses. `current` and `new` are untouched.

**Before any network call**, all five image files must match the pins: MEASUREMENT `6d55c0e2…` (naming the pin), initramfs
`02c7280a…`, manifest `64bd025d…`, vmlinuz `1a3a02d5…`, cmdline `d9e04c2c…`. The check covers:
- `/home/steven/enclave-prod/dist-leasegas-9f6d37bd8` once root has copied it there;
- the approved `stage-approved/dist-leasegas-9f6d37bd8`;
- **every location that exists**, so a production copy that differs from the stage refuses.

## The two modes

**`attest`:** the frozen probe runs for target `recovery`, with the fresh nonce, the AMD chain and the full pin. Exit 0 only if:
- the probe's own `pass` is true;
- the target is `recovery`;
- observed = expected = 08d1f838.

The verdict is written through the frozen `persist`: a public file plus a 0600 raw file. **`check-attestation-verdict.py` and
`keep.py` are ee5df6b8-only.** Root's new H activation (`work/custody-boot-activation-20261023`, not edited here) must use this
wrapper's acceptance, or its own check.

**`proofkey`:** the frozen helper runs for target `recovery`, so part B's stored document must carry 08d1f838. The statuses are
unchanged: `verified-legacy` 0, `pending-registry` 2, rejected or unknown 1.

**Unchanged limits, in every verdict:**
- the proof key is **NOT hardware-bound**: part B is the relay-routed origin;
- only part A's quote is fresh;
- measured-control-verify does not apply (legacy control).

## Tests

`logs/recovery-tests-1.out`: `tests/recovery-target.test.mjs` **5/5**, plus the existing proof-key tests 5/5. They ran in the 256
lane, peak 113 MiB. They cover:
- the frozen hashes;
- the real stage image passing;
- fake images: tampered, missing, a production copy that differs, MEASUREMENT naming another pin;
- one frozen target, with a conflicting one refused;
- the probe pinned to recovery and strict acceptance (5 negatives);
- the proof key verified, pending, and rejected for an ee5df6b8 quote or document.

## Not covered

- No live run.
- W's manual proof-key helper is not used or reimplemented.
