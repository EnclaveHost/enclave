# Custody v2 production verification

**Updated October 24, 2026, 01:22 UTC. The rollout is incomplete.** The CPU/RAM share correction is complete, but custody v2 is still a single-seat bootstrap. No production canary secret lifecycle has passed, and no real deployment's secrets have been migrated.

## What is actually in production

The October14 custodian remains running with the original image, measurement and sealed state. Two Base providers agreed at block53,005,325 (00:00:23UTC) that the original vault's bytecode is unchanged, the known committee remains epoch1 with one machine and threshold1, and `secretVaultV2`, `secretVault` and `hostOwnership` address-book entries remain unset. A fresh challenge-bound AMD SNP quote passed at00:00:27. This proves the observed image/identity binding; it is not a successful secret-release test.

The committee is `0x47742ae8c544ff66a4ad91cfbf5cecdd389013da362813ba3b55c4e247b0f7a3` in vault `0xE48699B8401564aaCe7A814AE4569b67a3F7eEF5`. Its only custodian is Enclave-operated. **This is not decentralized custody.** Accepted ownership of metal0 in the custody ownership registry is still zero; the registry's admin payout address is a different fact.

The October14 deployment narrative therefore does not establish current rollout readiness. Live configuration, discovery, owner enrollment and lifecycle evidence remain incomplete. Administrative contract controls are preserved; no existing contract has been rewritten for this rollout.

## Evidence and test coverage

| Area | Evidence | Current conclusion |
|---|---|---|
| CPU/RAM shares | Production verification19:41UTC: nine NucBox apps and18 TLS routes | Complete; separate from custody |
| Original custody deployment | Service/image metadata, fresh two-provider state and fresh AMD quote | Original service remains present and attested |
| Corrected custodian | Two identical builds of source `ab589bf8`; real SNP startup, storage503 outage and reopen tests20:14–20:16UTC | Startup/recovery tested; corrected image not activated as a production committee |
| Secret creation and value consumption | Dedicated HMAC proof app and driver source prepared | **Not run end to end on production SNP** |
| Legacy migration and active-copy removal | Relay inventory found37 encrypted records; historical canary absent | Inventory only; **new migration and deletion proof not run** |
| Secret rotation | Source tests/preparation | **Production canary not run** |
| Attestation-gated release and unauthorized rejection | Reviewed binding path and source tests | **Production recipient/rejection matrix not run** |
| Lifecycle outages and restart recovery | Custodian startup503/reopen test passed | **Secret-bearing lifecycle outage/restart tests not run** |
| Rollback protection | Source review identified missing hardware monotonic protection | **No protection claim; production negative tests pending** |
| Dashboard and address book | Dashboard code/site package and guarded signing helpers prepared | **Not published/activated** |

The separate [SNP startup result](custody-v2-snp-startup-recovery-20261023.json) and [CPU/RAM production result](nucbox-coupled-shares-production-20261023.json) retain their narrower scopes. Historical investigation details remain in [the evidence chronology](custody-v2-verification-history-20261023.md).

## Control recovery affecting rollout

The latest candidate control registered and adopted the original image-generator and EyesOff VMs, but its operational gate failed on a dropped EyesOff HTTP connection and automatically rolled back. The old control is unregistered again and lacks sufficient ETH for normal registration. Both original tenant VMs remained running; strict HTTPS app health passed again at2026-10-24T01:05:42.263364+00:00. See [the fresh public-health receipt](custody-protected-health-20261024.json).

A temporary keeper has renewed both app-funded leases using the existing executor/reserve path. Its outer cutoff is **03:53:51UTC /20:53:51 Arizona on October23**, with a maximum of eight renewals per app. That cap can be reached earlier; the cutoff is not a guarantee that leases remain protected until then. It is temporary incident protection, not completed control recovery. Its [initial public receipt](custody-temporary-lease-protection-20261023.json) records its exact scope. Root must maintain protection until normal control renewals are confirmed.

The existing delegated operator account rejects ordinary ETH transfers. [A bounded standard EIP-7702 maintenance proposal](operator-maintenance-proposal-20261024.md) is prepared, locally tested and awaiting approval. No delegation or funding change has happened. The new control recovery kit must fund both candidate and rollback registration, preserve the same guests, pass the full health window and fresh attestation, and attribute normal renewals to verified receipts before being kept.

The reproduced SDK fee difference was a possible cause of an earlier startup failure, not a measured production fee. The successful candidate's actual proof-key transaction used gas38,393 at6mwei effective. The later rollback was caused by the health gate.

## Rollout path and signing authority

1. Complete operator funding/control recovery, while preserving tenant VMs. The prepared funding operation needs approval to use0.000005ETH from the canary submitter plus at most0.000002ETH fees and temporarily clear/restore the existing delegation. Operational keys are already available; this step does not need MetaMask signing.
2. The operator proposes metal0's existing administrator as custody host owner. **The administrator must sign acceptance.** No ownership is inferred from the payout wallet.
3. Launch the corrected SNP custodian beside the original service, with verified public HTTPS ingress, and create a **new committee in the existing vault**. The original custodian lacks the code-approval signing route needed to admit corrected code into its committee; merely waiting seven days cannot repair that.
4. Complete the dedicated canary app publication and adequate test funding. The existing factory-only signing page (`http://127.0.0.1:39672`) and canary upload/catalog page (`http://127.0.0.1:39675`) remain unsigned. The full canary budget exceeds the current test wallet balance; the requested0.0001ETH Base top-up to `0x29479Bf04ED889D46a7AfB7f292B9Bb26e12647C` remains outstanding.
5. Run the complete creation, migration, rotation, release/rejection, outage, restart and rollback matrix with dedicated random canaries. Confirm app consumption through HMAC proofs, inspect relay surfaces only for those markers, and verify deletion of the old active record after successful migration. Do not use existing deployment secrets.
6. Recheck affected consumers; then obtain **administrator signatures for final address-book activation** and publish the verified dashboard. Owners authorize their own policy migrations. Existing policies and original custody remain available until that happens.

