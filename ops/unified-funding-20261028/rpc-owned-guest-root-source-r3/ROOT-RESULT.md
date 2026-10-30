# Persistent ownership revalidation and terminal timer fix

Separate r3 retains r1/r2 unchanged. requires_ownership_revalidation is an explicit state invariant that survives QUARANTINED -> STOPPING, watchdog calls and state reconstruction. Only an original-owned-identity revalidation with proven Off/zero memory/dead start worker/late-start fence consumes it. A released state returns unchanged on stale watchdog ticks before rollback handling.

Actual21 pure lifecycle tests PASS,0 failures/errors/skips,0.005s. Separate local invocationc4546e69423141b6913d298020bc8d2a; remote enclave-owned-guest-pure-test-r2-20261030 DynamicUser64965, private network/128MiB/noSwap/CPU1/20s. Fresh prior observation still under300s, actual execution rechecked sameboot/all7caps and4,637,474,816B residual after full service growth+256MiB test allowance. No native/VM/DB/RPC or production changes. Source hashes unchanged. Earlier19PASS remains correct for its narrower fixtures, not proof those edge cases were absent.

Native Windows adapter, protected durable admission/ownership, guardian/deadman, boot/attachment/readiness remain unfinished. Trusted receipt flags are not an authentication implementation. Existing source-author local resource failure remains; no account/preflight/author retry or floor reduction.
