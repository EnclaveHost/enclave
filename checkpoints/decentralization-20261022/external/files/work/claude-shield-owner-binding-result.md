# F2 fixed: the Shield custody report binds the ledger owner; authorization stays with the beneficial owner

Repository: `wo/work/enclave` (main working tree). Nothing was committed. No Windows manager, node, startup or Go file was
edited.

## The defect

For a deployment owned through a session vault, two owners differ:

- the ledger row's owner is the vault contract;
- `EnclaveSecretVaultV2.beneficialOwnerOf(id)`, which the custodian requires to equal `policy.owner`, is the vault's human
  owner.

The two sides bound different ones:

- The Shield-direct guest binds the **ledger** owner its own quorum reads (`shield_direct_custody.go`:
  `ShieldReleaseInput(binding, auth.NameGrant().Owner)`).
- The custodian passed `pol.owner` to the Shield verifier.

So every Shield custody release for a vault-owned deployment was refused with
`evidence_refused: guest binding differs from verifier request`. It failed closed.

## The fix (`custody/v2/custodian.mjs`, one argument)

The Shield verifier now receives `owner: s.lease.owner`. That is the ledger row owner from the custodian's own agreed
release read (`custody/v2/chain.mjs readReleaseAt`), the same value the guest binds.

Unchanged:

- **Policy authorization.** Step 6 still refuses unless `beneficialOwnerOf(id) === policy.owner` (`owner_mismatch`), before
  any evidence is looked at.
- **The bound fields.** The report still binds vault, deployment, revisions, committee, epoch, every challenge, the
  RuntimeID, the transport key, the recipient key R and the AppID. Only the owner component is now the ledger owner.
- **The SNP path.** The SNP verifier receives exactly its previous arguments (pinned by an existing test), and SNP evidence
  carries no owner.

## Regressions (`test/shield-custody.test.mjs`; the former `todo` is now an active test)

"session-vault owner: the report binds the ledger owner, the policy is still authorized by the beneficial owner":

- **Ledger owner bound.** Ledger owner is a session vault, beneficial owner equals the policy owner, and the report binds
  the vault. The release succeeds, and only the guest's R opens the owner's values (DLEQ-verified, combined, decrypted).
- **Wrong ledger owner refused.** In the same state, a report binding any other owner is `evidence_refused` at the binding:
  the beneficial/policy owner, another vault, or a stranger.
- **Policy authorization preserved.** A beneficial owner that is no longer the policy owner is `owner_mismatch`, even with
  the ledger owner bound exactly.
- **EOA unchanged.** Ledger, beneficial and policy owner are one address, and that release succeeds.

Mutation check: with the old argument (`pol.owner`) restored, this test fails (6 pass, 1 fail). With the fix it passes.

Runs (single job): `test/shield-custody.test.mjs` 7/7. `custody-v2-protocol`, `custody-vectors`,
`custody-v2-release-authority` and `shield-dns-challenge` 19/19.

## Not claimed

No activation. The custodian daemon adapter and routes (via `code-approve`), the 9445 custody-authorization transport,
`supports.custodyV2`, the measured Shield-direct image and any hardware or live release all remain pending. A vault-owned
deployment additionally needs its owner policy written with the Shield acknowledgement by the beneficial owner.
