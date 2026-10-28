# Unified platform funding

Status: required for decentralized payment rollout; specification only, not deployed.
User requirement recorded October 28, 2026: ETH, USDC, and compute credit must fund platform operations interchangeably. The platform must handle settlement currency rather than require users to maintain separate compute and gas balances.

## User-visible contract

A user authorizes a dollar-denominated platform budget and eligible funding sources. Compute, storage, publication, and necessary platform transaction gas consume that budget within the authorized scope. A funded session must not ask for a manual ETH top-up merely because its authorized value is held as USDC or usable platform credit. Show the total price, conversion costs, and remaining budget before authorization; automatic replenishment stays inside signed total, period, per-operation, and fee limits. Never silently increase those limits.

The dashboard may expose settlement details for inspection, but the normal operation is a single funding action. Existing deployments and administrator controls must survive migration. Failure of one quote provider or relayer must not make a particular operator a required payment intermediary.

## Current source findings

- `contracts/EnclaveDeployments.sol::fundEth` values ETH through an oracle, increases the dollar-denominated ledger balance, and forwards ETH to payout. It does not swap ETH into USDC; its comments explicitly exclude that funding from USDC runner escrow.
- The newer lease reserve source at `work/enclave/contracts/EnclaveLeaseGasReserve.sol` (outside this checkout) accepts native ETH. `depositAndFundCompute` splits incoming ETH between that reserve and ledger accounting credit; it does not supply USDC-to-ETH conversion.
- `contracts/SessionVault.sol` holds USDC and dispatches enumerated actions. Its current session dispatch has no asset-swap or gas-reserve funding action. The owner's restricted `ownerCall` does not grant sessions arbitrary calls.
- `contracts/EnclaveCreditVault.sol` represents closed-loop service credit with constrained outflows. Existing deployment `balance6`, vault-held USDC, runner escrow, and available session budget are different claims; adding them together would double-count value.

These are inspected-source findings, not a complete bytecode inventory of every deployed contract. Before migration, pin live chain, factory, implementation, address-book, token and reserve identities and reconcile them to source.

## Required settlement paths

| Funding source | Platform compute / service settlement | Lease gas settlement |
| --- | --- | --- |
| ETH | Quote and convert into the asset that actually backs the service liability and runner payment; do not just mint accounting credit | Deposit the required ETH under the current deployment owner and policy |
| USDC | Use authorized USDC funding with correct owner and refund accounting | Purchase an exact required ETH amount with a maximum USDC input, then deposit it atomically |
| Eligible compute credit | Debit the authenticated credit balance once for service consumption | Atomically retire the credit liability and supply ETH from explicitly backed settlement liquidity |

Quotes must account for actual asset prices and units. A dollar of service entitlement remains a dollar of service entitlement; ETH price movement, USDC price deviations, exchange costs, and transaction costs cannot be hidden by pretending token units are dollars. Do not charge a user twice when converting already-purchased credit. Existing promotional or otherwise unbacked credit needs explicit platform backing before it can settle external gas costs; a ledger number alone cannot manufacture ETH.

All unused swap input remains attributable to its original owner/source. Refunds must reverse the appropriate liability and retain source restrictions; conversion must not create an arbitrary cash-withdrawal capability for closed-loop credit.

## Execution and authorization

Introduce a typed funding intent binding chain ID, funding contract/version, owner, deployment, session or credit account, source asset, maximum source input, exact required outputs, maximum total dollar debit, conversion/relayer fee ceilings, nonce, expiry and allowed settlement route. No arbitrary target/calldata or unrestricted token allowance is accepted from a quote service.

The session policy must explicitly authorize gas funding and conversion. Charge actual source debit and permitted fees against session limits atomically, including the period and total budget. Do not reinterpret old grants as authorization for a new action. Existing immutable vaults require a compatible successor or explicitly signed new authority; retain the old deployment ownership and recovery paths until migration is proven.

A permissionless relayer or liquidity provider can front the transaction's ETH and be reimbursed only after successful settlement under the signed fee cap. This addresses the first-transaction gas problem for a user holding only USDC. Allow multiple independent submitters and verifiable quotes, bounded by on-chain execution and price limits. If liquidity, a route, or a price bound is unavailable, fail without debiting the user, show the specific failure, and try other authorized providers within the intent. Do not fall back to unlimited slippage or a discretionary administrator transfer.

Actual asset movement, credit retirement, budget accounting, exact gas-reserve ownership, and settlement must succeed together or revert together. Guard replay, reentrancy, stale quotes, incorrect assets/decimals, deployment transfers, callback behavior, dust, rounding, expired sessions and quote manipulation. Bind deposits to the expected owner and revert if ownership changes before execution. Preserve existing reserve sponsorship caps and policies.

## Rollout and acceptance gates

1. Reconcile deployed bytecode and source; inventory current credit backing, permissions and liabilities. Identify any existing conversion implementation before adding another.
2. Implement and test the USDC-session-to-lease-gas path, with actual exact-output conversion and bounded reimbursement. Include the initial transaction when the user's wallet has zero ETH.
3. Implement ETH-to-backed-service settlement and atomic credit-to-gas settlement. Migrate existing credit liabilities without losing value, minting duplicate credit, or counting spent/refundable escrow twice.
4. Integrate the same funding intent and status model into browser, CLI, session automation and dashboard. Self-hosted rate-zero deployments need gas but no extra compute credit merely to claim a lease.
5. Exercise every source/destination route on a fork and then dedicated production canaries: conservation, insufficient liquidity, quote expiry, slippage, wrong chain/token/owner, ownership transfer, duplicate submissions, concurrent relayers, budget exhaustion, failed swaps, partial failures, refund restrictions, provider outages, restart recovery and rollback.
6. Verify gas reserve replenishment and successful claim/renewal from a USDC-only authorized session. Verify equivalent service entitlement from ETH and backed credit, net of disclosed costs. Measure fees and preserve transaction receipts and reconciliation evidence.
7. Review migration and deployment transactions before requesting administrator signatures or new user grants. Keep old routes usable through staged rollout and document how to stop new intents without stranding existing assets or disabling applications.

Completion requires all routes working end to end with independent submission and no manual currency management inside an authorized budget. A planner, mock swap, successful quote, accounting-only credit, or a new contract without activated session/dashboard support does not satisfy this requirement.
