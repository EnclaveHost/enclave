# custody-v2-current-docs-20261023 (worker R): reconciled custody v2 documentation, for root review

This is source and documentation only. Root reviews and publishes the final version. Nothing here was sent, signed or changed in
production, and root's public output was not edited.

- `CURRENT-STATE.md`: what is deployed, the code freeze, what is proven, known limits, publication and admin rights, the
  PROVISIONAL incident timeline, and unresolved actions.
- `TEST-MATRIX.md`: every test that ran, by class (unit, browser, anvil, SNP hardware, production). No secret lifecycle test has
  run on hardware or in production.
- `ROLLBACK.md`: how each action reverses, and the custodian's limits against rollback and replay.
- `SIGNING-AUTHORITY.md`: who signs and who pays for each step, with status.
- `SOURCES.md`: exact file, line and commit references.
- `docs/security/`: the two custody v2 documents, starting from the checkpoint dfb4b55e originals (`docs/ORIGINS.md`).
- `patches/`: those document changes as patches against the checkpoint dfb4b55e originals and against main 68b82926.
- `scan.sh`, `q.sh`: the prescan and the unchanged-queue wrapper. Logs are in `logs/`.
