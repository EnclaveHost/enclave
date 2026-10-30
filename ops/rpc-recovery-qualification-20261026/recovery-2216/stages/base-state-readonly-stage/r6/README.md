# base-state-readonly-stage/r6 = frozen r5 (qualified disk guard, unchanged: jobs/disk_guard.py + tests byte-identical to r5) + review 1730 remedy
# (PREPARED by Claude, SOURCE ONLY; nothing built or run by Claude). Report: logs/claude-base-full-root-r6-1733.md
r5's helper is KNOWN UNSOUND for a full claim (its root reused cached trie hashes); r5 builds qualify only the build/API path.
r6 helper (src/main.rs), MANDATORY for exit 0 / fullStateIntegrity:
  (1) stateRoot.fromHashedOnly = StateRoot::new(NoopTrieCursorFactory, DatabaseHashedCursorFactory).root() == Finish header stateRoot
      (every HashedAccounts/HashedStorages entry, no trie table; streaming)
  (2) trieCache = reth_trie::verify::Verifier (= repair-trie --dry-run) with 0 account AND 0 storage inconsistencies (bounded memory)
  (3) checkpoints coherent, (4) plain->hashed FULL bijection PASS (v1; v2 = NOT_APPLICABLE -> exit 5 PARTIAL, never 0)
  stateRoot.cachedWalk (DbStateRoot over stored nodes) is DIAGNOSTIC ONLY: it never makes a pass; cachedWalk != fromHashedOnly -> 4.
Exit: 0 FULL / 5 PARTIAL / 4 FAILED / 3 refused. NOT a chain anchor (canonical header proof is separate and required).
Fixtures (src/bin/mk_fixture.rs, jobs/positive.sh): r5's 9 cases / 10 runs unchanged + P1 v1-pass-cached-trie, N1
v1-cached-trie-account-modified, N2 v1-cached-trie-storage-modified, N3 v1-stale-trie-node (NON-EMPTY caches; header = independent
alloy root of the ORIGINAL state before corruption) = 13 cases / 14 runs. jobs/fixtures.sh refusals unchanged (6).
Root order (all offline, unshare): guard-tests (256) -> build (4096, guarded on /vm) -> fixtures (512) -> positive (512) -> review;
any real read-only run needs separate authorization.
