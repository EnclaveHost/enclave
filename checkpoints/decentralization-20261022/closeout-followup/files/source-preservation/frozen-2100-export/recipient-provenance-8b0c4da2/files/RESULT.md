# Production custody recipient on metal0: source/provenance inventory (read-only, 2026-10-23)

This was requested in `work/custody-v2-ingress-forwarder-20261023/ROOT-RECIPIENT-PROVENANCE.txt`.
- **No changes:** no hardware or production change, no rebuild, and no image file modified.
- **Not read:** private config, `/proc/*/environ`, fw_cfg contents, keys and sealed state.
- **How:** every probe and extraction ran through the unchanged queue in the 256 MiB lane (peaks ≤ 27 MiB); logs are in `logs/`.
  - `stream-initramfs.py` reads the gzip'd cpio as one 64 KiB stream.
  - It hashes the public code members and writes out only `/opt/metal/flavor-env.json`, as key names plus public
    chain/registry/address-book values.

## Answer

**The running measured supervisor does NOT have a v2 custody vault.** It cannot sign custody v2 releases for the original
vault 0xE486 through the release-ticket path, and the owner-committed (direct) path is unavailable with the running guestd. So
this metal0 recipient currently has **no working path to authorize a v2 (or v1) custody release**. This is from source and image
bytes; no live release was attempted.

### Exact chain

1. **The running control VM** (qemu PID 3483499, started 2026-10-21 01:05:19 -07:00) boots
   `/home/steven/enclave-prod/dist-leasegas-deabf8f90`.
   - initramfs `c190c040…`, vmlinuz `1a3a02d5…`, cmdline `d9e04c2c…`, manifest `c7cb436d…`;
   - MEASUREMENT `ed918e4b…a2ac2`, cmdline `metal.mode=snp metal.isolation=snp-guest-per-app` (no `metal.control`, so the
     legacy, non-direct control path).
   - The VM started after the initramfs was written (00:40:04), and the files still hash to the manifest.
2. **The image is root-reviewed release deabf8f90** (`work/linux-post-adoption-release`, git archive `stage/metal-deabf8f90`).
   - It is control overlay commit `deabf8f90` (parent `51516b778`, then the `c083e27` lease-activation snapshot), overlaid on
     base image `dist-sdshield-2857356cd` (measurement b8376e15).
   - All **40/40** control-overlay files in the image equal the manifest hashes and the staged source bytes
     (`out/dist-leasegas-deabf8f90/initramfs-inventory.json`).
3. **The supervisor's v2 rule** (`/app/supervisor.js` `01ac9cb1…`, source `stage/metal-deabf8f90/supervisor.js` L2692–2716):
   - `authorizeCustody(…, {v: 2, vault, committedVault})` accepts `committedVault || process.env.CUSTODY_VAULT_V2`. With
     neither, it throws "CUSTODY_VAULT_V2 is not set: this box cannot authorize v2 custody releases".
   - `committedVault` exists only for DIRECT guests (an owner-committed startup package, `releaseTicketPump` L2771–2774).
   - Relay-ticket release guests get no `committedVault`.
4. **`CUSTODY_VAULT_V2` is never set in this image:**
   - **gsup** (`/opt/metal/gsup.mjs` `c2896d74…`, source `metal/guest/gsup.mjs`) builds the supervisor env (`supEnv`
     L467–553) from `flavorEnv`, `HOST_POLICY_ENV` and fixed fields, plus `withLeaseGasEnv`. It has **zero** `CUSTODY`
     occurrences. No file under the release's `metal/` mentions `CUSTODY_VAULT`, so neither host config nor fw_cfg can supply it.
   - **The baked `/opt/metal/flavor-env.json`** (`9d901ae3…`, measured) has 37 keys and none for custody. Its public values are
     `CHAIN_ID 8453`, `ADDRESS_BOOK_ADDRESS 0xab214342…0907` and `REGISTRY_ADDRESS 0x868eB7fc…CCAC`. No secret-like key is
     present.
   - **`host-policy.bundle.mjs`** has no custody references.
