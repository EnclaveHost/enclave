Current update October24 09:42UTC: see CURRENT-STATE.md. Metal0 ownership acceptance remains pending; a resource window is coordinated with Astra. The new recipient quote and TLS-pinned consumption integration passed173 Node/3 Python source tests, not production SNP tests. Custody rollout remains incomplete and single-seat.

# Custody v2 production reconciliation

CURRENT-STATE was refreshed against live infrastructure and tested source on October24 at05:43UTC; SIGNING-AUTHORITY and ROLLBACK retain their04:57UTC operational reconciliation. Metal0 recovery and operator nomination are confirmed; administrator acceptance and custody rollout remain pending. These documents distinguish completed operational actions from local tests and unperformed production lifecycle tests.

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
