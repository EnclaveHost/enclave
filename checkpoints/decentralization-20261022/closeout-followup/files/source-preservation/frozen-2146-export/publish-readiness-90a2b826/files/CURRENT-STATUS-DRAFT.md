# Production custody v2: current status (DRAFT, 2026-10-23 21:35 UTC)

**This is a draft for root.** It is not yet the public `outputs/decentralization-audit/custody-v2-live-verification-20261023.md`
(current bytes sha256 `ad1acb58f5d90f585380a9db0844a2d80e5c3001a19d31d6096b5fcdd9fd237e`). Every fact below comes from the evidence files listed in §5. Where the evidence shows root
acting or observing, it says so. Nothing in this draft was newly probed.

## 1. Current state

1. **CPU shares: complete.** Root's receipt (19:41Z) records the coupled-share runtime (image `c1619eec…`, measurement
   `62ac7aab…`) deployed, all nine pre-existing apps recovered, and strict HTTPS 200 on all 18 routes.
2. **Production custody is unchanged: the original October 14 single-seat bootstrap.**
   - It is vault `0xe48699b8…7eef5`, committee `0x4774…f7a3`, epoch 1: one Enclave-operated seat, threshold 1.
   - It runs on the original `custodian-v2-9d43e63e8` image, whose measurement `c8663742…` matches the on-chain record.
   - This is **not decentralized custody**: one seat, one chip, one operator.
3. **Corrected image r2: reproducible and hardware-tested for startup only. Not activated.**
   - **Build:** source `ab589bf8`, built twice byte-identically. Measurement `70aadff5…`, manifest `60bde3e9…`.
   - **Real SNP hardware covers ONLY** a quote-only boot and the isolated startup / storage-outage (seven HTTP 503 answers over
     45.9 s, no writes) / same-identity-reopen test at 20:14–20:16Z.
   - **Not tested:** no fresh secret lifecycle. No secret was created, released, migrated or rotated.
4. **Code admission (new verified evidence, 21:23Z, block 53,000,630).**
   - The original vault's `CODE_DELAY` is **604800 s (7 days)**.
   - `codeActiveAt(committee 0x4774, corrected measurement 0xfbe2f581…)` is **0**: the corrected code was never proposed for the
     existing committee.
   - So r2 cannot serve the existing committee until a code proposal and then 7 days.
   - **A new committee is not an upgrade:** creating one does not upgrade or migrate existing policies.
