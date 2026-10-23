# metal0 control: activate the restored-custody image (ROOT EXECUTES; prepared 2026-10-23, nothing here was run)

| | Production now | Candidate |
|---|---|---|
| Release source | deabf8f90 | **a6b1378c** (child of deabf8f90; `repo/` branch `restore/measured-custody-vaults`) |
| Image | `~/enclave-prod/dist-leasegas-deabf8f90` | `stage/dist-leasegas-a6b1378cd` |
| initramfs | c190c040… | **5ce61b6f590ed6b8…** (279,389,920 B) |
| Measurement | ed918e4b…a2ac2 | **ee5df6b83948f5bacebee414574adb87be9d58412b09ae9183fc4deed5aed3d96bc1cbead096372e7ee755febbbc22ec** |

- **Unchanged:** kernel `1a3a02d5…`, cmdline `d9e04c2c…`, base image `dist-sdshield-2857356cd`.
- **The only image change:** `opt/metal/gsup.mjs` and the in-image manifest.
  - That is 29,063 entries compared, entry by entry (`stage/entries-vs-production.jsonl`).
  - The candidate rebuilt byte-identically twice. The control rebuild of deabf8f90 from the same repo equals production byte for
    byte.
- **Effect:** the supervisor gets `CUSTODY_VAULT=0x08074300…11a6`, `CUSTODY_CHAIN_ID=8453` and
  `CUSTODY_VAULT_V2=0xe48699b8401564aace7a814ae4569b67a3f7eef5`. These are measured, not read from fw_cfg. Everything else in
  the legacy path is the deabf8f90 behaviour, including lease gas, isolation, release opt-in and post-adoption repairs.

## Signatures and authority (reported early)

- **Admitting the measurement needs NO on-chain, admin or host-operator signature.**
  - It is root's compare-and-swap of `METAL_ALLOWED_MEASUREMENTS` in `/etc/nan-relay/linux-leasegas-measurements.env` on the
    API relay (the `admit.py` pattern, over root's existing SSH).
  - The relay's attestation `operatorAllowlist` then lists it.
- **No registry re-registration:** the endpoint stays `https://api.enclave.host/t/metal0` and the registry key is unchanged.
- **Custody releases still need, at release time:**
  - the endpoint's registry operator key (already in the VM via fw_cfg `registryKey`, unchanged);
  - a live lease for the deployment;
  - the custodians' own checks.
- **Still blocking the custody production canary, unchanged by this fix (retained):**
  - the owner-gas / operator-proposal funding gap: "INSUFFICIENT BALANCE", and metal0's payout = Enclave, so there is no rate-0
    path for 0x29479…;
  - the r2 release needs two guests;
  - the address-book `secretVaultV2` is unset, and book/admin signatures are root's separate decision.

## Effect on existing apps and protections

- **Guests stay up.** guestd (`guestd.sdshield-9d1562738cde`) and every app guest are host-side and never touched.
  - Only the control VM restarts. During restart (~1–2 min) the supervisor is offline: no new claims and no control API, and
    public app data keeps flowing through guestd's data plane.
  - On boot, the supervisor ADOPTS each running guest by name and record digest (`supervisor.js` adoption, as in the deabf8f90
    activation). A guest is never relaunched unless its record differs, and this change does not touch records.
- **Lease gas is unchanged.** The conduit (`withLeaseGasEnv`, `lease-gas-conduit.bundle.mjs`) and the relay topology in
  config.json `leaseGas` stay as root left them. App-paid renewals must continue (gate phase 4).
- **New, intended:** a deployment whose guest asks for a v2 release for 0xE486 (or v1 for 0x0807…) can now be authorized.
  - The owner-committed rule (direct guests sign only their committed vault) and the refusal of any other vault are unchanged,
    and tested on the captured gsup environment.
  - The direct path stays unavailable with this guestd (no `directBootstrap`).
- **Platform host policy, admission bundle, guest protections, isolation min-TCB and egress:** unchanged (same files, entry-by-entry).

## Steps (adapt the reviewed `work/linux-post-adoption-release/activation/` scripts; do NOT edit those in place)

Copy that directory to a new `activation-a6b1378cd/`. Change only these constants:
- the commit, image and measurement above;
- `release` = the existing `~/enclave-prod/metal-deabf8f90`;
- the previous admission record = deabf8f90's `admission.json` (`environmentSha256 f33a6c91…`, installed 2026-10-21T08:04Z),
  unless root has changed the env since; `prepare-admission` must re-read the public allowlist and assert;
- the previous control = deabf8f90.

The steps:
0. **Preconditions** (root checks):
   - production is attached at ed918e4b, and both apps are actually healthy (`apphealth.py`);
   - `/availability` shows exactly one running owned guest per app (`guestrows.py` baseline); record the actual current guest
     ids;
   - the admission env still has `f33a6c91…`, or root's newer recorded sha;
   - `stage/INVENTORY.sha256` re-verifies.
1. **Stage:** copy `stage/dist-leasegas-a6b1378cd` to `~/enclave-prod/dist-leasegas-a6b1378cd`, inventory-compared.
   - Leave `dist-leasegas-deabf8f90` and `metal-deabf8f90` in place: they are the rollback.
   - `stage/metal-a6b1378cd` (git archive) is optional provenance. The launcher does not load `metal/guest/gsup.mjs`
     (`enclave-metal.mjs` references it only in comments), so WorkingDirectory can stay `metal-deabf8f90`.
2. **Admit (additive):** `METAL_ALLOWED_MEASUREMENTS` = the current list plus `ee5df6b8…`, by compare-and-swap with a fresh
   backup. Then recheck that the public attestation `operatorAllowlist` lists it. Undo: `unadmit` by compare-and-swap.
3. **Fresh preflight:** funding and lease, under 6 min old, both apps covered.
4. **Activate** (the `activate.py` phases, unchanged):
   - mandatory baseline;
   - fresh private backup;
   - config.json `dist` set to the new image. **This is the only config field that changes.**
   - restart `enclave-metal.service`;
   - attach within 120 s, with `admittedAtAttach == ee5df6b8…`;
   - adoption of both apps' baseline guests within 300 s;
   - gate v4 (≤ 300 s warm-up, 420 s continuous actual health, guests owned and running, vouch, no death/reap/relaunch);
   - both app-paid renewals within the limit.

   This ends PROVISIONAL.
5. **Root verifies:**
   - a fresh attestation (measurement ee5df6b8);
   - the capabilities (`/availability`, `/v1/health`);
   - the renewal audit on chain.
   - **Optional, without a release:** the supervisor journal shows no `CUSTODY_VAULT_V2 is not set` on any custody-auth request.

   Then `keep`.
6. **Rollback** (any phase failing, or root's choice):
   - stop the new control, then wait past every sponsored deadline it logged, on a block two public RPCs agree on;
   - restore config.json from the private backup by compare-and-swap (`dist` back to `dist-leasegas-deabf8f90`);
   - start the control. ed918e4b is still admitted.
   - The rollback restores the custody regression, but nothing else changes.

## Limits (retained)

- **guestd provenance:** guestd's binary-to-source link (9d1562738cde to `enclave-sdshield-guestd` 174edbb7) is by commit time
  and strings, not a rebuild.
- **No release run:** no live custody release was run, and none is part of this activation. A custody canary comes after `keep`
  and after the owner-gas blocker is resolved.
- **Pre-existing failure:** `test/metal-measured-control.test.mjs` test 4 fails identically on deabf8f90 and on a6b1378c. It
  compares the working tree with HEAD, which is meaningless in a committed release tree. It is not called green.
