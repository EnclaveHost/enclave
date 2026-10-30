# Authorized refund → wallet transfer → session re-funding: deployed-source review

Read-only, October29,2026 America/Phoenix. Human explicitly permits refund/deactivation, then session re-funding. This supersedes the earlier no-interruption/no-refund constraint for this migration. It does not replay old successful payments, change historical transactions, or make an unknown pending outcome safe to retry. Root is the sole financial coordinator. No RPC, signature, financial action, test, build, new author or production edit was performed in this review.

## Current-contract path is possible conditionally; refund alone does not guarantee transfer

Use exact source-verified rev16d ledger and legacy v2 vault below, not the incomplete future wallet-v1 candidate. `refund`1899–1911 first credits proven runner time, reserves `(leaseUntil - creditedUntil) * earn.rate6` when positive, then pays `min(ownerEscrow6, escrow6 - reserved)` if positive. It zeros balance6 and active but leaves runner, runnerOperator, leaseUntil and any reserved escrow attached. `transferDeployment`958–964 still requires ownerEscrow6==0 OR escrow6==0, and caller must be the actual owner, never a delegate.

An expired lease is not sufficient: reserve uses leaseUntil versus creditedUntil, not current time. The comment1367 about an unproven lapse making the tail refundable does not override the actual linked library. Actual runner `release`1168–1188 credits its proven time, clears runner/operator/lease/meter/watermark and removes the future tail reservation. It requires runnerOperator as sender. The normal app-stop path may trigger that release, but off-chain process exit alone is not the on-chain release. Do not fabricate proof or let a new claimant replace the old runner merely to clear the gate.

After a partial first refund, re-read the exact ownerEscrow/earn state. If both remain positive, an actual runner release followed by a second refund can clear the remaining owner-backed escrow. If refund amount is zero it reverts and does not deactivate; use the authorized setActive(false) path when needed. Alternatively, an orderly deactivate → runner release → one refund can avoid the partial-refund transaction, if the real host and current state support it. These are state-dependent sequences, not blind repeated refunds. Preserve each receipt and reconcile before progressing.

## Historical amounts, not quotes or authorization to send these values

Existing two-provider observation at block53263892:

| App | ID prefix | balance6 | ownerEscrow6 | earn escrow6 | refundable6 | cap6/sec | fee6/sec |
|---|---|---:|---:|---:|---:|---:|---:|
| DNS |59f1273d|6415930|4850000|4910724|4799124|14|0|
| KVM |9a28642b|5190014|5055558|5055558|4425558|18|0|

Before any additional credit, these figures imply DNS first-refund residual ownerEscrow50876/earn111600 and KVM630000/630000. Credit performed by the actual refund may reduce the remaining earn escrow, so these are explanatory arithmetic upper values, not predicted post-transaction states. Fresh reads are mandatory for execution. Both historical runners were NucBox operator0x1A01194c34Fe3577C6d0a54feB78af6253e494e0; leases were expired but attached. Actual current state is not established here.

Refund goes to the current ledger owner: historical B794 session vault, NOT directly to the human wallet or a session budget. Exact SessionVault1071 calls the proceeds FREE balance. `refund` does not replenish session.balance6, perPeriod allowance or locked6. Reusing the refunded USDC in a session requires existing owner-authorized topUp724 (within actual constraints), not an automatic `_spend` credit. Owner withdraw778 pays only the fixed wallet. Do not infer that a large vault token balance gives an existing session authority to spend it.

## Transfer and same-ID restoration

The controlling wallet is0x0b2d009c0c9Af05b12100D77F3c815fea822eE61; historical owner vault0xB794C4DD0e1C5E6B72281799F282BfdE7654345D. After the gate clears, existing owner-signed vault.release833 moves the same ID to that wallet and deletes held metadata. Existing session cannot sign that owner operation. Owner direct ownerCall851 can target the exact ledger when the book route differs, but is direct-only, one call, no USDC/own-vault target, no multicall and no ETH forwarding.

Transfer changes only d.owner. AppRef, config, ports, resource shares and ID persist; the explicit refund has already canceled prepaid runtime and active state. Preserve secrets and storage; no new-ID redeploy or secret claimPolicy is required by this source path. Wallet-held records become PROD for existing session authorization, so recheck actual environment/content policy and host access. DNS was historically held STAGING; KVM was promoted PROD. Existing wallet-release UI may impose inactive/no-runner/zero-old-reserve gates beyond the raw contract transfer gate: satisfy or explicitly adapt those gates, not pretend the UI will automatically accept a partial refund.