The prepared website must also reconcile IPNS publisher recovery before publication: the public record was at sequence1026, while the local publisher reported sequence0/empty state. Publishing or rolling back with an older sequence is not acceptable.

## Remaining security limitations

- One seat with threshold1 gives that custodian the decryption capability. More replicas operated under the same authority do not establish decentralized custody.
- The reviewed corrected release gate binds the recipient encryption key, deployment/app identity, policy and secret revisions, committee epoch and fresh challenge to AMD-rooted SNP evidence. The registry proof key is not the secret-release gate. Production validation remains pending.
- The recipient accepts a relay-provided custody pointer without independently verifying it against the chain. A malicious relay could substitute a fabricated committee/bundle/configuration and inject attacker-chosen values. This does not establish access to the owner's genuine values, but prevents a full end-to-end value-integrity claim.
- Sealed-state rollback and a malicious missing-state response are not prevented by a hardware monotonic counter. In-memory high-water marks do not supply restart-safe rollback protection.
- Public RPC providers, host/custodian availability and attested-machine admission remain dependencies. Two-provider agreement is not a light client.
- **Relay plaintext exclusion has not yet been proven in the requested production tests.** Removing the active legacy record cannot erase past plaintext, external copies or retained backups. Canary rotation also does not prove that external real credentials were revoked.

## Rollback procedures

Preserve old images, measurements, policies and sealed state. A failed control cutover stops the new control, waits out outstanding sponsored lease deadlines, restores only the reviewed configuration change and re-registers the previous control; that requires its own gas budget. Do not restart independent tenant VMs as a recovery shortcut.

Do not overwrite newer sealed state with an old blob or start older software against it without tested compatibility. Once policies depend on `sessionVaultFactory`, unsetting it can strand ownership resolution. Reversing a committee migration requires a new owner-authorized policy update with a freshly encrypted bundle; it is not a file restore. Keep revisions monotonic and externally rotated credentials rotated. A site rollback requires a newly signed IPNS record with a higher sequence.

Source and public evidence are being preserved on `checkpoint/decentralization-20261022`; main is unchanged. Raw hardware quotes, chip identifiers, signatures, private journals, keys and canary values are excluded. Claude reached its current weekly limit during preparation; unfinished source is explicitly marked and is not deployed.

## Offline harness correction, October24 01:08UTC

Root corrected several evidence defects in the unfinished r2 canary harness: committee selection is bound to the freshly read committee key; only the dedicated old-to-new migration source can select committee4774; empty searches and incomplete protected-policy snapshots cannot pass; rollback cannot be recorded as an observed expected failure without evidence that the older blob reopened under the same identity. Log checks bind the deployment, recipient endpoint and custodian key prefix, and do not persist raw peer log lines. A fresh random HMAC challenge checks the app consumed the exact current canary values, rejects the previous revision, and sends no canary values to the endpoint. Successful journal entries now require their prerequisites in order.

Offline validation: **43 tests passed; one rollback-protection property remains an explicit expected-failure TODO; 12 deliberately broken variants were detected.** The initial full run found a missing copied proposal file, restored from the baseline Git object before the successful rerun. No production signing, custody mutation or secret lifecycle test occurred. The driver remains unfinished: genesis/host and launch verification, outage/committee-migration handlers and full CLI integration still need completion. These test results must not be described as production SNP evidence.

Source commit: `285f2b5cc736f3600f73b357696f22e9d4235404`. The prior checkpoint `05f5de1ad4980fe5797947ccfcaa05869e4080d1` was independently verified on GitHub with302 manifest entries; this continuation is being appended separately. The maintenance approval remains unanswered; no wallet delegation or funds have changed.

## Genesis verification and live host authority, October24 01:22UTC

[Fresh read-only host evidence](custody-host-authority-20261024.json), at Base block53007638, confirms that metal0 is active and its payout is the administrator, but accepted custody ownership remains zero. No enrollment or wallet change was made.

Source `e00cb682612d86abac93ddbf9fded2cd266eb3dc` now includes a read-only committee-creation verifier: original vault bytecode/book/admin pins; two-provider agreement on canonical confirmed calldata and events; ID derivation; exact supplied attested-machine/key binding; single-seat epoch1 state; current accepted host authority; r2 code active at genesis with old code absent; canonical inclusion rechecked after state reads. It does not replace fresh SNP quote verification and is not yet wired into an executable production launch. Calldata signatures and chip identifiers are not returned in its evidence.

The full offline suite now has **52 passing tests and one explicit rollback-protection TODO**;20 deliberately broken guard variants were detected. These supersede the narrower counts above and remain offline results.

A further launch issue was found in the existing host helper: its `/submit` path uses `wallet.writeContract` without this canary driver's fee/journal controls. Do not give the new canary launcher a funded submitter until a bounded intent-capture/sending path is implemented. The guest already persists and reconciles the same genesis intent after refused submission, so this can be addressed in the untrusted host tooling without changing the measured guest or original service. Operator maintenance approval, admin enrollment, catalog/factory and address-book signatures remain pending.
