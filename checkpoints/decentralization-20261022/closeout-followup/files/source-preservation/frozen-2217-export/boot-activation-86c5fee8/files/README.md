# metal0 control: second image-only activation, carrying the boot-registration fix (ROOT EXECUTES each phase after review)

Prepared 2026-10-23 as source only. Nothing here touched production, the relay, SSH, the chain or keys.

This attempt reuses the first attempt (`work/custody-recipient-activation-20261023`, 7426b29), whose rollback restored
deabf8f90 at 21:37Z. It changes **only config.json `dist`**, to a build of H's reviewed commit 9f6d37bd that **root has
approved**. That attempt's state, private backup, evidence and relay backup are not touched; this folder keeps its own.

| Field | Value |
|---|---|
| Image | `dist-leasegas-deabf8f90` (ed918e4b) → `dist-leasegas-9f6d37bd8` |
| Source | H's commit **9f6d37bd858a…** (child of a6b1378c; delta = `supervisor.js` + its test) |
| Build | root's `build-approved.sh` run, log `custody-recipient-restore-20261023/logs/root-build-approved.out` |
| Measurement | **only** what root approves in `build.json`. That run printed `08d1f838…a000`, initramfs `02c7280a…` |

**What the second attempt changes vs the first:**

1. **Reviewed-build input instead of constants.**
   - `build-record.py` derives `build.json` from the completed build. It checks:
     - the commit, its parent, its delta and its `supervisor.js` bytes;
     - `APPROVED-COMMIT.txt` is exactly that commit with `extra NONE`;
     - every success marker of the log appears exactly once, and there is no refusal;
     - the logged inventory equals `INVENTORY.sha256`;
     - the kernel and cmdline are unchanged, and the initramfs and manifest are not a6's;
     - `MEASUREMENT` equals the logged value;
     - every staged file, re-hashed.
   - Root reviews it and writes `APPROVED-BUILD.txt` = `build-sha256 <sha256 of build.json>`.
   - `stage.py`, `prepare-admission.py`, `admit.py`, `unadmit.py`, `activate.py` and `keep.py` accept nothing else:
     - `load_new()` re-checks plan.json against the approval on every run;
     - no other head, measurement or file is accepted.
2. **Admission 36 → 37, additive.**
   - The compare-and-swap is from the 21:30Z env `85d5f14d…`. That is the 35, plus ee5df6b8, in installed order.
   - ed918e4b and ee5df6b8 must both be present. The candidate is appended and nothing is removed.
   - It is the same privileged admission type as before: a backup (`.before-9f6d37bd8`, while `.before-a6b1378cd` stays), an
     atomic replace, an explicit relay restart, and restore-and-restart on failure.
3. **Pre-cutover baseline from root's authenticated guestd listing.**
   - **Why guestd:** the old control is not registered, so it adopted nothing, and `/availability` has no `instanceSweep.held`.
   - **How root takes it:** root saves its existing authenticated client's `GET /vms` answer privately (0600, ≤ 300 s old). This
     folder never reads the key.
   - **Per app, the listing must show:**
     - exactly one nonterminal guest;
     - that guest is `running` and has a `recordSha256`;
     - it is the guest of the **original 21:31:30Z baseline** (`evidence/original-baseline-20261023T213130Z.json`, sha pinned
       `45554dc5…`): **gd9d4a391d** image-generator, **gdd0646f2c** EyesOff;
     - the same (empty) failed history.
   - **What is kept:** only id/name/status/recordSha256/createdAt. Other guests are recorded as `otherGuests`.
   - **`/availability` held is recorded as it is.** If absent, the result says `oldControlAdopted: false`; it never pretends the old
     control adopted. If present, it must agree with guestd.
   - Actual app health must pass now.
