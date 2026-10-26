# Composed RPC corrections and recovery handoff, October 26, 2026

The Buffer/native interface defect and the accidentally required witnessUrl field are corrected in the prepared integrated candidate. History recovery now bounds retained header and per-block transaction bytes, in addition to in-flight RPC concurrency. Administrator controls, signed enrollment, strict finality and the 120-second state requirement are preserved. Driver/history defaults remain disabled.

Actual history r4 passed 183 fixtures. Actual producer r5 passed 18 tests across bounded child output, request handling, cleanup and a real local socket proxy; subsequent source review found shutdown ownership races, addressed in prepared r6. The cold scanner's 61 tests and its revised supervisor's 8 tests passed. These are local tests, not real production witness or recovery evidence.

Integrated r3 failed the optional witnessUrl compatibility checks. Integrated r5 fixed those and passed its driver, placement, history and composition suites, but the enrollment suite failed after its positive genesis request encountered a primary change. Dependent assertions then failed without enrollment; the identified failing suite was stopped and the failure preserved. The full check's actual terminal status and remaining phases are in job-status.json and the raw receipts. No successful production qualification is implied.

The reviewed read-only local sudo scan is prepared; its live execution remains pending user action. No original cold archive has been removed. USB writes remain paused. The RAID repair chat has moved the disk to a read-only mount and is preserving data; the RPC manifest's former /mnt/usb paths must not be used to restart anything. Coordination with that separate chat has been requested from the user but is not yet authorized.

The earlier deleted-database journal check examined metadata only. A bounded search of retained journal contents is still a possible recovery investigation, not evidence of recoverable data. Do not use a compact allocated-block backup as evidence that deleted blocks were preserved. No weaker database acceptance standard has been approved.

No production proof service, lease relay, or consumer cutover has occurred. Safe/finalized readiness, historical blobs, native witnesses and full consumer behavior remain unverified.
