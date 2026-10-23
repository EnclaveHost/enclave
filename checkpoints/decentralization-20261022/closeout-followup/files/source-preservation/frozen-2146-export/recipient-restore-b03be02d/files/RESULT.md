# Restore metal0's measured custody vaults: source, tests, bounded build (2026-10-23; ROOT-RESTORE-PLAN.txt)

- **Scope:** source, tests and a bounded build only.
- **Not done:** no hardware run, no production, chain or key action, and nothing deployed or admitted. The original dist is
  untouched (its hashes were re-asserted before the build).
- **How:** every test, build and scan ran through the unchanged queue (256/512/1024 lanes); logs are in `logs/`.

## Answer to the early question

**Admitting the new measurement needs no on-chain, admin or host signature.** It is root's compare-and-swap of the relay's
`METAL_ALLOWED_MEASUREMENTS` (`admit.py` pattern). The custody releases themselves still depend on the existing registry operator
key, live leases, and the **owner-gas blocker, which is unchanged** (details in `ACTIVATION-PLAN.md`).

## Source (`repo/`, branch `restore/measured-custody-vaults`)

**Commit:** `a6b1378cdf430217025987d90c040d0e25a9993d` (SteveDeFacto), child of exact `deabf8f90`. The clone of
`linux-post-adoption-release/stage/scratch.git` checks out byte-identical to the staged `metal-deabf8f90`.

**The change:**
- `metal/guest/gsup.mjs` +6 lines, after `SECRETS_CAPABLE` in the legacy `supEnv`:
  `CUSTODY_VAULT 0x08074300…11a6`, `CUSTODY_CHAIN_ID 8453`, `CUSTODY_VAULT_V2 0xe48699b8401564aace7a814ae4569b67a3f7eef5`, with
  their comments.
- These lines are **byte-identical to the Oct-16 production gsup** (`2857356cd:metal/guest/gsup.mjs` L467–472; the constants come
  from 295650320 and its predecessor).
- They sit at the same place. Nothing else was taken from that ancestry, and all post-adoption and lease-gas code is untouched.

**Tests:** `test/helpers/gsup-env-harness.mjs` and `test/metal-gsup-custody-env.test.mjs`.
- The harness **runs the real gsup.mjs**. Only its `child_process` import is faked (a recorder that writes the supervisor's argv
  and env), plus guest-only file paths (`/proc/cmdline` = production's, fw_cfg and `/opt/metal`).
- The test covers:
  1. gsup hands the supervisor the three constants, and the deabf8f90 legacy behaviour holds: selling, per-app isolation,
     release opt-in, publicUrl.
  2. fw_cfg look-alikes (`CUSTODY_VAULT_V2`, `custodyVaultV2`, `env.*`) are ignored, and a baked flavor value is overridden.
  3. Control: the unmodified deabf8f90 gsup yields **no** vaults.
  4. The real supervisor `releaseTicketPump`, given **exactly the captured env**:
     - signs the v2 request for 0xE486, and the v2 operator message recovers to the operator;
     - refuses another vault;
     - for direct guests, signs only the owner-committed vault and refuses a mismatch;
     - and the regression env refuses ("CUSTODY_VAULT_V2 is not set").

**Results:**
- **`logs/test-1.out`:** 4/4, peak 240 MiB.
- **`logs/control-1.out`:** the same test file on the unmodified deabf8f90 tree fails tests 1, 2 and 4 on the vault assertions,
  and passes the control. That proves the test detects the regression.
- **`logs/related-1.out`:** 59/59, 1024 lane, peak 644 MiB. The files run were the new test,
  `isolation-release-ticket` (v2 wrong-vault and unset-vault), `bootstrap-supervisor` (committed vault),
  `metal-lease-gas-conduit`, `isolation-post-adoption-lease`, `lease-authorization-nonce` and `metal-launcher-isolation`.
- **`logs/measured-control-1.out`:** `metal-measured-control` gives 12/13 on BOTH deabf8f90 and a6b1378c, with the same test 4
  failing. That test compares the working tree with HEAD, which is meaningless in a committed release tree; it is pre-existing
  and **not called green**.

## Bounded build (`build-1.sh`, `repro-1.sh`; the reviewed builder `metal/overlay-control-image.py`, unchanged)

The base is the read-only `~/enclave-prod/dist-sdshield-2857356cd`. Its hashes and production's were asserted first. The build ran
in the 1024 lane; peak 301 MiB was sev-snp-measure.

- **Control:** deabf8f90 rebuilt from this repo is **byte-identical to production**: initramfs `c190c040…`, vmlinuz, cmdline and
  manifest `c7cb436d…`.
- **Candidate a6b1378c:**
  - initramfs `5ce61b6f…`, manifest `3874066d…`;
  - **measurement `ee5df6b83948f5bacebee414574adb87be9d58412b09ae9183fc4deed5aed3d96bc1cbead096372e7ee755febbbc22ec`**.
- **The measurement recipe** first reproduced production's `ed918e4b…`.
- **Delta vs production:**
  - **Image entries:** 29,063 entries compared; only `opt/metal/gsup.mjs` and `opt/metal/manifest.json` differ. The image gsup
    equals the source.
  - **Dist manifest:** only `controlOverlay.commit`, the gsup record and the initramfs record differ.
  - **Release directory:** the git archive differs from production's `metal-deabf8f90` in only gsup plus the two test files.
- **Reproducible:** a second candidate build is byte-identical.
- **Staged artifacts:** in `stage/`, not committed, binaries never committed; hashes in `stage/INVENTORY.sha256`.

## Activation / admission / rollback

`ACTIVATION-PLAN.md` covers the steps, their effect on existing app guests (adopted, not relaunched; guestd untouched), the
protections and the rollback. **The minimal production change is config.json `dist` only.**

## Limits (explicit)

- **Not proven on hardware:** no new attestation, capability probe or custody release has been made. Root verifies the fresh
  attestation and capabilities.
- **Not proven by rebuild:** the guestd provenance (9d1562738cde ↔ 174edbb7) is still not rebuild-proven.
- **The owner-gas blocker, two-guest r2 requirement and unset address book remain.** This fix only removes the supervisor-side
  refusal.
