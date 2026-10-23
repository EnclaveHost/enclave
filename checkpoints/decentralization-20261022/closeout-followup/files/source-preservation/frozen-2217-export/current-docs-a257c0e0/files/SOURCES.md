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

## Document originals

- **Checkpoint:** `work/source-checkpoint-20261022/main-repo` at checkpoint dfb4b55e627ebd95b647abebf09627296f099862 holds
  `docs/security/secret-custody-v2.md` 393f9d31 and `secret-custody-v2-spec.md` fee422be.
- **Main:** main 68b82926968c99503d38ae78dbcb04694cc2c56c holds 6e933b8e and ae96f2a4.
- **Dashboard:** the reviewed doc commits 2d3839c54 and 9d97b4b00 (custody-v2-dashboard repo) give de1dce4b.
