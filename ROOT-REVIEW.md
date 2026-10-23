Linux adoption guard follow-up, 2026-10-23

Base: f1d0666b9fc80d25a7c4cbacf4025f3a33152111. Source candidate only; no image or production activation.

Root reproduced actual adopt() freeing a terminal record's reserved slice and removing the record after a pending stop appeared during isolationHeldGuest(). The prior tryClaim check happened before adopt's await. Source e50da21d reproduced reservationFreed=true, recordRemoved=true with the old guest still listed. This was an actual full function in the existing VM test fixture with scripted backend/allocator edges, not a physical guest test.

Fix: adopt snapshots record identity, lease epoch, and policy-withdrawal generation before its first await. It refuses an existing stop/hold and checks again after the held-guest lookup. Changed identity/epoch/withdrawal or a current pending stop/hold defers adoption for a new sweep, without freeing capacity. This preserves fresh adoption after an earlier withdrawal, confirmed by the positive control. No new contract or administrative policy.

Evidence:
- Eight focused cases pass: pending stop before/during lookup, wallet hold, concurrent withdrawal, completed stop's changed epoch, replaced record, ordinary capacity-allocation path, and successful fresh adoption after a prior withdrawal.
- Same eight cases on immutable base f1d0666b: six guard cases fail behaviorally, two positive controls pass.
- Offline namespace regression: adopt-pending-stop, supervisor-wallet-unknown-hold, supervisor-wallet-policy: 37 passed, no failures/skips, peak168MiB under queue256.
- Initial sparse-checkout test attempts failed on missing dependencies before executing cases. After restoring pinned tracked dependencies (including the relay/net-guard.mjs symlink target), tests passed. node_modules reused from the exact base checkout; no dependency changes.

Limits: held-guest and provisioning edges are scripted. This is not guestd/physical termination evidence. Still requires D's paired egress implementation and decision()-capable admission bundle, image rebuild and reviewed measurement before activation. No production file was changed.
