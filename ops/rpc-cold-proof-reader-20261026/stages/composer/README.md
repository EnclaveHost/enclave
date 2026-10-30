# base-finality-proof-stage/r13-compose (50cf; PREPARED composer, NOT a stage; nothing composed, nothing run)

`compose_r13.py COLD_STAGE (--cold-only | --wiring WIRING) [--out DIR] [--dry-run-unapproved]` composes base-finality-proof-stage/r13 from the
root-QUALIFIED r12-final (9de0d8d7..., run 0738 PASS) + ONLY the frozen cold-proof readers, with the full pin cascade, COMPOSITION trace,
integration-r13 patches, r13 installer strings, SHA256SUMS and ONE root job; it writes logs/claude-r13-canary-handoff.json.
Gates (refuses otherwise): cold stage frozen AND root ACTUAL PASS RESULT for its exact SHA256SUMS; --wiring refused until da0's wiring stage
is frozen with a declared composition record (format never guessed); atomic (temp dir + rename; nothing left on refusal).
Report: ../../logs/claude-r13-composer-status.md
