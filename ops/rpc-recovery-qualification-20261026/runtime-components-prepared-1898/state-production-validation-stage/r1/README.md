# state-production-validation-stage/r1: the production STATE runner (PREPARED by Claude 1890; NOT run; NOT PASS; FAIL-CLOSED)
Report: ../../logs/claude-state-runtime-integration-1890.md. Plan 1867 → review 1869 → root 1868/1872; acceptance r3 (frozen, actual 46 PASS);
bsro r12 (guard 32 + ns 5 actual PASS).

**What it is:** the smallest integration that reuses what is already proven:
- **composite r6 owned-session/view lifecycle:** `composite_session.py` = r6 byte-for-byte + ONE seam. `Session.exec_plan()` returns
  (argv, limit, report path) to `use()`; `use()` keeps the report bytes. `OUTPUT_NAMES` also contains `state-report.json`. Test 1 proves
  that every other AST node equals r6.
- **composite r10 memory gate**, loaded from its pinned bytes: the gate checks (r7 qualifications, 4096 MiB lane + 16 GiB host floor,
  the root reservation incl. 40 GiB floor + 8 GiB native, the /vm floor, all 265 CONFIRMED via `check_view`), MemoryHigh as the only
  mutation, `make_memory_session` (telemetry, soft stop), `dirty`, `stop_session`/`runtime_identity`, `guard`, `evidence` (structural),
  `collect-evidence.sh` and `job-receipt.py`'s `status_ok`.
- **acceptance r3** `classify_state` / `final_state_status` / `expected_argv` as the ONLY classifier and final check.

**`fixture_exec` is never used.** Production is refused unless kind is production and there is no fixture exec or unmount.

**The argv** is acceptance r3 `expected_argv` of the pinned inputs:
`[helperDir/base-state-readonly, --db <run>/work/db, --static-files <pinned dir>, --rocksdb <run>/rocksdb-absent,
--out <run>/state-report.json, --plain-hashed]`.
- Nothing is configurable. The runtime's own args (before `--`) are only `--tree-root-pid`.
- Before the exec: the report and the RocksDB path must be absent, the helper sha == the pin, and the static-files dir holds EXACTLY the
  pinned files.
- After the exec: helper sha, static-file identities incl. ctime, and RocksDB absence are re-checked. Any change → `post_ok` false → 8.

**Codes:**
- r6 lifecycle first: 4 CLEANUP-INCOMPLETE, 5 CANCELLED, 3 REFUSED / 7.
- Then acceptance r3: 3 with no report → 30; 4 with a schema-valid failing report → 34; 5 with the full passing predicate → 35;
  others → 7; post-use failure → 8; dirty/unreadable OOM counters or a soft stop turn 34/35 into 7.
- **Final (`state_gate.py final`):** acceptance r3 `final_state_status` over evidence built from the native r6/r10 receipt fields
  (`interrupted`, `memory.{memoryDirty,softStop,eventsBefore,eventsAfter}`, `view`, the observed `children.exec.argv`,
  `stateProvenance`), the r10 snapshot rules, and the report bytes. Those bytes must equal the runtime's `reportSha256` / `reportPath`.
- 35 only with everything bound, else 10. Runtime 0 → 10. Other 1..255 are preserved.

**FAIL-CLOSED AS PREPARED.** `PRODUCTION_INPUTS = None`, so `gate`/`runtime` refuse first. Even when filled, `verify_production_inputs`
ALWAYS refuses on the two BLOCKED interfaces (capture r3 receipts, header extraction receipt) until a reviewed revision wires them.
Nothing is synthesized.

**Prerequisites (each needs root's actual evidence):**
- all 265 CONFIRMED;
- the structural cmv-r10 production CLEAN (final 0) over the SAME view (`verify_structural`);
- the r12 build;
- the capture r3 positive/fixtures receipts;
- the header extraction;
- `spv-r1-tests` 14/14;
- a reviewed revision pinning `PRODUCTION_INPUTS` and the two BLOCKED checks.

**Tests:** `bash jobs/q-exit-status.sh spv-r1-tests 256 unshare -Urn bash state-production-validation-stage/r1/jobs/tests.sh` (exactly 14).
**Production (later; refuses now):** `bash jobs/q-exit-status.sh state-prod 4096 bash state-production-validation-stage/r1/jobs/root-state-validate.sh VIEW_DIR MAX_HOURS`.

**Limits:** a 35 is self-consistent PARTIAL v2 state at the DB's own Finish header. It is NOT canonical proof, NOT recovery acceptance
and NOT reset authority. No original writes. Memory fit and runtime duration of a full hashed-state + Verifier scan are unmeasured; a
soft stop is CANCELLED (5).
