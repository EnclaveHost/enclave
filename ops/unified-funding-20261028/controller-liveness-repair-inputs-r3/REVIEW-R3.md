Read-only findings against frozen r2 partial delivery; line numbers refer to seed.

P1 unverified ownership: supervisor4434 classifies wrong-name/id as unknown; 7403 promotes the 409 ID to _vmId anyway; stopContainer4549 trusts it. Audit10679/10724 owner stop/lease loss can then delete the wrong guest. Existing test82-90 assumes vmId=409 id even for mismatches; split verified-held from unverified-conflict cases, retain coverage.

P1 stale completion: performTenantProvision7412-7430 lacks success ownership fence and catch fallback mutates revoked records. Caller adopt11794-11802 can release by deployment ID after obsolete attempt. Actual triggering teardown is abandonClaims9449-9457 or ledgerMoveSweep10568-10576, not a local owner DELETE that is already blocked while provisioning. Checks must include caller consequences and pre-spawn await.

Billing7664 lacks map-object and release-intent checks. Bookkeeping/reaper continues after changed state. respawnTenant7621 lacks completion fence/coordination. Existing test stale slow404 targets one billing observation only and is insufficient.

isolationHeldGuest3222 uses authenticated GET /vms and exact name/live state. adopt currently uses its object only for heldReservation. Retain correctly validated identity separately, without treating the POST409 error as authority or broadening capacity credit. Never claim the whole failed author is qualified because three focused diagnostics passed.

Deferred claimed records are not renewed; this task does not change lease policy. Real revocation and expiry must remain actionable. Cold activation and release-journal durability are out of scope, still unqualified.
