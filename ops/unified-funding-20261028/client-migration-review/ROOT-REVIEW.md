# Client migration review, 2026-10-28

Status: source snapshot only, NOT deployable and NOT approved for signing. The wallet handoff elsewhere covers only the four additive contract creations. Original $30 session and production relay are unchanged.

The deployed original SessionVault._end refunds escrow directly to the owner. The author correctly replaced the earlier proposed withdrawal sequence with termination, replacement legacy deposit, and successor deposit. No second withdrawal should be offered. The candidate 29+1 split is not a signed or approved plan.

Release blockers found in source review:

- canonicalReceipt does not bind the returned transaction hash, header number, transaction membership or log transaction metadata to the requested hash. Zero-hash preconfirmations can pass if an endpoint echoes them. Independent root regression cases are queued.
- The migration executor returns on a pending step, but its only reentry requires every step still planned. Reconciliation only marks booleans done, has no executable resume path, and does not persist/adopt the replacement key record after a delayed open. A normal delayed receipt or page reload can leave API access unavailable. Recovery must use immutable persisted public plan state and canonical evidence; never blindly resend or infer an old refund solely from !live.
- Reconciliation currently marks termination done on !live (including expiry/nonexistent state), replacement done on live alone, and gas done on relay live alone. Exact scope, amount, transaction/log and key checks must be shared with normal execution before state advances.
- normState/compareGrantToChain omit maxRateHour6 although the original on-chain Session mirrors it. The comment claiming maxRatePerHour is not mirrored is incorrect. Verify this field before reproducing a grant.
- Runtime and recovery-scope reads are at a numeric block without final block-hash recheck/freshness; journal and quote scope should not accept stale or replaced evidence.
- The page mounts via freshRecoveryScope before rendering owner controls. With intake off, missing catalog metadata or a failed scope read must not prevent terminate/end/withdraw.
- Actual response wire serialization, DOM integration, browser IndexedDB persistence, owner wallet requests and native HTTP migration have not been exercised. Scripted happy-path tests alone cannot qualify migration.
- Nine deployment records may exceed the eight-distinct-app grant limit. Resolve actual catalog identities before a concrete grant; never silently widen to wildcard or duplicate the gas budget.

All findings are against a stable copied source snapshot with SHA256 inventory. No source in the active Claude author's stage was edited. Tests use local public fixture keys only and must run under the shared queue and host reserve guards. No production signing, fund movement or nonce use.
