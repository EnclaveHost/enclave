# Exact source references

Paths are under `/home/steven/Documents/Codex/2026-10-18/wo/`. Commits are full or 8-character git ids. Each line ends with
whether it is "committed" or "uncommitted, as read" (with the time).

- **S1:** `work/custody-v2-live-20261023/evidence/known-state.json` (commit a90f833; repo head 1535fcf0). Block 52,994,819, 18:10Z:
  vault code hash, book entries and owner, committee 0x4774 and its machine, the canary policy. Also `README.md` L7-9 (measurement
  c8663742 = 2530eda0, image `custodian-v2-9d43e63e8`).
- **S2:** `work/custody-code-admission-20261023` commit 8578965c.
  - `evidence/original-code-path.json`: the deployed bytes reproduced from blob 7a385bbc; Weight(0,1); the 7-day boundary; cancel
    semantics; 21/21.
  - `evidence/live-code-state.json`: block 53,001,067; two RPCs agree; `codeActiveAt`; the live `proposeCode` eth_call reverts.
  - `orig-9d43/`: a git archive of `/home/steven/Projects/enclave` at 9d43e63e84e1799467a0202c0cf1cdc5a8aabca5.
- **S3:** `outputs/custody-existing-contracts/runtime-image-provenance.json` (root; not a repo): image directory
  `custodian-v2-9d43e63e8`, custodian.mjs `7c2cd000…`.
- **S4:** `work/custody-code-admission-20261023/HANDOFF.md` and `evidence/code-admission-plan.json` (commit 8578965c). Also
  `work/custody-v2-live-20261023/evidence/custody-code-delay.json` (commit 570947d4; block 53,000,630, `correctedCodeActiveAt` 0).
- **S5:** `work/custody-v2-live-20261023/evidence/session-factory-state.json` (commit 3fd6e8ff, block 52,998,138) and
  `book-abi-readcheck.json` (commit dc07e225, block 52,999,644: `owner()` = 0x0b2d…, no `pendingOwner`).
- **S6:** `work/custody-factory-wallet-20261023/evidence/root-live-preflight-20261023.json` (commit 9557ad6d; block 53,000,163,
  21:07:57Z, `sessionVaultFactory` 0), and `README.md` L1, L10-11, L101, L110-113.
- **S7:** `work/custody-v2-rollout-audit-20261023/RESULT.md` (commit 8df7139):
  - F2 (L171-174), F4 (L175), F6 (L179-182), F9 (L194-198);
  - S5 and S7 (L334, L336), absence-scope L261-267, O3 (L352-355).
  - "No fake SNP, anvil, local fixture or quote-only run counts as production evidence" (L42).
