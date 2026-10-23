# Public RPC allowlist review

Root captured the active S candidate by exact hashes in PINS.json (dirty source above baseline14d1e4954), then reproduced an inherited-property allowlist bypass through its actual HTTP server. The backend is explicitly a scripted loopback fixture, not Reth, a live blockchain or production. `unlisted_xyz` is refused, but `constructor` and `toString` pass METHODS lookup and reach the backend; an unexpected `constructor` transaction field also passes TX_KEYS validation. This proves violation of the role's strict forwarding boundary, not arbitrary RPC/admin execution or an exploit of production.

The three-line correction checks own properties for METHODS, TX_KEYS and LIMITS. Against the frozen corrected module, both methods return -32601, the field returns -32602, and none is forwarded. The patch is not applied to S's active tree; its owner must integrate it with regressions and rebuild the role. Additional inherited LIMITS names are handled in the patch but were not exercised by the initial HTTP probe.

Tests: probe.mjs against frozen original and --fixed against correction, through existing256MiB queue; exit0. Exact JSON receipts and module hashes are committed. No public network request, wallet use, production change or service restart.
