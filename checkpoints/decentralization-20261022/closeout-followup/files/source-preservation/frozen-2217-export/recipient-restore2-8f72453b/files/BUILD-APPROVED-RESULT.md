# Approved boot-registration build: root's PASS (source-only record)

The build ran 2026-10-23 21:50:25Z–21:54:50Z through `build-approved.sh` (template e02b3bd4), with root's approval file. **Root ran
it**, through the queue's 1024 lane (peak 301 MiB). The log is `logs/root-build-approved.out` (sha256 `89ba2d1b…`), exit 0.

This file records that result. It ran nothing, built nothing and activated nothing. The image binaries stay uncommitted
(gitignored `stage-approved/dist-*/`).

## Approved source

| | |
|---|---|
| H commit | **9f6d37bd858ad44be1171b6415353910214c2fa5** (tree 59f0a46d), on a6b1378c, in `work/custody-boot-registration-20261023/repo` |
| Commit message | "supervisor: adopt an existing exact registration at boot instead of a full register()" |
| Approval | `APPROVED-COMMIT.txt`: `commit 9f6d37bd…`, `extra NONE` (sha256 `f32ab104…`) |
| Delta vs a6b1378c | `supervisor.js` (+53/−6) and `test/registry-advertise-retry.test.mjs`, nothing else |
| Source patch | `stage-approved/h-9f6d37bd-on-a6b1378c.patch` (`git format-patch a6b1378c..9f6d37bd`, sha256 `56f54050…`) |

## Root's PASS, step by step (from the log)

1. **Control:** a6b1378c rebuilt from H's repo is `CONTROL-IDENTICAL` to the staged ee5df6b8 image. All four of initramfs
   `5ce61b6f…`, vmlinuz, cmdline and manifest match.
2. **Candidate:** built twice and `REPRODUCIBLE`. All four files are identical, with initramfs `02c7280a…` (279 388 203 bytes) both
   times.
3. **Exact delta:**
   - `MANIFEST-DELTA-EXACT ['/app/supervisor.js']`;
   - `ENTRY-DELTA-EXACT`:
     - versus a6: `app/supervisor.js` and `opt/metal/manifest.json`, out of 29 063 entries;
     - versus production deabf8f90: the same plus `opt/metal/gsup.mjs` (the a6b1378c vault restore);
   - `IMAGE-FILES-ARE-SOURCE`: the image's `supervisor.js` (`37e6a340…`, 815 857 bytes) and `gsup.mjs` equal the commit's bytes.
4. **Measurement:**
   - `MEASURE-RECIPE-REPRODUCES-PRODUCTION` (ed918e4b) and `MEASURE-RECIPE-REPRODUCES-A6` (ee5df6b8);
   - then the candidate measures:

**08d1f838d51274571fdf17b635606d20a6e7250f74d6676217eea40733a8d269aaf52edb85aac4a9ad1cc5c53318a000**

## Image pins (`stage-approved/INVENTORY.sha256`)

These are the same pins `recovery-target.mjs` checks.

| File | sha256 |
|---|---|
| MEASUREMENT | 6d55c0e2839e5a1aad1258ce80ec112181f155c50be9f5ad1f66f1bb44064537 |
| initramfs.cpio.gz | 02c7280a7020f29395d9e38e361d72aad8b39311218a1dd272dc2893e562dfaf |
| manifest.json | 64bd025db3ed62b82f016ed25f1bd24ab300dbe7520ca81498d3ccd293e43b16 |
| vmlinuz | 1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7 (= a6, = production) |
| cmdline | d9e04c2c4769a4aadeaf4591e8e825ac513bf89f2677918d7e74638d8c9c90b8 (= a6) |

**Image locations:**
- **Now:** `stage-approved/dist-leasegas-9f6d37bd8`.
- **Eventual production path:** `/home/steven/enclave-prod/dist-leasegas-9f6d37bd8`. It does not exist yet; root copies the image,
  and the copy must carry the same five hashes.

**Release dir:** the launcher's WorkingDirectory (`metal-deabf8f90`) is unchanged. `supervisor.js` runs in the control image, not
the launcher.

## Verification after activation (root)

```
node work/custody-recipient-activation-20261023/recovery-target.mjs attest
node work/custody-recipient-activation-20261023/recovery-target.mjs proofkey --expect-proof-key 0x<THIS boot's key>
```

The wrapper uses the frozen helpers unchanged, adding only the exact `recovery` target; see the activation folder's
`RECOVERY-TARGET.md`.

## Not shown here

- No VM boot of this image, and no adoption.
- No setProofKey.
- No custody lifecycle canary.