5. **This is a regression from the previous image.**
   - **2857356cd overlay, base image b8376e15:** its gsup `4cf28fd2…` (= `git show 2857356cd:metal/guest/gsup.mjs`) **measured**
     `CUSTODY_VAULT: 0x08074300…11a6`, `CUSTODY_CHAIN_ID: 8453` and `CUSTODY_VAULT_V2: 0xe48699b8401564aace7a814ae4569b67a3f7eef5`.
     They come from `295650320` (2026-10-14, "the control supervisor signs custody v2 releases … for its measured v2 vault
     only"), an ancestor of `2857356cd`.
   - **deabf8f90 overlay:** it replaced that gsup with `c2896d74` from the `c083e27` snapshot lineage, which does not contain
     295650320.
   - The 2026-10-14 image `dist-custody-v2-295650320` has the same `flavor-env` (`9d901ae3`) and gsup `4cf28fd2`, so it had the
     vault only through that gsup. It is not the running image.
6. **The direct path needs `manager.supports.directBootstrap === true`** (supervisor L2501–2503, L2600). The running guestd
   cannot provide it (next section). Owner-committed deployments are therefore refused with "the manager does not support
   owner-committed guest bootstrap".

## Per-app guestd / runtime / CPU release actually used

**guestd** (PID 2223309, started 2026-10-19 13:14:45 -07:00):
- **Binary:** `/home/steven/enclave-prod/bin/guestd.sdshield-9d1562738cde`, sha256 `9d1562738cde6d43…` (named by its hash),
  8,046,584 B, mtime 2026-10-16 12:04:46 -07:00.
  - It is a go1.27.0 `(devel)` build with **no VCS stamp**.
  - The binary contains `awaitingCustodyAuth` and `custody-auth`, and **no `directBootstrap` string**.
- **Probable source:** `/home/steven/Projects/enclave-sdshield-guestd` HEAD `174edbb7` (committed 2026-10-16 12:04:46 -07:00,
  the binary's exact mtime).
  - That source implements the custody-auth **v2** handoff (`custody.go`: `custody-auth-v2 0x<vault> 0x<id> <binding>`;
    `server.go` L302 reports `awaitingCustodyAuth {v:2, vault, binding}`) and has no direct bootstrap.
  - Without a rebuild this is **strong correlation, not proof**.
- **Flags** (from argv; paths only, `/proc/*/environ` not read):
  - `-release`; `-custody-auth-port 9445`;
  - `-custody-bootstrap-hosts custody-{us-west,ca-east,ap-southeast,eu-central}.app.enclave.host`;
  - `-isolation …/iso-sdshield-1c3cdbb8/isolation`; legacy `…/iso-03be27d6/isolation`.
- **CPU release for new guests:** `-cpu-template` / `-isolation-release` = `release-16c2999d` (release.json `16c2999d…`).
  - front `082313e0…`: Go `enclave.host/isolation/m2/front`, with the `enclave-custody-release-v2` and `v2/custody` protocol
    strings present;
  - init `a8bd7e1a…`; wasmtime `9caac5e6…`; runtime.json `c60712e8…`; kernel `1a3a02d5…`; OVMF `142589cc…`.
- **Legacy releases:** `0181bce3`, `6757d139`. **Shield:** `5cab66e4…` and profile `987b1b9f…`.
- **Adopted runtimes (`-adopt-runtimes`):** 59 entries, including **`d84fb52b`** (the Oct-14 doc's "CPU"). An already-running guest
  of that runtime can be adopted; new guests use 16c2999d.
- **Not running now:** the Oct-14 doc's `guestd.custody2-568ab660bab4` (the file is still in `bin/`) and
  `dist-custody-v2-295650320`.

**Consequence.** The guest side (front 16c2999d, guestd 9d156) can ask for a v2 authorization. The supervisor in ed918e4b refuses
to sign it, because no v2 vault is measured, and the direct path is unavailable.

## Root metadata queries to confirm (exact; read-only)

1. **Running measurement:** `GET https://api.enclave.host/t/metal0/v1/attestation`, and check the report's measurement =
   `ed918e4b393699b3…a2ac2`. That ties the running VM to this dist beyond the process argv.
2. **guestd capabilities:** `GET http://127.0.0.1:8095/health` on metal0 (guestd control listener), and read `supports.release`,
   `supports.directBootstrap` and `catalog.runtimeId`. Expected from source: release true, directBootstrap absent. If the endpoint
   needs the pairing key, root uses its existing authorised client.
3. **Supervisor journal:** the control VM's journal (root's existing read path) for `custody authorization for` /
   `CUSTODY_VAULT_V2 is not set` or `custody release authorized`. This is evidence of an actual attempt; none was made here.
4. **fw_cfg:** **no fw_cfg query is needed for the vault.** This image's gsup never reads any custody value from fw_cfg, so its
   value cannot change the answer.

## Root prerequisites (no new feature; not done here)

To make metal0 a v2 recipient for 0xE486 again:
- **Restore the measured constants.** Restore 295650320's measured gsup constants (`CUSTODY_VAULT`, `CUSTODY_CHAIN_ID`,
  `CUSTODY_VAULT_V2: 0xe486…`) in the deabf8f90 lineage's `metal/guest/gsup.mjs`. A test pins it (295650320's
  `test/isolation-release-ticket.test.mjs`-style).
- **Rebuild the control overlay.** This gives a new measurement.
- **Admit and activate.** Admit that measurement and activate through the existing post-adoption runbook (stage, admit,
  baseline, gate, keep or rollback).
- **Order:** a custody canary with that recipient comes after that, not before.
- **Direct bootstrap is a separate, larger choice.** It needs a guestd and CPU release with `directBootstrap`; it is not the
  minimal step.

## Limits

- No live custody release, SNP or chain action was taken.
- The guestd-to-source link is by commit time and capability strings, not a byte-identical rebuild.
- `d84fb52b` guests may still exist (adoption list); whether any is running is root's `/availability` instanceSweep read.
- The published inventories (`out/*/initramfs-inventory.json`) omit the image members whose PATHS carry the provider name the
  2026-10-21 rewrite removed (count recorded in `membersOmittedForRewrittenLiteral`). None of them is a custody, gsup,
  supervisor or flavor-env file.
