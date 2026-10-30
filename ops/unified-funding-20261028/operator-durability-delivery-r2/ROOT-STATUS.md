# Frozen r2 delivery — not deployed

All 243 delivered files are preserved unchanged. Terminal process verification, input drift checks and mutation replay passed. Initial bounded Linux/inert-transport tests pass 34/34, including the three prior independent failures and six actual shipped-client cases. These are not Windows or Base production qualification.

Root review rejects the new identical-authorization-tuple retry exception: it permits a new deployment to sign and submit while the same account nonce remains quarantined. One author test explicitly expects this behavior. Independent regressions and a separate narrow repair are pending; this delivery is not approved for installation. The original delivery and its tests remain unchanged as evidence. Native Windows exclusion, startup/store/SDDL wiring and deployment validation remain incomplete.

No production code, service, transaction, grant or private journal changed.
