# Wallet migration: actual authority and a scoped custody fence

Read-only source review, October 29, 2026. No author rerun, tests, build, chain reads, signatures, promotion, policy mutation or migration. Historical deployed ledger/vault sources are pinned; current host/relay source is not proof of installed behavior. Root's later observations are inputs for qualification, not finality or a complete session census.

## Actual consequences, rather than an unconditional staging blocker

The frozen release author is incomplete and unvalidated. Its `ROOT_QUALIFIED_CONTINUITY` is empty and staging is independently hard-blocked, so adding a continuity entry alone cannot enable a staging row. That is conservative UI behavior, not proof that every staging transfer expands authority. Do not claim the candidate completes migration.

The exact legacy vault `_requireHeldEnv` at 1104 uses held.env when nonzero; for held.env=0 it requires ledger owner == the vault's controlling wallet and assigns PROD=2. It then checks the grant environment mask. Thus, for each existing live session:

| Before env | Grant env mask | After wallet ownership, with delegation | Consequence |
|---|---|---|---|
| STAGING=1 | staging only=1 | denied | Narrows access |
| STAGING=1 | prod only=2 | may become allowed | Potential expansion; action-specific review required |
| STAGING=1 | both=3 | still allowed for common actions | Environment gate alone does not expand this session |
| PROD=2 | prod or both | common action environment unchanged | Other custody/content gates still need review |

At vault dispatch 1037–1050, `setAppRef` and `setConfig` require STAGING. Wallet-owned rows therefore **lose** those session mutation permissions. `setShares`, `setActive` and `refund` still require the environment plus grant action bit; `setMaxRate` additionally takes the stricter production branch. `fund` has holder/environment and rate checks, and wallet-held fee-bearing records receive an additional app-list/fee-ceiling check (1013–1034). A positive balance does not itself prevent ownership transfer.

Do not assume every deployment action is gated by grant apps: `_requireApp` is used for create/setAppRef/publish paths; common existing-record actions are not uniformly app-list gated. The host verifier returns apps/anyApp but `refusal` at session-api-auth.mjs:346–369 checks holder/environment/delegation, not app-list membership. Route action-scope checks remain separate. A claim of preserved eight-app scope needs the actual consumer, not merely the grant's apps array.

Root's block53264682 observation of the live API grant (envs3, anyApp true) does not establish environment broadening for that particular grant. It also does not prove equivalence for all grants. A complete review needs all live grants of the source vault and every other vault/delegate that can reach the wallet's records, with actions, envs, expiry/epoch, app constraints actually enforced, budgets and API route behavior. A different delegated vault whose prod sessions could not reach the original source-vault-owned record may gain access after the transfer. Ledger delegation is owner-wide, not per deployment (rev16d:558–571).

## Secret/content release is a separate predicate

Relay sessions.mjs:1180–1216 `custodyRefusal` refuses unadopted known-vault rows; for PROD it requires `promoted == keccak(abi.encode(appRef,configCid))`. STAGING has no promoted-content comparison. Plain wallet rows pass this custody predicate.

Therefore:

* STAGING -> wallet does not by itself remove a promotion requirement from this predicate: staging did not have one. Combined with session setAppRef/setConfig becoming forbidden, this can narrow content-mutation authority. Other grants/delegates still require qualification.
* Unpromoted PROD -> wallet removes a real refusal at this predicate. This is a concrete concern for cab8fb59 (root says env2/unpromoted), separate from its escrow-clear9.5USDC balance. Inactivity prevents current serving but is not a durable equivalent approval gate once an authorized principal can reactivate it.
* Promoted PROD -> wallet removes the stored promotion comparison. For the current unchanged content that comparison already passes, but future authorized mutation paths and independent content controls decide whether authority is preserved.

This predicate is called before legacy plaintext release in relay/secrets.js:393, attested release in secrets-release.mjs:442, and Shield release in shield-secrets.mjs:31. Further lease/eligibility/attestation/custody checks still apply. Neither attestation of what runs nor a generic allowed app image automatically substitutes for owner approval of the exact appRef/config pair.

