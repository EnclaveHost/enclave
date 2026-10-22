# Storage: next safe activation steps (root executes; this is a review of existing source/evidence, nothing was run live)

Machine-readable: ACTIONS.json. Pins: SHA256SUMS. All helpers are existing, root-reviewed files; nothing new to build or test.

## Now (no funds, no wallet, no state transition)

1. A1: finish the pending second v28 postcheck (`production-final/50-postcheck.sh`).
2. A2 (read-only live): `node <checkpoint-tree>/cli/enclave.mjs apps sia-s3 --json` and
   `node <checkpoint-tree>/cli/enclave.mjs status <sia-s3 deployment id> --json`.
   - Record the live version config, the slug owner, memMb and the deployment id/state.
   - Diff the config against `claude-resumed-20261022/storage-rollout-inventory/sia-s3-app/config.template.json` (6e31a0bc).
3. A3 (read-only, metal0 host OS): storage-closeout RECIPE section 1. This means the closure tar 83c95b4b under
   /opt/enclave-host-software/658e5a443480, then `host-preflight.sh` and `gate-preflight.mjs` for
   https://api.enclave.host/t/metal0.
   - Expect ADMISSIBLE, with operator 0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab.
   - Today PostgreSQL 18 is absent on this host (read-only local check).
4. A4 (normal role install, inert): install the PostgreSQL 18 distro package. Create a systemd-creds host key if
   needed. Unpack rc3 dc2d018f to /opt/enclave-storage-indexer/e903e94c876a with `current` pointing to it, and verify
   MANIFEST (pin sha256:e903e94c...). Do NOT enable the unit.
   - Rollback: remove the /opt directories.
5. A8: keep the exact bytes in root's offline material: rc3, the closure, the sia-s3 wasm 00e9cde0 and the config
   template.
   - The adapter's `/api/upload` holding path (storage-site-holding RECIPE) needs no admin signature. It is not a cold
     path (C1).
6. A9 (optional): refresh the indexer-free cold snapshot with the existing sia-direct-recovery tooling. The last one
   is from 2026-10-19 (1487 objects); live now has 1491. Keep a copy that is not on the DO fleet.

## Blocked, each for one concrete reason

- **A5, descriptor:** the descriptor binds an advertiseURL, and no non-DO-only ingress name exists for a storage
  replica (INGRESS REQUEST, hosted-service-placement-interface.txt:79-85). Then operator 0xC9D0...E6aB must
  personal_sign it. No funds are needed.
- **A6, start the replica:** after A5. It starts an admitted, unfunded indexer that holds nothing.
- **A7:** Sia funding per replica wallet (not authorized). Then the app-key registration on that replica.
- **T1, enrollment (first fenced C2 boot, one writer):** needs all of the following:
  - the front/relay writer-authority binding deployed;
  - the C2 catalog version published by the slug owner;
  - root's decision on U1: 00e9cde0 on a 0.1.8-written account has only mock evidence.

  After T1 there is no online downgrade.
- **T2 (1 -> 3) and T4 (retire the minipc VM):** after A5-A7 and T1.

## Never

- Restore the minipc DB or phrase onto a second running host.
- Run 0.1.8 and C2 at the same time, or `sia-s3 import` against a fenced account.
- Count metal0 + minipc as distinct failure domains: they share one site and uplink.
- Claim distributed storage before T2 commits on three independent domains.
