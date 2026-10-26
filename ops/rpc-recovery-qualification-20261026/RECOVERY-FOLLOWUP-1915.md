# Recovery qualification, 2026-10-26

These stages are saved to preserve source and evidence, not as production activation.

Cold relocation r9 passed 56 fixture tests. Independent review then found wrapper/path traversal and scanner completeness defects. It is NOT cleared for privileged scanning, cutover or reclamation. A corrected r10 is being prepared. All original archive data remains intact.

Authenticated backward lease-history r2 replaces the rejected positive-authority index design. The actual slice exposed a cache default integer overflow (`2 << 30` becomes negative), preventing reuse. The exact failed test and terminal verdict are retained; r2 is NOT qualified. Correction and independent review are pending. No authority policy has been enabled.

The separate driver r1 is source-only and not wired into production. Its actual fixture verdict is retained separately; passing fixtures do not prove native timing or the 120-second provisional-state requirement. Startup integration is underway in a new stage.

The resumable state download continues separately. Historical blob validation, chain synchronization, safe/finalized readiness, actual proof-serving, lease-relay and consumer cutover remain incomplete. Enclave administrator controls are preserved.
