# Paid capacity verification

Status: pricing component implemented and unit-tested; scheduling, contracts and production rollout remain incomplete. No audit spending is enabled.

## Current direction: transparent tests and supply/demand pricing

The user subsequently accepted that verification jobs may be recognizable and requested that their price rise with paid customer demand relative to qualified supply, falling when supply exceeds demand. The historical concealment discussion below records why absolute indistinguishability was not adopted. It is no longer a rollout requirement.

`availability/pricing.mjs` implements a deterministic quote for a fixed-duration job. The inputs are comparable resource-seconds within one resource/isolation class and one time window, not host counts. Demand must come from real customer work; verification-generated demand is excluded. Supply is the total recently qualified capacity, including capacity occupied by customer work. Separately, a job can only be offered against spare capacity. Otherwise useful customer work shrinking the idle pool would artificially inflate the scarcity signal.

The initial configurable curve is `anchorRate * (paidDemand / qualifiedSupply)^2`, bounded by explicit multiplier and payer price limits. At demand/supply 0.5 the unconstrained multiplier is 0.25; at 1 it is 1; at 2 it is 4. These are a policy shape, not deployed dollar prices. The anchor gives the ratio a currency value and must be agreed for each comparable resource class; a dimensionless demand/supply ratio cannot determine dollars on its own. The minimum multiplier permits a small offer under low demand only when an already-authorized budget exists. Zero budget or no qualified spare resources produces no offer.

Quotes enforce observation freshness, duration bounds, host minimum acceptance, payer maximum rate, per-job spend and remaining authorized budget. Epoch ordering and elapsed-time price-change limits stop repeated reads from ratcheting prices. Each quote expires and fixes the rate for its purchased interval. Policy changes cannot reprice existing leases. A host can decline; a lower verification offer is a separate voluntarily accepted purchase, not unilateral underpayment of its customer tariff.

This is not a finished economic mechanism. The demand/supply aggregator must exclude wash demand, duplicate capacity and stale evidence, distinguish resource classes, normalize protected execution performance, and resist short-term supply withholding. Queued demand must be backed by real purchasing authority and bounded so cheap queue spam cannot raise rewards. Customer work has priority; refusing compatible work must not generate replacement audit allocations. Reward spending is limited by actual customer revenue, so scarcity cannot create an unfunded promise. Thin-market anchors, observation windows, smoothing, revenue percentage and daily caps remain explicit configuration decisions.

Validation: ten pricing tests cover scarcity response, extreme demand, funding limits, host minimums, stale and out-of-order observations, disabled policy, rate-change limits, malformed inputs and monotonic demand/supply sweeps. No live customer funds were spent.

## Requirement

A host must not be able to give preferential service to verification work over customer work. Both must use the same scheduling, isolation, resource limits, networking, billing and proof-of-time paths, and successful work must earn the usual hosting payment. Revenue-derived funding is authorized by the paying wallet, not a shared reserve.

The initial companion-contract prototype is not suitable for a claim that audits are impossible to recognize. Its funding transactions identify sponsored deployments, and distinct application binaries, configuration, request patterns and funding accounts can reveal synthetic tests. Keeping an audit flag out of the deployment record alone does not fix this.

## Two architectures that remove advance selection

1. Verify every ordinary paid job. There is no distinct audit population to recognize. Verification cost must be supported by the application's verification method and payment budget. A generic program does not automatically have cheap verification; attestation proves a specific trust boundary and is not itself proof of output correctness or idle capacity.
2. Commit ordinary job results and execution evidence, then select completed jobs using fresh independent randomness. Selection cannot be computed from a public job ID, predictable timestamp, disclosed seed, or host-controlled input before execution. Commitments must be fixed before randomness is available, with enforceable deadlines and no ability to discard losing outcomes, retry identities or selectively omit jobs. The randomness source, its manipulation resistance, finality and outage behavior must be specified before deployment. This establishes a conditional guarantee about selection before commitment, not absolute invisibility across all side channels.

Neither design relies on making a specially recognizable synthetic benchmark look ordinary. Both need a complete, attributable job ledger so a host cannot report only its successful jobs. A completion commitment must bind chain/contract, deployment and lease, job identity, execution image, input/output commitments, allocated resources and measurement interval. Private contents require explicit authorization and protected verifier execution; publishing hashes or granting a verifier access must not silently weaken app privacy.

## What capacity results mean

Observed performance substantiates the resources and interval actually exercised. A small successful request is not proof of the entire advertised RAM, VRAM, CPU or concurrent job capacity. Independently witnessed completion latency includes network and queue delays; a host-provided timer alone is not reliable. Concurrent reservations and overlap must be checked before aggregating capacity. On Shield hardware, successful computation does not establish exclusive ownership of a physical GPU or prevent all outsourcing.

Idle capacity has no real workload to sample. It must either receive real paid work, run additionally funded work whose observability must be analyzed, or remain unverified for the idle period. Neither post-completion selection nor universal verification justifies an availability payment based only on a host's online claim.

## Payments and rollout constraints

Keep successful host payouts on the ordinary proof-of-time path. Funding limits must be based on newly credited paid service, never advertised capacity or purchased but unserved lease time. Enforce payer authorization, an explicit percentage, per-job and daily limits, expiry, revocation, replay protection and no recursive rewards. A source deployment's owner transfer must invalidate the former payer's authority.

USDC authorizations must remain bound to the intended deployment and ledger. Routing funds with the companion contract as the apparent payer would lose the existing owner's refund attribution; the production path must preserve the true payer. Transaction submitters still need upfront native gas or a separately specified sponsorship mechanism. No change to gas funding or an automatic fee diversion has been deployed.

Pending decisions: funding percentage and daily cap; pricing anchors and observation parameters; resource-specific verifiable workloads; privacy-preserving verifier admission; robust demand/supply accounting and witness selection. No absolute unrecognizability claim is warranted without a precise adversary model and a supported proof.