4. **Mandatory boot-funding preflight**, run by `funding.py` and run again by `activate.py` as the **last** check before its single
   write.
   - **`boot-funding.mjs` reads** (two RPCs, one agreed block, read-only):
     - the schema-4 registry code;
     - the operator's EIP-7702 code, which must be exactly `0xef0100 8900baca…` (root 20:14; keccak = `e2f1317f…`, tested);
     - the executor code hash `dd893cd4…`;
     - the metal0 row;
     - nonce at the block, latest and pending on both RPCs;
     - the balance;
     - viem's default fee `ceil(1.2·base)+tip` (≈ 7 mwei now, not 11);
     - two gas estimates, the L1 upper bound and the Isthmus operator fee for `setProofKey(metal0, 0xff…ff)`. The test key is the
       worst-case nonzero 20-byte key, for **fee estimation only**; the real boot key is minted after the restart.
   - **The decision function** is the **reviewed commit's own** `bootRegistrationAction`, read with `git show 9f6d37bd:supervisor.js`
     and hash-checked. It is asked about root's confirmed fields: repo `EnclaveHost/enclave`, measurement 0, prices 834/1667.
   - **`boot_funding_problems()` refuses unless:**
     - the decision is **exactly setProofKey**. A needed full `register()` is NOT accepted as a fallback for this cutover;
     - all fields are exact and the row is active and this operator's;
     - registry, delegation and executor are unchanged;
     - nonce = latest = pending on both RPCs, so no operator transaction is in flight;
     - the worst case (larger gas estimate × viem default maxFee + L1 + operator fee) ≤ balance, **with 25% headroom**;
     - the facts are under 360 s old.
   - **Block agreement is canonical** (fix after root's failed 22:07/22:08 runs). Root's runs failed because whole block objects were
     compared as JSON. The bounded read-only `block-probe.mjs` (`logs/probe2.out`, 10 rounds) found publicnode and mainnet.base.org
     returning the **same fields and values in a different property order** in round 5. The check now requires
     number/hash/parentHash/timestamp to be equal, and ignores provider metadata and order. Hash, number or timestamp disagreement,
     a null block, or the wrong block number still refuses (tested; mutants killed). Code, nonce, balance and `eth_call` results
     must still be exactly equal.
   - **Root's actual 2-RPC read** (block 53001451, `root-live-fees2.out`) passes: 271.9e9 worst case against 376.1e9. The full
     register would be 354.1e9.
   - The supervisor's sender is unchanged. There is no new fee sender, manual proof-key transaction, funding or delegation change,
     and W's rejected helper is neither used nor reimplemented.

**Byte for byte from the first attempt (tests pin this):**
- `verify-operational.py`, `guestrows.py` and `apphealth.py` (the `REVIEWED-COPIES.json` hashes);
- `preflight.mjs` and `renewal-watch.py`;
- in `common.py`: the rollback, journal, deadline, verified-block, dist-rewrite, protected-field, remote-script and lease-preflight
  code;
- in `activate.py`: everything from the write on. That covers the restart, attach in 120 s, both apps adopted with the **same**
  guests in 300 s, gate v4 at its defaults, renewals and PROVISIONAL. Only the state text naming the measurement differs.

There is no relaxation of health, adoption, vouch or authority. WorkingDirectory, drop-ins, leaseGas and all other config stay as
they are.

## Phases (run from `/home/steven/Documents/Codex/2026-10-18/wo`; stop and review after each)

| # | Command | Writes | Privilege / impact |
|---|---|---|---|
| B | `python3 work/custody-boot-activation-20261023/build-record.py --log work/custody-recipient-restore-20261023/logs/root-build-approved.out` | `build.json` | local, read-only (already run once, see `logs/`) |
| B' | **root reviews `build.json`** and writes `APPROVED-BUILD.txt` | | root's decision |
| 0 | `python3 …/stage.py` | `~/enclave-prod/dist-leasegas-9f6d37bd8` (via `.staging`, every hash checked), `plan.json` | local copy only |
| 1 | `python3 …/prepare-admission.py` | `admission.json`, `measurement.env` | **read-only** SSH read of the relay env and drop-in; public attestation |
| 2 | `python3 …/admit.py` | relay env (CAS + `.before-9f6d37bd8`) | **privileged**; restarts `enclave-api-relay.service` (transient: every api.enclave.host request/tunnel drops for seconds and reconnects; metal0 reattaches at ed918e4b) |
| 2b | `python3 …/recheck-admission.py` | `admission.json` stage | public read |
| 3 | `node …/preflight.mjs` (< 6 min before 4) | `evidence/lease-preflight.json` | public chain reads. **Both leases need fresh margin** (> 780 s: adoption 300 + rollback 480) |
| 3b | `python3 …/prebaseline.py --guestd-vms <root's fresh 0600 GET /vms file>` | `evidence/guestd-baseline.json` | read-only (root's own authenticated guestd read happens before, outside this folder) |
| 3c | `python3 …/funding.py [--rpc A --rpc B]` | `evidence/boot-funding.json`, `boot-funding-verdict.json` | public chain reads |
| 4 | `python3 …/activate.py --guestd-vms <a FRESH file, ≤ 300 s> [--funding-rpc A --funding-rpc B]` | config.json `dist` (fresh `private-backup/`), `result.json`, `gate.json`, `apps-health.json`, `evidence/*-activate.json` | restarts `enclave-metal.service` only (the control VM) |
| 5 | `python3 …/renewal-watch.py`, then `python3 …/keep.py --checked-attestation <root's fresh attest-control/1 verdict for the approved measurement> --attestation-raw <its 0600 raw answer> [--audit … --verified id=tx …]` | `result.json` | read-only on the host |
| R | `python3 …/rollback.py` | config.json back (CAS) | restarts the control |
| R2 | `python3 …/unadmit.py` (only while the candidate is NOT attached) | relay env back to `85d5f14d` (CAS on both versions) | **privileged**; relay restart |

**Expected boot sequence after phase 4's restart:**
1. The candidate attaches.
2. The reviewed supervisor reads its row, which is exact except for this boot's key, and sends ONE `setProofKey` through the
   existing default sender.
3. After the receipt **and** an exact re-read it adopts the registry row. A failed or lagging re-read throws, and the next normal
   attempt reads again.
4. Only then does the claim loop adopt both guests by record digest.
5. The unchanged 300 s adoption deadline and gate v4 decide. Any failure triggers the unchanged safe rollback.

**`keep.py` takes a strict verdict, never a substring** (root 22:08). It requires an attest-control/1 verdict that:
- passed, with every required check PASS;
- has observed == expected == **the approved measurement**;
- is bound to the verifier nonce, with VMPL 0;
- was produced after this activation attached and at most 1800 s before the keep;
- comes with a private 0600 raw answer that hashes to `rawSha256`.

A file that merely names the measurement is refused. Root supplies the fresh verdict for the recovery target: the frozen
`attest-control.mjs` pins ee5df6b8 and is not changed here.

**Root's runtime files stay out of the source commit.** They are gitignored and are never copied into the mutant runs:
`ROOT-*`, `evidence/*private*`, `evidence/boot-funding*.json`, `evidence/guestd-baseline*.json`, `evidence/lease-preflight*.json`
and `logs/root-*`.

## Retained limits

- **Rollback does not restore the host's registration.** The previous control (ed918e4b) needs a full `register()` at boot, which
  is the 21:37Z state: not registered, nothing adopted. Root may need to maintain the app leases separately while it is back.
- **Residual race.** The old control keeps retrying its full `register()` (backoff ≤ 300 s) until phase 4 stops it. The funding
  check sees an in-flight transaction only at check time.
  - If an old register lands in the seconds between the check and the stop, the balance drops by about 0.3e12 wei.
  - The new boot's setProofKey then cannot be paid, adoption times out, and the unchanged rollback runs.
  - The row would still be exact, apart from the old boot's key.
- **Funding bounds hold only at the checked block.** The 25% headroom covers about a 25% rise in fee or gas before the restart.
- **The guestd listing format is guestd 174edbb7's `GET /vms`** (`{"vms": [{id, name = deployment id, status, recordSha256,
  createdAt, …}]}`). Root's client output must be that body.
- **Not exercised end to end:** `activate.py`, `keep.py`, `preflight.mjs`, `funding.py` against the real chain, and `prebaseline.py`
  against the real guestd. They act on production, the relay or the chain. Their decisions are tested functions, and the gate is the
  byte copy.
- **Still open, unchanged by this attempt:** the custody canary's own blockers (owner gas, r2 two guests, the unset book
  `secretVaultV2`) and guestd's binary-to-source link.