- **S8:** `work/custody-snp-recovery-harness-20261023` (commit 7c4844a):
  - `evidence/20261023T201449Z/result.json` L3-4 (scope "startup-recovery evidence only; quote-only; not secret release or
    lifecycle"; `quoteOnly: true`), L46-54, L122-162, L245-275;
  - `terminal.json` L10;
  - `README.md` L172-176 ("Rollback is NOT addressed") and L231-233.
  - Stale before the run: `README.md` L3.
- **S9:** `work/custody-v2-release-20261023` (commit 23f7e51):
  - `README.md` L3-7 (e01206d3, 19:31Z, quote-only);
  - `RESULT-R2.md` L21 (only 404 = absent), L119, L199-204 (malicious 404, old valid blob, DoS), L213-214.
  - Stale before the run: `README.md` L13.
- **S10:** `work/custody-v2-durability-20261023/RESULT.md` L133-138 (not anti-rollback, high-water memory-only, a lying host) and
  `ROOT-ROLLOUT-FINDINGS.txt` L3, L5. Uncommitted, as read 22:05Z. The repo is `repo/` at ab589bf8.
- **S11:** ab589bf8 `custody/v2/custodian.mjs` L47 (`memoryHighWater()`), `startup-state.mjs` L4-5 and L13, `host.mjs` L65 (20
  history blobs). The original 9d43e63e8 `custody/v2/daemon.mjs` L78 and L86-91.
- **S12:** ab589bf8 `contracts/DEPLOYMENTS.md` L497-503 and `metal/PROTOCOL.md` L114-118 (proof key served at the attested origin
  `/v1/attestation` → `proofKey.address`, compared with the registry). Harness `verdict-fresh.json` and `verdict-reopen.json` L15
  (the binding is transport key + challenge + runtime). The wording "proof key relay-origin, not SNP-bound; quote-only transport
  key" is root's (`custody-code-admission-20261023/ROOT-DOCUMENT-RECONCILE.txt`).
- **S13:** `work/custody-publisher-assessment-20261023/RESULT.md` (commit b895d295): L10-11 and L66-68 (sequence 1026, valid
  until 10-30), L21-22 (`durableState: false`), L59-64 (local sequence 0, http-only, 503 on `/routing`).
- **S14:** `work/custody-v2-site-release-r2-20261023/RELEASE-HANDOFF.md` (commit 14b5f559) and
  `work/custody-site-publish-readiness-20261023/CURRENT-STATUS-DRAFT.md` L49 (commit 90a2b826; a draft, not public output).
- **S15:** `work/custody-factory-wallet-20261023/README.md` L110-113 (`serve.mjs`, port 39672).
- **S16:** `work/resume-after-checkpoint-20261022/ROOT-CONTINUE-LATEST.txt` L493-523 (root's journal; uncommitted, as read about
  22:16Z): the 21:29-22:14Z incident entries. L521-523 hold the 22:14Z state, the lease correction, the 22:10:58 renewal, the
  22:12:53 quote and the factory at 22:11. Corroborated by:
  - `work/custody-v2-live-20261023/evidence/protected-renewals/0xda09…result.json` (commit 1535fcf0);
  - `0x9eb4…result.json` and `boot-public-state.json` (staged, uncommitted);
  - `work/custody-recipient-activation-20261023/logs/root-activate.out` and `ROOT-REGISTRATION-INCIDENT.txt`;
  - `outputs/decentralization-audit/custody-v2-live-verification-20261023.md` L3-7 (root's public output; read only).

- **S17:** `work/custody-v2-live-20261023/evidence/known-state.json` as read at about 22:28Z. This is root's UNCOMMITTED modification
  (the repo head is d64f0443), at 2026-10-23T22:20:34.005Z, block 53,002,331: code hash `0x4b949b37…`; book `secretVaultV2`,
  `secretVault` and `hostOwnership` = 0; committee 0x4774 at epoch 1, t 1, W 1, with one machine.
- **S18:** `work/custody-v2-current-docs-20261023/ROOT-ROLLBACK-REVIEW.txt` (root, as read 22:27Z): the `7dd3acd` approval and
  build start at 22:25, and its behaviour as root describes it. This worker did not review the `7dd3acd` source.
- **S19:** the vault's owner and bundle semantics are in 9d43e63e8 `contracts/EnclaveSecretVaultV2.sol` (blob 7a385bbc), in
  `work/custody-code-admission-20261023/orig-9d43`:
  - `beneficialOwnerOf` reads `book.addr("sessionVaultFactory")` live;
  - `_ownerFor` and `_apply` pin the owner at the first write and revert `NotOwner` once the beneficial owner differs;
  - a committee change with a stored bundle needs a fresh bundle or a clear;
  - `_bundles[id]` holds the current revision only;
  - `_claim` deletes the bundle and pauses.
  - The original custodian's release refuses `owner_mismatch` when the beneficial owner is not the pinned owner
    (`custody/v2/custodian.mjs` L110-111).

- **S20:** root's freeze instruction `work/custody-v2-current-docs-20261023/ROOT-PRESERVE-2245.txt` (as read 22:46Z): the 22:45Z
  state, the 7dd3acd builds and measurement, the activation kit under review, and the factory and canary-wallet pages. Also:
  - the renewal receipts `work/custody-v2-live-20261023/evidence/protected-renewals-2239/*.result.json` (commit b4e1f14):
    imagegen tx 0x843c4aa8… at 22:39:27.772Z, EyesOff tx 0xeb9279fd… at 22:43:54.255Z;
  - the build record `work/custody-boot-price-release-20261023/stage/build-record.json` (measurement b007d471…).

- **S21:** `work/custody-v2-current-docs-20261023/RECIPIENT-BINDING-REVIEW.txt`. This is a bounded SOURCE review, written
  2026-10-23T22:54:44Z and reviewed by root; nothing was run. It covers the custodian at `custody-v2-durability-20261023/repo`
  ab589bf8 and the recipient candidate at `custody-boot-registration-20261023/repo` 7dd3acd.
  - Lines re-checked by this worker at ab589bf8:
    - `custody/v2/custodian.mjs` L164 (releaseBinding), L169-173 (verify with binding, appId, HOST_DATA), L178-180 (partials over
      the binding);
    - `custody/verifiers.mjs` L40-53 (VCEK-signed, DEBUG off, VMPL, measurement, report_data[0:32]/[32:64], HOST_DATA, CHIP_ID);
    - `custody/v2/chain.mjs` L71 (proofKey only in the registry ABI);
    - `isolation/m2/front/custody.go` L116-134 (committee from the pointer, no chain read), L245-258 (report_data = binding ||
      appSha), L286-287 (config compared with the relay-pointed bundle; the review cited L283-285).
- **S22:** root's instruction for this update (2026-10-23, received about 22:56Z). It is the source for the 22:47:45-22:56 facts:
  the top-up target check, `b007d471` staged and admitted (37 → 38), the old control re-attached with no restart, the funding
  refusal, and D's test counts. All are PROVISIONAL until root updates its journal.

- **S23:** `work/custody-boot-price-activation-20261023/result.json`, as read 23:25Z. It is root's runtime file: git-ignored and
  uncommitted, with kit head 8bbd0a74. It records the start at 23:10:06, the attach at 23:10:26, the registry lines, the stop and
  rollback at 23:15:29, `productionActivated` false and `bootFunding` at block 53,003,826. The same kit's `STATUS.txt` L30 holds
  D's root-final-tests line at 23:02:35Z.
- **S24:** `work/custody-boot-price-activation-20261023/evidence/postrollback-health.json` (23:16:22Z, read-only; untracked): both
  original guests running, `problems` [].
- **S25:** `work/custody-v2-live-20261023/evidence/unsigned-fee-path.json` (23:19:59Z; untracked, in root's live repo):
  `signingDisabled` and `broadcastMethodsDisabled` true; prepared gas 38,772, maxFee 7,000,000, bound 271,404,000,000 wei. Also
  root's `work/custody-boot-price-activation-20261023/ROOT-FEE-EVIDENCE-CORRECTION.txt` (23:25Z), which says 13.2 mwei is a
  suspected cause, not a confirmed actual fee.
- **S26:** `work/custody-boot-price-activation-20261023/FUNDING-MISMATCH-REVIEW.txt` L16-30 (the 13.2 mwei SDK-scenario analysis)
  and `work/custody-boot-registration-20261023/NORMAL-FEE-FIX.md` (9b82acc8 on branch `boot-normal-fee`, source only, NOT built).
  Neither active source was modified.

- **S27:** root's journal `work/resume-after-checkpoint-20261022/ROOT-CONTINUE-LATEST.txt`, last entry (as read 23:51Z), and
  `work/custody-boot-fee-activation-20261023/ROOT-RECOVERY-OBSERVED.txt`, its UPDATE at 23:47 (which supersedes the provisional 23:40
  note). These are the source for the renewals, setProofKey, gate, rollback, health, operator balance and nonce, and the H, M and D
  task status. The tx hashes are also in `work/custody-v2-live-20261023` at 2b0c975b (`evidence/registration-receipt-2341.json`,
  `protected-renewals-2331/`).
- **S28:** `work/custody-v2-live-20261023/evidence/host-reader-preflight.json` (19:43:23Z, commit 574fdc9): the accepted host owner
  for custody is unset. The registry PAYOUT wallet (declared on chain as `0x0b2d…`) is not accepted ownership.
- **S29:** `work/custody-boot-fee-activation-20261023/result.json` (23:43:19Z), `gate.json` (23:43:16Z) and
  `evidence/postrollback-public-health.json` (23:47:01Z). These are root runtime files, git-ignored, with kit head 9d75f953. They hold
  the start and attach times, the setProofKey tx and adoption lines, the gate FAIL reason and rollback times, and the post-rollback
  public health.

## Document originals

- **Checkpoint:** `work/source-checkpoint-20261022/main-repo` at checkpoint dfb4b55e627ebd95b647abebf09627296f099862 holds
  `docs/security/secret-custody-v2.md` 393f9d31 and `secret-custody-v2-spec.md` fee422be.
- **Main:** main 68b82926968c99503d38ae78dbcb04694cc2c56c holds 6e933b8e and ae96f2a4.
- **Dashboard:** the reviewed doc commits 2d3839c54 and 9d97b4b00 (custody-v2-dashboard repo) give de1dce4b.
