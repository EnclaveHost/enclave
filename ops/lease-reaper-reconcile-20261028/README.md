# Recover late-success lease renewals before expiry teardown

Status: source and tests only; no production rollout or financial transaction.

On 2026-10-28, EyesOff's relay returned HTTP 502 at 16:33:35 UTC. The renewal nevertheless succeeded at 16:33:53 in Base block 53207943 (transaction `0x237af9801a8109db9b4641f48f240c2df7ba0c180bee736509426e9fbc9ad9ce`) and extended the lease to 17:03:53. The controller retained 16:37:31 and stopped the guest at 16:39:03. Two RPC providers agreed on the event, successful receipt and canonical block. The normal controller then adopted its still-live lease and started another guest. Both app-domain and custom-domain ping eventually returned HTTPS 200.

The fix checks a fresh, block-pinned, two-provider agreement before local lease expiry can trigger teardown. An uncertain renewal response marks the record for reconciliation before another claim/renewal decision. Matching live lease evidence updates the local expiry without sending a transaction. Owner/operator stop epochs, record replacement, ledger changes, concurrent ticker callbacks, newer receipts and previously observed block floors are checked before applying the result or stopping a guest.

Reads have an eight-second response deadline and a fifteen-second maximum block age. A hung third endpoint cannot prevent two healthy peers agreeing. A pending request for the same ledger and deployment is coalesced. Unknown chain state does **not** extend a lease: the existing expiry/grace stop policy remains in force. Consequently a total RPC outage beyond the existing grace can still stop an app; this change does not promise unlimited availability during loss of lease authority.

## Source and packaging

The main-branch supervisor and its Dockerfile/metal overlay include `network/lease-expiry-reconcile.mjs`. The production controller has additional app-funded authorization and pending-stop behavior absent from main. **Do not replace the production supervisor with main's file.** `production-supervisor.patch` applies the same narrow change to the exact deployed source, preserving those existing paths. Ship the new helper with that source and include it in the overlay manifest/closure when building the candidate measured image.

`evidence.json` records the effective supervisor extracted by streaming the active initramfs, matching the checked-out production source SHA256 `01ac9cb17a5a5af6df8992121c75239a580845748ae89f3843e080a617a5f951`. It also pins the candidate patched source and helper. Refuse application of the production patch if the source hash has changed; rebase and repeat qualification instead.

## Validation

- `node --test --test-concurrency=1 test/lease-expiry-reconcile.test.mjs`: 15 passing offline tests.
- The same 15 tests with `SUPERVISOR_JS` pointing to the patched exact production supervisor: pass. The fixtures execute the real renewal and billing functions, with scripted chain/guest edges.
- `node --test --test-concurrency=1 test/tenant-lease.test.mjs test/lease-expiry-reconcile.test.mjs`: 24 passing tests.
- Syntax and whitespace checks pass. No live RPC, VM, GPU, signing or deployment is part of these tests.

Rollout requires a separately reviewed production overlay build, artifact verification and coordination with the funding/recovery owner. This patch does not alter funding contracts, RPC configuration, memory floors, pad-storage guards, lease duration or owner/admin stop authority.
