# Windows owner CLI: source qualification passed

Exact tested source was committed and pushed as b6ac5d657deee3a9e05c7038ae6ffe96c4d7a604. The owner CLI now routes reads through explicit local authority and submissions through the configured transaction backend, checks successful inclusion, preserves owner operations, and keeps status JSON on stdout with diagnostics on stderr.

Root r2 passed 43 checks (8 new +35 regressions), with no skips. Root r1 failed two JSON-output checks; its original source and evidence are retained. Admission bundles were unchanged and current in r2. Root copied exactly three tested files and preserved file modes.

This is source qualification only. Recording endpoints exercise routing and refusals, not cryptographic proof verification or SNP hardware. Full runtime composition, production readiness and cutover remain pending. prepare-ownership and deploy share tested paths but were not driven end to end by these fixtures. No admin rights or live configuration changed.
