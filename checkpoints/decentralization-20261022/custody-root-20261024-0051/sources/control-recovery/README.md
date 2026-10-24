# Final control recovery candidate — not deployed

Root finished this source after Claude reached its weekly limit. It reuses the already built, staged and relay-admitted5db2be3f/bc731956 control image from the previous fee recovery kit. No image rebuild, new admission, contract change, authority bypass or production restart is performed by source preparation.

The prior candidate actually registered and adopted both original tenant VMs, then the v4 health gate failed on one transport error and automatically rolled back. The old control remains unregistered. Original tenant VMs and original custody remain unchanged.

This kit changes the previous recovery procedure in three ways:

1. Gatev5 permits one reset only for an isolated transient transport error with no HTTP response. It still requires420 continuous healthy seconds and3 fresh vouch cycles after a reset. TLS errors, HTTP errors, wrong payloads, ownership/guest/journal faults and stale chain/vouches fail. Absolute deadline900s is unchanged. The1440s cutover guard and600s lease watchdog remain; a late reset can still fail the watchdog. No shortened window or skipped evidence counts as success.
2. Funding checks reserve both the candidate setProofKey and the old control's rollback register+setPrices, each with25% headroom. They price the exact candidate/old SDK senders on every RPC in the node pool. An unavailable fee estimate refuses, not guesses. The old sender's13.2mwei scenario was reproduced locally, not measured as the failed production transaction.
3. KEEP requires renewal hashes from the new control's journal and matching two-provider ledger receipts for both protected apps. Public availability alone cannot attribute a renewal. Activation first refuses unless the temporary lease keeper is confirmed stopped.

## Root procedure

- Do not execute until funding is restored and this kit's public build pins, actual staged hashes, relay allowlist, exact original guest IDs/record hashes and strict app health are freshly verified.
- This kit's `load_new()` reads the previous fee kit's immutable approved build/plan, pinned by hash. It does not copy a failed attempt's private backup, result or raw evidence. The39-entry admission must still include every previously allowed measurement and the candidate. Do not run old admission mutation scripts again.
- Resolve the separate operator account maintenance, verify exact delegation restoration, and restart the old control only after checking its startup gas budget. Recheck candidate+rollback funds before another cutover.
- Stop the temporary keeper cleanly between completed cycles, reconcile every intent, then run fresh lease/funding and authenticated guest baseline reads. Run activate.py in a surviving systemd user session, with no other operator signer. Current-image and inactive/failed keeper guards are mandatory.
- Require a successful gate, fresh root SNP attestation through attest-price.mjs, and both normal renewals verified by renewal-watch.py/keep.py. Provisional is not KEEP.
- On failure, the reviewed rollback stops the candidate, waits out signed lease deadlines, restores only the prior config, and restarts the old control. Its registration needs its reserved gas. Never restart independent tenant VMs. If normal control remains unregistered, resume the bounded keeper only after authority and signed outcomes are reconciled.

## Verification and limits

Root full suite before the final keeper-precondition addition:56 Python tests,17 Node tests,89 mutants killed, source/key/literal scans clean (`logs/root-full-2.out`). Gatev5 itself has11 real HTTP fixture tests and7 focused mutants in the frozen gate proposalf5077c21. Two additional tests cover the final keeper precondition; their result is recorded separately. No new production activation, operational PASS or normal-renewal success is claimed.

The proposed funding maintenance still awaits user approval. The original custody committee remains single-seat and unchanged; no secret lifecycle test is performed by this control recovery kit. The new r2 custody rollout has separate host-owner, ingress, committee, catalog, funding, canary and signing prerequisites.
