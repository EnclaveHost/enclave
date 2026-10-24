# Boot-fee build: root's result (public metadata only; recorded 2026-10-23T23:50:15Z by D, who took no build or live action)

## The approved source

**Root's `APPROVED-COMMIT.txt`** (sha256 `054fdc40c920e34e…`):
- commit **5db2be3f4d4bed2c543e1e181c976ca9e26aa410** (H, branch `boot-normal-fee`), single parent **9f6d37bd858ad44be1171b6415353910214c2fa5**;
- gsup REVIEWED;
- tests `test/boot-gpu-price.test.mjs test/operator-fee-path.test.mjs test/registry-advertise-retry.test.mjs`.

**Delta vs 9f6d37bd:** metal/guest/gsup.mjs, supervisor.js, test/boot-gpu-price.test.mjs, test/operator-fee-path.test.mjs, test/registry-advertise-retry.test.mjs. The image files are /app/supervisor.js, /opt/metal/gsup.mjs.

**Source patch:** `stage/5db2be3f4-on-9f6d37bd.patch` (build-record.json names it `patch`, the pre-move name: a quirk of the
reviewed template, which build-price.sh renames; the sha256 matches), full context, sha256 `02c2dbe30424eb3e61bfc98986d57dc3c04f31067b2b31fc91c49aa60907f8f3`, parent-anchored at 9f6d37bd.

## The two build runs

**1. `logs/root-build-fee.out`, exit 2: kept as the historical failure.** It refused BEFORE any build with "no APPROVED-COMMIT.txt
from root" (root's approval-path mistake, then corrected).

**2. `logs/root-build-fee2.out`, exit 0: the PASS, 23:28:02Z to 23:32:21Z, queue 1024.**
- **Control:** the 9f6d37bd rebuild is CONTROL-IDENTICAL to 08d1f838 (all 4 files).
- **Reproducible:** the candidate built twice is identical (all 4 files).
- **Exact delta:** MANIFEST-DELTA-EXACT and ENTRY-DELTA-EXACT; IMAGE-FILES-ARE-SOURCE; vmlinuz and cmdline unchanged.
- **Measurements:** the recipe reproduces ed918e4b, ee5df6b8 and 08d1f838 first.
- **Candidate measurement:** **bc731956cb425b886386375ac1dcea9dc91a04d7fc50715666c76aba193412c8455548dfbb36d979d8a53922668b896b**.
- **Build record:** `stage/build-record.json` sha256 `0d8c682a887f6ced516fea9fab8b144068e31f5415b5badbbe4ee419eef57bcc`, equal to the log's BUILD-RECORD line.

## Inventory (`stage/INVENTORY.sha256`)

The image binaries in `stage/dist-leasegas-5db2be3f4/` are NOT committed (gitignored).

```
fb40dbb58aa105d80db92a5e7d9dac84453d5a9a762e183ec1b72071ba62376f  dist-leasegas-5db2be3f4/MEASUREMENT
d9e04c2c4769a4aadeaf4591e8e825ac513bf89f2677918d7e74638d8c9c90b8  dist-leasegas-5db2be3f4/cmdline
62361c69cd9ead9b3f5f95f6afdddb608d1e1843d9e13182d5083c4e5dfcafbd  dist-leasegas-5db2be3f4/initramfs.cpio.gz
74eef1d1cadb385068803773cf046f67d5a2e91ad98ca023e4efa1a0cfc62456  dist-leasegas-5db2be3f4/manifest.json
1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7  dist-leasegas-5db2be3f4/vmlinuz
```

## What happened after the build (root's ROOT-RECOVERY-OBSERVED.txt; not verified by D)

- **The cutover:** root activated this image. Its normal setProofKey succeeded (block 53004641, nonce 23759) and both
  original VMs were adopted.
- **The rollback:** gate v4 then FAILED at 23:43:16Z on one EyesOff URLError, and the activation rolled back automatically to
  ed918e4b at 23:43:19Z.
- **The cost:** the setProofKey gas is spent. The operator has 145368427115 wei left (nonce 23760) and the old control is
  unregistered.
- **Status:** NOT a keep, and NOT an operational pass.