Both address-book secret keys being zero is not absence-of-secrets or absence-of-policy proof. Legacy relay storage, explicit CUSTODY_VAULT/backend configuration and independent policy paths exist. Qualify installed paths using public configuration identity/code/policy hashes and metadata only: active backend(s), per-app bundle presence/revision, paused/release status, beneficial-owner mapping, exact content/deployment authorization, and every fallback path. Do not read secret values or call destructive claimPolicy. For an unpromoted PROD row, an independently enforced equivalent refusal on every actual release route could prove non-expansion; absent that evidence, it remains unresolved.

## Proposed ownerCall self-transfer: source-supported but limited

`vault.ownerCall(actualLedger, transferDeployment(id, vault))` is permitted by the reviewed source when invoked directly by the actual vault owner and the transfer escrow OR gate passes. Ledger958–964 permits equal nonzero from/to. It sets the same owner and emits DeploymentTransferred; it does not change balance, config, active, lease or reserve state. Vault851–861 then deletes held[id] for the transfer selector. This is not a refund or a new deployment.

While ledger owner remains this vault and held.env==0:

* Every existing-deployment session dispatch action in this vault reaches `_requireHeldEnv` and reverts NotHeld. CREATE cannot overwrite the existing id/held slot, and PUBLISH is a separate catalog action, not a bypass to this record. Signed session calls not yet executed are gated at execution; they are not cancelled and may become executable later.
* Host session refusal rejects unadopted vault records. Windows host.mjs:675–697 uses fresh reads for restart; supervisor.js:5190–5221 requests fresh chain policy for non-GET mutations. Verify the installed versions and all actual routes. Already-authorized requests, cached GETs, existing connections and work after a checked await are not revoked by the chain transaction.
* Relay custodyRefusal rejects secret release for an unadopted known vault. Already-issued tickets are rechecked in the reviewed attested path, but already-delivered secrets cannot be recalled.

This is a **per-app fence for this vault's session and custody paths**, not a complete writer lock. Remaining qualifications and bypasses:

1. Any ledger delegate granted by the VAULT can call owner-gated setters directly, bypassing held. Review DelegateSet history plus fresh storage for every candidate, not merely the wallet->vault delegation bit. A delegate cannot transfer, but can reactivate/configure/refund. The direct vault owner can still ownerCall, and previously signed valid owner operations can adopt/promote/release. Book/admin and outstanding owner-operation coordination remain necessary.
2. Verify inactive, no attached runner/operator/lease and escrow eligibility immediately after the fence, then before final release. Self-transfer itself does not enforce inactive/no lease. A writer can win before the fence; verify resulting state instead of assuming the preflight survived.
3. While truly inactive and unleased, ordinary fund/fundFor/fundWithAuthorization/fundEth/fundEscrow and claim paths refuse; bandwidth charge also requires active+live lease+runner (ledger1953–1960), and settle has no runner credit. This narrows the earlier generic bandwidth warning: bandwidth is not an independent mutator of a proven inactive/unleased row unless another writer reactivates it.
4. Anyone may still deposit into the old-owner gas reserve even while inactive (reserve302–306). The owner can change reserve policy, and the self-transfer does not lock the book or reserve. A preflight is not an atomic zero-old-reserve assertion at final release inclusion.
5. The fence ends when the actual owner becomes the wallet: held0 plus wallet owner is the normal PROD fallback, so permitted session calls can work again. Pending calls may execute then. It is not a post-migration deny rule, and does not solve the actual permission-equivalence question.
6. Exact rollback of original held metadata is not a single existing call. `adopt` calls `_setEnv`, which clears promoted and leaves createdBy zero after deletion; `promote` can rebuild a reviewed production commitment but cannot restore original createdBy. Persist original held state and receipts as evidence, but do not call that an exact on-chain rollback. No action authorized here.

## What is actually missing

There is no universally missing environment primitive for every staging row: a complete grant/delegate/consumer census can establish equivalence or narrowing with current code. The candidate's unconditional staging refusal should not be treated as a protocol theorem.

For unpromoted PROD with no independently verified substitute, the missing guarantee is durable owner-approved content enforcement after wallet transfer on the installed release paths. For exact atomic state/reserve preservation, deployed release and transfer lack expected-state/old-reserve assertions. The temporary custody fence helps against one writer class but cannot remove permissionless reserve deposits or all owner/admin changes. A client or relay preflight alone cannot provide that atomic guarantee.

Root should qualify each inactive app separately using these predicates. None of this authorizes self-transfer, promotion, delegation changes, refund, new spending, app restarts or migration of the escrow-blocked DNS/KVM deployments.
