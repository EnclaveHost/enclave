# Incomplete RPC composition and finality work, 2026-10-26

These are preserved drafts and actual failures, not deployable or qualified changes.

- Composition r5 failed before runtime tests because network-runtime ran before host-admission.
- Composition r6 corrected that order, but the rebuilt admission bundle still lacks chainVerifierFromEnv and verifiedStateReader. Source export reconciliation is being prepared separately; neither revision passed.
- Finality prototype: 20 JavaScript tests passed; 26 of 27 Python tests passed. The older-receipt fixture reached replay rejection before its intended not-newer check. Original failures are unchanged.
- The finality prototype qualifies a running process only. Its optional integration cannot enable restart: the consumed launcher journal refuses startup before a new process exists. No restart readiness is claimed.
- Launcher and prototype HOLD flags remain false. No live activation or consumer cutover occurred.

Includes exact prepared source/jobs/manifests and selected original output. Clones, dependencies, native binaries, caches and active unfinished revisions are omitted. The 3 MB static closure-review/STALENESS.json is omitted; the original manifest records its digest, so that inner manifest intentionally has one absent file. The outer SHA256SUMS verifies every published file. All files are UTF-8 text.
