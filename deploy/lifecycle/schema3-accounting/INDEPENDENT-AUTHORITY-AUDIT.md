# Remaining independent-profile authority gaps

This is an audit of the staged schema-3 source, not a production change or a
claim of independent-profile completion. Retirement is metadata-only here;
legacy deployed retirement remains unchanged.

| Surface | Current authority/effect | Qualification still required |
| --- | --- | --- |
| `_hostRate`, `lifecycleOperator`, `lifecycleFunded` | Registry active/operator/proof key; payoutWallet compared through pinned selfHostingIdentity | Accepted EnclaveHostOwnership must supply host ownership. Payout routing is not ownership consent. Registry writer authority and bootstrap must be paired and authenticated. |
| `setClaimBond`, `slashBond` | Ledger admin can change future admission bond and slash escrow | Independent host consent/pinned terms; do not silently delete collateral enforcement. |
| `setProofRequiredFrom` | Ledger admin can change current payment proof rules | Immutable/consented profile including initial proof cutover. |
| Prover `setProofWindow` | Prover admin bounded by immutable maximum, but current window mutable | Explicitly consented proof economics; current bounds alone do not settle policy. |
| `setEthUsdFeed` | Ledger admin can replace price feed/disable ETH funding | Fixed authenticated feed/profile; preserve USDC and price safety. |
| `setPayout` | Admin can change destination for future platform component | Consented economic routing; no right to host/app ownership from payout. |
| `setRunnerBps` | Admin changes future create/resize/start snapshots | Fixed or expressly consented rate split. Existing accounting snapshots must be conserved. |
| `setMaxGpuMilli`, `setMaxFee` | Future-create/resize limits | Resource policy cannot become unconsented global platform veto. |
| `bindLifecycle`, `setFeeRouter`, `setProver` | One-shot bindings, some empty initial values allowed | Authenticate exact code/schema/profile and seal deployment; cannot rely on mutable global book. |
| `importDeployments`, `importFees`, `importEarn`, `importCaps`, `sealImports` | Admin import window, then permanently sealed | Exact authenticated migration snapshot, owner authorization, old runner cleared, escrow backing; no fabricated credits or duplicate funding. |
| `setOwner`/`acceptOwnership`, prover two-step owner | Admin authority transfers | Transfer does not remove remaining global powers. |
| Deployment owner/delegate mutators | Actual owner controls caps, cancel/refund, upgrades, shares | Preserve these rights and pending settlement protections. |
| Emergency quorum and reimbursements | Owner-enrolled quorum, bounded execution-gas pull reimbursement | Independent sender wired; Base L1 residual remains unpriced/unreserved, not fully funded. |

The registry's accepted ownership authority, production adapter profile, host
capacity test, sponsorship qualification, and live Base positive authority are
separate coordinator work. No broad financial rewrite is hidden in size work.