## Existing legacy session re-funding requirements

Exact v2 SessionVault._dispatch1014–1035 already supports ACT_FUND on an owner-wallet-held row. It checks owner==vault OR owner==fixed wallet, env membership, publisher scope/fee ceiling for a paid wallet-held app, rate cap and runner-rate funding safety, then `_fund`1126 sends vault USDC to ledger.fundFor(id,amount,holder). The holder is now the wallet, so new escrow is attributed to the wallet. ledger.fundFor1006 consumes msg.sender's USDC allowance; it does not debit the attributed payer.

The ledger rejects funding while inactive (`_requireActive`1841). Re-activate before deploy.fund; fund does NOT restart the record. That requires owner authority or existing wallet→funding-vault ledger delegation, plus the session's deploy.setActive bit6 and PROD env bit2. `prepareFund`177 may call delegated setMaxRate to rebase an unleased record to its cap; it rejects cap0, cap above session.maxRateHour6, rate below2*publisherFee, or runnerRate0. A self-host zero-rate attached lease cannot be session-funded by bypassing this check. Clearing the old lease lets the usual cap rebase occur before funding.

Historical no-fee cap ceilings imply at least50400microUSDC/hour for DNS and64800/hour for KVM. New runtime amount is NOT automatically old balance or refund; choose a finite amount within current session.balance6, perPeriod remaining, operation count, maxFee6 and intended recovery budget. ACT_FUND bit1 is required, nonce/lane must be fresh, deadline/live/epoch/attestation restrictions still apply. Re-activate+fund should be serialized with the scheduler to avoid a claim changing the rate between the two operations. There is no session multicall in this deployed v2 execute interface; each successful op incurs its own allowed fee/count.

Existing public history shows wallet→B794 delegation enabled at block53101046 and a known live B794 session4a59ff5d… env3 at53264682; these are historical facts, not fresh funding capacity. The captured known-session result lacks remaining USDC and rate/fee/period ceilings. The newer Nuc funding session0e6374… previously paid gas via action10; that is a separate executor/version, not evidence it can invoke this old v2 deploy.fund route. Root must select the actual existing funded session, verify its deployment/version/fixed wallet/scopes and balance, and avoid treating API-only/budget-zero authority or another vault's free balance as spendable funding. No new grant or top-up was signed here.

## Gas ETH stays in the old owner bucket

Reviewed reserve0x12A3f873041Dec436DaA0085B766a399A6fA3639 keys balances and policy by(id,owner). Historical old balances DNS1052268502151wei/KVM959970768583wei; destination wallet buckets were zero. Ledger refund does not return this ETH; ledger transfer does not move it. After transfer, old vault.ownerCall(reserve,withdraw(id,exactAmount,wallet)) can recover the old bucket under owner authority; reserve.withdraw349 intentionally needs no current ledger-owner read. Current release sponsorship may consume some before recovery, so never use stale withdraw amounts.

New wallet reserve configure325 and setClaimant341 require the new owner, and deposit302 credits that current owner. Depositing without configuration/claimant authority is not sufficient. No method copies old spend/cooldown counters: retain the actual finite budget rather than treating fresh bucket counters as new spending authority. Existing gas-funding adapters/grants must match current owner, ledger, reserve/controller and scope; old-target signature permission is not automatic new-target authority. Runtime re-funding and gas reserve restoration are distinct effects; funded runtime alone does not prove a host can claim or submit lifecycle transactions.

## Minimum fresh evidence for root's execution

At one consistent block: exact code/factory/implementation/book/ledger identities, row+cap+fee, earn and ownerEscrow/refundable, provenUntil/proof requirement, runner identity/lease and serving state; old/new reserve balances/policy/claimants/counters; actual session deployment/domain, live/epoch/expiry, fixed owner, action/env/apps, budget and per-period limits, lane nonce, attestation and delegation. Simulate each exact call against fresh state; reconcile refund/release/transfer/reactivation/fund/deposit receipts separately; then verify wallet owner, runtime/reserve/host assignment and real serving. Prior successful recovery payments remain non-repeatable. Root owns these live steps.