5. **Recipient (metal0 supervisor).**
   - The running control image `ed918e4b` lacks the measured `CUSTODY_VAULT_V2` setting, so it cannot authorize v2 releases.
   - A minimal restored image `ee5df6b8…bc22ec` is built reproducibly.
   - Root added it to the relay measurement allowlist at 21:30Z (`admission.json`: "verified active; old control still
     connected").
   - It is **not activated**: the control VM still runs `ed918e4b`.
   - Protected app guests are unchanged; the 21:13Z baseline shows EyesOff and image-generator healthy.
6. **Address-book `sessionVaultFactory`: awaiting the administrator only. No chain confirmation.**
   - The preflight passed on two providers at 21:07Z: all 98 deployments checked, no existing policy stranded, and the relay
     already pins the same factory.
   - The localhost signing page (127.0.0.1:39672) awaits the administrator's signature.
   - The repository journal held no attempt at 21:32Z, and no transaction is confirmed. This is not v2 activation.
7. **Address-book `secretVaultV2`:** an unsigned plan has been simulated. It is deliberately held until the lifecycle tests and
   dashboard publication pass.
8. **metal0 host-owner enrollment: blocked on operator gas.**
   - **The gap (21:16Z, two providers):** the operator holds 376,132,087,579 wei against a worst-case 1,038,286,650,790 wei, a gap
     of **662,154,563,211 wei**.
   - **Ordinary transfer is impossible:** the operator address carries an EIP-7702 lease delegation, and its executor has no
     payable receive.
   - **Rejected helper:** a force-fund helper was rejected by the automatic approval review. It was never implemented or sent,
     and must not be retried or worked around.
   - The delegation and all lease operations are unchanged. No enrollment transaction has been sent.
9. **Dashboard site.**
   - Release r2 `bafybeihm7f2mhw6…` (from dashboard `a942a61f`) is prepared and **unpublished**; the served site is unchanged.
   - The public IPNS record is valid at **sequence 1026** (old site CID `bafybeieuxt6…`) until **2026-10-30T13:03:14Z**.
   - The local publisher lost its state at its 19:27:53Z relaunch (sequence 0, empty value, no recovery, no durable state file).
     It awaits a recovery with its sequence preserved (handoff `f0efadbd`).
10. **The canary budget cannot cover the requested complete matrix.**
    - The full matrix's worst case is 8.74–9.74e13 wei at a 12 mwei cap, against a 5.5e13 wei budget.
    - Only a reduced plan without migration fits, and that cannot satisfy the complete matrix. The full matrix has not been run.
11. **Preservation:** the checkpoint `f2e7009e` was verified by root; main `68b82926` is unchanged.

## 2. Requested test matrix

The columns are: done in source, on a fake chain or anvil; done against real production (hardware or chain); and outstanding.

| Test | Source / fake / anvil | Real production | Outstanding |
|---|---|---|---|
| Fresh SNP quote, measurement binding | verifier tests | Oct 14 image 18:15Z; r2 quote-only 19:31Z and 20:14Z | — |
| Absent-state startup, storage-outage refusal, same-identity reopen | durability `ab589bf8` daemon-startup tests | r2 disposable canary 20:14–20:16Z (refusal host-observed; reopen attested) | the same with **real canary shares/secrets** |
| Canary secret creation (save) | dashboard real-contract anvil tests | — | yes |
| Legacy → v2 migration, active-store deletion | anvil / source | — | yes (not in the current budget) |
| Post-migration rotation | anvil | — | yes |
| Attestation-gated release | source | — | yes; blocked on recipient activation (`ed918e4b`) and code admission (§1.4) |
| Unauthorized-access and stale-revision rejection | anvil (session key refused; `NotOwner`) | — | yes |
| Pause / resume | anvil | — | yes |
| Outage and restart recovery with real shares | — | startup-only variant (above) | yes |
| Rollback: discovery clear, site rollback | unsigned plans, two-provider simulations | — | yes |
| Relay plaintext instrumentation, active-store deletion | — | inventory only (37 records; canary ID absent) | yes |
| Canary ingress forwarder | tests, 25 mutants killed | Caddy validation with the installed binary, 20:39Z | not live |
| Factory activation | tests; two-provider preflight 21:07Z | — | administrator signature, then chain confirmation |
| Dashboard publication | r2 built and checked | — | publisher recovery, then the reviewed publish flow |

A successful quote, source test or preflight is not evidence that a lifecycle case passed.

## 3. Rollback procedures

- **During canaries:** keep the original service, image, sealed state, committee and deployments intact. Canary teardown stops
  only its own processes and removes only its own private state.
- **Site:** keep the previous site CID (`bafybeieuxt6…`) and its release directory. A site rollback restores that release; it
  does not roll back policies.
- **`secretVaultV2`:** clearing it is an administrator-signed discovery rollback. Existing bundles and revisions remain, and
  users still need a reachable compatible custodian.
- **`sessionVaultFactory`:** do not toggle it as a routine rollback once policies exist, because ownership-interpretation
  changes can strand bundles.
- **Sealed state:** never overwrite newer sealed state with an older blob, and never run old software against new state without
  a tested migration path. There is no hardware monotonic counter.
- **Recipient:** activation changes only the control config `dist`. Rollback returns `dist` to `ed918e4b`; the relay allowlist
  admission is additive.
- **IPNS publisher:** do not change its value while sequence recovery is unconfirmed. A same-CID round with failed recovery is
  harmless and heals itself.

## 4. Administrator authority boundaries

- **The administrator wallet `0x0b2d…eE61` signs:**
  - `sessionVaultFactory` (pending now);
  - later `secretVaultV2`, after the tests;
  - metal0 `acceptOwner`, after the operator's proposal;
  - catalog publications.
- **Owners** sign their own policy changes and migrations.
- **Kept intact:** no administrator control is removed, and no existing contract is modified by any prepared call.
- **Code admission** for the existing committee takes effect only 7 days after a proposal; none has been made.
- **Root owns every activation and signature.** None has occurred except the measurement-allowlist admission in §1.5, which is
  an allowlist change, not an activation.

## 5. Evidence

All paths are relative to the workspace root. Public data only: no private bytes, raw quotes or keys.

| Evidence | sha256 |
|---|---|
| `outputs/decentralization-audit/nucbox-coupled-shares-production-20261023.json` | `4d4d795f1ed151e0dfcb0bcc4d0603f8fef22feb6f9194d1f0600a4669a805da` |
| `outputs/decentralization-audit/custody-v2-corrected-image-hardware-20261023.json` | `e3795392f4f171578b9f28d44175d48af433806ce9d308e0af44c444e5eeba6c` |
| `outputs/decentralization-audit/custody-v2-snp-startup-recovery-20261023.json` | `447a3cbfe1b6c2d6722c573d3693ad8ea054d6beb9f36beb7cdf111222206de5` |
| `work/custody-snp-recovery-harness-20261023/evidence/20261023T201449Z/result.json` | `362333f0df4d168f6b62fb65d7929824652e353230e3e3e895b1ce1dd4d17ef4` |
| `work/custody-v2-live-20261023/evidence/custody-code-delay.json` (root, 21:23Z) | `a843ab647535074069f10aa84f13e9202f719d84a3b54f5f19df3156a1e244ed` |
| `work/custody-v2-live-20261023/evidence/operator-fees-confirmed.json` (21:16Z) | `d7ee55117e80d117e7df56a76d9cc4ae23ed20df7bb6715b55775d93ce1bae6b` |
| `work/custody-v2-live-20261023/evidence/factory-consumer-state.json` | `e506f4c83d3173c303da41500dddbd2b9622bcf51aecdda3db62d5f8cbc4779b` |
| `work/custody-v2-live-20261023/evidence/factory-activation-unsigned-20261023.json` | `3b28b16ff5a10ae6968547f12cca456da522995737eb684a5d922fa3e8f5770b` |
| `work/custody-factory-wallet-20261023/evidence/root-live-preflight-20261023.json` | `dae31c3afff465d0e03d99fff683978313aa28318560ed76555a3d00a7dea442` |
| `work/custody-v2-live-20261023/evidence/book-activation-unsigned-20261023.json` | `fbd80b96c84afd79fda81e1068a15818a67cde098253f65720b4b3acb1a6adf4` |
| `work/custody-v2-live-20261023/evidence/metal0-enrollment-unsigned-20261023.json` | `9f6eba17c9c479e9006849316f1708f37ee6680f37a990e57e07c421b86e6b82` |
| `work/custody-v2-live-20261023/evidence/relay-session-authority.json` | `3e066d25a5ed6ae6f6db62b109a97f191ceb046855c9440b980d90da01b1cb71` |
| `work/custody-v2-live-20261023/evidence/recipient-live-confirm.json` | `f2ade7e161432a5396b914492aadb0e4b2d1e457e5fc99ce670dffdb4dec46c4` |
| `work/custody-v2-live-20261023/evidence/recipient-guestd-health.json` | `04172af17bc4564638bf64d6e43a71e965f7b1f616372c0df8edf3843861a0ea` |
| `work/custody-recipient-activation-20261023/admission.json` (21:30Z) | `6047abd60e360237c60218aaae61097c630970b53b58b587c097eec4c279410e` |
| `work/custody-publisher-assessment-20261023/evidence/public-read-20261023T204419Z.json` | `1139a0a7a8858135acf7c5d1d1baf813487c347b7bc3f5ae0fe37033e9280622` |

**Source heads:**
- r2 release: `23f7e51a`
- durability: `ab589bf8`
- dashboard: `9d97b4b0`
- site r2: `14b5f559`
- recipient restore: `b03be02d`, activation `2c5d9b5a`
- canary driver: `49fb0a6`
- factory handoff: `9557ad6d`
- live reads: `1c8403e8`; `custody-code-delay.json` and `operator-fees-confirmed.json` are not yet committed there

## 6. History: statements in the public file that this draft supersedes

The public file's sections from 18:10 to 21:13Z remain accurate as dated observations. Read these statements as history only:
- **"No wallet request is ready yet"** (20:25Z): the factory signing page has been open since 21:07Z. Enrollment and
  `secretVaultV2` are still not ready.
- **"A smaller baseline can fit"** (21:13Z): it fits, but omitting migration cannot satisfy the complete matrix (§1.10).
- **Recipient "a minimal correction is in preparation"** (20:59Z): it is now built and allowlist-admitted, but not activated
  (§1.5).
- **The 18:10Z note** that "owner enrollment remains required for the corrected image" still stands. It is now blocked on
  operator gas (§1.8).
- **The corrected image's path to the existing committee** is gated by the 7-day code delay (§1.4). No earlier section stated
  this.

**Standing limitations:**
- one seat on one chip;
- public RPC providers;
- no hardware anti-rollback;
- historical event discovery is incomplete;
- quorum reads are only as independent as the providers.
